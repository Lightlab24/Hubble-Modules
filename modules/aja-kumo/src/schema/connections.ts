import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const BLACKMAGIC_VIDEOHUB_SOURCE_LIMIT_MIN = 1

export const BLACKMAGIC_VIDEOHUB_SOURCE_LIMIT_MAX = 65_536

export const BLACKMAGIC_VIDEOHUB_DESTINATION_LIMIT_MIN = 1

export const BLACKMAGIC_VIDEOHUB_DESTINATION_LIMIT_MAX = 65_536

export const BLACKMAGIC_VIDEOHUB_REQUEST_TIMEOUT_MS_MIN = 100

export const BLACKMAGIC_VIDEOHUB_REQUEST_TIMEOUT_MS_MAX = 10_000

export const BLACKMAGIC_VIDEOHUB_RECONNECT_DELAY_MS_MIN = 100

export const BLACKMAGIC_VIDEOHUB_RECONNECT_DELAY_MS_MAX = 60_000

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

export const RouterHostSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value.length >= 1 && value.length <= 253 && !/[\s\u0000-\u001F\u007F/\\]/u.test(value),
    'router host must be a hostname or IP address containing 1..253 characters',
  )

export const BlackmagicVideohubSourceLimitSchema = z
  .int()
  .min(BLACKMAGIC_VIDEOHUB_SOURCE_LIMIT_MIN)
  .max(BLACKMAGIC_VIDEOHUB_SOURCE_LIMIT_MAX)

export const BlackmagicVideohubDestinationLimitSchema = z
  .int()
  .min(BLACKMAGIC_VIDEOHUB_DESTINATION_LIMIT_MIN)
  .max(BLACKMAGIC_VIDEOHUB_DESTINATION_LIMIT_MAX)

const BlackmagicVideohubConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('blackmagic-videohub'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  host: RouterHostSchema,
  port: z.int().min(1).max(65_535),
  sourceLimit: BlackmagicVideohubSourceLimitSchema.optional(),
  destinationLimit: BlackmagicVideohubDestinationLimitSchema.optional(),
  requestTimeoutMs: z
    .int()
    .min(BLACKMAGIC_VIDEOHUB_REQUEST_TIMEOUT_MS_MIN)
    .max(BLACKMAGIC_VIDEOHUB_REQUEST_TIMEOUT_MS_MAX),
  reconnectDelayMs: z
    .int()
    .min(BLACKMAGIC_VIDEOHUB_RECONNECT_DELAY_MS_MIN)
    .max(BLACKMAGIC_VIDEOHUB_RECONNECT_DELAY_MS_MAX),
  schemaVersion: z.literal(1),
})

export const AJA_KUMO_MAX_ADDRESS = 64

export const AjaKumoAddressSchema = z.int().min(1).max(AJA_KUMO_MAX_ADDRESS)

const AjaKumoConnectionObjectSchema = BlackmagicVideohubConnectionObjectSchema.extend({
  type: z.literal('aja-kumo'),
  password: z.string().max(1_024).default(''),
  sourceLimit: AjaKumoAddressSchema.optional(),
  destinationLimit: AjaKumoAddressSchema.optional(),
})

export const AjaKumoConnectionDefinitionSchema = AjaKumoConnectionObjectSchema.readonly()

export type AjaKumoConnectionDefinition = z.infer<typeof AjaKumoConnectionDefinitionSchema>
