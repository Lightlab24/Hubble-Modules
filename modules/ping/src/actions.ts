import { ModuleMatrixSchema, type ModuleManifest } from "@hubble/module-sdk";

export const PAGE_ID = "ping";
export const DEVICE_PROVIDER = "devices";
export const MATRIX_ACTION = "matrix";
export const FEEDBACK = "device";
export const DEVICE_FIELD = "module.device";
export const COLOR_FIELD = "module.feedbackColor";

export const actions = [
  {
    id: MATRIX_ACTION,
    label: "Show device status",
    description: "A key that shows whether a device on the Ping page is answering. Pressing it does nothing.",
    completion: "local",
    timeoutMs: 5000,
    fields: [],
  },
] satisfies ModuleManifest["actions"];

export const feedback = [
  {
    id: FEEDBACK,
    label: "Device status",
    description: "Online, Slow or Offline for one device on the Ping page.",
    fields: [],
  },
] satisfies ModuleManifest["feedback"];

// One setting to an operator: a device is in exactly one of these at a time.
const connection = { id: "connection", label: "Connection" };
export const triggers = [
  { id: "offline", label: "Offline", part: "background", color: "#E3242B", effect: { kind: "blink", cycleMs: 800 }, group: connection },
  { id: "slow", label: "Slow", part: "background", color: "#F59E0B", group: connection },
  { id: "online", label: "Online", part: "background", color: "#37A65B", group: connection },
] as const;

export const matrix = ModuleMatrixSchema.parse({
  id: "ping-devices",
  label: "Ping",
  actionId: MATRIX_ACTION,
  feedbackId: FEEDBACK,
  primaryField: DEVICE_FIELD,
  inactiveWhen: [{ field: DEVICE_FIELD, values: ["", null] }],
  // A status key only watches: it adds no command to the button's press.
  observerWhen: [{ field: DEVICE_FIELD, values: ["", null], negate: true }],
  fields: [
    { id: "enabled", label: "Enabled", type: "boolean", default: true, fill: "copy", width: 88 },
    {
      // Text with the page's devices offered as choices: a fixed choice list can't follow the page.
      id: DEVICE_FIELD,
      label: "Ping Device",
      type: "text",
      default: "",
      fill: "copy",
      formula: true,
      width: 190,
      choiceProvider: DEVICE_PROVIDER,
      emptyMessage: "Add a device on the Ping page.",
    },
    // This cell shows and edits the looks of Online, Slow and Offline for the row.
    { id: COLOR_FIELD, label: "Feedback Color", type: "color", colorMode: "pair", default: "#3A3A40 | #37A65B", fill: "copy", width: 155 },
  ],
  triggers,
  triggerField: COLOR_FIELD,
});
