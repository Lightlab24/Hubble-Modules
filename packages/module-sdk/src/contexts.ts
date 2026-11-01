import { z } from 'zod'

/** A logical workspace alias of a connection. Domain settings remain package-owned. */
export const ModuleContextReferenceSchema = z.strictObject({
  kind: z.literal('hubble-context-reference'),
  formatVersion: z.literal(1),
  workspaceId: z.uuid(),
  connectionId: z.uuid(),
  contextId: z.uuid(),
  unresolved: z.boolean().default(false),
})
export type ModuleContextReference = z.infer<typeof ModuleContextReferenceSchema>
export const ModuleLogicalContextSchema = z.strictObject({
  reference: ModuleContextReferenceSchema,
  name: z.string().min(1).max(256),
})
export const ModuleContextsRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('read') }),
  z.strictObject({
    method: z.literal('watch'),
    afterRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
  }),
])
export const ModuleContextsResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/u),
  contexts: z.array(ModuleLogicalContextSchema).max(256),
})
export type ModuleLogicalContext = z.infer<typeof ModuleLogicalContextSchema>
export type ModuleContextsRequest = z.infer<typeof ModuleContextsRequestSchema>
export type ModuleContextsResponse = z.infer<typeof ModuleContextsResponseSchema>

/** Interpret only explicitly tagged references, never ordinary package IDs or strings. */
export function mapModuleContextReferences(
  value: z.infer<ReturnType<typeof z.json>>,
  map: (reference: ModuleContextReference) => ModuleContextReference,
) {
  const root = { value: structuredClone(value) }
  const pending: { parent: object; key: string }[] = [{ parent: root, key: 'value' }]
  while (pending.length) {
    const next = pending.pop()
    if (!next) break
    const { parent, key } = next
    const item: unknown = Reflect.get(parent, key)
    if (!item || typeof item !== 'object') continue
    if (!Array.isArray(item) && Reflect.get(item, 'kind') === 'hubble-context-reference') {
      Reflect.set(
        parent,
        key,
        ModuleContextReferenceSchema.parse(map(ModuleContextReferenceSchema.parse(item))),
      )
      continue
    }
    for (const child of Object.keys(item)) pending.push({ parent: item, key: child })
  }
  return root.value
}
