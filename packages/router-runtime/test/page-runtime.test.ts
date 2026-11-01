import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { RouterPageRuntime } from "../src/page-runtime.js";
import { RossSwp08RoutingState } from "../src/routing-state.js";
import {
  RouterSessionBootstrapSchema,
  RouterResourcePageSchema,
  RouteCrosspointsResultSchema,
  RouteCrosspointsRequestSchema,
} from "../src/page-contract.js";
import type {
  RouterConnectionManagerContract,
  ManagedRouterConnectionSnapshot,
} from "../src/connection-contract.js";
import { createRouterPageApi } from "../src/frontend/page-client.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});
function fixture(count = 8, levels = 2) {
  const connectionId = randomUUID(),
    state = new RossSwp08RoutingState();
  state.replaceCatalogs({
    revision: 1,
    sources: Array.from({ length: count }, (_, index) => ({
      address: index + 1,
      label: `Source ${index + 1}`,
    })),
    destinations: Array.from({ length: count }, (_, index) => ({
      address: index + 1,
      label: `Destination ${index + 1}`,
    })),
  });
  state.replaceRoutes({
    clientRevision: 1,
    crosspoints: Array.from({ length: count }, (_, index) =>
      Array.from({ length: levels }, (_, level) => ({
        matrix: 1,
        destination: index + 1,
        level: level + 1,
        source: 1,
      })),
    ).flat(),
  });
  state.markReady();
  state.markLabelsReady();
  const snapshot = {
    definition: {
      connectionId,
      type: "ross-ultrix-ogp",
      name: "Test router",
      enabled: true,
      schemaVersion: 1,
      host: "127.0.0.1",
      port: 5254,
      sourceLimit: count,
      destinationLimit: count,
      levels,
      requestTimeoutMs: 1000,
      reconnectDelayMs: 2000,
      password: "NEVER_TO_FRONTEND",
      moduleBinding: { settings: { secret: "NEVER_TO_FRONTEND" } },
    },
    phase: "connected",
    routeTransport: "connected",
    selectedSource: null,
    selectedDestination: null,
    routes: { revision: 1, routes: new Map() },
    sourceCatalog: [],
    destinationCatalog: [],
    lastError: null,
  } as unknown as ManagedRouterConnectionSnapshot;
  const manager = {
    snapshots: () => [snapshot],
    routeState: () => state.snapshot(),
    subscribeRouteState: (
      _id: string,
      listener: Parameters<typeof state.subscribe>[0],
    ) => state.subscribe(listener),
    subscribe: () => () => {},
    queryRouteSources: (
      _id: string,
      query: Parameters<typeof state.sourcePage>[0],
    ) => state.sourcePage(query),
    queryRouteDestinations: (
      _id: string,
      query: Parameters<typeof state.destinationPage>[0],
    ) => state.destinationPage(query),
    routeCrosspoints: vi.fn(async (request: { operationId: string }) => ({
      status: "rejected",
      operationId: request.operationId,
      code: "target_conflict",
    })),
    interrogateRouteTargets: vi.fn(),
    refreshNames: vi.fn(),
  } as unknown as RouterConnectionManagerContract;
  const runtime = new RouterPageRuntime(manager, connectionId);
  runtime.start();
  cleanup.push(() => runtime.stop());
  const signal = new AbortController().signal;
  const open = async () => {
    const result = (await runtime.call("open", null, signal)) as {
      bootstrap: unknown;
    };
    return RouterSessionBootstrapSchema.parse(result.bootstrap);
  };
  return { runtime, state, manager, connectionId, signal, open };
}

it("boots and pages a 256-level router within the public bridge limit without leaking settings or issuing commands", async () => {
  const f = fixture(300, 256),
    boot = await f.open();
  const raw = await f.runtime.call("open", null, f.signal);
  expect(JSON.stringify(raw).length).toBeLessThan(196608);
  expect(JSON.stringify(raw)).not.toContain("NEVER_TO_FRONTEND");
  expect(boot.destinations.entries).toHaveLength(8);
  expect(boot.destinations.nextAfterAddress).toBe(8);
  const page = RouterResourcePageSchema.parse(
    await f.runtime.call(
      "resources",
      {
        resource: "destinations",
        connectionId: f.connectionId,
        version: boot.version,
        labelRevision: boot.labelRevision,
        afterAddress: 8,
        limit: 2048,
        search: null,
        source: null,
        levels: [],
      },
      f.signal,
    ),
  );
  expect(page.entries[0]?.address).toBe(9);
  expect(page.totalCount).toBe(300);
  expect(f.manager.routeCrosspoints).not.toHaveBeenCalled();
  expect(f.manager.interrogateRouteTargets).not.toHaveBeenCalled();
});

