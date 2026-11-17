import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  ModuleDocumentValueSchema,
  type ModuleActionResult,
  type ModuleContext,
  type ModuleExecutionContext,
  type ModuleInstance,
  type ModuleJsonValue,
  type ModuleValues,
} from "@hubble/module-sdk";
import { FEEDBACK, KEY_FIELD, MATRIX_ACTION, MONITOR_FIELD, MONITOR_PROVIDER, PAGE_ID, PRESS_ACTION } from "./actions.js";
import { keyById, type FlandersKey } from "./keys.js";
import { applyMutation, DEFAULT_PORT, DOCUMENT_ID, sameName, validateDocument, valueOf, type MonitorDocument, type MonitorRow, type Mutation } from "./model.js";
import { keyPacket } from "./protocol.js";
import { describeApps, listOtherConnections, type ConnectionLister } from "./sharing.js";
import { resolveAddress, SendError, sendOnce } from "./transport.js";

/** The latest thing that happened to a monitor, for its Status cell. Kept only for the address it was about. */
export interface MonitorStatus {
  host: string;
  port: string;
  text: string;
  tone: "ok" | "held" | "failed";
}
export type Statuses = Record<string, MonitorStatus>;

export interface BackendOptions {
  readonly listConnections?: ConnectionLister;
  readonly connectTimeoutMs?: number;
  readonly closeWaitMs?: number;
  readonly now?: () => Date;
}

/**
 * Keys for one monitor go one at a time across this worker, so Hubble never
 * opens two connections to the same monitor at once.
 */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

const failure = (
  category: Extract<ModuleActionResult, { status: "failure" }>["category"],
  message: string,
): ModuleActionResult => ({ status: "failure", category, message });

interface Monitor {
  readonly row: MonitorRow;
  readonly name: string;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly whenInUse: "wait" | "send";
}
const monitorOf = (row: MonitorRow): Monitor => ({
  row,
  name: valueOf(row, "name").trim(),
  enabled: valueOf(row, "enabled") === "TRUE",
  host: valueOf(row, "host"),
  port: Number(valueOf(row, "port")) || DEFAULT_PORT,
  whenInUse: valueOf(row, "whenInUse") === "send" ? "send" : "wait",
});

