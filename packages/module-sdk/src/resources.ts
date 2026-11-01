import { z } from 'zod'

/** Named, package-scoped concurrency budgets shared across that package's instances. */
export const ModuleResourceRequestSchema = z.discriminatedUnion('method', [
  z
    .strictObject({
      method: z.literal('acquire'),
      ttlMs: z.int().min(100).max(120000),
      claims: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(1024),
            limit: z.int().min(1).max(4096),
          }),
        )
        .min(1)
        .max(8),
    })
    .refine(
      (value) => new Set(value.claims.map((claim) => claim.key)).size === value.claims.length,
      'Resource claims require unique keys',
    ),
  z.strictObject({ method: z.literal('release'), leaseId: z.uuid() }),
])

export const ModuleResourceResponseSchema = z.union([
  z.strictObject({ granted: z.literal(true), leaseId: z.uuid() }),
  z.strictObject({ granted: z.literal(false) }),
  z.null(),
])
