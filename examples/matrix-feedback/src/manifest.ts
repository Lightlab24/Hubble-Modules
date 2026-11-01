import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.15",
    requiredFeatures: [
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-matrix-input-source-v1",
      "module-matrix-row-fields-v1",
      "module-matrix-fill-rules-v1",
    ],
  },
  capabilities: [],
  settings: [],
  actions: [
    {
      id: "meter",
      label: "Meter",
      description: "Observe local values",
      fields: [],
      completion: "local",
      timeoutMs: 1000,
    },
  ],
  feedback: [
    { id: "level", label: "Level", description: "Observed level", fields: [] },
  ],
  matrix: {
    id: "signal-meter",
    label: "Signal meter",
    actionId: "meter",
    feedbackId: "level",
    primaryField: "actionType",
    observerWhen: [{ field: "actionType", values: ["observe"], choice: true }],
    fields: [
      {
        id: "enabled",
        label: "Enabled",
        type: "boolean",
        default: true,
        fill: "copy",
      },
      {
        id: "module.level",
        label: "Level (%)",
        type: "number",
        default: 25,
        min: 0,
        max: 100,
        formula: true,
        fill: "copy",
        rules: [
          {
            when: [
              { field: "actionType", values: ["level-series"], choice: true },
            ],
            set: { fill: "series" },
          },
        ],
      },
      {
        id: "actionType",
        label: "Presentation",
        type: "choice",
        default: "observe",
        fill: "copy",
        choiceEditor: {
          choices: [
            { value: "level-series", label: "Numbered levels", parameters: [] },
            {
              value: "observe",
              label: "Observe threshold",
              parameters: [
                {
                  id: "colors",
                  label: "Colours",
                  type: "color-pair",
                  default: ["#16A34A", "#111111"],
                  labels: ["Above threshold", "Below threshold"],
                },
                {
                  id: "pulse",
                  label: "Pulse above threshold",
                  type: "boolean",
                  default: false,
                },
              ],
            },
          ],
        },
      },
    ],
    columnSettings: [
      {
        id: "threshold",
        label: "Threshold (%)",
        type: "number",
        required: true,
        default: 50,
        min: 0,
        max: 100,
      },
    ],
  },
});
