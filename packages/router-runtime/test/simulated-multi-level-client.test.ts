import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterConfirmedRouteTargetSnapshot } from "../src/connection-contract.js";
import { MultiLevelRouterConnectionManager } from "../src/multi-level-manager.js";
import type {
  MultiLevelRouterClientEvent,
  MultiLevelRouterConnectionDefinition,
} from "../src/multi-level-types.js";
import {
  SimulatedMultiLevelRouterClient,
  SimulatedQuartzRouterClient,
  createSimulatedMultiLevelClient,
} from "../src/simulated-multi-level-client.js";

const connectionId = "00000000-0000-4000-8000-000000000201";
const managers: MultiLevelRouterConnectionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

function definition(
  type: "ross-ultrix-ogp" | "evertz-quartz",
  overrides: Partial<MultiLevelRouterConnectionDefinition> = {},
): MultiLevelRouterConnectionDefinition {
  return {
    connectionId,
    type,
    name: type,
    enabled: true,
    simulated: true,
    host: "",
    port: type === "evertz-quartz" ? 23 : 5254,
    sourceLimit: 6,
    destinationLimit: 4,
    levels: 3,
    requestTimeoutMs: 1000,
    reconnectDelayMs: 2000,
    schemaVersion: 1,
    ...(type === "evertz-quartz"
      ? { levelSystem: "16-level", refreshIntervalSeconds: 60 }
      : {}),
    ...overrides,
  } as MultiLevelRouterConnectionDefinition;
}

const sourceAt = (
  client: { snapshot(): { routes: readonly { destination: number; level: number; source: number | null }[] } },
  destination: number,
  level: number,
) =>
  client
    .snapshot()
    .routes.find(
      (route) => route.destination === destination && route.level === level,
    )?.source;

