import { expect, it, vi } from 'vitest'
import type { ModuleContext, ModuleFeedback } from '@hubble/module-sdk'
import type {
  LightEncodeClientSnapshot,
  LightEncodeStateSnapshot,
} from '@hubble/lightencode-client'
import { createLightEncodeModule } from '../src/module.js'
import {
  LightEncodeConnectionManager,
  type LightEncodeManagedClient,
} from '../src/lightencode-connection-manager.js'

it('owns Matrix dispatch and observed recording colours without a host feedback resolver', async () => {
  let snapshot: LightEncodeClientSnapshot = {
    phase: 'connected',
    host: '127.0.0.1',
    port: 59613,
    appVersion: '1',
    sessionId: 'fixture',
    capabilities: [],
    lastEventAt: null,
    lastError: null,
    reconnectAttempt: 0,
    state: {
      type: 'state',
      revision: 1,
      app: { anyRecording: true, timerEnabled: true, timerMinutes: 45 },
      pipelines: [],
    },
  }
  const listeners = new Set<(snapshot: LightEncodeClientSnapshot) => void>()
  const result = async () => snapshot.state as LightEncodeStateSnapshot
  const client: LightEncodeManagedClient = {
    get snapshot() {
      return snapshot
    },
    start() {},
    stop() {},
    toggleAll: vi.fn(result),
    toggleSlot: vi.fn(result),
    toggleTimer: vi.fn(result),
    setTimerMinutes: vi.fn(result),
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
  }
  const feedback: ModuleFeedback[] = []
  const context: ModuleContext = {
    instanceId: 'matrix',
    scope: {
      kind: 'connection',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
    },
    settings: { host: '127.0.0.1', port: 59613, requestTimeoutMs: 1000 },
    log() {},
    publishState() {},
    publishEvent() {},
    publishFeedback(value) {
      feedback.push(value)
    },
  }
  const instance = createLightEncodeModule(
    () => new LightEncodeConnectionManager(() => client),
  ).createInstance(context)
  const execution = {
    executionId: 'matrix-test',
    gesture: 'press' as const,
    wrap: false,
    signal: new AbortController().signal,
    log() {},
  }
  await instance.start()
  try {
    for (const [actionType, actionValue, method, parameter] of [
      ['record-toggle-all', null, 'toggleAll', undefined],
      ['record-toggle-slot', 4, 'toggleSlot', 4],
      ['timer-toggle', null, 'toggleTimer', undefined],
      ['timer-set-minutes', 45, 'setTimerMinutes', 45],
    ] as const) {
      expect(
        await instance.execute(
          'matrix',
          {
            values: {
              enabled: true,
              actionType,
              actionValue,
              feedback: true,
              feedbackColor: '#123456',
            },
          },
          execution,
        ),
      ).toMatchObject({ status: 'success' })
      expect(client[method]).toHaveBeenCalledTimes(1)
      if (parameter !== undefined) expect(client[method]).toHaveBeenCalledWith(parameter)
    }
    const values = {
      enabled: true,
      actionType: 'record-toggle-all',
      feedback: true,
      feedbackColor: '#123456',
    }
    await instance.subscribeFeedback?.([{ id: 'matrix', fields: { actionId: 'row1', values } }], {
      signal: execution.signal,
    })
    expect(feedback.at(-1)).toMatchObject({
      state: 'active',
      appearance: { backgroundColor: '#123456' },
      fields: { actionId: 'row1' },
    })
    expect(client.toggleAll).toHaveBeenCalledTimes(1)
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state!,
        revision: 2,
        app: { anyRecording: false, timerEnabled: true, timerMinutes: 45 },
      },
    }
    for (const listener of listeners) listener(snapshot)
    await Promise.resolve()
    expect(feedback.at(-1)).toMatchObject({
      state: 'inactive',
      appearance: { backgroundColor: null },
    })
    snapshot = { ...snapshot, phase: 'disconnected', state: null }
    for (const listener of listeners) listener(snapshot)
    await Promise.resolve()
    expect(feedback.at(-1)).toMatchObject({
      state: 'unavailable',
      observedAt: null,
      appearance: { backgroundColor: null },
    })
    for (const actionValue of [0, 1000])
      expect(
        await instance.execute(
          'matrix',
          { values: { actionType: 'record-toggle-slot', actionValue } },
          execution,
        ),
      ).toMatchObject({ status: 'failure', category: 'invalid-config' })
    expect(client.toggleSlot).toHaveBeenCalledTimes(1)
  } finally {
    await instance.dispose()
  }
  expect(listeners.size).toBe(0)
})
