import type { Socket } from 'node:net'
import type {
  VideohubCrosspoint,
  VideohubDeviceStatus,
  VideohubError,
  VideohubErrorCode,
  VideohubOutputLock,
  VideohubRouterLabel,
} from './protocol.js'

export type VideohubConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'synchronizing'
  | 'connected'

export interface VideohubClientOptions {
  readonly host: string
  readonly port: number
  readonly requestTimeoutMs: number
  readonly connectTimeoutMs?: number
  readonly sourceLimit?: number
  readonly destinationLimit?: number
  readonly maxBufferedBytes?: number
  readonly socketFactory?: () => Socket
}

export interface VideohubNameCatalogSnapshot {
  readonly revision: number
  readonly sources: readonly VideohubRouterLabel[]
  readonly destinations: readonly VideohubRouterLabel[]
  readonly degraded: boolean
  readonly stale: boolean
}

export interface VideohubDeviceSnapshot {
  readonly deviceStatus: VideohubDeviceStatus
  readonly modelName: string | null
  readonly detectedSourceCount: number | null
  readonly detectedDestinationCount: number | null
  readonly sourceCount: number | null
  readonly destinationCount: number | null
}

export interface VideohubSnapshot extends VideohubDeviceSnapshot {
  readonly phase: VideohubConnectionPhase
  readonly revision: number
  readonly catalogRevision: number
  /** Monotonic successful setCrosspoint completions, retained across transport fencing. */
  readonly confirmedOperationSequence: number
  readonly protocolVersion: string | null
  readonly sources: readonly VideohubRouterLabel[]
  readonly destinations: readonly VideohubRouterLabel[]
  /**
   * Routes whose source and destination are both inside the effective local
   * caps. The client retains the complete detected routing block internally so
   * an above-cap external route can still invalidate prior exposed readback.
   */
  readonly routes: readonly VideohubCrosspoint[]
  readonly locks: readonly VideohubOutputLock[]
  readonly labelsDegraded: boolean
  readonly catalogStale: boolean
  readonly lastError: string | null
}

export type VideohubClientEvent =
  | Readonly<{
      type: 'phase'
      phase: VideohubConnectionPhase
      error: string | null
    }>
  | Readonly<{ type: 'device'; device: VideohubDeviceSnapshot }>
  | Readonly<{
      type: 'routes-reset'
      previousRevision: number
      revision: number
    }>
  | Readonly<{
      type: 'route'
      /** Authoritative device delta; its source can be outside a local source cap. */
      crosspoint: VideohubCrosspoint
      previousRevision: number
      revision: number
    }>
  | Readonly<{
      type: 'routes'
      /** Authoritative device deltas; sources can be outside a local source cap. */
      crosspoints: readonly VideohubCrosspoint[]
      previousRevision: number
      revision: number
    }>
  | Readonly<{
      type: 'route-observation'
      crosspoint: VideohubCrosspoint
      revision: number
    }>
  | Readonly<{ type: 'names'; names: VideohubNameCatalogSnapshot }>
  | Readonly<{ type: 'lock'; lock: VideohubOutputLock }>
  | Readonly<{ type: 'locks'; locks: readonly VideohubOutputLock[] }>
  | Readonly<{
      type: 'protocol-error'
      code: VideohubErrorCode
      message: string
    }>

export type VideohubRouteResult =
  | Readonly<{
      crosspoint: VideohubCrosspoint
      status: 'confirmed' | 'unchanged'
    }>
  | Readonly<{
      crosspoint: VideohubCrosspoint
      status: 'failed'
      error: VideohubError
    }>