describe("simulated Ultrix and Quartz client", () => {
  it("sizes itself from Sources, Destinations and Levels and starts each level on its own input", async () => {
    const client = new SimulatedMultiLevelRouterClient(
      definition("ross-ultrix-ogp"),
      { latencyMs: 0 },
    );
    expect(client.snapshot()).toMatchObject({
      phase: "disconnected",
      controlReady: false,
      subscriptions: [],
      routes: [],
    });
    await client.connect();
    const snapshot = client.snapshot();
    expect(snapshot).toMatchObject({
      phase: "connected",
      controlReady: true,
      takeError: null,
      lastError: null,
    });
    expect(snapshot.subscriptions.length).toBeGreaterThan(0);
    expect(snapshot.sources).toHaveLength(6);
    expect(snapshot.destinations).toHaveLength(4);
    expect(snapshot.sources[0]).toEqual({
      address: 1,
      label: "Source 1",
      description: null,
    });
    expect(snapshot.levels.map(({ label }) => label)).toEqual([
      "Video",
      "Audio 1",
      "Audio 2",
    ]);
    expect(snapshot.routes).toHaveLength(12);
    expect(
      snapshot.routes.every(({ destination, source }) => destination === source),
    ).toBe(true);
  });

  it("names Quartz levels by letter", async () => {
    const client = createSimulatedMultiLevelClient(
      definition("evertz-quartz"),
      { latencyMs: 0 },
    );
    await client.connect();
    expect(client.snapshot().levels.map(({ label }) => label)).toEqual([
      "V",
      "A",
      "B",
    ]);
  });

  it("routes chosen levels only, with one route event per change", async () => {
    const client = new SimulatedMultiLevelRouterClient(
      definition("ross-ultrix-ogp"),
      { latencyMs: 2 },
    );
    await client.connect();
    const events: MultiLevelRouterClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const revision = client.snapshot().revision;

    await client.setCrosspoint({ source: 5, destination: 2, levels: [2] });
    expect(sourceAt(client, 2, 1)).toBe(2);
    expect(sourceAt(client, 2, 2)).toBe(5);
    expect(sourceAt(client, 2, 3)).toBe(2);
    expect(events).toEqual([
      {
        type: "route",
        crosspoint: { destination: 2, level: 2, source: 5 },
        previousRevision: revision,
        revision: revision + 1,
      },
    ]);

    // All levels at once: level 2 is already there, so only 1 and 3 change.
    events.length = 0;
    await client.setCrosspoint({ source: 5, destination: 2 });
    expect(events).toEqual([
      {
        type: "routes",
        crosspoints: [
          { destination: 2, level: 1, source: 5 },
          { destination: 2, level: 3, source: 5 },
        ],
        previousRevision: revision + 1,
        revision: revision + 2,
      },
    ]);
    await expect(client.readDestination(2, [1, 3])).resolves.toEqual([
      { destination: 2, level: 1, source: 5 },
      { destination: 2, level: 3, source: 5 },
    ]);

    events.length = 0;
    await client.setCrosspoint({ source: 5, destination: 2 });
    expect(events).toEqual([]);
    await expect(
      client.setCrosspoint({ source: 1, destination: 1, levels: [4] }),
    ).rejects.toThrow("level must be an integer from 1 to 3");
  });

  it("locks Quartz destinations and refuses takes to a locked one", async () => {
    const client = createSimulatedMultiLevelClient(
      definition("evertz-quartz"),
      { latencyMs: 0 },
    );
    expect(client).toBeInstanceOf(SimulatedQuartzRouterClient);
    await client.connect();
    const events: MultiLevelRouterClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.setDestinationLock?.(3, true);
    expect(events).toEqual([{ type: "locks" }]);
    expect(client.destinationLocks?.()).toEqual(new Map([[3, 255]]));
    await expect(
      client.setCrosspoint({ source: 1, destination: 3, levels: [1] }),
    ).rejects.toThrow("Quartz rejected the take: destination 3 is locked");
    expect(sourceAt(client, 3, 1)).toBe(3);
    await client.setDestinationLock?.(3, false);
    expect(client.destinationLocks?.()).toEqual(new Map([[3, 0]]));
    await client.setCrosspoint({ source: 1, destination: 3, levels: [1] });
    expect(sourceAt(client, 3, 1)).toBe(1);

    const routes = client.snapshot().routes;
    await client.recallSalvo?.(4);
    expect(client.snapshot().routes).toEqual(routes);
    await expect(client.recallSalvo?.(33)).rejects.toThrow("1 to 32");
  });

  it("gives Ultrix no locks or salvos, as the real client has none", () => {
    const client = createSimulatedMultiLevelClient(
      definition("ross-ultrix-ogp"),
    );
    expect(client.setDestinationLock).toBeUndefined();
    expect(client.destinationLocks).toBeUndefined();
    expect(client.recallSalvo).toBeUndefined();
  });

  it("keeps routes across a reconnect and refuses writes while disconnected", async () => {
    const client = createSimulatedMultiLevelClient(
      definition("ross-ultrix-ogp"),
      { latencyMs: 0 },
    );
    await client.connect();
    await client.setCrosspoint({ source: 6, destination: 1, levels: [1] });
    client.disconnect();
    await expect(
      client.setCrosspoint({ source: 2, destination: 1 }),
    ).rejects.toThrow("Simulated Ultrix is not connected");
    await client.connect();
    expect(sourceAt(client, 1, 1)).toBe(6);
  });
});

