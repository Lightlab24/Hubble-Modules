import type { Socket } from 'node:net';
import { createModuleDocumentClient, ModuleDocumentConflictError, ModuleDocumentValueSchema, type ModuleHostServices } from '@hubble/module-sdk';
import type { ServiceOptions } from '../service.js';
import { CyanviewClient, type SocketFactory } from '../transport.js';
import { RcpSession } from '../control/rcp-session.js';
import type { CyanViewRcpConnectionDefinition } from '../control/config.js';
import type { PingSweep } from '../ping.js';
import type { AnnouncementListener } from '../announcements.js';
import { json, object, type RecordValue } from '../model.js';
import { SIMULATED_RIG_DOCUMENT } from '../repository.js';
import { SimulatedController, SimulatedRemiFleet, type SimulatedControllerState, type SimulatedFleetState } from './controller.js';
import { createBroker, type Broker, type BrokerCamera } from './broker.js';
import { memoryStreamPair, refusedStream, refusedWebSocket } from './sockets.js';

const MQTT_PORT = 1883;
const SAVE_BUDGET = 240_000;

/** The rig a new workspace starts with: a RIO with two cameras, and two RCPs that each take both as REMI copies. */
const SEED = [
  { serial: 'CY-RIO-1-10', name: 'RIO', base: '10.192.1.10', lan: '10.20.101.200' },
  { serial: 'CY-RCP-1-20', name: 'RCP', base: '10.192.1.20', lan: '10.20.101.201' },
  { serial: 'CY-RCP-1-30', name: 'RCP', base: '10.192.1.30', lan: '10.20.101.202' },
] as const;
const SEED_CAMERAS: [string, RecordValue][] = [
  ['wide', { Number: '1', Name: 'Wide', Model: 'Sony - Venice-IP', IP: '10.20.20.1', Port: '80', Login: '', Password: '', Enabled: '1', LensModel: '', LensParams: '', Interface: { device: 'SN', port: '*' } }],
  ['tight', { Number: '2', Name: 'Tight', Model: 'Sony - Venice-IP', IP: '10.20.20.2', Port: '80', Login: '', Password: '', Enabled: '1', LensModel: '', LensParams: '', Interface: { device: 'SN', port: '*' } }],
];
type RigState = { formatVersion: 1; controllers: SimulatedControllerState[]; fleet: SimulatedFleetState; recording: [string, '0' | '1'][]; selected: (string | null)[] };
const enabled = (row: RecordValue | undefined) => !!row && String(row.Enabled ?? '1') !== '0' && row.Enabled !== false;

/**
 * Simulated Cyanview controllers inside the worker, for the Simulated setting: a RIO and two RCPs. Each answers on its
 * settings socket and its MQTT broker as a real one does, and keeps its cameras' recording and its RCP panel's selected
 * camera. Every connection to them is in memory. `options` hands the module's service everything it would otherwise
 * use to reach the network, so nothing in Simulated reaches real equipment.
 */
