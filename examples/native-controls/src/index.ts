import { createHash } from "node:crypto";
import {
  ModuleHostServiceRequests,
  type HubbleModule,
  type ModuleValues,
} from "@hubble/module-sdk";
export default {
  createInstance(context) {
    const services = context.services;
    if (!services) throw Error("Native services are unavailable");
    return {
      start() {
        context.publishState({
          phase: "ready",
          message: null,
          observedAt: new Date().toISOString(),
          values: {},
        });
      },
      async discoverChoices(query, { signal }) {
        if (query.provider !== "applications") throw Error("Unknown provider");
        const response = await services.request(
          "keyboard",
          1,
          { operation: "list-applications" },
          signal,
        );
        if (!response.available)
          throw Error(
            response.message ?? "Application discovery is unavailable",
          );
        const choices = response.applications
          .map((app) => ({ id: app.bundleId, label: app.name.slice(0, 160) }))
          .filter(
            (app) =>
              app.id.length <= 160 &&
              `${app.id} ${app.label}`
                .toLowerCase()
                .includes(query.search.toLowerCase()),
          );
        const revision = createHash("sha256")
          .update(JSON.stringify(choices))
          .digest("hex");
        const offset = query.cursor === null ? 0 : Number(query.cursor);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > choices.length ||
          (query.cursor && query.catalogRevision !== revision)
        )
          throw Error("Refresh application choices");
        return {
          revision,
          choices: choices.slice(offset, offset + query.limit),
          nextCursor:
            offset + query.limit < choices.length
              ? String(offset + query.limit)
              : null,
        };
      },
      subscribeFeedback(subscriptions) {
        for (const item of subscriptions)
          context.publishFeedback({
            ...item,
            state: "inactive",
            observedAt: new Date().toISOString(),
          });
      },
      async execute(id, fields, execution) {
        if (id !== "send")
          return {
            status: "failure",
            category: "invalid-config",
            message: "Unknown action",
          };
        const values = fields.values as ModuleValues | undefined;
        let request;
        try {
          request = ModuleHostServiceRequests.keyboard.parse({
            operation: "send-shortcut",
            key: values?.["module.chord"],
            modifiers: String(values?.["module.modifiers"] ?? "")
              .split("+")
              .filter(Boolean),
            target: {
              mode: "application",
              bundleId: values?.["module.application"],
            },
          });
        } catch {
          return {
            status: "failure",
            category: "invalid-config",
            message: "Choose a shortcut and a running application",
          };
        }
        const result = await services.request(
          "keyboard",
          1,
          request,
          execution.signal,
        );
        return result.sent
          ? {
              status: "success",
              evidence: {
                kind: "response",
                summary: "Native bridge accepted the shortcut",
              },
            }
          : {
              status: "failure",
              category: "rejected",
              message: result.message ?? "Native shortcut was not sent",
            };
      },
      dispose() {},
    };
  },
} satisfies HubbleModule;
