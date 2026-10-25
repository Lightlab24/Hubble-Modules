import { randomUUID } from 'node:crypto'

import { z } from 'zod'

export const LIGHTENCODE_PROTOCOL_NAME = 'lightencode-companion' as const
export const LIGHTENCODE_PROTOCOL_VERSION = 1 as const
export const LIGHTENCODE_COMPANION_PORT = 59_613 as const
export const LIGHTENCODE_CLIENT_ID = 'bitfocus-companion' as const
export const LIGHTENCODE_CLIENT_VERSION = '1.0.5' as const
export const LIGHTENCODE_CAPABILITIES = [
  'record.toggleAll',
  'record.togglePipeline',
  'timer.toggle',
  'timer.set',
] as const
export const LIGHTENCODE_MAXIMUM_MESSAGE_BYTES = 256 * 1_024
export const LIGHTENCODE_MINIMUM_SLOT_NUMBER = 1
export const LIGHTENCODE_MAXIMUM_SLOT_NUMBER = 999
export const LIGHTENCODE_MINIMUM_TIMER_MINUTES = 0
export const LIGHTENCODE_MAXIMUM_TIMER_MINUTES = 1_440

const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const MAXIMUM_DIAGNOSTIC_INPUT_LENGTH = 4_096
const MAXIMUM_DIAGNOSTIC_OUTPUT_LENGTH = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu
const DISALLOWED_LINE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

function oneLineString(maximumLength: number, requireValue: boolean) {
  const schema = requireValue ? z.string().min(1) : z.string()
  return schema
    .max(maximumLength)
    .refine((value) => !DISALLOWED_LINE_CHARACTERS.test(value), 'must be one line')
}

export function sanitizeLightEncodeBoundaryText(value: string): string {
  const sanitized = value
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAXIMUM_DIAGNOSTIC_OUTPUT_LENGTH)
  return sanitized || 'Light Encode reported an error'
}

const LightEncodeVersionSchema = oneLineString(128, true)
const LightEncodeCapabilitySchema = oneLineString(128, true)
const LightEncodeCodeSchema = oneLineString(128, true)
const LightEncodeCameraIdSchema = oneLineString(512, false)
const LightEncodeUuidSchema = z.uuid()
const LightEncodeRevisionSchema = z.int().nonnegative().max(MAXIMUM_SAFE_INTEGER)
const LightEncodeTimestampSchema = z.int().nonnegative().max(MAXIMUM_SAFE_INTEGER)
const LightEncodeDiagnosticSchema = z
  .string()
  .max(MAXIMUM_DIAGNOSTIC_INPUT_LENGTH)
  .transform(sanitizeLightEncodeBoundaryText)

export const LightEncodeCommandNameSchema = z.enum(LIGHTENCODE_CAPABILITIES)
export type LightEncodeCommandName = z.infer<typeof LightEncodeCommandNameSchema>

export const LightEncodeRecordingStateSchema = z.enum([
  'idle',
  'recording',
  'finishing',
  'error',
])
export type LightEncodeRecordingState = z.infer<typeof LightEncodeRecordingStateSchema>

export const LightEncodePipelineStateSchema = z
  .strictObject({
    pipelineId: LightEncodeUuidSchema,
    cameraId: LightEncodeCameraIdSchema,
    recordingEnabled: z.boolean(),
    canStartRecording: z.boolean(),
    recordingState: LightEncodeRecordingStateSchema,
    errorMessage: LightEncodeDiagnosticSchema.nullable(),
  })
  .readonly()
export type LightEncodePipelineState = z.infer<typeof LightEncodePipelineStateSchema>

export const LightEncodeAppStateSchema = z
  .strictObject({
    anyRecording: z.boolean(),
    timerEnabled: z.boolean(),
    timerMinutes: z
      .int()
      .min(LIGHTENCODE_MINIMUM_TIMER_MINUTES)
      .max(LIGHTENCODE_MAXIMUM_TIMER_MINUTES),
  })
  .readonly()
export type LightEncodeAppState = z.infer<typeof LightEncodeAppStateSchema>

