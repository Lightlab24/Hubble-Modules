import {
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateResult,
  type RossSwp08InterrogateTargetOutcome,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RouteTargetOutcome,
} from '@hubble/router-runtime/routing-state'

export function routeRejected(
  operationId: string,
  code:
    | 'connection_unavailable'
    | 'disabled'
    | 'disconnected'
    | 'not_synchronized'
    | 'stale_generation'
    | 'invalid_source'
    | 'invalid_destination'
    | 'invalid_level'
    | 'duplicate_target'
    | 'capacity_exceeded'
    | 'target_conflict'
    | 'operation_id_conflict'
    | 'operation_capacity_exceeded',
): RossSwp08RouteCrosspointsResult {
  return Object.freeze({ status: 'rejected', operationId, code })
}

export function routePartial(
  operationId: string,
  outcomes: readonly RossSwp08RouteTargetOutcome[],
): RossSwp08RouteCrosspointsResult {
  return Object.freeze({
    status: 'partial',
    operationId,
    outcomes: Object.freeze([...outcomes]),
  })
}

export function interrogateRejected(
  requestId: string,
  code:
    | 'connection_unavailable'
    | 'disabled'
    | 'disconnected'
    | 'not_synchronized'
    | 'stale_generation'
    | 'invalid_destination'
    | 'invalid_level'
    | 'duplicate_target'
    | 'capacity_exceeded',
): RossSwp08InterrogateResult {
  return Object.freeze({ status: 'rejected', requestId, code })
}

export function interrogatePartial(
  requestId: string,
  outcomes: readonly RossSwp08InterrogateTargetOutcome[],
): RossSwp08InterrogateResult {
  return Object.freeze({ status: 'partial', requestId, outcomes: Object.freeze([...outcomes]) })
}

export function appendRemainingRouteOutcomes(
  outcomes: RossSwp08RouteTargetOutcome[],
  request: RossSwp08RouteCrosspointsRequest,
  currentMappingId: string,
  currentLevel: number,
): void {
  let found = false
  for (const mapping of request.mappings) {
    for (const level of mapping.levels) {
      if (!found) {
        found = mapping.mappingId === currentMappingId && level === currentLevel
        continue
      }
      outcomes.push({
        mappingId: mapping.mappingId,
        source: mapping.source,
        destination: mapping.destination,
        level,
        outcome: 'not_attempted',
      })
    }
  }
}

export function appendRouteOutcomes(
  outcomes: RossSwp08RouteTargetOutcome[],
  request: RossSwp08RouteCrosspointsRequest,
  currentMappingId: string,
  currentLevel: number,
  outcome: 'not_attempted',
): void {
  let found = false
  for (const mapping of request.mappings) {
    for (const level of mapping.levels) {
      if (!found) found = mapping.mappingId === currentMappingId && level === currentLevel
      if (!found) continue
      outcomes.push({
        mappingId: mapping.mappingId,
        source: mapping.source,
        destination: mapping.destination,
        level,
        outcome,
      })
    }
  }
}

export function appendRemainingInterrogateOutcomes(
  outcomes: RossSwp08InterrogateTargetOutcome[],
  request: RossSwp08InterrogateRequest,
  currentDestination: number,
): void {
  let found = false
  for (const target of request.targets) {
    if (!found) {
      found = target.destination === currentDestination
      continue
    }
    for (const level of target.levels) {
      outcomes.push({ destination: target.destination, level, outcome: 'not_attempted' })
    }
  }
}

export function appendInterrogateOutcomes(
  outcomes: RossSwp08InterrogateTargetOutcome[],
  request: RossSwp08InterrogateRequest,
  currentDestination: number,
  outcome: 'not_attempted',
): void {
  let found = false
  for (const target of request.targets) {
    if (!found) found = target.destination === currentDestination
    if (!found) continue
    for (const level of target.levels) {
      outcomes.push({ destination: target.destination, level, outcome })
    }
  }
}

export function routeRequestHash(request: RossSwp08RouteCrosspointsRequest): string {
  return JSON.stringify([
    request.connectionId,
    request.version.generation,
    request.version.revision,
    request.mappings.map((mapping) => [
      mapping.mappingId,
      mapping.source,
      mapping.destination,
      mapping.levels,
      mapping.expected.map((expected) => [expected.level, expected.source]),
    ]),
  ])
}

export function snapshotRouteRequest(
  request: RossSwp08RouteCrosspointsRequest,
): RossSwp08RouteCrosspointsRequest {
  return Object.freeze({
    operationId: request.operationId,
    connectionId: request.connectionId,
    version: Object.freeze({ ...request.version }),
    mappings: Object.freeze(
      request.mappings.map((mapping) =>
        Object.freeze({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          levels: Object.freeze([...mapping.levels]),
          expected: Object.freeze(
            mapping.expected.map((expected) => Object.freeze({ ...expected })),
          ),
        }),
      ),
    ),
  })
}

export function snapshotInterrogateRequest(
  request: RossSwp08InterrogateRequest,
): RossSwp08InterrogateRequest {
  return Object.freeze({
    requestId: request.requestId,
    connectionId: request.connectionId,
    generation: request.generation,
    targets: Object.freeze(
      request.targets.map((target) =>
        Object.freeze({
          destination: target.destination,
          levels: Object.freeze([...target.levels]),
        }),
      ),
    ),
  })
}
