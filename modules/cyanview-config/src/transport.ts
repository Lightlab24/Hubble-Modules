import WebSocket from 'ws';
import { stable, validIp, type RecordValue } from './model.js';
import type { RemiSelector } from './remi-model.js';

/**
 * Each camera's port as its network endpoint holds it. A RIO gives a model its port when the model is set
 * (a Burano's is 22) but doesn't list it on the camera; the endpoint is the camera control's first parent.
 */
export function endpointPorts(elements: unknown): Map<string, string> {
  const rows = (Array.isArray(elements) ? elements : []).filter(row => row && typeof row === 'object') as RecordValue[];
  const endpoints = new Map(rows.filter(row => row.module === 'CyElement.IpEndpoint' && typeof row.key === 'string').map(row => [row.key as string, row]));
  const ports = new Map<string, string>();
  for (const row of rows) {
    if (row.module !== 'CyElement.CamCtrl' || !Array.isArray(row.parents)) continue;
    const [endpointKey, cameraKey] = row.parents, endpoint = endpoints.get(String(endpointKey));
    if (endpoint && typeof cameraKey === 'string' && typeof endpoint.properties?.port === 'string') ports.set(cameraKey, endpoint.properties.port);
  }
  return ports;
}
export type SocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
export type ClientOptions = { timeout?: number; socket?: SocketFactory };
export class CyanviewClient {
  config: RecordValue = {};
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: { type: string; request: unknown; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void } | undefined;
  private configListeners = new Set<(config: RecordValue) => void>();
  private disconnected = false;
  private disconnectListeners = new Set<() => void>();
  private lastMessage = Date.now();
  constructor(readonly address: string, private options: ClientOptions = {}) { if (!validIp(address)) throw new Error('Enter a valid controller IPv4 address'); }
  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.socket?.readyState === WebSocket.OPEN && this.config.Product) return;
    this.disconnected = false;
    const socket = (this.options.socket ?? ((url, options) => new WebSocket(url, options)))(`ws://${this.address}/ws/ui`, { origin: `http://${this.address}`, handshakeTimeout: this.options.timeout ?? 5000, maxPayload: 8 * 1024 * 1024 });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); this.configListeners.delete(ready);
        if (error) { this.close(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Controller did not provide a configuration snapshot')), this.options.timeout ?? 5000);
      const abort = () => finish(new Error('Operation cancelled'));
      const ready = (config: RecordValue) => { if (typeof config.Product?.Serial === 'string' && config.Product.Serial.trim()) finish(); };
      this.configListeners.add(ready); signal.addEventListener('abort', abort, { once: true });
      socket.on('message', raw => {
        this.lastMessage = Date.now();
        const text = raw.toString(); if (text === 'pong') return;
        if (text === 'ping') { if (socket.readyState === WebSocket.OPEN) socket.send('pong'); return; }
        let value: RecordValue; try { value = JSON.parse(text); } catch { return; }
        if (value.type === 'config_data' && value.payload && typeof value.payload === 'object') {
          this.config = value.payload; for (const listener of this.configListeners) listener(this.config);
        }
        const request = this.pending;
        if (request && value.type === request.type && stable(value.request) === stable(request.request)) {
          this.pending = undefined; clearTimeout(request.timer); request.cleanup(); request.resolve(value.payload);
        }
      });
      socket.on('pong', () => { this.lastMessage = Date.now(); });
      socket.once('error', () => { finish(new Error('Controller connection failed')); this.failPending('Controller connection failed'); });
      socket.once('close', () => { this.disconnected = true; finish(new Error('Controller disconnected')); this.failPending('Controller disconnected before the result was confirmed'); for (const listener of this.disconnectListeners) listener(); });
    });
    this.lastMessage = Date.now();
    this.heartbeat = setInterval(() => { if (Date.now() - this.lastMessage > 15000) this.close(); else if (socket.readyState === WebSocket.OPEN) { socket.send('ping'); socket.ping(); } }, 3000);
    this.heartbeat.unref?.();
  }
  get serial(): string { return String(this.config.Product?.Serial ?? ''); }
  /** How long since the controller last sent anything on this socket, its answer to the heartbeat included. */
  get quietMs(): number { return Date.now() - this.lastMessage; }
  /** True on a socket lent by `lend()`, which its borrower can't close. */
  readonly lent: boolean = false;
  /**
   * This open socket, lent to a piece of work that would otherwise open another. Everything the work sends goes
   * down the same socket, in turn with whoever else is using it, and the controller's reports reach them all.
   * `close()` on the loan only ends that work's use of it: the socket stays open for whoever holds it.
   */
  lend(): CyanviewClient {
    const giveBack = () => {};
    return new Proxy(this, {
      get: (target, key) => {
        if (key === 'close') return giveBack;
        if (key === 'lent') return true;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  get connected(): boolean { return !this.disconnected && this.socket?.readyState === WebSocket.OPEN; }
  onConfig(listener: (config: RecordValue) => void) { this.configListeners.add(listener); return () => this.configListeners.delete(listener); }
  onDisconnect(listener: () => void) { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  async waitFor(test: (config: RecordValue) => boolean, signal: AbortSignal) {
    if (test(this.config)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.configListeners.delete(changed); signal.removeEventListener('abort', abort); };
      const changed = (value: RecordValue) => { if (test(value)) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(new Error('Operation cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Configuration readback timed out')); }, this.options.timeout ?? 5000);
      this.configListeners.add(changed); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  /** Resolves once the controller has pushed no configuration change for quietMs, or after limitMs at most. */
  async settle(quietMs: number, limitMs: number, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(quiet); clearTimeout(limit); this.configListeners.delete(changed); signal.removeEventListener('abort', abort); };
      const done = () => { cleanup(); resolve(); };
      let quiet = setTimeout(done, quietMs);
      const limit = setTimeout(done, limitMs);
      const changed = () => { clearTimeout(quiet); quiet = setTimeout(done, quietMs); };
      const abort = () => { cleanup(); reject(new Error('Operation cancelled')); };
      this.configListeners.add(changed); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  private failPending(message: string) { const pending = this.pending; if (!pending) return; this.pending = undefined; clearTimeout(pending.timer); pending.cleanup(); pending.reject(new Error(message)); }
  request(kind: 'action' | 'option', request: unknown, signal: AbortSignal): Promise<any> {
    const task = this.tail.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      if (this.disconnected || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Controller is disconnected');
      return new Promise<any>((resolve, reject) => {
        const abort = () => { this.failPending('Operation cancelled; check the current configuration before retrying'); this.close(); };
        const timer = setTimeout(() => { this.failPending('Controller reply timed out; check the current configuration before retrying'); this.close(); }, this.options.timeout ?? 5000);
        this.pending = { type: kind + '_reply', request, resolve, reject, timer, cleanup: () => signal.removeEventListener('abort', abort) };
        signal.addEventListener('abort', abort, { once: true });
        try { this.socket!.send(JSON.stringify({ type: kind + '_request', request })); } catch { abort(); }
      });
    });
    this.tail = task; return task;
  }
  option(key: string, field: string, signal: AbortSignal) { return this.request('option', [key, field], signal); }
  async action(request: unknown, signal: AbortSignal): Promise<any> {
    const payload = await this.request('action', request, signal);
    const accepted = (result: unknown): boolean => Array.isArray(result) && (result[0] === 'ok' || (result.length > 0 && result.every(accepted)));
    if (!accepted(payload)) throw new Error('Controller rejected the requested configuration');
    return payload;
  }
  async update(key: string, changes: RecordValue, signal: AbortSignal) { await this.action({ update: { key, changes } }, signal); }
  async mapping(key: string, field: string, signal: AbortSignal): Promise<{ key: string; property: string }> {
    const mapping = await this.option(key, field, signal);
    if (!mapping || typeof mapping.key !== 'string' || typeof mapping.property !== 'string') throw new Error(`${field} is not writable for the current device/model`);
    return mapping;
  }
  async readRemiSelectors(signal: AbortSignal): Promise<Map<string, RemiSelector>> {
    signal.throwIfAborted();
    if (!this.connected || !this.serial) throw new Error('Verify the controller before reading REMI selectors');
    const socket = (this.options.socket ?? ((url, options) => new WebSocket(url, options)))('ws://' + this.address + '/ws', {
      origin: 'http://' + this.address, handshakeTimeout: this.options.timeout ?? 5000, maxPayload: 8 * 1024 * 1024,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result?: Map<string, RemiSelector>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.terminate();
        if (result) resolve(result);
        else reject(new Error('REMI camera identities could not be read'));
      };
      const abort = () => finish();
      const timer = setTimeout(abort, this.options.timeout ?? 5000);
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', abort);
      socket.on('close', abort);
      socket.on('message', raw => {
        let message: RecordValue;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!Array.isArray(message.elements)) return;
        const selectors = new Map<string, RemiSelector>();
        for (const row of message.elements) {
          if (row?.module !== 'CyElement.ImportedDevice' || row.properties?.role !== 'camera' ||
            typeof row.key !== 'string' || typeof row.parents?.[0] !== 'string' ||
            typeof row.properties.device_id !== 'string') continue;
          selectors.set(row.key, { connection: row.parents[0], deviceId: row.properties.device_id });
        }
        finish(selectors);
      });
    });
  }
  /** Each camera's endpoint port, read from the element list. Empty when the list can't be read. */
  async readEndpointPorts(signal: AbortSignal): Promise<Map<string, string>> {
    if (!this.connected || signal.aborted) return new Map();
    const socket = (this.options.socket ?? ((url, options) => new WebSocket(url, options)))('ws://' + this.address + '/ws', {
      origin: 'http://' + this.address, handshakeTimeout: this.options.timeout ?? 5000, maxPayload: 8 * 1024 * 1024,
    });
    return new Promise(resolve => {
      let settled = false;
      const finish = (ports: Map<string, string>) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket.terminate(); resolve(ports);
      };
      const abort = () => finish(new Map());
      const timer = setTimeout(abort, this.options.timeout ?? 5000);
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', abort);
      socket.on('close', abort);
      socket.on('message', raw => {
        let message: RecordValue;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (Array.isArray(message.elements)) finish(endpointPorts(message.elements));
      });
    });
  }
  close() {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.disconnected = true; this.failPending('Controller connection closed');
    const socket = this.socket; this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}
