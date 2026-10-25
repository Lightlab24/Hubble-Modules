import type { Swp08Crosspoint } from './models.js'

export interface RossSwp08RouteVersion {
  readonly generation: string
  readonly revision: number
}

export const MAX_ROSS_SWP08_ROUTE_MAPPINGS = 256

export const MAX_ROSS_SWP08_INTERROGATE_DESTINATIONS = 256

export const MAX_ROSS_SWP08_COMMAND_TARGETS = 4_096

export const MAX_ROSS_SWP08_ACTIVE_ROUTE_OPERATIONS = 8

export const MAX_ROSS_SWP08_COMPLETED_ROUTE_OPERATIONS = 256

export type RossSwp08RouteRequestCode =
  | 'connection_unavailable'
  | 'disabled'
  | 'disconnected'
  | 'not_synchronized'
  | 'stale_generation'
  | 'target_conflict'
  | 'target_busy'
  | 'invalid_source'
  | 'invalid_destination'
  | 'invalid_level'
  | 'duplicate_target'
  | 'capacity_exceeded'
  | 'operation_id_conflict'
  | 'operation_capacity_exceeded'

export type RossSwp08RouteDispatchOutcome =
  | 'already_confirmed'
  | 'acknowledged'
  | 'nak'
  | 'timeout'
  | 'conflict'
  | 'not_attempted'

export interface RossSwp08RouteMapping {
  readonly mappingId: string
  readonly source: number
  readonly destination: number
  readonly levels: readonly number[]
  readonly expected: readonly Readonly<{ level: number; source: number }>[]
}

export interface RossSwp08RouteCrosspointsRequest {
  readonly operationId: string
  readonly connectionId: string
  readonly version: RossSwp08RouteVersion
  readonly mappings: readonly RossSwp08RouteMapping[]
}

export interface RossSwp08RouteTargetOutcome {
  readonly mappingId: string
  readonly source: number
  readonly destination: number
  readonly level: number
  readonly outcome: RossSwp08RouteDispatchOutcome
}

export type RossSwp08RouteCrosspointsResult =
  | Readonly<{
      status: 'acknowledged'
      operationId: string
      outcomes: readonly RossSwp08RouteTargetOutcome[]
    }>
  | Readonly<{
      status: 'partial'
      operationId: string
      outcomes: readonly RossSwp08RouteTargetOutcome[]
    }>
  | Readonly<{
      status: 'rejected'
      operationId: string
      code: RossSwp08RouteRequestCode
    }>

export interface RossSwp08InterrogateTarget {
  readonly destination: number
  readonly levels: readonly number[]
}

export interface RossSwp08InterrogateRequest {
  readonly requestId: string
  readonly connectionId: string
  readonly generation: string
  readonly targets: readonly RossSwp08InterrogateTarget[]
}

export type RossSwp08InterrogateRequestCode =
  | 'connection_unavailable'
  | 'disabled'
  | 'disconnected'
  | 'not_synchronized'
  | 'stale_generation'
  | 'invalid_destination'
  | 'invalid_level'
  | 'duplicate_target'
  | 'capacity_exceeded'

export type RossSwp08InterrogateDispatchOutcome =
  | 'acknowledged'
  | 'nak'
  | 'timeout'
  | 'not_attempted'

export interface RossSwp08InterrogateTargetOutcome {
  readonly destination: number
  readonly level: number
  readonly outcome: RossSwp08InterrogateDispatchOutcome
}

export type RossSwp08InterrogateResult =
  | Readonly<{
      status: 'acknowledged'
      requestId: string
      outcomes: readonly RossSwp08InterrogateTargetOutcome[]
    }>
  | Readonly<{
      status: 'partial'
      requestId: string
      outcomes: readonly RossSwp08InterrogateTargetOutcome[]
    }>
  | Readonly<{
      status: 'rejected'
      requestId: string
      code: RossSwp08InterrogateRequestCode
    }>

