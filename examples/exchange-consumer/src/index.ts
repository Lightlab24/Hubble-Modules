import { ModuleStateSchema } from "@hubble/module-sdk";
import type {
  HubbleModule,
  ModulePeer,
  ModuleJsonValue,
} from "@hubble/module-sdk";
export default {
  createInstance(context) {
    let target: ModulePeer | undefined,
      close = async () => {};
    const controller = new AbortController();
    const show = (value: ModuleJsonValue) =>
      context.publishState(
        ModuleStateSchema.parse({
          phase: "ready",
          message: null,
          observedAt: new Date().toISOString(),
          values: { counter: value },
        }),
      );
    const connect = async () => {
      await close();
      const binding = (await context.modules!.bindings(controller.signal)).find(
        (item) => item.name === "Counter" && !item.unresolved,
      );
      target = binding?.target;
      if (!target) return;
      const provider = target;
      close = await context.modules!.subscribe(
        { kind: "data", target: provider, id: "counter", version: 1 },
        async (event) => {
          if (event.kind === "availability") {
            if (!event.available)
              context.publishState({
                phase: "unavailable",
                message: "Counter unavailable",
                observedAt: event.observedAt,
                values: {},
              });
            return;
          }
          if (event.kind !== "data") return;
          show(event.value);
          const count =
            event.value &&
            typeof event.value === "object" &&
            !Array.isArray(event.value)
              ? event.value["count"]
              : undefined;
          if (
            context.settings["autoReset"] === true &&
            typeof count === "number" &&
            count > 10
          ) {
            // The module owns this automation; Hubble only routes an approved public action.
            try {
              await context.modules!.execute(
                provider,
                "reset",
                {},
                controller.signal,
              );
            } catch (error) {
              context.log({
                level: "error",
                stage: "exchange",
                message:
                  error instanceof Error ? error.message : "Reset denied",
              });
            }
          }
        },
        controller.signal,
      );
    };
    return {
      start: connect,
      async execute(id, _fields, execution) {
        if (execution.signal.aborted)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled",
          };
        if (id === "connect") await connect();
        else {
          if (!target)
            return {
              status: "failure",
              category: "unavailable",
              message: "Add the Counter binding and run Connect",
            };
          if (id === "refresh")
            show(
              await context.modules!.query(
                target,
                { id: "counter", version: 1, input: {} },
                execution.signal,
              ),
            );
          else if (id === "increment")
            return context.modules!.execute(
              target,
              "increment",
              {},
              execution.signal,
            );
          else
            return {
              status: "failure",
              category: "invalid-config",
              message: "Unknown action",
            };
        }
        return {
          status: "success",
          evidence: { kind: "local", summary: "Updated the counter view" },
        };
      },
      async dispose() {
        controller.abort();
        await close();
      },
    };
  },
} satisfies HubbleModule;
