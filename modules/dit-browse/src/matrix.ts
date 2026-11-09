import {
  ModuleMatrixSchema,
  type ModuleFeedback,
  type ModuleValues,
} from "@hubble/module-sdk";
import type { MatrixObservation } from "@hubble/module-runtime-helpers/matrix";
import type { DitBrowseConnectionSnapshot } from "@hubble/dit-browse-client";
import { z } from "zod";

const commands = [
  "focus-camera",
  "switch-workspace",
  "show-grid",
  "cycle-workspaces",
  "set-grid-lock",
  "toggle-grid-lock",
] as const;
const feedbackCommands = [
  "focus-camera",
  "switch-workspace",
  "set-grid-lock",
  "toggle-grid-lock",
];
export const matrix = ModuleMatrixSchema.parse({
  id: "workspace-control",
  label: "DIT Browse",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "actionType",
  inactiveWhen: [{ field: "actionType", values: [""] }],
  legacy: {
    adapter: "dit-browse",
    connectionType: "dit-browse",
    normalize: true,
  },
  fields: [
    {
      fill: "copy",
      id: "actionType",
      label: "Action",
      type: "choice",
      default: "",
      required: false,
      width: 220,
      choices: [
        { value: "", label: "Choose action" },
        ...commands.map((value, i) => ({
          value,
          label: [
            "Focus camera",
            "Switch workspace",
            "Toggle grid view",
            "Cycle workspaces",
            "Set grid lock",
            "Toggle grid lock",
          ][i],
        })),
      ],
    },
    {
      fill: "copy",
      id: "actionValue",
      label: "Value",
      type: "text",
      default: "",
      required: true,
      formula: true,
      choiceProvider: "matrix-values",
      emptyMessage: "No matching values are currently reported by DIT Browse.",
      enabledWhen: [
        {
          field: "actionType",
          values: ["focus-camera", "switch-workspace", "set-grid-lock"],
        },
      ],
      rules: [
        {
          when: [{ field: "actionType", values: ["focus-camera"] }],
          set: {
            type: "number",
            integer: true,
            min: 1,
            max: 999999,
            fill: "series",
          },
        },
        {
          when: [{ field: "actionType", values: ["switch-workspace"] }],
          set: {
            type: "number",
            integer: true,
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
            fill: "series",
          },
        },
        {
          when: [{ field: "actionType", values: ["set-grid-lock"] }],
          set: {
            type: "choice",
            fill: "copy",
            choices: [
              { value: "TRUE", label: "Lock grid" },
              { value: "FALSE", label: "Unlock grid" },
            ],
          },
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
      enabledWhen: [{ field: "actionType", values: feedbackCommands }],
    },
    {
      fill: "copy",
      id: "feedbackColor",
      label: "Feedback Color",
      type: "color",
      default: "#37A65B",
      width: 148,
      enabledWhen: [{ field: "actionType", values: feedbackCommands }],
      rules: [
        {
          when: [{ field: "actionType", values: ["toggle-grid-lock"] }],
          set: { colorMode: "pair" },
        },
      ],
    },
  ],
});
function colors(source: unknown) {
  const values = z
    .array(z.string().regex(/^#[0-9a-f]{6}$/iu))
    .min(1)
    .max(2)
    .parse(
      String(source || "#37A65B")
        .split("|")
        .map((value) => value.trim()),
    );
  return {
    active: values.at(-1)!,
    inactive: values.length === 2 ? values[0]! : null,
  };
}
export function matrixAction(fields: ModuleValues) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const command = z.enum(commands).parse(values.actionType);
  const specific: ModuleValues =
    command === "focus-camera"
      ? { cameraNumber: z.int().min(1).max(999999).parse(values.actionValue) }
      : command === "switch-workspace"
        ? {
            workspaceNumber: z
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER)
              .parse(values.actionValue),
          }
        : command === "set-grid-lock"
          ? {
              locked:
                z
                  .enum(["TRUE", "FALSE"])
                  .parse(String(values.actionValue).toUpperCase()) === "TRUE",
            }
          : {};
  if (!feedbackCommands.includes(command))
    return { id: `dit-browse.${command}`, fields: specific };
  const color = colors(values.feedbackColor);
  if (color.inactive && command !== "toggle-grid-lock")
    throw new Error("This action uses one feedback colour");
  return {
    id: `dit-browse.${command}`,
    fields: {
      ...specific,
      drivesTally: values.feedback === true,
      feedbackColor: color.active,
      ...(command === "toggle-grid-lock"
        ? { feedbackInactiveColor: color.inactive }
        : {}),
    },
  };
}
function cameraLabel(
  values: ModuleValues,
  connection: DitBrowseConnectionSnapshot | undefined,
) {
  if (values.actionType !== "focus-camera") return undefined;
  const cameraNumber = Number(values.actionValue);
  if (!Number.isInteger(cameraNumber) || cameraNumber < 1) return undefined;
  const title = connection?.connected
    ? connection.catalog.find((camera) => camera.cameraNumber === cameraNumber)
        ?.title || "Unlabeled"
    : "Unavailable";
  return `${cameraNumber} — ${title}`.slice(0, 160);
}
/** Live presentation of the Value cell. The saved value is never changed. */
function valueCell(
  values: ModuleValues,
  connection: DitBrowseConnectionSnapshot | undefined,
  color: string | null,
): NonNullable<NonNullable<ModuleFeedback["appearance"]>["cells"]> {
  const label = cameraLabel(values, connection);
  return label === undefined && color === null
    ? {}
    : { actionValue: { color, ...(label === undefined ? {} : { label }) } };
}
export function matrixFeedback({ state, fields }: MatrixObservation) {
  const values = (fields.values ?? {}) as ModuleValues;
  const connection = state?.values.legacySnapshot as unknown as
    | DitBrowseConnectionSnapshot
    | undefined;
  const observing =
    values.enabled !== false &&
    values.feedback === true &&
    feedbackCommands.includes(String(values.actionType));
  if (!observing)
    return {
      state: "inactive" as const,
      observedAt: new Date().toISOString(),
      appearance: {
        backgroundColor: null,
        cells: valueCell(values, connection, null),
      },
    };
  let active: boolean | null = false;
  if (!state?.observedAt || !connection?.connected || !connection.status)
    active = null;
  else
    switch (values.actionType) {
      case "focus-camera":
        active =
          connection.status.expansionEnabled &&
          connection.status.focusMode &&
          connection.status.selectedCameraNumber === Number(values.actionValue);
        break;
      case "switch-workspace":
        active =
          connection.status.activeWorkspaceNumber === undefined
            ? null
            : connection.status.activeWorkspaceNumber ===
              Number(values.actionValue);
        break;
      case "set-grid-lock":
        active =
          !connection.status.expansionEnabled ===
          (String(values.actionValue).toUpperCase() === "TRUE");
        break;
      case "toggle-grid-lock":
        active = !connection.status.expansionEnabled;
        break;
    }

  const color = colors(values.feedbackColor);
  const backgroundColor =
    values.enabled === false || values.feedback !== true || active === null
      ? null
      : active
        ? color.active
        : values.actionType === "toggle-grid-lock"
          ? color.inactive
          : null;
  return {
    state:
      active === null
        ? ("unavailable" as const)
        : active
          ? ("active" as const)
          : ("inactive" as const),
    observedAt: active === null ? null : (state?.observedAt ?? null),
    appearance: {
      backgroundColor,
      cells: valueCell(
        values,
        connection,
        values.actionType === "toggle-grid-lock" ? null : backgroundColor,
      ),
    },
  };
}
