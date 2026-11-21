/**
 * The binary form of Ross's openGear protocol (OGP), as a Carbonite switcher speaks it
 * on TCP port 5253. Written from the public openGear development guide and from frames
 * seen on a Carbonite Ultra (software 9.2.1).
 *
 * A frame is: sync BA D2 AC E5, source, destination, type, a 16-bit length, content.
 * A reply has the request's type with the top bit set. The switcher also sends frames
 * nobody asked for (value reports), so a reply is matched by type and parameter number.
 */
import net from "node:net";

export const OGP_DEFAULT_PORT = 5253;
/** Writing this parameter asks the switcher to accept the connection. */
export const OGP_CONNECTION_OID = 0xff03;

const SYNC = Buffer.from([0xba, 0xd2, 0xac, 0xe5]);
const HEADER_BYTES = 9;
const MAX_CONTENT_BYTES = 8192;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CLIENT_ADDRESS = 0x00;
const SWITCHER_ADDRESS = 0x10;
const GET_DESCRIPTOR = 0x47;
const GET_PARAM = 0x49;
const SET_PARAM = 0x4a;
const RESPONSE_BIT = 0x80;
const DEFAULT_TIMEOUT_MS = 3000;

const RETURN_CODES: Readonly<Record<number, string>> = {
  0x11: "The switcher doesn't have that setting",
  0x12: "The switcher refused that value",
  0x13: "The switcher says that setting can't be changed",
  0x14: "The switcher has that setting locked",
  0x15: "The switcher refused that list position",
};