export const LightEncodeStateSnapshotSchema = z
  .strictObject({
    type: z.literal('state'),
    revision: LightEncodeRevisionSchema,
    app: LightEncodeAppStateSchema,
    pipelines: z.array(LightEncodePipelineStateSchema).max(4_096).readonly(),
  })
  .readonly()
export type LightEncodeStateSnapshot = z.infer<typeof LightEncodeStateSnapshotSchema>

const LightEncodePipelinesRecordingConfirmationSchema = z
  .strictObject({
    kind: z.literal('pipelinesRecording'),
    pipelineIds: z.array(LightEncodeUuidSchema).max(4_096).readonly(),
    recording: z.boolean(),
  })
  .readonly()
const LightEncodeTimerEnabledConfirmationSchema = z
  .strictObject({
    kind: z.literal('timerEnabled'),
    enabled: z.boolean(),
  })
  .readonly()
const LightEncodeTimerMinutesConfirmationSchema = z
  .strictObject({
    kind: z.literal('timerMinutes'),
    minutes: z
      .int()
      .min(LIGHTENCODE_MINIMUM_TIMER_MINUTES)
      .max(LIGHTENCODE_MAXIMUM_TIMER_MINUTES),
  })
  .readonly()
export const LightEncodeConfirmationSchema = z.discriminatedUnion('kind', [
  LightEncodePipelinesRecordingConfirmationSchema,
  LightEncodeTimerEnabledConfirmationSchema,
  LightEncodeTimerMinutesConfirmationSchema,
])
export type LightEncodeConfirmation = z.infer<typeof LightEncodeConfirmationSchema>

export const LightEncodeClientHelloSchema = z
  .strictObject({
    type: z.literal('hello'),
    protocol: z.literal(LIGHTENCODE_PROTOCOL_NAME),
    protocolVersion: z.literal(LIGHTENCODE_PROTOCOL_VERSION),
    client: z.literal(LIGHTENCODE_CLIENT_ID),
    clientVersion: LightEncodeVersionSchema,
  })
  .readonly()
export type LightEncodeClientHello = z.infer<typeof LightEncodeClientHelloSchema>

export const LightEncodeHelloAckSchema = z
  .strictObject({
    type: z.literal('helloAck'),
    protocol: z.literal(LIGHTENCODE_PROTOCOL_NAME),
    protocolVersion: z.literal(LIGHTENCODE_PROTOCOL_VERSION),
    appVersion: LightEncodeVersionSchema,
    sessionId: LightEncodeUuidSchema,
    capabilities: z
      .array(LightEncodeCapabilitySchema)
      .max(64)
      .superRefine((capabilities, context) => {
        const observed = new Set(capabilities)
        if (observed.size !== capabilities.length) {
          context.addIssue({ code: 'custom', message: 'capabilities must be unique' })
        }
        for (const capability of LIGHTENCODE_CAPABILITIES) {
          if (!observed.has(capability)) {
            context.addIssue({
              code: 'custom',
              message: `missing required capability ${capability}`,
            })
          }
        }
      })
      .readonly(),
  })
  .readonly()
export type LightEncodeHelloAck = z.infer<typeof LightEncodeHelloAckSchema>

const EmptyArgumentsSchema = z.strictObject({}).readonly()
const AllTargetSchema = z.strictObject({ scope: z.literal('all') }).readonly()
const PipelineTargetSchema = z
  .strictObject({ scope: z.literal('pipeline'), pipelineId: LightEncodeUuidSchema })
  .readonly()
const AppTargetSchema = z.strictObject({ scope: z.literal('app') }).readonly()
const TimerArgumentsSchema = z
  .strictObject({
    minutes: z
      .int()
      .min(LIGHTENCODE_MINIMUM_TIMER_MINUTES)
      .max(LIGHTENCODE_MAXIMUM_TIMER_MINUTES),
  })
  .readonly()