describe.each(["ross-ultrix-ogp", "evertz-quartz"] as const)(
  "multi-level manager with a simulated %s",
  (type) => {
    async function connectedManager() {
      const manager = new MultiLevelRouterConnectionManager(type, (value) =>
        createSimulatedMultiLevelClient(value, { latencyMs: 1 }),
      );
      managers.push(manager);
      manager.reconcile([definition(type)]);
      await vi.waitFor(() =>
        expect(manager.snapshots()[0]?.phase).toBe("connected"),
      );
      return manager;
    }

    it("routes per level and resolves the confirmed-route watch", async () => {
      const manager = await connectedManager();
      expect(manager.routeState(connectionId).phase).toBe("ready");
      expect(manager.snapshots()[0]?.sourceCatalog).toHaveLength(6);
      const watched: RouterConfirmedRouteTargetSnapshot[] = [];
      manager.watchConfirmedRouteTarget(
        { connectionId, destination: 4, levels: [1, 2, 3] },
        (value) => watched.push(value),
      );
      await vi.waitFor(() =>
        expect(watched.at(-1)).toMatchObject({
          phase: "ready",
          sourcesByLevel: new Map([
            [1, 4],
            [2, 4],
            [3, 4],
          ]),
        }),
      );

      await manager.directRoute({
        connectionId,
        source: 6,
        destination: 4,
        levels: [2],
      });
      const routes = manager.snapshots()[0]!.routes.routes.get(4);
      expect([...(routes ?? [])]).toEqual([
        [1, 4],
        [2, 6],
        [3, 4],
      ]);
      await vi.waitFor(() =>
        expect(watched.at(-1)).toMatchObject({
          phase: "ready",
          sourcesByLevel: new Map([
            [1, 4],
            [2, 6],
            [3, 4],
          ]),
        }),
      );
      expect(manager.snapshots()[0]?.lastError).toBeNull();
    });

    it("routes through a versioned route request as the Router page does", async () => {
      const manager = await connectedManager();
      const result = await manager.routeCrosspoints({
        operationId: "00000000-0000-4000-8000-0000000000b1",
        connectionId,
        version: manager.routeState(connectionId).version,
        mappings: [
          {
            mappingId: "00000000-0000-4000-8000-0000000000b2",
            source: 1,
            destination: 2,
            levels: [1, 3],
            expected: [
              { level: 1, source: 2 },
              { level: 3, source: 2 },
            ],
          },
        ],
      } as Parameters<typeof manager.routeCrosspoints>[0]);
      expect(result).toMatchObject({ status: "acknowledged" });
      const routes = manager.snapshots()[0]!.routes.routes.get(2);
      expect([...(routes ?? [])]).toEqual([
        [1, 1],
        [2, 2],
        [3, 1],
      ]);
    });
  },
);

it("locks and unlocks a simulated Quartz destination through the manager", async () => {
  const manager = new MultiLevelRouterConnectionManager(
    "evertz-quartz",
    (value) => createSimulatedMultiLevelClient(value, { latencyMs: 0 }),
  );
  managers.push(manager);
  manager.reconcile([definition("evertz-quartz")]);
  await vi.waitFor(() =>
    expect(manager.snapshots()[0]?.phase).toBe("connected"),
  );
  await manager.setDestinationLock(connectionId, 2, true);
  expect(manager.snapshots()[0]?.destinationLocks).toEqual([
    { destination: 2, owner: 255 },
  ]);
  await expect(
    manager.directRoute({ connectionId, source: 1, destination: 2 }),
  ).rejects.toThrow("locked");
  await manager.setDestinationLock(connectionId, 2, false);
  await manager.directRoute({ connectionId, source: 1, destination: 2 });
  expect(manager.snapshots()[0]?.routes.routes.get(2)?.get(1)).toBe(1);
});

it("refuses destination locks on a simulated Ultrix, like a real one", async () => {
  const manager = new MultiLevelRouterConnectionManager(
    "ross-ultrix-ogp",
    (value) => createSimulatedMultiLevelClient(value, { latencyMs: 0 }),
  );
  managers.push(manager);
  manager.reconcile([definition("ross-ultrix-ogp")]);
  await vi.waitFor(() =>
    expect(manager.snapshots()[0]?.phase).toBe("connected"),
  );
  await expect(
    manager.setDestinationLock(connectionId, 2, true),
  ).rejects.toThrow("does not support destination locks");
});
