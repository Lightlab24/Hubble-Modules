import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

export const MAX_PACKET_BYTES = 1_048_576;
export const SUBSCRIPTIONS = ["#", "$SYS/#"];
export interface ReceivedMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
  qos: number;
  duplicate: boolean;
}

export function mqttText(value: string): Buffer {
  const text = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length);
  return Buffer.concat([length, text]);
}
export function packet(header: number, body: Buffer = Buffer.alloc(0)): Buffer {
  let length = body.length;
  const encoded: number[] = [];
  do {
    const digit = length % 128;
    length = Math.floor(length / 128);
    encoded.push(digit | (length ? 128 : 0));
  } while (length);
  return Buffer.concat([Buffer.from([header, ...encoded]), body]);
}

/** A subscription-only MQTT 3.1.1 client. There is deliberately no publish method. */
export class MqttListener {
  private socket: Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private phase: "connecting" | "subscribing" | "listening" | "closed" =
    "connecting";
  private ping: ReturnType<typeof setInterval> | undefined;
  private awaitingPing = false;
  constructor(
    private readonly events: {
      connected: () => void;
      message: (message: ReceivedMessage) => void;
      failed: (message: string) => void;
    },
  ) {}

  start(host: string, port: number): void {
    const socket = createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(5000);
    socket.on("connect", () => {
      if (this.phase === "closed") return;
      socket.write(
        packet(
          0x10,
          Buffer.concat([
            mqttText("MQTT"),
            Buffer.from([4, 2, 0, 30]),
            mqttText(`hubble-cap-${randomUUID().slice(0, 12)}`),
          ]),
        ),
      );
    });
    socket.on("data", (data) => {
      try {
        this.receive(data);
      } catch (error) {
        this.fail(
          error instanceof Error ? error.message : "Invalid MQTT packet",
        );
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(`Connection failed (${error.code ?? "network error"})`),
    );
    socket.on("timeout", () =>
      this.fail("MQTT connection or subscription timed out"),
    );
    socket.on("close", () =>
      this.fail(
        "Broker disconnected. Capture stopped; no automatic reconnect.",
      ),
    );
  }

  stop(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    clearInterval(this.ping);
    this.buffer = Buffer.alloc(0);
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      socket.end(packet(0xe0));
      const timer = setTimeout(() => socket.destroy(), 250);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    }
  }
  private fail(message: string): void {
    if (this.phase === "closed") return;
    this.stop();
    this.events.failed(message);
  }
  private isClosed(): boolean {
    return this.phase === "closed";
  }
  private receive(data: Buffer): void {
    if (this.phase === "closed") return;
    // A data event may contain many complete packets; only the incomplete tail is retained.
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2 && !this.isClosed()) {
      let length = 0,
        multiplier = 1,
        offset = 1;
      for (;;) {
        const digit = this.buffer[offset];
        if (digit === undefined) return;
        offset++;
        length += (digit & 127) * multiplier;
        if (length > MAX_PACKET_BYTES)
          throw new Error(
            "MQTT packet exceeds the 1 MB capture limit; capture stopped without truncating the packet",
          );
        if (!(digit & 128)) break;
        if (offset === 5) throw new Error("Invalid MQTT packet length");
        multiplier *= 128;
      }
      if (this.buffer.length < offset + length) return;
      const header = this.buffer[0];
      const body = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      this.handle(header, body);
    }
  }
  private handle(header: number, body: Buffer): void {
    if (header === 0x20 && this.phase === "connecting") {
      if (body.length !== 2 || body[0] !== 0)
        throw new Error("Invalid MQTT connection acknowledgment");
      if (body[1] !== 0)
        throw new Error(
          `MQTT broker refused anonymous access (CONNACK ${body[1]})`,
        );
      this.phase = "subscribing";
      this.socket?.write(
        packet(
          0x82,
          Buffer.concat([
            Buffer.from([0, 1]),
            ...SUBSCRIPTIONS.flatMap((topic) => [
              mqttText(topic),
              Buffer.from([0]),
            ]),
          ]),
        ),
      );
      return;
    }
    if (header === 0x90 && this.phase === "subscribing") {
      if (
        body.length !== 4 ||
        body.readUInt16BE(0) !== 1 ||
        body[2] !== 0 ||
        body[3] !== 0
      )
        throw new Error("Broker refused the capture subscriptions");
      this.phase = "listening";
      this.socket?.setTimeout(0);
      this.ping = setInterval(() => {
        if (this.awaitingPing)
          return this.fail("Broker stopped responding to MQTT keepalive");
        this.awaitingPing = true;
        this.socket?.write(packet(0xc0));
      }, 10_000);
      this.ping.unref();
      this.events.connected();
      return;
    }
    if (header === 0xd0 && body.length === 0) {
      this.awaitingPing = false;
      return;
    }
    // Retained PUBLISH packets may arrive before SUBACK on some brokers.
    if (header >> 4 !== 3 || this.phase === "connecting" || body.length < 2)
      throw new Error("Unexpected MQTT packet");
    const qos = (header >> 1) & 3;
    const size = body.readUInt16BE(0);
    const offset = 2 + size + (qos === 1 ? 2 : 0);
    if (qos > 1 || size === 0 || body.length < offset)
      throw new Error("Invalid MQTT message");
    const topicBytes = body.subarray(2, 2 + size);
    const topic = new TextDecoder("utf-8", { fatal: true }).decode(topicBytes);
    if (topic.includes("\0")) throw new Error("Invalid MQTT topic");
    if (qos === 1)
      this.socket?.write(packet(0x40, body.subarray(2 + size, offset)));
    this.events.message({
      topic,
      payload: body.subarray(offset),
      retained: Boolean(header & 1),
      qos,
      duplicate: Boolean(header & 8),
    });
  }
}
