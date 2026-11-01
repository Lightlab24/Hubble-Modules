import assert from "node:assert/strict";
import { it, mock } from "node:test";
import type { ModuleContext, ModuleSavedActions } from "@hubble/module-sdk";
import module from "../src/index.js";
it("changes row limits and colour decisions through module declarations without host calls", async () => {
  const publishState = mock.fn();
  const publishFeedback = mock.fn();
  const requestHost = mock.fn();
  const context: ModuleContext = {
    connectionEnabled: true,
    instanceId: "example",
    scope: {
      kind: "connection",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    },
    settings: {},
    publishState,
    publishFeedback,
    log: mock.fn(),
    requestHost,
  };
  const instance = module.createInstance(context);
  const execution = {
    executionId: "example",
    signal: new AbortController().signal,
    gesture: "press" as const,
    wrap: false,
    log() {},
  };
  const values = {
    actionType: "count",
    "module.value": 75,
    "module.colors": "#123456 | #654321",
  };
  assert.partialDeepStrictEqual(
    await instance.execute("apply", { values }, execution),
    {
      status: "failure",
      category: "invalid-config",
    },
  );
  assert.equal(publishState.mock.callCount(), 0);
  assert.partialDeepStrictEqual(
    await instance.execute(
      "apply",
      { values: { ...values, actionType: "percent" } },
      execution,
    ),
    { status: "success" },
  );
  instance.subscribeFeedback([
    { id: "level", fields: { values: { ...values, actionType: "percent" } } },
  ]);
  assert.partialDeepStrictEqual(publishFeedback.mock.calls.at(-1)?.arguments, [
    { state: "active", appearance: { backgroundColor: "#654321" } },
  ]);
  assert.equal(requestHost.mock.callCount(), 0);
});
it("adds a source default while retaining formulas and unknown saved fields", () => {
  const items: ModuleSavedActions = [
    {
      key: "stable-row",
      actionId: { mode: "literal", source: "apply" },
      actionFields: { mode: "literal", source: "{}" },
      feedback: { mode: "literal", source: "" },
      matrix: {
        id: "counter",
        fields: {
          "module.value": { mode: "formula", source: "=A2" },
          "module.old": { mode: "literal", source: "retained" },
        },
      },
    },
  ];
  const migrated = module.migrateSavedActions(items, 1, 2);
  assert.deepEqual(migrated[0]?.matrix?.fields, {
    ...items[0]?.matrix?.fields,
    "module.colors": { mode: "literal", source: "#333333 | #16A34A" },
  });
  assert.equal(items[0]?.matrix?.fields["module.colors"], undefined);
});
