import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ModuleExchange,
  ModuleExchangeNotification,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import type { CccController } from "../src/ccc-controller.js";
import { observeRcpPeers } from "../src/rcp-peers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const definition = (connectionId: string, name = "RCP", host = "127.0.0.1") => ({
  type: "cyanview-rcp" as const,
  connectionId,
  name,
  host,
  port: 1883,
  enabled: true,
  schemaVersion: 1 as const,
  requestTimeoutMs: 3000,
});
const describePeer = (connectionId: string): ModulePeerDescription => ({
  peer: { kind: "connection", connectionId, moduleId: "hubble-cyanview-rcp" },
  name: "RCP",
  available: true,
  actionsAllowed: false,
  data: [],
  actions: [],
});

function harness() {
  const peers = new Map<string, ModulePeerDescription>();
  const listeners = new Map<
    string,
    (event: ModuleExchangeNotification) => void | Promise<void>
  >();
  const closed: string[] = [];
  const subscribe = vi.fn<ModuleExchange["subscribe"]>(
    async (subscription, listener) => {
      if (subscription.target.kind !== "connection")
        throw new Error("Unexpected peer");
      const { connectionId } = subscription.target;
      listeners.set(connectionId, listener);
      return async () => {
        closed.push(connectionId);
      };
    },
  );
  const discover = vi.fn(async () => [
    // CCC follows CyanView RCP connections and nothing else it can see.
    {
      ...describePeer(randomUUID()),
      peer: {
        kind: "connection" as const,
        connectionId: "00000000-0000-4000-8000-000000000000",
        moduleId: "hubble-tsl",
      },
    },
    ...peers.values(),
  ]);
  const modules: ModuleExchange = {
    discover,
    bindings: async () => [],
    query: async () => null,
    publish: async () => {},
    reportAction: async () => {},
    subscribe,
    execute: async () => {
      throw new Error("Unexpected peer action");
    },
  };
  const configureConsumers = vi.fn();
  const observed = observeRcpPeers(modules, {
    configureConsumers,
  } as unknown as CccController);
  const publish = async (connectionId: string, value: unknown) =>
    listeners.get(connectionId)?.({
      kind: "data",
      provider: describePeer(connectionId).peer,
      generation: randomUUID(),
      observedAt: new Date().toISOString(),
      id: "connection",
      version: 1,
      value: value as never,
    });
  const availability = async (connectionId: string, available: boolean) =>
    listeners.get(connectionId)?.({
      kind: "availability",
      provider: describePeer(connectionId).peer,
      generation: available ? randomUUID() : null,
      observedAt: new Date().toISOString(),
      available,
      reason: available ? "ready" : "unavailable",
    });
  const applied = () => configureConsumers.mock.lastCall?.[0];
  return {
    peers,
    observed,
    discover,
    subscribe,
    configureConsumers,
    publish,
    availability,
    applied,
    closed,
  };
}

/** One poll and whatever it started. */
const tick = () => vi.advanceTimersByTimeAsync(1000);

it("leaves the controller alone on polls that find the same peers", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  await test.observed.start();
  await test.publish(id, definition(id));
  expect(test.applied()).toEqual([definition(id)]);
  test.configureConsumers.mockClear();
  test.discover.mockClear();
  test.subscribe.mockClear();
  for (let index = 0; index < 30; index++) await tick();
  expect(test.discover).toHaveBeenCalledTimes(30);
  expect(test.configureConsumers).not.toHaveBeenCalled();
  expect(test.subscribe).not.toHaveBeenCalled();
  await test.observed.stop();
});

it("configures an empty consumer list once when there are no peers", async () => {
  const test = harness();
  await test.observed.start();
  for (let index = 0; index < 5; index++) await tick();
  expect(test.configureConsumers).toHaveBeenCalledTimes(1);
  expect(test.configureConsumers).toHaveBeenCalledWith([], true);
  await test.observed.stop();
});

it("adopts a new peer on the next poll and offers it as a choice", async () => {
  const test = harness();
  const first = randomUUID();
  test.peers.set(first, describePeer(first));
  await test.observed.start();
  await test.publish(first, definition(first, "First"));
  await tick();
  test.configureConsumers.mockClear();

  const second = randomUUID();
  test.peers.set(second, describePeer(second));
  await tick();
  expect(test.subscribe).toHaveBeenCalledTimes(2);
  await test.publish(second, definition(second, "Second", "127.0.0.2"));
  expect(test.configureConsumers).toHaveBeenCalledTimes(1);
  expect(test.applied()).toEqual([
    definition(first, "First"),
    definition(second, "Second", "127.0.0.2"),
  ]);
  expect(test.observed.choices()).toEqual([
    { id: first, label: "First" },
    { id: second, label: "Second" },
  ]);
  await test.observed.stop();
});

it("reconfigures when a peer's definition really changes, not when it repeats", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  await test.observed.start();
  await test.publish(id, definition(id));
  test.configureConsumers.mockClear();

  await test.publish(id, definition(id));
  await test.publish(id, definition(id));
  expect(test.configureConsumers).not.toHaveBeenCalled();

  await test.publish(id, definition(id, "Renamed", "127.0.0.3"));
  expect(test.configureConsumers).toHaveBeenCalledTimes(1);
  expect(test.applied()).toEqual([definition(id, "Renamed", "127.0.0.3")]);
  await test.observed.stop();
});

it("drops a peer that becomes unavailable, then takes it back when it returns", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  await test.observed.start();
  await test.publish(id, definition(id));

  await test.availability(id, false);
  expect(test.applied()).toEqual([]);
  expect(test.observed.choices()).toEqual([]);
  await tick();
  expect(test.applied()).toEqual([]);

  await test.availability(id, true);
  await test.publish(id, definition(id));
  expect(test.applied()).toEqual([definition(id)]);
  await test.observed.stop();
});

it("closes and forgets a peer that leaves the workspace", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  await test.observed.start();
  await test.publish(id, definition(id));

  test.peers.delete(id);
  await tick();
  expect(test.closed).toEqual([id]);
  expect(test.applied()).toEqual([]);
  expect(test.observed.choices()).toEqual([]);
  await test.observed.stop();
});

it("subscribes again on a later poll after a subscription fails", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  test.subscribe.mockRejectedValueOnce(new Error("Provider is starting"));
  await test.observed.start();
  expect(test.subscribe).toHaveBeenCalledTimes(1);
  await tick();
  expect(test.subscribe).toHaveBeenCalledTimes(2);
  await test.publish(id, definition(id));
  expect(test.applied()).toEqual([definition(id)]);
  await test.observed.stop();
});

it("keeps polling after discovery fails", async () => {
  const test = harness();
  const id = randomUUID();
  await test.observed.start();
  test.discover.mockRejectedValueOnce(new Error("Host is busy"));
  await tick();
  test.peers.set(id, describePeer(id));
  await tick();
  await test.publish(id, definition(id));
  expect(test.applied()).toEqual([definition(id)]);
  await test.observed.stop();
});

it("tries again if the controller could not adopt the consumers", async () => {
  const test = harness();
  const id = randomUUID();
  test.peers.set(id, describePeer(id));
  await test.observed.start();
  test.configureConsumers.mockImplementationOnce(() => {
    throw new Error("Could not start the session");
  });
  await expect(test.publish(id, definition(id))).rejects.toThrow(
    "Could not start the session",
  );
  test.configureConsumers.mockClear();
  await tick();
  expect(test.configureConsumers).toHaveBeenCalledTimes(1);
  expect(test.applied()).toEqual([definition(id)]);
  await test.observed.stop();
});
