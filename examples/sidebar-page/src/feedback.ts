import {
  ModuleTableRowsSchema,
  type ModuleContext,
  type ModuleManifest,
} from "@hubble/module-sdk";
export const feedback: ModuleManifest["feedback"] = [
  {
    id: "active",
    label: "Active",
    description: "Local simulator state",
    fields: [],
  },
];
export function publish(context: ModuleContext, active: boolean) {
  const observedAt = new Date().toISOString();
  const rows = ModuleTableRowsSchema.parse(context.settings.cameras ?? []);
  context.publishState({
    phase: "ready",
    message: "Local example ready",
    observedAt,
    values: {
      active,
      cameraStatus: rows,
      configured: rows.length,
      enabled: rows.filter((row) => row.values.enabled === true).length,
    },
  });
  context.publishFeedback({
    id: "active",
    state: active ? "active" : "inactive",
    observedAt,
  });
}
