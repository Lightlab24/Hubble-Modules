import type {
  ModuleActionResult,
  ModuleContext,
  ModuleExecutionContext,
  ModuleInstance,
  ModuleValues,
} from "@hubble/module-sdk";
import { FEEDBACK, KEY_FIELD, MATRIX_ACTION, PRESS_ACTION } from "./actions.js";
import { readSettings } from "./config.js";
import { keyById, type FlandersKey } from "./keys.js";
import { keyPacket } from "./protocol.js";
import { describeApps, listOtherConnections, type ConnectionLister } from "./sharing.js";
import { resolveAddress, SendError, sendOnce } from "./transport.js";

export interface InstanceOptions {
  readonly listConnections?: ConnectionLister;
  readonly connectTimeoutMs?: number;
  readonly closeWaitMs?: number;
}

/**
 * Keys for one monitor go one at a time, across every connection in this
 * worker, so Hubble never opens two connections to the same monitor at once.
 */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
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

function chosenKey(id: string, fields: ModuleValues): FlandersKey | string {
  if (id === PRESS_ACTION) return keyById(fields.key) ?? "Choose a monitor key";
  const values = fields.values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    return "This action runs from a Button Matrix row. Use Press key elsewhere.";
  return keyById((values as Record<string, unknown>)[KEY_FIELD]) ?? "Choose a key in this row";
}

const failure = (
  category: Extract<ModuleActionResult, { status: "failure" }>["category"],
  message: string,
): ModuleActionResult => ({ status: "failure", category, message });

export function createInstance(context: ModuleContext, options: InstanceOptions = {}): ModuleInstance {
  const listConnections = options.listConnections ?? listOtherConnections;
  const lifetime = new AbortController();
  const settings = readSettings(context.settings);

  function publishReady() {
    context.publishState(
      typeof settings === "string"
        ? { phase: "error", message: settings, observedAt: new Date().toISOString(), values: {} }
        : {
            // Hubble shows any message as a connection error, so a ready monitor has none.
            phase: "ready",
            message: null,
            observedAt: new Date().toISOString(),
            values: { host: settings.host, port: settings.port, whenInUse: settings.whenInUse },
          },
    );
  }

  async function press(key: FlandersKey, execution: ModuleExecutionContext): Promise<ModuleActionResult> {
    if (typeof settings === "string") return failure("invalid-config", settings);
    if (context.connectionEnabled === false)
      return failure("unavailable", "This Flanders connection is switched off. Nothing was sent.");
    const signal = AbortSignal.any([execution.signal, lifetime.signal]);
    if (signal.aborted) return failure("cancelled", "Cancelled before sending");
    const target = `${settings.host}:${settings.port}`;
    return oneAtATime(target, async () => {
      try {
        if (signal.aborted) return failure("cancelled", "Cancelled before sending");
        const address = await resolveAddress(settings.host, signal);
        if (settings.whenInUse === "wait") {
          let others;
          try {
            others = await listConnections(address, settings.port, signal);
          } catch {
            if (signal.aborted) return failure("cancelled", "Cancelled before sending");
            return failure(
              "unavailable",
              `Couldn't check whether another app is using the monitor, so ${key.label} wasn't sent`,
            );
          }
          if (others.length) {
            const apps = describeApps(others);
            execution.log({
              level: "info",
              stage: "in-use",
              message: `${key.label} not sent: ${apps} is connected to ${address}:${settings.port}`,
            });
            return failure(
              "rejected",
              `${apps} ${others.length > 1 ? "are" : "is"} connected to this monitor, so ${key.label} wasn't sent. Sending would risk disconnecting ${others.length > 1 ? "them" : "it"}.`,
            );
          }
        }
        await sendOnce({
          address,
          port: settings.port,
          packet: keyPacket(key.code),
          signal,
          ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
          ...(options.closeWaitMs ? { closeWaitMs: options.closeWaitMs } : {}),
        });
        execution.log({ level: "info", stage: "sent", message: `Sent ${key.label} to ${address}:${settings.port}` });
        return {
          status: "success",
          evidence: {
            kind: "submitted",
            summary: `Sent ${key.label} to the monitor and closed the connection`,
          },
        };
      } catch (error) {
        if (error instanceof SendError) return failure(error.category, error.message);
        return failure("internal", `${key.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return {
    start() {
      // Nothing to connect: a monitor is only contacted while a key is sent.
      publishReady();
    },
    async execute(id, fields, execution) {
      if (id !== MATRIX_ACTION && id !== PRESS_ACTION) return failure("invalid-config", "Unknown Flanders action");
      const key = chosenKey(id, fields);
      if (typeof key === "string") return failure("invalid-config", key);
      return press(key, execution);
    },
    subscribeFeedback(subscriptions) {
      // The monitor reports nothing back, so there is no state to show.
      for (const subscription of subscriptions)
        if (subscription.id === FEEDBACK)
          context.publishFeedback({ ...subscription, state: "unavailable", observedAt: null });
    },
    dispose() {
      lifetime.abort();
    },
  };
}
