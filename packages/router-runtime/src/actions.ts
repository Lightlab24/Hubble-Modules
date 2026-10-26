import type {
  AjaKumoActionDefinition,
  BlackmagicVideohubActionDefinition,
  EvertzQuartzControlActionDefinition,
  RossActionDefinition,
} from './types.js'
import { isDirectionalButtonInteraction } from './types.js'

import type {
  ActionExecutionContext,
  AdapterActionResult,
  TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  rotationStepForInteraction,
  stepOrderedListIndex,
} from '@hubble/module-contracts/interaction'
import type { RouterConnectionManagerContract } from '@hubble/router-runtime/connection-contract'
import type {
  RossRouteGroupActionScope,
  RossRouteGroupCycleDestinationInput,
  RossRouteGroupRuntimeContract,
  RossRouteGroupSelectDestinationInput,
  RossRouteGroupSelectSourceInput,
  RossRouteGroupTakeInput,
  RossRouteGroupToggleEnabledInput,
} from '@hubble/router-runtime/group-contract'

export type RossRouteGroupActionRuntimeContract = Pick<
  RossRouteGroupRuntimeContract,
  'selectSource' | 'selectDestination' | 'cycleDestination' | 'take' | 'toggleGroupEnabled'
>

type SingleLevelRouterActionDefinition =
  | BlackmagicVideohubActionDefinition
  | AjaKumoActionDefinition
export type RouterActionDefinition =
  | RossActionDefinition
  | SingleLevelRouterActionDefinition
  | EvertzQuartzControlActionDefinition

export class RouterActionExecutor implements TypedActionExecutor<RouterActionDefinition> {
  readonly #connections: RouterConnectionManagerContract
  readonly #groups: RossRouteGroupActionRuntimeContract
  readonly #workspaceId: string

  constructor(connections: RouterConnectionManagerContract)
  constructor(
    connections: RouterConnectionManagerContract,
    groups: RossRouteGroupActionRuntimeContract,
    workspaceId: string,
  )
  constructor(
    connections: RouterConnectionManagerContract,
    groups?: RossRouteGroupActionRuntimeContract,
    workspaceId?: string,
  ) {
    this.#connections = connections
    this.#groups = groups ?? legacyGroupActionRuntime(connections)
    this.#workspaceId = workspaceId ?? ''
  }

