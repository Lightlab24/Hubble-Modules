import { setTimeout as delay } from "node:timers/promises";
import {
  createModuleDocumentClient,
  createModuleDatasetClient,
  createModuleHelperClient,
  ModuleDatasetReferenceSchema,
  ModuleDatasetRequestSchema,
  ModuleDocumentConflictError,
  type HubbleModule,
  type ModuleDocumentSnapshot,
  type ModuleFeedbackSubscription,
  type ModuleJsonValue,
} from "@hubble/module-sdk";

export default {
  createInstance(context) {
    if (!context.services)
      throw new Error("This module requires the documents service");
    const documents = createModuleDocumentClient(context.services);
    const datasets = createModuleDatasetClient(context.services);
    const renderer = createModuleHelperClient(context.services, "renderer");
    const lifetime = new AbortController();
    let count = 0;
    let document: ModuleDocumentSnapshot | null = null;
    let watchError: string | null = null;
    let watching: Promise<void> | undefined;
    let subscriptions: readonly ModuleFeedbackSubscription[] = [];
    let saves: Promise<unknown> = Promise.resolve();
    const body = (value: ModuleJsonValue) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid saved design");
      return value as Record<string, ModuleJsonValue>;
    };
    const publish = () => {
      const value = document ? body(document.value) : {};
      context.publishState({
        phase: watchError ? "error" : "ready",
        message: watchError,
        observedAt: new Date().toISOString(),
        values: {
          count,
          documentRevision: document?.revision ?? null,
          rowCount: Array.isArray(value.labels) ? value.labels.length : 0,
        },
      });
      for (const subscription of subscriptions)
        context.publishFeedback({
          ...subscription,
          state: count ? "active" : "inactive",
          observedAt: new Date().toISOString(),
        });
    };
    const textValue = (text: unknown) => {
      if (typeof text !== "string" || text.length > 200)
        throw new Error("Enter up to 200 characters");
      return text;
    };
    const render = async (input: unknown, signal: AbortSignal) => {
      signal.throwIfAborted();
      document = await documents.read("design", signal);
      const saved = body(document.value);
      let value = input ?? body(saved.design ?? {}).title;
      if (input === undefined && saved.sourceLink) {
        const reference = ModuleDatasetReferenceSchema.parse(saved.sourceLink);
        const result = await datasets.readReference(
          reference,
          { limit: 1 },
          signal,
        );
        if (result.status !== "data")
          throw new Error(
            `Linked data unavailable: ${result.status === "unavailable" ? result.reason : result.status}`,
          );
        const column = reference.columnIds?.[0],
          row = result.rows[0];
        if (!column || !row || row.errors[column])
          throw new Error(row?.errors[column] ?? "Linked cell is unavailable");
        value = String(row.values[column] ?? "");
      }
      const text = textValue(value);
      const result = await renderer.call("render", { text }, signal);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        typeof result.text !== "string"
      )
        throw new Error("Invalid helper render result");
      count++;
      publish();
      return { text: result.text, count };
    };
    const saveField = (
      key: "design" | "sourceLink",
      nextValue: ModuleJsonValue,
      signal: AbortSignal,
    ) => {
      const next = saves
        .catch(() => undefined)
        .then(async () => {
          signal.throwIfAborted();
          let current = await documents.read("design", signal);
          const before = JSON.stringify(body(current.value)[key]);
          for (let attempt = 0; ; attempt++) {
            try {
              document = await documents.write(
                current,
                { ...body(current.value), [key]: nextValue },
                signal,
              );
              publish();
              return document;
            } catch (error) {
              if (
                !(error instanceof ModuleDocumentConflictError) ||
                attempt >= 2 ||
                JSON.stringify(body(error.document.value)[key]) !== before
              )
                throw error;
              current = error.document;
            }
          }
        });
      saves = next;
      return next;
    };
    // Some hosts refuse a watch briefly right after a version switch, and other
    // failures can happen on any host, so one failure must not end it. Only a
    // failure that lasts is shown.
    const watchDesign = async () => {
      let failures = 0;
      while (!lifetime.signal.aborted) {
        const opened = Date.now();
        try {
          for await (const next of documents.watch("design", lifetime.signal)) {
            document = next;
            watchError = null;
            publish();
          }
        } catch (error) {
          if (lifetime.signal.aborted) return;
          // A watch that stayed open was working, so this failure starts a new count.
          failures = Date.now() - opened > 5000 ? 1 : failures + 1;
          const message = String(error).slice(0, 1000);
          context.log({
            level: failures > 1 ? "error" : "info",
            stage: "document-watch",
            message,
          });
          if (failures > 1) {
            watchError = message;
            publish();
          }
          await delay(Math.min(5000, 250 * 2 ** (failures - 1)), undefined, {
            signal: lifetime.signal,
          }).catch(() => {});
        }
      }
    };
    return {
      async start() {
        const helper = await renderer.start(lifetime.signal);
        if (helper.status !== "helper" || helper.state !== "ready")
          throw new Error("Package renderer is unavailable");
        document = await documents.read("design", lifetime.signal);
        publish();
        watching = watchDesign();
      },
      subscribeFeedback(value) {
        subscriptions = value;
        publish();
      },
      async call(method, request, execution) {
        if (
          method !== "page.designer" ||
          !request ||
          typeof request !== "object" ||
          Array.isArray(request)
        )
          throw new Error("Unknown page command");
        const command = request as Record<string, ModuleJsonValue>;
        if (command.commandId === "read")
          return documents.read("design", execution.signal);
        if (command.commandId === "sources") {
          const input = ModuleDatasetRequestSchema.parse({
            ...body(command.value ?? {}),
            method: "list",
          });
          if (input.method !== "list") throw new Error("Invalid catalog query");
          return datasets.list(input, execution.signal);
        }
        if (command.commandId === "source-rows") {
          const input = ModuleDatasetRequestSchema.parse({
            ...body(command.value ?? {}),
            method: "read",
          });
          if (input.method !== "read") throw new Error("Invalid source query");
          return datasets.read(input, execution.signal);
        }
        if (command.commandId === "preview-linked")
          return render(undefined, execution.signal);
        if (command.commandId === "link-source") {
          const reference = ModuleDatasetReferenceSchema.parse(command.value);
          if (
            reference.columnIds?.length !== 1 ||
            reference.rowIds?.length !== 1
          )
            throw new Error("Choose one source cell");
          const result = await datasets.readReference(
            reference,
            { limit: 1 },
            execution.signal,
          );
          if (
            result.status !== "data" ||
            result.rows[0]?.errors[reference.columnIds[0]!]
          )
            throw new Error("The selected source cell is unavailable");
          await saveField("sourceLink", reference, execution.signal);
          return render(undefined, execution.signal);
        }
        if (command.commandId !== "render")
          throw new Error("Unknown page command");
        const text = textValue(body(command.value ?? null).text);
        // This module serializes canvas commands; host revisions arbitrate other editors.
        const next = saves
          .catch(() => undefined)
          .then(async () => {
            execution.signal.throwIfAborted();
            let current = await documents.read("design", execution.signal);
            const title = body(body(current.value).design ?? {}).title;
            for (let attempt = 0; ; attempt++) {
              const value = body(current.value);
              try {
                document = await documents.write(
                  current,
                  {
                    ...value,
                    design: { ...body(value.design ?? {}), title: text },
                  },
                  execution.signal,
                );
                break;
              } catch (error) {
                // Retry only an explicit revision conflict that changed another field.
                if (
                  !(error instanceof ModuleDocumentConflictError) ||
                  attempt >= 2 ||
                  body(body(error.document.value).design ?? {}).title !== title
                )
                  throw error;
                current = error.document;
              }
            }
            return render(text, execution.signal);
          });
        saves = next;
        return next;
      },
      async execute(id, fields, execution) {
        if (execution.signal.aborted)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled",
          };
        try {
          if (id !== "render") throw new Error("Unknown action");
          const values = body(fields.values ?? {});
          const override = values["module.text"];
          const result = await render(
            override === "" ? undefined : override,
            execution.signal,
          );
          return {
            status: "success",
            evidence: { kind: "local", summary: result.text },
          };
        } catch (error) {
          return {
            status: "failure",
            category: execution.signal.aborted ? "cancelled" : "invalid-config",
            message: error instanceof Error ? error.message : "Invalid label",
          };
        }
      },
      async dispose() {
        lifetime.abort();
        await watching;
      },
    };
  },
} satisfies HubbleModule;
