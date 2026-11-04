import test from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";

test("page commands are local, scoped to their instance and honor cancellation", async () => {
  const first = createModuleHarness(module);
  const second = createModuleHarness(module);
  await first.instance.start();
  await second.instance.start();
  try {
    assert.deepEqual(
      await first.instance.call!(
        "page.dashboard",
        { commandId: "increment" },
        first.execution(),
      ),
      { count: 1, message: "Reply: 1" },
    );
    assert.deepEqual(
      await second.instance.call!(
        "page.dashboard",
        { commandId: "increment" },
        second.execution(),
      ),
      { count: 1, message: "Reply: 1" },
    );
    const cancelled = new AbortController();
    cancelled.abort();
    assert.throws(() =>
      first.instance.call!(
        "page.dashboard",
        { commandId: "increment" },
        first.execution(cancelled.signal),
      ),
    );
    assert.equal(first.controls.length, 0);
    assert.equal(second.controls.length, 0);
  } finally {
    await first.instance.dispose();
    await first.instance.dispose();
    await second.instance.dispose();
  }
});
