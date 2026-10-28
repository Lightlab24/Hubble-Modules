import { defineModuleManifest } from "@hubble/module-sdk/authoring";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  savedActionVersion: 2,
  host: {
    minimumVersion: "2.0.2",
    requiredFeatures: [
      "module-pages-v1",
      "module-fields-v2",
      "module-choices-v2",
      "module-saved-actions-v1",
      "host-service-registry-v1",
    ],
  },
  capabilities: [],
  settings: [
    {
      id: "advanced",
      label: "Advanced",
      type: "boolean",
      required: true,
      default: false,
    },
    {
      id: "region",
      label: "Region",
      type: "choice",
      required: true,
      default: "studio",
      choices: [
        { id: "studio", label: "Studio" },
        { id: "stage", label: "Stage" },
      ],
    },
    {
      id: "sources",
      label: "Sources",
      type: "multi-choice",
      required: false,
      default: [],
      choices: [],
      choiceProvider: "sources",
      maxItems: 4,
    },
    {
      id: "policy",
      label: "Policy",
      type: "object",
      required: false,
      default: {},
      visibleWhen: [{ field: "advanced", equals: true }],
      fields: [
        {
          id: "threshold",
          label: "Threshold",
          type: "number",
          required: true,
          default: 2.5,
          min: 0,
          max: 10,
          validation: { message: "Use a threshold from zero to ten." },
        },
      ],
    },
    {
      id: "routes",
      label: "Routes",
      type: "array",
      required: false,
      default: [],
      maxItems: 8,
      item: {
        id: "name",
        label: "Route name",
        type: "text",
        default: "New route",
        required: true,
      },
    },
  ],
  actions: [
    {
      id: "set-active",
      label: "Set active",
      description: "Update the example's local active state.",
      fields: [
        {
          id: "active",
          label: "Active",
          type: "boolean",
          required: true,
          default: false,
        },
      ],
      completion: "local",
      timeoutMs: 1000,
    },
  ],
  feedback: [
    {
      id: "active",
      label: "Active",
      description: "Reports the example's current local active state.",
      fields: [],
    },
  ],
  pages: [
    {
      id: "setup",
      label: "Independent API",
      sections: [
        {
          type: "settings",
          id: "settings",
          label: "Settings",
          fields: ["advanced", "region", "sources", "policy", "routes"],
        },
        {
          type: "status",
          id: "status",
          label: "Status",
          fields: [{ id: "active", label: "Active" }],
        },
      ],
    },
  ],
});
