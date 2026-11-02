import type { ModulePage } from "@hubble/module-sdk";

export const cameraPage: ModulePage = {
  id: "ccc",
  label: "CCC",
  navigation: { replaces: "ccc" },
  description:
    "Cyan Camera Control. Camera selection, recording and device feedback share the same saved camera rows.",
  sections: [
    {
      type: "status",
      id: "summary",
      label: "Camera control",
      fields: [
        { id: "enabledCameraCount", label: "Enabled cameras" },
        { id: "singleSwitch", label: "Single switch" },
        { id: "unavailableCameraCount", label: "Unavailable cameras" },
      ],
    },
    {
      type: "controls",
      id: "selection",
      label: "Camera selection",
      fields: [],
      commands: [
        {
          id: "single-switch",
          label: "Toggle single switch",
          kind: "command",
          inputFields: [],
        },
        {
          id: "enable-all-cameras",
          label: "Enable / disable all cameras",
          kind: "command",
          inputFields: [],
        },
      ],
    },
    {
      type: "table",
      id: "cameras",
      label: "Cameras",
      source: "document",
      documentId: "cameras",
      live: { source: "cameraSelection", columns: ["enabled"] },
      maxRows: 512,
      selectionHighlight: "row",
      dataset: { id: "cameras", version: 1 },
      description:
        "Add, delete, duplicate or drag camera rows. A duplicate keeps the RCP address and starts disabled with a blank camera number.",
      workbook: {
        stateKey: "camerasView",
        defaults: { frozenColumns: 1 },
        columns: {
          enabled: { fill: "copy", duplicate: "default", width: 110 },
          rcpIp: { fill: "copy", width: 180 },
          cameraNumber: { fill: "series", duplicate: "default", width: 150 },
          name: { width: 200 },
          connection: { width: 140 },
          recording: { width: 140 },
          message: { width: 280 },
        },
      },
      computed: {
        source: "cameraRows",
        columns: ["name", "connection", "recording", "message"],
        preview: { id: "camera-preview", version: 1 },
      },
      columns: [
        {
          id: "enabled",
          label: "Enabled",
          type: "boolean",
          required: true,
          default: false,
        },
        {
          id: "rcpIp",
          label: "RCP IP",
          type: "text",
          required: false,
          default: "",
        },
        {
          id: "cameraNumber",
          label: "Camera number",
          type: "text",
          required: false,
          default: "",
        },
        {
          id: "name",
          label: "Camera name",
          type: "text",
          required: false,
          default: "",
        },
        {
          id: "connection",
          label: "Connection",
          type: "text",
          required: false,
          default: "",
        },
        {
          id: "recording",
          label: "Recording",
          type: "text",
          required: false,
          default: "",
        },
        {
          id: "message",
          label: "Status",
          type: "text",
          required: false,
          default: "",
        },
      ],
    },
  ],
};
