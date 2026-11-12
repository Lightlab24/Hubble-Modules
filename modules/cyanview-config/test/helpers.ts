import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createModuleHarness } from '@hubble/module-sdk/testing';
import type { HubbleModule, ModuleDocumentSnapshot, ModuleJsonValue } from '@hubble/module-sdk';
import { createInstance } from '../src/index.js';
import { documentDefinitions, PlanRepository } from '../src/repository.js';
import { CyanviewClient } from '../src/transport.js';
import { object, type Plan, type RecordValue } from '../src/model.js';
import { normalizeSnapshot } from '../src/normalize.js';
import type { ServiceOptions } from '../src/service.js';
import { RcpSession } from '../src/control/rcp-session.js';
import type { ControlOptions } from '../src/control/service.js';

export const noEquipment: ControlOptions = { session: (definition, changed) => new RcpSession(definition, changed, true, () => createConnection({ host: '127.0.0.1', port: 9 })) };

export function fixture(settings: RecordValue = {}, options: ServiceOptions = {}, shared?: Map<string, ModuleDocumentSnapshot>) {
  const records = shared ?? new Map<string, ModuleDocumentSnapshot>();
  let failWrite: string | undefined;
  let heldPart: string | undefined, writeHold: Promise<void> | undefined;
  let slowRead: { part: string; ms: number } | undefined;
  let refusedWatches = 0;
  const watchers = new Map<string, Set<() => void>>();
  const definitions = documentDefinitions();
  const scope = { kind: 'host' as const, workspaceId: randomUUID(), capabilityId: 'lightlab-cyanview-config' };
  // Every managed RCP and RIO opens its connections as soon as the worker starts, so no test may default to a real one.
  // Held settings sockets are off unless a test asks for them, since many tests count sockets.
  const module: HubbleModule = { createInstance: context => createInstance(context, { neighbors:async()=>[],control:noEquipment,liveConfig:false,...options }) };
  const harness = createModuleHarness(module, { sampleData: false, ...settings }, { scope,
    requestHost: async (method, raw, signal) => {
      if (method !== 'service') throw new Error('Unexpected host operation');
      const outer = object(raw), input = object(outer.input), id = String(input.id);
      if (outer.service !== 'documents') throw new Error('Unexpected service');
      if (input.method === 'read' && slowRead && id.includes(slowRead.part)) { const { ms } = slowRead; slowRead = undefined; await delay(ms); }
      if (input.method === 'watch' && refusedWatches > 0 && id.includes('camera-control')) { refusedWatches--; throw new Error('Host service is not granted or available for this scope'); }
      const definition = definitions.find(item => item.id === id); if (!definition) throw new Error('Unknown document');
      let document: ModuleDocumentSnapshot = records.get(id) ?? { workspaceId: scope.workspaceId, owner: { kind: 'host' as const, capabilityId: scope.capabilityId, moduleId: 'lightlab-cyanview-config' }, id, version: 1, revision: null, value: structuredClone(definition.defaultValue) as ModuleDocumentSnapshot['value'], canUndo: false, canRedo: false };
      if (input.method === 'watch' && input.afterRevision === document.revision) {
        await new Promise<void>((resolve, reject) => {
          const entries = watchers.get(id) ?? new Set(); watchers.set(id, entries);
          const done = () => { entries.delete(done); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => { entries.delete(done); reject(new Error('Document watch cancelled')); };
          entries.add(done); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        document = records.get(id) ?? document;
      }
      if (input.method === 'write') {
        if (heldPart && id.includes(heldPart)) { await writeHold; document = records.get(id) ?? document; }
        if (failWrite && id.includes(failWrite)) { failWrite = undefined; throw new Error('Simulated storage failure'); }
        if (input.expectedRevision !== document.revision) return { status: 'conflict', document } as unknown as ModuleJsonValue;
        document = { ...document, revision: randomUUID(), value: structuredClone(input.value) };
        records.set(id, document);
        for (const done of [...(watchers.get(id) ?? [])]) done();
      }
      return { status: 'document', document } as unknown as ModuleJsonValue;
    },
  });
  const repository = new PlanRepository(harness.context.services!, settings.sampleData === true);
  const signal = new AbortController().signal;
  return { ...harness, records, repository, signal,
    failNextWrite(part: string) { failWrite = part; },
    slowNextRead(part: string, ms: number) { slowRead = { part, ms }; },
    refuseSelectionWatches(count: number) { refusedWatches = count; },
    holdWrites(part: string) {
      heldPart = part;
      let release!: () => void;
      writeHold = new Promise<void>(resolve => { release = resolve; });
      return () => { heldPart = undefined; release(); };
    },
    call(command: string, value: unknown = null) { return harness.instance.call!('page.studio', { sectionId: 'frontend', commandId: command, value: value as ModuleJsonValue }, harness.execution()) as Promise<any>; },
  };
}

export class FakeController {
  remiFleet?: FakeRemiFleet;
  server: Server;
  sockets = new Set<WebSocket>();
  wss = new WebSocketServer({ noServer: true });
  port = 0;
  actions: RecordValue[] = [];
  origins: string[] = [];
  options: string[] = [];
  opened = 0;
  failProperty = '';
  dropCreateReply = false;
  dropDeleteReply = false;
  wrongIdentity = false;
  replyDelayProperty = '';
  replyDelayMs = 0;
  /** A controller answers a write at once and pushes its changed configuration a little later. */
  pushDelayMs = 0;
  holdAction = '';
  heldActionReplies: (() => void)[] = [];
  replyTextHeartbeat = true;
  modelChoices = [['Sony - Venice-IP', 'VeniceCBM'], ['Sony - Alpha-USB', 'SonyDslr'], ['Sony - Alpha-IP', 'SonyDslrIP']];
  lensChoices = [['None', ''], ['B4 Generic', 'sony'], ['Tilta - Nucleus-M', 'tilta'], ['ARRI - cforce', 'arri_motor'], ['cmotion cGate', 'cgate']];
  config: RecordValue = { Product: { Serial: 'CY-RIO-1-10', Name: 'RIO', MaxCam: 'unlimited' }, Camera: {}, IP: {
    protected: { IP: '10.192.1.10', Interface: 'LAN1', Type: 'Local', mask: '16', ReadOnly: true, NoDelete: true },
    old: { IP: '10.20.101.200', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
  } };
  private endpoints = new Map<string, string>();
  private lenses = new Map<string, string>();
  private links = new Map<string, string>();
  constructor() {
    this.server = createServer();
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, 'http://localhost'), address = url.searchParams.get('device');
      if (!Object.values(object(this.config.IP)).some(row => object(row).IP === address)) { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, ws => {
        this.sockets.add(ws); this.opened++; this.origins.push(String(request.headers.origin));
        ws.once('close', () => this.sockets.delete(ws));
        if (url.pathname === '/ws' && this.remiFleet) {
          ws.send(JSON.stringify({ elements: this.remiFleet.elements(this), version: 1 })); return;
        }
        const config = structuredClone(this.config);
        if (this.wrongIdentity && address !== '10.192.1.10' && address !== '10.20.101.200') config.Product.Serial = 'ANOTHER-CONTROLLER';
        ws.send(JSON.stringify({ type: 'config_data', payload: config }));
        ws.on('message', raw => {
          if (raw.toString() === 'ping') { if(this.replyTextHeartbeat)ws.send('pong'); return; }
          const message = JSON.parse(raw.toString());
          if (message.type === 'option_request') {
            this.options.push(message.request[1]);
            ws.send(JSON.stringify({ type: 'option_reply', request: message.request, payload: this.option(message.request) })); return;
          }
          if (message.type !== 'action_request') return;
          this.actions.push(structuredClone(message.request));
          const result = this.apply(message.request);
          if (this.dropCreateReply && message.request.new) { this.dropCreateReply = false; this.broadcast(); return; }
          if (this.dropDeleteReply && message.request.delete) { this.dropDeleteReply = false; ws.terminate(); return; }
          // Echo order intentionally differs from the submitted object's order.
          const echo = message.request.update ? { update: { changes: message.request.update.changes, key: message.request.update.key } } : message.request;
          const reply = () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'action_reply', request: echo, payload: result }));
            if (this.remiFleet) this.remiFleet.publish();
            else if (this.pushDelayMs) { const config = structuredClone(this.config); setTimeout(() => { for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'config_data', payload: config })); }, this.pushDelayMs); }
            else this.broadcast();
          };
          if (this.holdAction && message.request[this.holdAction]) this.heldActionReplies.push(reply);
          else if (this.replyDelayProperty && message.request.update?.changes?.[this.replyDelayProperty] !== undefined) setTimeout(reply, this.replyDelayMs);
          else reply();
        });
      });
    });
  }
  /** Gives a camera already on the controller the address fields its model would have. */
  addressable(...keys: string[]) { for (const key of keys) this.endpoints.set('endpoint-' + key, key); }
  releaseActionReplies() { this.holdAction = ''; for (const reply of this.heldActionReplies.splice(0)) reply(); }
  broadcast() { for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'config_data', payload: this.config })); }
  async start() { await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.port = (this.server.address() as { port: number }).port; }
  socket = (url: string, options: WebSocket.ClientOptions) => { const parsed = new URL(url); return new WebSocket(`ws://127.0.0.1:${this.port}${parsed.pathname}?device=${parsed.hostname}`, options); };
  client = (address: string) => new CyanviewClient(address, { socket: this.socket, timeout: 250 });
  snapshot(address = '10.192.1.10') { return normalizeSnapshot(this.config, address); }
  private option([key, field]: string[]) {
    if (this.remiFleet && key === 'relay' && field === 'Tags') return { key, property: 'tags' };
    if (field === 'Model') return this.modelChoices.map(([label, model]) => [label, { update: { key, changes: { model } } }]);
    if (['IP', 'Port', 'Login', 'Password'].includes(field!)) return { key: [...this.endpoints].find(([, camera]) => camera === key)?.[0], property: field!.toLowerCase() };
    if (field === 'LensModel') return this.lensChoices.map(([label, model]) => [label, { update: { key: [...this.lenses].find(([, camera]) => camera === key)?.[0], changes: { model } } }]);
    if (field === 'LensParams') return { key: [...this.lenses].find(([, camera]) => camera === key)?.[0], property: 'params' };
    if (field === 'Interface') return [[{ device: 'SN', port: '*', status: 'current' }, { update: { key: [...this.endpoints].find(([, camera]) => camera === key)?.[0], changes: { content: '*' } } }]];
    if (field === 'LensInterface') return [1, 2].map(port => [{ device: 'RIO-1-10', port: String(port), status: 'free' }, [{ connect: ['physical-' + port, [...this.lenses].find(([, camera]) => camera === key)?.[0]] }]]);
    return [];
  }
  private apply(request: RecordValue): any {
    if (Array.isArray(request)) return request.map(item => this.apply(item));
    const remi = this.remiFleet?.apply(this, request);
    if (remi) return remi;
    if (request.new) {
      const key = randomUUID().slice(0, 8);
      if (request.new[0] === 'CyElement.Camera') {
        this.config.Camera[key] = { Number: '0', Name: '', Model: '', LensModel: '', LensParams: '', Interface: { device: 'SN', port: '*' } };
        this.endpoints.set('endpoint-' + randomUUID().slice(0, 8), key); this.lenses.set('lens-' + randomUUID().slice(0, 8), key);
      } else if (request.new[0] === 'CyElement.LanIp') this.config.IP[key] = { IP: '', Interface: 'LAN1', mask: '16', Type: 'LAN', ReadOnly: false, NoDelete: false };
      else return ['error', 'unsupported'];
      return ['ok', key];
    }
    if (request.delete) { const key = request.delete[0]; delete this.config.Camera[key]; delete this.config.IP[key]; this.links.delete(key); return ['ok', key]; }
    if (request.connect) {
      const [port, lens] = request.connect, camera = this.lenses.get(lens);
      if (!camera) return ['error', 'bad parameters'];
      this.config.Camera[camera].LensInterface = { device: 'RIO-1-10', port: port.split('-').at(-1), status: 'current' };
      const link = randomUUID().slice(0, 8); this.links.set(link, camera); return ['ok', link];
    }
    if (request.update) {
      const { key, changes } = request.update;
      if (this.failProperty && Object.hasOwn(changes, this.failProperty)) return ['error', 'bad parameters'];
      const camera = this.config.Camera[key];
      if (camera) for (const [field, value] of Object.entries(changes)) {
        if (field === 'model') { camera.Model = this.modelChoices.find(([, id]) => id === value)?.[0] ?? ''; for (const [endpoint, owner] of this.endpoints) if (owner === key) this.endpoints.delete(endpoint); this.endpoints.set('endpoint-' + randomUUID().slice(0, 8), key); if (value !== 'SonyDslr') Object.assign(camera, { IP: '', Port: '80', Login: '', Password: '' }); }
        else camera[field === 'number' ? 'Number' : field === 'name' ? 'Name' : field] = value;
      }
      else if (this.endpoints.has(key)) { const target = this.config.Camera[this.endpoints.get(key)!]; for (const [field, value] of Object.entries(changes)) { if (field === 'content') target.Interface = { device: 'SN', port: value }; else target[({ ip: 'IP', port: 'Port', login: 'Login', password: 'Password' } as RecordValue)[field] ?? field] = value; } }
      else if (this.lenses.has(key)) { const target = this.config.Camera[this.lenses.get(key)!]; if (changes.model !== undefined) target.LensModel = changes.model === '' ? '' : this.lensChoices.find(([, id]) => id === changes.model)?.[0] ?? ''; if (changes.params !== undefined) target.LensParams = changes.params; }
      else if (this.config.IP[key]) { for (const [field, value] of Object.entries(changes)) this.config.IP[key][({ ip: 'IP', interface: 'Interface' } as RecordValue)[field] ?? field] = value; }
      else return ['error', 'unknown element'];
      return ['ok', key];
    }
    return ['error', 'unsupported'];
  }
  async close() { for (const socket of this.sockets) socket.terminate(); await new Promise<void>(resolve => this.wss.close(() => resolve())); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

export class FakeRemiFleet {
  readonly writes: { device: string; enable: string; sourceKey: string }[] = [];
  failEnable = '';
  /** Switching an import off leaves the camera it made on the controller, as a left-behind copy. */
  keepCopies = false;
  /** Serials a controller still lists from an earlier job, which nothing on this network answers to. */
  remembered: string[] = [];
  /** Which controllers list which. Every one lists every other unless a test says otherwise. */
  sees: (from: FakeController, to: FakeController) => boolean = () => true;
  private sequence = 0;
  private sources = new Map<FakeController, { key: string; peer: string; address: string }[]>();
  private assignments = new Map<FakeController, Map<string, string>>();
  private entries = new Map<FakeController, Map<string, { sourceKey: string; source: FakeController; connection: string }>>();
  constructor(readonly devices: FakeController[]) {
    for (const device of devices) {
      device.remiFleet = this;
      device.config.Remi = { relay: { Type: 'Relay', Tags: ['fixture-access-tag'] } };
      this.sources.set(device, []);
      this.assignments.set(device, new Map());
    }
    this.sync();
  }
  /** Adds controllers to a running fleet. */
  adopt(devices: FakeController[]) {
    for (const device of devices) {
      device.remiFleet = this;
      device.config.Remi = { relay: { Type: 'Relay', Tags: ['fixture-access-tag'] } };
      this.sources.set(device, []);
      this.assignments.set(device, new Map());
      (this.devices as FakeController[]).push(device);
    }
    this.sync();
  }
  private key(prefix: string) { return prefix + (++this.sequence); }
  deviceAt(address: string) {
    return this.devices.find(device => Object.values(object(device.config.IP)).some(row => row.IP === address));
  }
  client = (address: string) => {
    const device = this.deviceAt(address);
    if (!device) throw new Error('Simulated controller is offline');
    return device.client(address);
  };
  private sync() {
    for (const [receiver, routes] of this.sources) {
      const entries = new Map();
      this.entries.set(receiver, entries);
      const assigned = this.assignments.get(receiver)!;
      for (const route of routes) {
        const source = this.deviceAt(route.address);
        const importer = { Type: 'LAN_manual', IP: route.address, Connections: {} as RecordValue };
        receiver.config.Remi[route.key] = importer;
        if (!source) continue;
        const cameras = Object.entries(object(source.config.Camera)).map(([key, row]) => {
          const selector = route.key + '-' + key;
          const local = assigned.get(selector) ?? null;
          entries.set(selector, { sourceKey: key, source, connection: route.peer });
          return [String(row.Number) + ' ' + String(row.Name), local, local ? '1' : '0', selector];
        });
        importer.Connections[route.peer] = { name: source.config.Product.Serial.toLowerCase(), connected: '1', cameras };
      }
      // Like a real controller, each one lists every other it has seen, whether or not it takes cameras from it.
      for (const key of Object.keys(receiver.config.Remi)) if (key.startsWith('seen-')) delete receiver.config.Remi[key];
      for (const other of this.devices) if (other !== receiver && this.sees(receiver, other)) {
        const serial = String(other.config.Product.Serial).toLowerCase();
        receiver.config.Remi['seen-' + serial] = { Type: 'LAN_auto', IP: other.config.IP.protected.IP, Connections: { ['seen-' + serial]: { name: serial, connected: '1', cameras: [] } } };
      }
      for (const serial of this.remembered) receiver.config.Remi['seen-' + serial] = { Type: 'LAN_auto', IP: '', Connections: { ['seen-' + serial]: { name: serial, connected: '0', cameras: [] } } };
    }
  }
  publish() { this.sync(); for (const device of this.devices) device.broadcast(); }
  elements(receiver: FakeController) {
    return [...this.entries.get(receiver)!.entries()].map(([key, row]) => ({
      key, module: 'CyElement.ImportedDevice', parents: [row.connection],
      properties: { role: 'camera', device_id: row.source.config.Product.Serial.toLowerCase() + '.' + row.sourceKey },
    }));
  }
  apply(receiver: FakeController, request: RecordValue): string[] | undefined {
    if (request.new?.[0] === 'CyElement.SessionImporter') {
      const key = this.key('importer');
      this.sources.get(receiver)!.push({ key, peer: this.key('peer'), address: request.new[1] });
      this.sync();
      return ['ok', key];
    }
    const update = request.update;
    if (!update) return;
    if (update.key === 'relay' && typeof update.changes.tags === 'string') {
      receiver.config.Remi.relay.Tags = update.changes.tags.split(',').filter(Boolean);
      return ['ok', 'relay'];
    }
    const enable = update.changes.auto_camera;
    if (enable !== '0' && enable !== '1') return;
    const entry = this.entries.get(receiver)!.get(update.key);
    if (!entry) return ['error', 'unknown REMI camera'];
    if (enable === '1' && receiver.config.Product.Serial === this.failEnable) return ['error', 'simulated import failure'];
    const assignments = this.assignments.get(receiver)!;
    const previous = assignments.get(update.key);
    this.writes.push({ device: receiver.config.Product.Serial, enable, sourceKey: entry.sourceKey });
    if (enable === '1' && !previous) {
      const key = this.key('copy');
      const row = entry.source.config.Camera[entry.sourceKey];
      receiver.config.Camera[key] = { Number: row.Number, Name: row.Name, Model: 'Cyan - Imported' };
      assignments.set(update.key, key);
    } else if (enable === '0' && previous) {
      if (!this.keepCopies) delete receiver.config.Camera[previous];
      assignments.delete(update.key);
    }
    return ['ok', update.key];
  }
}
export function planFor(controller: FakeController): Plan { const snapshot = controller.snapshot(); return { formatVersion: 1, devices: [snapshot.device], cameras: [], lans: snapshot.lans, uiState: null }; }
