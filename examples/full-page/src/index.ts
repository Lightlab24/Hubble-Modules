import type { HubbleModule } from "@hubble/module-sdk";

export default {
  createInstance(context) {
    let count = 0;
    let disposed = false;
    const publish = () =>
      context.publishState({
        phase: "ready",
        message: null,
        observedAt: new Date().toISOString(),
        values: { count },
      });
    return {
      start: publish,
      call(method, value, execution) {
        execution.signal.throwIfAborted();
        if (disposed) throw new Error("Instance disposed");
        if (
          method !== "page.dashboard" ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.commandId !== "increment"
        )
          throw new Error("Unknown page command");
        count++;
        publish();
        return { count, message: `Reply: ${count}` };
      },
      async execute() {
        throw new Error("No actions declared");
      },
      dispose() {
        disposed = true;
      },
    };
  },
} satisfies HubbleModule;
