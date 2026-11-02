import { afterEach, expect, it, vi } from "vitest";
import type {
  VideohubClientEvent,
  VideohubCrosspoint,
  VideohubSnapshot,
} from "@hubble/protocol-videohub";
import { SingleLevelRouterConnectionManager } from "../src/single-level-manager.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const managers: SingleLevelRouterConnectionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

async function fixture(type: "aja-kumo" | "blackmagic-videohub") {
  const listeners = new Set<(event: VideohubClientEvent) => void>();
  const emit = (event: VideohubClientEvent) => {
    for (const listener of listeners) listener(event);
  };
  let current: VideohubSnapshot = {
    phase: "disconnected",
    revision: 1,
    catalogRevision: 1,
    confirmedOperationSequence: 0,
    protocolVersion: "2.3",
    deviceStatus: "present",
    modelName: type,
    detectedSourceCount: 4,
    detectedDestinationCount: 3,
    sourceCount: 3,
    destinationCount: 3,
    sources: [1, 2, 3].map((address) => ({ address, name: `SRC ${address}` })),
    destinations: [1, 2, 3].map((address) => ({
      address,
      name: `DST ${address}`,
    })),
    routes: [1, 2, 3].map((address) => ({
      source: address,
      destination: address,
    })),
    locks: [],
    labelsDegraded: false,
    catalogStale: false,
    lastError: null,
  };
  const snapshot = vi.fn(() => current);
  const manager = new SingleLevelRouterConnectionManager(type, () => ({
    snapshot,
    connect: async () => {
      current = { ...current, phase: "connected" };
      emit({ type: "phase", phase: "connected", error: null });
    },
    disconnect() {},
    refreshNames: async () => {},
    refreshRoutes: async () => {},
    setCrosspoint: async () => {},
    readDestination: async (destination) =>
      current.routes.find((route) => route.destination === destination)!,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }));
  managers.push(manager);
  manager.reconcile([
    {
      connectionId,
      type,
      name: type,
      enabled: true,
      host: "127.0.0.1",
      port: 9990,
      sourceLimit: 3,
      destinationLimit: 3,
      requestTimeoutMs: 1000,
      reconnectDelayMs: 2000,
      schemaVersion: 1,
    },
  ]);
  await vi.waitFor(() =>
    expect(manager.snapshots()[0]?.phase).toBe("connected"),
  );
  return {
    manager,
    snapshot,
    emit,
    update(crosspoints: readonly VideohubCrosspoint[], batch = false) {
      const previousRevision = current.revision;
      const changed = new Map(
        crosspoints.map((point) => [point.destination, point]),
      );
      current = {
        ...current,
        revision: previousRevision + 1,
        routes: current.routes.map(
          (point) => changed.get(point.destination) ?? point,
        ),
      };
      if (batch)
        emit({
          type: "routes",
          crosspoints,
          previousRevision,
          revision: current.revision,
        });
      else
        emit({
          type: "route",
          crosspoint: crosspoints[0]!,
          previousRevision,
          revision: current.revision,
        });
    },
  };
}

it.each(["aja-kumo", "blackmagic-videohub"] as const)(
  "%s applies confirmed route deltas without materializing full client snapshots",
  async (type) => {
    const f = await fixture(type);
    const original = f.manager.snapshots()[0]!.routes;
    const confirmed = vi.fn();
    f.manager.watchConfirmedRouteTarget(
      { connectionId, destination: 2, levels: [1] },
      confirmed,
    );
    confirmed.mockClear();
    f.snapshot.mockClear();
    for (let i = 0; i < 100; i++)
      f.emit({
        type: "route-observation",
        crosspoint: { source: 2, destination: 2 },
        revision: 1,
      });
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(confirmed).not.toHaveBeenCalled();
    f.update([{ source: 3, destination: 2 }]);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(confirmed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "ready",
        sourcesByLevel: new Map([[1, 3]]),
      }),
    );
    const single = f.manager.snapshots()[0]!.routes;
    expect(single.routes.get(2)?.get(1)).toBe(3);
    expect(single.routes.get(1)).toBe(original.routes.get(1));
    expect(original.routes.get(2)?.get(1)).toBe(2);
    f.update(
      [
        { source: 1, destination: 2 },
        { source: 2, destination: 3 },
      ],
      true,
    );
    const batch = f.manager.snapshots()[0]!.routes;
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(batch.revision).toBe(3);
    expect(batch.routes.get(2)?.get(1)).toBe(1);
    expect(batch.routes.get(3)?.get(1)).toBe(2);
    expect(single.routes.get(2)?.get(1)).toBe(3);
    expect(single.routes.get(3)?.get(1)).toBe(3);
  },
);

it.each(["aja-kumo", "blackmagic-videohub"] as const)(
  "%s retains authoritative reconciliation for routes outside the local source limit",
  async (type) => {
    const f = await fixture(type);
    f.snapshot.mockClear();
    f.update([{ source: 4, destination: 2 }]);
    expect(f.snapshot).toHaveBeenCalled();
    expect(f.manager.snapshots()[0]!.routes.routes.has(2)).toBe(false);
    expect(f.manager.snapshots()[0]!.routes.routes.get(1)?.get(1)).toBe(1);
  },
);
