import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import type {
  ModuleExchange,
  ModuleExchangeNotification,
  ModulePeerBinding,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import module from "../src/module.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const consumer = {
  kind: "connection" as const,
  connectionId: randomUUID(),
  moduleId: "hubble-tally-switch",
};
const tslPeer = {
  kind: "connection" as const,
  connectionId: randomUUID(),
  moduleId: "hubble-tsl",
};
const routerPeer = {
  kind: "connection" as const,
  connectionId: randomUUID(),
  moduleId: "hubble-blackmagic-videohub",
};
const tslBinding: ModulePeerBinding = {
  id: randomUUID(),
  name: "TSL",
  consumer,
  target: tslPeer,
  allowActions: false,
};
const routerBinding: ModulePeerBinding = {
  id: randomUUID(),
  name: "Router",
  consumer,
  target: routerPeer,
  allowActions: true,
};
const describePeer = (
  peer: ModulePeerDescription["peer"],
  overrides: Partial<ModulePeerDescription> = {},
): ModulePeerDescription => ({
  peer,
  name: peer.moduleId,
  available: true,
  actionsAllowed: peer === routerPeer,
  data:
    peer === tslPeer
      ? [{ id: "tally", label: "Tally", version: 1, query: false }]
      : [{ id: "router", label: "Router", version: 1, query: true }],
  actions: [],
  ...overrides,
});
const mappings = [1, 2].map((address) => ({
  id: `camera-${address}`,
  values: {
    name: `Camera ${address}`,
    enabled: true,
    receiver: tslBinding.id,
    screen: 0,
    address,
    indicator: "default",
    router: routerBinding.id,
    source: address,
    destination: 1,
    level: 1,
  },
}));
const onAir = (camera: 1 | 2) => ({
  phase: "listening",
  protocol: "3.1",
  displays: [1, 2].map((address, index) => [
    0,
    address,
    address === camera ? 2 : 0,
    0,
    0,
    0,
    true,
    index + 1,
  ]),
});

async function harness(enabled = true) {
  let peers = [describePeer(tslPeer), describePeer(routerPeer)];
  let bindings = [tslBinding, routerBinding];
  const listeners = new Map<
    string,
    (event: ModuleExchangeNotification) => void | Promise<void>
  >();
  const route = vi.fn(async () => ({
    status: "success" as const,
    evidence: { kind: "submitted" as const, summary: "fixture" },
  }));
  const discover = vi.fn(async () => peers);
  const bindingsCall = vi.fn(async () => bindings);
  const subscribe = vi.fn<ModuleExchange["subscribe"]>(
    async (subscription, listener) => {
      if (subscription.kind !== "data") throw new Error("Unexpected filter");
      listeners.set(subscription.id, listener);
      return async () => {
        listeners.delete(subscription.id);
      };
    },
  );
  const test = createModuleHarness(
    module,
    { enabled, mappings },
    {
      modules: {
        discover,
        bindings: bindingsCall,
        query: async () => null,
        subscribe,
        publish: async () => {},
        execute: route,
        reportAction: async () => {},
      },
    },
  );
  const generation = { tally: randomUUID(), router: randomUUID() };
  const data = async (id: "tally" | "router", value: unknown) =>
    listeners.get(id)?.({
      kind: "data",
      provider: id === "tally" ? tslPeer : routerPeer,
      generation: generation[id],
      observedAt: new Date().toISOString(),
      id,
      version: 1,
      value: value as never,
    });
  const availability = async (id: "tally" | "router", available: boolean) =>
    listeners.get(id)?.({
      kind: "availability",
      provider: id === "tally" ? tslPeer : routerPeer,
      generation: available ? generation[id] : null,
      observedAt: new Date().toISOString(),
      available,
      reason: available ? "ready" : "unavailable",
    });
  const rowStatus = () =>
    (
      test.states.at(-1) as {
        values: {
          mappingStatus: { rows: { values: { status: string } }[] };
        };
      }
    ).values.mappingStatus.rows.map((row) => row.values.status);
  const notice = () =>
    (test.states.at(-1) as { values: { notice: string } }).values.notice;
  return {
    ...test,
    route,
    discover,
    bindingsCall,
    subscribe,
    data,
    availability,
    rowStatus,
    notice,
    setPeers(next: ModulePeerDescription[]) {
      peers = next;
    },
    setBindings(next: ModulePeerBinding[]) {
      bindings = next;
    },
  };
}
/** One poll and whatever it started. */
const tick = () => vi.advanceTimersByTimeAsync(1000);

