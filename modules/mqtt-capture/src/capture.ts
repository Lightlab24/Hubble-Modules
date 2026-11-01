import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import type {
  ModuleContext,
  ModulePageCommandResult,
  ModuleTableRow,
} from "@hubble/module-sdk";
import {
  MqttListener,
  SUBSCRIPTIONS,
  type ReceivedMessage,
} from "./mqtt-listener.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGES = 100_000;
const CHUNK_CHARACTERS = 48_000;

export class Capture {
  private listener: MqttListener | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private output = "";
  private pending: string[] = [];
  private lines: string[] = [];
  private transcript = "";
  private id = "";
  private host = "";
  private port = 1883;
  private status = "Ready";
  private reason = "Enter an IP address and start a capture.";
  private startedAt: string | null = null;
  private lastMessageAt: string | null = null;
  private count = 0;
  private retained = 0;
  private bytes = 0;
  private topics = new Set<string>();
  private recent: ModuleTableRow[] = [];
  private disposed = false;
  constructor(private readonly context: ModuleContext) {}
  start(): void {
    if (!this.context.runtimeDirectory)
      throw new Error(
        "This Hubble build does not provide module runtime storage",
      );
    mkdirSync(this.context.runtimeDirectory, { recursive: true, mode: 0o700 });
    const latest = readdirSync(this.context.runtimeDirectory)
      .filter((name) => /^mqtt-[0-9T-]+-[a-f0-9-]+\.jsonl$/u.test(name))
      .sort()
      .at(-1);
    if (latest) {
      const file = path.join(this.context.runtimeDirectory, latest);
      if (statSync(file).size <= MAX_CAPTURE_BYTES + 4096) {
        const contents = readFileSync(file, "utf8");
        const end = contents.lastIndexOf("\n");
        this.lines = contents
          .slice(0, end + 1)
          .split(/(?<=\n)/u)
          .filter(Boolean);
        try {
          const first = JSON.parse(this.lines[0] ?? "{}");
          this.id = first.captureId ?? randomUUID();
          this.host = first.host ?? "";
          this.port = first.port ?? 1883;
          this.startedAt = first.timestamp ?? null;
          for (const line of this.lines) {
            const record = JSON.parse(line);
            if (record.type === "message") {
              this.count++;
              this.retained += Number(record.retained);
              this.topics.add(record.topic);
              this.lastMessageAt = record.timestamp;
              this.preview(record);
            }
          }
          const last = JSON.parse(this.lines.at(-1) ?? "{}");
          this.status = "Stopped";
          this.reason =
            last.type === "stopped"
              ? "Previous capture is available to copy or export."
              : "Previous capture was interrupted. The recovered transcript is incomplete.";
          if (last.type !== "stopped")
            this.lines.push(
              JSON.stringify({
                type: "interrupted",
                timestamp: new Date().toISOString(),
                message: this.reason,
              }) + "\n",
            );
          this.bytes = Buffer.byteLength(this.lines.join(""));
        } catch {
          this.lines = [];
          this.count = 0;
          this.retained = 0;
          this.topics.clear();
          this.recent = [];
          this.lastMessageAt = null;
          this.reason =
            "The previous capture could not be read. Its file has been preserved.";
        }
      }
    }
    this.flushTimer = setInterval(() => {
      this.flush();
      this.publish();
    }, 500);
    this.flushTimer.unref();
    this.publish();
  }
  begin(host: unknown, port: unknown): ModulePageCommandResult {
    if (this.disposed) throw new Error("Capture module has stopped");
    if (this.listener)
      throw new Error("Stop the current capture before starting another");
    if (typeof host !== "string" || !isIP(host.trim()))
      throw new Error("Enter a valid IPv4 or IPv6 address");
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("Port must be 1–65535");
    this.flush();
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const output = path.join(
      this.context.runtimeDirectory!,
      `mqtt-${startedAt.replace(/[:.Z]/gu, "-")}-${id}.jsonl`,
    );
    writeFileSync(output, "", { flag: "wx", mode: 0o600 });
    this.id = id;
    this.startedAt = startedAt;
    this.output = output;
    this.host = host.trim();
    this.port = port;
    this.count = 0;
    this.retained = 0;
    this.bytes = 0;
    this.lastMessageAt = null;
    this.topics.clear();
    this.lines = [];
    this.pending = [];
    this.transcript = "";
    this.recent = [];
    this.status = "Connecting";
    this.reason = `Connecting to ${this.host}:${this.port}`;
    this.append({
      type: "capture",
      formatVersion: 1,
      captureId: this.id,
      host: this.host,
      port,
      subscriptions: SUBSCRIPTIONS,
      protocol: "MQTT 3.1.1",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      notes:
        "Subscription only; no control messages sent. Timestamps are receipt times in UTC. Retained messages are broker snapshots, not new actions. MQTT does not identify the publishing client. QoS is delivery QoS to this subscriber.",
    });
    this.listener = new MqttListener({
      connected: () => {
        this.status = "Capturing";
        this.reason = "Listening to all topics";
        this.append({ type: "connected" });
        this.publish();
      },
      message: (message) => this.receive(message),
      failed: (message) => this.stop(message, true),
    });
    this.listener.start(this.host, this.port);
    this.publish();
    return {
      message: "Connecting. Live status will show when capture is listening.",
    };
  }
  stop(
    reason = "Stopped by operator",
    failed = false,
  ): ModulePageCommandResult {
    if (!this.listener) return { message: "Capture is already stopped" };
    this.listener.stop();
    this.listener = undefined;
    this.status = failed ? "Error" : "Stopped";
    this.reason = reason;
    this.append({
      type: "stopped",
      reason,
      incomplete: failed,
      messages: this.count,
      topics: this.topics.size,
    });
    this.flush();
    this.publish();
    return { message: reason };
  }
  marker(note: unknown): ModulePageCommandResult {
    if (!this.listener)
      throw new Error("Start a capture before adding a marker");
    if (typeof note !== "string" || !note.trim() || note.length > 1000)
      throw new Error("Enter a note of 1–1000 characters");
    if (this.bytes + Buffer.byteLength(note) + 512 > MAX_CAPTURE_BYTES)
      return this.stop(
        "Capture reached the 16 MB limit; start another capture to continue",
        true,
      );
    this.append({ type: "marker", note: note.trim() });
    return { message: "Timestamped marker added" };
  }
  text(cursor: unknown): ModulePageCommandResult {
    if (this.listener)
      throw new Error(
        "Stop capture before copying or exporting its complete transcript",
      );
    if (!this.lines.length) throw new Error("No transcript is available");
    this.transcript ||= this.lines.join("");
    let offset = 0;
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== "string" || !cursor.startsWith(`${this.id}:`))
        throw new Error("Capture changed during export");
      const value = cursor.slice(this.id.length + 1);
      if (!/^\d+$/u.test(value)) throw new Error("Invalid transcript cursor");
      offset = Number(value);
      if (!Number.isSafeInteger(offset) || offset >= this.transcript.length)
        throw new Error("Invalid transcript cursor");
    }
    let end = Math.min(this.transcript.length, offset + CHUNK_CHARACTERS);
    // Never split a surrogate pair across clipboard/download chunks.
    if (
      end < this.transcript.length &&
      /[\uD800-\uDBFF]/u.test(this.transcript[end - 1])
    )
      end--;
    return {
      text: this.transcript.slice(offset, end),
      nextCursor: end < this.transcript.length ? `${this.id}:${end}` : null,
      fileName: `mqtt-capture-${(this.startedAt ?? "").replace(/[^0-9T]/gu, "-")}.txt`,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop("Capture stopped because the module or workspace was closed");
    this.disposed = true;
    clearInterval(this.flushTimer);
    this.flush();
  }
  private receive(message: ReceivedMessage): void {
    let payload: string, encoding: string;
    try {
      payload = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(message.payload);
      encoding = "utf8";
    } catch {
      payload = message.payload.toString("base64");
      encoding = "base64";
    }
    const record = {
      type: "message",
      sequence: this.count + 1,
      timestamp: new Date().toISOString(),
      topic: message.topic,
      payload,
      encoding,
      payloadBytes: message.payload.length,
      retained: message.retained,
      qos: message.qos,
      duplicate: message.duplicate,
    };
    const line = JSON.stringify(record) + "\n";
    if (
      this.count >= MAX_MESSAGES ||
      this.bytes + Buffer.byteLength(line) > MAX_CAPTURE_BYTES
    ) {
      this.stop(
        "Capture limit reached (16 MB or 100,000 messages). This message and subsequent traffic were not captured.",
        true,
      );
      return;
    }
    this.count++;
    this.retained += Number(message.retained);
    this.topics.add(message.topic);
    this.lastMessageAt = record.timestamp;
    this.appendLine(line);
    this.preview(record);
  }
  private preview(record: {
    sequence: number;
    timestamp: string;
    topic: string;
    payload: string;
    encoding: string;
    retained: boolean;
  }): void {
    this.recent.unshift({
      id: String(record.sequence),
      values: {
        timestamp: record.timestamp,
        topic: record.topic.slice(0, 512),
        payload:
          record.payload.length > 512
            ? `${record.payload.slice(0, 512)}… (full payload in transcript)`
            : record.payload,
        encoding: record.encoding,
        delivery: record.retained ? "Retained" : "Live",
      },
    });
    this.recent.length = Math.min(this.recent.length, 100);
  }
  private append(record: Record<string, unknown>): void {
    this.appendLine(
      JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n",
    );
  }
  private appendLine(line: string): void {
    this.lines.push(line);
    this.pending.push(line);
    this.bytes += Buffer.byteLength(line);
    this.transcript = "";
    if (this.pending.length >= 128) this.flush();
  }
  private flush(): void {
    if (!this.pending.length || !this.output) return;
    const pending = this.pending.join("");
    try {
      appendFileSync(this.output, pending);
      this.pending = [];
    } catch {
      this.pending = [];
      this.listener?.stop();
      this.listener = undefined;
      this.status = "Error";
      this.reason =
        "Capture stopped because the transcript could not be saved. Copy or export the in-memory transcript.";
      this.lines.push(
        JSON.stringify({
          type: "storage-error",
          timestamp: new Date().toISOString(),
          message: this.reason,
        }) + "\n",
      );
      this.transcript = "";
      this.publish();
    }
  }
  private publish(): void {
    if (this.disposed) return;
    this.context.publishState({
      phase:
        this.status === "Error"
          ? "error"
          : this.status === "Connecting"
            ? "connecting"
            : "ready",
      observedAt: new Date().toISOString(),
      message: this.reason,
      values: {
        status: this.status,
        host: this.host,
        port: this.port,
        endpoint: this.host ? `${this.host}:${this.port}` : "Not set",
        messages: this.count,
        topics: this.topics.size,
        retained: this.retained,
        live: this.count - this.retained,
        size: `${(this.bytes / 1024).toFixed(1)} KB`,
        startedAt: this.startedAt,
        lastMessageAt: this.lastMessageAt,
        canStart: !this.listener,
        canStop: !!this.listener,
        canExport: !this.listener && this.lines.length > 0,
        messagesView: this.recent,
      },
    });
  }
}
