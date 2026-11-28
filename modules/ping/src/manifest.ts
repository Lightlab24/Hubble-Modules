import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { ModuleDocumentValueSchema } from "@hubble/module-sdk";
import { actions, feedback, matrix, PAGE_ID } from "./actions.js";
import { defaultDocument, DOCUMENT_ID } from "./model.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  // One Ping module per workspace; its page lists every device.
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.3.0",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-page-icons-v1",
      "module-custom-pages-v1",
      "module-custom-pages-full-page-v1",
      "module-theme-v1",
      "module-controls-v1",
      "module-spreadsheet-controls-v1",
      "module-spreadsheet-layout-v1",
      "module-spreadsheet-extended-editing-v1",
      "module-spreadsheet-text-size-v1",
      "module-spreadsheet-workbook-tools-v1",
      "module-spreadsheet-column-editor-v1",
      "module-documents-v1",
      "host-service-registry-v1",
      "module-fields-v2",
      "module-matrix-v1",
      "module-matrix-row-fields-v1",
      "module-feedback-observers-v1",
      "module-feedback-triggers-v1",
      "module-feedback-trigger-groups-v1",
      // Lets an alert ask for a notification without the Dock bounce.
      "host-alert-choices-v1",
      // The alert count on the Ping tab in the sidebar.
      "module-page-badges-v1",
      // The page can be open in several HubDash windows at once.
      "module-page-windows-v1",
      // Where each window was last left is kept on this computer, out of the workspace.
      "module-runtime-directory-v1",
    ],
  },
  configVersion: 1,
  capabilities: [`service.page.${PAGE_ID}`, "host.documents"],
  documents: [{ id: DOCUMENT_ID, label: "Ping devices", version: 1, defaultValue: ModuleDocumentValueSchema.parse(defaultDocument()) }],
  settings: [],
  actions: [...actions],
  feedback,
  matrix,
  pages: [
    {
      id: PAGE_ID,
      label: "Ping",
      icon: "ui/ping.svg",
      // Devices that are Offline or Slow right now, from the published state.
      badge: { value: "alerts" },
      layout: "full-page",
      sections: [
        {
          type: "custom",
          id: "frontend",
          label: "Ping devices",
          entry: "ui/index.html",
          height: 560,
          // Live in every window at once: each copy follows the others, and none is refused for
          // being behind or undoes another's work (merge.ts, test/windows.test.ts).
          windows: true,
          // Each sheet can open in a window of its own, from the sidebar's Open in its own window ›.
          // The worker publishes them as windowParts; a sheet's window shows only that sheet.
          parts: { value: "windowParts" },
          commands: [
            { id: "snapshot", label: "Read the device list" },
            { id: "save", label: "Save the device list" },
            { id: "live", label: "Read the latest ping results" },
            { id: "clear-history", label: "Clear the ping history" },
            { id: "place", label: "Remember where this window was left" },
          ],
        },
      ],
    },
  ],
});
