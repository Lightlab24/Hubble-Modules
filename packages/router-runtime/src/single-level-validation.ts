import { type VideohubSnapshot } from '@hubble/protocol-videohub'
import type { RouterConfirmedRouteTarget } from '@hubble/router-runtime/connection-contract'
import {
  MAX_ROSS_SWP08_COMMAND_TARGETS,
  MAX_ROSS_SWP08_INTERROGATE_DESTINATIONS,
  MAX_ROSS_SWP08_ROUTE_MAPPINGS,
  type RossSwp08InterrogateRequest,
  type RossSwp08RouteCrosspointsRequest,
} from '@hubble/router-runtime/routing-state'
import { MAX_ROUTER_ADDRESS, VIDEO_LEVEL } from './single-level-limits.js'
import { interrogateRejected, routeRejected } from './single-level-requests.js'
import { type ManagedEntry } from './single-level-types.js'

export function validateDimensions(
  snapshot: VideohubSnapshot,
): asserts snapshot is VideohubSnapshot &
  Readonly<{
    detectedSourceCount: number
    detectedDestinationCount: number
    sourceCount: number
    destinationCount: number
  }> {
  for (const [label, value] of [
    ['source', snapshot.detectedSourceCount],
    ['destination', snapshot.detectedDestinationCount],
    ['effective source', snapshot.sourceCount],
    ['effective destination', snapshot.destinationCount],
  ] as const) {
    if (value === null || !Number.isInteger(value) || value < 1 || value > MAX_ROUTER_ADDRESS) {
      throw new RangeError(`Router reported unsupported ${label} dimensions`)
    }
  }
}

export function normalizeConfirmedRouteTarget(
  entry: ManagedEntry,
  target: RouterConfirmedRouteTarget,
): RouterConfirmedRouteTarget {
  validateCurrentAddress(entry, target.destination, 'destination')
  assertVideoLevels(target.levels)
  return Object.freeze({
    connectionId: target.connectionId,
    destination: target.destination,
    levels: Object.freeze([VIDEO_LEVEL]),
  })
}

export function validateCurrentAddress(
  entry: ManagedEntry,
  value: number,
  kind: 'source' | 'destination',
): void {
  const configuredLimit =
    kind === 'source' ? entry.definition.sourceLimit : entry.definition.destinationLimit
  const effectiveLimit =
    kind === 'source' ? entry.effectiveSourceCount : entry.effectiveDestinationCount
  const maximum =
    effectiveLimit ??
    configuredLimit ??
    (entry.definition.type === 'aja-kumo' ? 64 : MAX_ROUTER_ADDRESS)
  if (!validAddress(value, maximum)) {
    throw new RangeError(`Router ${kind} must be an integer from 1 to ${String(maximum)}`)
  }
}

export function assertVideoLevels(levels: readonly number[] | undefined): void {
  if (levels === undefined) return
  if (levels.length !== 1 || levels[0] !== VIDEO_LEVEL) {
    throw new RangeError('Router supports only video level 1')
  }
}

export function validateRouteRequest(
  entry: ManagedEntry,
  request: RossSwp08RouteCrosspointsRequest,
): Parameters<typeof routeRejected>[1] | null {
  if (
    !UUID_PATTERN.test(request.version.generation) ||
    !validRevision(request.version.revision)
  ) {
    return 'stale_generation'
  }
  if (request.mappings.length < 1 || request.mappings.length > MAX_ROSS_SWP08_ROUTE_MAPPINGS) {
    return 'capacity_exceeded'
  }
  if (entry.phase !== 'connected') return 'disconnected'
  const state = entry.routing.snapshot()
  if (state.version.generation !== request.version.generation) return 'stale_generation'
  if (state.phase !== 'ready') return 'not_synchronized'
  if (request.mappings.length > MAX_ROSS_SWP08_COMMAND_TARGETS) return 'capacity_exceeded'
  const targets = new Set<number>()
  const mappingIds = new Set<string>()
  for (const mapping of request.mappings) {
    if (mappingIds.has(mapping.mappingId) || targets.has(mapping.destination))
      return 'duplicate_target'
    mappingIds.add(mapping.mappingId)
    targets.add(mapping.destination)
    if (!validAddress(mapping.source, entry.effectiveSourceCount ?? 0)) return 'invalid_source'
    if (!validAddress(mapping.destination, entry.effectiveDestinationCount ?? 0)) {
      return 'invalid_destination'
    }
    if (mapping.levels.length !== 1 || mapping.levels[0] !== VIDEO_LEVEL) return 'invalid_level'
    if (
      mapping.expected.length !== 1 ||
      mapping.expected[0]?.level !== VIDEO_LEVEL ||
      !validAddress(mapping.expected[0].source, entry.effectiveSourceCount ?? 0)
    ) {
      return 'target_conflict'
    }
  }
  return null
}

export function validateInterrogateRequest(
  entry: ManagedEntry,
  request: RossSwp08InterrogateRequest,
): Parameters<typeof interrogateRejected>[1] | null {
  if (!UUID_PATTERN.test(request.generation)) return 'stale_generation'
  if (
    request.targets.length < 1 ||
    request.targets.length > MAX_ROSS_SWP08_INTERROGATE_DESTINATIONS
  ) {
    return 'capacity_exceeded'
  }
  if (entry.phase !== 'connected') return 'disconnected'
  const state = entry.routing.snapshot()
  if (state.version.generation !== request.generation) return 'stale_generation'
  if (state.phase !== 'ready') return 'not_synchronized'
  const destinations = new Set<number>()
  for (const target of request.targets) {
    if (!validAddress(target.destination, entry.effectiveDestinationCount ?? 0)) {
      return 'invalid_destination'
    }
    if (destinations.has(target.destination)) return 'duplicate_target'
    destinations.add(target.destination)
    if (target.levels.length !== 1 || target.levels[0] !== VIDEO_LEVEL) return 'invalid_level'
  }
  return null
}

export function validAddress(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum
}

export function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
