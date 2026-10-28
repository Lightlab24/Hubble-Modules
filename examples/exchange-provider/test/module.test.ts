import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import type { ModuleExchange, ModuleJsonValue } from "@hubble/module-sdk";
import module from "../src/index.js";

test("query, isolation and cancelled actions leave the inert counter unchanged", async () => {
  const values: ModuleJsonValue[] = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("No peers in provider fixture");
  };
  const modules: ModuleExchange = {
    discover: async () => [],
    bindings: async () => [],
    query: unavailable,
    subscribe: unavailable,
    execute: unavailable,
    reportAction: unavailable,
    publish: async (_id, _version, value) => {
      values.push(value);
    },
  };
  const a = createModuleHarness(module, {}, { modules }),
    b = createModuleHarness(module, {}, { modules });
  await a.instance.start();
  await b.instance.start();
  await a.instance.execute("increment", {}, a.execution());
  const query = { id: "counter", version: 1, input: {} };
  assert.deepEqual(
    await a.instance.queryData!(query, {
      signal: new AbortController().signal,
    }),
    { count: 1 },
  );
  assert.deepEqual(
    await b.instance.queryData!(query, {
      signal: new AbortController().signal,
    }),
    { count: 0 },
  );
  const before = values.length;
  assert.equal(
    (
      await a.instance.execute(
        "increment",
        {},
        a.execution(AbortSignal.abort()),
      )
    ).status,
    "failure",
  );
  assert.equal(values.length, before);
  await a.instance.dispose();
  await b.instance.dispose();
});
