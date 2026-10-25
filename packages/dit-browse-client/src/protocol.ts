import { z } from 'zod'

export const DIT_BROWSE_PROTOCOL = 'ditbrowse.control' as const
export const DIT_BROWSE_PROTOCOL_VERSION = 1 as const
export const DIT_BROWSE_WEBSOCKET_PATH = '/api/ws' as const
export const DIT_BROWSE_REQUIRED_CAPABILITIES = [
  'status',
  'focusCamera',
  'showGrid',
  'toggleExpansion',
  'statusEvents',
] as const
export const DIT_BROWSE_CAPABILITIES = [
  ...DIT_BROWSE_REQUIRED_CAPABILITIES,
  'switchWorkspace',
] as const

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
export const DIT_BROWSE_MAX_CAMERA_NUMBER = 999_999
const MAX_ERROR_INPUT_LENGTH = 4_096
const MAX_ERROR_OUTPUT_LENGTH = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g
const DISALLOWED_LINE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function oneLineString(maxLength: number, requireValue: boolean) {
  const schema = requireValue ? z.string().min(1) : z.string()
  return schema
    .max(maxLength)
    .refine((value) => !DISALLOWED_LINE_CHARACTERS.test(value), 'must be one line')
}

export function sanitizeDitBrowseBoundaryText(value: string): string {
  const sanitized = value
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_OUTPUT_LENGTH)
  return sanitized || 'DIT Browse reported an error'
}

export const DitBrowsePositiveIntegerSchema = z.int().positive().max(MAX_SAFE_INTEGER)
export const DitBrowseCameraNumberSchema = z.int().positive().max(DIT_BROWSE_MAX_CAMERA_NUMBER)

export const DitBrowseRequestIdSchema = oneLineString(128, true)
export const DitBrowseCapabilitySchema = z.enum(DIT_BROWSE_CAPABILITIES)
export const DitBrowseCapabilitiesSchema = z
  .array(DitBrowseCapabilitySchema)
  .min(DIT_BROWSE_REQUIRED_CAPABILITIES.length)
  .max(DIT_BROWSE_CAPABILITIES.length)
  .superRefine((capabilities, context) => {
    const observed = new Set(capabilities)
    if (
      observed.size !== capabilities.length ||
      DIT_BROWSE_REQUIRED_CAPABILITIES.some((capability) => !observed.has(capability))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'DIT Browse capabilities must match protocol version 1',
      })
    }
  })
  .readonly()

const DitBrowseIdentifierSchema = oneLineString(512, true)
const DitBrowseNullableIdentifierSchema = DitBrowseIdentifierSchema.nullable()
const DitBrowseLabelSchema = oneLineString(512, false)
const DitBrowseUrlSchema = oneLineString(4_096, false)
const DitBrowseServerNameSchema = oneLineString(128, true)
const DitBrowseVersionSchema = oneLineString(128, true)
const DitBrowseErrorMessageSchema = z
  .string()
  .max(MAX_ERROR_INPUT_LENGTH)
  .transform(sanitizeDitBrowseBoundaryText)

export const DitBrowseStatusTabSchema = z
  .strictObject({
    index: DitBrowsePositiveIntegerSchema,
    tileId: DitBrowseIdentifierSchema,
    cameraId: DitBrowseNullableIdentifierSchema,
    cameraNumber: DitBrowseCameraNumberSchema.nullable(),
    title: DitBrowseLabelSchema,
    url: DitBrowseUrlSchema,
    workspaceNumbers: z.array(DitBrowsePositiveIntegerSchema).max(4096).readonly().optional(),
  })
  .readonly()

export const DitBrowseStatusSchema = z
  .strictObject({
    activeWorkspaceNumber: DitBrowsePositiveIntegerSchema.optional(),
    workspaceNumbers: z.array(DitBrowsePositiveIntegerSchema).max(4096).readonly().optional(),
    visibleTileIds: z.array(DitBrowseIdentifierSchema).max(4096).readonly().optional(),
    expansionEnabled: z.boolean(),
    focusMode: z.boolean(),
    selectedCameraNumber: DitBrowseCameraNumberSchema.nullable(),
    selectedTileId: DitBrowseNullableIdentifierSchema,
    selectedIndex: DitBrowsePositiveIntegerSchema.nullable(),
    tabs: z.array(DitBrowseStatusTabSchema).max(4_096).readonly(),
  })
  .readonly()

export const StatusCommandSchema = z.strictObject({ type: z.literal('status') }).readonly()
export const FocusCameraCommandSchema = z
  .strictObject({
    type: z.literal('focusCamera'),
    cameraNumber: DitBrowseCameraNumberSchema,
  })
  .readonly()
export const SwitchWorkspaceCommandSchema = z
  .strictObject({
    type: z.literal('switchWorkspace'),
    workspaceNumber: DitBrowsePositiveIntegerSchema,
  })
  .readonly()
export const ShowGridCommandSchema = z.strictObject({ type: z.literal('showGrid') }).readonly()
export const ToggleExpansionCommandSchema = z
  .strictObject({ type: z.literal('toggleExpansion') })
  .readonly()
export const DitBrowseCommandSchema = z.discriminatedUnion('type', [
  StatusCommandSchema,
  FocusCameraCommandSchema,
  SwitchWorkspaceCommandSchema,
  ShowGridCommandSchema,
  ToggleExpansionCommandSchema,
])

