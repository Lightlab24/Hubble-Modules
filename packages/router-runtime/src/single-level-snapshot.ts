import { type VideohubCrosspoint, type VideohubSnapshot } from '@hubble/protocol-videohub'
import type { ManagedRouterConnectionSnapshot } from '@hubble/router-runtime/connection-contract'
import type { Swp08ConnectionPhase, Swp08RouteMapSnapshot } from './models.js'
import { VIDEO_LEVEL } from './single-level-limits.js'
import {
  type ManagedEntry,
  type SingleLevelRouterConnectionDefinition,
} from './single-level-types.js'
import { validAddress } from './single-level-validation.js'

export function managedSnapshot(entry: ManagedEntry): ManagedRouterConnectionSnapshot {
  return Object.freeze({
    definition: entry.definition,
    phase: entry.phase,
    routeTransport: entry.phase,
    selectedSource: entry.selectedSource,
    selectedDestination: entry.selectedDestination,
    routes: entry.routes,
    sourceCatalog: entry.sourceCatalog,
    destinationCatalog: entry.destinationCatalog,
    lastError: entry.lastError,
    deviceStatus: entry.deviceStatus,
    deviceModel: entry.deviceModel,
    detectedSourceCount: entry.detectedSourceCount,
    detectedDestinationCount: entry.detectedDestinationCount,
    effectiveSourceCount: entry.effectiveSourceCount,
    effectiveDestinationCount: entry.effectiveDestinationCount,
    catalogStale: entry.catalogStale,
    lockedDestinationCount: entry.lockedDestinationCount,
    ...(entry.definition.type === 'aja-kumo'
      ? { salvoCatalog: entry.client.salvoCatalog?.() ?? [] }
      : {}),
  })
}

export function mapPhase(phase: VideohubSnapshot['phase']): Swp08ConnectionPhase {
  return phase === 'connected'
    ? 'connected'
    : phase === 'disconnected'
      ? 'disconnected'
      : 'connecting'
}

export function boundedCrosspoints(
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): readonly Readonly<{ matrix: 1; destination: number; level: 1; source: number }>[] {
  return Object.freeze(
    snapshot.routes
      .filter((crosspoint) => representableCrosspoint(entry, crosspoint))
      .map(toSwp08Crosspoint)
      .sort((left, right) => left.destination - right.destination),
  )
}

export function boundedRouteSnapshot(
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): Swp08RouteMapSnapshot {
  const routes = new Map<number, ReadonlyMap<number, number>>()
  for (const crosspoint of snapshot.routes) {
    if (!representableCrosspoint(entry, crosspoint)) continue
    routes.set(crosspoint.destination, new Map([[VIDEO_LEVEL, crosspoint.source]]))
  }
  return Object.freeze({ revision: snapshot.revision, routes })
}

export function representableCrosspoint(
  entry: ManagedEntry,
  crosspoint: VideohubCrosspoint,
): boolean {
  return (
    validAddress(crosspoint.source, entry.effectiveSourceCount ?? 0) &&
    validAddress(crosspoint.destination, entry.effectiveDestinationCount ?? 0)
  )
}

export function toSwp08Crosspoint(crosspoint: VideohubCrosspoint) {
  return Object.freeze({
    matrix: 1 as const,
    destination: crosspoint.destination,
    level: VIDEO_LEVEL,
    source: crosspoint.source,
  })
}

export function emptyRouteSnapshot(): Swp08RouteMapSnapshot {
  return Object.freeze({ revision: 0, routes: new Map() })
}

export function requiresNewClient(
  current: SingleLevelRouterConnectionDefinition,
  next: SingleLevelRouterConnectionDefinition,
): boolean {
  return (
    (current.type === 'aja-kumo' &&
      next.type === 'aja-kumo' &&
      current.password !== next.password) ||
    current.host !== next.host ||
    current.port !== next.port ||
    current.sourceLimit !== next.sourceLimit ||
    current.destinationLimit !== next.destinationLimit ||
    current.requestTimeoutMs !== next.requestTimeoutMs
  )
}

export function isUnsupportedDimensionsMessage(message: string): boolean {
  return /unsupported dimensions?|dimensions? (?:are )?(?:invalid|unavailable)|(?:video inputs|video outputs).*integer from 1 to 65536/iu.test(
    message,
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
