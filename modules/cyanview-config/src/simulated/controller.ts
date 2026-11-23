import { randomUUID } from 'node:crypto';
import { CyanviewClient, type SocketFactory } from '../transport.js';
import { object, type RecordValue } from '../model.js';
import { normalizeSnapshot } from '../normalize.js';
import { memoryWebSocketPair, refusedWebSocket } from './sockets.js';

const OPEN = 1;
/** What a simulated controller needs of a settings socket's far end: a `ws` server socket or an in-memory one. */
export type PeerSocket = {
  readonly readyState: number;
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
};
/** What a simulated controller keeps, so the simulated rig can be put back after the worker restarts. */
export type SimulatedControllerState = { config: RecordValue; endpoints: [string, string][]; lenses: [string, string][]; links: [string, string][] };

/**
 * A Cyanview RCP, RIO or Gateway as its settings socket (`/ws/ui`) and element list (`/ws`) show it. It applies the
 * actions the module sends, answers its option questions, and pushes its whole configuration to every open socket
 * after each change, as a real controller does. Its sockets are in memory and never reach the network. The module's
 * tests reach the same controller over a loopback WebSocket server, and set the switches below to make it misbehave.
 */
export class SimulatedController {
  remiFleet?: SimulatedRemiFleet;
  sockets = new Set<PeerSocket>();
  /** The address each open socket reached this controller by. A socket ends when its address leaves the controller. */
  private reachedBy = new Map<PeerSocket, string | null>();
  actions: RecordValue[] = [];
  origins: string[] = [];
  options: string[] = [];
  opened = 0;
  /** The path of every socket opened, in order: `/ws/ui` is a settings socket, `/ws` a read of the element list. */
  paths: string[] = [];
  failProperty = '';
  dropCreateReply = false;
  dropDeleteReply = false;
  /** The controller says no to deleting a camera, as one that is busy with it does. */
  refuseCameraDeletes = false;
  wrongIdentity = false;
  replyDelayProperty = '';
  replyDelayMs = 0;
  /** How long the controller takes to answer a question about a setting's choices. */
  optionDelayMs = 0;
  /** A controller answers a write at once and pushes its changed configuration a little later. */
  pushDelayMs = 0;
  holdAction = '';
  heldActionReplies: (() => void)[] = [];
  replyTextHeartbeat = true;
  /** Extra elements the /ws element list reports, such as a camera's network endpoint and camera control. */
  endpointElements?: () => RecordValue[];
  /** Sees every action as it arrives, so a test can check the order across controllers. */
  onAction?: (request: RecordValue) => void;
  /** Told after each action has been applied and pushed, so the rig can report the change over MQTT and save it. */
  changed?: () => void;
  /** Keeps every action, option question and socket in the lists above, for tests. A rig that runs for hours keeps none. */
  history = true;
  modelChoices = [['Sony - Venice-IP', 'VeniceCBM'], ['Sony - Alpha-USB', 'SonyDslr'], ['Sony - Alpha-IP', 'SonyDslrIP']];
  lensChoices = [['None', ''], ['B4 Generic', 'sony'], ['Tilta - Nucleus-M', 'tilta'], ['ARRI - cforce', 'arri_motor'], ['cmotion cGate', 'cgate']];
  config: RecordValue = { Product: { Serial: 'CY-RIO-1-10', Name: 'RIO', MaxCam: 'unlimited' }, Camera: {}, IP: {
    protected: { IP: '10.192.1.10', Interface: 'LAN1', Type: 'Local', mask: '16', ReadOnly: true, NoDelete: true },
    old: { IP: '10.20.101.200', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
  } };
  protected endpoints = new Map<string, string>();
  protected lenses = new Map<string, string>();
  protected links = new Map<string, string>();
  /** An address that was changed or removed takes the sockets that were open on it, as it does on a real controller. */
  private addressGone(address: unknown) {
    if (!address || this.answers(String(address))) return;
    for (const [socket, reached] of this.reachedBy) if (reached === address) socket.terminate();
  }
  /** Whether one of this controller's addresses is this one. */
  answers(address: string | null) { return Object.values(object(this.config.IP)).some(row => object(row).IP === address); }
  /** A new settings socket from the module, at one of this controller's addresses. */
  accept(ws: PeerSocket, path: string, address: string | null, origin: string) {
    this.sockets.add(ws); this.opened++; this.reachedBy.set(ws, address);
    if (this.history) { this.paths.push(path); this.origins.push(origin); }
    ws.once('close', () => { this.sockets.delete(ws); this.reachedBy.delete(ws); });
    if (path === '/ws' && (this.remiFleet || this.endpointElements)) {
      ws.send(JSON.stringify({ elements: [...(this.remiFleet?.elements(this) ?? []), ...(this.endpointElements?.() ?? [])], version: 1 })); return;
    }
    const config = structuredClone(this.config);
    if (this.wrongIdentity && address !== '10.192.1.10' && address !== '10.20.101.200') config.Product.Serial = 'ANOTHER-CONTROLLER';
    ws.send(JSON.stringify({ type: 'config_data', payload: config }));
    ws.on('message', raw => {
      if (raw.toString() === 'ping') { if (this.replyTextHeartbeat) ws.send('pong'); return; }
      const message = JSON.parse(raw.toString());
      if (message.type === 'option_request') {
        if (this.history) this.options.push(message.request[1]);
        const answer = () => { if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'option_reply', request: message.request, payload: this.option(message.request) })); };
        if (this.optionDelayMs) setTimeout(answer, this.optionDelayMs); else answer();
        return;
      }
      if (message.type !== 'action_request') return;
      if (this.history) this.actions.push(structuredClone(message.request));
      this.onAction?.(structuredClone(message.request));
      const result = this.apply(message.request);
      if (this.dropCreateReply && message.request.new) { this.dropCreateReply = false; this.broadcast(); this.changed?.(); return; }
      if (this.dropDeleteReply && message.request.delete) { this.dropDeleteReply = false; ws.terminate(); this.changed?.(); return; }
      // Echo order intentionally differs from the submitted object's order.
      const echo = message.request.update ? { update: { changes: message.request.update.changes, key: message.request.update.key } } : message.request;
      const reply = () => {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'action_reply', request: echo, payload: result }));
        if (this.remiFleet) this.remiFleet.publish();
        else if (this.pushDelayMs) { const config = structuredClone(this.config); setTimeout(() => { for (const socket of this.sockets) if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'config_data', payload: config })); }, this.pushDelayMs); }
        else this.broadcast();
        this.changed?.();
      };
      if (this.holdAction && message.request[this.holdAction]) this.heldActionReplies.push(reply);
      else if (this.replyDelayProperty && message.request.update?.changes?.[this.replyDelayProperty] !== undefined) setTimeout(reply, this.replyDelayMs);
      else reply();
    });
  }
  /**
   * A WAN setting like the one a RIO WAN showed on Nov 17, 2026: on DHCP, nothing else set, and kept
   * across restarts. Its page writes it through the commands this controller answers below.
   */
  addWan(values: RecordValue = {}) {
    this.config.IP.wan = { DHCP: true, DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: 'LAN1', Locked: true, NoDelete: true, ReadOnly: false, Type: 'WAN', mask: '', ...values };
  }
  /** Gives a camera already on the controller the address fields its model would have. */
  addressable(...keys: string[]) { for (const key of keys) this.endpoints.set('endpoint-' + key, key); }
  /** Puts a camera on the controller as if it had been made there, with its own address and lens elements. */
  addCamera(key: string, row: RecordValue) {
    this.config.Camera[key] = row;
    this.endpoints.set('endpoint-' + key, key); this.lenses.set('lens-' + key, key);
  }
  releaseActionReplies() { this.holdAction = ''; for (const reply of this.heldActionReplies.splice(0)) reply(); }
  broadcast() { for (const socket of this.sockets) if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'config_data', payload: this.config })); }
  /** A settings socket to this controller that stays in memory. An address it doesn't have refuses the connection. */
  socket: SocketFactory = (url, options) => {
    const parsed = new URL(url), address = parsed.hostname;
    if (!this.answers(address)) return refusedWebSocket() as never;
    const [client, server] = memoryWebSocketPair();
    client.readyState = server.readyState = OPEN;
    setImmediate(() => { if (server.readyState === OPEN) this.accept(server, parsed.pathname, address, String(options.origin)); });
    return client as never;
  };
  client = (address: string) => new CyanviewClient(address, { socket: this.socket, timeout: 250 });
  snapshot(address = '10.192.1.10') { return normalizeSnapshot(this.config, address); }
  state(): SimulatedControllerState {
    return { config: structuredClone(this.config), endpoints: [...this.endpoints], lenses: [...this.lenses], links: [...this.links] };
  }
  restore(state: SimulatedControllerState) {
    this.config = structuredClone(state.config);
    this.endpoints = new Map(state.endpoints); this.lenses = new Map(state.lenses); this.links = new Map(state.links);
  }
  protected option([key, field]: string[]) {
    // What a RIO WAN answered for its WAN setting. DHCP comes as the controller's own on and off commands,
    // and turning it on blanks the address, mask, gateway and DNS in the same write.
    if (this.config.IP[key!]?.Type === 'WAN') {
      if (field === 'DHCP') return [[false, { update: { changes: { dhcp: 'no' }, key } }], [true, { update: { changes: { dhcp: 'yes', dns: '', dns2: '', gateway: '', ip: '', mask: '' }, key } }]];
      const property = ({ DNS1: 'dns', DNS2: 'dns2', Gateway: 'gateway', mask: 'mask' } as RecordValue)[field!];
      return property ? { key, property } : [];
    }
    if (this.remiFleet && key === 'relay' && field === 'Tags') return { key, property: 'tags' };
    if (field === 'Enabled') return this.config.Camera[key!] ? { key, property: 'enabled' } : [];
    if (field === 'Model') return this.modelChoices.map(([label, model]) => [label, { update: { key, changes: { model } } }]);
    if (['IP', 'Port', 'Login', 'Password'].includes(field!)) return { key: [...this.endpoints].find(([, camera]) => camera === key)?.[0], property: field!.toLowerCase() };
    if (field === 'LensModel') return this.lensChoices.map(([label, model]) => [label, { update: { key: [...this.lenses].find(([, camera]) => camera === key)?.[0], changes: { model } } }]);
    if (field === 'LensParams') return { key: [...this.lenses].find(([, camera]) => camera === key)?.[0], property: 'params' };
    if (field === 'Interface') return [[{ device: 'SN', port: '*', status: 'current' }, { update: { key: [...this.endpoints].find(([, camera]) => camera === key)?.[0], changes: { content: '*' } } }]];
    if (field === 'LensInterface') return [1, 2].map(port => [{ device: 'RIO-1-10', port: String(port), status: 'free' }, [{ connect: ['physical-' + port, [...this.lenses].find(([, camera]) => camera === key)?.[0]] }]]);
    return [];
  }
  protected apply(request: RecordValue): any {
    if (Array.isArray(request)) return request.map(item => this.apply(item));
    if (this.refuseCameraDeletes && request.delete && this.config.Camera[request.delete[0]]) return ['error', 'busy'];
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
    if (request.delete) { const key = request.delete[0], address = this.config.IP[key]?.IP; delete this.config.Camera[key]; delete this.config.IP[key]; this.links.delete(key); this.addressGone(address); return ['ok', key]; }
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
        else camera[field === 'number' ? 'Number' : field === 'name' ? 'Name' : field === 'enabled' ? 'Enabled' : field] = value;
      }
      else if (this.endpoints.has(key)) { const target = this.config.Camera[this.endpoints.get(key)!]; for (const [field, value] of Object.entries(changes)) { if (field === 'content') target.Interface = { device: 'SN', port: value }; else target[({ ip: 'IP', port: 'Port', login: 'Login', password: 'Password' } as RecordValue)[field] ?? field] = value; } }
      else if (this.lenses.has(key)) { const target = this.config.Camera[this.lenses.get(key)!]; if (changes.model !== undefined) target.LensModel = changes.model === '' ? '' : this.lensChoices.find(([, id]) => id === changes.model)?.[0] ?? ''; if (changes.params !== undefined) target.LensParams = changes.params; }
      else if (this.config.IP[key]) { const address = this.config.IP[key].IP; for (const [field, value] of Object.entries(changes)) this.config.IP[key][({ ip: 'IP', interface: 'Interface', dhcp: 'DHCP', dns: 'DNS1', dns2: 'DNS2', gateway: 'Gateway' } as RecordValue)[field] ?? field] = field === 'dhcp' ? value === 'yes' : value; if (this.config.IP[key].IP !== address) this.addressGone(address); }
      else return ['error', 'unknown element'];
      return ['ok', key];
    }
    return ['error', 'unsupported'];
  }
  /** Drops every open socket, as a controller going off the network does. */
  async close() { for (const socket of this.sockets) socket.terminate(); }
}

