export const MAX_VIDEOHUB_ADDRESS = 65_536
export const DEFAULT_VIDEOHUB_PORT = 9_990

export type VideohubDeviceStatus = 'unknown' | 'present' | 'absent' | 'needs-update'
export type VideohubLockState = 'unlocked' | 'owned' | 'locked'

export interface VideohubRouterLabel {
  readonly address: number
  readonly name: string
}

export interface VideohubCrosspoint {
  readonly destination: number
  readonly source: number
}

export interface VideohubOutputLock {
  readonly destination: number
  readonly state: VideohubLockState
}

export type VideohubProtocolMessage =
  | Readonly<{
      type: 'protocol-preamble'
      version: string
      major: number
      minor: number
    }>
  | Readonly<{
      type: 'device'
      status: Exclude<VideohubDeviceStatus, 'unknown'>
      modelName: string | null
      videoInputs: number | null
      videoOutputs: number | null
    }>
  | Readonly<{ type: 'input-labels'; labels: readonly VideohubRouterLabel[] }>
  | Readonly<{ type: 'output-labels'; labels: readonly VideohubRouterLabel[] }>
  | Readonly<{ type: 'video-output-routing'; crosspoints: readonly VideohubCrosspoint[] }>
  | Readonly<{ type: 'video-output-locks'; locks: readonly VideohubOutputLock[] }>
  | Readonly<{ type: 'ack' }>
  | Readonly<{ type: 'nak' }>
  | Readonly<{ type: 'unknown'; header: string; lines: readonly string[] }>

export type VideohubStatusHeader =
  | 'INPUT LABELS'
  | 'OUTPUT LABELS'
  | 'VIDEO OUTPUT ROUTING'
  | 'VIDEO OUTPUT LOCKS'

export type VideohubErrorCode =
  | 'disconnected'
  | 'timeout'
  | 'rejected'
  | 'locked'
  | 'protocol-error'
  | 'unsupported-dimensions'
  | 'conflicting-readback'

export class VideohubError extends Error {
  public readonly code: VideohubErrorCode

  public constructor(code: VideohubErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VideohubError'
    this.code = code
  }
}

export class VideohubDecodeError extends VideohubError {
  public constructor(message: string, options?: ErrorOptions) {
    super('protocol-error', message, options)
    this.name = 'VideohubDecodeError'
  }
}

export function assertHubbleAddress(address: number, label = 'address'): number {
  if (!Number.isSafeInteger(address) || address < 1 || address > MAX_VIDEOHUB_ADDRESS) {
    throw new RangeError(
      `${label} must be an integer from 1 to ${String(MAX_VIDEOHUB_ADDRESS)}`,
    )
  }
  return address
}

export function toVideohubAddress(address: number): number {
  return assertHubbleAddress(address) - 1
}

export function fromVideohubAddress(address: number): number {
  if (!Number.isSafeInteger(address) || address < 0 || address >= MAX_VIDEOHUB_ADDRESS) {
    throw new RangeError(
      `Videohub address must be an integer from 0 to ${String(MAX_VIDEOHUB_ADDRESS - 1)}`,
    )
  }
  return address + 1
}

function assertHeader(header: string): string {
  if (!/^[A-Z][A-Z0-9 ]*$/u.test(header)) {
    throw new Error(
      'Videohub block header must contain only uppercase letters, numbers, and spaces',
    )
  }
  return header
}

function assertLine(line: string): string {
  if (/\r|\n/u.test(line)) throw new Error('Videohub block lines must not contain newlines')
  return line
}

export function encodeVideohubBlock(header: string, lines: readonly string[] = []): Buffer {
  const body = lines.map(assertLine).join('\n')
  return Buffer.from(
    `${assertHeader(header)}:\n${body}${body.length > 0 ? '\n' : ''}\n`,
    'utf8',
  )
}

export function encodeStatusRequest(header: VideohubStatusHeader): Buffer {
  return encodeVideohubBlock(header)
}

export function encodePing(): Buffer {
  return encodeVideohubBlock('PING')
}

export function encodeVideoOutputRouting(crosspoints: readonly VideohubCrosspoint[]): Buffer {
  if (crosspoints.length === 0) throw new Error('At least one Videohub route is required')
  const destinations = new Set<number>()
  const lines = crosspoints.map((crosspoint) => {
    assertHubbleAddress(crosspoint.destination, 'destination')
    assertHubbleAddress(crosspoint.source, 'source')
    if (destinations.has(crosspoint.destination)) {
      throw new Error(`Duplicate Videohub destination ${String(crosspoint.destination)}`)
    }
    destinations.add(crosspoint.destination)
    return `${String(toVideohubAddress(crosspoint.destination))} ${String(
      toVideohubAddress(crosspoint.source),
    )}`
  })
  return encodeVideohubBlock('VIDEO OUTPUT ROUTING', lines)
}

export function immutableLabel(label: VideohubRouterLabel): VideohubRouterLabel {
  return Object.freeze({ address: label.address, name: label.name })
}

export function immutableCrosspoint(crosspoint: VideohubCrosspoint): VideohubCrosspoint {
  return Object.freeze({ destination: crosspoint.destination, source: crosspoint.source })
}

export function immutableLock(lock: VideohubOutputLock): VideohubOutputLock {
  return Object.freeze({ destination: lock.destination, state: lock.state })
}
