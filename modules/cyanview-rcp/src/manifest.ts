import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.0",
    requiredFeatures: ["host-services-v1", "module-exchange-v1"],
  },
  configVersion: 1,
  capabilities: [
    "persistent-connection",
    "state-feedback",
    "service.selectCamera",
    "service.recordCamera",
    "service.recordGroupAll",
  ],
  exchange: {
    data: [
      { id: "connection", label: "RCP connection", version: 1, query: true },
    ],
  },
  settings: [],
  actions: [
    ...(["start-enabled-cameras", "stop-enabled-cameras"] as const).map(
      (command) => ({
        id: `cyanview-rcp.${command}`,
        label:
          command === "start-enabled-cameras"
            ? "Start enabled cameras"
            : "Stop enabled cameras",
        description:
          "Controls matching enabled CCC cameras through the shared recording queue.",
        completion: "state-confirmed" as const,
        completionAlternatives: ["local" as const],
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      }),
    ),
    {
      id: "cyanview-rcp.select-camera",
      label: "select camera",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "response",
      completionAlternatives: ["state-confirmed", "local"],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "cyanview-rcp.record-camera",
      label: "record camera",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "response",
      completionAlternatives: ["state-confirmed", "local"],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "cyanview-rcp.record-group-all",
      label: "record group all",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "response",
      completionAlternatives: ["state-confirmed", "local"],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
});
