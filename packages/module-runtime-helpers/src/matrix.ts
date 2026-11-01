import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ModuleDataAssembler } from "@hubble/module-contracts/observations";
import { moduleFeedbackKey, ModuleFeedbackSchema } from "@hubble/module-sdk";
import type {
  HubbleModule,
  ModuleMatrix,
  ModuleValues,
  ModuleFeedback,
  ModuleFeedbackSubscription,
  ModuleState,
  ModuleJsonValue,
} from "@hubble/module-sdk";

export const matrixActionSchema = z
  .object({ type: z.literal("matrix"), values: z.record(z.string(), z.json()) })
  .catchall(z.json());

export interface MatrixObservation {
  readonly state: ModuleState | undefined;
  readonly events: ReadonlyMap<string, ModuleJsonValue>;
  readonly data: ReadonlyMap<string, unknown>;
  readonly feedback: ReadonlyMap<string, ModuleFeedback>;
  readonly fields: ModuleValues;
  readonly settings: ModuleValues;
}

/** Package-side adapter. The host receives no protocol-specific commands or observations. */
export function withModuleMatrix(
  base: HubbleModule,
  descriptor: ModuleMatrix,
  action: (
    fields: ModuleValues,
    settings: ModuleValues,
  ) => { id: string; fields: ModuleValues },
  observe: (
    input: MatrixObservation,
  ) => Pick<ModuleFeedback, "state" | "observedAt" | "appearance"> = () => ({
    state: "inactive",
    observedAt: new Date().toISOString(),
  }),
  dataChannels: readonly string[] = [],
  feedbackIds: readonly string[] = [],
): HubbleModule {
  return {
    ...base,
    createInstance(context) {
      let state: ModuleState | undefined;
      const events = new Map<string, ModuleJsonValue>();
      const data = new Map<string, unknown>();
      const feedback = new Map<string, ModuleFeedback>();
      let feedbackQueued = false;
      const assemblers = new Map(
        dataChannels.map((channel) => [channel, new ModuleDataAssembler()]),
      );
      let subscriptions: readonly ModuleFeedbackSubscription[] = [];
      const emit = () => {
        for (const subscription of subscriptions) {
          let result: Pick<
            ModuleFeedback,
            "state" | "observedAt" | "appearance"
          >;
          try {
            result = observe({
              state,
              events,
              data,
              feedback,
              fields: subscription.fields ?? {},
              settings: context.settings,
            });
          } catch {
            // An invalid row draft must not interrupt transport observations or other rows.
            result = {
              state: "unavailable",
              observedAt: null,
              appearance: { backgroundColor: null, glow: null },
            };
          }
          // Validate before crossing the worker boundary: one invalid observation must
          // clear that row's appearance, without aborting the remaining subscriptions.
          const parsed = ModuleFeedbackSchema.safeParse({
            ...subscription,
            ...result,
          });
          context.publishFeedback(
            parsed.success
              ? parsed.data
              : {
                  ...subscription,
                  state: "unavailable",
                  observedAt: null,
                  appearance: { backgroundColor: null, glow: null, cells: {} },
                },
          );
        }
      };
      const instance = base.createInstance({
        ...context,
        publishState(value) {
          state = value;
          context.publishState(value);
          emit();
        },
        publishFeedback(value) {
          context.publishFeedback(value);
          if (!feedbackIds.includes(value.id)) return;
          const key = moduleFeedbackKey(value.id, value.fields);
          if (value.state === "unavailable") feedback.delete(key);
          else feedback.set(key, value);
          while (feedback.size > 8192)
            feedback.delete(feedback.keys().next().value!);
          if (!feedbackQueued) {
            feedbackQueued = true;
            queueMicrotask(() => {
              feedbackQueued = false;
              emit();
            });
          }
        },
        publishEvent(channel, value) {
          context.publishEvent?.(channel, value);
          const assembler = assemblers.get(channel);
          if (assembler) {
            const decoded = assembler.accept(value);
            if (!decoded.complete) return;
            data.set(channel, decoded.value);
          } else events.set(channel, value);
          emit();
        },
      });
      return {
        ...instance,
        async subscribeFeedback(values, observation) {
          subscriptions = values.filter(
            (item) => item.id === descriptor.feedbackId,
          );
          await instance.subscribeFeedback?.(
            values.filter((item) => item.id !== descriptor.feedbackId),
            observation,
          );
          emit();
        },
        async execute(id, fields, execution) {
          if (id !== descriptor.actionId)
            return instance.execute(id, fields, execution);
          let mapped: ReturnType<typeof action>;
          try {
            mapped = action(fields, context.settings);
          } catch (error) {
            return {
              status: "failure",
              category: "invalid-config",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid Matrix fields",
            };
          }
          return instance.execute(
            mapped.id,
            {
              actionId: fields.actionId ?? randomUUID(),
              actionColumnId: fields.actionColumnId ?? randomUUID(),
              enabled: true,
              ...mapped.fields,
            },
            execution,
          );
        },
        async dispose() {
          subscriptions = [];
          events.clear();
          data.clear();
          feedback.clear();
          await instance.dispose();
        },
      };
    },
  };
}
