import { ModuleMatrixSchema, type ModuleManifest } from "@hubble/module-sdk";
import { KEYS } from "./keys.js";

export const MATRIX_ACTION = "matrix";
export const PRESS_ACTION = "press-key";
export const FEEDBACK = "key";
export const KEY_FIELD = "module.key";

export const actions = [
  {
    id: MATRIX_ACTION,
    label: "Button Matrix key",
    description: "Presses the key chosen in this Button Matrix row.",
    completion: "submitted",
    timeoutMs: 10_000,
    fields: [],
  },
  {
    id: PRESS_ACTION,
    label: "Press key",
    description: "Presses one key on the monitor, as if on its front panel.",
    completion: "submitted",
    timeoutMs: 10_000,
    fields: [
      {
        id: "key",
        label: "Key",
        type: "choice",
        required: true,
        default: "f1",
        choices: KEYS.map((key) => ({ id: key.id, label: key.label, group: key.group })),
      },
    ],
  },
] satisfies ModuleManifest["actions"];

export const feedback = [
  {
    id: FEEDBACK,
    label: "Monitor key",
    description: "The monitor doesn't report its state back, so a key shows no feedback colour.",
    fields: [],
  },
] satisfies ModuleManifest["feedback"];

export const matrix = ModuleMatrixSchema.parse({
  id: "flanders-keys",
  label: "Flanders",
  actionId: MATRIX_ACTION,
  feedbackId: FEEDBACK,
  primaryField: KEY_FIELD,
  inactiveWhen: [{ field: KEY_FIELD, values: ["", null] }],
  fields: [
    { id: "enabled", label: "Enabled", type: "boolean", default: true, fill: "copy", width: 88 },
    {
      id: KEY_FIELD,
      label: "Key",
      type: "choice",
      default: "",
      fill: "copy",
      width: 160,
      choices: KEYS.map((key) => ({ value: key.id, label: key.label })),
    },
  ],
});
