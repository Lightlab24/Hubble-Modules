import { z } from "zod";
import { ModulePeerSchema, modulePeerKey } from "./exchange-contracts.js";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u);
export const ModuleLegacyDocumentSourceSchema = z.enum([
  "ccc",
  "router-groups",
]);
export type ModuleLegacyDocumentSource = z.infer<
  typeof ModuleLegacyDocumentSourceSchema
>;
export const ModuleDocumentValueSchema = z
  .json()
  .refine(
    (value) => JSON.stringify(value).length <= 262_144,
    "Module document exceeds 256K characters",
  );
export const ModuleDocumentDefinitionSchema = z.strictObject({
  id: Id,
  label: z.string().min(1).max(160),
  version: z.int().min(1).max(65535),
  defaultValue: ModuleDocumentValueSchema.default(null),
  /** Read-only package query that validates and normalizes an explicit edit before persistence. */
  prepare: z
    .strictObject({ id: Id, version: z.int().min(1).max(65535) })
    .optional(),
  /** Pure migrateDocument hook upgrades persisted values when selecting a package. */
  migrate: z.boolean().optional(),
  /** Frozen compatibility input, available only to the historical owner. */
  legacyImport: ModuleLegacyDocumentSourceSchema.optional(),
});
export const ModuleDocumentRecordSchema = z
  .strictObject({
    owner: ModulePeerSchema,
    id: Id,
    version: z.int().min(1).max(65535),
    revision: z.uuid(),
    value: ModuleDocumentValueSchema,
    /** Host migration provenance; keeps historical row references stable during transfer. */
    legacySource: ModuleLegacyDocumentSourceSchema.optional(),
  })
  .refine(
    (record) =>
      !record.legacySource ||
      (record.legacySource === "ccc"
        ? record.owner.kind === "host" &&
          record.owner.capabilityId === "ccc" &&
          record.owner.moduleId === "hubble-ccc"
        : record.owner.kind === "connection" &&
          [
            "hubble-ross-ultrix-ogp",
            "hubble-evertz-quartz",
            "hubble-blackmagic-videohub",
            "hubble-aja-kumo",
          ].includes(record.owner.moduleId)),
    "Legacy document provenance belongs to its historical owner",
  );
export const ModuleWorkspaceDocumentsSchema = z
  .array(ModuleDocumentRecordSchema)
  .max(1024)
  .refine(
    (records) =>
      new Set(records.map(moduleDocumentKey)).size === records.length,
    "Duplicate module document identity",
  )
  .refine(
    (records) => JSON.stringify(records).length <= 4_194_304,
    "Workspace module documents exceed 4M characters",
  );

export function moduleDocumentKey(record: {
  owner: z.infer<typeof ModulePeerSchema>;
  id: string;
}): string {
  return JSON.stringify([modulePeerKey(record.owner), record.id]);
}
export const ModuleDocumentRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("list") }),
  z.strictObject({ method: z.literal("read"), id: Id }),
  z.strictObject({
    method: z.literal("watch"),
    id: Id,
    afterRevision: z.uuid().nullable(),
  }),
  z.strictObject({
    method: z.literal("write"),
    id: Id,
    expectedRevision: z.uuid().nullable(),
    value: ModuleDocumentValueSchema,
  }),
  z.strictObject({
    method: z.literal("reset"),
    id: Id,
    expectedRevision: z.uuid().nullable(),
  }),
  z.strictObject({
    method: z.literal("history"),
    id: Id,
    expectedRevision: z.uuid().nullable(),
    intent: z.enum(["undo", "redo"]),
  }),
]);
export const ModuleDocumentSnapshotSchema = z.strictObject({
  workspaceId: z.uuid(),
  owner: ModulePeerSchema,
  id: Id,
  version: z.int().min(1).max(65535),
  revision: z.uuid().nullable(),
  value: ModuleDocumentValueSchema,
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export const ModuleDocumentIssuesSchema = z
  .array(
    z.strictObject({
      tableId: Id,
      rowId: Id,
      fieldId: Id,
      message: z.string().min(1).max(1000),
    }),
  )
  .max(128);
export const ModuleDocumentPreparationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("accepted"),
      value: ModuleDocumentValueSchema,
    }),
    z.strictObject({
      status: z.literal("invalid"),
      message: z.string().min(1).max(1000),
      issues: ModuleDocumentIssuesSchema.default([]),
    }),
  ],
);
export type ModuleDocumentPreparationResult = z.infer<
  typeof ModuleDocumentPreparationResultSchema
>;
export const ModuleDocumentResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("catalog"),
    documents: z.array(ModuleDocumentDefinitionSchema).max(64),
  }),
  z.strictObject({
    status: z.literal("document"),
    document: ModuleDocumentSnapshotSchema,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    document: ModuleDocumentSnapshotSchema,
  }),
  z.strictObject({
    status: z.literal("invalid"),
    document: ModuleDocumentSnapshotSchema,
    message: z.string().min(1).max(1000),
    issues: ModuleDocumentIssuesSchema,
  }),
]);
export class ModuleDocumentValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.infer<typeof ModuleDocumentIssuesSchema> = [],
  ) {
    super(message);
    this.name = "ModuleDocumentValidationError";
  }
}
export type ModuleDocumentRecord = z.infer<typeof ModuleDocumentRecordSchema>;
export type ModuleWorkspaceDocuments = z.infer<
  typeof ModuleWorkspaceDocumentsSchema
>;
export type ModuleDocumentDefinition = z.infer<
  typeof ModuleDocumentDefinitionSchema
>;
export type ModuleDocumentRequest = z.infer<typeof ModuleDocumentRequestSchema>;
export type ModuleDocumentResponse = z.infer<
  typeof ModuleDocumentResponseSchema
>;
export type ModuleDocumentSnapshot = z.infer<
  typeof ModuleDocumentSnapshotSchema
>;

export const ModuleDocumentMigrationInputSchema = z.strictObject({
  id: Id,
  fromVersion: z.int().min(0).max(65535),
  toVersion: z.int().min(1).max(65535),
  value: ModuleDocumentValueSchema,
});
export const ModuleDocumentMigrationSchema = z.strictObject({
  before: ModuleWorkspaceDocumentsSchema,
  after: ModuleWorkspaceDocumentsSchema,
});
export type ModuleDocumentMigrationInput = z.infer<
  typeof ModuleDocumentMigrationInputSchema
>;
export type ModuleDocumentMigration = z.infer<
  typeof ModuleDocumentMigrationSchema
>;
