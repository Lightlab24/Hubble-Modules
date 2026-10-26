import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { LiveGradeEditionSchema, LiveGradeGenerationSchema } from './livegrade-slots.js'
import { ConnectionIdSchema } from './primitives.js'

export const LIVEGRADE_STUDIO_REQUEST_TIMEOUT_MS_MIN = 100

export const LIVEGRADE_STUDIO_REQUEST_TIMEOUT_MS_MAX = 5_000

const codePointLength = (value: string): number => Array.from(value).length

export const ConnectionNameSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      codePointLength(value) >= 1 &&
      codePointLength(value) <= 128 &&
      !/[\u0000-\u001F\u007F\u2028\u2029]/u.test(value),
    'connection name must be one line containing 1..128 readable Unicode characters',
  )

const LiveGradeConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('livegrade'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  generation: LiveGradeGenerationSchema,
  edition: LiveGradeEditionSchema.optional(),
  requestTimeoutMs: z
    .int()
    .min(LIVEGRADE_STUDIO_REQUEST_TIMEOUT_MS_MIN)
    .max(LIVEGRADE_STUDIO_REQUEST_TIMEOUT_MS_MAX),
  schemaVersion: z.literal(1),
})

const validLiveGradeEdition = (connection: {
  generation: 6 | 7
  edition?: string | undefined
}) => connection.edition !== 'frontier' || connection.generation === 7

export const LiveGradeConnectionDefinitionSchema = LiveGradeConnectionObjectSchema.refine(
  validLiveGradeEdition,
  { path: ['edition'], message: 'LiveGrade Frontier requires generation 7' },
).readonly()

export type LiveGradeConnectionDefinition = z.infer<typeof LiveGradeConnectionDefinitionSchema>
