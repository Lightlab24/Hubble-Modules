import { ModuleBindingSchema } from '@hubble/module-sdk'
import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const GENERIC_HTTP_REQUEST_TIMEOUT_MS_MIN = 100

export const GENERIC_HTTP_REQUEST_TIMEOUT_MS_MAX = 10_000

export const GENERIC_HTTP_BASE_URL_MAX_BYTES = 2_048

export const GENERIC_HTTP_PROXY_ADDRESS_MAX_BYTES = 2_048

export const GENERIC_HTTP_DEFAULT_PROXY_ADDRESS = ''

export const GENERIC_HTTP_DEFAULT_REJECT_UNAUTHORIZED = true

export const GENERIC_HTTP_DEFAULT_INSECURE_HTTP_PARSER = false

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

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const GenericHttpTargetScopeSchema = z.enum(['loopback', 'private-lan', 'public'])

function isCanonicalGenericHttpBaseUrl(value: string): boolean {
  if (
    value !== value.trim() ||
    utf8ByteLength(value) > GENERIC_HTTP_BASE_URL_MAX_BYTES ||
    /[\\\u0000-\u001F\u007F\u2028\u2029]/u.test(value)
  ) {
    return false
  }
  try {
    const endpoint = new URL(value)
    return (
      (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.hash === '' &&
      endpoint.hostname !== '' &&
      hasCanonicalGenericHttpAuthority(value)
    )
  } catch {
    return false
  }
}

export const GenericHttpBaseUrlSchema = z
  .string()
  .refine(
    (value) => value === '' || isCanonicalGenericHttpBaseUrl(value),
    'HTTP Requests base URL must be blank or an absolute HTTP(S) URL without credentials or a fragment',
  )

export const GenericHttpProxyAddressSchema = z
  .string()
  .refine(
    (value) => value === '' || isGenericHttpProxyAddress(value),
    'HTTP Requests proxy address must be blank or an absolute HTTP(S) URL',
  )

function isGenericHttpProxyAddress(value: string): boolean {
  if (
    value !== value.trim() ||
    utf8ByteLength(value) > GENERIC_HTTP_PROXY_ADDRESS_MAX_BYTES ||
    /[\\\u0000-\u001F\u007F\u2028\u2029]/u.test(value)
  ) {
    return false
  }
  try {
    const endpoint = new URL(value)
    return (
      (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
      endpoint.hostname !== '' &&
      endpoint.hash === ''
    )
  } catch {
    return false
  }
}

export function hasCanonicalGenericHttpAuthority(value: string): boolean {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return false
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return false
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(value)
  const authority = match?.[1]
  if (
    authority === undefined ||
    authority === '' ||
    authority.includes('@') ||
    authority.includes('%') ||
    !/^[\u0000-\u007F]+$/u.test(authority)
  ) {
    return false
  }
  const rawAuthority = parseRawHttpAuthority(authority)
  if (
    rawAuthority === null ||
    !hasCanonicalGenericHttpPort(rawAuthority.port, endpoint) ||
    rawAuthority.hostname === '' ||
    /[\u3002\uFF0E\uFF61]/u.test(rawAuthority.hostname) ||
    rawAuthority.hostname.normalize('NFKC') !== rawAuthority.hostname
  ) {
    return false
  }
  const rawHostname = rawAuthority.hostname
  return rawHostname.toLocaleLowerCase('en-US') === endpoint.hostname.toLocaleLowerCase('en-US')
}

interface RawHttpAuthority {
  readonly hostname: string
  readonly port: string | null
}

function parseRawHttpAuthority(authority: string): RawHttpAuthority | null {
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    if (closingBracket < 0) return null
    const suffix = authority.slice(closingBracket + 1)
    if (suffix !== '' && !/^:[0-9]+$/u.test(suffix)) return null
    return {
      hostname: authority.slice(0, closingBracket + 1),
      port: suffix === '' ? null : suffix.slice(1),
    }
  }
  const lastColon = authority.lastIndexOf(':')
  if (lastColon < 0) return { hostname: authority, port: null }
  if (!/^:[0-9]+$/u.test(authority.slice(lastColon))) return null
  return { hostname: authority.slice(0, lastColon), port: authority.slice(lastColon + 1) }
}

function hasCanonicalGenericHttpPort(rawPort: string | null, endpoint: URL): boolean {
  if (rawPort === null) return true
  const effectivePort =
    endpoint.port === '' ? (endpoint.protocol === 'https:' ? '443' : '80') : endpoint.port
  return /^(?:[1-9][0-9]{0,4})$/u.test(rawPort) && rawPort === effectivePort
}

const GenericHttpConnectionObjectSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  moduleBinding: ModuleBindingSchema.optional(),
  type: z.literal('generic-http'),
  name: ConnectionNameSchema,
  enabled: z.boolean(),
  baseUrl: GenericHttpBaseUrlSchema,
  targetScope: GenericHttpTargetScopeSchema.default('loopback'),
  proxyAddress: GenericHttpProxyAddressSchema.default(GENERIC_HTTP_DEFAULT_PROXY_ADDRESS),
  rejectUnauthorized: z.boolean().default(GENERIC_HTTP_DEFAULT_REJECT_UNAUTHORIZED),
  insecureHTTPParser: z.boolean().default(GENERIC_HTTP_DEFAULT_INSECURE_HTTP_PARSER),
  requestTimeoutMs: z
    .int()
    .min(GENERIC_HTTP_REQUEST_TIMEOUT_MS_MIN)
    .max(GENERIC_HTTP_REQUEST_TIMEOUT_MS_MAX),
  schemaVersion: z.literal(1),
})

export const GenericHttpConnectionDefinitionSchema =
  GenericHttpConnectionObjectSchema.readonly()

export type GenericHttpConnectionDefinition = z.infer<
  typeof GenericHttpConnectionDefinitionSchema
>
