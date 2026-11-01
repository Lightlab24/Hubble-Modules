import type { RouterConnectionDefinition } from "../types.js";
import type { ManagedRouterConnectionSnapshot } from "../connection-contract.js";

/** Package-owned display DTO. Connection credentials never cross the page bridge. */
type DisplayDefinition<T> = T extends RouterConnectionDefinition
  ? Omit<
      T,
      "moduleBinding" | "password" | "username" | "refreshIntervalSeconds"
    >
  : never;
export type ConnectionView = DisplayDefinition<RouterConnectionDefinition> & {
  status: "connecting" | "connected" | "disconnected" | "disabled";
  modelName?: string | null;
  detectedSourceCount: number | null;
  detectedDestinationCount: number | null;
  effectiveSourceCount: number | null;
  effectiveDestinationCount: number | null;
  destinationLocks?: readonly { destination: number; owner: number }[];
};

export function connectionView(
  snapshot: ManagedRouterConnectionSnapshot,
): ConnectionView {
  const { definition } = snapshot;
  // Do not spread settings: KUMO credentials and future secrets remain in the worker.
  return {
    connectionId: definition.connectionId,
    name: definition.name,
    enabled: definition.enabled,
    schemaVersion: definition.schemaVersion,
    type: definition.type,
    host: definition.host,
    port: definition.port,
    sourceLimit: definition.sourceLimit,
    destinationLimit: definition.destinationLimit,
    requestTimeoutMs: definition.requestTimeoutMs,
    reconnectDelayMs: definition.reconnectDelayMs,
    ...("levels" in definition ? { levels: definition.levels } : {}),
    ...("levelSystem" in definition
      ? { levelSystem: definition.levelSystem }
      : {}),
    status: definition.enabled ? snapshot.phase : "disabled",
    modelName: snapshot.deviceModel,
    detectedSourceCount: snapshot.detectedSourceCount ?? null,
    detectedDestinationCount: snapshot.detectedDestinationCount ?? null,
    effectiveSourceCount: snapshot.effectiveSourceCount ?? null,
    effectiveDestinationCount: snapshot.effectiveDestinationCount ?? null,
    destinationLocks: snapshot.destinationLocks,
  } as ConnectionView;
}

export function connectionPresentationStatus(status: ConnectionView["status"]) {
  return status === "connecting" || status === "disconnected"
    ? "reconnecting"
    : status;
}
export function connectionPresentationLabel(
  status: ConnectionView["status"],
): string {
  return {
    reconnecting: "Reconnecting",
    connected: "Connected",
    disabled: "Disabled",
  }[connectionPresentationStatus(status)];
}
