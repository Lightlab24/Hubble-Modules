import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

/**
 * Connections between the module and its simulated controllers that never leave the worker. Nothing here opens a
 * socket, listens on a port or touches the network: each end hands what is written to the other on the next turn of
 * the event loop, the way a local socket would.
 */

const CONNECTING = 0, OPEN = 1, CLOSED = 3;

/** One end of an in-memory settings socket. It answers to what the module's controller client and the simulated controllers use of `ws`. */
export class MemoryWebSocket extends EventEmitter {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;
  readyState = CONNECTING;
  peer?: MemoryWebSocket;
  constructor() { super(); this.on('error', () => undefined); }
  send(data: string | Buffer) {
    if (this.readyState !== OPEN) return;
    const peer = this.peer, text = Buffer.from(data);
    setImmediate(() => { if (peer?.readyState === OPEN && this.readyState === OPEN) peer.emit('message', text, false); });
  }
  /** A controller answers a WebSocket ping by itself, as `ws` does. */
  ping() {
    if (this.readyState !== OPEN) return;
    setImmediate(() => { if (this.readyState === OPEN && this.peer?.readyState === OPEN) this.emit('pong', Buffer.alloc(0)); });
  }
  terminate() { this.end(); this.peer?.end(); }
  close() { this.terminate(); }
  private end() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    setImmediate(() => this.emit('close', 1006, Buffer.alloc(0)));
  }
}

/** A connected pair: the module's end, and the simulated controller's. */
export function memoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const client = new MemoryWebSocket(), server = new MemoryWebSocket();
  client.peer = server; server.peer = client;
  return [client, server];
}

/** A settings socket to an address no simulated controller has, which fails as a refused connection does. */
export function refusedWebSocket(): MemoryWebSocket {
  const socket = new MemoryWebSocket();
  setImmediate(() => { socket.emit('error', new Error('connect ECONNREFUSED')); socket.terminate(); });
  return socket;
}

/** One end of an in-memory byte stream with the parts of `net.Socket` the module's MQTT session uses. */
export class MemoryStream extends Duplex {
  peer?: MemoryStream;
  private idleMs = 0;
  private idle?: ReturnType<typeof setTimeout>;
  constructor() { super({ allowHalfOpen: false }); }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const peer = this.peer;
    this.touch();
    setImmediate(() => { if (peer && !peer.destroyed) { peer.touch(); peer.push(chunk); } done(); });
  }
  override _final(done: (error?: Error | null) => void) { this.peer?.push(null); done(); }
  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    clearTimeout(this.idle);
    const peer = this.peer;
    if (peer && !peer.destroyed) setImmediate(() => peer.destroy());
    done(error);
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  /** Emits `timeout` after this long with nothing sent or received, as `net.Socket` does. Zero turns it off. */
  setTimeout(ms: number, listener?: () => void) {
    this.idleMs = ms;
    if (listener) this.once('timeout', listener);
    this.touch();
    return this;
  }
  private touch() {
    clearTimeout(this.idle);
    if (this.idleMs > 0 && !this.destroyed) { this.idle = setTimeout(() => this.emit('timeout'), this.idleMs); this.idle.unref(); }
  }
}

/** A connected pair: the module's end, which reports `connect` as a TCP socket would, and the simulated broker's. */
export function memoryStreamPair(): [MemoryStream, MemoryStream] {
  const client = new MemoryStream(), server = new MemoryStream();
  client.peer = server; server.peer = client;
  setImmediate(() => { if (!client.destroyed) client.emit('connect'); });
  return [client, server];
}

/** A stream to an address no simulated controller answers on, which fails as a refused connection does. */
export function refusedStream(): MemoryStream {
  const stream = new MemoryStream();
  setImmediate(() => stream.destroy(new Error('connect ECONNREFUSED')));
  return stream;
}
