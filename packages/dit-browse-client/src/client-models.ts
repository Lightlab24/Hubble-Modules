import WebSocket from 'ws'
import {
  sanitizeDitBrowseBoundaryText,
  type DitBrowseCommandErrorCode,
  type DitBrowseStatus,
} from './protocol.js'
import { type DitBrowseCameraCatalogEntry } from './state.js'

export type DitBrowseConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'

export type DitBrowseClientErrorCode =
  | DitBrowseCommandErrorCode
  | 'not_connected'
  | 'disconnected'
  | 'stopped'
  | 'reconfigured'
  | 'protocol_error'
  | 'unsupported_command'
  | 'not_confirmed'

export class DitBrowseCommandError extends Error {
  override readonly name = 'DitBrowseCommandError'
  readonly code: DitBrowseClientErrorCode
  readonly requestId?: string

  constructor(code: DitBrowseClientErrorCode, message: string, requestId?: string) {
    super(sanitizeDitBrowseBoundaryText(message))
    this.code = code
    if (requestId !== undefined) this.requestId = requestId
  }
}

export interface DitBrowseConnectionSnapshot {
  readonly phase: DitBrowseConnectionPhase
  readonly connected: boolean
  readonly endpoint: string
  readonly port: number
  readonly serverVersion: string | null
  readonly status: DitBrowseStatus | null
  readonly revision: number
  readonly catalog: readonly DitBrowseCameraCatalogEntry[]
  readonly lastError: string | null
  readonly reconnectAttempt: number
  readonly nextReconnectDelayMs: number | null
}

export interface DitBrowseClientClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type DitBrowseSocketFactory = (url: string) => WebSocket

export type DitBrowseSnapshotListener = (snapshot: DitBrowseConnectionSnapshot) => void

export interface DitBrowseClientOptions {
  readonly port?: number
  readonly clientName: string
  readonly clientVersion: string
  readonly requestTimeoutMs?: number
  readonly reconnectDelaysMs?: readonly number[]
  readonly socketFactory?: DitBrowseSocketFactory
  readonly clock?: DitBrowseClientClock
}

export interface PendingRequest {
  readonly resolve: (status: DitBrowseStatus) => void
  readonly reject: (error: DitBrowseCommandError) => void
  readonly timeout: unknown
}
