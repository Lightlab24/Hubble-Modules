import { expect, it } from "vitest";
import {
  ModuleFeedbackSchema,
  ModuleMatrixSchema,
  type HubbleModule,
} from "@hubble/module-sdk";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import { withModuleMatrix, type MatrixObservation } from "../src/matrix.js";
import { matrixFeedback as ccc } from "../../../modules/ccc/src/matrix.js";
import { matrixFeedback as rcp } from "../../../modules/cyanview-rcp/src/matrix.js";
import { matrixFeedback as dit } from "../../../modules/dit-browse/src/matrix.js";
import { matrixFeedback as lightencode } from "../../../modules/lightencode/src/matrix.js";

const base: HubbleModule = {
  createInstance: () => ({
    start() {},
    dispose() {},
    execute: async () => ({
      status: "success",
      evidence: { kind: "local", summary: "Fixture only" },
    }),
  }),
};
const descriptor = ModuleMatrixSchema.parse({
  id: "matrix",
  label: "Matrix",
  primaryField: "enabled",
  actionId: "matrix",
  feedbackId: "matrix",
  fields: [{ id: "enabled", label: "Enabled", type: "boolean", default: true }],
});
const mapAction = () => ({ id: "send", fields: {} });
it("validates local inactive feedback before the worker boundary", async () => {
  const harness = createModuleHarness(
    withModuleMatrix(base, descriptor, mapAction),
  );
  try {
    await harness.instance.subscribeFeedback!([{ id: "matrix", fields: {} }], {
      signal: harness.execution().signal,
    });
    expect(harness.feedback).toEqual([
      expect.objectContaining({
        state: "inactive",
        observedAt: expect.any(String),
      }),
    ]);
  } finally {
    await harness.instance.dispose();
  }
});

it("clears a malformed row observation while preserving valid feedback for other rows", async () => {
  const harness = createModuleHarness(
    withModuleMatrix(base, descriptor, mapAction, ({ fields }) =>
      fields.row === "bad"
        ? {
            state: "active",
            observedAt: null,
            appearance: { backgroundColor: "#ff0000" },
          }
        : {
            state: "active",
            observedAt: "2026-10-31T10:00:00.000Z",
            appearance: { backgroundColor: "#00ff00" },
          },
    ),
  );
  try {
    await harness.instance.subscribeFeedback!(
      ["bad", "good"].map((row) => ({ id: "matrix", fields: { row } })),
      { signal: harness.execution().signal },
    );
    expect(harness.feedback).toEqual([
      {
        id: "matrix",
        fields: { row: "bad" },
        state: "unavailable",
        observedAt: null,
        appearance: { backgroundColor: null, glow: null, cells: {} },
      },
      {
        id: "matrix",
        fields: { row: "good" },
        state: "active",
        observedAt: "2026-10-31T10:00:00.000Z",
        appearance: { backgroundColor: "#00ff00" },
      },
    ]);
  } finally {
    await harness.instance.dispose();
  }
});

it.each([
  ["CCC", ccc, { actionType: "enable-all-cameras", drivesTally: true }],
  [
    "CyanView RCP",
    rcp,
    { actionType: "select-camera", drivesTally: true, cameraNumber: 1 },
  ],
  [
    "DIT Browse",
    dit,
    { actionType: "focus-camera", feedback: true, actionValue: 1 },
  ],
  [
    "Lightencode",
    lightencode,
    { actionType: "record-toggle-all", feedback: true },
  ],
] as const)(
  "%s distinguishes local inactive rows from missing device observations",
  (_label, observe, values) => {
    const input: MatrixObservation = {
      state: undefined,
      data: new Map(),
      events: new Map(),
      feedback: new Map(),
      settings: {},
      fields: { values: { ...values, enabled: false } },
    };
    const inactive = ModuleFeedbackSchema.parse({
      id: "matrix",
      ...observe(input),
    });
    expect(inactive).toMatchObject({
      state: "inactive",
      observedAt: expect.any(String),
    });
    const unknown = ModuleFeedbackSchema.parse({
      id: "matrix",
      ...observe({
        ...input,
        fields: { values: { ...values, enabled: true } },
      }),
    });
    expect(unknown).toMatchObject({
      state: "unavailable",
      observedAt: null,
      appearance: { backgroundColor: null },
    });
  },
);
