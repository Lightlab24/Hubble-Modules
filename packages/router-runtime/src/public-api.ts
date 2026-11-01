import { z } from "zod";
import type {
  ModuleActionResult,
  ModuleExecutionContext,
  ModuleJsonValue,
  ModuleManifest,
  ModuleValues,
} from "@hubble/module-sdk";
import type { RouterConnectionManagerContract } from "./connection-contract.js";

export const routeFields = z.strictObject({
  source: z.int().min(1).max(65536),
  destination: z.int().min(1).max(65536),
  level: z.int().min(1).max(256),
});
export const directRouteAction: ModuleManifest["actions"][number] = {
  id: "route",
  label: "Route source to output",
  group: "Routing",
  description:
    "Submit one crosspoint and wait for the protocol operation to settle. No automatic retry.",
  completion: "submitted",
  timeoutMs: 120000,
  fields: ["source", "destination", "level"].map((id) => ({
    id,
    label:
      id === "destination" ? "Output" : id === "level" ? "Level" : "Source",
    type: "number",
    required: true,
    integer: true,
    default: 1,
    min: 1,
    max: id === "level" ? 256 : 65536,
  })),
};
export function routerReadiness(
  manager: RouterConnectionManagerContract,
  connectionId: string,
): ModuleJsonValue {
  const snapshot = manager
    .snapshots()
    .find((item) => item.definition.connectionId === connectionId);
  let ready = false;
  try {
    ready =
      snapshot?.routeTransport === "connected" &&
      manager.routeState(connectionId).phase === "ready";
  } catch {
    /* Not connected. */
  }
  const definition = snapshot?.definition;
  return {
    ready,
    sourceLimit:
      snapshot?.effectiveSourceCount ??
      (definition && "sourceLimit" in definition
        ? definition.sourceLimit
        : null) ??
      null,
    destinationLimit:
      snapshot?.effectiveDestinationCount ??
      (definition && "destinationLimit" in definition
        ? definition.destinationLimit
        : null) ??
      null,
    levels: definition && "levels" in definition ? definition.levels : 1,
  };
}
export async function routePublic(
  manager: RouterConnectionManagerContract,
  connectionId: string,
  fields: ModuleValues,
  execution: ModuleExecutionContext,
): Promise<ModuleActionResult> {
  const parsed = routeFields.safeParse(fields);
  if (!parsed.success)
    return {
      status: "failure",
      category: "invalid-config",
      message: "Choose a valid source, output and level",
    };
  if (execution.signal.aborted)
    return {
      status: "failure",
      category: "cancelled",
      message: "Cancelled before route dispatch",
    };
  const state = routerReadiness(manager, connectionId) as {
    ready: boolean;
    sourceLimit: number | null;
    destinationLimit: number | null;
    levels: number;
  };
  const { source, destination, level } = parsed.data;
  if (!state.ready)
    return {
      status: "failure",
      category: "unavailable",
      message: "Router is not ready",
    };
  if (
    (state.sourceLimit !== null && source > state.sourceLimit) ||
    (state.destinationLimit !== null && destination > state.destinationLimit) ||
    level > state.levels
  )
    return {
      status: "failure",
      category: "invalid-config",
      message: "Crosspoint exceeds the router range",
    };
  try {
    const submission = manager.submitDirectRouteTracked({
      connectionId,
      source,
      destination,
      levels: [level],
    });
    await Promise.all([submission.accepted, submission.settled]);
    if (execution.signal.aborted)
      return {
        status: "failure",
        category: "cancelled",
        message:
          "Cancelled after dispatch; the route may have completed and will not be replayed",
      };
    return {
      status: "success",
      evidence: {
        kind: "submitted",
        summary: "The router protocol operation settled; no retry was sent",
      },
    };
  } catch (error) {
    return {
      status: "failure",
      category: "rejected",
      message:
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Router operation failed; no retry was sent",
    };
  }
}
