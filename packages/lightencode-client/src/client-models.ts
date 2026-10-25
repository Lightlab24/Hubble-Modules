import {
  LIGHTENCODE_COMPANION_PORT,
  sanitizeLightEncodeBoundaryText,
  type LightEncodeCommandResponse,
  type LightEncodeStateSnapshot,
} from './protocol.js'

export type LightEncodeConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'

export type LightEncodeCommandErrorCode =
  | 'disconnected'
  | 'command_timeout'
  | 'duplicate_request'
  | 'rejected'
  | 'protocol_error'
  | 'state_not_confirmed'
  | 'slot_not_found'

export class LightEncodeCommandError extends Error {
  override readonly name = 'LightEncodeCommandError'
  readonly code: LightEncodeCommandErrorCode
  readonly requestId?: string
  readonly serverCode?: string

  constructor(
    code: LightEncodeCommandErrorCode,
    message: string,
    requestId?: string,
    serverCode?: string,
  ) {
    super(sanitizeLightEncodeBoundaryText(message))
    this.code = code
    if (requestId !== undefined) this.requestId = requestId
    if (serverCode !== undefined) this.serverCode = serverCode
  }
}

export interface LightEncodeClientSnapshot {
  readonly phase: LightEncodeConnectionPhase
  readonly host: string
  readonly port: typeof LIGHTENCODE_COMPANION_PORT
  readonly appVersion: string | null
  readonly sessionId: string | null
  readonly capabilities: readonly string[]
  readonly state: LightEncodeStateSnapshot | null
  readonly lastEventAt: string | null
  readonly lastError: string | null
  readonly reconnectAttempt: number
}

export interface LightEncodeClientClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface LightEncodeSocket {
  on(event: 'connect' | 'end', listener: () => void): this
  on(event: 'data', listener: (data: Buffer) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (hadError: boolean) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  removeAllListeners(): this
  write(data: string | Uint8Array): boolean
  destroy(): unknown
}

export type LightEncodeSocketFactory = (
  host: string,
  port: typeof LIGHTENCODE_COMPANION_PORT,
) => LightEncodeSocket

export type LightEncodeSnapshotListener = (snapshot: LightEncodeClientSnapshot) => void

export interface LightEncodeClientOptions {
  readonly clientVersion?: string
  readonly requestTimeoutMs?: number
  readonly reconnectDelayMs?: number
  readonly pingIntervalMs?: number
  readonly staleIntervalMs?: number
  readonly socketFactory?: LightEncodeSocketFactory
  readonly clock?: LightEncodeClientClock
  readonly requestIdFactory?: () => string
}

export interface PendingCommand {
  readonly requestId: string
  readonly sessionId: string
  readonly resolve: (snapshot: LightEncodeStateSnapshot) => void
  readonly reject: (error: LightEncodeCommandError) => void
  readonly timeout: unknown
  response: Extract<LightEncodeCommandResponse, { readonly ok: true }> | null
}
