import { randomUUID } from "node:crypto";
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
  deviceIdentity,
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
import {
  RoutingChangeSchema,
  type RoutingLive,
  type RoutingSnapshot,
  type TslRouting,
} from "./routing.js";
import { applySetupChange, type RoutingChange, type SetupChange } from "./changes.js";

export const PAGE_ID = "tsl";
export const PAGE_SECTION_ID = "app";
export const PAGE_COMMANDS = [
  { id: "snapshot", label: "Read the page" },
  { id: "live", label: "Read the latest tally" },
  { id: "view", label: "Remember the open tab" },
  { id: "saved", label: "Read what is saved" },
  { id: "save-switcher", label: "Save the switcher setup" },
  { id: "read-switcher", label: "Read the switcher" },
  { id: "send-switcher", label: "Send to the switcher" },
  { id: "delete-switcher", label: "Delete from the switcher" },
  { id: "routing-save", label: "Save the camera mappings" },
  { id: "routing-follow", label: "Follow tally, or stop" },
] as const;
/** The module settings the page saves itself, through Hubble's own settings save. */
export const PAGE_SETTINGS = [
  "protocol",
  "transport",
  "port",
  "bindAddress",
  "sourceAddress",
  "staleAfterMs",
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
  /**
   * Which run of the module counted `version`. The page hands both back; a place kept from a
   * run that has stopped means nothing to the next one, even when the numbers happen to agree.
   */
  readonly run: string;
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
  /** Each camera's tally and routing status, the routers here, and whether tally is followed. */
  readonly routing: RoutingLive;
  /** Where the switcher setup and the last reading of the switcher stand. */
  readonly setup: SetupLive;
}
/**
 * Every open copy of the page hears of a change to the switcher setup or to what the switcher was
 * last read to have, whichever window made it, and reads it again when it holds something older.
 */
export interface SetupLive {
  /** The saved switcher setup's revision. */
  readonly revision: string | null;
  /** Changes with each read, send or delete, from any window. */
  readonly reading: string;
  /** A request to the switcher is under way, from any window. */
  readonly busy: boolean;
}
/** What is saved and shared by every copy of the page, without the live tally. */
export interface SharedReply {
  readonly switcher: { readonly value: SwitcherDocument; readonly revision: string | null };
  readonly reading: SwitcherReading | null;
  readonly readAt: number | null;
  readonly readError: string | null;
  readonly routeAddress: string | null;
  /** The reading's stamp, as `SetupLive.reading` gives it. */
  readonly stamp: string;
  /** The camera mappings, when asked for. */
  readonly routing?: RoutingSnapshot;
}
/** A saved change to the switcher setup: the setup as saved now. */
export interface SetupSaved {
  readonly status: "saved";
  readonly value: SwitcherDocument;
  readonly revision: string | null;
  /** Fields the page changed by itself that another window had changed first, so theirs stayed. */
  readonly kept: readonly string[];
}
export interface PageSnapshot {
  readonly name: string;
  readonly tab: "tally" | "routing" | "setup";
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
  /** The camera mappings as saved, with their revision. */
  readonly routing: RoutingSnapshot;
  /** The reading's stamp, as `SetupLive.reading` gives it. */
  readonly stamp: string;
}

