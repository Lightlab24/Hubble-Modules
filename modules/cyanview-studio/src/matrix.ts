import { ModuleMatrixSchema, type ModuleValues } from "@hubble/module-sdk";
import { z } from "zod";

export const matrix = ModuleMatrixSchema.parse({
  id: "feed-selection",
  label: "CyanView Studio",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "feedNumber",
  inactiveWhen: [
    { field: "feedNumber", values: [null] },
    { field: "feedId", values: [null] },
    { field: "cameraId", values: ["", null] },
  ],
  legacy: {
    adapter: "cyanview-studio",
    normalize: true,
    connectionType: "cyanview-studio",
  },
  variants: ["select-feed-number", "select-feed-id", "select-feed"].map(
    (command) => ({
      when: [{ field: "column.commandId", values: [command] }],
      fields: { actionType: { default: command } },
    }),
  ),
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
      default: "select-feed-number",
      width: 230,
      choices: [
        { value: "select-feed-number", label: "Select feed number" },
        { value: "select-feed-id", label: "Select feed ID" },
        { value: "select-feed", label: "Select camera ID" },
      ],
    },
    {
      fill: "series",
      id: "feedNumber",
      label: "Feed number",
      type: "number",
      default: null,
      integer: true,
      min: 1,
      formula: true,
      required: false,
      width: 180,
      enabledWhen: [{ field: "actionType", values: ["select-feed-number"] }],
    },
    {
      fill: "series",
      id: "feedId",
      label: "Feed ID",
      type: "number",
      default: null,
      integer: true,
      formula: true,
      required: false,
      width: 180,
      enabledWhen: [{ field: "actionType", values: ["select-feed-id"] }],
    },
    {
      fill: "copy",
      id: "cameraId",
      label: "Camera ID",
      type: "text",
      default: "",
      formula: true,
      required: false,
      width: 200,
      enabledWhen: [{ field: "actionType", values: ["select-feed"] }],
    },
  ],
});

export function matrixAction(fields: ModuleValues) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const command = z
    .enum(["select-feed-number", "select-feed-id", "select-feed"])
    .parse(values.actionType);
  const field = {
    "select-feed-number": "feedNumber",
    "select-feed-id": "feedId",
    "select-feed": "cameraId",
  }[command];
  return {
    id: `cyanview-studio.${command}`,
    fields: { [field]: values[field] ?? null },
  };
}
