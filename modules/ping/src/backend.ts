import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  ModuleDocumentValueSchema,
  type ModuleActionResult,
  type ModuleContext,
  type ModuleFeedbackSubscription,
  type ModuleInstance,
  type ModuleJsonValue,
} from "@hubble/module-sdk";
import { DEVICE_FIELD, DEVICE_PROVIDER, FEEDBACK, MATRIX_ACTION, PAGE_ID } from "./actions.js";
import { Pinger, type PingerOptions, type PingSample } from "./engine.js";
import { HISTORY_SPAN_MS, type Series } from "./history.js";
import { applyMutation, DOCUMENT_ID, rulesOf, same, sameName, spanOf, validateDocument, valueOf, type DeviceRow, type Mutation, type PingDocument } from "./model.js";
import { windowParts } from "./sheet-window.js";
import { DeviceWatch, type Alert, type DeviceState, type DeviceSummary } from "./watch.js";

/** Hubble's channel for telling the operator something outside its window. */
const ALERT_CHANNEL = "host.alert.v1";

export interface BackendOptions extends PingerOptions {
  readonly now?: () => number;
  /** How long a `live` request waits for a new result before answering anyway. */
  readonly liveWaitMs?: number;
}
export interface LiveRequest {
  /** The newest sequence the page has seen; the answer waits for something newer. */
  after?: number;
  span?: string;
  /** The device whose timeline the page is showing, and the stretch of time it wants. */
  timeline?: { deviceId: string; from: number; to: number; points: number };
}
export interface LiveReply {
  sequence: number;
  /** The device list's revision, so every open copy of the page hears of a save at once. */
  revision?: string | null;
  now: number;
  /** Why nothing is being pinged, or "" while pings run. */
  problem: string;
  devices: Record<string, DeviceSummary>;
  timeline: (Series & { deviceId: string }) | null;
}

const failure = (
  category: Extract<ModuleActionResult, { status: "failure" }>["category"],
  message: string,
): ModuleActionResult => ({ status: "failure", category, message });

const pingable = (row: DeviceRow) => valueOf(row, "enabled") === "TRUE" && valueOf(row, "host") !== "";

