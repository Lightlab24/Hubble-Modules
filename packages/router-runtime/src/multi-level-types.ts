import {
  type OgpCrosspoint,
  type UltrixOgpClientEvent,
  type UltrixOgpSnapshot,
} from '@hubble/protocol-ultrix-ogp'
import type {
  RouterConfirmedRouteTarget,
  RouterConfirmedRouteTargetListener,
  RouterConfirmedRouteTargetSnapshot,
} from '@hubble/router-runtime/connection-contract'
import {
  RossSwp08RoutingState,
  type RossSwp08RouteCrosspointsResult,
} from '@hubble/router-runtime/routing-state'
import type {
  Swp08ConnectionPhase,
  Swp08NameCatalogSnapshot,
  Swp08RouteMapSnapshot,
} from './models.js'
import {
  type EvertzQuartzConnectionDefinition,
  type RossUltrixOgpConnectionDefinition,
} from './types.js'

export type MultiLevelRouterConnectionDefinition =
  | RossUltrixOgpConnectionDefinition
  | EvertzQuartzConnectionDefinition

export type MultiLevelRouterClientEvent = UltrixOgpClientEvent | Readonly<{ type: 'locks' }>

export interface MultiLevelRouterManagedClient {
  connect(): Promise<void>
  disconnect(): void
  refreshNames(): Promise<void>
  refreshRoutes(): Promise<void>
  readDestination(
    destination: number,
    levels?: readonly number[],
  ): Promise<readonly OgpCrosspoint[]>
  setCrosspoint(input: {
    readonly source: number
    readonly destination: number
    readonly levels?: readonly number[]
  }): Promise<void>
  recallSalvo?(salvo: number, signal?: AbortSignal): Promise<void>
  setDestinationLock?(destination: number, locked: boolean, signal?: AbortSignal): Promise<void>
  destinationLocks?(): ReadonlyMap<number, number>
  snapshot(): UltrixOgpSnapshot
  subscribe(listener: (event: MultiLevelRouterClientEvent) => void): () => void
}

export type MultiLevelRouterManagedClientFactory = (
  definition: MultiLevelRouterConnectionDefinition,
) => MultiLevelRouterManagedClient

export interface ActiveRouteOperation {
  readonly hash: string
  readonly promise: Promise<RossSwp08RouteCrosspointsResult>
}

export interface CompletedRouteOperation {
  readonly hash: string
  readonly result: RossSwp08RouteCrosspointsResult
}

export interface ConfirmedRouteWatch {
  readonly key: string
  readonly target: RouterConfirmedRouteTarget
  readonly listeners: Set<RouterConfirmedRouteTargetListener>
  snapshot: RouterConfirmedRouteTargetSnapshot
  running: boolean
  runId: number
}

export interface ManagedEntry {
  definition: MultiLevelRouterConnectionDefinition
  readonly client: MultiLevelRouterManagedClient
  readonly routing: RossSwp08RoutingState
  phase: Swp08ConnectionPhase
  selectedSource: number | null
  selectedDestination: number | null
  routes: Swp08RouteMapSnapshot
  sourceCatalog: Swp08NameCatalogSnapshot['sources']
  destinationCatalog: Swp08NameCatalogSnapshot['destinations']
  lastError: string | null
  transportEpoch: number
  pendingLegacyRoutes: number
  commandTail: Promise<void>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  retryDisconnectInProgress: boolean
  unsubscribe: () => void
  readonly activeRouteOperations: Map<string, ActiveRouteOperation>
  readonly completedRouteOperations: Map<string, CompletedRouteOperation>
  readonly confirmedRouteWatches: Map<string, ConfirmedRouteWatch>
  confirmedRouteWatchTail: Promise<void>
}
