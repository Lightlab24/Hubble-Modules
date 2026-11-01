import { ModuleMatrixSchema, type ModuleValues } from "@hubble/module-sdk";
import type { MatrixObservation } from "@hubble/module-runtime-helpers/matrix";
import { z } from "zod";

const commands = [
  "select-camera",
  "record-camera",
  "record-group-all",
  "start-enabled-cameras",
  "stop-enabled-cameras",
] as const;
export const matrix = ModuleMatrixSchema.parse({
  id: "camera-control",
  label: "CyanView RCP",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "cameraNumber",
  inactiveWhen: [
    { field: "actionType", values: ["select-camera", "record-camera"] },
    { field: "cameraNumber", values: [null] },
  ],
  legacy: {
    adapter: "cyanview-rcp",
    connectionType: "cyanview-rcp",
    normalize: true,
  },
  variants: commands.map((command) => ({
    when: [{ field: "column.commandId", values: [command] }],
    fields: { actionType: { default: command } },
  })),
  fields: [
    {
      fill: "copy",
      id: "enabled",
      label: "Enabled",
      type: "boolean",
      default: true,
      width: 88,
    },
    {
      fill: "copy",
      id: "actionType",
      label: "Action",
      type: "choice",
      default: "select-camera",
      width: 240,
      choices: [
        { value: "select-camera", label: "Select camera" },
        { value: "record-camera", label: "Record camera" },
        { value: "record-group-all", label: "Record Group ALL" },
        { value: "start-enabled-cameras", label: "Start enabled cameras" },
        { value: "stop-enabled-cameras", label: "Stop enabled cameras" },
      ],
    },
    {
      fill: "series",
      id: "cameraNumber",
      label: "Camera Number",
      type: "number",
      default: null,
      required: false,
      min: 1,
      max: 999999,
      integer: true,
      formula: true,
      enabledWhen: [
        { field: "actionType", values: ["select-camera", "record-camera"] },
      ],
    },
    {
      fill: "copy",
      id: "drivesTally",
      label: "Feedback",
      type: "boolean",
      default: false,
      width: 112,
      enabledWhen: [{ field: "actionType", values: ["select-camera"] }],
    },
    {
      fill: "copy",
      id: "feedbackColor",
      label: "Feedback Color",
      type: "color",
      default: "#37A65B",
      width: 148,
      enabledWhen: [
        { field: "actionType", values: ["select-camera"] },
        { field: "drivesTally", values: [true] },
      ],
    },
  ],
});
export function matrixAction(fields: ModuleValues) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const command = z.enum(commands).parse(values.actionType);
  const specific: ModuleValues =
    command === "select-camera" || command === "record-camera"
      ? { cameraNumber: z.int().min(1).max(999999).parse(values.cameraNumber) }
      : {};
  return {
    id: `cyanview-rcp.${command}`,
    fields: {
      ...specific,
      ...(command === "select-camera"
        ? {
            drivesTally: values.drivesTally === true,
            feedbackColor: values.feedbackColor || "#37A65B",
          }
        : {}),
    },
  };
}
export function matrixFeedback({ state, data, fields }: MatrixObservation) {
  const values = (fields.values ?? {}) as ModuleValues;
  const snapshot = (
    data.get("driver.snapshots") as
      | { phase: string; activeCameraNumber: number | null }[]
      | undefined
  )?.[0];
  const observing =
    values.enabled !== false &&
    values.actionType === "select-camera" &&
    values.drivesTally === true;
  if (!observing)
    return {
      state: "inactive" as const,
      observedAt: new Date().toISOString(),
      appearance: { backgroundColor: null },
    };
  const unknown =
    !state?.observedAt ||
    state.phase !== "ready" ||
    snapshot?.phase !== "ready" ||
    snapshot.activeCameraNumber === null;
  const active =
    observing &&
    !unknown &&
    snapshot?.activeCameraNumber === values.cameraNumber;
  return {
    state: unknown
      ? ("unavailable" as const)
      : active
        ? ("active" as const)
        : ("inactive" as const),
    observedAt: unknown ? null : (state?.observedAt ?? null),
    appearance: {
      backgroundColor:
        active && typeof values.feedbackColor === "string"
          ? values.feedbackColor
          : null,
    },
  };
}
