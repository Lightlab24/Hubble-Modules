import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import {
  MODULE_SPREADSHEET_CONTROLS_FEATURE,
  MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE,
  MODULE_SPREADSHEET_COLUMN_EDITOR_FEATURE,
  MODULE_SPREADSHEET_LAYOUT_FEATURE,
  MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE,
  MODULE_SPREADSHEET_WORKBOOK_TOOLS_FEATURE,
  MODULE_SPREADSHEET_TOOLBAR_SECTIONS_FEATURE,
} from "@hubble/module-sdk/spreadsheet-controls";
import { defaultPatch } from "./model.js";
import { documentId, patchTable } from "./table.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.18",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-custom-pages-v1",
      MODULE_SPREADSHEET_CONTROLS_FEATURE,
      MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE,
      MODULE_SPREADSHEET_COLUMN_EDITOR_FEATURE,
      MODULE_SPREADSHEET_LAYOUT_FEATURE,
      MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE,
      MODULE_SPREADSHEET_WORKBOOK_TOOLS_FEATURE,
      MODULE_SPREADSHEET_TOOLBAR_SECTIONS_FEATURE,
      "module-table-workbook-v1",
      "module-workbook-formula-choice-labels-v1",
      "module-table-spreadsheet-v1",
      "module-workbook-field-rules-v1",
      "module-optional-numbers-v1",
      "module-fields-v2",
      "module-documents-v1",
      "host-service-registry-v1",
      "module-exchange-v1",
      "module-document-preparation-v1",
    ],
  },
  capabilities: ["host.documents", "service.page.patch"],
  settings: [],
  actions: [],
  feedback: [],
  documents: [
    {
      id: documentId,
      label: "Patch data",
      version: 1,
      defaultValue: defaultPatch,
      prepare: { id: "validate-patch", version: 1 },
    },
  ],
  exchange: {
    data: [
      {
        id: "validate-patch",
        label: "Validate patch data",
        version: 1,
        query: true,
      },
    ],
  },
  pages: [
    {
      id: "patch",
      label: "Patch Sheet",
      sections: [
        {
          type: "custom",
          id: "sheet",
          label: "Custom patch layout",
          entry: "ui/index.html",
          height: 600,
          commands: [
            { id: "choices", label: "Load routes" },
            { id: "edit", label: "Apply batch" },
            { id: "save-workbook", label: "Save custom workbook" },
            { id: "snapshot", label: "Read patch" },
          ],
        },
      ],
    },
    { id: "workbook", label: "Patch Workbook", sections: [patchTable] },
  ],
});
