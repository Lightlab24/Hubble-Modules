import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const LIGHTENCODE_COMPANION_PORT = 59_613

export const LIGHTENCODE_REQUEST_TIMEOUT_MS_MIN = 100

export const LIGHTENCODE_REQUEST_TIMEOUT_MS_MAX = 10_000

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

export const LightEncodeHostSchema = z
  .string()
  .refine(
    isLightEncodeHost,
    'Light Encode host must be a hostname, IPv4 address, or bare IPv6 address',
  )

function isLightEncodeHost(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false
  if (/[\s\u0000-\u001F\u007F/\\@?#\[\]]/u.test(value)) return false
  const hostname =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
      value,
    )
  const bareIpv6 = value.includes(':') && /^[0-9A-Fa-f:.]+$/u.test(value)
  if (!hostname && !bareIpv6) return false
  try {
    const endpoint = new URL(
      `tcp://${bareIpv6 ? `[${value}]` : value}:${String(LIGHTENCODE_COMPANION_PORT)}/`,
    )
    return (
      endpoint.protocol === 'tcp:' &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.pathname === '/' &&
      endpoint.search === '' &&
      endpoint.hash === '' &&
      endpoint.port === String(LIGHTENCODE_COMPANION_PORT) &&
      (bareIpv6 ||
        endpoint.hostname.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US'))
    )
  } catch {
    return false
  }
}

const LightEncodeConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('lightencode'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  host: LightEncodeHostSchema,
  port: z.literal(LIGHTENCODE_COMPANION_PORT),
  requestTimeoutMs: z
    .int()
    .min(LIGHTENCODE_REQUEST_TIMEOUT_MS_MIN)
    .max(LIGHTENCODE_REQUEST_TIMEOUT_MS_MAX),
  schemaVersion: z.literal(1),
})

export const LightEncodeConnectionDefinitionSchema =
  LightEncodeConnectionObjectSchema.readonly()

export type LightEncodeConnectionDefinition = z.infer<
  typeof LightEncodeConnectionDefinitionSchema
>
