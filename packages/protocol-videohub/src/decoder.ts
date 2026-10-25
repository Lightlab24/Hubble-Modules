import { StringDecoder } from 'node:string_decoder'

import {
  MAX_VIDEOHUB_ADDRESS,
  VideohubDecodeError,
  fromVideohubAddress,
  immutableCrosspoint,
  immutableLabel,
  immutableLock,
  type VideohubDeviceStatus,
  type VideohubLockState,
  type VideohubProtocolMessage,
} from './protocol.js'

export interface VideohubSectionDecoderOptions {
  readonly maxBufferedBytes?: number
}

// A theoretical 65,536-port router needs several MiB for a complete label
// block. The cap remains finite so a peer cannot grow an unterminated section
// without bound.
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1_048_576

function immutableLines(lines: readonly string[]): readonly string[] {
  return Object.freeze([...lines])
}

function parseInteger(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = value === undefined || !/^\d+$/u.test(value) ? Number.NaN : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new VideohubDecodeError(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    )
  }
  return parsed
}

function keyValues(lines: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  return values
}

function parsePreamble(lines: readonly string[]): VideohubProtocolMessage {
  const version = keyValues(lines).get('Version')
  const match = version === undefined ? null : /^(\d+)\.(\d+)$/u.exec(version)
  if (match === null)
    throw new VideohubDecodeError('Protocol preamble is missing a valid Version')
  return Object.freeze({
    type: 'protocol-preamble',
    version: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
  })
}

function parseDeviceStatus(
  value: string | undefined,
): Exclude<VideohubDeviceStatus, 'unknown'> {
  if (value === 'true') return 'present'
  if (value === 'false') return 'absent'
  if (value !== undefined && /^needs[\s_-]+update$/iu.test(value)) return 'needs-update'
  throw new VideohubDecodeError('VIDEOHUB DEVICE is missing a valid Device present value')
}

function parseDevice(lines: readonly string[]): VideohubProtocolMessage {
  const values = keyValues(lines)
  const status = parseDeviceStatus(values.get('Device present'))
  if (status !== 'present') {
    return Object.freeze({
      type: 'device',
      status,
      modelName: null,
      videoInputs: null,
      videoOutputs: null,
    })
  }
  const modelName = values.get('Model name')?.trim()
  if (modelName === undefined || modelName.length === 0) {
    throw new VideohubDecodeError('VIDEOHUB DEVICE is missing Model name')
  }
  const videoInputs = parseInteger(
    values.get('Video inputs'),
    'Video inputs',
    1,
    MAX_VIDEOHUB_ADDRESS,
  )
  const videoOutputs = parseInteger(
    values.get('Video outputs'),
    'Video outputs',
    1,
    MAX_VIDEOHUB_ADDRESS,
  )
  return Object.freeze({ type: 'device', status, modelName, videoInputs, videoOutputs })
}

function parseLabels(lines: readonly string[], type: 'input-labels' | 'output-labels') {
  const labels = lines.flatMap((line) => {
    // Preserve Unicode line separators in the decoded value so the client can
    // reject them as unsafe display text and substitute its numeric fallback.
    const match = /^(\d+)(?: (.*))?$/su.exec(line)
    if (match === null) return []
    const wireAddress = Number(match[1])
    if (
      !Number.isSafeInteger(wireAddress) ||
      wireAddress < 0 ||
      wireAddress >= MAX_VIDEOHUB_ADDRESS
    ) {
      return []
    }
    return [immutableLabel({ address: fromVideohubAddress(wireAddress), name: match[2] ?? '' })]
  })
  return Object.freeze({ type, labels: Object.freeze(labels) })
}

function parseRoutes(lines: readonly string[]): VideohubProtocolMessage {
  const crosspoints = lines.flatMap((line) => {
    const match = /^(\d+) (\d+)$/u.exec(line)
    if (match === null) return []
    const destination = Number(match[1])
    const source = Number(match[2])
    if (
      !Number.isSafeInteger(destination) ||
      destination < 0 ||
      destination >= MAX_VIDEOHUB_ADDRESS ||
      !Number.isSafeInteger(source) ||
      source < 0 ||
      source >= MAX_VIDEOHUB_ADDRESS
    ) {
      return []
    }
    return [
      immutableCrosspoint({
        destination: fromVideohubAddress(destination),
        source: fromVideohubAddress(source),
      }),
    ]
  })
  return Object.freeze({
    type: 'video-output-routing',
    crosspoints: Object.freeze(crosspoints),
  })
}

