import { defineModuleManifest } from "@hubble/module-sdk/authoring";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  host: {
    minimumVersion: "2.0.8",
    requiredFeatures: ["module-pages-v1", "module-table-workbook-v1"],
  },
  capabilities: [],
  settings: [],
  actions: [],
  feedback: [],
  pages: [
    {
      id: "plan",
      label: "Plan",
      sections: [
        {
          type: "table",
          id: "rows",
          label: "Plan",
          source: "settings",
          maxRows: 64,
          workbook: {
            stateKey: "planView",
            columns: { name: { fill: "series" }, value: { formula: true } },
          },
          columns: [
            {
              id: "name",
              label: "Name",
              type: "text",
              required: true,
              default: "Camera 1",
            },
            {
              id: "value",
              label: "Value",
              type: "number",
              required: true,
              default: 1,
            },
          ],
        },
      ],
    },
  ],
});
