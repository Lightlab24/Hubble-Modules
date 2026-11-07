import { setTimeout as delay } from "node:timers/promises";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  ModuleDocumentValidationError,
  ModuleDocumentValueSchema,
  validateModuleWorkbookRow,
  type HubbleModule,
  type ModuleDocumentSnapshot,
  type ModuleJsonValue,
} from "@hubble/module-sdk";
import { z } from "zod";
import {
  applyChange,
  patchSchema,
  patchValueIssue,
  routeAvailable,
} from "./model.js";
import { routesForArea } from "./routes.js";
import { WorkbookStateSchema, workbookFromDocument } from "./workbook-state.js";
import { documentId, patchTable } from "./table.js";

const pageCommand = z.object({
  sectionId: z.literal("sheet"),
  commandId: z.enum(["snapshot", "choices", "edit", "save-workbook"]),
  value: z.json().optional(),
});

export function preparePatch(input: ModuleJsonValue): ModuleJsonValue {
  const request = z
    .looseObject({
      id: z.string(),
      version: z.number(),
      value: ModuleDocumentValueSchema,
    })
    .parse(input);
  if (request.id !== documentId || request.version !== 1)
    throw new Error("Unknown patch document");
  const { rows } = workbookFromDocument(request.value);
  const issues = rows.flatMap((row) =>
    Object.entries(row.values).flatMap(([fieldId, value]) => {
      const message =
        typeof value === "string" && patchValueIssue(fieldId, value);
      return message
        ? [{ tableId: "rows", rowId: row.id, fieldId, message }]
        : [];
    }),
  );
  for (const row of rows)
    if (!routeAvailable(row))
      issues.push({
        tableId: "rows",
        rowId: row.id,
        fieldId: "route",
        message: "The route is outside this area",
      });
  return issues.length
    ? { status: "invalid", message: issues[0]!.message, issues }
    : { status: "accepted", value: request.value };
}

// Canonical key order makes stale checks independent of JSON property ordering.
function sameWorkbook(a: unknown, b: unknown): boolean {
  const encode = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : item,
    );
  return encode(a) === encode(b);
}