function parseLockState(value: string): VideohubLockState | null {
  if (value === 'U') return 'unlocked'
  if (value === 'O') return 'owned'
  if (value === 'L') return 'locked'
  return null
}

function parseLocks(lines: readonly string[]): VideohubProtocolMessage {
  const locks = lines.flatMap((line) => {
    const match = /^(\d+) ([UOL])$/u.exec(line)
    if (match === null) return []
    const destination = Number(match[1])
    const state = parseLockState(match[2] ?? '')
    if (
      state === null ||
      !Number.isSafeInteger(destination) ||
      destination < 0 ||
      destination >= MAX_VIDEOHUB_ADDRESS
    ) {
      return []
    }
    return [immutableLock({ destination: fromVideohubAddress(destination), state })]
  })
  return Object.freeze({ type: 'video-output-locks', locks: Object.freeze(locks) })
}

export function decodeVideohubSection(lines: readonly string[]): VideohubProtocolMessage {
  const [firstLine, ...body] = lines
  if (firstLine === undefined || firstLine.length === 0) {
    throw new VideohubDecodeError('Videohub section must not be empty')
  }
  if (firstLine === 'ACK') return Object.freeze({ type: 'ack' })
  if (firstLine === 'NAK') return Object.freeze({ type: 'nak' })
  if (!firstLine.endsWith(':')) {
    return Object.freeze({ type: 'unknown', header: firstLine, lines: immutableLines(body) })
  }
  const header = firstLine.slice(0, -1)
  switch (header) {
    case 'PROTOCOL PREAMBLE':
      return parsePreamble(body)
    case 'VIDEOHUB DEVICE':
      return parseDevice(body)
    case 'INPUT LABELS':
      return parseLabels(body, 'input-labels')
    case 'OUTPUT LABELS':
      return parseLabels(body, 'output-labels')
    case 'VIDEO OUTPUT ROUTING':
      return parseRoutes(body)
    case 'VIDEO OUTPUT LOCKS':
      return parseLocks(body)
    default:
      return Object.freeze({ type: 'unknown', header, lines: immutableLines(body) })
  }
}

export class VideohubSectionDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxBufferedBytes: number
  private readonly sectionLines: string[] = []
  private currentLine = ''
  private bufferedBytes = 0
  private pendingCarriageReturn = false

  public constructor(options: VideohubSectionDecoderOptions = {}) {
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new RangeError('maxBufferedBytes must be a positive integer')
    }
    this.maxBufferedBytes = maxBufferedBytes
  }

  public push(chunk: Uint8Array | string): readonly VideohubProtocolMessage[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    const messages: VideohubProtocolMessage[] = []
    for (const character of text) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false
        if (character === '\n') continue
      }
      if (character === '\r') {
        this.finishLine(messages)
        this.pendingCarriageReturn = true
        continue
      }
      if (character === '\n') {
        this.finishLine(messages)
        continue
      }
      this.currentLine += character
      this.bufferedBytes += Buffer.byteLength(character, 'utf8')
      if (this.bufferedBytes > this.maxBufferedBytes) {
        this.reset()
        throw new VideohubDecodeError(
          `Videohub section exceeded ${String(this.maxBufferedBytes)} bytes`,
        )
      }
    }
    return Object.freeze(messages)
  }

  public reset(): void {
    this.decoder.end()
    this.sectionLines.length = 0
    this.currentLine = ''
    this.bufferedBytes = 0
    this.pendingCarriageReturn = false
  }

  private finishLine(messages: VideohubProtocolMessage[]): void {
    if (this.currentLine.length > 0) {
      this.sectionLines.push(this.currentLine)
      this.bufferedBytes += 1
      this.currentLine = ''
      if (this.bufferedBytes > this.maxBufferedBytes) {
        this.reset()
        throw new VideohubDecodeError(
          `Videohub section exceeded ${String(this.maxBufferedBytes)} bytes`,
        )
      }
      return
    }
    if (this.sectionLines.length === 0) return
    const lines = [...this.sectionLines]
    this.sectionLines.length = 0
    this.bufferedBytes = 0
    messages.push(decodeVideohubSection(lines))
  }
}
