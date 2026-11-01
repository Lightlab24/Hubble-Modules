import { defineModuleManifest } from "@hubble/module-sdk/authoring";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "host-service-registry-v1",
      "module-native-menus-v1",
      "module-workspace-instances-v1",
      "module-workspace-actions-v1",
    ],
  },
  capabilities: ["host.native-menus"],
  settings: [],
  feedback: [],
  actions: [
    {
      id: "choose-view",
      label: "Choose view",
      description:
        "Read the package-defined menu and invoke one current exact command.",
      completion: "response",
      timeoutMs: 15000,
      fields: [
        {
          id: "title",
          label: "View",
          type: "text",
          default: "Camera A",
          required: true,
        },
      ],
    },
  ],
});
