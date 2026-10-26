import {
  LightEncodeCommandError,
  type LightEncodeClientSnapshot,
  type LightEncodeStateSnapshot,
} from '@hubble/lightencode-client'
import { describe, expect, it, vi } from 'vitest'
import { ButtonIdentifierSchema, type LightEncodeActionDefinition } from '../src/config.js'

import { ActionAbortedError } from '@hubble/module-contracts/execution'
import { LightEncodeActionExecutor } from '../src/lightencode-action-executor.js'
import {
  LightEncodeConnectionManagerError,
  type LightEncodeConnectionManagerContract,
  type LightEncodeManagedClient,
} from '../src/lightencode-connection-manager.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

describe('LightEncodeActionExecutor', () => {
  it.each([
    ['lightencode.record-toggle-all', 'toggleAll', undefined],
    ['lightencode.record-toggle-slot', 'toggleSlot', 4],
    ['lightencode.timer-toggle', 'toggleTimer', undefined],
    ['lightencode.timer-set-minutes', 'setTimerMinutes', 45],
  ] as const)(
    'routes %s exactly once and waits for confirmation',
    async (type, method, value) => {
      const managedClient = client()
      const executor = new LightEncodeActionExecutor(manager(managedClient))

      await expect(executor.execute(action(type, value), context())).resolves.toEqual({
        outcome: 'success',
      })
      expect(managedClient[method]).toHaveBeenCalledTimes(1)
      if (value !== undefined) expect(managedClient[method]).toHaveBeenCalledWith(value)
    },
  )

  it('does not issue a command when execution was already aborted', async () => {
    const managedClient = client()
    const controller = new AbortController()
    controller.abort()

    await expect(
      new LightEncodeActionExecutor(manager(managedClient)).execute(
        action('lightencode.timer-toggle'),
        context(controller.signal),
      ),
    ).rejects.toBeInstanceOf(ActionAbortedError)
    expect(managedClient.toggleTimer).not.toHaveBeenCalled()
  })

  it('distinguishes an unconfigured connection from a disconnected client', async () => {
    await expect(
      new LightEncodeActionExecutor(manager(null)).execute(
        action('lightencode.record-toggle-all'),
        context(),
      ),
    ).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'lightencode_unconfigured',
      errorMessage: 'Light Encode connection is unavailable',
    })

    await expect(
      new LightEncodeActionExecutor(
        manager(client({ phase: 'disconnected', state: null })),
      ).execute(action('lightencode.record-toggle-all'), context()),
    ).resolves.toMatchObject({ outcome: 'failure', errorCode: 'lightencode_disconnected' })
  })

  it.each([
    ['disconnected', 'lightencode_disconnected'],
    ['command_timeout', 'lightencode_timeout'],
    ['slot_not_found', 'lightencode_slot_not_found'],
    ['rejected', 'lightencode_rejected'],
    ['state_not_confirmed', 'lightencode_not_confirmed'],
    ['duplicate_request', 'lightencode_protocol_error'],
    ['protocol_error', 'lightencode_protocol_error'],
  ] as const)('maps client error %s to safe failure %s', async (code, errorCode) => {
    const raw = 'pipeline d396fe70 private failure\nraw response at /private/path'
    const managedClient = client()
    vi.mocked(managedClient.toggleSlot).mockRejectedValueOnce(
      new LightEncodeCommandError(code, raw),
    )

    const result = await new LightEncodeActionExecutor(manager(managedClient)).execute(
      action('lightencode.record-toggle-slot', 4),
      context(),
    )

    expect(result).toMatchObject({ outcome: 'failure', errorCode })
    if (result.outcome === 'failure') {
      expect(result.errorMessage).not.toContain('d396fe70')
      expect(result.errorMessage).not.toContain('/private/path')
    }
  })

  it('maps an unknown failure without leaking details', async () => {
    const managedClient = client()
    vi.mocked(managedClient.toggleAll).mockRejectedValueOnce(
      new Error('private pipeline detail'),
    )

    await expect(
      new LightEncodeActionExecutor(manager(managedClient)).execute(
        action('lightencode.record-toggle-all'),
        context(),
      ),
    ).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'lightencode_protocol_error',
      errorMessage: 'Light Encode command failed unexpectedly',
    })
  })

  it('maps a pipeline race rejection back to the safe slot-unavailable code', async () => {
    const managedClient = client()
    const error = new LightEncodeCommandError(
      'rejected',
      'private missing pipeline detail',
      undefined,
      'pipeline_not_found',
    )
    vi.mocked(managedClient.toggleSlot).mockRejectedValueOnce(error)

    await expect(
      new LightEncodeActionExecutor(manager(managedClient)).execute(
        action('lightencode.record-toggle-slot', 4),
        context(),
      ),
    ).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'lightencode_slot_not_found',
      errorMessage: 'The requested Light Encode slot is unavailable',
    })
  })

  it('keeps a non-slot pipeline rejection in the general rejected category', async () => {
    const managedClient = client()
    vi.mocked(managedClient.toggleAll).mockRejectedValueOnce(
      new LightEncodeCommandError(
        'rejected',
        'private pipeline detail',
        undefined,
        'pipeline_not_found',
      ),
    )

    await expect(
      new LightEncodeActionExecutor(manager(managedClient)).execute(
        action('lightencode.record-toggle-all'),
        context(),
      ),
    ).resolves.toMatchObject({ outcome: 'failure', errorCode: 'lightencode_rejected' })
  })
})

