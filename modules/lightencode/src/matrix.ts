import { ModuleMatrixSchema, type ModuleValues } from "@hubble/module-sdk";
import type { MatrixObservation } from "@hubble/module-runtime-helpers/matrix";
import { z } from "zod";
import {
  LightEncodeSlotNumberSchema,
  LightEncodeTimerMinutesSchema,
} from "./schema/actions.js";
import type { ManagedLightEncodeConnectionSnapshot } from "./lightencode-connection-manager.js";

export const matrix = ModuleMatrixSchema.parse({
  id: "recording",
  label: "Light Encode",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "actionType",
  inactiveWhen: [{ field: "actionType", values: [""] }],
  legacy: {
    adapter: "lightencode",
    connectionType: "lightencode",
    normalize: true,
  },
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
      default: "",
      width: 230,
      choices: [
        { value: "", label: "Choose action" },
        { value: "record-toggle-all", label: "Record / Stop All" },
        { value: "record-toggle-slot", label: "Record / Stop Slot" },
        { value: "timer-toggle", label: "Enable / Disable Timer" },
        { value: "timer-set-minutes", label: "Set Timer Minutes" },
      ],
      required: false,
    },
    {
      fill: "copy",
      id: "actionValue",
      label: "Value",
      type: "number",
      default: null,
      required: true,
      integer: true,
      min: 0,
      max: 1440,
      formula: true,
      enabledWhen: [
        {
          field: "actionType",
          values: ["record-toggle-slot", "timer-set-minutes"],
        },
      ],
      rules: [
        {
          when: [{ field: "actionType", values: ["record-toggle-slot"] }],
          set: { min: 1, max: 999, fill: "series" },
        },
      ],
    },
    {
      fill: "copy",
      id: "feedback",
      label: "Feedback",
      type: "boolean",
      default: false,
      width: 112,
    },
    {
      fill: "copy",
      id: "feedbackColor",
      label: "Feedback Color",
      type: "color",
      default: "#37A65B",
      width: 148,
    },
  ],
});

export function matrixAction(fields: ModuleValues) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const command = z
    .enum([
      "record-toggle-all",
      "record-toggle-slot",
      "timer-toggle",
      "timer-set-minutes",
    ])
    .parse(values.actionType);
  const specific: ModuleValues =
    command === "record-toggle-slot"
      ? { slotNumber: LightEncodeSlotNumberSchema.parse(values.actionValue) }
      : command === "timer-set-minutes"
        ? { minutes: LightEncodeTimerMinutesSchema.parse(values.actionValue) }
        : {};
  return {
    id: `lightencode.${command}`,
    fields: {
      ...specific,
      drivesTally: values.feedback === true,
      feedbackColor: values.feedbackColor || "#37A65B",
    },
  };
}

export function matrixFeedback({ state, data, fields }: MatrixObservation) {
  const values = (fields.values ?? {}) as ModuleValues;
  const connection = (
    data.get("driver.snapshots") as
      | readonly ManagedLightEncodeConnectionSnapshot[]
      | undefined
  )?.[0]?.connection;
  if (values.enabled === false || values.feedback !== true)
    return {
      state: "inactive" as const,
      observedAt: new Date().toISOString(),
      appearance: { backgroundColor: null },
    };
  let active: boolean | null = false;
  if (
    !state?.observedAt ||
    state.phase !== "ready" ||
    connection?.phase !== "connected" ||
    !connection.state
  )
    active = null;
  else {
    switch (values.actionType) {
      case "record-toggle-all":
        active = connection.state.app.anyRecording;
        break;
      case "record-toggle-slot": {
        const pipeline =
          connection.state.pipelines[Number(values.actionValue) - 1];
        active = pipeline ? pipeline.recordingState === "recording" : null;
        break;
      }
      case "timer-toggle":
        active = connection.state.app.timerEnabled;
        break;
      case "timer-set-minutes":
        active =
          connection.state.app.timerMinutes === Number(values.actionValue);
        break;
    }
  }

  return {
    state:
      active === null
        ? ("unavailable" as const)
        : active
          ? ("active" as const)
          : ("inactive" as const),
    observedAt: active === null ? null : (state?.observedAt ?? null),
    appearance: {
      backgroundColor:
        active && typeof values.feedbackColor === "string"
          ? values.feedbackColor
          : null,
    },
  };
}
