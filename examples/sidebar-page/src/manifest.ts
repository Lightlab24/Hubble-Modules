import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { settings } from "./config.js";
import { actions } from "./actions.js";
import { feedback } from "./feedback.js";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: { minimumVersion: "2.0.2", requiredFeatures: ["module-pages-v1"] },
  configVersion: 1,
  capabilities: [],
  settings,
  actions: [...actions],
  feedback,
  pages: [
    {
      id: "monitor",
      label: "Camera monitor",
      sections: [
        {
          type: "table",
          id: "cameraStatus",
          label: "Published cameras",
          source: "state",
          maxRows: 128,
          columns: [
            {
              id: "name",
              label: "Camera name",
              type: "text",
              required: true,
              default: "Camera",
            },
            {
              id: "enabled",
              label: "Enabled",
              type: "boolean",
              required: true,
              default: false,
            },
            {
              id: "cameraNumber",
              label: "Camera number",
              type: "number",
              required: true,
              default: 1,
            },
          ],
        },
      ],
    },
    {
      id: "cameras",
      label: "Camera setup",
      description:
        "A local example of module-owned settings and spreadsheet data.",
      sections: [
        {
          type: "settings",
          id: "setup",
          label: "Settings",
          fields: ["title", "initialState"],
        },
        {
          type: "status",
          id: "summary",
          label: "Module status",
          fields: [
            { id: "configured", label: "Configured cameras" },
            { id: "enabled", label: "Enabled cameras" },
          ],
        },
        {
          type: "table",
          id: "cameras",
          label: "Cameras",
          source: "settings",
          maxRows: 128,
          description:
            "Each row has a stable ID. This example makes no network connections.",
          columns: [
            {
              id: "name",
              label: "Camera name",
              type: "text",
              required: true,
              default: "Camera",
            },
            {
              id: "enabled",
              label: "Enabled",
              type: "boolean",
              required: true,
              default: false,
            },
            {
              id: "cameraNumber",
              label: "Camera number",
              type: "number",
              required: true,
              default: 1,
              min: 1,
              max: 9999,
            },
            {
              id: "mode",
              label: "Mode",
              type: "choice",
              required: true,
              default: "auto",
              choices: [
                { id: "auto", label: "Automatic", group: "Exposure" },
                { id: "manual", label: "Manual", group: "Exposure" },
              ],
            },
          ],
        },
      ],
    },
  ],
});
