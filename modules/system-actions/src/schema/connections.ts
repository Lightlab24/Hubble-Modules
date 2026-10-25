import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

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

const KeyboardConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('keyboard'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  requestTimeoutMs: z.int().min(100).max(10_000).default(5_000),
  schemaVersion: z.literal(1),
})

export const KeyboardConnectionDefinitionSchema = KeyboardConnectionObjectSchema.readonly()
