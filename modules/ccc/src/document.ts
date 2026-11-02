import { z } from "zod";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  ModuleTableRowsSchema,
  ModuleTableViewStateSchema,
  type ModuleHostServices,
  type ModuleJsonValue,
  type ModuleDocumentMigrationInput,
} from "@hubble/module-sdk";
import {
  CccConfigSchema,
  CccRowsSchema,
  applyCccMutation,
  type CccConfig,
  type CccMutationRequest,
} from "./config.js";

export const documentId = "cameras";
const Document = z.looseObject({
  revision: z.int().min(0),
  singleSwitch: z.boolean().optional(),
  cameras: ModuleTableRowsSchema,
  camerasView: ModuleTableViewStateSchema.optional(),
});
const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue;
const rows = (value: z.infer<typeof Document>) =>
  CccRowsSchema.parse(
    value.cameras.map((row) => {
      const number = row.values.cameraNumber ?? "";
      if (number !== "" && number !== null && !/^\d+$/u.test(String(number)))
        throw new Error("Enter a whole camera number or leave it blank");
      return {
        rowId: row.id,
        enabled: row.values.enabled ?? false,
        rcpIp: row.values.rcpIp ?? "",
        cameraNumber: number === "" || number === null ? null : Number(number),
      };
    }),
  );
export function cccDocumentConfig(value: unknown): CccConfig {
  const document = Document.parse(value);
  return CccConfigSchema.parse({
    revision: document.revision,
    rows: rows(document),
    singleSwitch: document.singleSwitch ?? false,
  });
}
export function replaceCccDocument(
  value: unknown,
  config: CccConfig,
): ModuleJsonValue {
  const document = Document.parse(value);
  return json({
    ...document,
    revision: config.revision,
    singleSwitch: config.singleSwitch ?? false,
    cameras: config.rows.map((row) => {
      const old = document.cameras.find((item) => item.id === row.rowId);
      return {
        ...old,
        id: row.rowId,
        values: {
          ...old?.values,
          enabled: row.enabled,
          rcpIp: row.rcpIp,
          cameraNumber:
            row.cameraNumber === null ? "" : String(row.cameraNumber),
        },
      };
    }),
  });
}
export function migrateCccDocument(
  input: ModuleDocumentMigrationInput,
): ModuleJsonValue {
  if (
    input.id !== documentId ||
    input.fromVersion !== 0 ||
    input.toVersion !== 1
  )
    throw new Error("Unsupported CCC document migration");
  return replaceCccDocument(
    { revision: 0, cameras: [], camerasView: { version: 1 } },
    CccConfigSchema.parse(input.value),
  );
}
export function prepareCccDocument(raw: unknown): ModuleJsonValue {
  const input = z
    .object({
      id: z.literal(documentId),
      version: z.literal(1),
      intent: z.enum(["write", "reset", "undo", "redo"]),
      before: z.object({ version: z.literal(1), value: z.json() }),
      value: z.json(),
    })
    .parse(raw);
  const before = cccDocumentConfig(input.before.value);
  const desired = Document.parse(input.value);
  if (input.intent === "undo" || input.intent === "redo") {
    cccDocumentConfig(input.value);
    return input.value;
  }
  const next = applyCccMutation(before, {
    kind: "replace",
    expectedRevision: before.revision,
    rows: rows(desired),
    singleSwitch: desired.singleSwitch ?? false,
  });
  const changed =
    JSON.stringify({ ...before, revision: 0 }) !==
    JSON.stringify({ ...next, revision: 0 });
  return replaceCccDocument(input.value, {
    ...next,
    revision: changed ? before.revision + 1 : before.revision,
  });
}

/** All controllers and editors share this portable document. No typed CCC host store is used. */
export function createCccDocumentStore(services: ModuleHostServices) {
  const client = createModuleDocumentClient(services);
  let value: ModuleJsonValue = { revision: 0, cameras: [] };
  let revision: string | null = null;
  const readDocument = async () => {
    const document = await client.read(documentId);
    if (document.version !== 1)
      throw new Error("Update CCC to read this camera document");
    value = document.value;
    revision = document.revision;
    return document;
  };
  return {
    client,
    value: () => value,
    revision: () => revision,
    async read() {
      return cccDocumentConfig((await readDocument()).value);
    },
    async mutate(request: CccMutationRequest) {
      for (let attempt = 0; ; attempt++) {
        const document = await readDocument();
        const next = applyCccMutation(
          cccDocumentConfig(document.value),
          request.mutation,
        );
        try {
          const result = await client.write(
            document,
            replaceCccDocument(document.value, next),
          );
          value = result.value;
          revision = result.revision;
          return cccDocumentConfig(result.value);
        } catch (error) {
          if (
            !(error instanceof ModuleDocumentConflictError) ||
            request.mutation.kind === "replace" ||
            attempt >= 2
          )
            throw error;
        }
      }
    },
  };
}