export const LightEncodeCommandTargetSchema = z.union([
  AllTargetSchema,
  PipelineTargetSchema,
  AppTargetSchema,
])
export type LightEncodeCommandTarget = z.infer<typeof LightEncodeCommandTargetSchema>
export const LightEncodeCommandArgumentsSchema = z.union([
  EmptyArgumentsSchema,
  TimerArgumentsSchema,
])
export type LightEncodeCommandArguments = z.infer<typeof LightEncodeCommandArgumentsSchema>

const ToggleAllCommandSchema = z
  .strictObject({
    type: z.literal('command'),
    id: LightEncodeUuidSchema,
    name: z.literal('record.toggleAll'),
    target: AllTargetSchema,
    args: EmptyArgumentsSchema,
  })
  .readonly()
const TogglePipelineCommandSchema = z
  .strictObject({
    type: z.literal('command'),
    id: LightEncodeUuidSchema,
    name: z.literal('record.togglePipeline'),
    target: PipelineTargetSchema,
    args: EmptyArgumentsSchema,
  })
  .readonly()
const ToggleTimerCommandSchema = z
  .strictObject({
    type: z.literal('command'),
    id: LightEncodeUuidSchema,
    name: z.literal('timer.toggle'),
    target: AppTargetSchema,
    args: EmptyArgumentsSchema,
  })
  .readonly()
const SetTimerCommandSchema = z
  .strictObject({
    type: z.literal('command'),
    id: LightEncodeUuidSchema,
    name: z.literal('timer.set'),
    target: AppTargetSchema,
    args: TimerArgumentsSchema,
  })
  .readonly()
export const LightEncodeCommandRequestSchema = z.discriminatedUnion('name', [
  ToggleAllCommandSchema,
  TogglePipelineCommandSchema,
  ToggleTimerCommandSchema,
  SetTimerCommandSchema,
])
export type LightEncodeCommandRequest = z.infer<typeof LightEncodeCommandRequestSchema>

const CanonicalLightEncodeCommandFailureSchema = z
  .strictObject({
    pipelineId: LightEncodeUuidSchema.nullable().optional(),
    cameraId: LightEncodeCameraIdSchema.nullable().optional(),
    code: LightEncodeCodeSchema,
    reason: LightEncodeDiagnosticSchema,
  })
  .readonly()
const SwiftLightEncodeCommandFailureSchema = z
  .strictObject({
    pipelineID: LightEncodeUuidSchema.nullable().optional(),
    cameraID: LightEncodeCameraIdSchema.nullable().optional(),
    code: LightEncodeCodeSchema,
    reason: LightEncodeDiagnosticSchema,
  })
  .readonly()
export const LightEncodeCommandFailureSchema = z
  .union([CanonicalLightEncodeCommandFailureSchema, SwiftLightEncodeCommandFailureSchema])
  .transform((failure) => {
    if ('pipelineID' in failure || 'cameraID' in failure) {
      return Object.freeze({
        ...('pipelineID' in failure ? { pipelineId: failure.pipelineID } : {}),
        ...('cameraID' in failure ? { cameraId: failure.cameraID } : {}),
        code: failure.code,
        reason: failure.reason,
      })
    }
    return failure
  })
export type LightEncodeCommandFailure = z.infer<typeof LightEncodeCommandFailureSchema>

const ResponseSharedShape = {
  type: z.literal('response'),
  id: LightEncodeUuidSchema,
  code: LightEncodeCodeSchema.nullable().optional(),
  message: LightEncodeDiagnosticSchema.nullable().optional(),
  stateRevision: LightEncodeRevisionSchema,
  failures: z
    .array(LightEncodeCommandFailureSchema)
    .max(4_096)
    .readonly()
    .nullable()
    .optional(),
}
const LightEncodeSuccessfulCommandResponseSchema = z
  .strictObject({
    ...ResponseSharedShape,
    ok: z.literal(true),
    confirmation: LightEncodeConfirmationSchema,
  })
  .readonly()
const LightEncodeRejectedCommandResponseSchema = z
  .strictObject({
    ...ResponseSharedShape,
    ok: z.literal(false),
    confirmation: z.null().optional(),
  })
  .readonly()
