import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MIN = 10

export const ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MAX = 3_600

export const ROSS_ULTRIX_OGP_SOURCE_LIMIT_MIN = 1

export const ROSS_ULTRIX_OGP_SOURCE_LIMIT_MAX = 65_536

export const ROSS_ULTRIX_OGP_DESTINATION_LIMIT_MIN = 1

export const ROSS_ULTRIX_OGP_DESTINATION_LIMIT_MAX = 65_536

export const ROSS_ULTRIX_OGP_LEVELS_MIN = 1

export const ROSS_ULTRIX_OGP_LEVELS_MAX = 256

export const ROSS_ULTRIX_OGP_REQUEST_TIMEOUT_MS_MIN = 100

export const ROSS_ULTRIX_OGP_REQUEST_TIMEOUT_MS_MAX = 10_000

export const ROSS_ULTRIX_OGP_RECONNECT_DELAY_MS_MIN = 100

export const ROSS_ULTRIX_OGP_RECONNECT_DELAY_MS_MAX = 60_000

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

export const RossSwp08RefreshIntervalSecondsSchema = z
  .int()
  .min(0)
  .max(ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MAX)
  .refine(
    (value) => value === 0 || value >= ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MIN,
    `refresh timer must be 0 or ${String(ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MIN)}..${String(
      ROSS_SWP08_REFRESH_INTERVAL_SECONDS_MAX,
    )} seconds`,
  )

export const RossUltrixOgpSourceLimitSchema = z
  .int()
  .min(ROSS_ULTRIX_OGP_SOURCE_LIMIT_MIN)
  .max(ROSS_ULTRIX_OGP_SOURCE_LIMIT_MAX)

export const RossUltrixOgpDestinationLimitSchema = z
  .int()
  .min(ROSS_ULTRIX_OGP_DESTINATION_LIMIT_MIN)
  .max(ROSS_ULTRIX_OGP_DESTINATION_LIMIT_MAX)

export const RossUltrixOgpLevelsSchema = z
  .int()
  .min(ROSS_ULTRIX_OGP_LEVELS_MIN)
  .max(ROSS_ULTRIX_OGP_LEVELS_MAX)

const RossUltrixOgpConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('ross-ultrix-ogp'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  host: RouterHostSchema,
  port: z.int().min(1).max(65_535),
  sourceLimit: RossUltrixOgpSourceLimitSchema,
  destinationLimit: RossUltrixOgpDestinationLimitSchema,
  levels: RossUltrixOgpLevelsSchema,
  requestTimeoutMs: z
    .int()
    .min(ROSS_ULTRIX_OGP_REQUEST_TIMEOUT_MS_MIN)
    .max(ROSS_ULTRIX_OGP_REQUEST_TIMEOUT_MS_MAX),
  reconnectDelayMs: z
    .int()
    .min(ROSS_ULTRIX_OGP_RECONNECT_DELAY_MS_MIN)
    .max(ROSS_ULTRIX_OGP_RECONNECT_DELAY_MS_MAX),
  schemaVersion: z.literal(1),
})

export const EvertzQuartzLevelSystemSchema = z.enum(['8-level', '16-level', 'magnum'])

export const EvertzQuartzLevelsSchema = z.int().min(1).max(26)

const EvertzQuartzConnectionObjectSchema = RossUltrixOgpConnectionObjectSchema.extend({
  type: z.literal('evertz-quartz'),
  levels: EvertzQuartzLevelsSchema,
  levelSystem: EvertzQuartzLevelSystemSchema,
  refreshIntervalSeconds: RossSwp08RefreshIntervalSecondsSchema,
})

function validateQuartzLevels(
  connection: { levels: number; levelSystem: string },
  context: z.core.$RefinementCtx,
): void {
  const maximum =
    connection.levelSystem === '8-level' ? 8 : connection.levelSystem === '16-level' ? 16 : 26
  if (connection.levels > maximum)
    context.addIssue({
      code: 'custom',
      path: ['levels'],
      message: 'Active levels exceed the selected Quartz level system',
    })
}

export const EvertzQuartzConnectionDefinitionSchema =
  EvertzQuartzConnectionObjectSchema.superRefine(validateQuartzLevels).readonly()

export type EvertzQuartzConnectionDefinition = z.infer<
  typeof EvertzQuartzConnectionDefinitionSchema
>
