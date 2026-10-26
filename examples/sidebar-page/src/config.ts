import type { ModuleManifest } from "@hubble/module-sdk";
export const settings: ModuleManifest["settings"] = [
  {
    id: "title",
    label: "Workspace label",
    type: "text",
    required: true,
    default: "Studio",
  },
  {
    id: "initialState",
    label: "Initial state",
    type: "boolean",
    required: true,
    default: false,
  },
];
