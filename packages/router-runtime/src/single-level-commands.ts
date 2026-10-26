import {
  MAX_ROSS_SWP08_COMPLETED_ROUTE_OPERATIONS,
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateResult,
  type RossSwp08InterrogateTargetOutcome,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RouteTargetOutcome,
} from '@hubble/router-runtime/routing-state'
import { routeSource } from './single-level-confirmation.js'
import { MAX_PENDING_LEGACY_ROUTES, VIDEO_LEVEL } from './single-level-limits.js'
import {
  appendRemainingRouteOutcomes,
  interrogatePartial,
  interrogationFailureOutcome,
  mappingOutcome,
  routeFailureOutcome,
  routePartial,
} from './single-level-requests.js'
import { errorMessage } from './single-level-snapshot.js'
import { type ManagedEntry } from './single-level-types.js'
import { validateCurrentAddress } from './single-level-validation.js'

export interface SingleLevelCommandsContext {
  assertConnected(connectionId: string, entry: ManagedEntry, epoch: number): void
  assertConnectedOrConfirmedAfterFence(
    connectionId: string,
    entry: ManagedEntry,
    epoch: number,
    previousConfirmedOperationSequence: number,
  ): void
  synchronizeAfterCommand(entry: ManagedEntry): void
  emit(): void
  entryConnected(connectionId: string, entry: ManagedEntry, epoch: number): boolean
  isCurrentEntry(connectionId: string, entry: ManagedEntry): boolean
}

export function queueLegacyRoute(
  runtime: SingleLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  source: number,
  destination: number,
): Promise<void> {
  validateCurrentAddress(entry, source, 'source')
  validateCurrentAddress(entry, destination, 'destination')
  if (entry.pendingLegacyRoutes >= MAX_PENDING_LEGACY_ROUTES) {
    throw new Error('Router route submission queue capacity exceeded')
  }
  const epoch = entry.transportEpoch
  runtime.assertConnected(connectionId, entry, epoch)
  entry.pendingLegacyRoutes += 1
  const operation = enqueueCommand(runtime, entry, async () => {
    runtime.assertConnected(connectionId, entry, epoch)
    const confirmedOperationSequence = entry.client.snapshot().confirmedOperationSequence
    await entry.client.setCrosspoint({ source, destination })
    runtime.assertConnectedOrConfirmedAfterFence(
      connectionId,
      entry,
      epoch,
      confirmedOperationSequence,
    )
    runtime.synchronizeAfterCommand(entry)
  })
  return operation.then(
    () => {
      entry.pendingLegacyRoutes = Math.max(0, entry.pendingLegacyRoutes - 1)
    },
    (error: unknown) => {
      entry.pendingLegacyRoutes = Math.max(0, entry.pendingLegacyRoutes - 1)
      if (runtime.isCurrentEntry(connectionId, entry)) {
        entry.lastError = `Last submitted route failed: ${errorMessage(error)}`
        runtime.emit()
      }
      throw error
    },
  )
}

export async function executeRouteRequest(
  runtime: SingleLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  epoch: number,
  request: RossSwp08RouteCrosspointsRequest,
): Promise<RossSwp08RouteCrosspointsResult> {
  const outcomes: RossSwp08RouteTargetOutcome[] = []
  for (const mapping of request.mappings) {
    const level = mapping.levels[0] as number
    if (!runtime.entryConnected(connectionId, entry, epoch)) {
      appendRemainingRouteOutcomes(outcomes, request, mapping.mappingId, 'not_attempted')
      return routePartial(request.operationId, outcomes)
    }
    const current = routeSource(entry, mapping.destination)
    const expected = mapping.expected[0]?.source
    if (current === mapping.source) {
      outcomes.push({ ...mappingOutcome(mapping, level), outcome: 'already_confirmed' })
      continue
    }
    if (expected === undefined || current !== expected) {
      outcomes.push({ ...mappingOutcome(mapping, level), outcome: 'conflict' })
      appendRemainingRouteOutcomes(outcomes, request, mapping.mappingId, 'not_attempted', true)
      return routePartial(request.operationId, outcomes)
    }
    try {
      const confirmedOperationSequence = entry.client.snapshot().confirmedOperationSequence
      await entry.client.setCrosspoint({
        source: mapping.source,
        destination: mapping.destination,
      })
      runtime.assertConnectedOrConfirmedAfterFence(
        connectionId,
        entry,
        epoch,
        confirmedOperationSequence,
      )
      runtime.synchronizeAfterCommand(entry)
      outcomes.push({ ...mappingOutcome(mapping, level), outcome: 'acknowledged' })
    } catch (error: unknown) {
      outcomes.push({
        ...mappingOutcome(mapping, level),
        outcome: routeFailureOutcome(error),
      })
      appendRemainingRouteOutcomes(outcomes, request, mapping.mappingId, 'not_attempted', true)
      return routePartial(request.operationId, outcomes)
    }
  }
  return Object.freeze({
    status: 'acknowledged',
    operationId: request.operationId,
    outcomes: Object.freeze(outcomes),
  })
}

export async function executeInterrogation(
  runtime: SingleLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  epoch: number,
  request: RossSwp08InterrogateRequest,
): Promise<RossSwp08InterrogateResult> {
  if (!runtime.entryConnected(connectionId, entry, epoch)) {
    return interrogatePartial(
      request.requestId,
      request.targets.map((target) => ({
        destination: target.destination,
        level: VIDEO_LEVEL,
        outcome: 'not_attempted',
      })),
    )
  }
  try {
    // Videohub cannot request selected destinations, so one authoritative
    // complete routing block satisfies the entire interrogation batch.
    await entry.client.refreshRoutes()
    runtime.assertConnected(connectionId, entry, epoch)
    runtime.synchronizeAfterCommand(entry)
  } catch (error: unknown) {
    const outcome = interrogationFailureOutcome(error)
    return interrogatePartial(
      request.requestId,
      request.targets.map((target) => ({
        destination: target.destination,
        level: VIDEO_LEVEL,
        outcome,
      })),
    )
  }
  const outcomes: RossSwp08InterrogateTargetOutcome[] = request.targets.map((target) => ({
    destination: target.destination,
    level: VIDEO_LEVEL,
    outcome: routeSource(entry, target.destination) === null ? 'nak' : 'acknowledged',
  }))
  if (outcomes.some(({ outcome }) => outcome !== 'acknowledged')) {
    return interrogatePartial(request.requestId, outcomes)
  }
  return Object.freeze({
    status: 'acknowledged',
    requestId: request.requestId,
    outcomes: Object.freeze(outcomes),
  })
}

export function enqueueCommand<T>(
  runtime: SingleLevelCommandsContext,
  entry: ManagedEntry,
  operation: () => Promise<T>,
): Promise<T> {
  const result = entry.commandTail.then(operation, operation)
  entry.commandTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function completeRouteOperation(
  runtime: SingleLevelCommandsContext,
  entry: ManagedEntry,
  operationId: string,
  hash: string,
  result: RossSwp08RouteCrosspointsResult,
): void {
  entry.activeRouteOperations.delete(operationId)
  entry.completedRouteOperations.set(operationId, { hash, result })
  while (entry.completedRouteOperations.size > MAX_ROSS_SWP08_COMPLETED_ROUTE_OPERATIONS) {
    const oldest = entry.completedRouteOperations.keys().next().value
    if (oldest === undefined) break
    entry.completedRouteOperations.delete(oldest)
  }
}