  async execute(
    action: RouterActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    const singleLevel = isSingleLevelAction(action)
    const kumo = action.type.startsWith('aja-kumo.')
    if (context.signal.aborted) {
      return failure(
        'action_exception',
        kumo
          ? 'AJA KUMO action was cancelled'
          : singleLevel
            ? 'Blackmagic Videohub action was cancelled'
            : 'Ross action was cancelled',
      )
    }
    try {
      if (
        singleLevel &&
        singleLevelActionExceedsEffectiveDimensions(action, this.#connections)
      ) {
        return failure(
          kumo ? 'aja_kumo_unconfigured' : 'blackmagic_unconfigured',
          `${kumo ? 'AJA KUMO' : 'Blackmagic Videohub'} action is outside the available router range`,
        )
      }
      switch (action.type) {
        case 'ross-swp08.select-source':
        case 'aja-kumo.select-source':
        case 'blackmagic-videohub.select-source':
          await this.#groups.selectSource({
            ...groupActionScope(this.#workspaceId, action),
            source: action.source,
            levels: action.type === 'ross-swp08.select-source' ? action.levels : [1],
          })
          break
        case 'ross-swp08.select-destination':
        case 'aja-kumo.select-destination':
        case 'blackmagic-videohub.select-destination':
          {
            const destinations = cyclingDestinations(action)
            if (destinations === null) {
              await this.#groups.selectDestination({
                ...groupActionScope(this.#workspaceId, action),
                destination: action.destination,
              })
            } else {
              await this.#groups.cycleDestination({
                ...groupActionScope(this.#workspaceId, action),
                destinations,
                step: rotationStepForInteraction(context.interaction) ?? 1,
                wrap: isDirectionalButtonInteraction(context.interaction) ? context.wrap : true,
              })
            }
          }
          break
        case 'ross-swp08.take':
        case 'aja-kumo.take':
        case 'blackmagic-videohub.take':
          await this.#groups.take({
            ...groupActionScope(this.#workspaceId, action),
            levels: action.type === 'ross-swp08.take' ? action.levels : [1],
          })
          break
        case 'ross-swp08.toggle-group-enabled':
        case 'aja-kumo.toggle-group-enabled':
        case 'blackmagic-videohub.toggle-group-enabled':
          await this.#groups.toggleGroupEnabled({
            workspaceId: this.#workspaceId,
            moduleConnectionId: action.moduleConnectionId,
            connectionId: action.connectionId,
            groupId: action.groupId,
          })
          break
        case 'ross-swp08.direct-route':
        case 'aja-kumo.direct-route':
        case 'blackmagic-videohub.direct-route':
          {
            const levels = action.type === 'ross-swp08.direct-route' ? action.levels : [1]
            const route = {
              connectionId: action.connectionId,
              source: action.source,
              destination: action.destination,
              ...(levels.length === 0 ? {} : { levels }),
            }
            await (this.#connections.submitDirectRoute?.(route) ??
              this.#connections.directRoute(route))
          }
          break
        case 'evertz-quartz.lock-destination':
        case 'evertz-quartz.unlock-destination':
          if (this.#connections.setDestinationLock === undefined)
            throw new Error('This router does not support destination locks')
          await this.#connections.setDestinationLock(
            action.connectionId,
            action.destination,
            action.type === 'evertz-quartz.lock-destination',
            context.signal,
          )
          break
        case 'evertz-quartz.recall-salvo':
        case 'aja-kumo.recall-salvo':
          if (this.#connections.recallSalvo === undefined) {
            throw new Error('This router does not support salvo recall')
          }
          await this.#connections.recallSalvo(action.connectionId, action.salvo, context.signal)
          break
        case 'ross-swp08.refresh-names':
        case 'aja-kumo.refresh-names':
        case 'blackmagic-videohub.refresh-names':
          await this.#connections.refreshNames(action.connectionId)
          break
      }
      return { outcome: 'success' }
    } catch (error) {
      if (kumo && isCancelled(context.signal)) {
        return failure('action_exception', 'AJA KUMO action was cancelled')
      }
      return kumo
        ? mapKumoError(error)
        : singleLevel
          ? mapBlackmagicError(error)
          : mapRossError(error)
    }
  }
}

function isSingleLevelAction(
  action: RouterActionDefinition,
): action is SingleLevelRouterActionDefinition {
  return action.type.startsWith('blackmagic-videohub.') || action.type.startsWith('aja-kumo.')
}

function singleLevelActionExceedsEffectiveDimensions(
  action: SingleLevelRouterActionDefinition,
  connections: RouterConnectionManagerContract,
): boolean {
  const snapshot = connections
    .snapshots()
    .find(({ definition }) => definition.connectionId === action.connectionId)
  if (
    snapshot?.definition.type !== 'blackmagic-videohub' &&
    snapshot?.definition.type !== 'aja-kumo'
  )
    return false
  const sourceMaximum = snapshot.effectiveSourceCount
  const destinationMaximum = snapshot.effectiveDestinationCount
  switch (action.type) {
    case 'aja-kumo.select-source':
    case 'blackmagic-videohub.select-source':
      return (
        sourceMaximum !== null && sourceMaximum !== undefined && action.source > sourceMaximum
      )
    case 'aja-kumo.select-destination':
    case 'blackmagic-videohub.select-destination':
      return (
        destinationMaximum !== null &&
        destinationMaximum !== undefined &&
        (action.destinations ?? [action.destination]).some(
          (destination) => destination > destinationMaximum,
        )
      )
    case 'aja-kumo.direct-route':
    case 'blackmagic-videohub.direct-route':
      return (
        (sourceMaximum !== null &&
          sourceMaximum !== undefined &&
          action.source > sourceMaximum) ||
        (destinationMaximum !== null &&
          destinationMaximum !== undefined &&
          action.destination > destinationMaximum)
      )
    case 'aja-kumo.take':
    case 'blackmagic-videohub.take':
    case 'aja-kumo.toggle-group-enabled':
    case 'blackmagic-videohub.toggle-group-enabled':
    case 'aja-kumo.refresh-names':
    case 'aja-kumo.recall-salvo':
    case 'blackmagic-videohub.refresh-names':
      return false
  }
}