export function createBackend(context: ModuleContext, options: BackendOptions = {}): ModuleInstance {
  if (!context.services) throw Error("Ping needs Hubble's portable documents.");
  const documents = createModuleDocumentClient(context.services);
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  const waiters = new Set<() => void>();
  /** Results are kept per device row, and start again when its address changes. */
  const watches = new Map<string, DeviceWatch>();
  let plan: PingDocument | undefined;
  let revision: string | null = null;
  let sequence = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let subscriptions: readonly ModuleFeedbackSubscription[] = [];
  const published = new Map<string, string>();

  const pinger = new Pinger(onSample, () => bump(), options);

  function counts() {
    let online = 0;
    let alerts = 0;
    let checked = 0;
    for (const row of plan?.devices ?? []) {
      const state = watching(row) ? (watches.get(row.id)?.state ?? "not-checked") : "not-checked";
      if (state === "not-checked") continue;
      checked++;
      if (state === "offline" || state === "slow") alerts++;
      if (state !== "offline") online++;
    }
    return { online, alerts, checked };
  }

  function publish() {
    context.publishState({
      // Hubble shows any message as a connection error, so a ready module has none.
      phase: "ready",
      message: null,
      observedAt: new Date(now()).toISOString(),
      // The sheets, for the sidebar's Open in its own window › (manifest: parts). Sent with every
      // state, so a sheet added, renamed, moved or removed in any window shows there at once.
      values: { revision, ...counts(), ...(plan ? { windowParts: windowParts(plan) } : {}) },
    });
  }

  /** Lets waiting pages know there is something new, at most a few times a second. */
  function bump() {
    sequence = Math.max(sequence + 1, now());
    if (wake) return;
    wake = setTimeout(() => {
      wake = undefined;
      for (const finish of [...waiters]) finish();
    }, 100);
  }

  const active = () => plan?.settings.pinging === true && context.connectionEnabled !== false;
  const watching = (row: DeviceRow) => active() && pingable(row);

  /** Takes a new copy of the plan: drops results for removed or re-addressed devices, then pings what is left. */
  function adopt(doc: PingDocument) {
    plan = doc;
    for (const [id, watch] of watches) {
      const row = doc.devices.find((item) => item.id === id);
      if (!row || valueOf(row, "host") !== watch.address) watches.delete(id);
    }
    for (const row of doc.devices) if (pingable(row) && !watches.has(row.id)) watches.set(row.id, new DeviceWatch(valueOf(row, "host")));
    pinger.configure({
      addresses: active() ? doc.devices.filter(pingable).map((row) => valueOf(row, "host")) : [],
      intervalMs: doc.settings.intervalMs,
      sizeBytes: doc.settings.sizeBytes,
    });
    emitFeedback();
    publish();
    bump();
  }

  function onSample(sample: PingSample) {
    if (!plan) return;
    let changed = false;
    for (const row of plan.devices) {
      if (!watching(row) || valueOf(row, "host") !== sample.address) continue;
      const watch = watches.get(row.id);
      if (!watch) continue;
      const before = watch.state;
      const alert = watch.add(valueOf(row, "name"), rulesOf(row, plan.settings), sample.at, sample.rtt);
      if (alert) raise(row, alert);
      if (watch.state !== before) changed = true;
    }
    if (changed) {
      emitFeedback();
      publish();
    }
    bump();
  }

  /** An alert always goes to the Status Log, and to a macOS notification when Notifications is on. */
  function raise(row: DeviceRow, alert: Alert) {
    context.log({ level: alert.level, stage: alert.stage, message: alert.message });
    if (!plan?.settings.notify) return;
    context.publishEvent?.(ALERT_CHANNEL, {
      // One key per device and kind of event: Hubble drops a repeat of the same key within ten seconds.
      key: `${row.id}:${alert.stage}`,
      title: alert.title,
      body: alert.body,
      severity: alert.level === "error" ? "critical" : "info",
      notification: true,
      // A bounce repeats until HubDash is clicked, which is too much for a device that may flap.
      dockBounce: false,
    });
  }

  function stateOf(row: DeviceRow): DeviceState {
    return watching(row) ? (watches.get(row.id)?.state ?? "not-checked") : "not-checked";
  }

  /** Tells Hubble what each subscribed key shows, only when it changed. */
  function emitFeedback() {
    const seen = new Set<string>();
    for (const subscription of subscriptions) {
      if (subscription.id !== FEEDBACK) continue;
      const values = (subscription.fields as { values?: Record<string, unknown> } | undefined)?.values;
      const name = typeof values?.[DEVICE_FIELD] === "string" ? (values[DEVICE_FIELD] as string) : "";
      const row = name.trim() ? plan?.devices.find((item) => sameName(valueOf(item, "name"), name)) : undefined;
      const state = row ? stateOf(row) : "not-checked";
      const key = JSON.stringify(subscription.fields ?? null);
      seen.add(key);
      if (published.get(key) === state) continue;
      published.set(key, state);
      const known = state !== "not-checked";
      context.publishFeedback({
        ...subscription,
        // Unknown until a ping says otherwise: a device that isn't being pinged is never shown as down.
        state: !known ? "unavailable" : state === "offline" ? "inactive" : "active",
        observedAt: known ? new Date(now()).toISOString() : null,
        appearance: known ? { triggers: [state] } : { triggers: null },
      } as unknown as Parameters<ModuleContext["publishFeedback"]>[0]);
    }
    for (const key of [...published.keys()]) if (!seen.has(key)) published.delete(key);
  }

  async function snapshot(signal: AbortSignal) {
    const saved = await documents.read(DOCUMENT_ID, signal);
    if (saved.revision !== revision || !plan) {
      revision = saved.revision;
      adopt(validateDocument(saved.value));
    }
    return { document: plan!, revision, sequence };
  }

  /**
   * Puts one change from a copy of the page onto the list as saved now, so a copy that hasn't
   * heard of another window's change yet keeps it rather than being refused (see merge.ts).
   * Saves go one at a time, so copies in several windows never collide with each other here;
   * a collision with Hubble itself (an Undo, an import) is read again and retried.
   */
  async function store(operation: Mutation, signal: AbortSignal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await documents.read(DOCUMENT_ID, signal);
      const current = validateDocument(saved.value);
      const clashes: string[] = [];
      const next = applyMutation(current, operation, clashes);
      // A change to what is saved already, such as one another window made first, writes nothing.
      if (same(next, current)) {
        if (saved.revision !== revision || !plan) {
          revision = saved.revision;
          adopt(current);
        }
        return { document: current, revision: saved.revision, sequence, clashes };
      }
      try {
        const result = await documents.write(saved, ModuleDocumentValueSchema.parse(next), signal);
        revision = result.revision;
        adopt(next);
        return { document: next, revision, sequence, clashes };
      } catch (error) {
        if (!(error instanceof ModuleDocumentConflictError) || attempt === 3) throw error;
      }
    }
    throw Error("The device list changed before saving.");
  }
  let saving: Promise<unknown> = Promise.resolve();
  function save(operation: Mutation, signal: AbortSignal) {
    const run = saving.then(() => {
      signal.throwIfAborted();
      return store(operation, signal);
    });
    saving = run.catch(() => undefined);
    return run;
  }

  async function live(request: LiveRequest, signal: AbortSignal): Promise<LiveReply> {
    const after = Number(request.after ?? 0);
    if (sequence <= after)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, options.liveWaitMs ?? 5000);
        signal.addEventListener("abort", finish, { once: true });
        waiters.add(finish);
      });
    signal.throwIfAborted();
    const at = now();
    const spanMs = spanOf(String(request.span ?? plan?.view.span ?? "")).ms;
    const devices: Record<string, DeviceSummary> = {};
    for (const row of plan?.devices ?? []) {
      const watch = watches.get(row.id);
      if (!watch) continue;
      const summary = watch.summary(spanMs, at);
      devices[row.id] = watching(row) ? summary : { ...summary, state: "not-checked", now: null };
    }
    let timeline: LiveReply["timeline"] = null;
    const wanted = request.timeline;
    const watch = wanted ? watches.get(String(wanted.deviceId)) : undefined;
    if (wanted && watch) {
      const to = Math.min(Number(wanted.to) || at, at);
      const from = Math.max(Number(wanted.from) || to - spanMs, at - HISTORY_SPAN_MS);
      const points = Math.min(1200, Math.max(10, Math.round(Number(wanted.points) || 600)));
      if (to > from) timeline = { deviceId: wanted.deviceId, ...watch.history.series(from, to, points, at, plan?.settings.intervalMs ?? 1000) };
    }
    return { sequence, revision, now: at, problem: active() ? pinger.problem : "", devices, timeline };
  }

  return {
    async start() {
      await snapshot(lifetime.signal);
      void (async () => {
        for await (const saved of documents.watch(DOCUMENT_ID, lifetime.signal)) {
          if (saved.revision === revision) continue;
          revision = saved.revision;
          adopt(validateDocument(saved.value));
        }
      })().catch(() => {
        if (!lifetime.signal.aborted) context.log({ level: "error", stage: "ping-plan-watch", message: "Stopped following the device list." });
      });
    },
    async execute(id) {
      if (id !== MATRIX_ACTION) return failure("invalid-config", "Unknown Ping action");
      return { status: "success", evidence: { kind: "local", summary: "A Ping key only shows a device's status" } };
    },
    choices(provider) {
      if (provider !== DEVICE_PROVIDER) return [];
      return (plan?.devices ?? []).map((row) => valueOf(row, "name").trim()).filter(Boolean).map((name) => ({ id: name, label: name }));
    },
    async call(method, raw, execution): Promise<ModuleJsonValue> {
      if (method !== `page.${PAGE_ID}` || !raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Unknown Ping page command.");
      const command = raw as { sectionId?: string; commandId?: string; value?: { operation?: Mutation } & LiveRequest };
      if (command.sectionId !== "frontend") throw Error("Unknown Ping view.");
      const { signal } = execution;
      signal.throwIfAborted();
      if (command.commandId === "snapshot") return (await snapshot(signal)) as unknown as ModuleJsonValue;
      if (command.commandId === "save") return (await save(command.value!.operation!, signal)) as unknown as ModuleJsonValue;
      if (command.commandId === "clear-history") {
        // Past results only. States, alerts and the saved device list are untouched.
        for (const watch of watches.values()) watch.clearHistory();
        bump();
        return { sequence, cleared: watches.size } as unknown as ModuleJsonValue;
      }
      if (command.commandId === "live") return (await live(command.value ?? {}, signal)) as unknown as ModuleJsonValue;
      throw Error("Unknown Ping page command.");
    },
    subscribeFeedback(next) {
      subscriptions = next;
      published.clear();
      emitFeedback();
    },
    dispose() {
      clearTimeout(wake);
      for (const finish of [...waiters]) finish();
      lifetime.abort();
      pinger.stop();
    },
  };
}
