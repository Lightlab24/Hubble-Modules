import { randomUUID } from "node:crypto";
import { ActionAbortedError } from "@hubble/module-contracts/execution";
import {
  legacyExecution,
  legacyResult,
} from "@hubble/module-runtime-helpers/legacy";
import type { HubbleModule } from "@hubble/module-sdk";
import {
  GenericHttpConnectionDefinitionSchema,
  GenericHttpDeleteActionDefinitionSchema,
  GenericHttpGetActionDefinitionSchema,
  GenericHttpPatchActionDefinitionSchema,
  GenericHttpPostActionDefinitionSchema,
  GenericHttpPutActionDefinitionSchema,
} from "./config.js";
import { HttpRequestsActionExecutor } from "./http-requests-action-executor.js";
import { HttpRequestsClient } from "./http-requests-client.js";

const schemas = {
  "generic-http.get": GenericHttpGetActionDefinitionSchema,
  "generic-http.post": GenericHttpPostActionDefinitionSchema,
  "generic-http.put": GenericHttpPutActionDefinitionSchema,
  "generic-http.patch": GenericHttpPatchActionDefinitionSchema,
  "generic-http.delete": GenericHttpDeleteActionDefinitionSchema,
} as const;

export default {
  createInstance(context) {
    if (context.scope.kind !== "connection")
      throw new Error("HTTP requires a connection scope");
    const connection = GenericHttpConnectionDefinitionSchema.parse({
      ...context.settings,
      connectionId: context.scope.connectionId,
      type: "generic-http",
      name: context.settings.name ?? "HTTP Requests",
      enabled: true,
      schemaVersion: 1,
    });
    const client = new HttpRequestsClient();
    const executor = new HttpRequestsActionExecutor([connection], client);
    let started = false;
    return {
      start() {
        started = true;
        context.publishState({
          phase: "ready",
          message:
            "Ready to send requests; endpoint health is checked by each action",
          observedAt: new Date().toISOString(),
          values: {},
        });
      },
      async execute(id, fields, execution) {
        if (!started)
          return {
            status: "failure",
            category: "unavailable",
            message: "HTTP module is stopped",
          };
        const schema = Object.hasOwn(schemas, id)
          ? schemas[id as keyof typeof schemas]
          : undefined;
        if (!schema)
          return {
            status: "failure",
            category: "invalid-config",
            message: "Unknown HTTP action",
          };
        const action = schema.safeParse({
          actionId: randomUUID(),
          actionColumnId: randomUUID(),
          enabled: true,
          ...fields,
          type: id,
          connectionId: connection.connectionId,
          interaction: execution.gesture,
          wrap: execution.wrap,
        });
        if (!action.success)
          return {
            status: "failure",
            category: "invalid-config",
            message: "Invalid HTTP action configuration",
          };
        execution.log({
          level: "debug",
          stage: "dispatch",
          message: "Validated request passed to HTTP client",
        });
        try {
          const result = legacyResult(
            await executor.execute(action.data, legacyExecution(execution)),
            "response",
          );
          execution.log({
            level: result.status === "success" ? "info" : "error",
            stage: result.status === "success" ? "response" : "request-failed",
            message:
              result.status === "success"
                ? result.evidence.summary
                : result.message,
          });
          return result;
        } catch (error) {
          if (error instanceof ActionAbortedError)
            return {
              status: "failure",
              category: "cancelled",
              message:
                "HTTP request cancelled; dispatched work is not replayed",
            };
          return {
            status: "failure",
            category: "internal",
            message: "HTTP request failed unexpectedly",
          };
        }
      },
      dispose() {
        started = false;
        client.stop();
      },
    };
  },
} satisfies HubbleModule;
