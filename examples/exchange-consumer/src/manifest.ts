import { defineModuleManifest } from "@hubble/module-sdk/authoring";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: { minimumVersion: "2.0.2", requiredFeatures: ["module-exchange-v1"] },
  capabilities: [],
  feedback: [],
  settings: [
    {
      id: "autoReset",
      label: "Reset when the counter exceeds ten",
      type: "boolean",
      required: true,
      default: false,
    },
  ],
  actions: ["connect", "refresh", "increment"].map((id) => ({
    id,
    label: id,
    description: "Inert module exchange example",
    fields: [],
    completion: "local" as const,
    timeoutMs: 1000,
  })),
});
