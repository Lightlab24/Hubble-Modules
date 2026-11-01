import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { matrix } from "./matrix.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.15",
    requiredFeatures: [
      "host-services-v1",
      "module-fields-v2",
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-matrix-context-v1",
      "module-matrix-row-fields-v1",
      "module-matrix-fill-rules-v1",
    ],
  },
  configVersion: 1,
  matrix,
  capabilities: [
    "persistent-connection",
    "state-feedback",
    "service.toggleAll",
    "service.toggleSlot",
    "service.toggleTimer",
    "service.setTimerMinutes",
  ],
  settings: [
    {
      id: "host",
      label: "Host",
      type: "text",
      required: true,
      default: "127.0.0.1",
      description: "Hostname, IPv4 address, or bare IPv6 address.",
    },
    {
      id: "port",
      label: "Companion port",
      type: "number",
      required: true,
      default: 59613,
      integer: true,
      min: 59613,
      max: 59613,
    },
    {
      id: "requestTimeoutMs",
      label: "Request timeout (ms)",
      type: "number",
      required: true,
      default: 3000,
      integer: true,
      min: 100,
      max: 10000,
    },
  ],
  actions: [
    {
      id: "matrix",
      label: "Recording action",
      description: "Runs the action declared by this Matrix row.",
      completion: "state-confirmed",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: "lightencode.record-toggle-all",
      label: "record toggle all",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "state-confirmed",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: "lightencode.record-toggle-slot",
      label: "record toggle slot",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "state-confirmed",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: "lightencode.timer-toggle",
      label: "timer toggle",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "state-confirmed",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: "lightencode.timer-set-minutes",
      label: "timer set minutes",
      description:
        "Preserves the existing saved action contract and protocol completion boundary.",
      completion: "state-confirmed",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [
    {
      id: "matrix",
      label: "Recording and timer",
      description: "Observed Light Encode recording or timer state.",
      fields: [],
    },
  ],
});
