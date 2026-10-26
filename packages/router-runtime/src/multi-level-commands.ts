import {
  MAX_ROSS_SWP08_COMPLETED_ROUTE_OPERATIONS,
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateResult,
  type RossSwp08InterrogateTargetOutcome,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RouteTargetOutcome,
} from '@hubble/router-runtime/routing-state'
import { routeSource } from './multi-level-confirmation.js'
import { MAX_PENDING_LEGACY_ROUTES } from './multi-level-limits.js'
import {
  appendInterrogateOutcomes,
  appendRemainingInterrogateOutcomes,
  appendRemainingRouteOutcomes,
  appendRouteOutcomes,
  interrogatePartial,
  routePartial,
} from './multi-level-requests.js'
import { errorMessage } from './multi-level-snapshot.js'
import { type ManagedEntry } from './multi-level-types.js'
import { validateAddress } from './multi-level-validation.js'

export interface MultiLevelCommandsContext {
  assertConnected(connectionId: string, entry: ManagedEntry, epoch: number): void
  synchronizeAfterCommand(entry: ManagedEntry): void
  emit(): void
  entryConnected(connectionId: string, entry: ManagedEntry, epoch: number): boolean
  isCurrentEntry(connectionId: string, entry: ManagedEntry): boolean
}

export function queueLegacyRoute(
  runtime: MultiLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  source: number,
  destination: number,
  levels: readonly number[],
): Promise<void> {
  validateAddress(source, entry.definition.sourceLimit, 'source')
  validateAddress(destination, entry.definition.destinationLimit, 'destination')
  if (entry.pendingLegacyRoutes >= MAX_PENDING_LEGACY_ROUTES) {
    throw new Error('Ross route submission queue capacity exceeded')
  }
  const epoch = entry.transportEpoch
  runtime.assertConnected(connectionId, entry, epoch)
  entry.pendingLegacyRoutes += 1
  const operation = enqueueCommand(runtime, entry, async () => {
    runtime.assertConnected(connectionId, entry, epoch)
    await entry.client.setCrosspoint({ source, destination, levels })
    runtime.assertConnected(connectionId, entry, epoch)
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
  runtime: MultiLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  epoch: number,
  request: RossSwp08RouteCrosspointsRequest,
): Promise<RossSwp08RouteCrosspointsResult> {
  const outcomes: RossSwp08RouteTargetOutcome[] = []
  for (const mapping of request.mappings) {
    for (const [index, level] of mapping.levels.entries()) {
      if (!runtime.entryConnected(connectionId, entry, epoch)) {
        appendRouteOutcomes(outcomes, request, mapping.mappingId, level, 'not_attempted')
        return routePartial(request.operationId, outcomes)
      }
      const current = routeSource(entry, mapping.destination, level)
      const expected = mapping.expected[index]?.source
      if (current === mapping.source) {
        outcomes.push({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          level,
          outcome: 'already_confirmed',
        })
        continue
      }
      if (expected === undefined || current !== expected) {
        outcomes.push({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          level,
          outcome: 'conflict',
        })
        appendRemainingRouteOutcomes(outcomes, request, mapping.mappingId, level)
        return routePartial(request.operationId, outcomes)
      }
      try {
        await entry.client.setCrosspoint({
          source: mapping.source,
          destination: mapping.destination,
          levels: [level],
        })
        runtime.assertConnected(connectionId, entry, epoch)
        runtime.synchronizeAfterCommand(entry)
        outcomes.push({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          level,
          outcome: 'acknowledged',
        })
      } catch (error: unknown) {
        outcomes.push({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          level,
          outcome: /NAK|reject/iu.test(errorMessage(error)) ? 'nak' : 'timeout',
        })
        appendRemainingRouteOutcomes(outcomes, request, mapping.mappingId, level)
        return routePartial(request.operationId, outcomes)
      }
    }
  }
  return Object.freeze({
    status: 'acknowledged',
    operationId: request.operationId,
    outcomes: Object.freeze(outcomes),
  })
}

export async function executeInterrogation(
  runtime: MultiLevelCommandsContext,
  connectionId: string,
  entry: ManagedEntry,
  epoch: number,
  request: RossSwp08InterrogateRequest,
): Promise<RossSwp08InterrogateResult> {
  const outcomes: RossSwp08InterrogateTargetOutcome[] = []
  for (const target of request.targets) {
    if (!runtime.entryConnected(connectionId, entry, epoch)) {
      appendInterrogateOutcomes(outcomes, request, target.destination, 'not_attempted')
      return interrogatePartial(request.requestId, outcomes)
    }
    try {
      await entry.client.readDestination(target.destination, target.levels)
      runtime.assertConnected(connectionId, entry, epoch)
      runtime.synchronizeAfterCommand(entry)
      for (const level of target.levels) {
        outcomes.push({ destination: target.destination, level, outcome: 'acknowledged' })
      }
    } catch (error: unknown) {
      const outcome = /NAK|reject/iu.test(errorMessage(error)) ? 'nak' : 'timeout'
      for (const level of target.levels) {
        outcomes.push({ destination: target.destination, level, outcome })
      }
      appendRemainingInterrogateOutcomes(outcomes, request, target.destination)
      return interrogatePartial(request.requestId, outcomes)
    }
  }
  return Object.freeze({
    status: 'acknowledged',
    requestId: request.requestId,
    outcomes: Object.freeze(outcomes),
  })
}

export function enqueueCommand<T>(
  runtime: MultiLevelCommandsContext,
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
  runtime: MultiLevelCommandsContext,
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
