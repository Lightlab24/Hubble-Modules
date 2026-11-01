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
import {
  HttpRequestsClient,
  resolveHttpRequestUrl,
  HTTP_REQUESTS_GLOBAL_CAPACITY,
  HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
} from "./http-requests-client.js";
import { matrixRequest } from "./matrix.js";

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
      subscribeFeedback(subscriptions) {
        for (const subscription of subscriptions)
          context.publishFeedback({
            ...subscription,
            state: "inactive",
            observedAt: new Date().toISOString(),
          });
      },
      async execute(id, fields, execution) {
        if (id === "matrix") {
          try {
            const request = matrixRequest(fields);
            id = request.id;
            fields = request.fields;
          } catch (error) {
            return {
              status: "failure",
              category: "invalid-config",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid HTTP Matrix request",
            };
          }
        }
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
        if (!context.services)
          return {
            status: "failure",
            category: "unavailable",
            message: "The host resource service is unavailable",
          };
        let origin: string;
        try {
          origin = resolveHttpRequestUrl(
            connection.baseUrl,
            action.data.requestTarget,
          ).origin;
        } catch {
          return {
            status: "failure",
            category: "invalid-config",
            code: "generic_http_invalid_target",
            message: "HTTP request target is invalid",
          };
        }
        execution.log({
          level: "debug",
          stage: "dispatch",
          message: "Validated request passed to HTTP client",
        });
        let leaseId: string | undefined;
        try {
          const reservation = await context.services.request(
            "resources",
            1,
            {
              method: "acquire",
              ttlMs: connection.requestTimeoutMs + 1000,
              claims: [
                { key: "requests", limit: HTTP_REQUESTS_GLOBAL_CAPACITY },
                {
                  key: `origin:${origin}`,
                  limit: HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
                },
              ],
            },
            execution.signal,
          );
          if (!reservation?.granted)
            return {
              status: "failure",
              category: "rejected",
              code: "generic_http_capacity_exceeded",
              message: "HTTP request capacity has been reached",
            };
          leaseId = reservation.leaseId;
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
        } finally {
          if (leaseId) {
            try {
              await context.services.request("resources", 1, {
                method: "release",
                leaseId,
              });
            } catch {
              context.log({
                level: "error",
                stage: "resource-release",
                message:
                  "Request finished; host operation cleanup will release its capacity",
              });
            }
          }
        }
      },
      dispose() {
        started = false;
        client.stop();
      },
    };
  },
} satisfies HubbleModule;
