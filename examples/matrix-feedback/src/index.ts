import {
  decodeModuleChoice,
  moduleFieldDefault,
  type HubbleModule,
} from "@hubble/module-sdk";
import manifest from "./manifest.js";

const definition = manifest.matrix!;
export default {
  createInstance(context) {
    return {
      start() {},
      dispose() {},
      execute() {
        return {
          status: "success",
          evidence: {
            kind: "local",
            summary: "The meter observes its saved values.",
          },
        };
      },
      subscribeFeedback(subscriptions) {
        for (const request of subscriptions) {
          if (request.id !== definition.feedbackId) continue;
          const values = request.fields.values as Record<string, unknown>;
          const settings = request.fields.settings as Record<string, unknown>;
          const choice = decodeModuleChoice(
            definition.fields.find((field) => field.id === "actionType")!
              .choiceEditor!,
            String(values.actionType),
          );
          const active =
            Number(values["module.level"]) >=
            Number(
              settings.threshold ??
                moduleFieldDefault(definition.columnSettings[0]!),
            );
          const colors = choice?.parameters.colors as string[] | undefined;
          const enabled = values.enabled !== false && !!choice;
          context.publishFeedback({
            ...request,
            observedAt: new Date().toISOString(),
            state: enabled ? (active ? "active" : "inactive") : "unavailable",
            appearance: {
              backgroundColor: enabled
                ? (colors?.[active ? 0 : 1] ?? null)
                : null,
              glow:
                enabled && active && choice?.parameters.pulse === true
                  ? { color: "#FFFFFF", cycleMs: 1500 }
                  : null,
              cells: {
                "module.level": {
                  label: `${String(values["module.level"])}%`,
                  inputSource: String(values["module.level"]),
                  color: null,
                },
              },
            },
          });
        }
      },
    };
  },
} satisfies HubbleModule;
