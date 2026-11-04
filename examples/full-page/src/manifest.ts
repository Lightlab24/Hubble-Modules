import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.18",
    requiredFeatures: [
      "module-pages-v1",
      "module-custom-pages-v1",
      "module-custom-pages-full-page-v1",
      "module-workspace-instances-v1",
    ],
  },
  configVersion: 1,
  instanceScope: "workspace",
  capabilities: ["service.page.dashboard"],
  settings: [],
  actions: [],
  feedback: [],
  pages: [
    {
      id: "dashboard",
      label: "Full page",
      layout: "full-page",
      sections: [
        {
          type: "custom",
          id: "app",
          label: "Package application",
          entry: "ui/index.html",
          commands: [{ id: "increment", label: "Call local backend" }],
        },
      ],
    },
  ],
});
