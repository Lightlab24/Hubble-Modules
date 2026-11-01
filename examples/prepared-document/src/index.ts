import {
  ModuleTableRowsSchema,
  type HubbleModule,
  type ModuleJsonValue,
  type ModuleDocumentMigrationInput,
} from "@hubble/module-sdk";

function object(value: ModuleJsonValue): Record<string, ModuleJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected an object");
  return value as Record<string, ModuleJsonValue>;
}

export function migrateDocument(
  input: ModuleDocumentMigrationInput,
): ModuleJsonValue {
  if (input.id !== "list" || input.fromVersion !== 1 || input.toVersion !== 2)
    throw Error("Unsupported list migration");
  const value = object(input.value);
  return {
    ...value,
    items: ModuleTableRowsSchema.parse(value.items).map((row) => ({
      ...row,
      values: { note: "", ...row.values },
    })),
  };
}

/** Observational query: validate and normalize, without writing or executing anything. */
export function prepareDocument(input: ModuleJsonValue): ModuleJsonValue {
  const request = object(input),
    value = object(request.value ?? null);
  if (request.id !== "list" || request.version !== 2)
    throw Error("Unsupported list version");
  const items = ModuleTableRowsSchema.parse(value.items);
  const issues = items.flatMap((row) =>
    typeof row.values.name !== "string" ||
    !row.values.name.trim() ||
    row.values.name.length > 80
      ? [
          {
            tableId: "items",
            rowId: row.id,
            fieldId: "name",
            message: "Enter a name of up to 80 characters",
          },
        ]
      : [],
  );
  if (issues.length)
    return {
      status: "invalid",
      message: "Correct the highlighted names",
      issues,
    };
  // History may be validated but must be returned exactly; never normalize a historical value.
  if (request.intent === "undo" || request.intent === "redo")
    return { status: "accepted", value };
  return {
    status: "accepted",
    value: {
      ...value,
      items: items.map((row) => ({
        ...row,
        values: { ...row.values, name: String(row.values.name).trim() },
      })),
    },
  };
}

export default {
  migrateDocument,
  createInstance: () => ({
    queryData(query) {
      if (query.id !== "prepare-list" || query.version !== 1)
        throw Error("Unknown query");
      return prepareDocument(query.input);
    },
    execute: async () => ({
      status: "failure",
      category: "invalid-config",
      message: "This example has no device actions",
    }),
    dispose() {},
  }),
} satisfies HubbleModule;
