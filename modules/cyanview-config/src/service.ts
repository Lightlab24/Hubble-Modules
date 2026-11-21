import { CyanviewClient } from './transport.js';
import { ConfigurationOperations, lentSocket, ownSocket, type ClientFactory, type HeldControllers } from './operations.js';
import { PlanRepository } from './repository.js';
import { Discovery, type DiscoveryMethod, type DiscoveryOptions } from './discovery.js';
import { normalizeSnapshot, optionEntries } from './normalize.js';
import { baseFromSerial, object, savedDeviceAddresses, validIp, type Plan, type RecordValue } from './model.js';
import { readNeighbors } from './neighbors.js';
import { RemiOperations } from './remi.js';
import type { ChoiceCatalogs } from './choice-catalogs.js';
import { cameraChoiceKey, isCameraChoiceField, type CameraChoice } from './choice-context.js';
import type { ControlOptions } from './control/service.js';
import type { CameraEnabledOptions } from './camera-enabled.js';
import { LiveConfig, type ConfigObserver, type LiveConfigOptions } from './live-config.js';
import type { OpenDevicePage } from './open-page.js';

export type ServiceOptions = { client?: ClientFactory; reachable?: (address: string, signal: AbortSignal) => Promise<boolean>; discovery?: DiscoveryOptions; neighbors?: (signal: AbortSignal) => Promise<string[]>; control?: ControlOptions;
  /** Each managed controller's held settings socket. False holds none, for tests that count sockets. */
  liveConfig?: LiveConfigOptions | false;
  cameraEnabled?: CameraEnabledOptions;
  /** How long after work on a socket of its own ends before the held socket is lent again. */
  ownSettleMs?: number;
  /** How long a watched controller with no held socket may take to answer a look for REMI copies. */
  lookReachMs?: number;
  /** Opens a controller's own web page. Tests record the address and open nothing. */
  openPage?: OpenDevicePage };
