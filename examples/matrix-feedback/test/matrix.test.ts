import { expect, it, vi } from "vitest";
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
  expect(
    resolveModuleMatrixField(level, {
      actionType: "observe;colors=#123456|#654321",
    }).fill,
  ).toBe("copy");
  expect(
    resolveModuleMatrixField(level, { actionType: "level-series" }).fill,
  ).toBe("series");
  expect(manifest.host).toMatchObject({
    requiredFeatures: expect.arrayContaining(["module-matrix-fill-rules-v1"]),
  });
});

it("drives generic cell, background and glow presentation without Tally or a host call", () => {
  const publishFeedback = vi.fn(),
    requestHost = vi.fn();
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
  expect(publishFeedback).toHaveBeenCalledWith(
    expect.objectContaining({
      state: "active",
      appearance: {
        backgroundColor: "#123456",
        glow: { color: "#FFFFFF", cycleMs: 1500 },
        cells: {
          "module.level": { label: "75%", inputSource: "75", color: null },
        },
      },
    }),
  );
  expect(requestHost).not.toHaveBeenCalled();
});
