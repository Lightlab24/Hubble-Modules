import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  modulePeerKey,
  type ModuleContext,
  type ModuleJsonValue,
  type ModulePeerBinding,
} from "@hubble/module-sdk";
import {
  indicators,
  RoutingEngine,
  tallySchema,
  type Mapping,
  type Route,
} from "./routing-engine.js";
import { applyRoutingChange, type RoutingChange } from "./changes.js";

/** The camera mappings: saved with the workspace, so they travel with it. */
export const ROUTING_DOCUMENT_ID = "routing";
/** Every camera reads this module's own tally; the engine still keys tallies by receiver. */
const SELF = "self";
const COALESCE_MS = 10;
const REFRESH_MS = 1000;
/** How often the saved cameras are read again, for a change made outside this module, such as an import. */
const DOCUMENT_MS = 2000;
/** A save that lost a race is put onto what won it and tried again, this many times in all. */
const SAVE_ATTEMPTS = 8;
const MAX_CAMERAS = 512;

export const RoutingRowSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/u),
  name: z.string().max(160).default(""),
  enabled: z.boolean().default(true),
  /** TSL 5.0 screen; a TSL 3.1 switcher has only screen 0. */
  screen: z.int().min(0).max(65534).default(0),
  address: z.int().min(0).max(65534).default(1),
  /** Which lamp means "on air": the default is flag 2 on TSL 3.1 and red text on 5.0. */
  indicator: z.enum(indicators).default("default"),
  /** The router: Hubble's binding to a router module, as `bindings()` names it. */
  router: z.string().max(200).default(""),
  destination: z.int().min(1).max(65536).default(1),
  source: z.int().min(1).max(65536).default(1),
  level: z.int().min(1).max(256).default(1),
});
export type RoutingRow = z.infer<typeof RoutingRowSchema>;
export const RoutingDocumentSchema = z.strictObject({
  rows: z.array(RoutingRowSchema).max(512).default([]),
});
export type RoutingDocument = z.infer<typeof RoutingDocumentSchema>;
export const defaultRoutingDocument = (): RoutingDocument => RoutingDocumentSchema.parse({});

export interface RoutingRouter {
  readonly id: string;
  readonly label: string;
  readonly ready: boolean;
}
export interface RoutingStatus {
  readonly id: string;
  /** "ON AIR", "Off" or "Unknown". */
  readonly program: string;
  readonly status: string;
}
export interface RoutingLive {
  readonly following: boolean;
  readonly statuses: readonly RoutingStatus[];
  readonly routers: readonly RoutingRouter[];
  readonly notice: string;
  /** The saved cameras' revision; a page holding another one reads them again. */
  readonly revision: string | null;
}
export interface RoutingSnapshot extends RoutingLive {
  readonly rows: readonly RoutingRow[];
}
const RowIdSchema = RoutingRowSchema.shape.id;
const ROW_FIELDS = Object.keys(RoutingRowSchema.shape).filter((key) => key !== "id") as [
  Exclude<keyof RoutingRow, "id">,
  ...Exclude<keyof RoutingRow, "id">[],
];
/** One copy's change to the cameras. Values are checked on the list it makes, as saved. */
export const RoutingChangeSchema = z.strictObject({
  removed: z.array(RowIdSchema).max(MAX_CAMERAS).default([]),
  added: z
    .array(z.strictObject({ row: RoutingRowSchema, after: RowIdSchema.nullable() }))
    .max(MAX_CAMERAS)
    .default([]),
  changed: z
    .array(z.strictObject({ id: RowIdSchema, fields: z.partialRecord(z.enum(ROW_FIELDS), z.json()) }))
    .max(MAX_CAMERAS)
    .default([]),
});
/** A saved change: the cameras as saved now, and the cameras it changed that were deleted elsewhere. */
export interface RoutingSave {
  readonly status: "saved";
  readonly rows: RoutingRow[];
  readonly revision: string | null;
  readonly missing: string[];
}

const toMapping = (row: RoutingRow): Mapping => ({
  id: row.id,
  values: {
    name: row.name,
    enabled: row.enabled,
    receiver: SELF,
    screen: row.screen,
    address: row.address,
    indicator: row.indicator,
    router: row.router,
    source: row.source,
    destination: row.destination,
    level: row.level,
  },
});

