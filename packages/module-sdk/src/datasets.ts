import { z } from 'zod'
import { ModulePeerSchema } from './exchange-contracts.js'
import type { ModuleHostServices } from './host-services.js'

const Id = z.string().min(1).max(160)
const Revision = z.string().regex(/^[0-9a-f]{64}$/u)
export const ModuleDatasetSourceSchema = z.strictObject({
  workspaceId: z.uuid(),
  owner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('hubble') }),
    z.strictObject({ kind: z.literal('module'), peer: ModulePeerSchema }),
  ]),
  sourceId: Id,
})
export const ModuleDatasetColumnSchema = z.strictObject({
  id: Id,
  label: z.string().min(1).max(160),
  type: z.enum(['text', 'number', 'boolean', 'json']),
})
export const ModuleDatasetRowSchema = z.strictObject({
  id: Id,
  values: z.record(Id, z.json()),
  errors: z.record(Id, z.string().max(1000)).default({}),
})
export const ModuleDatasetDescriptorSchema = z.strictObject({
  source: ModuleDatasetSourceSchema,
  label: z.string().min(1).max(512),
  version: z.int().min(1).max(65535),
  revision: Revision,
  available: z.boolean(),
  sheets: z
    .array(
      z.strictObject({
        id: Id,
        label: z.string().min(1).max(160),
        columns: z.array(ModuleDatasetColumnSchema).max(512),
        rowCount: z.int().min(0).max(100000),
      }),
    )
    .max(256),
})
const Cursor = z.strictObject({ revision: Revision, offset: z.int().min(0).max(10000) })
export const ModuleDatasetRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('list'),
    cursor: Cursor.nullable().default(null),
    limit: z.int().min(1).max(100).default(25),
  }),
  z.strictObject({
    method: z.literal('read'),
    source: ModuleDatasetSourceSchema,
    sheetId: Id,
    version: z.int().min(1).max(65535).optional(),
    columnIds: z.array(Id).min(1).max(512).nullable().default(null),
    rowIds: z.array(Id).max(2000).nullable().default(null),
    revision: Revision.nullable().default(null),
    afterRowId: Id.nullable().default(null),
    limit: z.int().min(1).max(128).default(64),
  }),
  z.strictObject({
    method: z.literal('watch'),
    source: ModuleDatasetSourceSchema,
    afterRevision: Revision.nullable(),
  }),
])
export const ModuleDatasetResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('catalog'),
    revision: Revision,
    sources: z.array(ModuleDatasetDescriptorSchema).max(100),
    nextCursor: Cursor.nullable(),
  }),
  z.strictObject({
    status: z.literal('data'),
    dataset: ModuleDatasetDescriptorSchema,
    sheetId: Id,
    rows: z.array(ModuleDatasetRowSchema).max(128),
    nextRowId: Id.nullable(),
  }),
  z.strictObject({ status: z.literal('changed'), dataset: ModuleDatasetDescriptorSchema }),
  z.strictObject({ status: z.literal('stale'), dataset: ModuleDatasetDescriptorSchema.nullable() }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'permission',
      'workspace',
      'missing-source',
      'missing-sheet',
      'missing-column',
      'missing-row',
      'schema-version',
      'provider',
      'invalid-data',
      'limit',
    ]),
  }),
])
/** Reserved tagged JSON value: portable references are remapped by workspace transfer. */
export const ModuleDatasetReferenceSchema = z.strictObject({
  kind: z.literal('hubble-dataset-reference'),
  formatVersion: z.literal(1),
  source: ModuleDatasetSourceSchema,
  schemaVersion: z.int().min(1).max(65535),
  sheetId: Id,
  columnIds: z.array(Id).min(1).max(512).nullable().default(null),
  rowIds: z.array(Id).max(2000).nullable().default(null),
  unresolved: z.boolean().default(false),
})
export type ModuleDatasetReference = z.infer<typeof ModuleDatasetReferenceSchema>
/** Only the explicit reserved reference format is interpreted; ordinary strings/objects are unchanged. */
export function mapModuleDatasetReferences(
  value: z.infer<ReturnType<typeof z.json>>,
  map: (reference: ModuleDatasetReference) => ModuleDatasetReference,
) {
  const root = { value: structuredClone(value) }
  const pending: { parent: Record<string, unknown> | unknown[]; key: string | number }[] = [
    { parent: root, key: 'value' },
  ]
  while (pending.length) {
    const next = pending.pop()
    if (!next) break
    const { parent, key } = next
    const item: unknown = Reflect.get(parent, key)
    if (!item || typeof item !== 'object') continue
    if (!Array.isArray(item) && Reflect.get(item, 'kind') === 'hubble-dataset-reference') {
      Reflect.set(
        parent,
        key,
        ModuleDatasetReferenceSchema.parse(map(ModuleDatasetReferenceSchema.parse(item))),
      )
      continue
    }
    for (const child of Object.keys(item))
      pending.push({ parent: item as Record<string, unknown>, key: child })
  }
  return root.value
}
export type ModuleDatasetSource = z.infer<typeof ModuleDatasetSourceSchema>
export type ModuleDatasetColumn = z.infer<typeof ModuleDatasetColumnSchema>
export type ModuleDatasetRow = z.infer<typeof ModuleDatasetRowSchema>
export type ModuleDatasetDescriptor = z.infer<typeof ModuleDatasetDescriptorSchema>
export type ModuleDatasetRequest = z.infer<typeof ModuleDatasetRequestSchema>
export type ModuleDatasetResponse = z.infer<typeof ModuleDatasetResponseSchema>
export function moduleDatasetKey(source: ModuleDatasetSource): string {
  const owner = source.owner
  return JSON.stringify([
    source.workspaceId,
    owner.kind,
    owner.kind === 'module' ? owner.peer.kind : null,
    owner.kind === 'module'
      ? owner.peer.kind === 'connection'
        ? owner.peer.connectionId
        : owner.peer.capabilityId
      : null,
    owner.kind === 'module' ? owner.peer.moduleId : null,
    source.sourceId,
  ])
}
/** Read-only, scoped sources. Pages call their backend, which uses this same public client. */
export function createModuleDatasetClient(services: ModuleHostServices) {
  const request = (input: z.input<typeof ModuleDatasetRequestSchema>, signal?: AbortSignal) =>
    services.request('datasets', 1, ModuleDatasetRequestSchema.parse(input), signal)
  return {
    list: (
      input: { cursor?: z.infer<typeof Cursor> | null; limit?: number } = {},
      signal?: AbortSignal,
    ) => request({ method: 'list', ...input }, signal),
    read: (
      input: Omit<
        Extract<z.input<typeof ModuleDatasetRequestSchema>, { method: 'read' }>,
        'method'
      >,
      signal?: AbortSignal,
    ) => request({ method: 'read', ...input }, signal),
    async readReference(
      reference: ModuleDatasetReference,
      options: { revision?: string | null; afterRowId?: string | null; limit?: number } = {},
      signal?: AbortSignal,
    ) {
      const link = ModuleDatasetReferenceSchema.parse(reference)
      if (link.unresolved)
        return { status: 'unavailable' as const, reason: 'missing-source' as const }
      return request(
        {
          method: 'read',
          source: link.source,
          sheetId: link.sheetId,
          version: link.schemaVersion,
          columnIds: link.columnIds,
          rowIds: link.rowIds,
          ...options,
        },
        signal,
      )
    },
    async *watch(
      source: ModuleDatasetSource,
      signal: AbortSignal,
    ): AsyncGenerator<ModuleDatasetResponse> {
      let afterRevision: string | null = null
      let signature = ''
      while (!signal.aborted) {
        const result = await request({ method: 'watch', source, afterRevision }, signal)
        const next = JSON.stringify(result)
        if (signature !== next) {
          signature = next
          yield result
        }
        if (result.status !== 'changed') return
        afterRevision = result.dataset.revision
      }
    },
  }
}
