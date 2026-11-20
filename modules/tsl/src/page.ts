import dgram from "node:dgram";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  type ModuleContext,
  type ModuleJsonValue,
} from "@hubble/module-sdk";
import type { TslDiscoveredDisplay, TslReceiver } from "./receiver.js";
import {
  defaultSwitcherDocument,
  ReceiverSettingsSchema,
  SWITCHER_DOCUMENT_ID,
  SwitcherDocumentSchema,
  wantedDevice,
  type ReceiverSettings,
  type SwitcherDocument,
} from "./setup.js";
import {
  deleteDevice,
  readSwitcher,
  sendDevice,
  type SwitcherReading,
} from "./switcher/index.js";

export const PAGE_ID = "tsl";
export const PAGE_SECTION_ID = "app";
export const PAGE_COMMANDS = [
  { id: "snapshot", label: "Read the page" },
  { id: "live", label: "Read the latest tally" },
  { id: "view", label: "Remember the open tab" },
  { id: "save-switcher", label: "Save the switcher setup" },
  { id: "read-switcher", label: "Read the switcher" },
  { id: "send-switcher", label: "Send to the switcher" },
  { id: "delete-switcher", label: "Delete from the switcher" },
] as const;
/** The module settings the page saves itself, through Hubble's own settings save. */
export const PAGE_SETTINGS = [
  "protocol",
  "transport",
  "port",
  "bindAddress",
  "sourceAddress",
  "staleAfterMs",
  "routingPeer",
] as const;

export interface TallyRow {
  readonly key: string;
  readonly screen: number;
  readonly address: number;
  readonly label: string;
  /** 5.0: left, text, right as 0 off, 1 red, 2 green, 3 amber. 3.1: tallies 1 to 4 as 0 or 1. */
  readonly lamps: readonly number[];
  readonly sender: string;
  readonly fresh: boolean;
}
export interface LiveReply {
  readonly version: number;
  /** True when rows is the whole list, false when it is only what changed. */
  readonly full: boolean;
  readonly rows: readonly TallyRow[];
  readonly removed: readonly string[];
  readonly listener: {
    readonly phase: "listening" | "error" | "stopped";
    readonly error: string | null;
    readonly invalidPackets: number;
    readonly lastPacketAt: number | null;
    readonly lastSender: string | null;
  };
}
export interface PageSnapshot {
  readonly name: string;
  readonly tab: "tally" | "setup";
  readonly receiver: ReceiverSettings;
  readonly addresses: readonly { id: string; label: string }[];
  readonly peers: readonly { id: string; label: string }[];
  readonly switcher: { readonly value: SwitcherDocument; readonly revision: string | null };
  /** The address this computer uses to reach the switcher, when it could be worked out. */
  readonly routeAddress: string | null;
  readonly reading: SwitcherReading | null;
  readonly readAt: number | null;
  readonly readError: string | null;
  readonly live: LiveReply;
}

const LocalState = z.object({
  tab: z.enum(["tally", "setup"]).default("tally"),
  reading: z.unknown().optional(),
  readAt: z.number().nullable().default(null),
  readError: z.string().nullable().default(null),
  readHost: z.string().default(""),
});
const LIVE_WAIT_MS = 20_000;
const COALESCE_MS = 40;

const rowOf = (display: TslDiscoveredDisplay): TallyRow => ({
  key: `${display.screen}:${display.address}`,
  screen: display.screen,
  address: display.address,
  label: display.label.trim().slice(0, 64),
  lamps:
    display.protocol === "3.1"
      ? display.flags.slice(0, 4).map((flag) => (flag ? 1 : 0))
      : [display.left, display.text, display.right],
  sender: display.sourceAddress,
  fresh: display.fresh,
});

/** "10.20.20.41" or "10.20.20.41:5253": the port is only needed where a site moved it. */
export function switcherTarget(address: string): { host: string; port?: number } {
  const match = /^(.*):(\d{1,5})$/u.exec(address.trim());
  if (!match || !match[1] || match[1].includes(":") || Number(match[2]) < 1 || Number(match[2]) > 65535)
    return { host: address.trim() };
  return { host: match[1], port: Number(match[2]) };
}

/** What the page needs from outside itself. Tests and the preview swap these. */
export interface PageDependencies {
  readSwitcher: typeof readSwitcher;
  sendDevice: typeof sendDevice;
  deleteDevice: typeof deleteDevice;
  routeAddress: typeof routeAddress;
  localAddresses: () => { id: string; label: string }[];
}

