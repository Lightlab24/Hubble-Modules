import type { VideohubClientEvent } from "@hubble/protocol-videohub";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterConfirmedRouteTargetSnapshot } from "../src/connection-contract.js";
import {
  SimulatedKumoRouterClient,
  SimulatedSingleLevelRouterClient,
  createSimulatedSingleLevelClient,
} from "../src/simulated-single-level-client.js";
import { SingleLevelRouterConnectionManager } from "../src/single-level-manager.js";
import type { SingleLevelRouterConnectionDefinition } from "../src/single-level-types.js";

const connectionId = "00000000-0000-4000-8000-000000000101";
const managers: SingleLevelRouterConnectionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

function definition(
  type: "blackmagic-videohub" | "aja-kumo",
  overrides: Partial<SingleLevelRouterConnectionDefinition> = {},
): SingleLevelRouterConnectionDefinition {
  return {
    connectionId,
    type,
    name: type,
    enabled: true,
    simulated: true,
    host: "",
    port: type === "aja-kumo" ? 80 : 9990,
    requestTimeoutMs: 1000,
    reconnectDelayMs: 2000,
    schemaVersion: 1,
    ...(type === "aja-kumo" ? { password: "" } : {}),
    ...overrides,
  } as SingleLevelRouterConnectionDefinition;
}

describe("simulated Videohub and KUMO client", () => {
  it("uses a 40×40 Videohub with Input and Output names when Sources and Destinations are blank", async () => {
    const client = new SimulatedSingleLevelRouterClient(
      definition("blackmagic-videohub"),
      { latencyMs: 0 },
    );
    expect(client.snapshot().phase).toBe("disconnected");
    const phases: string[] = [];
    client.subscribe((event) => {
      if (event.type === "phase") phases.push(event.phase);
    });
    await client.connect();
    expect(phases).toEqual(["connecting", "connected"]);
    const snapshot = client.snapshot();
    expect(snapshot).toMatchObject({
      phase: "connected",
      deviceStatus: "present",
      modelName: "Simulated Videohub 40x40",
      detectedSourceCount: 40,
      detectedDestinationCount: 40,
      sourceCount: 40,
      destinationCount: 40,
      labelsDegraded: false,
      lastError: null,
    });
    expect(snapshot.sources[0]).toEqual({ address: 1, name: "Input 1" });
    expect(snapshot.destinations[39]).toEqual({
      address: 40,
      name: "Output 40",
    });
    expect(snapshot.routes).toHaveLength(40);
    expect(
      snapshot.routes.every(
        ({ source, destination }) => source === destination,
      ),
    ).toBe(true);
    expect(snapshot.locks.every(({ state }) => state === "unlocked")).toBe(
      true,
    );
    // Snapshots are reused until something changes.
    expect(client.snapshot()).toBe(snapshot);
  });

  it("uses a 32×32 KUMO with Source and Dest names, and the configured size when given", async () => {
    const blank = createSimulatedSingleLevelClient(definition("aja-kumo"), {
      latencyMs: 0,
    });
    await blank.connect();
    expect(blank.snapshot()).toMatchObject({
      modelName: "Simulated KUMO 32x32",
      sourceCount: 32,
      destinationCount: 32,
    });
    expect(blank.snapshot().sources[1]?.name).toBe("Source 2");
    expect(blank.snapshot().destinations[1]?.name).toBe("Dest 2");

    const sized = createSimulatedSingleLevelClient(
      definition("aja-kumo", { sourceLimit: 4, destinationLimit: 6 }),
      { latencyMs: 0 },
    );
    await sized.connect();
    expect(sized.snapshot()).toMatchObject({
      sourceCount: 4,
      destinationCount: 6,
    });
    // More outputs than inputs: outputs 5 and 6 start on inputs 1 and 2.
    expect(sized.snapshot().routes.map(({ source }) => source)).toEqual([
      1, 2, 3, 4, 1, 2,
    ]);
  });

  it("routes a crosspoint with the events and counters a real Videohub produces", async () => {
    const client = new SimulatedSingleLevelRouterClient(
      definition("blackmagic-videohub", {
        sourceLimit: 4,
        destinationLimit: 4,
      }),
      { latencyMs: 2 },
    );
    await client.connect();
    const events: VideohubClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const before = client.snapshot();
    await client.setCrosspoint({ source: 3, destination: 2 });
    const after = client.snapshot();
    expect(events.filter(({ type }) => type === "route")).toEqual([
      {
        type: "route",
        crosspoint: { destination: 2, source: 3 },
        previousRevision: before.revision,
        revision: before.revision + 1,
      },
    ]);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.confirmedOperationSequence).toBe(
      before.confirmedOperationSequence + 1,
    );
    expect(after.routes.find(({ destination }) => destination === 2)).toEqual(
      { destination: 2, source: 3 },
    );
    await expect(client.readDestination(2)).resolves.toEqual({
      destination: 2,
      source: 3,
    });

    // An unchanged route is confirmed without a route event.
    events.length = 0;
    await client.setCrosspoint({ source: 3, destination: 2 });
    expect(events.filter(({ type }) => type === "route")).toEqual([]);
    expect(client.snapshot().revision).toBe(after.revision);
    expect(client.snapshot().confirmedOperationSequence).toBe(
      after.confirmedOperationSequence + 1,
    );

    await expect(
      client.setCrosspoint({ source: 5, destination: 1 }),
    ).rejects.toThrow("source must be an integer from 1 to 4");
  });

  it("refuses commands while disconnected and keeps its routes for the next connection", async () => {
    const client = new SimulatedSingleLevelRouterClient(
      definition("blackmagic-videohub", {
        sourceLimit: 2,
        destinationLimit: 2,
      }),
      { latencyMs: 0 },
    );
    await expect(
      client.setCrosspoint({ source: 2, destination: 1 }),
    ).rejects.toThrow("Simulated Videohub is not connected");
    await client.connect();
    await client.setCrosspoint({ source: 2, destination: 1 });
    client.disconnect();
    expect(client.snapshot()).toMatchObject({
      phase: "disconnected",
      routes: [],
      sourceCount: null,
    });
    await client.connect();
    expect(client.snapshot().routes[0]).toEqual({ destination: 1, source: 2 });
  });

  it("fails a write that a disconnect overtakes, without applying it", async () => {
    const client = new SimulatedSingleLevelRouterClient(
      definition("blackmagic-videohub", {
        sourceLimit: 2,
        destinationLimit: 2,
      }),
      { latencyMs: 5 },
    );
    await client.connect();
    const write = client.setCrosspoint({ source: 2, destination: 1 });
    client.disconnect();
    await expect(write).rejects.toThrow("not connected");
    await client.connect();
    expect(client.snapshot().routes[0]).toEqual({ destination: 1, source: 1 });
  });

  it("gives KUMO eight empty salvos and no Videohub salvos", async () => {
    const kumo = createSimulatedSingleLevelClient(definition("aja-kumo"), {
      latencyMs: 0,
    });
    expect(kumo).toBeInstanceOf(SimulatedKumoRouterClient);
    await kumo.connect();
    const routes = kumo.snapshot().routes;
    expect(kumo.salvoCatalog?.()).toHaveLength(8);
    await kumo.recallSalvo?.(3);
    expect(kumo.snapshot().routes).toEqual(routes);
    await expect(kumo.recallSalvo?.(9)).rejects.toThrow("1 to 8");
    const videohub = createSimulatedSingleLevelClient(
      definition("blackmagic-videohub"),
    );
    expect(videohub.recallSalvo).toBeUndefined();
    expect(videohub.salvoCatalog).toBeUndefined();
  });
});

