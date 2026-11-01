import {
  ModuleMatrixSchema,
  moduleFeedbackKey,
  type ModuleValues,
} from "@hubble/module-sdk";
import type { MatrixObservation } from "@hubble/module-runtime-helpers/matrix";
import { z } from "zod";
import {
  CCC_COMMAND_OPTIONS,
  CccCommandSchema,
  canonicalCccCommand,
  cccCommandNeedsCamera,
  resolveCccCameraRow,
  type CccState,
} from "./config.js";

const cameraCommands = [
  "enable-camera",
  "disable-camera",
  "toggle-camera-enabled",
];
export const feedbackCommands = [
  ...cameraCommands,
  "enable-all-cameras",
  "single-switch",
  "roll-enabled-cameras",
  "stop-enabled-cameras",
  "roll-toggle-enabled-cameras",
];
export const matrix = ModuleMatrixSchema.parse({
  id: "camera-control",
  label: "CCC",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "actionType",
  legacy: { adapter: "ccc", normalize: true },
  variants: CCC_COMMAND_OPTIONS.map(({ value }) => ({
    when: [{ field: "column.commandId", values: [value] }],
    fields: { actionType: { default: value } },
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
      default: "toggle-camera-enabled",
      required: true,
      width: 260,
      choiceEditor: {
        choices: CCC_COMMAND_OPTIONS.map((choice) => ({
          ...choice,
          ...(choice.value === "toggle-camera-enabled"
            ? {
                aliases: [
                  { value: "enable-camera", parameters: {} },
                  { value: "disable-camera", parameters: {} },
                ],
              }
            : {}),
        })),
      },
    },
    {
      id: "cameraId",
      fill: "series",
      formula: true,
      label: "CCC Camera",
      type: "text",
      default: "",
      required: true,
      width: 300,
      choiceProvider: "matrix-cameras",
      emptyMessage: "Add cameras in the CCC sheet.",
      enabledWhen: [{ field: "actionType", values: cameraCommands }],
    },
    {
      fill: "copy",
      id: "drivesTally",
      label: "Button Feedback",
      type: "boolean",
      default: true,
      width: 112,
      enabledWhen: [{ field: "actionType", values: feedbackCommands }],
    },
    {
      fill: "copy",
      id: "feedbackColor",
      label: "Feedback Color",
      type: "color",
      default: "#37A65B",
      width: 150,
      colorMode: "pair",
      enabledWhen: [
        { field: "actionType", values: feedbackCommands },
        { field: "drivesTally", values: [true] },
      ],
    },
  ],
});

export function matrixAction(fields: ModuleValues) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const command = CccCommandSchema.parse(
    canonicalCccCommand(String(values.actionType)),
  );
  return {
    id: "ccc.command",
    fields: {
      command,
      ...(cccCommandNeedsCamera(command)
        ? { cameraId: z.string().min(1).parse(values.cameraId) }
        : {}),
    },
  };
}

export function matrixFeedback({ data, feedback, fields }: MatrixObservation) {
  const values = (fields.values ?? {}) as ModuleValues;
  const command = canonicalCccCommand(String(values.actionType));
  const snapshot = data.get("host.ccc") as CccState | undefined;
  const row =
    cccCommandNeedsCamera(command) && values.cameraId
      ? resolveCccCameraRow(
          snapshot?.config.rows ?? [],
          String(values.cameraId),
        )
      : null;
  const cells: Record<
    string,
    { label: string; color: null; inputSource?: string }
  > = row
    ? {
        cameraId: {
          label: `${row.rcpIp || "Unconfigured"} · Camera ${row.cameraNumber ?? "?"}`,
          color: null,
          ...(values.cameraId === row.rowId && row.cameraNumber !== null
            ? { inputSource: String(row.cameraNumber) }
            : {}),
        },
      }
    : {};
  if (
    values.enabled === false ||
    values.drivesTally !== true ||
    !feedbackCommands.includes(command)
  )
    return {
      state: "inactive" as const,
      observedAt: new Date().toISOString(),
      appearance: { backgroundColor: null, cells },
    };
  const rowId = row?.rowId ?? "";
  const observation = feedback.get(
    moduleFeedbackKey(command, rowId ? { cameraId: rowId } : undefined),
  );
  const active =
    observation?.observedAt && observation.state !== "unavailable"
      ? observation.state === "active"
      : null;
  const colors = z
    .array(z.string().regex(/^#[0-9a-f]{6}$/iu))
    .min(1)
    .max(2)
    .parse(
      String(values.feedbackColor || "#37A65B")
        .split("|")
        .map((value) => value.trim()),
    );
  return {
    state:
      active == null
        ? ("unavailable" as const)
        : active
          ? ("active" as const)
          : ("inactive" as const),
    observedAt: active == null ? null : (observation?.observedAt ?? null),
    appearance: {
      cells,
      backgroundColor:
        active == null
          ? null
          : active
            ? colors.at(-1)!
            : colors.length === 2
              ? colors[0]!
              : null,
    },
  };
}