const LocalState = z.object({
  tab: z.enum(["tally", "routing", "setup"]).default("tally"),
  reading: z.unknown().optional(),
  readAt: z.number().nullable().default(null),
  readError: z.string().nullable().default(null),
  readHost: z.string().default(""),
});
const LIVE_WAIT_MS = 20_000;
const COALESCE_MS = 40;
/** How often the saved switcher setup is read again, for a change made outside this module, such as an import. */
const DOCUMENT_MS = 2000;
/** A save that lost a race is put onto what won it and tried again, this many times in all. */
const SAVE_ATTEMPTS = 8;
/** How long a switcher request waits for another window's to finish. */
const SWITCHER_QUEUE_MS = 30_000;
/** How long the address that reaches the switcher is worked out once for. */
const ROUTE_MS = 5000;
const SETUP_FIELDS = Object.keys(SwitcherDocumentSchema.shape) as [keyof SwitcherDocument, ...(keyof SwitcherDocument)[]];
/** One copy's change to the switcher setup. Values are checked on the setup it makes, as saved. */
const SetupChangeSchema = z.partialRecord(z.enum(SETUP_FIELDS), z.json());
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  private readonly run = randomUUID();
  private version = 0;
  private fullBefore = 0;
  private waiters = new Set<() => void>();
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private local = LocalState.parse({});
  private reading: SwitcherReading | null = null;
  private loaded: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  /** A switcher conversation is under way, asked for by any window. */
  private busy = false;
  /** The switcher conversation in progress. Closing waits for it, so its form is left tidy. */
  private talking: Promise<void> | undefined;
  /** Switcher requests in turn: the one under way, then each waiting one. */
  private queue: Promise<void> = Promise.resolve();
  /** The saved switcher setup as last read or written here, followed for changes from elsewhere. */
  private setup: { value: SwitcherDocument; revision: string | null } | undefined;
  private setupSaving = 0;
  private setupAdopted = 0;
  private setupReading = false;
  private setupTimer: ReturnType<typeof setInterval> | undefined;
  /** How many times the switcher was read, sent to or deleted from, by any window, in this run. */
  private readings = 0;
  private route: { host: string; at: number; address: Promise<string | null> } | undefined;
  private readonly stopping = new AbortController();
  private closed = false;
  private readonly file: string | undefined;
  private readonly switcher: PageDependencies;

  constructor(
    private readonly context: ModuleContext,
    private readonly receiver: () => TslReceiver | undefined,
    private readonly peers: () => Promise<readonly { id: string; label: string }[]>,
    private readonly routing: TslRouting,
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

  /** A page that is starting, is behind, or kept its place from another run gets everything. */
  private behind(after: number, run: string | undefined): boolean {
    return (run !== undefined && run !== this.run) || after <= 0 || after > this.version;
  }
  private live(after: number, run?: string): LiveReply {
    const state = this.receiver()?.snapshot();
    const full = this.behind(after, run) || after < this.fullBefore;
    const rows = [...this.rows.values()].filter((entry) => full || entry.version > after).map((entry) => entry.row);
    let lastPacketAt: number | null = null;
    let lastSender: string | null = null;
    for (const display of state?.displays ?? [])
      if (lastPacketAt === null || display.lastSeen > lastPacketAt) {
        lastPacketAt = display.lastSeen;
        lastSender = display.sourceAddress;
      }
    return {
      run: this.run,
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
      routing: this.routing.live(),
      setup: { revision: this.setup?.revision ?? null, reading: this.stamp(), busy: this.busy },
    };
  }
  /** Names this run, so a page that kept a stamp from the last run never takes it for this one's. */
  private stamp(): string {
    return `${this.run}:${this.readings}`;
  }

  private async waitLive(after: number, run: string | undefined, signal: AbortSignal): Promise<LiveReply> {
    // A page that already went away must not hold a wait open.
    signal.throwIfAborted();
    // A page that is starting, or is behind, gets everything as it stands right now.
    if (this.behind(after, run)) this.collectNow();
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
    return this.live(after, run);
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
    const adopted = this.setupAdopted;
    const saved = await this.documents().read(SWITCHER_DOCUMENT_ID, signal);
    const parsed = SwitcherDocumentSchema.safeParse(saved.value);
    const document = { value: parsed.success ? parsed.data : defaultSwitcherDocument(), revision: saved.revision };
    // A read that crossed a save may answer with what was saved before it: only a clean one is kept.
    if (!this.setupSaving && this.setupAdopted === adopted) this.adoptSetup(document);
    return document;
  }
  /** The saved setup, as read or written here. Every open page hears of a new revision. */
  private adoptSetup(document: { value: SwitcherDocument; revision: string | null }): void {
    const known = this.setup !== undefined && this.setup.revision === document.revision;
    this.setup = document;
    this.setupAdopted++;
    if (!known) this.changed();
  }
  /** Follows the saved setup from now on, for a change made outside this module, such as an import. */
  private followSetup(): void {
    if (this.setupTimer || this.closed || !this.context.services) return;
    this.setupTimer = setInterval(() => {
      if (this.closed || this.setupReading || this.setupSaving) return;
      this.setupReading = true;
      void this.document(this.stopping.signal)
        .catch(() => undefined)
        .finally(() => {
          this.setupReading = false;
        });
    }, DOCUMENT_MS);
    this.setupTimer.unref?.();
  }
  /**
   * Puts one copy's change onto the setup as saved now. A save that lost a race to another window
   * is put onto what won it and tried again, so neither undoes the other.
   */
  private async saveSetup(change: SetupChange, expected: SetupChange, signal: AbortSignal): Promise<SetupSaved> {
    this.setupSaving++;
    try {
      let current = await this.document(signal);
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        const applied = applySetupChange(current.value, change, expected);
        const value = SwitcherDocumentSchema.parse(applied.value);
        // Nothing to write: already saved, as when a save is sent again after a restart.
        if (sameJson(value, current.value)) return { status: "saved", value: current.value, revision: current.revision, kept: applied.kept };
        try {
          const saved = await this.documents().write(
            { id: SWITCHER_DOCUMENT_ID, revision: current.revision },
            value as unknown as ModuleJsonValue,
            signal,
          );
          const stored = SwitcherDocumentSchema.parse(saved.value);
          this.adoptSetup({ value: stored, revision: saved.revision });
          return { status: "saved", value: stored, revision: saved.revision, kept: applied.kept };
        } catch (error) {
          if (!(error instanceof ModuleDocumentConflictError)) throw error;
          // Another window saved first: this change goes onto what it saved.
          const parsed = SwitcherDocumentSchema.safeParse(error.document.value);
          current = { value: parsed.success ? parsed.data : defaultSwitcherDocument(), revision: error.document.revision };
          this.adoptSetup(current);
        }
      }
      throw new Error("The switcher setup kept changing in another window. Try again");
    } finally {
      this.setupSaving--;
    }
  }
  /** The address this computer uses to reach a host, worked out at most once every few seconds. */
  private routeFor(host: string): Promise<string | null> {
    const target = switcherTarget(host).host;
    const now = Date.now();
    if (!this.route || this.route.host !== target || now - this.route.at > ROUTE_MS)
      this.route = { host: target, at: now, address: this.switcher.routeAddress(target).catch(() => null) };
    return this.route.address;
  }
  /** What is saved and shared by every copy of the page: the setup, the last reading and, if asked, the cameras. */
  private async shared(signal: AbortSignal, routing: boolean): Promise<SharedReply> {
    this.followSetup();
    const switcher = await this.document(signal);
    // A reading belongs to the address it came from.
    const here = this.local.readHost === switcher.value.host;
    return {
      switcher,
      routeAddress: await this.routeFor(switcher.value.host),
      reading: here ? this.reading : null,
      readAt: here ? this.local.readAt : null,
      readError: here ? this.local.readError : null,
      stamp: this.stamp(),
      ...(routing ? { routing: this.routing.snapshot() } : {}),
    };
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
    const [shared, peers] = await Promise.all([this.shared(signal, false), this.peers().catch(() => [])]);
    return {
      name: String(this.context.settings.name ?? ""),
      tab: this.local.tab,
      receiver: this.receiverSettings(),
      addresses: this.switcher.localAddresses(),
      peers,
      switcher: shared.switcher,
      routeAddress: shared.routeAddress,
      reading: shared.reading,
      readAt: shared.readAt,
      readError: shared.readError,
      live: this.live(0),
      routing: this.routing.snapshot(),
      stamp: shared.stamp,
    };
  }
  private collectNow(): void {
    clearTimeout(this.coalesce);
    this.coalesce = undefined;
    this.collect();
  }

  /**
   * One conversation with the switcher at a time: its Devices form is a single shared form. A
   * request from another window waits its turn rather than being refused, and reads the setup
   * once its turn comes, so it sends what is saved then.
   */
  private async withSwitcher<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let done!: () => void;
    const turn = new Promise<void>((resolve) => (done = resolve));
    // The next request waits for this one and for every one before it.
    this.queue = before.then(() => turn);
    try {
      await waitTurn(before, signal);
      if (this.closed) throw new Error("TSL Tally stopped");
      this.busy = true;
      this.changed();
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
        this.changed();
      }
    } finally {
      done();
    }
  }
  private async took(host: string, reading: SwitcherReading | null, error: string | null) {
    this.reading = reading ?? (error ? null : this.reading);
    this.local = { ...this.local, readHost: host, readAt: Date.now(), readError: error };
    // Every open page takes in what the switcher has now.
    this.readings++;
    this.changed();
    await this.remember();
    return { reading: this.reading, readAt: this.local.readAt, readError: error, stamp: this.stamp() };
  }
  private async contact(
    host: string,
    stage: string,
    work: () => Promise<SwitcherReading>,
  ): Promise<{ reading: SwitcherReading | null; readAt: number | null; readError: string | null; stamp: string }> {
    if (!host) throw new Error("Enter the switcher's address first");
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
  }

  /** How the page's device is found on the switcher: by the name it has there, or the one it is being given. */
  private names(document: SwitcherDocument): { deviceName: string; otherName: string } {
    return { deviceName: deviceIdentity(document), otherName: document.name };
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
        const { after, run } = z.object({ after: z.int().min(0), run: z.string().max(64).optional() }).parse(request.value);
        // Each reply says where the saved setup stands, so this run has to know it first.
        if (!this.setup && this.context.services) {
          this.followSetup();
          await this.document(signal).catch(() => undefined);
        }
        return json(await this.waitLive(after, run, signal));
      }
      case "saved": {
        const { routing } = z.object({ routing: z.boolean().default(false) }).parse(request.value ?? {});
        return json(await this.shared(signal, routing));
      }
      case "view": {
        const { tab } = z.object({ tab: z.enum(["tally", "routing", "setup"]) }).parse(request.value);
        this.local = { ...this.local, tab };
        await this.remember();
        return null;
      }
      case "save-switcher": {
        // Only what the page changed, never its whole setup: the backend puts it onto what is saved now.
        const input = z.object({ change: SetupChangeSchema, expected: SetupChangeSchema.default({}) }).parse(request.value);
        return json(await this.saveSetup(input.change as SetupChange, input.expected as SetupChange, signal));
      }
      case "read-switcher":
        return json(
          await this.withSwitcher(signal, async () => {
            const { value: document } = await this.document(signal);
            return this.contact(document.host, "read-switcher", () =>
              this.switcher.readSwitcher({ ...switcherTarget(document.host), ...this.names(document), signal }),
            );
          }),
        );
      case "send-switcher": {
        // The page sends what it shows for This computer: a change there may still be on its way
        // through Hubble, and the switcher has to get what the person is looking at.
        const { adopt, receiver } = z
          .object({
            adopt: z.boolean().default(false),
            receiver: ReceiverSettingsSchema.pick({ protocol: true, transport: true, port: true }).optional(),
          })
          .parse(request.value ?? {});
        return json(
          await this.withSwitcher(signal, async () => {
            // The setup as saved when this request's turn comes, with every window's changes in it.
            const { value: document } = await this.document(signal);
            const target = switcherTarget(document.host);
            const sendTo = document.sendTo || (await this.switcher.routeAddress(target.host));
            if (!sendTo) throw new Error("Choose which of this computer's addresses the switcher should send to");
            const local = this.switcher.localAddresses().map((item) => item.id);
            const notHere = () => new Error(`${sendTo} isn't one of this computer's addresses`);
            // Only this computer's addresses, or the one the device already sends to: a device that
            // feeds something else can have its other settings changed and still send there.
            if (!local.includes(sendTo) && !document.device) throw notHere();
            return this.contact(document.host, "send-switcher", async () => {
              const before = await this.switcher.readSwitcher({ ...target, ...this.names(document), signal });
              if (!local.includes(sendTo) && before.mine?.ip !== sendTo) throw notHere();
              // Never change someone else's device without being told to.
              if (before.mine && !local.includes(before.mine.ip) && !adopt)
                throw new Error(`${before.mine.name} on the switcher sends to ${before.mine.ip}. Confirm before changing it`);
              return this.switcher.sendDevice({
                ...target,
                settings: wantedDevice(document, { ...this.receiverSettings(), ...receiver }, sendTo),
                // The device as the switcher has it now, so a rename changes it rather than adding one.
                deviceName: before.mine?.name ?? document.name,
                signal,
              });
            });
          }),
        );
      }
      case "routing-save": {
        // Only what the page changed, never its whole list: the backend puts it onto what is saved now.
        const { change } = z.object({ change: RoutingChangeSchema }).parse(request.value);
        return json(await this.routing.save(change as RoutingChange, signal));
      }
      case "routing-follow": {
        const { mode } = z.object({ mode: z.enum(["follow", "unfollow", "toggle"]) }).parse(request.value);
        return json({ following: await this.routing.follow(mode) });
      }
      case "delete-switcher":
        return json(
          await this.withSwitcher(signal, async () => {
            const { value: document } = await this.document(signal);
            return this.contact(document.host, "delete-switcher", () =>
              this.switcher.deleteDevice({ ...switcherTarget(document.host), ...this.names(document), signal }),
            );
          }),
        );
      default:
        throw new Error("Unknown page command");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.setupTimer);
    this.stopping.abort();
    clearTimeout(this.coalesce);
    for (const wake of [...this.waiters]) wake();
    // A request cut short by a restart still cancels its edit and lets go of the switcher's form.
    await this.talking;
    await this.writes;
  }
}

/** Waits for the switcher request before this one, while the page still wants an answer. */
function waitTurn(before: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Request cancelled"));
    const timer = setTimeout(
      () => finish(new Error("The switcher is still busy with a request from another window. Try again")),
      SWITCHER_QUEUE_MS,
    );
    timer.unref?.();
    signal.addEventListener("abort", stop, { once: true });
    void before.then(() => finish());
  });
}
