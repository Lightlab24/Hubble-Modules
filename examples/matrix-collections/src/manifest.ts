import {
  ModuleMatrixSchema,
  ModuleOrderedNumbersSchema,
} from "@hubble/module-sdk";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export const ordered = ModuleOrderedNumbersSchema.parse({
  min: 1,
  max: 64,
  maxItems: 4,
  itemLabel: "Cue",
});
export const palette = ["#123456", "#654321", "#339966", "#993366"];
export const matrix = ModuleMatrixSchema.parse({
  id: "local-cues",
  label: "Local cues",
  actionId: "apply",
  feedbackId: "selected",
  primaryField: "actionType",
  availableWhenDisabled: [
    { field: "actionType", values: ["forward", "reverse"] },
  ],
  fields: [
    {
      id: "actionType",
      label: "Preset",
      type: "text",
      default: "forward",
      choiceProvider: "presets",
      choiceFields: ["module.cues"],
    },
    {
      id: "module.cues",
      label: "Cue order",
      type: "text",
      default: "1, 2",
      orderedNumbers: ordered,
    },
    {
      id: "module.colors",
      label: "Cue colours",
      type: "color",
      default: "#123456",
      colorMode: "palette",
      colorPalette: {
        defaults: palette,
        itemsField: "module.cues",
        itemLabel: "Cue",
      },
    },
  ],
});
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-matrix-collections-v1",
      "module-choice-bindings-v1",
      "module-choices-v2",
      "module-optional-numbers-v1",
      "module-disabled-state-v1",
    ],
  },
  capabilities: [],
  lifecycle: { runWhenDisabled: true },
  settings: [
    {
      id: "offset",
      label: "Optional cue offset",
      type: "number",
      default: null,
      required: false,
      integer: true,
      min: 0,
      max: 64,
    },
  ],
  matrix,
  actions: [
    {
      id: "apply",
      label: "Apply local cues",
      description: "Records local cue order; sends no device command.",
      completion: "local",
      timeoutMs: 1000,
      fields: [],
    },
  ],
  feedback: [
    {
      id: "selected",
      label: "Selected cue",
      description: "Shows the first cue colour.",
      fields: [],
    },
  ],
});