export const DitBrowseClientHelloSchema = z
  .strictObject({
    type: z.literal('hello'),
    protocol: z.literal(DIT_BROWSE_PROTOCOL),
    protocolVersion: z.literal(DIT_BROWSE_PROTOCOL_VERSION),
    client: z
      .strictObject({
        name: oneLineString(128, true),
        version: DitBrowseVersionSchema,
      })
      .readonly(),
  })
  .readonly()

export const DitBrowseCommandMessageSchema = z
  .strictObject({
    type: z.literal('command'),
    requestId: DitBrowseRequestIdSchema,
    command: DitBrowseCommandSchema,
  })
  .readonly()

export const DitBrowseServerHelloSchema = z
  .strictObject({
    type: z.literal('hello'),
    protocol: z.literal(DIT_BROWSE_PROTOCOL),
    protocolVersion: z.literal(DIT_BROWSE_PROTOCOL_VERSION),
    server: z
      .strictObject({
        name: DitBrowseServerNameSchema,
        version: DitBrowseVersionSchema,
      })
      .readonly(),
    capabilities: DitBrowseCapabilitiesSchema,
  })
  .readonly()

export const DitBrowseCommandErrorCodeSchema = z.enum([
  'bad_request',
  'not_found',
  'renderer_unavailable',
  'timeout',
  'internal_error',
])

const DitBrowseRejectedResultSchema = z
  .strictObject({
    type: z.literal('result'),
    requestId: DitBrowseRequestIdSchema,
    ok: z.literal(false),
    error: z
      .strictObject({
        code: DitBrowseCommandErrorCodeSchema,
        message: DitBrowseErrorMessageSchema,
      })
      .readonly(),
  })
  .readonly()

const DitBrowseSuccessfulResultSchema = z
  .strictObject({
    type: z.literal('result'),
    requestId: DitBrowseRequestIdSchema,
    ok: z.literal(true),
    status: DitBrowseStatusSchema.optional(),
  })
  .readonly()

export const DitBrowseCommandResultSchema = z.discriminatedUnion('ok', [
  DitBrowseSuccessfulResultSchema,
  DitBrowseRejectedResultSchema,
])

export const DitBrowseStatusEventSchema = z
  .strictObject({
    type: z.literal('event'),
    event: z.literal('status'),
    revision: z.int().nonnegative().max(MAX_SAFE_INTEGER),
    status: DitBrowseStatusSchema,
  })
  .readonly()

export const DitBrowseProtocolErrorCodeSchema = z.enum(['bad_request', 'unsupported_protocol'])
export const DitBrowseProtocolErrorSchema = z
  .strictObject({
    type: z.literal('error'),
    error: z
      .strictObject({
        code: DitBrowseProtocolErrorCodeSchema,
        message: DitBrowseErrorMessageSchema,
      })
      .readonly(),
  })
  .readonly()

export const DitBrowseServerMessageSchema = z.union([
  DitBrowseServerHelloSchema,
  DitBrowseCommandResultSchema,
  DitBrowseStatusEventSchema,
  DitBrowseProtocolErrorSchema,
])

export type DitBrowseStatusTab = z.infer<typeof DitBrowseStatusTabSchema>
export type DitBrowseStatus = z.infer<typeof DitBrowseStatusSchema>
export type DitBrowseCommand = z.infer<typeof DitBrowseCommandSchema>
export type DitBrowseClientHello = z.infer<typeof DitBrowseClientHelloSchema>
export type DitBrowseCommandMessage = z.infer<typeof DitBrowseCommandMessageSchema>
export type DitBrowseServerHello = z.infer<typeof DitBrowseServerHelloSchema>
export type DitBrowseCommandResult = z.infer<typeof DitBrowseCommandResultSchema>
export type DitBrowseStatusEvent = z.infer<typeof DitBrowseStatusEventSchema>
export type DitBrowseProtocolErrorMessage = z.infer<typeof DitBrowseProtocolErrorSchema>
export type DitBrowseServerMessage = z.infer<typeof DitBrowseServerMessageSchema>
export type DitBrowseCommandErrorCode = z.infer<typeof DitBrowseCommandErrorCodeSchema>

export class DitBrowseProtocolValidationError extends Error {
  override readonly name = 'DitBrowseProtocolValidationError'
}

export function parseDitBrowseServerMessage(value: unknown): DitBrowseServerMessage {
  const parsed = DitBrowseServerMessageSchema.safeParse(value)
  if (!parsed.success) {
    throw new DitBrowseProtocolValidationError('Invalid DIT Browse server message')
  }
  return parsed.data
}

export function createDitBrowseClientHello(
  clientName: string,
  clientVersion: string,
): DitBrowseClientHello {
  return DitBrowseClientHelloSchema.parse({
    type: 'hello',
    protocol: DIT_BROWSE_PROTOCOL,
    protocolVersion: DIT_BROWSE_PROTOCOL_VERSION,
    client: { name: clientName, version: clientVersion },
  })
}

export function createDitBrowseCommandMessage(
  requestId: string,
  command: DitBrowseCommand,
): DitBrowseCommandMessage {
  return DitBrowseCommandMessageSchema.parse({ type: 'command', requestId, command })
}

export function createFocusCameraCommand(
  requestId: string,
  cameraNumber: number,
): DitBrowseCommandMessage {
  if (
    !Number.isSafeInteger(cameraNumber) ||
    cameraNumber < 1 ||
    cameraNumber > DIT_BROWSE_MAX_CAMERA_NUMBER
  ) {
    throw new RangeError('cameraNumber must be an integer between 1 and 999999')
  }
  return createDitBrowseCommandMessage(requestId, { type: 'focusCamera', cameraNumber })
}
