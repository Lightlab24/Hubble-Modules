import type { ModuleContext, ModuleInstance } from "@hubble/module-sdk";
import { createActions } from "./actions.js";
import { publish } from "./feedback.js";
export function createInstance(context: ModuleContext): ModuleInstance {
  let active = context.settings.initialState === true;
  let started = false;
  const actions = createActions((value) => {
    active = value;
    publish(context, active);
  });
  return {
    start() {
      started = true;
      publish(context, active);
    },
    async execute(id, fields, execution) {
      if (!started)
        return {
          status: "failure",
          category: "unavailable",
          message: "Module is stopped",
        };
      return actions.execute(id, fields, execution);
    },
    dispose() {
      if (!started) return;
      started = false;
      context.publishFeedback({
        id: "active",
        state: "unavailable",
        observedAt: null,
      });
    },
  };
}
