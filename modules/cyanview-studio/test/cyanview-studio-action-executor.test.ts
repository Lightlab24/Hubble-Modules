import { describe, expect, it, vi } from 'vitest'
import {
  ButtonIdentifierSchema,
  CyanViewStudioSelectFeedActionDefinitionSchema,
  CyanViewStudioSelectFeedIdActionDefinitionSchema,
} from '../src/config.js'

import { CyanViewStudioActionExecutor } from '../src/cyanview-studio-action-executor.js'
import {
  CyanViewStudioConnectionError,
  type CyanViewStudioConnectionManagerContract,
} from '../src/cyanview-studio-connection-manager.js'

const action = CyanViewStudioSelectFeedActionDefinitionSchema.parse({
  actionId: 'cyanview-feed',
  interaction: 'press',
  actionColumnId: '22222222-2222-4222-8222-222222222222',
  type: 'cyanview-studio.select-feed',
  connectionId: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  cameraId: 'CAM-A',
})

const feedIdAction = CyanViewStudioSelectFeedIdActionDefinitionSchema.parse({
  actionId: 'cyanview-feed-id',
  interaction: 'press',
  actionColumnId: '44444444-4444-4444-8444-444444444444',
  type: 'cyanview-studio.select-feed-id',
  connectionId: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  feedId: 15,
})

const context = {
  executionId: '33333333-3333-4333-8333-333333333333',
  buttonNumber: ButtonIdentifierSchema.parse('1'),
  interaction: 'press' as const,
  wrap: true,
  signal: new AbortController().signal,
}

describe('CyanViewStudioActionExecutor', () => {
  it('selects the configured camera without exposing it in the result', async () => {
    const selectFeed = vi.fn(() => Promise.resolve())
    const executor = new CyanViewStudioActionExecutor(manager({ selectFeed }))

    await expect(executor.execute(action, context)).resolves.toEqual({ outcome: 'success' })
    expect(selectFeed).toHaveBeenCalledWith(action.connectionId, 'CAM-A')
  })

  it('selects the explicit feed ID without exposing it in the result', async () => {
    const selectFeedByFeedId = vi.fn(() => Promise.resolve())
    const executor = new CyanViewStudioActionExecutor(manager({ selectFeedByFeedId }))

    await expect(executor.execute(feedIdAction, context)).resolves.toEqual({
      outcome: 'success',
    })
    expect(selectFeedByFeedId).toHaveBeenCalledWith(feedIdAction.connectionId, 15)
  })

  it('dispatches visible feed numbers independently of legacy feed IDs', async () => {
    const selectFeedByNumber = vi.fn(() => Promise.resolve())
    const selectFeedByFeedId = vi.fn(() => Promise.resolve())
    const executor = new CyanViewStudioActionExecutor(
      manager({ selectFeedByNumber, selectFeedByFeedId }),
    )
    const { actionId, actionColumnId, connectionId, interaction, enabled } = feedIdAction
    await expect(
      executor.execute(
        {
          actionId,
          actionColumnId,
          connectionId,
          interaction,
          enabled,
          type: 'cyanview-studio.select-feed-number',
          feedNumber: 2,
        },
        context,
      ),
    ).resolves.toEqual({ outcome: 'success' })
    expect(selectFeedByNumber).toHaveBeenCalledExactlyOnceWith(action.connectionId, 2)
    expect(selectFeedByFeedId).not.toHaveBeenCalled()
  })

  it('explains how to replace a legacy selector rejected by the current API', async () => {
    const executor = new CyanViewStudioActionExecutor(
      manager({
        selectFeedByFeedId: vi.fn(() =>
          Promise.reject(
            new CyanViewStudioConnectionError('cyanview_feed_id_unsupported', 'private'),
          ),
        ),
      }),
    )
    await expect(executor.execute(feedIdAction, context)).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'cyanview_invalid_request',
      errorMessage:
        'This saved action uses a database Feed ID; add Select Feed and enter the feed number shown in Studio',
    })
  })

  it.each([
    'cyanview_unconfigured',
    'cyanview_unavailable',
    'cyanview_timeout',
    'cyanview_camera_not_found',
    'cyanview_feed_not_found',
    'cyanview_invalid_request',
    'cyanview_protocol_error',
  ] as const)('maps %s to a bounded action failure', async (code) => {
    const selection = vi.fn(() =>
      Promise.reject(new CyanViewStudioConnectionError(code, 'private CAM-A response detail')),
    )
    const executor = new CyanViewStudioActionExecutor(
      manager(
        code === 'cyanview_feed_not_found'
          ? { selectFeedByFeedId: selection }
          : { selectFeed: selection },
      ),
    )

    const result = await executor.execute(
      code === 'cyanview_feed_not_found' ? feedIdAction : action,
      context,
    )

    expect(result).toMatchObject({ outcome: 'failure', errorCode: code })
    expect(JSON.stringify(result)).not.toContain('CAM-A')
    expect(JSON.stringify(result)).not.toContain('private')
  })
})

function manager(
  overrides: Partial<
    Pick<
      CyanViewStudioConnectionManagerContract,
      'selectFeed' | 'selectFeedByFeedId' | 'selectFeedByNumber'
    >
  >,
): CyanViewStudioConnectionManagerContract {
  return {
    reconcile: vi.fn(),
    refresh: vi.fn(),
    selectFeed: vi.fn(() => Promise.resolve()),
    selectFeedByNumber: vi.fn(() => Promise.resolve()),
    selectFeedByFeedId: vi.fn(() => Promise.resolve()),
    snapshots: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    stop: vi.fn(),
    ...overrides,
  }
}
