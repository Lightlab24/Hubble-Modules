import { gunzipSync } from 'node:zlib'

import { encodeOgpNetstring, type OgpNetstringFrame } from './netstring-codec.js'

export type OgpJsonObject = Readonly<Record<string, unknown>>

export interface OgpMessage {
  readonly type: string
  readonly slot?: number
  readonly payload?: unknown
  readonly zip?: string
  readonly [key: string]: unknown
}

export type DecodedOgpFrame =
  | Readonly<{ kind: 'keepalive' }>
  | Readonly<{ kind: 'message'; message: OgpMessage }>
  | Readonly<{ kind: 'unknown'; message: OgpMessage }>

export interface DecodeOgpFrameOptions {
  readonly maxInflatedBytes?: number
}

export interface OgpHandshakeOptions {
  readonly trusted: true
  readonly detail: 'minimal'
  readonly subscriptions: true
  readonly build?: string
}

export interface OgpValueReference {
  readonly oid: string
  readonly element?: true
  readonly index?: number
}

export interface OgpValuePayload extends OgpValueReference {
  readonly value: unknown
}

const KNOWN_MESSAGE_TYPES = new Set([
  'device',
  'error',
  'handshake',
  'multi-value',
  'restart',
  'value',
  'value-request',
  'device-request',
])
const DEFAULT_MAX_INFLATED_BYTES = 64 * 1024 * 1024

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObjectJson(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(
      `Invalid OGP ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isObject(parsed)) throw new Error(`Invalid OGP ${label}: expected a JSON object`)
  return parsed
}

function jsonMessage(value: Record<string, unknown>): OgpMessage {
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new Error('Invalid OGP message: missing string type')
  }
  if (value.slot !== undefined && !Number.isInteger(value.slot)) {
    throw new Error('Invalid OGP message: slot must be an integer')
  }
  return value as OgpMessage
}

export function encodeOgpJsonMessage(message: OgpMessage): Buffer {
  return encodeOgpNetstring(JSON.stringify(message))
}

export function encodeHandshake(options: OgpHandshakeOptions): Buffer {
  const payload: Record<string, unknown> = {
    trusted: true,
    force: false,
    detail: 'minimal',
    subscriptions: true,
  }
  if (options.build !== undefined) payload.build = options.build
  return encodeOgpJsonMessage({ type: 'handshake', slot: 0, payload })
}

export function encodeSubscriptionRequest(subscription: readonly string[]): Buffer {
  if (
    subscription.length === 0 ||
    subscription.some((oid) => typeof oid !== 'string' || oid.length === 0)
  ) {
    throw new Error('OGP subscription must contain at least one non-empty OID')
  }
  return encodeOgpJsonMessage({
    type: 'device-request',
    slot: 0,
    payload: {
      detail: 'subscription',
      subscription: [...subscription],
    },
  })
}

export function encodeValueRequest(reference: OgpValueReference): Buffer {
  if (typeof reference.oid !== 'string' || reference.oid.length === 0) {
    throw new Error('OGP value request requires an OID')
  }
  if (reference.element === true) {
    if (!Number.isSafeInteger(reference.index) || (reference.index ?? -1) < 0) {
      throw new Error('OGP element value request requires a non-negative integer index')
    }
  } else if (reference.index !== undefined) {
    throw new Error('OGP value request index requires element: true')
  }
  return encodeOgpJsonMessage({
    type: 'value-request',
    slot: 0,
    payload: { ...reference },
  })
}

export function encodeValueUpdate(payload: OgpValuePayload): Buffer {
  return encodeOgpJsonMessage({ type: 'value', slot: 0, payload: { ...payload } })
}

export function encodeMultiValueUpdate(payload: readonly OgpValuePayload[]): Buffer {
  if (payload.length === 0) throw new Error('OGP multi-value update must not be empty')
  return encodeOgpJsonMessage({
    type: 'multi-value',
    slot: 0,
    payload: payload.map((entry) => ({ ...entry })),
  })
}

export function decodeOgpFrame(
  frame: OgpNetstringFrame,
  options: DecodeOgpFrameOptions = {},
): DecodedOgpFrame {
  if (frame.text.length === 0) {
    if (frame.binary !== null && frame.binary.length > 0) {
      throw new Error('Invalid OGP keepalive with binary payload')
    }
    return Object.freeze({ kind: 'keepalive' })
  }
  const header = parseObjectJson(frame.text, 'message')
  let normalized = header
  if (frame.binary !== null) {
    if (header.zip !== 'gzip') {
      throw new Error(`Unsupported OGP binary compression: ${String(header.zip)}`)
    }
    const maxInflatedBytes = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES
    if (!Number.isSafeInteger(maxInflatedBytes) || maxInflatedBytes < 1) {
      throw new RangeError('maxInflatedBytes must be a positive safe integer')
    }
    let inflated: Buffer
    try {
      inflated = gunzipSync(frame.binary, { maxOutputLength: maxInflatedBytes })
    } catch (error) {
      throw new Error(
        `Unable to decompress OGP gzip payload: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    const decodedPayload = parseObjectJson(inflated, 'gzip payload')
    normalized =
      typeof decodedPayload.type === 'string'
        ? decodedPayload
        : { ...header, payload: decodedPayload }
  }
  const message = jsonMessage(normalized)
  return Object.freeze({
    kind: KNOWN_MESSAGE_TYPES.has(message.type) ? 'message' : 'unknown',
    message,
  }) as DecodedOgpFrame
}

export function isImplicitHandshakeSuccess(message: OgpMessage): boolean {
  return message.type === 'device' && isObject(message.payload)
}
