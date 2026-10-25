import {
  type VideohubClientEvent,
  type VideohubCrosspoint,
  type VideohubDeviceStatus,
  type VideohubSnapshot,
} from '@hubble/protocol-videohub'
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
import type {
  AjaKumoConnectionDefinition,
  BlackmagicVideohubConnectionDefinition,
} from './types.js'

export type SingleLevelRouterConnectionDefinition =
  | BlackmagicVideohubConnectionDefinition
  | AjaKumoConnectionDefinition

export interface SingleLevelRouterManagedClient {
  connect(): Promise<void>
  disconnect(): void
  refreshNames(): Promise<void>
  refreshRoutes(): Promise<void>
  readDestination(destination: number): Promise<VideohubCrosspoint>
  setCrosspoint(input: VideohubCrosspoint): Promise<void>
  recallSalvo?(salvo: number, signal?: AbortSignal): Promise<void>
  salvoCatalog?(): readonly Readonly<{ address: number; name: string }>[]
  snapshot(): VideohubSnapshot
  subscribe(listener: (event: VideohubClientEvent) => void): () => void
}

export type SingleLevelRouterManagedClientFactory = (
  definition: SingleLevelRouterConnectionDefinition,
) => SingleLevelRouterManagedClient

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
}

export interface ManagedEntry {
  definition: SingleLevelRouterConnectionDefinition
  readonly client: SingleLevelRouterManagedClient
  readonly routing: RossSwp08RoutingState
  phase: Swp08ConnectionPhase
  selectedSource: number | null
  selectedDestination: number | null
  routes: Swp08RouteMapSnapshot
  sourceCatalog: Swp08NameCatalogSnapshot['sources']
  destinationCatalog: Swp08NameCatalogSnapshot['destinations']
  lastError: string | null
  deviceStatus: VideohubDeviceStatus
  deviceModel: string | null
  detectedSourceCount: number | null
  detectedDestinationCount: number | null
  effectiveSourceCount: number | null
  effectiveDestinationCount: number | null
  catalogStale: boolean
  lockedDestinationCount: number
  transportEpoch: number
  pendingLegacyRoutes: number
  commandTail: Promise<void>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  suppressDisconnectEvent: boolean
  unsubscribe: () => void
  readonly activeRouteOperations: Map<string, ActiveRouteOperation>
  readonly completedRouteOperations: Map<string, CompletedRouteOperation>
  readonly confirmedRouteWatches: Map<string, ConfirmedRouteWatch>
}