/**
 * Routing on tally, merged in from TALLY Switch: each output follows the one camera on air.
 * The rules are TALLY Switch's (`RoutingEngine`): startup and a router coming back hold the
 * route they find, only a fresh tally change routes, an uncertain result is never retried.
 * Routes go to router modules through module exchange, as TALLY Switch sent them.
 */
export class TslRouting {
  private rows: RoutingRow[] = [];
  private revision: string | null = null;
  private following = false;
  private engine: RoutingEngine;
  private bindings: ModulePeerBinding[] = [];
  private routers: RoutingRouter[] = [];
  private readonly ready = new Map<string, boolean>();
  private readonly subscriptions = new Map<string, () => Promise<void>>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private documentTimer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private tallyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private reconciled: string | undefined;
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private notice = "Add a router module to this workspace to route on tally";
  /** Why the saved cameras couldn't be read yet. Tally never waits on it, and reads try again. */
  private loadError = "";
  private loaded = false;
  /** Saves of this module's own under way, and how many times the saved cameras were taken in. */
  private saving = 0;
  private adopted = 0;
  private readonly file: string | undefined;

  constructor(
    private readonly context: ModuleContext,
    private readonly tally: () => ModuleJsonValue,
    private readonly changed: () => void,
  ) {
    this.file = context.runtimeDirectory
      ? path.join(context.runtimeDirectory, "routing-following.json")
      : undefined;
    this.engine = this.build(undefined);
  }

  /** A new engine for new mappings: what it knows of tally and routers carries over. */
  private build(previous: RoutingEngine | undefined): RoutingEngine {
    previous?.close();
    const engine = new RoutingEngine(
      this.rows.map(toMapping),
      this.following,
      (input) => this.route(input),
      () => {
        if (!this.closed) this.changed();
      },
    );
    for (const [id, tally] of previous?.tallies ?? []) engine.tallies.set(id, tally);
    for (const [id, router] of previous?.routers ?? []) engine.routers.set(id, router);
    return engine;
  }

  private async route(input: Route): Promise<string> {
    const binding = this.bindings.find(
      (item) => item.id === input.router && item.allowActions && !item.unresolved,
    );
    const exchange = this.context.modules;
    if (!binding || !exchange || this.controller.signal.aborted)
      throw new Error("Router action permission unavailable");
    const result = await exchange.execute(
      binding.target,
      "route",
      { source: input.source, destination: input.destination, level: input.level },
      this.controller.signal,
    );
    if (result.status !== "success") throw new Error(result.message);
    return `Submitted · source ${input.source} → output ${input.destination}`;
  }

  private documents() {
    if (!this.context.services) throw new Error("This Hubble cannot save the camera mappings");
    return createModuleDocumentClient(this.context.services);
  }

  async start(): Promise<void> {
    // Routing never stops tally: a damaged Follow file starts unfollowed, and cameras that can't be
    // read yet come in on the next read.
    if (this.file) {
      try {
        const text = await readFile(this.file, "utf8");
        if (text.length > 1024) throw new Error("Invalid saved follow state");
        this.following = z.object({ following: z.boolean() }).parse(JSON.parse(text)).following;
      } catch {
        this.following = false;
      }
    }
    if (this.context.services) {
      try {
        const saved = await this.documents().read(ROUTING_DOCUMENT_ID, this.controller.signal);
        const parsed = RoutingDocumentSchema.safeParse(saved.value);
        this.rows = parsed.success ? parsed.data.rows : [];
        this.revision = saved.revision;
        this.loaded = true;
      } catch (error) {
        this.loadError = unreadable(error);
      }
    }
    this.engine = this.build(this.engine);
    this.feed();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
    if (this.context.services) {
      this.documentTimer = setInterval(() => void this.reread(), DOCUMENT_MS);
      this.documentTimer.unref?.();
    }
  }