export const LightEncodeCommandResponseSchema = z.discriminatedUnion('ok', [
  LightEncodeSuccessfulCommandResponseSchema,
  LightEncodeRejectedCommandResponseSchema,
])
export type LightEncodeCommandResponse = z.infer<typeof LightEncodeCommandResponseSchema>

export const LightEncodeErrorResponseSchema = z
  .strictObject({
    type: z.literal('error'),
    id: LightEncodeUuidSchema.nullable().optional(),
    code: LightEncodeCodeSchema,
    message: LightEncodeDiagnosticSchema,
  })
  .readonly()
export type LightEncodeErrorResponse = z.infer<typeof LightEncodeErrorResponseSchema>

export const LightEncodePingSchema = z
  .strictObject({ type: z.literal('ping'), timestamp: LightEncodeTimestampSchema })
  .readonly()
export type LightEncodePing = z.infer<typeof LightEncodePingSchema>
export const LightEncodePongSchema = z
  .strictObject({ type: z.literal('pong'), timestamp: LightEncodeTimestampSchema })
  .readonly()
export type LightEncodePong = z.infer<typeof LightEncodePongSchema>

export const LightEncodeServerMessageSchema = z.union([
  LightEncodeHelloAckSchema,
  LightEncodeCommandResponseSchema,
  LightEncodeErrorResponseSchema,
  LightEncodeStateSnapshotSchema,
  LightEncodePingSchema,
  LightEncodePongSchema,
])
export type LightEncodeServerMessage = z.infer<typeof LightEncodeServerMessageSchema>

export class LightEncodeProtocolValidationError extends Error {
  override readonly name: string = 'LightEncodeProtocolValidationError'
}

export class LightEncodeFramingError extends LightEncodeProtocolValidationError {
  override readonly name = 'LightEncodeFramingError'
}

export function parseLightEncodeServerMessage(value: unknown): LightEncodeServerMessage {
  const parsed = LightEncodeServerMessageSchema.safeParse(value)
  if (!parsed.success) {
    throw new LightEncodeProtocolValidationError('Invalid Light Encode server message')
  }
  return parsed.data
}

export function createLightEncodeClientHello(
  clientVersion: string = LIGHTENCODE_CLIENT_VERSION,
): LightEncodeClientHello {
  return LightEncodeClientHelloSchema.parse({
    type: 'hello',
    protocol: LIGHTENCODE_PROTOCOL_NAME,
    protocolVersion: LIGHTENCODE_PROTOCOL_VERSION,
    client: LIGHTENCODE_CLIENT_ID,
    clientVersion,
  })
}

export function createLightEncodeCommand(
  name: LightEncodeCommandName,
  target: LightEncodeCommandTarget,
  args: LightEncodeCommandArguments,
  id: string = randomUUID(),
): LightEncodeCommandRequest {
  return LightEncodeCommandRequestSchema.parse({ type: 'command', id, name, target, args })
}

export function encodeLightEncodeClientMessage(
  message:
    | LightEncodeClientHello
    | LightEncodeCommandRequest
    | LightEncodePing
    | LightEncodePong,
): string {
  return `${JSON.stringify(message)}\n`
}

export class LightEncodeNdjsonFramer {
  private buffer = Buffer.alloc(0)
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(private readonly maximumBytes = LIGHTENCODE_MAXIMUM_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError('maximumBytes must be a positive integer')
    }
  }

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []

    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break

      let frame = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      if (frame.length > this.maximumBytes) throw oversizedFrameError()
      if (frame.length === 0) continue

      let text: string
      try {
        text = this.decoder.decode(frame)
      } catch (error) {
        throw new LightEncodeFramingError('Light Encode frame is not valid UTF-8', {
          cause: error,
        })
      }
      try {
        messages.push(JSON.parse(text) as unknown)
      } catch (error) {
        throw new LightEncodeFramingError('Light Encode frame contains invalid JSON', {
          cause: error,
        })
      }
    }

    if (this.buffer.length > this.maximumBytes) throw oversizedFrameError()
    return messages
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

function oversizedFrameError(): LightEncodeFramingError {
  return new LightEncodeFramingError('Light Encode protocol message exceeds 256 KiB')
}
