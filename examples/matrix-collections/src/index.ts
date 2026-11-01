import {
  parseModuleOrderedNumbers,
  parseModuleColorPalette,
  type HubbleModule,
  type ModuleValues,
} from "@hubble/module-sdk";
import { ordered, palette } from "./manifest.js";

function read(fields: ModuleValues) {
  const values = fields.values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Missing row");
  const cues = parseModuleOrderedNumbers(values["module.cues"], ordered);
  const colors = parseModuleColorPalette(
    String(values["module.colors"]),
    palette.length,
  );
  if (!cues.success || !colors)
    throw new Error("Correct the cue order and colours");
  return {
    cues: cues.values,
    color:
      cues.values.length === 1
        ? colors.singletonColor
        : (colors.cycleColors ?? palette)[0]!,
  };
}
export default {
  createInstance(context) {
    return {
      start() {},
      dispose() {},
      discoverChoices(query) {
        if (query.provider !== "presets") throw new Error("Unknown provider");
        const choices = [
          {
            id: "forward",
            label: "Forward",
            values: { "module.cues": "1, 2" },
          },
          {
            id: "reverse",
            label: "Reverse",
            values: { "module.cues": "2, 1" },
          },
        ].filter((choice) =>
          choice.label.toLowerCase().includes(query.search.toLowerCase()),
        );
        const offset = query.cursor === null ? 0 : Number(query.cursor);
        if (!Number.isInteger(offset) || offset < 0 || offset > choices.length)
          throw new Error("Refresh choices");
        return {
          revision: "presets-1",
          choices: choices.slice(offset, offset + query.limit),
          nextCursor:
            offset + query.limit < choices.length
              ? String(offset + query.limit)
              : null,
        };
      },
      execute(id, fields, execution) {
        if (execution.signal.aborted)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled",
          };
        if (id !== "apply")
          return {
            status: "failure",
            category: "invalid-config",
            message: "Unknown action",
          };
        try {
          const { cues } = read(fields);
          context.publishState({
            phase: "ready",
            message: null,
            observedAt: new Date().toISOString(),
            values: { cues, offset: context.settings.offset ?? null },
          });
          return {
            status: "success",
            evidence: { kind: "local", summary: "Local cue order recorded" },
          };
        } catch (error) {
          return {
            status: "failure",
            category: "invalid-config",
            message: String(error),
          };
        }
      },
      subscribeFeedback(subscriptions) {
        for (const subscription of subscriptions) {
          try {
            context.publishFeedback({
              ...subscription,
              state: "active",
              observedAt: new Date().toISOString(),
              appearance: { backgroundColor: read(subscription.fields).color },
            });
          } catch {
            context.publishFeedback({
              ...subscription,
              state: "unavailable",
              observedAt: null,
              appearance: { backgroundColor: null },
            });
          }
        }
      },
    };
  },
} satisfies HubbleModule;