it("publishes nothing and does not re-evaluate on polls that find nothing new", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  await tick();
  const states = test.states.length;
  const feedback = test.feedback.length;
  test.discover.mockClear();
  test.bindingsCall.mockClear();
  const parse = vi.spyOn(JSON, "parse");
  for (let index = 0; index < 30; index++) await tick();
  expect(test.discover).toHaveBeenCalledTimes(30);
  expect(test.bindingsCall).toHaveBeenCalledTimes(30);
  expect(test.states).toHaveLength(states);
  expect(test.feedback).toHaveLength(feedback);
  expect(test.subscribe).toHaveBeenCalledTimes(2);
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();
  await test.instance.dispose();
});

it("publishes the starting state and feedback exactly once", async () => {
  const test = await harness(false);
  await test.instance.start();
  expect(test.states).toHaveLength(1);
  expect(test.feedback).toEqual([
    { id: "following", state: "inactive", observedAt: expect.any(String) },
  ]);
  await tick();
  expect(test.states).toHaveLength(1);
  expect(test.feedback).toHaveLength(1);
  await test.instance.dispose();
});

it("publishes follow changes as state and feedback, even with no rows", async () => {
  const test = createModuleHarness(
    module,
    { enabled: false, mappings: [] },
    {
      modules: {
        discover: async () => [],
        bindings: async () => [],
        query: async () => null,
        subscribe: async () => async () => {},
        publish: async () => {},
        execute: async () => {
          throw new Error("Unexpected router action");
        },
        reportAction: async () => {},
      },
    },
  );
  await test.instance.start();
  expect(test.states).toHaveLength(1);
  await test.instance.execute("follow", { mode: "follow" }, test.execution());
  expect(test.states).toHaveLength(2);
  expect(test.feedback.at(-1)).toMatchObject({ state: "active" });
  expect(test.feedback).toHaveLength(2);
  await test.instance.execute("follow", { mode: "follow" }, test.execution());
  expect(test.states).toHaveLength(2);
  expect(test.feedback).toHaveLength(2);
  await test.instance.dispose();
});

it("publishes a changed notice as state alone", async () => {
  const test = await harness();
  test.setPeers([]);
  await test.instance.start();
  expect(test.notice()).toContain("Add a TSL receiver");
  const feedback = test.feedback.length;
  test.setPeers([describePeer(tslPeer), describePeer(routerPeer)]);
  await tick();
  expect(test.notice()).toContain("Receiving module data");
  expect(test.feedback).toHaveLength(feedback);
  await test.instance.dispose();
});

it("still routes the next tally change after idle polls, and only once", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  for (let index = 0; index < 5; index++) await tick();
  expect(test.route).not.toHaveBeenCalled();

  await test.data("tally", onAir(2));
  await vi.waitFor(() => expect(test.route).toHaveBeenCalledTimes(1));
  expect(test.route).toHaveBeenCalledWith(
    routerPeer,
    "route",
    { source: 2, destination: 1, level: 1 },
    expect.any(AbortSignal),
  );
  await vi.waitFor(() =>
    expect(test.rowStatus()[1]).toContain("Submitted · source 2"),
  );
  for (let index = 0; index < 5; index++) await tick();
  await test.data("tally", onAir(2));
  expect(test.route).toHaveBeenCalledTimes(1);
  await test.instance.dispose();
});

it("publishes a repeated tally packet only if it changes a row", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  const states = test.states.length;
  await test.data("tally", onAir(1));
  await test.data("tally", onAir(1));
  expect(test.states).toHaveLength(states);
  await test.data("tally", onAir(2));
  await vi.waitFor(() => expect(test.states.length).toBeGreaterThan(states));
  await test.instance.dispose();
});

