import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { LIVEGRADE_APPLICATIONS } from "./config.js";
import { matrix } from "./matrix.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "host-service-registry-v1",
      "module-native-menus-v1",
      "module-matrix-v1",
      "module-matrix-context-v1",
      "module-matrix-row-fields-v1",
      "module-feedback-observers-v1",
      "module-choice-bindings-v1",
      "module-choices-v2",
      "module-fields-v2",
      "module-optional-numbers-v1",
    ],
  },
  capabilities: [
    "state-feedback",
    "dynamic-choices",
    "host.native-menus",
    "service.selectSlot",
    "service.requestAccessibilityPermission",
  ],
  matrix,
  settings: [
    {
      id: "generation",
      label: "Default generation",
      type: "number",
      default: 7,
      required: true,
      min: 6,
      max: 7,
      integer: true,
      description:
        "The default for older Select Slot columns. Each Matrix row can choose any supported application.",
    },
    {
      id: "edition",
      label: "Default edition",
      type: "choice",
      default: "standard",
      required: false,
      choices: [
        { id: "standard", label: "Standard" },
        { id: "frontier", label: "Frontier (generation 7)" },
      ],
    },
    {
      id: "requestTimeoutMs",
      label: "Menu request timeout (ms)",
      type: "number",
      default: 1500,
      required: true,
      min: 100,
      max: 5000,
      integer: true,
      description:
        "Run LiveGrade and allow Hubble Accessibility access in macOS System Settings. Slot commands preserve background focus.",
    },
  ],
  actions: [
    {
      id: "matrix",
      label: "LiveGrade Matrix",
      description: "Select the slot declared by this Matrix row.",
      completion: "response",
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: "livegrade.select-slot",
      label: "Select Slot",
      description:
        "Invoke the exact current slot menu command without activating LiveGrade. Completion is a native response, not observed selected state.",
      completion: "response",
      timeoutMs: 30000,
      legacy: true,
      fields: [
        {
          id: "application",
          label: "Application",
          type: "choice",
          default: "7",
          required: true,
          choices: LIVEGRADE_APPLICATIONS.map(({ value, label }) => ({
            id: value,
            label,
          })),
        },
        {
          id: "assignmentMode",
          label: "Assignment mode",
          type: "choice",
          default: "auto-alphanumeric",
          required: true,
          choices: [
            { id: "auto-alphanumeric", label: "Auto Alphanumeric" },
            { id: "manual", label: "Manual" },
          ],
        },
        {
          id: "sequence",
          label: "Menu position",
          type: "number",
          default: null,
          required: false,
          min: 1,
          max: 4096,
          integer: true,
        },
        {
          id: "slotId",
          label: "Slot / query",
          type: "text",
          default: "",
          required: false,
        },
      ],
    },
  ],
  feedback: [
    {
      id: "matrix",
      label: "LiveGrade slot labels",
      description:
        "Current catalog labels; this does not assert a selected slot.",
      fields: [],
    },
  ],
});