/** What a REMI fleet keeps, by each controller's place in the rig, so it can be put back after a restart. */
export type SimulatedFleetState = { sequence: number; sources: { key: string; peer: string; address: string }[][]; assignments: [string, string][][] };

/**
 * REMI between simulated controllers: each one's manual connections to the others, the cameras it takes from them as
 * copies, and the list of every other controller it has seen.
 */
export class SimulatedRemiFleet {
  readonly writes: { device: string; enable: string; sourceKey: string }[] = [];
  /** Keeps every REMI write in `writes`, for tests. */
  history = true;
  failEnable = '';
  /** Switching an import off leaves the camera it made on the controller, as a left-behind copy. */
  keepCopies = false;
  /** Serials a controller still lists from an earlier job, which nothing on this network answers to. */
  remembered: string[] = [];
  /**
   * Controllers switched off. Nothing reaches them, and the others stop listing their cameras but keep the
   * copies they made from them, as the Gateway did with a RIO that went off on Nov 20, 2026.
   */
  readonly off = new Set<SimulatedController>();
  /** Which controllers list which. Every one lists every other unless a test says otherwise. */
  sees: (from: SimulatedController, to: SimulatedController) => boolean = () => true;
  private sequence = 0;
  private sources = new Map<SimulatedController, { key: string; peer: string; address: string }[]>();
  private assignments = new Map<SimulatedController, Map<string, string>>();
  private entries = new Map<SimulatedController, Map<string, { sourceKey: string; source: SimulatedController; connection: string }>>();
  constructor(readonly devices: SimulatedController[]) {
    for (const device of devices) {
      device.remiFleet = this;
      device.config.Remi = { relay: { Type: 'Relay', Tags: ['fixture-access-tag'] } };
      this.sources.set(device, []);
      this.assignments.set(device, new Map());
    }
    this.sync();
  }
  /** Adds controllers to a running fleet. */
  adopt(devices: SimulatedController[]) {
    for (const device of devices) {
      device.remiFleet = this;
      device.config.Remi = { relay: { Type: 'Relay', Tags: ['fixture-access-tag'] } };
      this.sources.set(device, []);
      this.assignments.set(device, new Map());
      (this.devices as SimulatedController[]).push(device);
    }
    this.sync();
  }
  private key(prefix: string) { return prefix + (++this.sequence); }
  deviceAt(address: string) {
    return this.devices.find(device => !this.off.has(device) && Object.values(object(device.config.IP)).some(row => row.IP === address));
  }
  /** Switches a controller off or back on. Its open sockets drop when it goes off. */
  power(device: SimulatedController, on: boolean) {
    if (on) this.off.delete(device);
    else { this.off.add(device); for (const socket of device.sockets) socket.terminate(); }
    this.publish();
  }
  client = (address: string) => {
    const device = this.deviceAt(address);
    if (!device) throw new Error('Simulated controller is offline');
    return device.client(address);
  };
  /** The camera a REMI copy on this controller is taken from, one hop back. Nothing for a camera that isn't a copy, or whose source has gone. */
  source(device: SimulatedController, key: string): { device: SimulatedController; key: string } | undefined {
    const selector = [...this.assignments.get(device) ?? []].find(([, copy]) => copy === key)?.[0];
    const entry = selector === undefined ? undefined : this.entries.get(device)?.get(selector);
    return entry ? { device: entry.source, key: entry.sourceKey } : undefined;
  }
  /** The camera a copy on this controller comes from, followed back through any chain to the controller it is plugged into. */
  origin(device: SimulatedController, key: string): { device: SimulatedController; key: string } {
    const seen = new Set<string>();
    let current = { device, key };
    for (let next = this.source(device, key); next && !seen.has(this.devices.indexOf(next.device) + '/' + next.key); next = this.source(next.device, next.key)) {
      seen.add(this.devices.indexOf(next.device) + '/' + next.key);
      current = next;
    }
    return current;
  }
  /** Whether this camera on this controller is a REMI copy. */
  isCopy(device: SimulatedController, key: string) { return [...this.assignments.get(device)?.values() ?? []].includes(key); }
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
      for (const other of this.devices) if (other !== receiver && !this.off.has(other) && this.sees(receiver, other)) {
        const serial = String(other.config.Product.Serial).toLowerCase();
        receiver.config.Remi['seen-' + serial] = { Type: 'LAN_auto', IP: other.config.IP.protected.IP, Connections: { ['seen-' + serial]: { name: serial, connected: '1', cameras: [] } } };
      }
      for (const serial of this.remembered) receiver.config.Remi['seen-' + serial] = { Type: 'LAN_auto', IP: '', Connections: { ['seen-' + serial]: { name: serial, connected: '0', cameras: [] } } };
    }
  }
  publish() { this.sync(); for (const device of this.devices) if (!this.off.has(device)) device.broadcast(); }
  elements(receiver: SimulatedController) {
    return [...this.entries.get(receiver)!.entries()].map(([key, row]) => ({
      key, module: 'CyElement.ImportedDevice', parents: [row.connection],
      properties: { role: 'camera', device_id: row.source.config.Product.Serial.toLowerCase() + '.' + row.sourceKey },
    }));
  }
  apply(receiver: SimulatedController, request: RecordValue): string[] | undefined {
    if (request.new?.[0] === 'CyElement.SessionImporter') {
      const key = this.key('importer');
      this.sources.get(receiver)!.push({ key, peer: this.key('peer'), address: request.new[1] });
      this.sync();
      return ['ok', key];
    }
    // A deleted copy is no longer what its import feeds.
    if (request.delete) for (const [selector, key] of this.assignments.get(receiver)!) if (key === request.delete[0]) this.assignments.get(receiver)!.delete(selector);
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
    if (this.history) this.writes.push({ device: receiver.config.Product.Serial, enable, sourceKey: entry.sourceKey });
    if (enable === '1' && !previous) {
      const key = this.key('copy');
      const row = entry.source.config.Camera[entry.sourceKey];
      // A copy names the controller and camera it came from, as real copies do.
      receiver.config.Camera[key] = { Number: row.Number, Name: row.Name, Model: 'Cyan - Imported', Enabled: '1', Interface: { device: '(D)' + String(entry.source.config.Product.Serial).toLowerCase(), port: entry.sourceKey } };
      assignments.set(update.key, key);
    } else if (enable === '0' && previous) {
      if (!this.keepCopies) delete receiver.config.Camera[previous];
      assignments.delete(update.key);
    }
    return ['ok', update.key];
  }
  state(): SimulatedFleetState {
    return { sequence: this.sequence, sources: this.devices.map(device => structuredClone(this.sources.get(device) ?? [])), assignments: this.devices.map(device => [...this.assignments.get(device) ?? []]) };
  }
  /** Puts back what `state` returned, after each controller's own state is back. */
  restore(state: SimulatedFleetState) {
    this.sequence = state.sequence;
    this.devices.forEach((device, index) => { this.sources.set(device, structuredClone(state.sources[index] ?? [])); this.assignments.set(device, new Map(state.assignments[index] ?? [])); });
    this.sync();
  }
}
