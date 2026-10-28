import { z } from 'zod'
import { ModuleChoiceSchema } from './fields.js'

export const ModuleChoiceQuerySchema = z.strictObject({
  version: z.literal(2),
  provider: z.string().min(1).max(96),
  draft: z
    .record(z.string().min(1).max(96), z.json())
    .refine((value) => JSON.stringify(value).length <= 262_144),
  search: z.string().max(256),
  cursor: z.string().min(1).max(2048).nullable(),
  limit: z.int().min(1).max(128),
  requestRevision: z.int().nonnegative(),
  catalogRevision: z.string().min(1).max(160).optional(),
  generation: z.uuid().optional(),
})
export type ModuleChoiceQuery = z.infer<typeof ModuleChoiceQuerySchema>
export const ModuleChoicePageSchema = z.strictObject({
  revision: z.string().min(1).max(160),
  choices: z
    .array(ModuleChoiceSchema)
    .max(128)
    .refine(
      (choices) => new Set(choices.map((choice) => choice.id)).size === choices.length,
      'Duplicate choice ID',
    ),
  nextCursor: z.string().min(1).max(2048).nullable(),
})
export type ModuleChoicePage = z.infer<typeof ModuleChoicePageSchema>
export const ModuleChoiceDiscoverySchema = ModuleChoicePageSchema.extend({
  requestRevision: z.int().nonnegative(),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.uuid(),
})
export type ModuleChoiceDiscovery = z.infer<typeof ModuleChoiceDiscoverySchema>
