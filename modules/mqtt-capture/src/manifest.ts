import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.6",
    requiredFeatures: [
      "module-pages-v1",
      "module-page-controls-v1",
      "module-runtime-directory-v1",
    ],
  },
  capabilities: ["service.page.capture"],
  settings: [],
  actions: [],
  feedback: [],
  pages: [
    {
      id: "capture",
      label: "MQTT Capture",
      description:
        "Listen to all MQTT topics on an IP address. Start, operate your camera controls, then Stop and copy or export the transcript. Latest messages appear first below; exports include every captured message. Captures stop at 16 MB or 100,000 messages.",
      sections: [
        {
          type: "controls",
          id: "captureControls",
          label: "Capture",
          fields: [
            {
              id: "host",
              label: "IP address",
              type: "text",
              required: true,
              default: "",
            },
            {
              id: "port",
              label: "Port",
              type: "number",
              required: true,
              default: 1883,
              min: 1,
              max: 65535,
            },
            {
              id: "note",
              label: "Marker note",
              type: "text",
              required: false,
              default: "",
              description:
                "Optional: describe the next operation, for example “Pressing Gain Up”.",
            },
          ],
          commands: [
            {
              id: "start",
              label: "Start new capture",
              kind: "command",
              inputFields: ["host", "port"],
              enabledWhen: "canStart",
            },
            {
              id: "stop",
              label: "Stop capture",
              kind: "command",
              inputFields: [],
              enabledWhen: "canStop",
            },
            {
              id: "marker",
              label: "Add marker",
              kind: "command",
              inputFields: ["note"],
              enabledWhen: "canStop",
            },
            {
              id: "copy",
              label: "Copy transcript",
              kind: "copy",
              inputFields: [],
              enabledWhen: "canExport",
            },
            {
              id: "export",
              label: "Export transcript",
              kind: "download",
              inputFields: [],
              enabledWhen: "canExport",
            },
          ],
        },
        {
          type: "status",
          id: "liveStatus",
          label: "Live status",
          fields: [
            { id: "status", label: "Connection" },
            { id: "endpoint", label: "Listening to" },
            { id: "messages", label: "Messages" },
            { id: "topics", label: "Unique topics" },
            { id: "retained", label: "Retained snapshot messages" },
            { id: "live", label: "Live messages" },
            { id: "size", label: "Transcript size" },
            { id: "startedAt", label: "Started (UTC)" },
            { id: "lastMessageAt", label: "Last message (UTC)" },
          ],
        },
        {
          type: "table",
          id: "messagesView",
          label: "Latest 100 messages",
          source: "state",
          maxRows: 100,
          columns: [
            {
              id: "timestamp",
              label: "Received (UTC)",
              type: "text",
              required: true,
              default: "",
            },
            {
              id: "topic",
              label: "Topic",
              type: "text",
              required: true,
              default: "",
            },
            {
              id: "payload",
              label: "Payload",
              type: "text",
              required: false,
              default: "",
            },
            {
              id: "encoding",
              label: "Encoding",
              type: "text",
              required: true,
              default: "utf8",
            },
            {
              id: "delivery",
              label: "Delivery",
              type: "text",
              required: true,
              default: "Live",
            },
          ],
        },
      ],
    },
  ],
});
