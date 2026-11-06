import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.22",
    requiredFeatures: [
      "module-pages-v1",
      "module-custom-pages-v1",
      "module-workspace-instances-v1",
      "module-sliders-v1",
    ],
  },
  configVersion: 1,
  instanceScope: "workspace",
  capabilities: ["service.page.zoom"],
  settings: [
    {
      id: "trim",
      label: "Trim",
      type: "number",
      required: true,
      default: 0,
      min: -12,
      max: 12,
      slider: { step: 0.5, unit: " dB" },
    },
  ],
  actions: [],
  feedback: [],
  pages: [
    {
      id: "settings",
      label: "Slider settings",
      sections: [
        { type: "settings", id: "levels", label: "Levels", fields: ["trim"] },
      ],
    },
    {
      id: "zoom",
      label: "Zoom",
      sections: [
        {
          type: "custom",
          id: "app",
          label: "Zoom",
          entry: "ui/index.html",
          height: 240,
          commands: [{ id: "set-zoom", label: "Set zoom" }],
        },
      ],
    },
  ],
});