/** A failure talking to the switcher. `code` is the switcher's own return code, when it gave one. */
export class OgpError extends Error {
  readonly code: number | null;
  readonly oid: number | null;
  constructor(
    message: string,
    options: { code?: number; oid?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "OgpError";
    this.code = options.code ?? null;
    this.oid = options.oid ?? null;
  }
}

/** The operator, or Hubble, stopped the work. */
export class OgpAbortError extends OgpError {
  constructor() {
    super("Stopped before the switcher answered");
    this.name = "AbortError";
  }
}

export type OgpSocket = Pick<
  net.Socket,
  "on" | "once" | "write" | "destroy" | "setNoDelay"
>;
export type OgpConnect = (options: { host: string; port: number }) => OgpSocket;

export interface OgpBinaryClientOptions {
  readonly host: string;
  readonly port?: number | undefined;
  /** How long to wait for the connection and for each reply. */
  readonly timeoutMs?: number | undefined;
  /** The only parameters `set` may write. The connection request is always allowed. */
  readonly writable?: ReadonlySet<number> | undefined;
  /** For tests: supplies the socket. */
  readonly connect?: OgpConnect | undefined;
}

export interface OgpChoice {
  readonly key: number;
  readonly label: string;
}
export interface OgpDescriptor {
  readonly name: string;
  readonly typeId: number;
  readonly choices: readonly OgpChoice[];
}

interface Frame {
  readonly source: number;
  readonly destination: number;
  readonly type: number;
  readonly content: Buffer;
}
interface Pending {
  readonly type: number;
  readonly oid: number;
  readonly resolve: (content: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function int32(value: number): Buffer {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new RangeError("Not a 32-bit whole number");
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

/** Text as the switcher takes it: UTF-8 with a closing NUL. */
export function cstring(text: string): Buffer {
  if (text.includes("\0")) throw new RangeError("Text can't contain a NUL");
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
}

export function readInt(value: Buffer): number {
  if (value.length === 4) return value.readInt32BE(0);
  if (value.length === 2) return value.readInt16BE(0);
  if (value.length === 1) return value.readInt8(0);
  throw new OgpError("The switcher sent a number this module can't read");
}

export function readString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

/** A list of texts: each is a count byte, then that many bytes, the last a NUL. */
export function readStrings(value: Buffer): string[] {
  const texts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const count = value.readUInt8(offset);
    if (offset + 1 + count > value.length)
      throw new OgpError("The switcher sent a list this module can't read");
    texts.push(readString(value.subarray(offset + 1, offset + 1 + count)));
    offset += 1 + count;
  }
  return texts;
}

function parseDescriptor(content: Buffer): OgpDescriptor {
  // [code][oid 2][length][version][type][size][access][precision][widget][name length][name]
  // [constraint type][constraint length][constraint]. The length bytes are one byte wide and
  // wrap on a long list, so only the positions are trusted.
  if (content.length < 13)
    throw new OgpError("The switcher sent a description this module can't read");
  const typeId = content.readUInt8(5);
  const nameEnd = 11 + content.readUInt8(10);
  if (nameEnd + 2 > content.length)
    throw new OgpError("The switcher sent a description this module can't read");
  const name = readString(content.subarray(11, nameEnd));
  const constraintType = content.readUInt8(nameEnd);
  const data = content.subarray(nameEnd + 2);
  const choices: OgpChoice[] = [];
  if (constraintType === 2 || constraintType === 3) {
    const wide = constraintType === 3;
    const keyBytes = typeId === 2 || typeId === 12 ? 2 : 4;
    if (data.length < (wide ? 2 : 1))
      throw new OgpError("The switcher sent a list of choices this module can't read");
    const count = wide ? data.readUInt16BE(0) : data.readUInt8(0);
    let offset = wide ? 2 : 1;
    for (let index = 0; index < count; index++) {
      if (offset + keyBytes + 1 > data.length)
        throw new OgpError("The switcher sent a list of choices this module can't read");
      const key =
        keyBytes === 2 ? data.readInt16BE(offset) : data.readInt32BE(offset);
      const length = data.readUInt8(offset + keyBytes);
      const start = offset + keyBytes + 1;
      if (start + length > data.length)
        throw new OgpError("The switcher sent a list of choices this module can't read");
      choices.push({ key, label: readString(data.subarray(start, start + length)) });
      offset = start + length;
    }
  }
  return { name, typeId, choices };
}

/**
 * One connection to the switcher. Requests go out one at a time and are never sent twice:
 * a write that got no answer may or may not have been applied.
 */
export class OgpBinaryClient {
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #writable: ReadonlySet<number>;
  readonly #connect: OgpConnect;
  #socket: OgpSocket | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed: Error | undefined;
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;

  constructor(options: OgpBinaryClientOptions) {
    this.#host = options.host;
    this.#port = options.port ?? OGP_DEFAULT_PORT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#writable = options.writable ?? new Set();
    this.#connect =
      options.connect ?? ((target) => net.connect({ host: target.host, port: target.port }));
  }

  /**
   * Opens the connection. While `signal` is followed, aborting it fails the request in
   * flight and every later one; the socket stays open so the caller can still tidy up
   * after `stopFollowingAbort()`.
   */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.#socket || this.#closed)
      return Promise.reject(new OgpError("This connection has already been used"));
    if (signal?.aborted) return Promise.reject(new OgpAbortError());
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortConnect);
        if (error) {
          this.#fail(error);
          reject(error);
          return;
        }
        if (signal) {
          this.#signal = signal;
          this.#onAbort = () => this.#rejectPending(new OgpAbortError());
          signal.addEventListener("abort", this.#onAbort);
        }
        resolve();
      };
      const abortConnect = () => finish(new OgpAbortError());
      const timer = setTimeout(
        () => finish(new OgpError("The switcher didn't answer. Check its address and the network")),
        this.#timeoutMs,
      );
      signal?.addEventListener("abort", abortConnect);
      let socket: OgpSocket;
      try {
        socket = this.#connect({ host: this.#host, port: this.#port });
      } catch (error) {
        finish(connectionError(error));
        return;
      }
      this.#socket = socket;
      socket.setNoDelay(true);
      socket.once("connect", () => finish());
      socket.on("data", (chunk: Buffer) => this.#receive(chunk));
      socket.on("error", (error: Error) => {
        const failure = connectionError(error);
        finish(failure);
        this.#fail(failure);
      });
      socket.on("close", () => {
        const failure = new OgpError("The switcher closed the connection");
        finish(failure);
        this.#fail(failure);
      });
    });
  }

  /** Lets tidy-up requests run after the AbortSignal has fired. */
  stopFollowingAbort(): void {
    if (this.#signal && this.#onAbort)
      this.#signal.removeEventListener("abort", this.#onAbort);
    this.#signal = undefined;
    this.#onAbort = undefined;
  }

  /** Asks the switcher to accept this connection. Never forces another client off. */
  async handshake(): Promise<void> {
    const content = await this.#exchange(
      SET_PARAM,
      OGP_CONNECTION_OID,
      Buffer.from([0, 0, 0, 0]),
    );
    const value = content.subarray(4);
    if (content.readUInt8(0) !== 0 || value.length < 2 || value.readUInt16BE(0) === 0)
      throw new OgpError(
        "The switcher refused the connection. It may already have as many DashBoard connections as it allows",
        { code: content.readUInt8(0), oid: OGP_CONNECTION_OID },
      );
  }

  /** Reads one parameter's raw value. */
  async get(oid: number): Promise<Buffer> {
    const content = await this.#exchange(GET_PARAM, oid);
    this.#check(content, oid);
    // The byte before the value is a length on most replies but not all, so it is not used.
    return Buffer.from(content.subarray(4));
  }

