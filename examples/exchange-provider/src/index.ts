import type { HubbleModule } from "@hubble/module-sdk";
// A counter only: no sockets, filesystem, keyboard, cameras or other equipment.
export default {
  createInstance(context) {
    let count = 0;
    const publish = () => context.modules!.publish("counter", 1, { count });
    return {
      async start() {
        await publish();
      },
      queryData(query) {
        if (query.id !== "counter" || query.version !== 1)
          throw new Error("Unknown data contract");
        return Promise.resolve({ count });
      },
      async execute(id, _fields, execution) {
        if (execution.signal.aborted)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled",
          };
        if (id === "increment") count++;
        else if (id === "reset") count = 0;
        else
          return {
            status: "failure",
            category: "invalid-config",
            message: "Unknown action",
          };
        await publish();
        return {
          status: "success",
          evidence: { kind: "local", summary: "Updated the inert counter" },
        };
      },
      async dispose() {},
    };
  },
} satisfies HubbleModule;
