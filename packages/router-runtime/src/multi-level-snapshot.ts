import {
  type OgpCrosspoint,
  type UltrixOgpConnectionPhase,
  type UltrixOgpSnapshot,
} from '@hubble/protocol-ultrix-ogp'
import type { ManagedRouterConnectionSnapshot } from '@hubble/router-runtime/connection-contract'
import type { Swp08ConnectionPhase, Swp08Crosspoint, Swp08RouteMapSnapshot } from './models.js'
import {
  type ManagedEntry,
  type MultiLevelRouterConnectionDefinition,
} from './multi-level-types.js'
import { validAddress } from './multi-level-validation.js'

export function managedSnapshot(entry: ManagedEntry): ManagedRouterConnectionSnapshot {
  return Object.freeze({
    definition: entry.definition,
    ...(entry.definition.type === 'evertz-quartz'
      ? {
          destinationLocks: [...(entry.client.destinationLocks?.() ?? [])].map(
            ([destination, owner]) => ({ destination, owner }),
          ),
        }
      : {}),
    phase: entry.phase,
    routeTransport: entry.phase,
    selectedSource: entry.selectedSource,
    selectedDestination: entry.selectedDestination,
    routes: entry.routes,
    sourceCatalog: entry.sourceCatalog,
    destinationCatalog: entry.destinationCatalog,
    lastError: entry.lastError,
  })
}

export function mapPhase(phase: UltrixOgpConnectionPhase): Swp08ConnectionPhase {
  if (phase === 'connected') return 'connected'
  if (phase === 'disconnected') return 'disconnected'
  return 'connecting'
}

export function boundedCrosspoints(
  definition: MultiLevelRouterConnectionDefinition,
  snapshot: UltrixOgpSnapshot,
): readonly Swp08Crosspoint[] {
  const result: Swp08Crosspoint[] = []
  for (const { destination, level, source } of snapshot.routes) {
    if (
      source === null ||
      !validAddress(destination, definition.destinationLimit) ||
      !validAddress(level, definition.levels) ||
      !validAddress(source, definition.sourceLimit)
    ) {
      continue
    }
    result.push({ matrix: 1, destination, level, source })
  }
  result.sort((left, right) => left.destination - right.destination || left.level - right.level)
  return Object.freeze(result.map((crosspoint) => Object.freeze(crosspoint)))
}

export function boundedRouteSnapshot(
  definition: MultiLevelRouterConnectionDefinition,
  snapshot: UltrixOgpSnapshot,
): Swp08RouteMapSnapshot {
  const routes = new Map<number, ReadonlyMap<number, number>>()
  for (const { destination, level, source } of snapshot.routes) {
    if (
      source === null ||
      !validAddress(destination, definition.destinationLimit) ||
      !validAddress(level, definition.levels) ||
      !validAddress(source, definition.sourceLimit)
    ) {
      continue
    }
    const levels = new Map(routes.get(destination) ?? [])
    levels.set(level, source)
    routes.set(destination, levels)
  }
  return Object.freeze({ revision: snapshot.revision, routes })
}

export function emptyRouteSnapshot(): Swp08RouteMapSnapshot {
  return Object.freeze({ revision: 0, routes: new Map() })
}

export function representableCrosspoint(
  entry: ManagedEntry,
  crosspoint: OgpCrosspoint,
): boolean {
  return (
    crosspoint.source !== null &&
    validAddress(crosspoint.source, entry.definition.sourceLimit) &&
    validAddress(crosspoint.destination, entry.definition.destinationLimit) &&
    validAddress(crosspoint.level, entry.definition.levels)
  )
}

export function ogpCrosspointToSwp08(crosspoint: OgpCrosspoint): Swp08Crosspoint {
  if (crosspoint.source === null) {
    throw new Error('Unrouted OGP crosspoints cannot be represented as Ross route state')
  }
  return Object.freeze({
    matrix: 1,
    destination: crosspoint.destination,
    level: crosspoint.level,
    source: crosspoint.source,
  })
}

export function requiresNewClient(
  current: MultiLevelRouterConnectionDefinition,
  next: MultiLevelRouterConnectionDefinition,
): boolean {
  return (
    current.host !== next.host ||
    current.port !== next.port ||
    current.sourceLimit !== next.sourceLimit ||
    current.destinationLimit !== next.destinationLimit ||
    current.levels !== next.levels ||
    current.requestTimeoutMs !== next.requestTimeoutMs ||
    (current.type === 'evertz-quartz' &&
      next.type === 'evertz-quartz' &&
      (current.levelSystem !== next.levelSystem ||
        current.refreshIntervalSeconds !== next.refreshIntervalSeconds))
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function snapshotError(snapshot: UltrixOgpSnapshot): string | null {
  return snapshot.lastError
}