describe.each(["blackmagic-videohub", "aja-kumo"] as const)(
  "single-level manager with a simulated %s",
  (type) => {
    async function connectedManager() {
      const manager = new SingleLevelRouterConnectionManager(type, (value) =>
        createSimulatedSingleLevelClient(value, { latencyMs: 1 }),
      );
      managers.push(manager);
      manager.reconcile([
        definition(type, { sourceLimit: 8, destinationLimit: 8 }),
      ]);
      await vi.waitFor(() =>
        expect(manager.snapshots()[0]?.phase).toBe("connected"),
      );
      return manager;
    }

    it("connects, routes a crosspoint and resolves the confirmed-route watch", async () => {
      const manager = await connectedManager();
      const snapshot = manager.snapshots()[0]!;
      expect(snapshot).toMatchObject({
        lastError: null,
        deviceStatus: "present",
        effectiveSourceCount: 8,
        effectiveDestinationCount: 8,
      });
      expect(snapshot.sourceCatalog[0]?.label).toBe(
        type === "aja-kumo" ? "Source 1" : "Input 1",
      );
      expect(snapshot.routes.routes.get(5)?.get(1)).toBe(5);
      expect(manager.routeState(connectionId).phase).toBe("ready");

      const watched: RouterConfirmedRouteTargetSnapshot[] = [];
      manager.watchConfirmedRouteTarget(
        { connectionId, destination: 5, levels: [1] },
        (value) => watched.push(value),
      );
      expect(watched.at(-1)).toMatchObject({
        phase: "ready",
        sourcesByLevel: new Map([[1, 5]]),
      });
      const routeEvents = vi.fn();
      manager.subscribeRouteState(connectionId, routeEvents);

      await manager.directRoute({ connectionId, source: 7, destination: 5 });
      expect(manager.snapshots()[0]?.routes.routes.get(5)?.get(1)).toBe(7);
      expect(watched.at(-1)).toMatchObject({
        phase: "ready",
        sourcesByLevel: new Map([[1, 7]]),
      });
      expect(routeEvents).toHaveBeenCalled();
      expect(manager.snapshots()[0]?.lastError).toBeNull();
    });

    it("routes through a versioned route request as the Router page does", async () => {
      const manager = await connectedManager();
      const version = manager.routeState(connectionId).version;
      const result = await manager.routeCrosspoints({
        operationId: "00000000-0000-4000-8000-0000000000a1",
        connectionId,
        version,
        mappings: [
          {
            mappingId: "00000000-0000-4000-8000-0000000000a2",
            source: 2,
            destination: 3,
            levels: [1],
            expected: [{ level: 1, source: 3 }],
          },
        ],
      } as Parameters<typeof manager.routeCrosspoints>[0]);
      expect(result).toMatchObject({
        status: "acknowledged",
        outcomes: [expect.objectContaining({ outcome: "acknowledged" })],
      });
      expect(manager.snapshots()[0]?.routes.routes.get(3)?.get(1)).toBe(2);
    });
  },
);
