import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { hasCanonicalGenericHttpAuthority } from './connections.js'
import { ActionColumnIdSchema, ConnectionIdSchema, SafeIdentifierSchema } from './primitives.js'

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const GENERIC_HTTP_REQUEST_TARGET_MAX_BYTES = 4_096

export const GENERIC_HTTP_BODY_MAX_BYTES = 262_144

export const GENERIC_HTTP_HEADER_MAX_BYTES = 65_536

export const GENERIC_HTTP_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'application/xml',
  'text/html',
  'text/plain',
  'text/csv',
  'text/xml',
  'multipart/form-data',
  'application/octet-stream',
  'application/javascript',
  'application/pdf',
  'application/zip',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'application/ld+json',
  'application/vnd.api+json',
  'application/x-yaml',
  'application/graphql',
] as const

export const GenericHttpContentTypeSchema = z.enum(GENERIC_HTTP_CONTENT_TYPES)

export type GenericHttpContentType = z.infer<typeof GenericHttpContentTypeSchema>

export const GenericHttpBodyTextSchema = z
  .string()
  .refine(
    (value) => utf8ByteLength(value) <= GENERIC_HTTP_BODY_MAX_BYTES,
    'HTTP Requests body must contain at most 262144 UTF-8 bytes',
  )

export const GenericHttpHeaderTextSchema = z
  .string()
  .refine(
    (value) => utf8ByteLength(value) <= GENERIC_HTTP_HEADER_MAX_BYTES,
    'HTTP Requests header must contain at most 65536 UTF-8 bytes',
  )

export const GenericHttpRequestTargetSchema = z
  .string()
  .refine(
    isGenericHttpRequestTarget,
    'HTTP Requests URL / URI must contain 0..4096 safe UTF-8 bytes',
  )

function isGenericHttpRequestTarget(value: string): boolean {
  if (
    value !== value.trim() ||
    utf8ByteLength(value) > GENERIC_HTTP_REQUEST_TARGET_MAX_BYTES ||
    /[\\#\u0000-\u001F\u007F\u2028\u2029]/u.test(value) ||
    value.startsWith('//')
  ) {
    return false
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return true
  try {
    const endpoint = new URL(value)
    return (
      (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
      hasCanonicalGenericHttpAuthority(value) &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.hash === '' &&
      endpoint.hostname !== ''
    )
  } catch {
    return false
  }
}

const GenericHttpActionIdentityShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  enabled: z.boolean(),
  requestTarget: GenericHttpRequestTargetSchema,
  header: GenericHttpHeaderTextSchema.default(''),
} as const

export const GenericHttpGetActionDefinitionSchema = z
  .strictObject({
    ...GenericHttpActionIdentityShape,
    type: z.literal('generic-http.get'),
  })
  .readonly()

const GenericHttpBodyActionShape = {
  ...GenericHttpActionIdentityShape,
  body: GenericHttpBodyTextSchema,
} as const

export const GenericHttpPostActionDefinitionSchema = z
  .strictObject({
    ...GenericHttpBodyActionShape,
    type: z.literal('generic-http.post'),
    contenttype: GenericHttpContentTypeSchema,
  })
  .readonly()

export const GenericHttpPutActionDefinitionSchema = z
  .strictObject({
    ...GenericHttpBodyActionShape,
    type: z.literal('generic-http.put'),
    contenttype: GenericHttpContentTypeSchema,
  })
  .readonly()

export const GenericHttpPatchActionDefinitionSchema = z
  .strictObject({
    ...GenericHttpBodyActionShape,
    type: z.literal('generic-http.patch'),
    contenttype: GenericHttpContentTypeSchema,
  })
  .readonly()

export const GenericHttpDeleteActionDefinitionSchema = z
  .strictObject({
    ...GenericHttpBodyActionShape,
    type: z.literal('generic-http.delete'),
  })
  .readonly()

export type GenericHttpGetActionDefinition = z.infer<
  typeof GenericHttpGetActionDefinitionSchema
>

export type GenericHttpPostActionDefinition = z.infer<
  typeof GenericHttpPostActionDefinitionSchema
>

export type GenericHttpPutActionDefinition = z.infer<
  typeof GenericHttpPutActionDefinitionSchema
>

export type GenericHttpPatchActionDefinition = z.infer<
  typeof GenericHttpPatchActionDefinitionSchema
>

export type GenericHttpDeleteActionDefinition = z.infer<
  typeof GenericHttpDeleteActionDefinitionSchema
>

export type GenericHttpActionDefinition =
  | GenericHttpGetActionDefinition
  | GenericHttpPostActionDefinition
  | GenericHttpPutActionDefinition
  | GenericHttpPatchActionDefinition
  | GenericHttpDeleteActionDefinition
