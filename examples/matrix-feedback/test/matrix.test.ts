import assert from "node:assert/strict";
import { it, mock } from "node:test";
import {
  ModuleMatrixSchema,
  resolveModuleMatrixField,
  type ModuleContext,
} from "@hubble/module-sdk";
import manifest from "../src/manifest.js";
import module from "../src/index.js";
it("declares action-dependent fill through the public API in an unrelated package", () => {
  const level = ModuleMatrixSchema.parse(manifest.matrix).fields.find(
    (field) => field.id === "module.level",
  )!;
  assert.equal(
    resolveModuleMatrixField(level, {
      actionType: "observe;colors=#123456|#654321",
    }).fill,
    "copy",
  );
  assert.equal(
    resolveModuleMatrixField(level, { actionType: "level-series" }).fill,
    "series",
  );
  assert.ok(
    manifest.host.requiredFeatures.includes("module-matrix-fill-rules-v1"),
  );
});
it("drives generic cell, background and glow presentation without Tally or a host call", () => {
  const publishFeedback = mock.fn(),
    requestHost = mock.fn();
  const instance = module.createInstance({
    publishFeedback,
    requestHost,
  } as unknown as ModuleContext);
  instance.subscribeFeedback([
    {
      id: "level",
      fields: {
        actionId: "stable-row",
        actionColumnId: "stable-column",
        values: {
          enabled: true,
          "module.level": 75,
          actionType: "observe;colors=#123456|#654321;pulse=on",
        },
        settings: { threshold: 60 },
      },
    },
  ]);
  assert.partialDeepStrictEqual(publishFeedback.mock.calls, [
    {
      arguments: [
        {
          state: "active",
          appearance: {
            backgroundColor: "#123456",
            glow: { color: "#FFFFFF", cycleMs: 1500 },
            cells: {
              "module.level": { label: "75%", inputSource: "75", color: null },
            },
          },
        },
      ],
    },
  ]);
  assert.equal(requestHost.mock.callCount(), 0);
});