/** This computer's IPv4 addresses, for "Listen on" and "Send to". */
export function localAddresses(interfaces = os.networkInterfaces()): { id: string; label: string }[] {
  const found: { id: string; label: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces))
    for (const entry of entries ?? [])
      if (entry.family === "IPv4" && !entry.internal) found.push({ id: entry.address, label: `${entry.address} · ${name}` });
  return found.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** The local address the system would use to reach a host. Nothing is sent. */
export function routeAddress(host: string, timeoutMs = 800): Promise<string | null> {
  if (!host) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("error", () => finish(null));
    try {
      socket.connect(9, host, () => {
        try {
          const address = socket.address().address;
          finish(address && address !== "0.0.0.0" ? address : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * The backend of the TSL Tally page: live tally for the Tally tab, and the switcher's device
 * for the Setup tab. It reaches the switcher only when the operator presses a button.
 */
export class TslPage {
  private rows = new Map<string, { row: TallyRow; signature: string; version: number }>();
  private removed = new Map<string, number>();
  private version = 0;
  private fullBefore = 0;
  private waiters = new Set<() => void>();
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private local = LocalState.parse({});
  private reading: SwitcherReading | null = null;
  private loaded: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private busy = false;
  /** The switcher conversation in progress. Closing waits for it, so its form is left tidy. */
  private talking: Promise<void> | undefined;
  private closed = false;
  private readonly file: string | undefined;
  private readonly switcher: PageDependencies;

  constructor(
    private readonly context: ModuleContext,
    private readonly receiver: () => TslReceiver | undefined,
    private readonly peers: () => Promise<readonly { id: string; label: string }[]>,
    dependencies: Partial<PageDependencies> = {},
  ) {
    this.switcher = { readSwitcher, sendDevice, deleteDevice, routeAddress, localAddresses: () => localAddresses(), ...dependencies };
    this.file = context.runtimeDirectory ? path.join(context.runtimeDirectory, "page-state.json") : undefined;
  }

  /** The receiver changed. Coalesced, because a switcher sends hundreds of packets in a burst. */
  changed(): void {
    if (this.closed || this.coalesce) return;
    this.coalesce = setTimeout(() => {
      this.coalesce = undefined;
      this.collect();
    }, COALESCE_MS);
    this.coalesce.unref?.();
  }

  private collect(): void {
    const displays = this.receiver()?.snapshot().displays ?? [];
    const seen = new Set<string>();
    let next = this.version;
    const bump = () => (next === this.version ? ++next : next);
    for (const display of displays) {
      const row = rowOf(display);
      seen.add(row.key);
      const signature = JSON.stringify(row);
      const known = this.rows.get(row.key);
      if (known?.signature === signature) continue;
      this.rows.set(row.key, { row, signature, version: bump() });
      this.removed.delete(row.key);
    }
    for (const key of this.rows.keys())
      if (!seen.has(key)) {
        this.rows.delete(key);
        this.removed.set(key, bump());
      }
    if (this.removed.size > 8192) {
      // Too many to keep: older pollers get the whole list instead.
      this.fullBefore = next;
      this.removed.clear();
    }
    // The listener's own state (phase, error) is part of every reply, so wake pollers for it too.
    this.version = Math.max(next, this.version + 1);
    for (const wake of [...this.waiters]) wake();
  }

  private live(after: number): LiveReply {
    const state = this.receiver()?.snapshot();
    const full = after <= 0 || after < this.fullBefore || after > this.version;
    const rows = [...this.rows.values()].filter((entry) => full || entry.version > after).map((entry) => entry.row);
    let lastPacketAt: number | null = null;
    let lastSender: string | null = null;
    for (const display of state?.displays ?? [])
      if (lastPacketAt === null || display.lastSeen > lastPacketAt) {
        lastPacketAt = display.lastSeen;
        lastSender = display.sourceAddress;
      }
    return {
      version: this.version,
      full,
      rows,
      removed: full ? [] : [...this.removed].filter(([, version]) => version > after).map(([key]) => key),
      listener: {
        phase: state?.phase ?? "stopped",
        error: state?.error ?? null,
        invalidPackets: state?.invalidPackets ?? 0,
        lastPacketAt,
        lastSender,
      },
    };
  }

  private async waitLive(after: number, signal: AbortSignal): Promise<LiveReply> {
    // A page that already went away must not hold a wait open.
    signal.throwIfAborted();
    // A page that is starting, or is behind, gets everything as it stands right now.
    if (after <= 0 || after > this.version) this.collectNow();
    else if (after === this.version && !this.closed)
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, LIVE_WAIT_MS);
        timer.unref?.();
        signal.addEventListener("abort", wake, { once: true });
        this.waiters.add(wake);
      });
    signal.throwIfAborted();
    return this.live(after);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        const text = await readFile(this.file, "utf8");
        if (text.length > 1_000_000) return;
        this.local = LocalState.parse(JSON.parse(text));
        this.reading = (this.local.reading as SwitcherReading | undefined) ?? null;
      } catch {
        // No saved page state yet, or an unreadable one: start fresh.
      }
    })();
    return this.loaded;
  }

  /** Local to this computer on purpose: the open tab and the last reading are not workspace data. */
  private remember(): Promise<void> {
    const saving = this.writes.then(async () => {
      if (!this.file || this.closed) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify({ ...this.local, reading: this.reading }), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    this.writes = saving.catch(() => undefined);
    return saving.catch((error: unknown) => {
      this.context.log({
        level: "error",
        stage: "page-state",
        message: error instanceof Error ? error.message.slice(0, 300) : "The page's local state could not be saved",
      });
    });
  }

  private documents() {
    if (!this.context.services) throw new Error("This Hubble cannot save the switcher setup");
    return createModuleDocumentClient(this.context.services);
  }
  private async document(signal?: AbortSignal): Promise<{ value: SwitcherDocument; revision: string | null }> {
    const saved = await this.documents().read(SWITCHER_DOCUMENT_ID, signal);
    const parsed = SwitcherDocumentSchema.safeParse(saved.value);
    return { value: parsed.success ? parsed.data : defaultSwitcherDocument(), revision: saved.revision };
  }
  private receiverSettings(): ReceiverSettings {
    return ReceiverSettingsSchema.parse({
      protocol: this.context.settings.protocol,
      transport: this.context.settings.transport,
      bindAddress: this.context.settings.bindAddress,
      port: this.context.settings.port,
      sourceAddress: this.context.settings.sourceAddress ?? "",
      staleAfterMs: this.context.settings.staleAfterMs ?? 0,
      routingPeer: this.context.settings.routingPeer ?? "",
    });
  }

  private async snapshot(signal: AbortSignal): Promise<PageSnapshot> {
    await this.load();
    this.collectNow();
    const [switcher, peers] = await Promise.all([this.document(signal), this.peers().catch(() => [])]);
    return {
      name: String(this.context.settings.name ?? ""),
      tab: this.local.tab,
      receiver: this.receiverSettings(),
      addresses: this.switcher.localAddresses(),
      peers,
      switcher,
      routeAddress: await this.switcher.routeAddress(switcherTarget(switcher.value.host).host),
      // A reading belongs to the address it came from.
      reading: this.local.readHost === switcher.value.host ? this.reading : null,
      readAt: this.local.readHost === switcher.value.host ? this.local.readAt : null,
      readError: this.local.readHost === switcher.value.host ? this.local.readError : null,
      live: this.live(0),
    };
  }
  private collectNow(): void {
    clearTimeout(this.coalesce);
    this.coalesce = undefined;
    this.collect();
  }

  /** One conversation with the switcher at a time: its Devices form is a single shared form. */
  private async withSwitcher<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Still working on the last switcher request");
    this.busy = true;
    const talk = work();
    this.talking = talk.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await talk;
    } finally {
      this.busy = false;
      this.talking = undefined;
    }
  }
  private async took(host: string, reading: SwitcherReading | null, error: string | null) {
    this.reading = reading ?? (error ? null : this.reading);
    this.local = { ...this.local, readHost: host, readAt: Date.now(), readError: error };
    await this.remember();
    return { reading: this.reading, readAt: this.local.readAt, readError: error };
  }
  private async contact(
    host: string,
    stage: string,
    work: () => Promise<SwitcherReading>,
  ): Promise<{ reading: SwitcherReading | null; readAt: number | null; readError: string | null }> {
    if (!host) throw new Error("Enter the switcher's address first");
    return this.withSwitcher(async () => {
      try {
        const reading = await work();
        this.context.log({ level: "info", stage, message: `${stage} on ${host}: ${reading.devices.length} devices listed` });
        return await this.took(host, reading, null);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "The switcher could not be reached";
        this.context.log({ level: "error", stage, message: `${stage} on ${host} failed: ${message}` });
        // A failed read replaces the reading; a failed send or delete keeps what was last read.
        if (stage === "read-switcher") await this.took(host, null, message);
        throw new Error(message);
      }
    });
  }

  async call(value: ModuleJsonValue, signal: AbortSignal): Promise<ModuleJsonValue> {
    const request = z
      .object({ sectionId: z.literal(PAGE_SECTION_ID), commandId: z.string(), value: z.unknown().optional() })
      .parse(value);
    const json = (reply: unknown) => JSON.parse(JSON.stringify(reply)) as ModuleJsonValue;
    await this.load();
    switch (request.commandId) {
      case "snapshot":
        return json(await this.snapshot(signal));
      case "live": {
        const { after } = z.object({ after: z.int().min(0) }).parse(request.value);
        return json(await this.waitLive(after, signal));
      }
      case "view": {
        const { tab } = z.object({ tab: z.enum(["tally", "setup"]) }).parse(request.value);
        this.local = { ...this.local, tab };
        await this.remember();
        return null;
      }
      case "save-switcher": {
        const input = z
          .object({ value: SwitcherDocumentSchema, revision: z.string().nullable() })
          .parse(request.value);
        try {
          const saved = await this.documents().write(
            { id: SWITCHER_DOCUMENT_ID, revision: input.revision },
            input.value as unknown as ModuleJsonValue,
            signal,
          );
          return json({ status: "saved", value: SwitcherDocumentSchema.parse(saved.value), revision: saved.revision });
        } catch (error) {
          if (!(error instanceof ModuleDocumentConflictError)) throw error;
          const current = SwitcherDocumentSchema.safeParse(error.document.value);
          return json({
            status: "conflict",
            value: current.success ? current.data : defaultSwitcherDocument(),
            revision: error.document.revision,
          });
        }
      }
      case "read-switcher": {
        const { value: document } = await this.document(signal);
        return json(
          await this.contact(document.host, "read-switcher", () =>
            this.switcher.readSwitcher({ ...switcherTarget(document.host), deviceName: document.name, signal }),
          ),
        );
      }
      case "send-switcher": {
        // The page sends what it shows for This computer: a change there may still be on its way
        // through Hubble, and the switcher has to get what the person is looking at.
        const { adopt, receiver } = z
          .object({
            adopt: z.boolean().default(false),
            receiver: ReceiverSettingsSchema.pick({ protocol: true, transport: true, port: true }).optional(),
          })
          .parse(request.value ?? {});
        const { value: document } = await this.document(signal);
        const target = switcherTarget(document.host);
        const sendTo = document.sendTo || (await this.switcher.routeAddress(target.host));
        if (!sendTo) throw new Error("Choose which of this computer's addresses the switcher should send to");
        const local = this.switcher.localAddresses().map((item) => item.id);
        if (!local.includes(sendTo)) throw new Error(`${sendTo} isn't one of this computer's addresses`);
        return json(
          await this.contact(document.host, "send-switcher", async () => {
            // Never repoint someone else's device without being told to.
            const before = await this.switcher.readSwitcher({ ...target, deviceName: document.name, signal });
            if (before.mine && !local.includes(before.mine.ip) && !adopt)
              throw new Error(`${before.mine.name} on the switcher sends to ${before.mine.ip}. Confirm before changing it`);
            return this.switcher.sendDevice({
              ...target,
              settings: wantedDevice(document, { ...this.receiverSettings(), ...receiver }, sendTo),
              signal,
            });
          }),
        );
      }
      case "delete-switcher": {
        const { value: document } = await this.document(signal);
        return json(
          await this.contact(document.host, "delete-switcher", () =>
            this.switcher.deleteDevice({ ...switcherTarget(document.host), deviceName: document.name, signal }),
          ),
        );
      }
      default:
        throw new Error("Unknown page command");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.coalesce);
    for (const wake of [...this.waiters]) wake();
    // A request cut short by a restart still cancels its edit and lets go of the switcher's form.
    await this.talking;
    await this.writes;
  }
}