it("delivers sequenced feedback, acknowledges it, preserves another page, and cancels pending polls", async () => {
  const f = fixture(),
    first = await f.open(),
    second = await f.open();
  const abort = new AbortController();
  const waiting = f.runtime.call(
    "poll",
    { sessionId: first.listenerId, afterSequence: first.lastEventSequence },
    abort.signal,
  );
  f.state.observe({ matrix: 1, destination: 1, level: 1, source: 1 });
  const next = (await waiting) as {
    events: { sequence: number; event: { type: string } }[];
  };
  expect(next.events).toHaveLength(1);
  expect(next.events[0]?.event.type).toBe("observation");
  const pending = f.runtime.call(
    "poll",
    { sessionId: first.listenerId, afterSequence: next.events[0]!.sequence },
    abort.signal,
  );
  abort.abort(new Error("Page closed"));
  await expect(pending).rejects.toThrow("Page closed");
  const other = (await f.runtime.call(
    "poll",
    { sessionId: second.listenerId, afterSequence: second.lastEventSequence },
    f.signal,
  )) as { events: unknown[] };
  expect(other.events).toHaveLength(1);
  await f.runtime.call("close", first.listenerId, f.signal);
  await expect(
    f.runtime.call(
      "poll",
      { sessionId: first.listenerId, afterSequence: 0 },
      f.signal,
    ),
  ).rejects.toThrow("unavailable");
});

it("restarts an overflowed stream, bounds sessions, and rejects foreign commands before dispatch", async () => {
  const f = fixture(),
    boot = await f.open();
  for (let index = 0; index < 130; index++)
    f.state.observe({ matrix: 1, destination: 1, level: 1, source: 1 });
  const reply = (await f.runtime.call(
    "poll",
    { sessionId: boot.listenerId, afterSequence: boot.lastEventSequence },
    f.signal,
  )) as { events: { event: { type: string } }[] };
  expect(reply.events[0]?.event.type).toBe("resync_required");
  for (let index = 1; index < 8; index++) await f.open();
  await expect(f.open()).rejects.toThrow("Close an unused");
  const request = {
    operationId: randomUUID(),
    connectionId: f.connectionId,
    version: boot.version,
    mappings: [
      {
        mappingId: randomUUID(),
        source: 2,
        destination: 1,
        levels: [1],
        expected: [{ level: 1, source: 1 }],
      },
    ],
  };
  await expect(
    f.runtime.call(
      "route",
      { ...request, connectionId: randomUUID() },
      f.signal,
    ),
  ).rejects.toThrow("scope changed");
  expect(f.manager.routeCrosspoints).not.toHaveBeenCalled();
  expect(
    RouteCrosspointsResultSchema.parse(
      await f.runtime.call("route", request, f.signal),
    ),
  ).toMatchObject({
    status: "rejected",
    code: "target_conflict",
    message: expect.any(String),
  });
});

it("pages all 4096 command outcomes across bounded bridge replies without repeating device commands", async () => {
  const f = fixture(16, 256),
    boot = await f.open();
  const mappings = Array.from({ length: 16 }, (_, index) => ({
    mappingId: randomUUID(),
    source: 2,
    destination: index + 1,
    levels: Array.from({ length: 256 }, (_, level) => level + 1),
    expected: Array.from({ length: 256 }, (_, level) => ({
      level: level + 1,
      source: 1,
    })),
  }));
  vi.mocked(f.manager.routeCrosspoints).mockImplementation(async (request) => ({
    status: "acknowledged",
    operationId: request.operationId,
    outcomes: request.mappings.flatMap((mapping) =>
      mapping.levels.map((level) => ({
        mappingId: mapping.mappingId,
        source: mapping.source,
        destination: mapping.destination,
        level,
        outcome: "acknowledged" as const,
      })),
    ),
  }));
  const sizes: number[] = [];
  const client = createRouterPageApi(
    {
      call: async (command, input) => {
        const result = await f.runtime.call(command, input ?? null, f.signal);
        sizes.push(JSON.stringify(result).length);
        return JSON.parse(JSON.stringify(result));
      },
    },
    () => {},
  );
  const result = await client.routeCrosspoints(
    RouteCrosspointsRequestSchema.parse({
      operationId: randomUUID(),
      connectionId: f.connectionId,
      version: boot.version,
      mappings,
    }),
  );
  expect(result.status).toBe("acknowledged");
  if (result.status === "acknowledged")
    expect(result.outcomes).toHaveLength(4096);
  expect(sizes.length).toBeGreaterThan(2);
  expect(Math.max(...sizes)).toBeLessThan(262144);
  expect(f.manager.routeCrosspoints).toHaveBeenCalledTimes(1);
});