export class SimulatedRig {
  readonly controllers: SimulatedController[];
  readonly fleet: SimulatedRemiFleet;
  private brokers = new Map<SimulatedController, Broker>();
  /** Whether each camera is recording, by the camera it really is: a REMI copy records with the camera it comes from. */
  private recording = new Map<string, '0' | '1'>();
  private selected = new Map<SimulatedController, string | null>();
  constructor() {
    this.controllers = SEED.map(seed => {
      const controller = new SimulatedController();
      controller.config.Product = { Serial: seed.serial, Name: seed.name, MaxCam: 'unlimited' };
      controller.config.IP.protected.IP = seed.base;
      controller.config.IP.old.IP = seed.lan;
      return controller;
    });
    for (const [key, row] of SEED_CAMERAS) this.controllers[0]!.addCamera(key, structuredClone(row));
    this.fleet = new SimulatedRemiFleet(this.controllers);
    for (const rcp of this.controllers.slice(1)) {
      const [, importer] = this.fleet.apply(rcp, { new: ['CyElement.SessionImporter', SEED[0].base] })!;
      for (const [key] of SEED_CAMERAS) this.fleet.apply(rcp, { update: { key: importer + '-' + key, changes: { auto_camera: '1' } } });
    }
    this.fleet.writes.length = 0;
    this.fleet.history = false;
    this.fleet.publish();
    for (const controller of this.controllers) {
      controller.history = false;
      controller.changed = () => this.refresh();
      this.brokers.set(controller, createBroker({ model: {
        root: () => this.serial(controller).toLowerCase(),
        panel: () => /^CY-(RCP|GWY|GATEWAY)-/i.test(this.serial(controller)),
        cameras: () => this.cameras(controller),
        record: (key, value) => this.record(controller, key, value),
        selected: () => this.selected.get(controller) ?? null,
        select: number => this.select(controller, number),
      } }));
    }
  }
  private serial(controller: SimulatedController) { return String(controller.config.Product?.Serial ?? ''); }
  /** The simulated controller at an address, base or LAN. */
  controllerAt(address: string) { return this.controllers.find(controller => controller.answers(address)); }
  /** Every address a simulated controller answers on. */
  addresses() { return this.controllers.flatMap(controller => Object.values(object(controller.config.IP)).map(row => String(object(row).IP ?? '')).filter(Boolean)); }
  /** A camera's identity as the camera it really is, so its copies share its recording. */
  private physical(controller: SimulatedController, key: string) {
    const origin = this.fleet.origin(controller, key);
    return this.controllers.indexOf(origin.device) + '/' + origin.key;
  }
  /**
   * Whether a camera reports itself online: it is switched on, and so is every copy back to the camera it comes from,
   * and that camera has a model set. A camera that was just made and has no model yet reports offline.
   */
  private online(controller: SimulatedController, key: string): boolean {
    const seen = new Set<string>();
    // One hop at a time, so a copy switched off in the middle of a chain takes the copies after it offline too.
    for (let current: { device: SimulatedController; key: string } | undefined = { device: controller, key }; current;) {
      const row = object(current.device.config.Camera)[current.key] as RecordValue | undefined;
      if (!enabled(row)) return false;
      if (!this.fleet.isCopy(current.device, current.key)) return String(row!.Model ?? '').trim() !== '';
      const id = this.controllers.indexOf(current.device) + '/' + current.key;
      if (seen.has(id)) return false;
      seen.add(id);
      current = this.fleet.source(current.device, current.key);
    }
    return false;
  }
  private cameras(controller: SimulatedController): BrokerCamera[] {
    return Object.entries(object(controller.config.Camera)).map(([key, raw]) => {
      const row = object(raw);
      return { id: key, number: String(row.Number ?? ''), name: String(row.Name ?? ''), online: this.online(controller, key), recording: this.recording.get(this.physical(controller, key)) ?? '0' };
    });
  }
  private record(controller: SimulatedController, key: string, value: 'Rec' | 'Stop' | 'RecToggle') {
    if (!object(controller.config.Camera)[key] || !this.online(controller, key)) return;
    const id = this.physical(controller, key), now = this.recording.get(id) ?? '0';
    this.recording.set(id, value === 'Rec' || (value === 'RecToggle' && now !== '1') ? '1' : '0');
    this.refresh();
  }
  private select(controller: SimulatedController, number: string) {
    const key = Object.entries(object(controller.config.Camera)).find(([, row]) => String(object(row).Number) === number)?.[0];
    if (!key) return;
    this.selected.set(controller, key);
    this.refresh();
  }
  /** Reports every controller's camera status again, since a change on one can reach copies on the others. */
  refresh() {
    for (const [controller, key] of this.selected) if (key && !object(controller.config.Camera)[key]) this.selected.set(controller, null);
    for (const broker of this.brokers.values()) broker.refresh();
  }
  /** A settings socket to whichever simulated controller has the address. */
  socket: SocketFactory = (url, options) => {
    const controller = this.controllerAt(new URL(url).hostname);
    return controller ? controller.socket(url, options) : refusedWebSocket() as never;
  };
  /** An MQTT connection to the simulated controller at the address. */
  connect(host: string, port: number): Socket {
    const controller = this.controllerAt(host);
    if (!controller || port !== MQTT_PORT) return refusedStream() as unknown as Socket;
    const [client, server] = memoryStreamPair();
    this.brokers.get(controller)!.accept(server);
    return client as unknown as Socket;
  }
  private ping: PingSweep = async (range, receive, progress, signal) => {
    signal.throwIfAborted();
    receive(this.addresses().filter(range.contains));
    progress(range.count);
  };
  private announcements: AnnouncementListener = async (receive, signal) => {
    for (const controller of this.controllers) {
      const serial = this.serial(controller), role = /^CY-RCP-/i.test(serial) ? 'rcp' : /^CY-RIO-/i.test(serial) ? 'rio' : 'gateway';
      receive({ role, serialHint: serial, addresses: Object.values(object(controller.config.IP)).map(row => String(object(row).IP ?? '')).filter(Boolean) });
    }
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  /**
   * The module's service options with every way out to the network replaced by the rig: controller sockets, MQTT,
   * reachability, ping sweeps, broadcast announcements, the neighbour cache and opening a controller's web page.
   * Only timings come from `base`, so a test can shorten them; nothing in `base` can reach equipment.
   */
  options(base: ServiceOptions = {}): ServiceOptions {
    return {
      ...(base.liveConfig === undefined ? {} : { liveConfig: base.liveConfig }),
      ...(base.cameraEnabled ? { cameraEnabled: base.cameraEnabled } : {}),
      ...(base.ownSettleMs === undefined ? {} : { ownSettleMs: base.ownSettleMs }),
      ...(base.lookReachMs === undefined ? {} : { lookReachMs: base.lookReachMs }),
      client: address => new CyanviewClient(address, { socket: this.socket }),
      reachable: async address => !!this.controllerAt(address),
      neighbors: async () => [],
      control: { ...base.control, session: (definition: CyanViewRcpConnectionDefinition, changed: () => void) => new RcpSession(definition, changed, true, (host, port) => this.connect(host, port)) },
      discovery: {
        ...(base.discovery?.durationMs === undefined ? {} : { durationMs: base.discovery.durationMs }),
        ping: this.ping, announcements: this.announcements, neighbors: async () => [],
      },
      openPage: async () => { throw new Error('A simulated controller has no web page to open'); },
    };
  }
  state(): RigState {
    return { formatVersion: 1, controllers: this.controllers.map(controller => controller.state()), fleet: this.fleet.state(),
      recording: [...this.recording], selected: this.controllers.map(controller => this.selected.get(controller) ?? null) };
  }
  /** Puts back a saved rig. Anything that isn't one leaves the rig as it starts. */
  restore(value: unknown): boolean {
    const saved = object(value) as Partial<RigState>;
    if (saved.formatVersion !== 1 || !Array.isArray(saved.controllers) || saved.controllers.length !== this.controllers.length || !saved.fleet ||
      saved.controllers.some(state => !state || typeof state.config !== 'object' || !Array.isArray(state.endpoints) || !Array.isArray(state.lenses) || !Array.isArray(state.links))) return false;
    this.controllers.forEach((controller, index) => controller.restore(saved.controllers![index]!));
    this.fleet.restore(saved.fleet);
    this.recording = new Map((saved.recording ?? []).filter(([, recording]) => recording === '0' || recording === '1'));
    this.selected = new Map(this.controllers.map((controller, index) => [controller, typeof saved.selected?.[index] === 'string' ? saved.selected[index] : null]));
    return true;
  }
  async dispose() {
    for (const broker of this.brokers.values()) broker.close();
    await Promise.all(this.controllers.map(controller => controller.close()));
  }
}

/**
 * Keeps the simulated rig in a module document. Hubble lets a module write its documents only during a command (a
 * page call or a key press), so each command saves the rig on its way out if anything has changed. A change made
 * outside a command, such as a copy following a camera switched on, is saved by the next command. At start the
 * rig is put back from the document, before anything connects to it.
 */
export class SimulatedRigStore {
  private documents: ReturnType<typeof createModuleDocumentClient>;
  private saved = '';
  private tail: Promise<void> = Promise.resolve();
  private tooLarge = false;
  constructor(services: ModuleHostServices, private rig: SimulatedRig, private log: (message: string) => void) { this.documents = createModuleDocumentClient(services); }
  async load(signal: AbortSignal) {
    try {
      const document = await this.documents.read(SIMULATED_RIG_DOCUMENT, signal);
      if (Object.keys(object(document.value)).length && !this.rig.restore(document.value)) this.log('The saved simulated controllers could not be read, so they start afresh');
    } catch (error) {
      signal.throwIfAborted();
      this.log('The saved simulated controllers could not be read, so they start afresh: ' + (error instanceof Error ? error.message : String(error)));
    }
    this.saved = JSON.stringify(this.rig.state());
  }
  /** Saves the rig if it has changed since it was last saved or read. One save runs at a time. */
  save(signal: AbortSignal) {
    const run = this.tail.then(() => this.saveNow(signal));
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async saveNow(signal: AbortSignal) {
    const state = this.rig.state(), text = JSON.stringify(state);
    if (text === this.saved) return;
    if (text.length > SAVE_BUDGET) {
      if (!this.tooLarge) this.log('The simulated controllers hold too much to save, so a restart puts them back as they were last saved');
      this.tooLarge = true; return;
    }
    this.tooLarge = false;
    for (let attempt = 0; ; attempt++) {
      const current = await this.documents.read(SIMULATED_RIG_DOCUMENT, signal);
      try { await this.documents.write(current, ModuleDocumentValueSchema.parse(json(state)), signal); this.saved = text; return; }
      catch (error) { if (!(error instanceof ModuleDocumentConflictError) || attempt === 2) throw error; }
    }
  }
}