  /** Takes in cameras saved elsewhere. This module's own saves already hold that revision. */
  private async reread(): Promise<void> {
    // A read that crosses a save of this module's own may answer with what was saved before it.
    if (this.closed || this.reading || this.saving) return;
    this.reading = true;
    const adopted = this.adopted;
    try {
      const saved = await this.documents().read(ROUTING_DOCUMENT_ID, this.controller.signal);
      if (this.closed || this.saving || this.adopted !== adopted) return;
      const first = !this.loaded;
      this.loaded = true;
      this.loadError = "";
      if (saved.revision === this.revision && !first) return;
      const parsed = RoutingDocumentSchema.safeParse(saved.value);
      this.adopt(parsed.success ? parsed.data.rows : [], saved.revision);
    } catch (error) {
      // The next read tries again.
      if (!this.loaded) this.loadError = unreadable(error);
    } finally {
      this.reading = false;
    }
  }

  /** The receiver changed. Coalesced: a switcher sends hundreds of packets in a burst. */
  tallyChanged(): void {
    if (this.closed || this.tallyTimer) return;
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = undefined;
      this.feed();
    }, COALESCE_MS);
    this.tallyTimer.unref?.();
  }
  private feed(): void {
    if (this.closed) return;
    const tally = tallySchema.safeParse(this.tally());
    if (tally.success) this.engine.tallies.set(SELF, tally.data);
    else this.engine.tallies.delete(SELF);
    this.engine.evaluate(true);
  }

  /** Which router modules are here, and whether each is ready. Polled, as TALLY Switch did. */
  private async refresh(): Promise<void> {
    const exchange = this.context.modules;
    if (!exchange || this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const [bindings, peers] = await Promise.all([
        exchange.bindings(this.controller.signal),
        exchange.discover(this.controller.signal),
      ]);
      if (this.closed) return;
      const signature = JSON.stringify([bindings, peers]);
      if (signature === this.reconciled) return;
      // Set first: an event or failure during this pass clears it, so the next poll repeats it.
      this.reconciled = signature;
      this.bindings = bindings;
      const routers: RoutingRouter[] = [];
      const wanted = new Set<string>();
      for (const binding of bindings) {
        const peer = peers.find((item) => modulePeerKey(item.peer) === modulePeerKey(binding.target));
        if (!peer?.data.some((item) => item.id === "router" && item.version === 1)) continue;
        const approved = binding.allowActions && !binding.unresolved && !!peer.actionsAllowed;
        const ready = !!peer.available && (this.ready.get(binding.id) ?? false);
        this.engine.routers.set(binding.id, { ready, approved });
        routers.push({ id: binding.id, label: binding.name || peer.name, ready: ready && approved });
        if (binding.unresolved || !peer.available) continue;
        const key = JSON.stringify([binding.id, modulePeerKey(binding.target)]);
        wanted.add(key);
        if (this.subscriptions.has(key)) continue;
        let generation: string | null | undefined;
        const unsubscribe = await exchange.subscribe(
          { kind: "data", target: binding.target, id: "router", version: 1 },
          (event) => {
            if (this.closed) return;
            if (event.kind === "availability") {
              if (!event.available) {
                this.reconciled = undefined;
                this.ready.delete(binding.id);
                this.engine.routers.delete(binding.id);
                generation = undefined;
                this.engine.baseline(binding.id);
                this.engine.evaluate(false);
              }
              return;
            }
            if (event.kind !== "data") return;
            if (generation !== event.generation) this.engine.baseline(binding.id);
            generation = event.generation;
            const value = z.object({ ready: z.boolean() }).safeParse(event.value);
            this.ready.set(binding.id, value.success && value.data.ready);
            // The next pass restores the full approval rule.
            this.reconciled = undefined;
            this.engine.routers.set(binding.id, {
              ready: value.success && value.data.ready,
              approved: this.bindings.some(
                (item) => item.id === binding.id && item.allowActions && !item.unresolved,
              ),
            });
            this.routers = this.routers.map((router) =>
              router.id === binding.id ? { ...router, ready: value.success && value.data.ready } : router,
            );
            this.engine.evaluate(false);
          },
          this.controller.signal,
        );
        if (this.closed) {
          await unsubscribe();
          return;
        }
        this.subscriptions.set(key, unsubscribe);
      }
      for (const [key, unsubscribe] of this.subscriptions)
        if (!wanted.has(key)) {
          this.subscriptions.delete(key);
          await unsubscribe();
        }
      for (const id of this.engine.routers.keys())
        if (!routers.some((router) => router.id === id)) this.engine.routers.delete(id);
      this.routers = routers;
      this.notice = routers.length
        ? ""
        : "Add a router module to this workspace to route on tally";
      this.engine.evaluate(false);
    } catch (error) {
      if (!this.closed) {
        this.reconciled = undefined;
        this.engine.routers.clear();
        this.notice = error instanceof Error ? error.message.slice(0, 300) : "Router modules unavailable";
        this.engine.evaluate(false);
      }
    } finally {
      this.refreshing = false;
    }
  }

  isFollowing(): boolean {
    return this.following;
  }

  /** Follow, unfollow or toggle. Kept on this computer: it is the operator's, not the workspace's. */
  follow(mode: "follow" | "unfollow" | "toggle"): Promise<boolean> {
    const save = this.writes.then(async () => {
      if (this.closed) throw new Error("TSL Tally stopped");
      const value = mode === "toggle" ? !this.following : mode === "follow";
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, JSON.stringify({ following: value }), { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      }
      if (this.closed) return value;
      this.following = value;
      this.engine.setFollowing(value);
      this.changed();
      return value;
    });
    this.writes = save.catch(() => undefined);
    return save;
  }

  /** The saved cameras, as read or written here: routing follows them at once. */
  private adopt(rows: RoutingRow[], revision: string | null): void {
    if (this.closed) return;
    this.adopted++;
    this.rows = rows;
    this.revision = revision;
    this.loaded = true;
    this.loadError = "";
    this.engine = this.build(this.engine);
    this.feed();
  }

  /**
   * Saves one copy's change to the cameras onto what is saved now. A save that lost a race to
   * another window is put onto what won it and tried again, so neither undoes the other.
   */
  async save(change: RoutingChange, signal: AbortSignal): Promise<RoutingSave> {
    this.saving++;
    try {
      return await this.saveOnto(change, signal);
    } finally {
      this.saving--;
    }
  }
  private async saveOnto(change: RoutingChange, signal: AbortSignal): Promise<RoutingSave> {
    if (!this.loaded) {
      const saved = await this.documents().read(ROUTING_DOCUMENT_ID, signal);
      const parsed = RoutingDocumentSchema.safeParse(saved.value);
      this.adopt(parsed.success ? parsed.data.rows : [], saved.revision);
    }
    let current = { rows: this.rows, revision: this.revision };
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const { rows, missing } = applyRoutingChange(current.rows, change);
      if (rows.length > MAX_CAMERAS) throw new Error(`A routing sheet holds at most ${MAX_CAMERAS} cameras`);
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Two cameras have the same ID");
      const value = RoutingDocumentSchema.parse({ rows });
      // Nothing to write: already saved, as when a save is sent again after a restart.
      if (JSON.stringify(value.rows) === JSON.stringify(current.rows))
        return { status: "saved", rows: current.rows, revision: current.revision, missing };
      try {
        const saved = await this.documents().write(
          { id: ROUTING_DOCUMENT_ID, revision: current.revision },
          value as unknown as ModuleJsonValue,
          signal,
        );
        const stored = RoutingDocumentSchema.parse(saved.value);
        this.adopt(stored.rows, saved.revision);
        return { status: "saved", rows: stored.rows, revision: saved.revision, missing };
      } catch (error) {
        if (!(error instanceof ModuleDocumentConflictError)) throw error;
        // Another window saved first: this change goes onto what it saved.
        const parsed = RoutingDocumentSchema.safeParse(error.document.value);
        current = { rows: parsed.success ? parsed.data.rows : [], revision: error.document.revision };
        this.adopt(current.rows, current.revision);
      }
    }
    throw new Error("The camera mappings kept changing in another window. Try again");
  }

  live(): RoutingLive {
    const statuses = this.engine.statuses.map((row) => ({
      id: row.id,
      program: row.values.program,
      status: row.values.status,
    }));
    return { following: this.following, statuses, routers: this.routers, notice: this.loadError || this.notice, revision: this.revision };
  }

  snapshot(): RoutingSnapshot {
    return { ...this.live(), rows: this.rows };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.documentTimer);
    clearTimeout(this.tallyTimer);
    this.controller.abort();
    this.engine.close();
    await this.writes;
    await Promise.allSettled([...this.subscriptions.values()].map((unsubscribe) => unsubscribe()));
    this.subscriptions.clear();
  }
}

function unreadable(error: unknown): string {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return `The saved cameras couldn't be read yet${detail}`.slice(0, 300);
}