function action(
  type: LightEncodeActionDefinition['type'],
  value?: number,
): LightEncodeActionDefinition {
  const common = {
    actionId: 'lightencode-action',
    actionColumnId: '22222222-2222-4222-8222-222222222222',
    interaction: 'press' as const,
    type,
    connectionId: CONNECTION_ID,
    enabled: true,
    drivesTally: true,
    feedbackColor: '#37A65B',
  }
  switch (type) {
    case 'lightencode.record-toggle-all':
    case 'lightencode.timer-toggle':
      return common as LightEncodeActionDefinition
    case 'lightencode.record-toggle-slot':
      return { ...common, slotNumber: value ?? 4 } as LightEncodeActionDefinition
    case 'lightencode.timer-set-minutes':
      return { ...common, minutes: value ?? 45 } as LightEncodeActionDefinition
  }
}

function context(signal = new AbortController().signal) {
  return {
    executionId: '33333333-3333-4333-8333-333333333333',
    buttonNumber: ButtonIdentifierSchema.parse('1'),
    interaction: 'press' as const,
    wrap: true,
    signal,
  }
}

function client(
  overrides: Partial<LightEncodeClientSnapshot> = {},
): LightEncodeManagedClient & {
  toggleAll: ReturnType<typeof vi.fn<() => Promise<LightEncodeStateSnapshot>>>
  toggleSlot: ReturnType<typeof vi.fn<(slot: number) => Promise<LightEncodeStateSnapshot>>>
  toggleTimer: ReturnType<typeof vi.fn<() => Promise<LightEncodeStateSnapshot>>>
  setTimerMinutes: ReturnType<
    typeof vi.fn<(minutes: number) => Promise<LightEncodeStateSnapshot>>
  >
} {
  const confirmed = state()
  return {
    snapshot: snapshot(overrides),
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    toggleAll: vi.fn(() => Promise.resolve(confirmed)),
    toggleSlot: vi.fn(() => Promise.resolve(confirmed)),
    toggleTimer: vi.fn(() => Promise.resolve(confirmed)),
    setTimerMinutes: vi.fn(() => Promise.resolve(confirmed)),
  }
}

function manager(
  managedClient: LightEncodeManagedClient | null,
): LightEncodeConnectionManagerContract {
  const invoke = (
    connectionId: string,
    command: (client: LightEncodeManagedClient) => Promise<LightEncodeStateSnapshot>,
  ): Promise<LightEncodeStateSnapshot> => {
    if (connectionId !== CONNECTION_ID || managedClient === null) {
      return Promise.reject(
        new LightEncodeConnectionManagerError(
          'lightencode_unconfigured',
          'Light Encode is unavailable',
        ),
      )
    }
    if (managedClient.snapshot.phase !== 'connected' || managedClient.snapshot.state === null) {
      return Promise.reject(new LightEncodeCommandError('disconnected', 'not connected'))
    }
    return command(managedClient)
  }
  return {
    reconcile: () => undefined,
    refresh: () => undefined,
    toggleAll: (connectionId) => invoke(connectionId, (client) => client.toggleAll()),
    toggleSlot: (connectionId, slotNumber) =>
      invoke(connectionId, (client) => client.toggleSlot(slotNumber)),
    toggleTimer: (connectionId) => invoke(connectionId, (client) => client.toggleTimer()),
    setTimerMinutes: (connectionId, minutes) =>
      invoke(connectionId, (client) => client.setTimerMinutes(minutes)),
    snapshots: () => [],
    subscribe: () => () => undefined,
    stop: () => undefined,
  }
}

function snapshot(
  overrides: Partial<LightEncodeClientSnapshot> = {},
): LightEncodeClientSnapshot {
  return {
    phase: 'connected',
    host: '127.0.0.1',
    port: 59_613,
    appVersion: '1.0.0',
    sessionId: '44444444-4444-4444-8444-444444444444',
    capabilities: ['record.toggleAll', 'record.togglePipeline', 'timer.toggle', 'timer.set'],
    state: state(),
    lastEventAt: '2026-08-22T12:00:00.000Z',
    lastError: null,
    reconnectAttempt: 0,
    ...overrides,
  }
}

function state(): LightEncodeStateSnapshot {
  return {
    type: 'state',
    revision: 3,
    app: { anyRecording: false, timerEnabled: false, timerMinutes: 30 },
    pipelines: [],
  }
}