export { baseFromSerial };
const safeDevice = (device: RecordValue) => Object.fromEntries(['id', 'serial', 'name', 'kind', 'base', 'alias', 'address', 'online', 'lastSeen', 'addresses', 'capacity'].filter(key => device[key] !== undefined).map(key => [key, device[key]]));
export class CyanviewService {
  private client: ClientFactory;
  private operations: ConfigurationOperations;
  readonly remi: RemiOperations;
  // Bumped when a controller is removed, so a read already under way can't bring it back.
  private generations = new Map<string, number>();
  /** When each controller was last read. Every controller reports its status live over MQTT, so nothing here decides Online or Offline. */
  private observations: RecordValue = {};
  private candidates = new Map<string, RecordValue>();
  /** Every controller a read one lists as a neighbour, by lower-case serial, with the addresses it was seen at. */
  private neighbours = new Map<string, Set<string>>();
  private lookups = new Map<string, RecordValue>();
  /** Setup mode's network clears under way: how many of each RCP's addresses are done. */
  private networkClears = new Map<string, { done: number; total: number }>();
  private discovery: Discovery;
  private live?: LiveConfig;
  private stopped = false;
  private mqttDown: (id: string) => boolean = () => false;
  /** Sockets that work has opened for itself on each controller, and until when the held one may be behind them. */
  private ownSockets = new Map<string, { open: number; settledAt: number }>();
  /**
   * The settings socket held on each controller, for sends, switches and lists to use instead of opening their own
   * beside it. With nothing held, as in tests that count sockets, each opens its own as before.
   */
  readonly held: HeldControllers = {
    lend: device => {
      const own = this.ownSockets.get(String(device.id));
      return own && (own.open > 0 || Date.now() < own.settledAt) ? undefined : this.live?.lend(String(device.id));
    },
    opened: device => {
      const id = String(device.id), own = this.ownSockets.get(id) ?? { open: 0, settledAt: 0 };
      this.ownSockets.set(id, own); own.open++;
      let done = false;
      // A controller took about 0.4 s to report a change to its other sockets (RCP 1, Nov 12 2026). A second covers it.
      return () => { if (done) return; done = true; own.open--; own.settledAt = Date.now() + (this.options.ownSettleMs ?? 1000); };
    },
    watched: device => !!this.live?.watching(String(device.id)),
    down: device => !!this.live?.watching(String(device.id)) && !this.live.connection(String(device.id)) && this.mqttDown(String(device.id)),
  };
  constructor(private repository: PlanRepository, private choiceCatalogs: ChoiceCatalogs, private publish: (values: RecordValue) => void, private lifetime: AbortSignal, private options: ServiceOptions = {}) {
    this.client = options.client ?? (address => new CyanviewClient(address));
    this.remi = new RemiOperations(repository, this.client, this.held, options.lookReachMs);
    this.operations = new ConfigurationOperations(repository, this.client, this.remi, this.held);
    if (options.liveConfig !== false) this.live = new LiveConfig(this.client, () => this.emit(), options.liveConfig);
    this.discovery = new Discovery(async (address, signal) => {
      const snapshot = await this.snapshot(address, signal, false);
      if (!/^CY-(RCP|RIO|GATEWAY|GWY)-/i.test(snapshot.device.serial)) throw new Error('Not a configurable Cyanview controller');
      return this.rememberCandidate(snapshot.device);
    }, () => this.emit(), options.reachable, {
      neighbors: options.neighbors ?? readNeighbors,
      ...options.discovery,
      // Saved devices that aren't in the list, which Discover checks before anything else.
      saved: options.discovery?.saved ?? (async signal => {
        const { plan } = await this.repository.read(signal), managed = new Set(plan.devices.map(device => String(device.serial).toUpperCase()));
        return (plan.savedDevices ?? []).filter(row => !managed.has(String(row.serial).toUpperCase())).map(row => ({ serial: String(row.serial), addresses: savedDeviceAddresses(row) }));
      }),
      seeds: options.discovery?.seeds ?? (async(receive,signal)=>{
        const addresses=(devices:RecordValue[])=>devices.flatMap(device=>[device.address,device.base,device.alias,...(device.addresses??[])]).filter(validIp);
        receive(addresses([...this.candidates.values()]));
        await Promise.allSettled([
          this.repository.read(signal).then(({plan})=>receive(addresses(plan.devices))),
          (options.neighbors??readNeighbors)(signal).then(receive),
        ]);
      }),
    });
  }
  state() { return { observations: this.observations, discovery: this.discovery.progress, lookupResults: [...this.lookups.values()], configChanges: this.live?.state() ?? null, networkClears: Object.fromEntries(this.networkClears) }; }
  /** Says whether a controller's MQTT link is down, which with no settings socket either means it isn't answering at all. */
  followMqtt(down: (id: string) => boolean) { this.mqttDown = down; }
  /** Keeps a settings socket open on each managed controller, so a change made anywhere shows up without Refresh all. */
  watch(plan: Plan) { if (!this.stopped) this.live?.setPlan(plan); }
  /** Each configuration a held socket reports, with the one before it. Nothing is reported without held sockets. */
  observeConfig(observer: ConfigObserver) { return this.live?.observe(observer); }
  forgetManagedDevices(ids: string[]) {
    for (const id of ids) { this.ownSockets.delete(id); this.generations.set(id, (this.generations.get(id) || 0) + 1); delete this.observations[id]; }
  }
  private emit() { if (!this.stopped) this.publish(this.state()); }
  private rememberCandidate(input: RecordValue) {
    const device = safeDevice(input), previous = this.candidates.get(device.id);
    device.addresses = [...new Set([...(previous?.addresses ?? []), previous?.address, device.address].filter(Boolean))];
    this.candidates.set(device.id, device); return device;
  }
  async snapshot(address: string, signal: AbortSignal, catalog = true) {
    if (!validIp(address)) throw new Error('Enter a valid controller IPv4 address');
    const client = this.client(address);
    try { await client.connect(signal); return await this.read(client, signal, catalog); } finally { client.close(); }
  }
  /** What an open socket says the controller has now. */
  private async read(client: CyanviewClient, signal: AbortSignal, catalog = true, endpoints = true) {
    for (let attempt = 0; ; attempt++) {
      const config = client.config, snapshot = normalizeSnapshot(config, client.address);
      this.noteNeighbours(config);
      // A camera whose model's port the controller doesn't list (a Burano's 22) shows the port its endpoint
      // holds. A read on the held socket after each change opens nothing else, so it leaves the port the page
      // already has rather than blanking it.
      const unlisted = snapshot.cameras.filter(camera => !('Port' in object(object(config.Camera)[String(camera.elementKey)])));
      if (unlisted.length && endpoints) {
        const ports = await client.readEndpointPorts(signal);
        for (const camera of unlisted) if (ports.has(String(camera.elementKey))) camera.port = ports.get(String(camera.elementKey))!;
      } else for (const camera of unlisted) Reflect.deleteProperty(camera, 'port');
      if (catalog) await this.remi.readCameraReferences(snapshot, client, signal);
      if (catalog && snapshot.cameras[0]) {
        try { snapshot.device.modelCatalog = optionEntries(await client.option(snapshot.cameras[0].elementKey, 'Model', signal)).map(entry => ({ label: entry.label, id: object(entry.request).update?.changes?.model ?? '' })); } catch { /* The verified snapshot remains usable if option discovery is unavailable. */ }
      }
      // The questions above wait their turn on the socket, behind a send that is using it. If the controller
      // reported a change meanwhile, what was read at the start is already old, so it is read again: what
      // goes back is what the controller has now.
      if (client.config === config || attempt === 2) return snapshot;
    }
  }
  private noteNeighbours(config: RecordValue) {
    for (const raw of Object.values(object(config.Remi))) {
      const entry = object(raw), seenAt = String(entry.IP ?? '');
      for (const peer of Object.values(object(entry.Connections))) {
        const serial = String(object(peer).name ?? '').trim().toLowerCase();
        if (!/^cy-[a-z0-9]+-\d{1,3}-\d{1,3}$/.test(serial)) continue;
        const addresses = this.neighbours.get(serial) ?? new Set<string>();
        if (validIp(seenAt)) addresses.add(seenAt);
        this.neighbours.set(serial, addresses);
        if (this.neighbours.size > 512) this.neighbours.delete(this.neighbours.keys().next().value!);
      }
    }
  }
  /**
   * The rest of a rig that was set up outside this module. Each controller keeps a list of every
   * other one it has seen, including ones from old jobs, so each listed serial is tried at its base
   * address and only one that answers as itself is offered. Nothing is written to any controller.
   */
  async findRig(ignore: string[], signal: AbortSignal) {
    const { plan } = await this.repository.read(signal);
    const skip = new Set([...plan.devices.map(device => String(device.serial).toLowerCase()), ...ignore.map(serial => serial.toLowerCase())]);
    const found: RecordValue[] = [], tried = new Set<string>();
    // A controller just found may list more, so look again until a round finds nothing new.
    for (let round = 0; round < 4 && found.length < 64; round++) {
      const listed = [...this.neighbours].filter(([serial]) => !skip.has(serial) && !tried.has(serial)).slice(0, 64);
      if (!listed.length) break;
      await Promise.all(listed.map(async ([serial, seenAt]) => {
        tried.add(serial);
        for (const address of new Set([baseFromSerial(serial), ...seenAt].filter(Boolean))) {
          // Only reaching it has a short limit. One that is off the network is given up on quickly.
          let reach: CyanviewClient | undefined;
          try {
            reach = this.client(address);
            await reach.connect(AbortSignal.any([signal, AbortSignal.timeout(1500)]));
            if (reach.serial.toLowerCase() !== serial) continue;
          } catch { signal.throwIfAborted(); continue; } finally { reach?.close(); }
          try { found.push((await this.probe(address, signal)).device); return; }
          catch { signal.throwIfAborted(); }
        }
      }));
    }
    return { found };
  }
  /** A read that answered says the controller was reachable then, and when. */
  private reached() {
    return { online: true, lastSeen: new Date().toISOString() };
  }
  async probe(address: string, signal: AbortSignal) { const snapshot = await this.snapshot(address, signal); const device = this.rememberCandidate(snapshot.device); snapshot.device.addresses = device.addresses; this.lookups.set(device.id, device); if (this.lookups.size > 256) this.lookups.delete(this.lookups.keys().next().value!); this.emit(); return snapshot; }
  private async saveModelCatalogs(devices: RecordValue[], signal: AbortSignal) {
    const lists: [string, CameraChoice[]][] = devices.filter(device => device.modelCatalog?.length).map(device => [
      cameraChoiceKey(device.serial, 'Model')!,
      device.modelCatalog.map((choice: { label: string }) => ({ label: choice.label, port: null })),
    ]);
    // Import and Refresh still return verified configuration if catalog storage fails.
    await this.choiceCatalogs.saveMany('Model', lists, signal).catch(() => undefined);
  }
  async importDevice(id: string, address: string, signal: AbortSignal) {
    const candidate = this.candidates.get(id);
    if (candidate && address !== candidate.address && !candidate.addresses?.includes(address)) throw new Error('Discovered address changed');
    const reached = await this.snapshot(address, signal), snapshot = await this.baseSnapshot(reached.device, signal) ?? reached;
    if (snapshot.device.id !== id) throw new Error('Controller identity changed before adding it');
    if (snapshot.cameras.some(row => row.remi)) {
      const { plan } = await this.repository.read(signal);
      await this.remi.describeCameras(plan, [snapshot], signal);
    }
    this.observations[snapshot.device.id] = this.reached();
    await this.saveModelCatalogs([snapshot.device], signal);
    this.emit();
    return snapshot;
  }
  /**
   * A controller's base address is its own, while a LAN address can be set on two by mistake. So when
   * a controller is reached some other way and its base answers as the same controller, use the base.
   */
  private async baseSnapshot(device: RecordValue, signal: AbortSignal) {
    const base = String(device.base ?? '');
    if (!base || base === String(device.address || base)) return undefined;
    // Only reaching it has a short limit. A controller with a lot on it can take longer to read in full.
    const probe = this.client(base);
    try {
      await probe.connect(AbortSignal.any([signal, AbortSignal.timeout(3000)]));
      if (probe.serial !== device.serial) return undefined;
    } catch { signal.throwIfAborted(); return undefined; } finally { probe.close(); }
    try {
      const snapshot = await this.snapshot(base, signal);
      return snapshot.device.serial === device.serial ? snapshot : undefined;
    } catch { signal.throwIfAborted(); return undefined; }
  }
  /**
   * Reads every controller once for changes made outside this module. Status stays with MQTT. A live read
   * follows a change the controller just reported, so it reads the socket that reported it.
   */
  async refresh(signal: AbortSignal, only?: string[], live = false) {
    const { plan } = await this.repository.read(signal);
    const snapshots: ReturnType<typeof normalizeSnapshot>[] = [], failed: string[] = [];
    await Promise.all(plan.devices.filter(device => !only || only.includes(device.id)).map(async device => {
      const generation = this.generations.get(device.id) || 0, current = () => generation === (this.generations.get(device.id) || 0);
      try {
        const held = live ? this.live?.connection(device.id) : undefined;
        const snapshot = held ? await this.read(held, signal, true, false) : await this.baseSnapshot(device, signal) ?? await this.snapshot(device.address || device.base, signal);
        if (!current()) return;
        if (snapshot.device.serial !== device.serial) throw new Error('Controller identity changed');
        snapshots.push(snapshot);
        this.observations[device.id] = this.reached();
      } catch { if (current()) { failed.push(device.id); this.observations[device.id] = { ...this.observations[device.id], online: false }; } }
    }));
    await this.saveModelCatalogs(snapshots.map(snapshot => snapshot.device), signal);
    await this.remi.describeCameras(plan, snapshots, signal);
    this.emit(); return { snapshots, failed, observations: this.observations };
  }
  startScan(range: string, method: DiscoveryMethod = 'ping') { return this.discovery.start(range, method); }
  waitForScan(signal: AbortSignal) { return this.discovery.waitForCompletion(signal); }
  stopScan() { this.discovery.stop(); if (this.discovery.progress) this.discovery.progress.state = 'stopped'; this.emit(); }
  async optionsFor(input: RecordValue, signal: AbortSignal) {
    const field = input.field;
    if (!isCameraChoiceField(field)) throw new Error('Unsupported option field');
    const { plan } = await this.repository.read(signal), device = plan.devices.find(row => row.id === input.device), row = plan.cameras.find(row => row.id === input.rowId && row.device === input.device);
    if (!device || !row?.elementKey) throw new Error('Camera configuration is unavailable on this controller');
    // A list is asked for over the socket already held on the controller, where there is one.
    const client = lentSocket(this.held, device) ?? await ownSocket(this.held, this.client, device, signal);
    let catalog;
    try {
      if (client.serial !== device.serial) throw new Error('Controller identity changed');
      const observed = client.config.Camera?.[row.elementKey];
      if (!observed) throw new Error('Camera configuration is unavailable on this controller');
      const key = cameraChoiceKey(device.serial, field, row.elementKey, observed.Model, observed.LensModel)!;
      const entries = optionEntries(await client.option(row.elementKey, field, signal))
        .map(entry => ({ label: entry.label, port: entry.description?.port == null ? null : String(entry.description.port) }));
      catalog = { key, entries };
    } finally { client.close(); }
    const saved = await this.choiceCatalogs.save(field, catalog.key, catalog.entries, signal).catch(() => false);
    return { ...catalog, saved };
  }
  send(input: RecordValue, signal: AbortSignal) { return this.operations.run(input, signal); }
  /** Setup mode: deletes an RCP's LAN addresses and leaves its WAN Static with nothing set, reporting each one as it goes. */
  async clearNetwork(input: RecordValue, signal: AbortSignal) {
    const id = String(input.device ?? '');
    try {
      return await this.operations.clearNetwork(input, signal, (device, done, total) => { this.networkClears.set(device, { done, total }); this.emit(); });
    } finally { this.networkClears.delete(id); this.emit(); }
  }
  dispose() { this.stopped = true; this.discovery.dispose(); this.live?.dispose(); }
}
