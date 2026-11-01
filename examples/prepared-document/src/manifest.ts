import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-table-workbook-v1",
      "module-documents-v1",
      "host-service-registry-v1",
      "module-exchange-v1",
      "module-document-preparation-v1",
      "module-document-migrations-v1",
      "module-table-duplicate-policy-v1",
    ],
  },
  capabilities: ["host.documents"],
  settings: [],
  actions: [],
  feedback: [],
  documents: [
    {
      id: "list",
      label: "Prepared list",
      version: 2,
      migrate: true,
      prepare: { id: "prepare-list", version: 1 },
      defaultValue: {
        items: [
          { id: "first", values: { name: "First", enabled: false, note: "" } },
        ],
        itemsView: { version: 1 },
      },
    },
  ],
  exchange: {
    data: [
      { id: "prepare-list", label: "Validate list", version: 1, query: true },
    ],
  },
  pages: [
    {
      id: "list",
      label: "Prepared list",
      sections: [
        {
          type: "table",
          id: "items",
          label: "Items",
          source: "document",
          documentId: "list",
          maxRows: 64,
          workbook: {
            stateKey: "itemsView",
            columns: { enabled: { duplicate: "default", fill: "copy" } },
          },
          columns: [
            {
              id: "name",
              label: "Name",
              type: "text",
              default: "New",
              required: true,
            },
            {
              id: "enabled",
              label: "Enabled",
              type: "boolean",
              default: false,
              required: true,
            },
            {
              id: "note",
              label: "Note",
              type: "text",
              default: "",
              required: false,
            },
          ],
        },
      ],
    },
  ],
});
