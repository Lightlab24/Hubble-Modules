import type { VideohubDeviceStatus } from '@hubble/protocol-videohub'
import type {
  Swp08ConnectionPhase,
  Swp08NameCatalogSnapshot,
  Swp08RouteMapSnapshot,
} from './models.js'
import type { RouterConnectionDefinition } from './types.js'

import type {
  RossSwp08DestinationPage,
  RossSwp08DestinationPageRequest,
  RossSwp08InterrogateRequest,
  RossSwp08InterrogateResult,
  RossSwp08RouteCrosspointsRequest,
  RossSwp08RouteCrosspointsResult,
  RossSwp08RoutePageRequest,
  RossSwp08RouteStateEvent,
  RossSwp08RoutingStateSnapshot,
  RossSwp08SourcePage,
} from '@hubble/router-runtime/routing-state'

export interface ManagedRouterConnectionSnapshot {
  readonly definition: RouterConnectionDefinition
  readonly phase: Swp08ConnectionPhase
  readonly routeTransport: Swp08ConnectionPhase
  readonly selectedSource: number | null
  readonly selectedDestination: number | null
  readonly routes: Swp08RouteMapSnapshot
  readonly sourceCatalog: Swp08NameCatalogSnapshot['sources']
  readonly destinationCatalog: Swp08NameCatalogSnapshot['destinations']
  readonly lastError: string | null
  /** Transport-specific device metadata. Present for auto-sized routers. */
  readonly deviceStatus?: VideohubDeviceStatus
  readonly deviceModel?: string | null
  readonly detectedSourceCount?: number | null
  readonly detectedDestinationCount?: number | null
  readonly effectiveSourceCount?: number | null
  readonly effectiveDestinationCount?: number | null
  readonly catalogStale?: boolean
  readonly lockedDestinationCount?: number
  readonly destinationLocks?: readonly Readonly<{ destination: number; owner: number }>[]
  readonly salvoCatalog?: readonly Readonly<{ address: number; name: string }>[]
}

export type RouterConnectionManagerListener = (
  snapshots: readonly ManagedRouterConnectionSnapshot[],
) => void

export type RouterRouteStateListener = (event: RossSwp08RouteStateEvent) => void

export interface RouterDirectRouteInput {
  readonly connectionId: string
  readonly source: number
  readonly destination: number
  readonly levels?: readonly number[]
}

export interface RouterDirectRouteSubmission {
  readonly submissionId: string
  /** Preserves the transport's existing action-completion boundary. */
  readonly accepted: Promise<void>
  /** Resolves or rejects when the correlated protocol operation finally settles. */
  readonly settled: Promise<void>
}

export interface RouterConfirmedRouteTarget {
  readonly connectionId: string
  readonly destination: number
  readonly levels: readonly number[]
}

export interface RouterConfirmedRouteTargetSnapshot extends RouterConfirmedRouteTarget {
  readonly phase: 'pending' | 'ready'
  readonly sourcesByLevel: ReadonlyMap<number, number>
  readonly lastError: string | null
}

export type RouterConfirmedRouteTargetListener = (
  snapshot: RouterConfirmedRouteTargetSnapshot,
) => void

/**
 * The transport-neutral router surface consumed by actions, feedback, and the
 * desktop router API. The request/event types intentionally alias the mature
 * routing-state model. Historical type names are retained for compatibility;
 * they do not imply an active SW-P-08 transport.
 */
export interface RouterConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  refreshNames(connectionId?: string): Promise<void>
  setDestinationLock?(
    connectionId: string,
    destination: number,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<void>
  recallSalvo?(connectionId: string, salvo: number, signal?: AbortSignal): Promise<void>
  snapshots(): readonly ManagedRouterConnectionSnapshot[]
  subscribe(listener: RouterConnectionManagerListener): () => void
  subscribePrimaryRouteFeedback(listener: RouterConnectionManagerListener): () => void
  routeState(connectionId: string): RossSwp08RoutingStateSnapshot
  queryRouteSources(
    connectionId: string,
    request: RossSwp08RoutePageRequest,
  ): RossSwp08SourcePage
  queryRouteDestinations(
    connectionId: string,
    request: RossSwp08DestinationPageRequest,
  ): RossSwp08DestinationPage
  subscribeRouteState(connectionId: string, listener: RouterRouteStateListener): () => void
  routeCrosspoints(
    request: RossSwp08RouteCrosspointsRequest,
  ): Promise<RossSwp08RouteCrosspointsResult>
  interrogateRouteTargets(
    request: RossSwp08InterrogateRequest,
  ): Promise<RossSwp08InterrogateResult>
  selectDestination(connectionId: string, destination: number): void
  selectSource(connectionId: string, source: number, levels?: readonly number[]): Promise<void>
  take(connectionId: string, levels?: readonly number[]): Promise<void>
  directRoute(input: RouterDirectRouteInput): Promise<void>
  submitDirectRouteTracked(input: RouterDirectRouteInput): RouterDirectRouteSubmission
  watchConfirmedRouteTarget(
    target: RouterConfirmedRouteTarget,
    listener: RouterConfirmedRouteTargetListener,
  ): () => void
  submitSelectSource?(
    connectionId: string,
    source: number,
    levels?: readonly number[],
  ): Promise<void>
  submitTake?(connectionId: string, levels?: readonly number[]): Promise<void>
  submitDirectRoute?(input: RouterDirectRouteInput): Promise<void>
  stop(): void
}
