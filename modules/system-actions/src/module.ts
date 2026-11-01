import { randomUUID } from "node:crypto";
import { KeyboardBridgeResponseSchema } from "@hubble/module-contracts/keyboard";
import { legacyExecution } from "@hubble/module-runtime-helpers/legacy";
import { matrix, matrixAction } from "./matrix.js";
import { systemFeedback } from "./feedback.js";
import { systemDiscovery } from "./discovery.js";
import { ModuleHostServiceRequests } from "@hubble/module-sdk";
import type { HubbleModule } from "@hubble/module-sdk";
import {
  ActionDefinitionSchema,
  ConnectionDefinitionsSchema,
} from "./config.js";
import { KeyboardActionExecutor } from "./keyboard-action-executor.js";

export default {
  createInstance(context) {
    if (
      context.scope.kind !== "host" ||
      context.scope.capabilityId !== "system-actions"
    )
      throw new Error("System actions require their host capability scope");
    if (!context.services)
      throw new Error("Native host services are unavailable");
    const discover = systemDiscovery(context.services);
    let feedbackEpoch = 0,
      applicationReadAt = 0;
    let applications = new Map<string, string>();
    const executor = new KeyboardActionExecutor(
      ConnectionDefinitionsSchema.parse(context.settings.connections ?? []),
      async (request) => {
        return KeyboardBridgeResponseSchema.parse(
          await context.services!.request(
            "keyboard",
            1,
            ModuleHostServiceRequests.keyboard.parse(request),
          ),
        );
      },
    );
    return {
      start() {
        context.publishState({
          phase: "ready",
          message: null,
          observedAt: new Date().toISOString(),
          values: {},
        });
      },
      discoverChoices: discover,
      async subscribeFeedback(subscriptions, { signal }) {
        const epoch = ++feedbackEpoch;
        if (subscriptions.length && Date.now() - applicationReadAt > 30000) {
          try {
            const response = await context.services!.request(
              "keyboard",
              1,
              { operation: "list-applications" },
              signal,
            );
            if (epoch !== feedbackEpoch || signal.aborted) return;
            applications = new Map(
              [
                ...response.applications,
                ...(response.installedApplications ?? []),
              ].map((app) => [app.bundleId, app.name]),
            );
            applicationReadAt = Date.now();
          } catch {
            /* Keep local labels and saved values when native discovery is unavailable. */
          }
        }
        if (epoch !== feedbackEpoch || signal.aborted) return;
        for (const subscription of subscriptions)
          context.publishFeedback(systemFeedback(subscription, applications));
      },
      async execute(id, fields, execution) {
        if (id === matrix.actionId) {
          try {
            const mapped = matrixAction(fields);
            id = mapped.id;
            fields = mapped.fields;
          } catch (error) {
            return {
              status: "failure",
              category: "invalid-config",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid system action",
            };
          }
        }
        const action = ActionDefinitionSchema.parse({
          actionId: randomUUID(),
          actionColumnId: randomUUID(),
          enabled: true,
          connectionId: null,
          ...fields,
          ...(id === "system.select-menu-item" &&
          typeof fields.menuPath === "string" &&
          !fields.menuPath.trim().startsWith("[")
            ? {
                menuPath: JSON.stringify(
                  fields.menuPath
                    .split(">")
                    .map((title) => ({ title: title.trim() })),
                ),
              }
            : {}),
          type: id,
          interaction: execution.gesture,
          wrap: execution.wrap,
        });
        if (
          action.type !== "keyboard.send-shortcut" &&
          action.type !== "system.activate-application" &&
          action.type !== "system.open-application" &&
          action.type !== "system.select-menu-item"
        )
          return {
            status: "failure",
            category: "invalid-config",
            message: "Unsupported system action",
          };
        const result = await executor.execute(
          action,
          legacyExecution(execution),
        );
        if (result.outcome === "failure")
          return {
            status: "failure",
            category: "rejected",
            code: result.errorCode,
            message: result.errorMessage,
          };
        execution.log({
          level: "info",
          stage: "native-response",
          message:
            "Signed native bridge reported the system operation completed",
        });
        return {
          status: "success",
          evidence: {
            kind: "response",
            summary:
              "Signed native bridge reported the requested operation completed",
          },
        };
      },
      dispose() {
        feedbackEpoch++;
        applications.clear();
      },
    };
  },
} satisfies HubbleModule;
