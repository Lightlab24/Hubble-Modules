import type { Socket } from 'node:net'
import type { OgpCrosspoint, OgpLevel, OgpRouterLabel } from './ultrix-parameters.js'
export type UltrixOgpConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'synchronizing'
  | 'connected'

export interface UltrixOgpClientOptions {
  readonly host: string
  readonly port: number
  readonly levels: number
  readonly sourceLimit: number
  readonly destinationLimit: number
  readonly requestTimeoutMs: number
  readonly connectTimeoutMs?: number
  readonly panelId?: number
  readonly socketFactory?: () => Socket
}

export interface OgpNameCatalogSnapshot {
  readonly revision: number
  readonly sources: readonly OgpRouterLabel[]
  readonly destinations: readonly OgpRouterLabel[]
}

export interface UltrixOgpSnapshot {
  readonly phase: UltrixOgpConnectionPhase
  readonly revision: number
  readonly catalogRevision: number
  readonly controlReady: boolean
  readonly takeError: string | null
  readonly sources: readonly OgpRouterLabel[]
  readonly destinations: readonly OgpRouterLabel[]
  readonly levels: readonly OgpLevel[]
  readonly routes: readonly OgpCrosspoint[]
  readonly subscriptions: readonly string[]
  readonly multiSetEnabled: boolean
  readonly lastError: string | null
}

export type UltrixOgpClientEvent =
  | Readonly<{
      type: 'phase'
      phase: UltrixOgpConnectionPhase
      error: string | null
    }>
  | Readonly<{
      type: 'routes-reset'
      previousRevision: number
      revision: number
    }>
  | Readonly<{
      type: 'route'
      crosspoint: OgpCrosspoint
      previousRevision: number
      revision: number
    }>
  | Readonly<{
      type: 'route-observation'
      crosspoint: OgpCrosspoint
      revision: number
    }>
  | Readonly<{
      type: 'routes'
      crosspoints: readonly OgpCrosspoint[]
      previousRevision: number
      revision: number
    }>
  | Readonly<{ type: 'names'; names: OgpNameCatalogSnapshot }>
  | Readonly<{ type: 'levels'; levels: readonly OgpLevel[] }>
  | Readonly<{ type: 'control-ready'; ready: boolean }>
  | Readonly<{ type: 'take-error'; error: string }>
  | Readonly<{ type: 'protocol-error'; code: string; message: string }>
