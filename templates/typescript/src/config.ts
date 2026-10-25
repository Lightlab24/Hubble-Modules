import type { ModuleManifest } from "@hubble/module-sdk";
export const settings: ModuleManifest["settings"] = [
  {
    id: "initialState",
    label: "Initial state",
    type: "boolean",
    required: true,
    default: false,
  },
];