function groupActionScope(
  workspaceId: string,
  action: Extract<
    RouterActionDefinition,
    {
      type:
        | 'ross-swp08.select-source'
        | 'ross-swp08.select-destination'
        | 'ross-swp08.take'
        | 'blackmagic-videohub.select-source'
        | 'aja-kumo.select-source'
        | 'blackmagic-videohub.select-destination'
        | 'aja-kumo.select-destination'
        | 'blackmagic-videohub.take'
        | 'aja-kumo.take'
    }
  >,
):
  | RossRouteGroupSelectSourceInput
  | RossRouteGroupSelectDestinationInput
  | RossRouteGroupTakeInput {
  return {
    workspaceId,
    moduleConnectionId: action.moduleConnectionId,
    connectionId: action.connectionId,
    groupId: action.groupId,
  }
}

/** Compatibility for direct unit construction while the long-lived core adapter owns the real runtime. */
function legacyGroupActionRuntime(
  connections: RouterConnectionManagerContract,
): RossRouteGroupActionRuntimeContract {
  const selectedDestinationByGroup = new Map<string, number>()
  const enabledByGroup = new Map<string, boolean>()
  const requireEnabled = (input: RossRouteGroupActionScope): void => {
    if (enabledByGroup.get(groupScopeKey(input)) === false) {
      throw new Error('Routing group is disabled')
    }
  }
  return Object.freeze({
    selectSource(input: RossRouteGroupSelectSourceInput): Promise<void> {
      requireEnabled(input)
      const levels = input.levels?.length === 0 ? undefined : input.levels
      return (
        connections.submitSelectSource?.(input.connectionId, input.source, levels) ??
        connections.selectSource(input.connectionId, input.source, levels)
      )
    },
    selectDestination(input: RossRouteGroupSelectDestinationInput): Promise<void> {
      requireEnabled(input)
      selectedDestinationByGroup.set(groupScopeKey(input), input.destination)
      connections.selectDestination(input.connectionId, input.destination)
      return Promise.resolve()
    },
    cycleDestination(input: RossRouteGroupCycleDestinationInput): Promise<void> {
      requireEnabled(input)
      const current = selectedDestinationByGroup.get(groupScopeKey(input))
      const currentIndex = current === undefined ? null : input.destinations.indexOf(current)
      const destination =
        input.destinations[
          stepOrderedListIndex(input.destinations.length, currentIndex, input.step, input.wrap)
        ]
      if (destination === undefined) throw new Error('Ross destination cycle is empty')
      if (destination === current) return Promise.resolve()
      selectedDestinationByGroup.set(groupScopeKey(input), destination)
      connections.selectDestination(input.connectionId, destination)
      return Promise.resolve()
    },
    take(input: RossRouteGroupTakeInput): Promise<void> {
      requireEnabled(input)
      const levels = input.levels?.length === 0 ? undefined : input.levels
      return (
        connections.submitTake?.(input.connectionId, levels) ??
        connections.take(input.connectionId, levels)
      )
    },
    toggleGroupEnabled(input: RossRouteGroupToggleEnabledInput): Promise<void> {
      const key = groupScopeKey(input)
      enabledByGroup.set(key, enabledByGroup.get(key) === false)
      selectedDestinationByGroup.delete(key)
      return Promise.resolve()
    },
  })
}

function cyclingDestinations(
  action: Extract<
    RouterActionDefinition,
    {
      type:
        | 'ross-swp08.select-destination'
        | 'blackmagic-videohub.select-destination'
        | 'aja-kumo.select-destination'
    }
  >,
): readonly number[] | null {
  return action.destinations ?? null
}

function groupScopeKey(input: {
  readonly workspaceId: string
  readonly moduleConnectionId: string
  readonly connectionId: string
  readonly groupId: string | null
}): string {
  return `${input.workspaceId}\u0000${input.moduleConnectionId}\u0000${input.connectionId}\u0000${input.groupId ?? ''}`
}

