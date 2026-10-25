import { describe, expect, it, vi } from 'vitest'
import {
  ActionDefinitionSchema,
  AjaKumoConnectionDefinitionSchema,
  ButtonIdentifierSchema,
  type AjaKumoActionDefinition,
} from '../src/config.js'

import type { ActionExecutionContext } from '@hubble/module-contracts/execution'
import { RouterActionExecutor } from '@hubble/router-runtime/actions'
import { AjaKumoConnectionManager } from '../src/aja-kumo-connection-manager.js'

const connectionId = '00000000-0000-4000-8000-000000000001'
const moduleConnectionId = '00000000-0000-4000-8000-000000000002'
const groupId = '00000000-0000-4000-8000-000000000003'
const workspaceId = '00000000-0000-4000-8000-000000000004'
const definition = AjaKumoConnectionDefinitionSchema.parse({
  connectionId,
  type: 'aja-kumo',
  name: 'KUMO',
  enabled: true,
  host: '127.0.0.1',
  port: 80,
  requestTimeoutMs: 1_000,
  reconnectDelayMs: 2_000,
  schemaVersion: 1,
})

function action(
  command: string,
  fields: Record<string, unknown> = {},
): AjaKumoActionDefinition {
  const parsed = ActionDefinitionSchema.parse({
    actionId: 'kumo-action',
    actionColumnId: '00000000-0000-4000-8000-000000000005',
    interaction: 'press',
    connectionId,
    moduleConnectionId,
    enabled: true,
    type: `aja-kumo.${command}`,
    ...(['refresh-names', 'recall-salvo'].includes(command)
      ? {}
      : { drivesTally: true, feedbackColor: '#37A65B' }),
    ...(['select-source', 'select-destination', 'take', 'toggle-group-enabled'].includes(
      command,
    )
      ? { groupId }
      : {}),
    ...fields,
  })
  if (!parsed.type.startsWith('aja-kumo.')) throw new Error('Expected a KUMO action')
  return parsed as AjaKumoActionDefinition
}