export function createBackend(context: ModuleContext, options: BackendOptions = {}): ModuleInstance {
  if (!context.services) throw Error("Flanders needs Hubble's portable documents.");
  const documents = createModuleDocumentClient(context.services);
  const listConnections = options.listConnections ?? listOtherConnections;
  const now = options.now ?? (() => new Date());
  const lifetime = new AbortController();
  const statuses: Statuses = {};
  const waiters = new Set<() => void>();
  let plan: MonitorDocument | undefined;
  let revision: string | null = null;
  // Clock-based so it keeps rising across a worker restart. The page uses it to ignore state that arrives late.
  let sequence = 0;
  const clock = () => now().toTimeString().slice(0, 8);

  function publish() {
    sequence = Math.max(sequence + 1, Date.now());
    context.publishState({
      // Hubble shows any message as a connection error, so a ready module has none.
      phase: "ready",
      message: null,
      observedAt: now().toISOString(),
      values: { revision, sequence, statuses: ModuleDocumentValueSchema.parse(statuses) },
    });
    for (const wake of [...waiters]) wake();
  }

  /** A status belongs to an address. Change the address, or remove the monitor, and it goes. */
  function adopt(doc: MonitorDocument) {
    plan = doc;
    for (const [id, status] of Object.entries(statuses)) {
      const row = doc.monitors.find((item) => item.id === id);
      if (!row || valueOf(row, "host") !== status.host || valueOf(row, "port") !== status.port) delete statuses[id];
    }
  }
  function setStatus(monitor: Monitor, text: string, tone: MonitorStatus["tone"]) {
    statuses[monitor.row.id] = { host: valueOf(monitor.row, "host"), port: valueOf(monitor.row, "port"), text: `${text} · ${clock()}`, tone };
    publish();
  }

  async function snapshot(signal: AbortSignal) {
    const saved = await documents.read(DOCUMENT_ID, signal);
    revision = saved.revision;
    adopt(validateDocument(saved.value));
    return { document: plan!, revision, statuses, sequence };
  }

  function find(id: string, fields: ModuleValues): { monitor: Monitor; key: FlandersKey } | string {
    let name: unknown;
    let keyId: unknown;
    if (id === PRESS_ACTION) {
      name = fields.monitor;
      keyId = fields.key;
    } else {
      const values = fields.values;
      if (!values || typeof values !== "object" || Array.isArray(values))
        return "This action runs from a Button Matrix row. Use Press key elsewhere.";
      name = (values as Record<string, unknown>)[MONITOR_FIELD];
      keyId = (values as Record<string, unknown>)[KEY_FIELD];
    }
    const key = keyById(keyId);
    if (!key) return "Choose a key";
    if (typeof name !== "string" || !name.trim()) return "Choose a monitor";
    const row = plan?.monitors.find((item) => sameName(valueOf(item, "name"), name));
    if (!row) return `There's no monitor called "${name.trim()}" on the Flanders page`;
    return { monitor: monitorOf(row), key };
  }

  async function press(monitor: Monitor, key: FlandersKey, execution: ModuleExecutionContext): Promise<ModuleActionResult> {
    if (!monitor.enabled) return failure("unavailable", `${monitor.name} is switched off on the Flanders page. Nothing was sent.`);
    if (!monitor.host) return failure("invalid-config", `${monitor.name} has no IP address on the Flanders page`);
    if (context.connectionEnabled === false) return failure("unavailable", "The Flanders module is switched off. Nothing was sent.");
    const signal = AbortSignal.any([execution.signal, lifetime.signal]);
    if (signal.aborted) return failure("cancelled", "Cancelled before sending");
    return oneAtATime(`${monitor.host}:${monitor.port}`, async () => {
      try {
        if (signal.aborted) return failure("cancelled", "Cancelled before sending");
        const address = await resolveAddress(monitor.host, signal);
        if (monitor.whenInUse === "wait") {
          let others;
          try {
            others = await listConnections(address, monitor.port, signal);
          } catch {
            if (signal.aborted) return failure("cancelled", "Cancelled before sending");
            setStatus(monitor, `${key.label} not sent · couldn't check for other apps`, "failed");
            return failure("unavailable", `Couldn't check whether another app is using ${monitor.name}, so ${key.label} wasn't sent`);
          }
          if (others.length) {
            const apps = describeApps(others);
            setStatus(monitor, `${key.label} held back · ${apps} connected`, "held");
            execution.log({ level: "info", stage: "in-use", message: `${key.label} not sent to ${monitor.name}: ${apps} is connected to ${address}:${monitor.port}` });
            return failure(
              "rejected",
              `${apps} ${others.length > 1 ? "are" : "is"} connected to ${monitor.name}, so ${key.label} wasn't sent. Sending would risk disconnecting ${others.length > 1 ? "them" : "it"}.`,
            );
          }
        }
        await sendOnce({
          address,
          port: monitor.port,
          packet: keyPacket(key.code),
          signal,
          ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
          ...(options.closeWaitMs ? { closeWaitMs: options.closeWaitMs } : {}),
        });
        setStatus(monitor, `Sent ${key.label}`, "ok");
        execution.log({ level: "info", stage: "sent", message: `Sent ${key.label} to ${monitor.name} at ${address}:${monitor.port}` });
        return { status: "success", evidence: { kind: "submitted", summary: `Sent ${key.label} to ${monitor.name} and closed the connection` } };
      } catch (error) {
        if (error instanceof SendError) {
          if (error.category !== "cancelled")
            setStatus(monitor, `${key.label} not sent · ${error.category === "timeout" ? "no answer" : "couldn't connect"}`, "failed");
          return failure(error.category, `${monitor.name}: ${error.message}`);
        }
        return failure("internal", `${key.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Reads this Mac's connection list for every monitor. Contacts no monitor. */
  async function checkOtherApps(signal: AbortSignal) {
    const doc = (await snapshot(signal)).document;
    let busy = 0;
    for (const monitor of doc.monitors.map(monitorOf)) {
      if (!monitor.enabled || !monitor.host) continue;
      try {
        const others = await listConnections(await resolveAddress(monitor.host, signal), monitor.port, signal);
        if (others.length) busy++;
        statuses[monitor.row.id] = {
          host: monitor.host,
          port: valueOf(monitor.row, "port"),
          text: `${others.length ? `${describeApps(others)} connected · ${monitor.whenInUse === "wait" ? "keys held back" : "keys sent anyway"}` : "No other apps connected"} · ${clock()}`,
          tone: others.length ? "held" : "ok",
        };
      } catch (error) {
        if (signal.aborted) throw error;
        statuses[monitor.row.id] = { host: monitor.host, port: valueOf(monitor.row, "port"), text: `Couldn't check · ${clock()}`, tone: "failed" };
      }
    }
    publish();
    return busy ? `Another app is connected to ${busy} monitor${busy > 1 ? "s" : ""}` : "No other apps are connected";
  }

  async function save(operation: Mutation, signal: AbortSignal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await documents.read(DOCUMENT_ID, signal);
      const next = applyMutation(validateDocument(saved.value), operation);
      try {
        const result = await documents.write(saved, ModuleDocumentValueSchema.parse(next), signal);
        revision = result.revision;
        adopt(next);
        publish();
        return { document: next, revision, statuses, sequence };
      } catch (error) {
        if (!(error instanceof ModuleDocumentConflictError) || attempt === 2) throw error;
      }
    }
    throw Error("The monitor list changed before saving.");
  }

  return {
    async start() {
      // Nothing to connect: a monitor is only contacted while a key is sent.
      await snapshot(lifetime.signal);
      publish();
      void (async () => {
        for await (const saved of documents.watch(DOCUMENT_ID, lifetime.signal)) {
          revision = saved.revision;
          adopt(validateDocument(saved.value));
          publish();
        }
      })().catch(() => {
        if (!lifetime.signal.aborted) context.log({ level: "error", stage: "monitor-plan-watch", message: "Stopped following the monitor list." });
      });
    },
    async execute(id, fields, execution) {
      if (id !== MATRIX_ACTION && id !== PRESS_ACTION) return failure("invalid-config", "Unknown Flanders action");
      const chosen = find(id, fields);
      if (typeof chosen === "string") return failure("invalid-config", chosen);
      return press(chosen.monitor, chosen.key, execution);
    },
    choices(provider) {
      if (provider !== MONITOR_PROVIDER) return [];
      return (plan?.monitors ?? []).map((row) => valueOf(row, "name").trim()).filter(Boolean).map((name) => ({ id: name, label: name }));
    },
    async call(method, raw, execution): Promise<ModuleJsonValue> {
      if (method !== `page.${PAGE_ID}` || !raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Unknown Flanders page command.");
      const command = raw as { sectionId?: string; commandId?: string; value?: { operation?: Mutation; after?: number } };
      if (command.sectionId !== "frontend") throw Error("Unknown Flanders view.");
      const { signal } = execution;
      signal.throwIfAborted();
      if (command.commandId === "snapshot") return (await snapshot(signal)) as unknown as ModuleJsonValue;
      if (command.commandId === "save") return (await save(command.value!.operation!, signal)) as unknown as ModuleJsonValue;
      if (command.commandId === "check") return { message: await checkOtherApps(signal), statuses, sequence } as unknown as ModuleJsonValue;
      if (command.commandId === "changes") {
        // Parks until something changes, so a key's result reaches the page straight away.
        const after = Number(command.value?.after ?? 0);
        if (sequence <= after)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", finish);
              waiters.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, 20_000);
            signal.addEventListener("abort", finish, { once: true });
            waiters.add(finish);
          });
        return { statuses, sequence } as unknown as ModuleJsonValue;
      }
      throw Error("Unknown Flanders page command.");
    },
    subscribeFeedback(subscriptions) {
      // The monitor reports nothing back, so there is no state to show.
      for (const subscription of subscriptions)
        if (subscription.id === FEEDBACK) context.publishFeedback({ ...subscription, state: "unavailable", observedAt: null });
    },
    dispose() {
      for (const wake of [...waiters]) wake();
      lifetime.abort();
    },
  };
}
