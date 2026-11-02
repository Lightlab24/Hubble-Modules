import { CCC_COMMAND_OPTIONS } from "./config.js";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { matrix } from "./matrix.js";
import { cameraPage } from "./page.js";

const cameraField = {
  id: "cameraId",
  label: "Camera",
  type: "choice" as const,
  required: true,
  default: "",
  choices: [],
  choiceProvider: "cameras",
};

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.15",
    requiredFeatures: [
      "host-services-v1",
      "module-workspace-actions-v1",
      "module-exchange-v1",
      "module-runtime-directory-v1",
      "module-fields-v2",
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-matrix-input-source-v1",
      "module-choice-bindings-v1",
      "module-matrix-context-v1",
      "module-matrix-row-fields-v1",
      "module-choices-v2",
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-page-controls-v1",
      "module-documents-v1",
      "module-document-preparation-v1",
      "module-document-migrations-v1",
      "module-table-workbook-v1",
      "module-table-duplicate-policy-v1",
      "module-table-spreadsheet-v1",
      "module-page-navigation-v1",
      "module-table-selection-v1",
      "module-table-preview-v1",
      "module-table-live-v1",
      "module-table-presentation-v1",
      "module-datasets-v1",
      "host-service-registry-v1",
    ],
  },
  configVersion: 1,
  instanceScope: "workspace",
  documents: [
    {
      id: "cameras",
      label: "CCC cameras",
      version: 1,
      defaultValue: {
        revision: 0,
        singleSwitch: false,
        cameras: [],
        camerasView: { version: 1 },
      },
      legacyImport: "ccc",
      migrate: true,
      prepare: { id: "prepare-cameras", version: 1 },
    },
  ],
  pages: [cameraPage],
  exchange: {
    data: [
      {
        id: "prepare-cameras",
        label: "Validate camera edits",
        version: 1,
        query: true,
      },
      {
        id: "camera-preview",
        label: "Preview camera observations",
        version: 1,
        query: true,
      },
    ],
  },
  capabilities: [
    "state-feedback",
    "host.documents",
    "service.page.ccc",
    "service.activate",
    "service.mutate",
    "service.command",
  ],
  settings: [],
  matrix,
  actions: [
    {
      id: "matrix",
      label: "CCC Matrix",
      description: "Package-owned camera controls.",
      completion: "response",
      completionAlternatives: ["local", "state-confirmed"],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
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
      fields: value === "toggle-camera-enabled" ? [cameraField] : [],
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
  feedback: [
    {
      id: "matrix",
      label: "CCC Matrix",
      description: "Camera selection and observed recording feedback.",
      fields: [],
    },
    ...CCC_COMMAND_OPTIONS.filter(({ value }) =>
      [
        "toggle-camera-enabled",
        "single-switch",
        "enable-all-cameras",
        "roll-enabled-cameras",
        "stop-enabled-cameras",
        "roll-toggle-enabled-cameras",
      ].includes(value),
    ).map(({ value, label }) => ({
      id: value,
      label,
      description:
        value === "toggle-camera-enabled"
          ? "Active when this camera is enabled in CCC, including while its RCP or camera is offline."
          : "Observed CCC selection or camera recording state.",
      fields: value === "toggle-camera-enabled" ? [cameraField] : [],
    })),
  ],
});