  /** Writes one parameter. Refuses, before sending anything, a parameter outside the allowlist. */
  async set(oid: number, value: Buffer): Promise<void> {
    if (!this.#writable.has(oid))
      throw new OgpError(
        `This module doesn't write switcher setting 0x${oid.toString(16).toUpperCase()}`,
        { oid },
      );
    if (value.length > 255) throw new OgpError("That value is too long for the switcher", { oid });
    this.#check(await this.#exchange(SET_PARAM, oid, value), oid);
  }

  /** Reads a parameter's name and, for a choice, its numbered choices. */
  async descriptor(oid: number): Promise<OgpDescriptor> {
    const content = await this.#exchange(GET_DESCRIPTOR, oid);
    this.#check(content, oid);
    return parseDescriptor(content);
  }

  close(): void {
    this.#fail(new OgpError("The connection to the switcher is closed"));
  }

  #check(content: Buffer, oid: number): void {
    const code = content.readUInt8(0);
    if (code !== 0)
      throw new OgpError(
        RETURN_CODES[code] ?? `The switcher answered with error ${String(code)}`,
        { code, oid },
      );
  }

  #exchange(type: number, oid: number, value?: Buffer): Promise<Buffer> {
    const run = () =>
      new Promise<Buffer>((resolve, reject) => {
        if (this.#closed) return void reject(this.#closed);
        if (this.#signal?.aborted) return void reject(new OgpAbortError());
        const socket = this.#socket;
        if (!socket) return void reject(new OgpError("Not connected to the switcher"));
        const body =
          value === undefined
            ? Buffer.from([0, oid >> 8, oid & 0xff])
            : Buffer.concat([Buffer.from([0, oid >> 8, oid & 0xff, value.length]), value]);
        const header = Buffer.alloc(HEADER_BYTES);
        SYNC.copy(header, 0);
        header.writeUInt8(CLIENT_ADDRESS, 4);
        header.writeUInt8(SWITCHER_ADDRESS, 5);
        header.writeUInt8(type, 6);
        header.writeUInt16BE(body.length, 7);
        const pending: Pending = {
          type: type | RESPONSE_BIT,
          oid,
          resolve,
          reject,
          timer: setTimeout(() => {
            if (this.#pending !== pending) return;
            this.#pending = undefined;
            reject(new OgpError("The switcher didn't answer in time", { oid }));
          }, this.#timeoutMs),
        };
        this.#pending = pending;
        try {
          socket.write(Buffer.concat([header, body]));
        } catch (error) {
          clearTimeout(pending.timer);
          this.#pending = undefined;
          reject(connectionError(error));
        }
      });
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_BUFFERED_BYTES)
      return this.#fail(new OgpError("The switcher sent more than this module can hold"));
    for (;;) {
      const start = this.#buffer.indexOf(SYNC);
      if (start < 0) {
        // Keep a tail that could be the start of a sync split across packets.
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 3));
        return;
      }
      if (start > 0) this.#buffer = this.#buffer.subarray(start);
      if (this.#buffer.length < HEADER_BYTES) return;
      const length = this.#buffer.readUInt16BE(7);
      if (length > MAX_CONTENT_BYTES)
        return this.#fail(new OgpError("The switcher sent a message this module can't read"));
      if (this.#buffer.length < HEADER_BYTES + length) return;
      const frame: Frame = {
        source: this.#buffer.readUInt8(4),
        destination: this.#buffer.readUInt8(5),
        type: this.#buffer.readUInt8(6),
        content: Buffer.from(this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)),
      };
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      this.#deliver(frame);
    }
  }

  #deliver(frame: Frame): void {
    const pending = this.#pending;
    if (
      !pending ||
      frame.type !== pending.type ||
      frame.source !== SWITCHER_ADDRESS ||
      frame.destination !== CLIENT_ADDRESS ||
      frame.content.length < 1
    )
      return;
    // A reply names its parameter. A bare error code, with no parameter, is taken as the reply too.
    const named = frame.content.length >= 3;
    if (named && frame.content.readUInt16BE(1) !== pending.oid) return;
    if (!named && frame.content.readUInt8(0) === 0) return;
    if (named && frame.content.readUInt8(0) === 0 && frame.content.length < 4) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.resolve(frame.content);
  }

  #rejectPending(error: Error): void {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.reject(error);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.stopFollowingAbort();
    this.#rejectPending(error);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#buffer = Buffer.alloc(0);
    if (socket) {
      // A late error on a socket we no longer use must not go unhandled.
      socket.on("error", () => undefined);
      socket.destroy();
    }
  }
}

function connectionError(error: unknown): OgpError {
  if (error instanceof OgpError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message =
    code === "ECONNREFUSED"
      ? "The switcher refused the connection. Check its address"
      : code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN"
        ? "This computer can't reach the switcher. Check its address and the network"
        : code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? "That switcher name wasn't found. Check its address"
          : code === "ETIMEDOUT"
            ? "The switcher didn't answer. Check its address and the network"
            : "The connection to the switcher failed";
  return new OgpError(message, { cause: error });
}