function mapRossError(error: unknown): AdapterActionResult {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /selected (?:source|destination).*not configured|routing group is disabled|routing group (?:toggle|transition) is (?:already )?in progress/iu.test(
      message,
    )
  ) {
    return failure('ross_unconfigured', message)
  }
  if (/not (?:available|connected)|connection closed/iu.test(message)) {
    return failure('ross_disconnected', 'Ross router is not connected')
  }
  if (/timed out/iu.test(message)) {
    return failure('ross_timeout', 'Ross router did not acknowledge the command')
  }
  if (/NAK/iu.test(message)) {
    return failure('ross_rejected', 'Ross router rejected the command')
  }
  if (/route was not confirmed|reports a take error/iu.test(message)) {
    return failure('ross_rejected', 'Ross router did not confirm the route')
  }
  return failure('ross_protocol_error', 'Ross router command failed unexpectedly')
}

function mapBlackmagicError(error: unknown): AdapterActionResult {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /routing group is disabled|routing group (?:toggle|transition) is (?:already )?in progress/iu.test(
      message,
    )
  ) {
    return failure('blackmagic_unconfigured', message)
  }
  if (
    /selected (?:source|destination).*not configured|unconfigured|(?:source|destination).*integer from 1 to/iu.test(
      message,
    )
  ) {
    return failure(
      'blackmagic_unconfigured',
      'Blackmagic Videohub action is outside the available router range',
    )
  }
  if (/foreign lock|locked by another|output .* locked/iu.test(message)) {
    return failure('blackmagic_locked', 'Blackmagic Videohub destination is locked elsewhere')
  }
  if (
    /unsupported dimensions?|dimensions? (?:are )?(?:invalid|unavailable)|dimension.*exceed|(?:video inputs|video outputs).*integer from 1 to 65536/iu.test(
      message,
    )
  ) {
    return failure(
      'blackmagic_unsupported_dimensions',
      'Blackmagic Videohub reported unsupported dimensions',
    )
  }
  if (/conflict|changed before|expected source/iu.test(message)) {
    return failure('blackmagic_conflict', 'Blackmagic Videohub route changed before Take')
  }
  if (/not (?:available|connected|synchronized)|connection closed/iu.test(message)) {
    return failure('blackmagic_disconnected', 'Blackmagic Videohub is not connected')
  }
  if (/timed out|timeout/iu.test(message)) {
    return failure('blackmagic_timeout', 'Blackmagic Videohub did not confirm the route')
  }
  if (/NAK|reject|not confirmed/iu.test(message)) {
    return failure('blackmagic_rejected', 'Blackmagic Videohub rejected the command')
  }
  return failure('blackmagic_protocol_error', 'Blackmagic Videohub command failed unexpectedly')
}

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

function mapKumoError(error: unknown): AdapterActionResult {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /routing group is disabled|routing group (?:toggle|transition) is (?:already )?in progress/iu.test(
      message,
    )
  ) {
    return failure('aja_kumo_unconfigured', message)
  }
  if (
    /selected (?:source|destination).*not configured|unconfigured|(?:source|destination).*integer from 1 to/iu.test(
      message,
    )
  ) {
    return failure(
      'aja_kumo_unconfigured',
      'AJA KUMO action is outside the available router range',
    )
  }
  if (/foreign lock|locked by another|output .*locked|destination locked/iu.test(message)) {
    return failure('aja_kumo_locked', 'AJA KUMO destination is locked elsewhere')
  }
  if (
    /unsupported dimensions?|dimensions? (?:are )?(?:invalid|unavailable)|dimension.*exceed|(?:video inputs|video outputs).*integer from 1 to 65536/iu.test(
      message,
    )
  ) {
    return failure(
      'aja_kumo_unsupported_dimensions',
      'AJA KUMO reported unsupported dimensions',
    )
  }
  if (/conflict|changed before|expected source/iu.test(message)) {
    return failure('aja_kumo_conflict', 'AJA KUMO route changed before Take')
  }
  if (/not (?:available|connected|synchronized)|connection closed/iu.test(message)) {
    return failure('aja_kumo_disconnected', 'AJA KUMO is not connected')
  }
  if (/timed out|timeout/iu.test(message)) {
    return failure('aja_kumo_timeout', 'AJA KUMO did not confirm the command')
  }
  if (/NAK|reject|not confirmed|not acknowledged/iu.test(message)) {
    return failure('aja_kumo_rejected', 'AJA KUMO rejected the command')
  }
  return failure('aja_kumo_protocol_error', 'AJA KUMO command failed unexpectedly')
}

/** Compatibility export retained for callers and tests using the original Ross-specific name. */
export { RouterActionExecutor as RossSwp08ActionExecutor }

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
