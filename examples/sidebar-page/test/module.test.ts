import { test } from "node:test";
import {
  assertModuleConformance,
  createModuleHarness,
} from "@hubble/module-sdk/testing";
import assert from "node:assert/strict";
import module from "../src/index.js";
test("instance isolation, cancellation, evidence and cleanup", async () => {
  await assertModuleConformance({
    module,
    settings: { initialState: false, title: "Studio", cameras: [] },
    actionId: "set-state",
    fields: { active: true },
  });
});
test("sidebar tables reach the worker as module-owned settings without sending controls", async () => {
  const harness = createModuleHarness(module, {
    initialState: false,
    title: "Studio",
    cameras: [
      {
        id: "camera-b",
        values: { name: "B", enabled: false, cameraNumber: 2, mode: "manual" },
      },
      {
        id: "camera-a",
        values: { name: "A", enabled: true, cameraNumber: 1, mode: "auto" },
      },
    ],
  });
  await harness.instance.start();
  assert.equal(harness.controls.length, 0);
  const values = (harness.states.at(-1) as { values: Record<string, unknown> })
    .values;
  assert.equal(values.active, false);
  assert.equal(values.configured, 2);
  assert.equal(values.enabled, 1);
  assert.deepEqual(
    (values.cameraStatus as { id: string }[]).map((row) => row.id),
    ["camera-b", "camera-a"],
  );
  await harness.instance.dispose();
});
