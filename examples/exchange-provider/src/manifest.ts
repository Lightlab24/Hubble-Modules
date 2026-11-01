import { defineModuleManifest } from "@hubble/module-sdk/authoring";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: { minimumVersion: "2.0.2", requiredFeatures: ["module-exchange-v1"] },
  capabilities: [],
  settings: [],
  feedback: [],
  exchange: {
    data: [{ id: "counter", label: "Counter", version: 1, query: true }],
  },
  actions: ["increment", "reset"].map((id) => ({
    id,
    label: id,
    description: "Inert module exchange example",
    fields: [],
    completion: "local" as const,
    timeoutMs: 1000,
  })),
});