export type RossSwp08RouteSyncPhase = 'synchronizing' | 'ready' | 'degraded' | 'stale'

export type RossSwp08LabelPhase = 'loading' | 'ready' | 'degraded'

export interface RossSwp08RouteReadStamp {
  readonly version: RossSwp08RouteVersion
  readonly labelRevision: number
}

export interface RossSwp08RoutingStateSnapshot extends RossSwp08RouteReadStamp {
  readonly phase: RossSwp08RouteSyncPhase
  readonly labelPhase: RossSwp08LabelPhase
  readonly knownSourceCount: number
  readonly knownDestinationCount: number
  readonly knownCrosspointCount: number
}

export interface RossSwp08RoutePageRequest {
  readonly afterAddress: number | null
  readonly limit: number
  readonly search: string | null
}

export interface RossSwp08DestinationPageRequest extends RossSwp08RoutePageRequest {
  readonly source: number | null
  readonly levels: readonly number[]
}

export interface RossSwp08SourcePage extends RossSwp08RouteReadStamp {
  readonly entries: readonly Readonly<{ address: number; label: string | null }>[]
  readonly nextAfterAddress: number | null
  readonly totalCount: number
}

export interface RossSwp08DestinationPage extends RossSwp08RouteReadStamp {
  readonly entries: readonly Readonly<{
    address: number
    label: string | null
    routes: readonly Readonly<{ level: number; source: number }>[]
  }>[]
  readonly nextAfterAddress: number | null
  readonly totalCount: number
}

export interface RossSwp08CrosspointDelta extends Swp08Crosspoint {
  readonly previousSource: number | null
}

export type RossSwp08DestinationSummary =
  | Readonly<{
      kind: 'unknown'
      knownLevelCount: 0
      totalLevelCount: number
    }>
  | Readonly<{
      kind: 'partial'
      sources: readonly number[]
      knownLevelCount: number
      totalLevelCount: number
    }>
  | Readonly<{
      kind: 'uniform'
      source: number
      knownLevelCount: number
      totalLevelCount: number
    }>
  | Readonly<{
      kind: 'mixed'
      sources: readonly number[]
      knownLevelCount: number
      totalLevelCount: number
    }>

export type RossSwp08RouteStateEvent =
  | Readonly<{
      type: 'reset'
      version: RossSwp08RouteVersion
      phase: RossSwp08RouteSyncPhase
    }>
  | Readonly<{
      type: 'delta'
      generation: string
      previousRevision: number
      revision: number
      crosspoints: readonly RossSwp08CrosspointDelta[]
      knownSourceCount: number
      knownDestinationCount: number
      knownCrosspointCount: number
    }>
  | Readonly<{
      type: 'observation'
      version: RossSwp08RouteVersion
      crosspoint: Swp08Crosspoint
    }>
  | Readonly<{
      type: 'intent'
      version: RossSwp08RouteVersion
      crosspoints: readonly [Swp08Crosspoint, ...Swp08Crosspoint[]]
      active: boolean
    }>
  | Readonly<{
      type: 'catalog'
      version: RossSwp08RouteVersion
      labelRevision: number
      sourcesChanged: boolean
      destinationsChanged: boolean
      knownSourceCount: number
      knownDestinationCount: number
    }>
  | Readonly<{
      type: 'phase'
      version: RossSwp08RouteVersion
      phase: RossSwp08RouteSyncPhase
    }>
  | Readonly<{
      type: 'label-phase'
      version: RossSwp08RouteVersion
      labelRevision: number
      phase: RossSwp08LabelPhase
    }>

export interface RossSwp08RoutingStateOptions {
  readonly createGeneration?: () => string
}

export type RossSwp08RouteStateListener = (event: RossSwp08RouteStateEvent) => void

export interface RouteDeltaInput {
  readonly previousRevision: number
  readonly revision: number
  readonly crosspoints: readonly Swp08Crosspoint[]
}
