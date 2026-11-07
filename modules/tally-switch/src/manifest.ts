import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import type { ModuleField } from "@hubble/module-sdk";
import { indicators } from "./engine.js";
const text = (id: string, label: string, value = ""): ModuleField => ({
  id,
  label,
  type: "text",
  required: true,
  default: value,
});
const number = (
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
): ModuleField => ({
  id,
  label,
  type: "number",
  required: true,
  default: value,
  integer: true,
  min,
  max,
});
const peer = (id: string, label: string): ModuleField => ({
  id,
  label,
  type: "choice",
  required: true,
  default: "",
  choices: [],
  choiceProvider: id,
});
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.13",
    requiredFeatures: [
      "module-action-authoring-v1",
      "module-pages-v1",
      "module-page-navigation-v1",
      "module-table-workbook-v1",
      "module-fields-v2",
      "module-table-selection-v1",
      "module-table-presentation-v1",
      "module-table-spreadsheet-v1",
      "module-exchange-v1",
      "module-exchange-peers-v1",
      "module-runtime-directory-v1",
      "module-page-controls-v1",
    ],
  },
  capabilities: ["service.page.tally-switch", "service.follow"],
  settings: [
    {
      id: "enabled",
      label: "Follow tally by default",
      type: "boolean",
      required: true,
      default: false,
    },
  ],
  // Controlled from its page and the TSL Matrix follow action, never a separate button column.
  actionUi: false,
  actions: [
    {
      id: "follow",
      label: "TALLY Switch follow",
      description:
        "Follow, unfollow or toggle automatic routing from observed program tally.",
      completion: "local",
      timeoutMs: 5000,
      fields: [
        {
          id: "mode",
          label: "Mode",
          type: "choice",
          required: true,
          default: "toggle",
          choices: ["follow", "unfollow", "toggle"].map((id) => ({
            id,
            label: id,
          })),
        },
      ],
    },
  ],
  feedback: [
    {
      id: "following",
      label: "TALLY Switch following",
      description: "Whether automatic tally routing is enabled.",
      fields: [],
    },
  ],
  exchange: {
    data: [
      { id: "following", label: "Following state", version: 1, query: true },
    ],
    // Every TSL receiver and router in the workspace connects with no approval step.
    peers: [
      { data: "tally", version: 1, actions: [] },
      { data: "router", version: 1, actions: ["route"] },
    ],
  },
  pages: [
    {
      id: "tally-switch",
      navigation: {
        replaces: "tally-switch",
        relatedCapabilities: ["tally-receiver", "host.tsl"],
      },
      label: "TALLY Switch",
      sections: [
        {
          type: "status",
          id: "summary",
          label: "Automatic routing",
          fields: [
            { id: "following", label: "Following" },
            { id: "notice", label: "Status" },
          ],
        },
        {
          type: "controls",
          id: "follow",
          label: "Follow control",
          fields: [],
          commands: [
            {
              id: "toggle",
              label: "Follow / Unfollow",
              kind: "command",
              inputFields: [],
            },
          ],
        },
        {
          type: "table",
          id: "mappings",
          workbook: {
            stateKey: "mappingWorkbook",
            defaults: { frozenColumns: 1, textSize: 12 },
            columns: {
              source: { fill: "series", width: 110 },
              name: { fill: "series", width: 190 },
              address: { fill: "series" },
              enabled: { fill: "copy", width: 100 },
              receiver: { fill: "copy" },
              screen: { fill: "copy" },
              indicator: { fill: "copy" },
              router: { fill: "copy" },
              destination: { fill: "copy" },
              level: { fill: "copy" },
            },
          },
          label: "Camera mappings",
          description:
            "Choose a TSL receiver and a router for each camera. Startup and reconnect hold the last route until fresh tally changes.",
          source: "settings",
          selectionHighlight: "row",
          rowHighlight: {
            field: "program",
            values: ["ON AIR"],
            color: "#602A2A",
          },
          maxRows: 512,
          computed: {
            source: "mappingStatus",
            columns: ["program", "status"],
            dependencies: {
              rowFields: [
                "enabled",
                "receiver",
                "screen",
                "address",
                "indicator",
                "router",
                "destination",
                "source",
                "level",
              ],
              settingsFields: [],
            },
          },
          columns: [
            text("name", "Camera", "Camera"),
            {
              id: "enabled",
              label: "Enabled",
              type: "boolean",
              required: true,
              default: true,
            },
            peer("receiver", "TSL receiver"),
            number("screen", "Screen", 0, 0, 65534),
            number("address", "Address", 1, 0, 65534),
            {
              id: "indicator",
              label: "Program tally",
              type: "choice",
              required: true,
              default: "default",
              choices: indicators.map((id) => ({ id, label: id })),
            },
            peer("router", "Router"),
            number("destination", "Output", 1, 1, 65536),
            number("source", "Source", 1, 1, 65536),
            number("level", "Level", 1, 1, 256),
            text("program", "Tally"),
            text("status", "Routing status"),
          ],
        },
      ],
    },
  ],
});