export default {
  createInstance(context) {
    if (!context.services)
      throw new Error("Patch Sheet requires portable documents");
    const documents = createModuleDocumentClient(context.services);
    const lifetime = new AbortController();
    let batches = 0;
    let latestSequence = 0;
    let latestDocument: ModuleDocumentSnapshot;
    let watchError: string | null = null;
    let watching: Promise<void> | undefined;
    const snapshot = (document: ModuleDocumentSnapshot) => ({
      sequence: document.sequence ?? 0,
      ...workbookFromDocument(document.value),
      batches,
    });
    const publish = (document: ModuleDocumentSnapshot) => {
      const patch = snapshot(document);
      if (patch.sequence < latestSequence) return;
      latestSequence = patch.sequence;
      latestDocument = document;
      context.publishState({
        phase: watchError ? "error" : "ready",
        message: watchError,
        observedAt: new Date().toISOString(),
        values: { patch },
      });
    };
    // Some hosts refuse a watch briefly right after a version switch, and other
    // failures can happen on any host, so one failure must not end it. Only a
    // failure that lasts is shown.
    const watchPatch = async () => {
      let failures = 0;
      while (!lifetime.signal.aborted) {
        const opened = Date.now();
        try {
          for await (const document of documents.watch(
            documentId,
            lifetime.signal,
          )) {
            watchError = null;
            publish(document);
          }
        } catch (error) {
          if (lifetime.signal.aborted) return;
          // A watch that stayed open was working, so this failure starts a new count.
          failures = Date.now() - opened > 5000 ? 1 : failures + 1;
          const message = String(error).slice(0, 1000);
          context.log({
            level: failures > 1 ? "error" : "info",
            stage: "patch-watch",
            message,
          });
          if (failures > 1) {
            watchError = message;
            publish(latestDocument);
          }
          await delay(Math.min(5000, 250 * 2 ** (failures - 1)), undefined, {
            signal: lifetime.signal,
          }).catch(() => {});
        }
      }
    };
    return {
      async start() {
        publish(await documents.read(documentId, lifetime.signal));
        watching = watchPatch();
      },
      queryData(query) {
        if (query.id !== "validate-patch" || query.version !== 1)
          throw new Error("Unknown query");
        return preparePatch(query.input);
      },
      async call(method, raw, { signal }): Promise<ModuleJsonValue> {
        if (method !== "page.patch") throw new Error("Unknown page");
        signal.throwIfAborted();
        const command = pageCommand.parse(raw);
        if (command.commandId === "snapshot")
          return snapshot(await documents.read(documentId, signal));
        if (command.commandId === "choices") {
          const input = z
            .object({ query: z.string(), area: z.string() })
            .safeParse(command.value);
          const query = input.success
            ? input.data.query
            : typeof command.value === "string"
              ? command.value
              : "";
          const area = input.success ? input.data.area : "any";
          const words = query.trim().toLowerCase().split(/\s+/u);
          return routesForArea(area).filter((route) => {
            const group = "group" in route ? route.group : "";
            return words.every((word) =>
              `${group} ${route.label} ${route.value}`
                .toLowerCase()
                .includes(word),
            );
          });
        }
        if (command.commandId === "save-workbook") {
          const { before, next } = z
            .strictObject({
              before: WorkbookStateSchema,
              next: WorkbookStateSchema,
            })
            .parse(command.value);
          try {
            const document = await documents.read(documentId, signal);
            const current = workbookFromDocument(document.value);
            if (!sameWorkbook(current, before))
              throw new Error(
                "The workbook changed before this edit could save",
              );
            for (const row of next.rows) {
              validateModuleWorkbookRow(patchTable, row.values);
              if (
                Object.keys(row.formulas ?? {}).some(
                  (id) => !patchTable.workbook?.columns?.[id]?.formula,
                )
              )
                throw new Error("A field does not support formulas");
            }
            const value = patchSchema.parse(document.value);
            const committed = await documents.write(
              document,
              ModuleDocumentValueSchema.parse({
                ...value,
                rows: next.rows,
                ...(JSON.stringify(current.view) !== JSON.stringify(next.view)
                  ? { customView: next.view }
                  : {}),
                ...(JSON.stringify(current.nativeView) !==
                JSON.stringify(next.nativeView)
                  ? { rowsView: next.nativeView }
                  : {}),
              }),
              signal,
            );
            batches++;
            publish(committed);
            return { status: "saved", snapshot: snapshot(committed) };
          } catch (error) {
            return {
              status: "rejected",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
        let document = await documents.read(documentId, signal);
        // A concurrent workbook edit may change another cell or the sheet layout.
        // Retry only while all target cells still match the submitted draft.
        for (let attempt = 0; ; attempt++) {
          const patch = patchSchema.parse(document.value);
          let rows;
          try {
            rows = applyChange(patch.rows, command.value);
          } catch (error) {
            return {
              status: "rejected",
              message:
                error instanceof Error
                  ? error.message
                  : "Patch edit is invalid",
            };
          }
          try {
            const saved = await documents.write(
              document,
              ModuleDocumentValueSchema.parse({ ...patch, rows }),
              signal,
            );
            batches++;
            publish(saved);
            return { status: "saved", snapshot: snapshot(saved) };
          } catch (error) {
            if (error instanceof ModuleDocumentValidationError)
              return { status: "rejected", message: error.message };
            if (!(error instanceof ModuleDocumentConflictError)) throw error;
            if (attempt >= 2)
              return {
                status: "rejected",
                message: "Patch changed while saving. Try again.",
              };
            document = error.document;
          }
        }
      },
      async execute() {
        return {
          status: "failure",
          category: "invalid-config",
          message: "No device actions",
        };
      },
      async dispose() {
        lifetime.abort();
        await watching;
      },
    };
  },
} satisfies HubbleModule;
