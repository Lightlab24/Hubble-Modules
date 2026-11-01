import { matrix } from "./matrix.js";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { listenerFields, feedbackColumns, text, number } from "./fields.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.10",
    requiredFeatures: [
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-runtime-directory-v1",
      "host-services-v1",
      "module-pages-v1",
      "module-table-workbook-v1",
      "module-fields-v2",
      "module-table-spreadsheet-v1",
      "module-table-selection-v1",
      "module-exchange-v1",
    ],
  },
  configVersion: 1,
  capabilities: ["persistent-listener", "state-feedback", "tally-receiver"],
  settings: listenerFields,
  matrix,
  actions: [
    {
      id: "set-column-indication",
      label: "Set column indication",
      description: "Set indication on a column owned by this receiver.",
      completion: "local",
      timeoutMs: 5000,
      fields: [
        {
          id: "columnId",
          label: "Column ID",
          type: "text",
          required: true,
          default: "",
        },
        {
          id: "enabled",
          label: "Indication",
          type: "boolean",
          required: true,
          default: true,
        },
      ],
    },
    {
      id: "matrix",
      label: "Tally action",
      description: "Module-owned Tally feedback and follow controls.",
      completion: "local",
      timeoutMs: 5000,
      fields: [],
    },
    {
      id: "tsl.tally-feedback",
      label: "tsl.tally feedback",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.set-indication",
      label: "tsl.set indication",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.tally-switch",
      label: "tsl.tally switch",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.follow",
      label: "tsl.follow",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [
    {
      id: "matrix",
      label: "Matrix tally",
      description: "Observed row colours, glow and address indication.",
      fields: [],
    },
    {
      id: "tally",
      label: "Program tally",
      description:
        "Observed tally for a configured feedback mapping; unavailable when stale or disconnected.",
      fields: [
        {
          id: "mappingId",
          label: "Camera mapping",
          type: "choice",
          required: true,
          default: "",
          choices: [],
          choiceProvider: "feedback-mappings",
        },
      ],
    },
  ],
  exchange: {
    data: [
      {
        id: "matrix-columns",
        label: "Owned Matrix columns",
        version: 1,
        query: true,
      },
      { id: "tally", label: "TSL tally observations", version: 1, query: true },
    ],
  },
  pages: [
    {
      id: "tsl",
      label: "TSL Tally",
      sections: [
        {
          type: "settings",
          id: "receiver",
          label: "Receiver",
          fields: listenerFields.map((field) => field.id),
        },
        {
          type: "status",
          id: "status",
          label: "Reception",
          fields: [
            { id: "listener", label: "Listening on" },
            { id: "received", label: "Discovered displays" },
            { id: "invalidPackets", label: "Invalid packets" },
          ],
        },
        {
          type: "table",
          id: "discovery",
          workbook: {
            stateKey: "discoveryWorkbook",
            defaults: { frozenColumns: 1, textSize: 12 },
            columns: {},
          },
          label: "Live discovery",
          source: "state",
          selectionHighlight: "row",
          maxRows: 512,
          columns: [
            number("screen", "Screen"),
            number("address", "Address"),
            text("label", "Label"),
            text("tally", "Tally"),
            text("status", "Status"),
            text("sender", "Sender"),
          ],
        },
        {
          type: "table",
          id: "feedbackMappings",
          workbook: {
            stateKey: "feedbackWorkbook",
            defaults: { frozenColumns: 1, textSize: 12 },
            columns: {
              name: { fill: "series" },
              address: { fill: "series" },
              screen: { fill: "copy" },
              indicator: { fill: "copy" },
            },
          },
          label: "Button feedback mappings",
          source: "settings",
          selectionHighlight: "row",
          maxRows: 256,
          columns: feedbackColumns,
          computed: { source: "feedbackStatus", columns: ["status"] },
        },
      ],
    },
  ],
});
