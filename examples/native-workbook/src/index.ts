import type { HubbleModule } from "@hubble/module-sdk";
export default {
  createInstance: () => ({
    execute: async () => ({
      status: "failure",
      category: "invalid-config",
      message: "This UI example has no device actions",
    }),
    dispose() {},
  }),
} satisfies HubbleModule;
