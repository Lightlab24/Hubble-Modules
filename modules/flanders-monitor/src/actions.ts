import { ModuleMatrixSchema, type ModuleManifest } from "@hubble/module-sdk";
import { KEYS } from "./keys.js";

export const PAGE_ID = "flanders";
export const MONITOR_PROVIDER = "monitors";
export const MATRIX_ACTION = "matrix";
export const PRESS_ACTION = "press-key";
export const FEEDBACK = "key";
export const MONITOR_FIELD = "module.monitor";
export const KEY_FIELD = "module.key";

export const actions = [
  {
    id: MATRIX_ACTION,
    label: "Button Matrix key",
    description: "Presses the key chosen in this Button Matrix row on the monitor chosen beside it.",
    completion: "submitted",
    timeoutMs: 10_000,
    fields: [],
  },
  {
    id: PRESS_ACTION,
    label: "Press key",
    description: "Presses one key on a monitor from the Flanders page, as if on its front panel.",
    completion: "submitted",
    timeoutMs: 10_000,
    fields: [
      {
        id: "monitor",
        label: "Monitor",
        type: "choice",
        required: true,
        default: "",
        choices: [],
        choiceProvider: MONITOR_PROVIDER,
      },
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
  inactiveWhen: [
    { field: MONITOR_FIELD, values: ["", null] },
    { field: KEY_FIELD, values: ["", null] },
  ],
  fields: [
    { id: "enabled", label: "Enabled", type: "boolean", default: true, fill: "copy", width: 88 },
    {
      // Text with the page's monitors offered as choices: a fixed choice list can't follow the page.
      id: MONITOR_FIELD,
      label: "Monitor",
      type: "text",
      default: "",
      fill: "copy",
      formula: true,
      width: 180,
      choiceProvider: MONITOR_PROVIDER,
    },
    {
      id: KEY_FIELD,
      label: "Key",
      type: "choice",
      default: "",
      fill: "copy",
      width: 140,
      choices: KEYS.map((key) => ({ value: key.id, label: key.label })),
    },
  ],
});
