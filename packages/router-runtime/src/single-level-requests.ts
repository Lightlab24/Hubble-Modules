import {
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateResult,
  type RossSwp08InterrogateTargetOutcome,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RouteTargetOutcome,
} from '@hubble/router-runtime/routing-state'
import { VIDEO_LEVEL } from './single-level-limits.js'
import { errorMessage } from './single-level-snapshot.js'

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

export function mappingOutcome(
  mapping: RossSwp08RouteCrosspointsRequest['mappings'][number],
  level: number,
) {
  return {
    mappingId: mapping.mappingId,
    source: mapping.source,
    destination: mapping.destination,
    level,
  }
}

export function appendRemainingRouteOutcomes(
  outcomes: RossSwp08RouteTargetOutcome[],
  request: RossSwp08RouteCrosspointsRequest,
  currentMappingId: string,
  outcome: 'not_attempted',
  skipCurrent = false,
): void {
  let foundCurrent = false
  for (const mapping of request.mappings) {
    if (!foundCurrent) {
      foundCurrent = mapping.mappingId === currentMappingId
      if (!foundCurrent) continue
      if (skipCurrent) continue
    }
    outcomes.push({ ...mappingOutcome(mapping, VIDEO_LEVEL), outcome })
  }
}

export function routeFailureOutcome(error: unknown): 'nak' | 'timeout' | 'conflict' {
  const message = errorMessage(error)
  if (/conflict|changed before|expected source/iu.test(message)) return 'conflict'
  if (/NAK|reject|locked/iu.test(message)) return 'nak'
  return 'timeout'
}

export function interrogationFailureOutcome(error: unknown): 'nak' | 'timeout' {
  const message = errorMessage(error)
  return /NAK|reject|locked/iu.test(message) ? 'nak' : 'timeout'
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
