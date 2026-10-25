import { createActionRegistry } from "@hubble/module-sdk/authoring";
import type { ModuleManifest } from "@hubble/module-sdk";
export const actions = [
  {
    id: "set-state" as const,
    label: "Set state",
    description: "Set the local simulator state",
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
] satisfies ModuleManifest["actions"];
export function createActions(update: (active: boolean) => void) {
  return createActionRegistry(actions, {
    "set-state": (fields) => {
      update(fields.active === true);
      return {
        status: "success",
        evidence: { kind: "local", summary: "Local state updated" },
      };
    },
  });
}
