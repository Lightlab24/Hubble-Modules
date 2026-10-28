import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertModuleConformance,
  createModuleHarness,
  assertSavedActionMigration,
} from "@hubble/module-sdk/testing";
import module from "../src/index.js";
test("isolated instances and cancellation without hardware", async () => {
  await assertModuleConformance({
    module,
    actionId: "set-active",
    fields: { active: true },
  });
});
test("draft-sensitive read-only search, pagination and pure migration", async () => {
  const harness = createModuleHarness(module, { region: "studio" });
  await harness.instance.start();
  const query = {
    version: 2 as const,
    provider: "sources",
    draft: { region: "stage" },
    search: "source",
    cursor: null,
    limit: 2,
    requestRevision: 1,
  };
  const first = await harness.instance.discoverChoices!(query, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    first.choices.map(({ id }) => id),
    ["stage-1", "stage-2"],
  );
  const next = await harness.instance.discoverChoices!(
    { ...query, cursor: first.nextCursor, catalogRevision: first.revision },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(
    next.choices.map(({ id }) => id),
    ["stage-3", "stage-4"],
  );
  assert.deepEqual(harness.context.settings, { region: "studio" });
  assert.equal(harness.controls.length, 0);
  await harness.instance.dispose();
  const before = [
    {
      key: "stable-binding",
      actionId: { mode: "literal" as const, source: "set-state" },
      actionFields: { mode: "formula" as const, source: "=A1" },
      feedback: {
        mode: "literal" as const,
        source: '{"id":"active","fields":{}}',
      },
    },
  ];
  const migrated = await assertSavedActionMigration(module, before, 1, 2);
  assert.equal(migrated.after[0]?.actionId.source, "set-active");
  assert.deepEqual(migrated.after[0]?.actionFields, before[0]?.actionFields);
  assert.equal(before[0]?.actionId.source, "set-state");
});
