import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const DIT_BROWSE_CAMERA_NUMBER_MIN = 1

export const DIT_BROWSE_CAMERA_NUMBER_MAX = 999_999

export const DIT_BROWSE_REQUEST_TIMEOUT_MS_MIN = 100

export const DIT_BROWSE_REQUEST_TIMEOUT_MS_MAX = 4_000

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

export const DitBrowseCameraNumberSchema = z
  .int()
  .min(DIT_BROWSE_CAMERA_NUMBER_MIN)
  .max(DIT_BROWSE_CAMERA_NUMBER_MAX)

export const DitBrowseWorkspaceNumberSchema = z.int().positive().max(Number.MAX_SAFE_INTEGER)

export const DitBrowseConnectionDefinitionSchema = z
  .strictObject({
    connectionId: ConnectionIdSchema,
    moduleBinding: ModuleBindingSchema.optional(),
    type: z.literal('dit-browse'),
    name: ConnectionNameSchema,
    enabled: z.boolean(),
    port: z.int().min(1).max(65_535),
    requestTimeoutMs: z
      .int()
      .min(DIT_BROWSE_REQUEST_TIMEOUT_MS_MIN)
      .max(DIT_BROWSE_REQUEST_TIMEOUT_MS_MAX),
    schemaVersion: z.literal(1),
  })
  .readonly()

export type DitBrowseConnectionDefinition = z.infer<typeof DitBrowseConnectionDefinitionSchema>
