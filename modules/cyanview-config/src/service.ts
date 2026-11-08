import { CyanviewClient } from './transport.js';
import { ConfigurationOperations, type ClientFactory } from './operations.js';
import { PlanRepository } from './repository.js';
import { Discovery, type DiscoveryMethod, type DiscoveryOptions } from './discovery.js';
import { normalizeSnapshot, optionEntries } from './normalize.js';
import { object, validIp, type RecordValue } from './model.js';
import { readNeighbors } from './neighbors.js';
import { RemiOperations } from './remi.js';
import type { ChoiceCatalogs } from './choice-catalogs.js';
import { cameraChoiceKey, isCameraChoiceField, type CameraChoice } from './choice-context.js';
import type { ControlOptions } from './control/service.js';

export type ServiceOptions = { client?: ClientFactory; reachable?: (address: string, signal: AbortSignal) => Promise<boolean>; discovery?: DiscoveryOptions; neighbors?: (signal: AbortSignal) => Promise<string[]>; control?: ControlOptions };
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
  private lookups = new Map<string, RecordValue>();
  private discovery: Discovery;
  private stopped = false;
  constructor(private repository: PlanRepository, private choiceCatalogs: ChoiceCatalogs, private publish: (values: RecordValue) => void, private lifetime: AbortSignal, private options: ServiceOptions = {}) {
    this.client = options.client ?? (address => new CyanviewClient(address));
    this.remi = new RemiOperations(repository, this.client);
    this.operations = new ConfigurationOperations(repository, this.client, this.remi);
    this.discovery = new Discovery(async (address, signal) => {
      const snapshot = await this.snapshot(address, signal, false);
      if (!/^CY-(RCP|RIO|GATEWAY|GWY)-/i.test(snapshot.device.serial)) throw new Error('Not a configurable Cyanview controller');
      return this.rememberCandidate(snapshot.device);
    }, () => this.emit(), options.reachable, {
      ...options.discovery,
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
  state() { return { observations: this.observations, discovery: this.discovery.progress, lookupResults: [...this.lookups.values()] }; }
  forgetManagedDevices(ids: string[]) {
    for (const id of ids) { this.generations.set(id, (this.generations.get(id) || 0) + 1); delete this.observations[id]; }
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
    try {
      await client.connect(signal); const snapshot = normalizeSnapshot(client.config, address);
      if (catalog) await this.remi.readCameraReferences(snapshot, client, signal);
      if (catalog && snapshot.cameras[0]) {
        try { snapshot.device.modelCatalog = optionEntries(await client.option(snapshot.cameras[0].elementKey, 'Model', signal)).map(entry => ({ label: entry.label, id: object(entry.request).update?.changes?.model ?? '' })); } catch { /* The verified snapshot remains usable if option discovery is unavailable. */ }
      }
      return snapshot;
    } finally { client.close(); }
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
    const snapshot = await this.snapshot(address, signal);
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
  /** Reads every controller once for changes made outside this module. Status stays with MQTT. */
  async refresh(signal: AbortSignal) {
    const { plan } = await this.repository.read(signal);
    const snapshots: ReturnType<typeof normalizeSnapshot>[] = [], failed: string[] = [];
    await Promise.all(plan.devices.map(async device => {
      const generation = this.generations.get(device.id) || 0, current = () => generation === (this.generations.get(device.id) || 0);
      try {
        const address = device.address || device.base, snapshot = await this.snapshot(address, signal);
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
    const client = this.client(device.address || device.base);
    let catalog;
    try {
      await client.connect(signal);
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
  dispose() { this.stopped = true; this.discovery.dispose(); }
}
