import { CCC_COMMAND_OPTIONS } from "./config.js";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.0",
    requiredFeatures: [
      "host-services-v1",
      "module-workspace-actions-v1",
      "module-exchange-v1",
      "module-runtime-directory-v1",
      "module-fields-v2",
    ],
  },
  configVersion: 1,
  capabilities: [
    "state-feedback",
    "host.ccc-store",
    "service.activate",
    "service.mutate",
    "service.command",
  ],
  settings: [],
  actions: [
    ...CCC_COMMAND_OPTIONS.map(({ value, label }) => ({
      id: value,
      label,
      description: "CCC owns camera selection and recording decisions.",
      completion: (value === "toggle-camera-enabled" ||
      value === "enable-all-cameras" ||
      value === "single-switch"
        ? "local"
        : value === "roll-enabled-cameras" ||
            value === "stop-enabled-cameras" ||
            value === "roll-toggle-enabled-cameras"
          ? "state-confirmed"
          : "response") as "local" | "state-confirmed" | "response",
      completionAlternatives: [],
      timeoutMs: 120000,
      fields:
        value === "toggle-camera-enabled"
          ? [
              {
                id: "cameraId",
                label: "Camera",
                type: "choice" as const,
                required: true,
                default: "",
                choices: [],
                choiceProvider: "cameras",
              },
            ]
          : [],
    })),
    {
      id: "record-rcp",
      label: "CyanView recording",
      description:
        "Uses the same CCC recording queue for an approved CyanView module.",
      completion: "state-confirmed",
      completionAlternatives: ["local"],
      timeoutMs: 120000,
      fields: [
        {
          id: "connectionId",
          label: "RCP",
          type: "choice",
          required: true,
          default: "",
          choices: [],
          choiceProvider: "rcps",
        },
        {
          id: "command",
          label: "Command",
          type: "choice",
          required: true,
          default: "record-camera",
          choices: [
            { id: "record-camera", label: "Toggle camera" },
            { id: "record-group-all", label: "Toggle Group ALL" },
            { id: "start-enabled-cameras", label: "Start enabled cameras" },
            { id: "stop-enabled-cameras", label: "Stop enabled cameras" },
          ],
        },
        {
          id: "cameraNumber",
          label: "Camera number",
          type: "number",
          default: 1,
          required: false,
          integer: true,
          min: 1,
          max: 999999,
        },
      ],
    },
    {
      id: "ccc.command",
      label: "ccc.command",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "response",
      timeoutMs: 120000,
      fields: [],
      completionAlternatives: ["state-confirmed", "local"],
      legacy: true,
    },
  ],
  feedback: CCC_COMMAND_OPTIONS.filter(({ value }) =>
    [
      "single-switch",
      "enable-all-cameras",
      "roll-enabled-cameras",
      "stop-enabled-cameras",
      "roll-toggle-enabled-cameras",
    ].includes(value),
  ).map(({ value, label }) => ({
    id: value,
    label,
    description: "Observed CCC selection or camera recording state.",
    fields: [],
  })),
});
