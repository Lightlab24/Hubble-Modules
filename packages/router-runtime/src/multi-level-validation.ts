import { type OgpCrosspoint } from '@hubble/protocol-ultrix-ogp'
import type { RouterConfirmedRouteTarget } from '@hubble/router-runtime/connection-contract'
import {
  MAX_ROSS_SWP08_COMMAND_TARGETS,
  MAX_ROSS_SWP08_INTERROGATE_DESTINATIONS,
  MAX_ROSS_SWP08_ROUTE_MAPPINGS,
  type RossSwp08InterrogateRequest,
  type RossSwp08RouteCrosspointsRequest,
} from '@hubble/router-runtime/routing-state'
import { interrogateRejected, routeRejected } from './multi-level-requests.js'
import {
  type ManagedEntry,
  type MultiLevelRouterConnectionDefinition,
} from './multi-level-types.js'

export function routeLevels(
  definition: MultiLevelRouterConnectionDefinition,
  requested: readonly number[] | undefined,
): readonly number[] {
  const levels =
    requested === undefined
      ? Array.from({ length: definition.levels }, (_, index) => index + 1)
      : [...requested]
  if (levels.length === 0) throw new RangeError('at least one level is required')
  const seen = new Set<number>()
  for (const level of levels) {
    validateAddress(level, definition.levels, 'level')
    if (seen.has(level)) throw new RangeError('Ross route levels must be unique')
    seen.add(level)
  }
  return Object.freeze(levels)
}

export function normalizeConfirmedRouteTarget(
  definition: MultiLevelRouterConnectionDefinition,
  target: RouterConfirmedRouteTarget,
): RouterConfirmedRouteTarget {
  validateAddress(target.destination, definition.destinationLimit, 'destination')
  const levels = [...routeLevels(definition, target.levels)].sort((left, right) => left - right)
  return Object.freeze({
    connectionId: target.connectionId,
    destination: target.destination,
    levels: Object.freeze(levels),
  })
}

export function validateConfirmedRouteReadback(
  definition: MultiLevelRouterConnectionDefinition,
  target: RouterConfirmedRouteTarget,
  crosspoints: readonly OgpCrosspoint[],
): ReadonlyMap<number, number> {
  const expected = new Set(target.levels)
  const observed = new Set<number>()
  const sourcesByLevel = new Map<number, number>()
  for (const crosspoint of crosspoints) {
    if (crosspoint.destination !== target.destination) {
      throw new Error(
        `Router confirmed readback returned destination ${String(
          crosspoint.destination,
        )} instead of ${String(target.destination)}`,
      )
    }
    if (!expected.has(crosspoint.level) || observed.has(crosspoint.level)) {
      throw new Error('Router confirmed readback returned invalid levels')
    }
    observed.add(crosspoint.level)
    if (crosspoint.source !== null) {
      validateAddress(crosspoint.source, definition.sourceLimit, 'source')
      sourcesByLevel.set(crosspoint.level, crosspoint.source)
    }
  }
  if (observed.size !== expected.size) {
    throw new Error('Router confirmed readback omitted a requested level')
  }
  return sourcesByLevel
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
  let targetCount = 0
  const targets = new Set<string>()
  const mappingIds = new Set<string>()
  for (const mapping of request.mappings) {
    if (mappingIds.has(mapping.mappingId)) return 'duplicate_target'
    mappingIds.add(mapping.mappingId)
    if (!validAddress(mapping.source, entry.definition.sourceLimit)) return 'invalid_source'
    if (!validAddress(mapping.destination, entry.definition.destinationLimit)) {
      return 'invalid_destination'
    }
    if (mapping.levels.length === 0) return 'invalid_level'
    if (mapping.levels.length !== mapping.expected.length) return 'target_conflict'
    let previousLevel = 0
    for (let index = 0; index < mapping.levels.length; index += 1) {
      const level = mapping.levels[index] as number
      targetCount += 1
      if (targetCount > MAX_ROSS_SWP08_COMMAND_TARGETS) return 'capacity_exceeded'
      if (!validAddress(level, entry.definition.levels)) return 'invalid_level'
      if (level === previousLevel) return 'duplicate_target'
      if (level < previousLevel) return 'invalid_level'
      previousLevel = level
      const expected = mapping.expected[index]
      if (expected === undefined || expected.level !== level) return 'target_conflict'
      if (!validAddress(expected.source, entry.definition.sourceLimit)) return 'invalid_source'
      const key = `${String(mapping.destination)}:${String(level)}`
      if (targets.has(key)) return 'duplicate_target'
      targets.add(key)
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
  let count = 0
  const targets = new Set<string>()
  const destinations = new Set<number>()
  for (const target of request.targets) {
    if (!validAddress(target.destination, entry.definition.destinationLimit)) {
      return 'invalid_destination'
    }
    if (destinations.has(target.destination)) return 'duplicate_target'
    destinations.add(target.destination)
    if (target.levels.length === 0) return 'invalid_level'
    let previousLevel = 0
    for (const level of target.levels) {
      count += 1
      if (count > MAX_ROSS_SWP08_COMMAND_TARGETS) return 'capacity_exceeded'
      if (!validAddress(level, entry.definition.levels)) return 'invalid_level'
      if (level === previousLevel) return 'duplicate_target'
      if (level < previousLevel) return 'invalid_level'
      previousLevel = level
      const key = `${String(target.destination)}:${String(level)}`
      if (targets.has(key)) return 'duplicate_target'
      targets.add(key)
    }
  }
  return null
}

export function validateAddress(value: number, maximum: number, label: string): void {
  if (!validAddress(value, maximum)) {
    throw new RangeError(`Ross route ${label} must be an integer from 1 to ${String(maximum)}`)
  }
}

export function validAddress(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum
}

export function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