it("picks up a binding added later on the next poll", async () => {
  const test = await harness();
  test.setBindings([tslBinding]);
  await test.instance.start();
  await test.data("tally", onAir(1));
  expect(test.subscribe).toHaveBeenCalledTimes(1);
  expect(test.rowStatus()[0]).toContain("router unavailable");

  test.setBindings([tslBinding, routerBinding]);
  await tick();
  expect(test.subscribe).toHaveBeenCalledTimes(2);
  await test.data("router", { ready: true });
  expect(test.rowStatus()[0]).toContain("startup tally observed");
  await test.data("tally", onAir(2));
  await vi.waitFor(() => expect(test.route).toHaveBeenCalledTimes(1));
  await test.instance.dispose();
});

it("subscribes to a peer that becomes available on the next poll", async () => {
  const test = await harness();
  test.setPeers([
    describePeer(tslPeer, { available: false }),
    describePeer(routerPeer),
  ]);
  await test.instance.start();
  expect(test.subscribe).toHaveBeenCalledTimes(1);
  test.setPeers([describePeer(tslPeer), describePeer(routerPeer)]);
  await tick();
  expect(test.subscribe).toHaveBeenCalledTimes(2);
  await test.instance.dispose();
});

it("follows a revoked and restored router approval on the next poll, holding the change it missed", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  await tick();
  expect(test.rowStatus()[0]).toContain("startup tally observed");

  test.setBindings([tslBinding, { ...routerBinding, allowActions: false }]);
  await tick();
  expect(test.rowStatus()[0]).toContain("router unavailable");
  await test.data("tally", onAir(2));
  await tick();
  expect(test.route).not.toHaveBeenCalled();

  // Regaining approval starts fresh, as a reconnect does: camera 2 went on air while
  // the router couldn't act, so it is the baseline and only the next change routes.
  test.setBindings([tslBinding, routerBinding]);
  await tick();
  await test.data("tally", onAir(2));
  await tick();
  expect(test.route).not.toHaveBeenCalled();
  await test.data("tally", onAir(1));
  await vi.waitFor(() => expect(test.route).toHaveBeenCalledTimes(1));
  await test.instance.dispose();
});

it("holds when the router goes unavailable with the same peers, then starts afresh", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  await tick();
  expect(test.rowStatus()[0]).toContain("startup tally observed");

  // An overflow notice reports unavailable while the provider stays up, so discovery won't differ.
  await test.availability("router", false);
  expect(test.rowStatus()[0]).toContain("router unavailable");
  await tick();
  expect(test.rowStatus()[0]).toContain("router unavailable");
  await test.data("tally", onAir(2));
  expect(test.route).not.toHaveBeenCalled();

  // The winner while it was away becomes the new baseline, so its return replays nothing.
  await test.data("router", { ready: true });
  await tick();
  expect(test.rowStatus()[1]).toContain("startup tally observed");
  expect(test.route).not.toHaveBeenCalled();
  await test.data("tally", onAir(1));
  await vi.waitFor(() => expect(test.route).toHaveBeenCalledTimes(1));
  await test.instance.dispose();
});

it("reapplies the peer's approval after a router event on the next poll", async () => {
  const test = await harness();
  test.setPeers([
    describePeer(tslPeer),
    describePeer(routerPeer, { actionsAllowed: false }),
  ]);
  await test.instance.start();
  await test.data("tally", onAir(1));
  await test.data("router", { ready: true });
  // The event alone reads only the binding, so this shows the state it left behind.
  expect(test.rowStatus()[0]).toContain("startup tally observed");
  await tick();
  expect(test.rowStatus()[0]).toContain("router unavailable");
  await test.instance.dispose();
});

it("reports a failed poll, holds, and recovers on the next poll with the same peers", async () => {
  const test = await harness();
  await test.instance.start();
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  await tick();

  test.discover.mockRejectedValueOnce(new Error("Host is busy"));
  await tick();
  expect(test.notice()).toBe("Host is busy");
  expect(test.rowStatus()[0]).toContain("every mapped camera");

  await tick();
  expect(test.notice()).toContain("Receiving module data");
  // Providers publish again only when something changes, so the next packet restores the rows.
  await test.data("router", { ready: true });
  await test.data("tally", onAir(1));
  expect(test.rowStatus()[0]).not.toContain("every mapped camera");
  await test.instance.dispose();
});
