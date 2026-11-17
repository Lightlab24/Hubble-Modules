import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { ModuleDocumentValueSchema } from "@hubble/module-sdk";
import { actions, feedback, matrix, PAGE_ID } from "./actions.js";
import { defaultDocument, DOCUMENT_ID } from "./model.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  // One Flanders module per workspace; its page lists every monitor.
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.2.0",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-page-icons-v1",
      "module-custom-pages-v1",
      "module-custom-pages-full-page-v1",
      "module-spreadsheet-controls-v1",
      "module-spreadsheet-layout-v1",
      "module-spreadsheet-extended-editing-v1",
      "module-spreadsheet-text-size-v1",
      "module-spreadsheet-workbook-tools-v1",
      "module-documents-v1",
      "host-service-registry-v1",
      "module-fields-v2",
      "module-matrix-v1",
      "module-feedback-observers-v1",
    ],
  },
  configVersion: 1,
  capabilities: [`service.page.${PAGE_ID}`, "host.documents"],
  documents: [
    { id: DOCUMENT_ID, label: "Flanders monitors", version: 1, defaultValue: ModuleDocumentValueSchema.parse(defaultDocument()) },
  ],
  settings: [],
  actions: [...actions],
  feedback,
  matrix,
  pages: [
    {
      id: PAGE_ID,
      label: "Flanders",
      icon: "ui/monitor.svg",
      layout: "full-page",
      sections: [
        {
          type: "custom",
          id: "frontend",
          label: "Flanders monitors",
          entry: "ui/index.html",
          height: 560,
          commands: [
            { id: "snapshot", label: "Read the monitor list" },
            { id: "save", label: "Save the monitor list" },
            { id: "check", label: "Check for other apps" },
            { id: "changes", label: "Wait for the next status change" },
          ],
        },
      ],
    },
  ],
});
