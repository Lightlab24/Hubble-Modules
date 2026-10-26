import { describe, expect, it, vi } from 'vitest'
import {
  BlackmagicVideohubDirectRouteActionDefinitionSchema,
  BlackmagicVideohubRefreshNamesActionDefinitionSchema,
  BlackmagicVideohubSelectDestinationActionDefinitionSchema,
  BlackmagicVideohubSelectSourceActionDefinitionSchema,
  BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema,
  ButtonIdentifierSchema,
} from '../src/config.js'

import {
  RouterActionExecutor,
  type RossRouteGroupActionRuntimeContract,
} from '@hubble/router-runtime/actions'
import type { RouterConnectionManagerContract } from '@hubble/router-runtime/connection-contract'

const CONNECTION_ID = id(1)
const WORKSPACE_ID = id(2)
const MODULE_CONNECTION_ID = id(3)
const GROUP_ID = id(30)

function id(suffix: number): string {
  return `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
}

function context(interaction: 'press' | 'rotate-left' | 'rotate-right' = 'press', wrap = true) {
  return {
    executionId: id(20),
    buttonNumber: ButtonIdentifierSchema.parse('1'),
    interaction,
    wrap,
    signal: new AbortController().signal,
  }
}

function harness(effectiveDimensions?: {
  readonly sources: number
  readonly destinations: number
}) {
  const submitDirectRoute = vi.fn(() => Promise.resolve())
  const refreshNames = vi.fn(() => Promise.resolve())
  const connections = {
    directRoute: vi.fn(() => Promise.resolve()),
    submitDirectRoute,
    refreshNames,
    snapshots: vi.fn(() =>
      effectiveDimensions === undefined
        ? []
        : [
            {
              definition: { connectionId: CONNECTION_ID, type: 'blackmagic-videohub' },
              effectiveSourceCount: effectiveDimensions.sources,
              effectiveDestinationCount: effectiveDimensions.destinations,
            },
          ],
    ),
  } as unknown as RouterConnectionManagerContract
  const groups: RossRouteGroupActionRuntimeContract = {
    selectSource: vi.fn(() => Promise.resolve()),
    selectDestination: vi.fn(() => Promise.resolve()),
    cycleDestination: vi.fn(() => Promise.resolve()),
    take: vi.fn(() => Promise.resolve()),
    toggleGroupEnabled: vi.fn(() => Promise.resolve()),
  }
  return {
    connections,
    refreshNames,
    submitDirectRoute,
    groups,
    executor: new RouterActionExecutor(connections, groups, WORKSPACE_ID),
  }
}

describe('RouterActionExecutor Blackmagic Videohub actions', () => {
  it('toggles an explicit group through the shared runtime without touching the router', async () => {
    const { executor, groups, submitDirectRoute } = harness()
    const action = BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema.parse({
      actionId: id(31),
      actionColumnId: id(32),
      interaction: 'press',
      type: 'blackmagic-videohub.toggle-group-enabled',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      groupId: GROUP_ID,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#37A65B',
      feedbackInactiveColor: '#334155',
    })

    await expect(executor.execute(action, context())).resolves.toEqual({ outcome: 'success' })
    expect(groups.toggleGroupEnabled).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      connectionId: CONNECTION_ID,
      groupId: GROUP_ID,
    })
    expect(submitDirectRoute).not.toHaveBeenCalled()
  })

  it.each([
    'Routing group is disabled',
    'Routing group toggle is in progress',
    'Routing group transition is in progress',
  ])('preserves the operator-facing group failure: %s', async (message) => {
    const { executor, groups } = harness()
    vi.mocked(groups.selectSource).mockRejectedValueOnce(new Error(message))
    const action = BlackmagicVideohubSelectSourceActionDefinitionSchema.parse({
      actionId: id(33),
      actionColumnId: id(34),
      interaction: 'press',
      type: 'blackmagic-videohub.select-source',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      groupId: GROUP_ID,
      source: 9,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })

    await expect(executor.execute(action, context())).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'blackmagic_unconfigured',
      errorMessage: message,
    })
  })

  it('uses the shared group runtime with fixed video level 1', async () => {
    const { executor, groups } = harness()
    const action = BlackmagicVideohubSelectSourceActionDefinitionSchema.parse({
      actionId: id(4),
      actionColumnId: id(5),
      interaction: 'press',
      type: 'blackmagic-videohub.select-source',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      groupId: null,
      source: 9,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })

    await expect(executor.execute(action, context())).resolves.toEqual({ outcome: 'success' })
    expect(groups.selectSource).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      connectionId: CONNECTION_ID,
      groupId: null,
      source: 9,
      levels: [1],
    })
  })

  it('forwards Blackmagic left/right direction and wrap policy to destination cycles', async () => {
    const { executor, groups } = harness()
    const action = (interaction: 'rotate-left' | 'rotate-right') =>
      BlackmagicVideohubSelectDestinationActionDefinitionSchema.parse({
        actionId: interaction === 'rotate-left' ? id(21) : id(23),
        actionColumnId: id(22),
        interaction,
        type: 'blackmagic-videohub.select-destination',
        connectionId: CONNECTION_ID,
        moduleConnectionId: MODULE_CONNECTION_ID,
        groupId: null,
        destination: 1,
        destinations: [1, 5, 10],
        enabled: true,
        drivesTally: true,
        feedbackColor: '#00FF00',
        feedbackColors: ['#00FF00', '#0000FF', '#FFFF00'],
      })

    await expect(
      executor.execute(action('rotate-left'), context('rotate-left', false)),
    ).resolves.toEqual({ outcome: 'success' })
    await expect(
      executor.execute(action('rotate-right'), context('rotate-right', true)),
    ).resolves.toEqual({ outcome: 'success' })

    expect(groups.cycleDestination).toHaveBeenNthCalledWith(1, {
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      connectionId: CONNECTION_ID,
      groupId: null,
      destinations: [1, 5, 10],
      step: -1,
      wrap: false,
    })
    expect(groups.cycleDestination).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      connectionId: CONNECTION_ID,
      groupId: null,
      destinations: [1, 5, 10],
      step: 1,
      wrap: true,
    })
  })

  it('submits Direct Route without mutating grouped selection state', async () => {
    const { executor, groups, submitDirectRoute } = harness()
    const action = BlackmagicVideohubDirectRouteActionDefinitionSchema.parse({
      actionId: id(6),
      actionColumnId: id(7),
      interaction: 'press',
      type: 'blackmagic-videohub.direct-route',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      source: 10,
      destination: 2,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })

    await expect(executor.execute(action, context())).resolves.toEqual({ outcome: 'success' })
    expect(submitDirectRoute).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      source: 10,
      destination: 2,
      levels: [1],
    })
    expect(groups.selectSource).not.toHaveBeenCalled()
    expect(groups.selectDestination).not.toHaveBeenCalled()
  })

  it('rejects actions beyond newly detected dimensions before changing group state or routing', async () => {
    const { executor, groups, submitDirectRoute } = harness({ sources: 8, destinations: 4 })
    const source = BlackmagicVideohubSelectSourceActionDefinitionSchema.parse({
      actionId: id(10),
      actionColumnId: id(11),
      interaction: 'press',
      type: 'blackmagic-videohub.select-source',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      groupId: null,
      source: 9,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })
    const destinationCycle = BlackmagicVideohubSelectDestinationActionDefinitionSchema.parse({
      actionId: id(12),
      actionColumnId: id(13),
      interaction: 'press',
      type: 'blackmagic-videohub.select-destination',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      groupId: null,
      destination: 2,
      destinations: [2, 5],
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
      feedbackColors: ['#00FF00', '#00FF00'],
    })
    const direct = BlackmagicVideohubDirectRouteActionDefinitionSchema.parse({
      actionId: id(14),
      actionColumnId: id(15),
      interaction: 'press',
      type: 'blackmagic-videohub.direct-route',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      source: 9,
      destination: 2,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })

    for (const action of [source, destinationCycle, direct]) {
      await expect(executor.execute(action, context())).resolves.toMatchObject({
        outcome: 'failure',
        errorCode: 'blackmagic_unconfigured',
      })
    }
    expect(groups.selectSource).not.toHaveBeenCalled()
    expect(groups.selectDestination).not.toHaveBeenCalled()
    expect(groups.cycleDestination).not.toHaveBeenCalled()
    expect(submitDirectRoute).not.toHaveBeenCalled()
  })

  it.each([
    ['source must be an integer from 1 to 8', 'blackmagic_unconfigured'],
    ['locked by another client', 'blackmagic_locked'],
    ['command timed out', 'blackmagic_timeout'],
    ['route conflicting readback', 'blackmagic_conflict'],
    ['connection is not connected', 'blackmagic_disconnected'],
    ['Videohub dimensions are unavailable', 'blackmagic_unsupported_dimensions'],
  ] as const)('maps %s failures to sanitized Blackmagic codes', async (message, errorCode) => {
    const { executor, submitDirectRoute } = harness()
    submitDirectRoute.mockRejectedValueOnce(new Error(message))
    const action = BlackmagicVideohubDirectRouteActionDefinitionSchema.parse({
      actionId: id(8),
      actionColumnId: id(9),
      interaction: 'press',
      type: 'blackmagic-videohub.direct-route',
      connectionId: CONNECTION_ID,
      moduleConnectionId: MODULE_CONNECTION_ID,
      source: 10,
      destination: 2,
      enabled: true,
      drivesTally: true,
      feedbackColor: '#00FF00',
    })

    await expect(executor.execute(action, context())).resolves.toMatchObject({
      outcome: 'failure',
      errorCode,
    })
  })

  it.each([
    ['Videohub is not connected', 'blackmagic_disconnected'],
    ['Videohub acknowledgement timed out', 'blackmagic_timeout'],
    ['Videohub rejected the command with NAK', 'blackmagic_rejected'],
    ['Videohub dimensions are unavailable', 'blackmagic_unsupported_dimensions'],
    ['Invalid Videohub stream: broken status block', 'blackmagic_protocol_error'],
  ] as const)(
    'preserves the sanitized %s category for Refresh Router Names',
    async (message, errorCode) => {
      const { executor, refreshNames } = harness()
      refreshNames.mockRejectedValueOnce(new Error(message))
      const action = BlackmagicVideohubRefreshNamesActionDefinitionSchema.parse({
        actionId: id(16),
        actionColumnId: id(17),
        interaction: 'press',
        type: 'blackmagic-videohub.refresh-names',
        connectionId: CONNECTION_ID,
        moduleConnectionId: MODULE_CONNECTION_ID,
        enabled: true,
      })

      await expect(executor.execute(action, context())).resolves.toMatchObject({
        outcome: 'failure',
        errorCode,
      })
      expect(refreshNames).toHaveBeenCalledWith(CONNECTION_ID)
    },
  )
})