function context(overrides: Partial<ActionExecutionContext> = {}): ActionExecutionContext {
  return {
    executionId: 'kumo-execution',
    buttonNumber: ButtonIdentifierSchema.parse('1'),
    interaction: 'press',
    wrap: true,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe.each([{ name: 'source', Executor: RouterActionExecutor }])(
  'AJA KUMO action execution ($name)',
  ({ Executor }) => {
    function fixture() {
      const connections = new AjaKumoConnectionManager()
      vi.spyOn(connections, 'snapshots').mockReturnValue([
        {
          definition,
          phase: 'connected',
          routeTransport: 'connected',
          selectedSource: null,
          selectedDestination: null,
          routes: { revision: 0, routes: new Map() },
          sourceCatalog: [],
          destinationCatalog: [],
          lastError: null,
          effectiveSourceCount: 4,
          effectiveDestinationCount: 4,
        },
      ])
      const submit = vi.spyOn(connections, 'submitDirectRoute').mockResolvedValue()
      const refresh = vi.spyOn(connections, 'refreshNames').mockResolvedValue()
      const recall = vi.spyOn(connections, 'recallSalvo').mockResolvedValue()
      const groups = {
        selectSource: vi.fn(() => Promise.resolve()),
        selectDestination: vi.fn(() => Promise.resolve()),
        cycleDestination: vi.fn(() => Promise.resolve()),
        take: vi.fn(() => Promise.resolve()),
        toggleGroupEnabled: vi.fn(() => Promise.resolve()),
      }
      return {
        executor: new Executor(connections, groups, workspaceId),
        connections,
        groups,
        submit,
        refresh,
        recall,
      }
    }

    it('dispatches every operator action to the selected workspace, module, and group', async () => {
      const { executor, groups, submit, refresh, recall } = fixture()
      const scope = { workspaceId, connectionId, moduleConnectionId, groupId }
      for (const command of [
        action('select-source', { source: 2 }),
        action('select-destination', { destination: 3 }),
        action('take'),
        action('toggle-group-enabled'),
        action('direct-route', { source: 2, destination: 3 }),
        action('refresh-names'),
        action('recall-salvo', { salvo: 8 }),
      ]) {
        expect(command).not.toHaveProperty('levels')
        await expect(executor.execute(command, context())).resolves.toEqual({
          outcome: 'success',
        })
      }
      expect(groups.selectSource).toHaveBeenCalledWith({ ...scope, source: 2, levels: [1] })
      expect(groups.selectDestination).toHaveBeenCalledWith({ ...scope, destination: 3 })
      expect(groups.take).toHaveBeenCalledWith({ ...scope, levels: [1] })
      expect(groups.toggleGroupEnabled).toHaveBeenCalledWith(scope)
      expect(submit).toHaveBeenCalledWith({
        connectionId,
        source: 2,
        destination: 3,
        levels: [1],
      })
      expect(refresh).toHaveBeenCalledWith(connectionId)
      expect(recall).toHaveBeenCalledWith(connectionId, 8, expect.any(AbortSignal))
    })

    it.each([
      { interaction: 'press', wrap: false, expectedStep: 1, expectedWrap: true },
      { interaction: 'rotate-left', wrap: false, expectedStep: -1, expectedWrap: false },
      { interaction: 'rotate-right', wrap: true, expectedStep: 1, expectedWrap: true },
    ] as const)(
      'preserves destination cycling for $interaction',
      async ({ interaction, wrap, expectedStep, expectedWrap }) => {
        const { executor, groups } = fixture()
        const command = action('select-destination', {
          destination: 1,
          destinations: [1, 3],
          feedbackColor: '#FF0000',
          feedbackColors: ['#FF0000', '#00FF00'],
        })
        await expect(
          executor.execute(command, context({ interaction, wrap })),
        ).resolves.toEqual({
          outcome: 'success',
        })
        expect(groups.cycleDestination).toHaveBeenCalledWith({
          workspaceId,
          connectionId,
          moduleConnectionId,
          groupId,
          destinations: [1, 3],
          step: expectedStep,
          wrap: expectedWrap,
        })
        expect(groups.selectDestination).not.toHaveBeenCalled()
      },
    )

    it.each([
      action('select-source', { source: 5 }),
      action('select-destination', { destination: 5 }),
      action('select-destination', {
        destination: 1,
        destinations: [1, 5],
        feedbackColors: ['#37A65B', '#37A65B'],
      }),
      action('direct-route', { source: 5, destination: 1 }),
      action('direct-route', { source: 1, destination: 5 }),
    ])('rejects $type outside the live router size before dispatch', async (command) => {
      const { executor, groups, submit } = fixture()
      await expect(executor.execute(command, context())).resolves.toMatchObject({
        outcome: 'failure',
        errorCode: 'aja_kumo_unconfigured',
      })
      expect(submit).not.toHaveBeenCalled()
      expect(groups.selectSource).not.toHaveBeenCalled()
      expect(groups.selectDestination).not.toHaveBeenCalled()
      expect(groups.cycleDestination).not.toHaveBeenCalled()
    })

    it('does not submit a cancelled route', async () => {
      const { executor, submit } = fixture()
      await expect(
        executor.execute(
          action('direct-route', { source: 1, destination: 1 }),
          context({ signal: AbortSignal.abort() }),
        ),
      ).resolves.toMatchObject({
        outcome: 'failure',
        errorCode: 'action_exception',
        errorMessage: 'AJA KUMO action was cancelled',
      })
      expect(submit).not.toHaveBeenCalled()
    })

    it.each([
      ['Routing group is disabled', 'aja_kumo_unconfigured'],
      ['selected source is not configured', 'aja_kumo_unconfigured'],
      ['output 1 is locked', 'aja_kumo_locked'],
      ['unsupported dimensions', 'aja_kumo_unsupported_dimensions'],
      ['route conflict', 'aja_kumo_conflict'],
      ['not connected', 'aja_kumo_disconnected'],
      ['operation timed out', 'aja_kumo_timeout'],
      ['route not confirmed', 'aja_kumo_rejected'],
      ['unexpected payload', 'aja_kumo_protocol_error'],
    ])('reports %s as %s', async (message, errorCode) => {
      const { executor, submit } = fixture()
      submit.mockRejectedValue(new Error(message))
      await expect(
        executor.execute(action('direct-route', { source: 1, destination: 1 }), context()),
      ).resolves.toMatchObject({ outcome: 'failure', errorCode })
    })

    it('handles a non-Error rejection without exposing transport details', async () => {
      const { executor, refresh } = fixture()
      refresh.mockRejectedValue('sensitive transport details')
      await expect(executor.execute(action('refresh-names'), context())).resolves.toEqual({
        outcome: 'failure',
        errorCode: 'aja_kumo_protocol_error',
        errorMessage: 'AJA KUMO command failed unexpectedly',
      })
    })
  },
)
