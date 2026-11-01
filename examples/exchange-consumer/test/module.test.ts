import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import type {
  ModuleExchange,
  ModuleExchangeNotification,
  ModulePeer,
} from "@hubble/module-sdk";
import module from "../src/index.js";

test("uses the routed API, handles denial and unavailable peers, and releases its subscription", async () => {
  const target: ModulePeer = {
    kind: "connection",
    moduleId: "example-exchange-provider",
    connectionId: "11111111-1111-4111-8111-111111111111",
  };
  let listener:
      | ((event: ModuleExchangeNotification) => void | Promise<void>)
      | undefined,
    approved = false,
    closed = 0;
  const actions: string[] = [];
  const modules: ModuleExchange = {
    discover: async () => [],
    bindings: async () => [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Counter",
        consumer: { ...target, moduleId: "example-exchange-consumer" },
        target,
        allowActions: approved,
      },
    ],
    query: async () => ({ count: 7 }),
    publish: async () => {},
    reportAction: async () => {},
    subscribe: async (_filter, callback) => {
      listener = callback;
      return async () => {
        closed++;
      };
    },
    execute: async (_target, id) => {
      if (!approved) throw new Error("Approval required");
      actions.push(id);
      return {
        status: "success",
        evidence: { kind: "local", summary: "Inert fixture" },
      };
    },
  };
  const harness = createModuleHarness(module, { autoReset: true }, { modules });
  await harness.instance.start();
  await harness.instance.execute("refresh", {}, harness.execution());
  assert.deepEqual(actions, []);
  const data: ModuleExchangeNotification = {
    kind: "data",
    provider: target,
    generation: "33333333-3333-4333-8333-333333333333",
    observedAt: new Date().toISOString(),
    id: "counter",
    version: 1,
    value: { count: 11 },
  };
  await listener!(data);
  assert.deepEqual(actions, []);
  assert.equal(harness.traces.length, 1);
  approved = true;
  await listener!(data);
  assert.deepEqual(actions, ["reset"]);
  await listener!({
    kind: "availability",
    provider: target,
    generation: null,
    observedAt: new Date().toISOString(),
    available: false,
    reason: "unavailable",
  });
  assert.equal(
    (harness.states.at(-1) as { phase: string }).phase,
    "unavailable",
  );
  await harness.instance.dispose();
  assert.equal(closed, 1);
});
