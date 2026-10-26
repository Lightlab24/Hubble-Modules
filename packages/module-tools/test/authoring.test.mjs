import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../module-sdk/dist/authoring.js";
const actions = [
  {
    id: "take",
    label: "Take",
    description: "Confirmed take",
    fields: [],
    completion: "state-confirmed",
    timeoutMs: 1000,
  },
];
const execution = {
  signal: new AbortController().signal,
  executionId: "test",
  gesture: "press",
  wrap: false,
  log() {},
};
test("action registry rejects missing and undeclared handlers", () => {
  assert.throws(() => createActionRegistry(actions, {}), /identical/);
  assert.throws(
    () => createActionRegistry(actions, { take() {}, hidden() {} }),
    /identical/,
  );
});
test("action registry rejects false completion evidence and cancels before dispatch", async () => {
  let called = false;
  const registry = createActionRegistry(actions, {
    take() {
      called = true;
      return {
        status: "success",
        evidence: { kind: "submitted", summary: "Socket write" },
      };
    },
  });
  assert.equal(
    (
      await registry.execute(
        "take",
        {},
        { ...execution, signal: AbortSignal.abort() },
      )
    ).category,
    "cancelled",
  );
  assert.equal(called, false);
  await assert.rejects(
    registry.execute("take", {}, execution),
    /completion evidence/,
  );
});
