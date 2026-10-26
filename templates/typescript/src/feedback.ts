import type { ModuleContext, ModuleManifest } from "@hubble/module-sdk";
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
  context.publishState({
    phase: "ready",
    message: null,
    observedAt,
    values: { active },
  });
  context.publishFeedback({
    id: "active",
    state: active ? "active" : "inactive",
    observedAt,
  });
}
