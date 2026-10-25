import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const CYANVIEW_RCP_REQUEST_TIMEOUT_MS_MIN = 100

export const CYANVIEW_RCP_REQUEST_TIMEOUT_MS_MAX = 4_000

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

export const CyanViewRcpHostSchema = z
  .string()
  .trim()
  .refine(
    isCyanViewStudioHost,
    'CyanView RCP host must be a hostname, IPv4 address, or bracketed IPv6 address',
  )

function isCyanViewStudioHost(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false
  const hostname =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
      value,
    )
  const bracketedIpv6 = /^\[[0-9A-Fa-f:.]+\]$/u.test(value)
  if (!hostname && !bracketedIpv6) return false
  try {
    const endpoint = new URL(`http://${value}:4173/`)
    return (
      endpoint.protocol === 'http:' &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.pathname === '/' &&
      endpoint.search === '' &&
      endpoint.hash === '' &&
      endpoint.port === '4173' &&
      (bracketedIpv6 ||
        endpoint.hostname.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US'))
    )
  } catch {
    return false
  }
}

const CyanViewRcpConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('cyanview-rcp'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  host: CyanViewRcpHostSchema,
  port: z.int().min(1).max(65_535),
  requestTimeoutMs: z
    .int()
    .min(CYANVIEW_RCP_REQUEST_TIMEOUT_MS_MIN)
    .max(CYANVIEW_RCP_REQUEST_TIMEOUT_MS_MAX),
  schemaVersion: z.literal(1),
})

export const CyanViewRcpConnectionDefinitionSchema =
  CyanViewRcpConnectionObjectSchema.readonly()
