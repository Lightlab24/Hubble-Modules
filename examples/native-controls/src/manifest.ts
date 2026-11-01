import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { ModuleMatrixSchema } from "@hubble/module-sdk";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "host-service-registry-v1",
      "module-native-controls-v1",
      "module-workspace-matrix-choices-v1",
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-shortcut-editor-v1",
      "module-choices-v2",
    ],
  },
  capabilities: ["host.keyboard"],
  settings: [],
  matrix: ModuleMatrixSchema.parse({
    id: "shortcuts",
    label: "Native shortcuts",
    actionId: "send",
    feedbackId: "state",
    primaryField: "module.chord",
    fields: [
      {
        id: "module.chord",
        label: "Shortcut",
        type: "text",
        required: true,
        default: "",
        shortcut: { modifiersField: "module.modifiers" },
      },
      { id: "module.modifiers", label: "Modifiers", type: "text", default: "" },
      {
        id: "module.application",
        label: "Application",
        type: "text",
        required: true,
        default: "",
        choiceProvider: "applications",
      },
    ],
  }),
  actions: [
    {
      id: "send",
      label: "Send shortcut",
      description: "An explicit shortcut to the selected running application.",
      completion: "response",
      timeoutMs: 5000,
      legacy: true,
      fields: [],
    },
  ],
  feedback: [
    {
      id: "state",
      label: "Response only",
      description: "No continuous application state is claimed.",
      fields: [],
    },
  ],
});
