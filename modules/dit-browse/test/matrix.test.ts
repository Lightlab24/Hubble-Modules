import { expect, it, vi } from 'vitest'
import type { ModuleContext, ModuleFeedback } from '@hubble/module-sdk'
import type { DitBrowseConnectionSnapshot, DitBrowseStatus } from '@hubble/dit-browse-client'
import { createDitBrowseModule } from '../src/module.js'
import {
  DitBrowseConnectionManager,
  type DitBrowseManagedClient,
} from '../src/dit-browse-connection-manager.js'

it('owns Matrix commands, contextual discovery and feedback without a host DIT resolver', async () => {
  const status: DitBrowseStatus = {
    expansionEnabled: true,
    focusMode: false,
    selectedCameraNumber: null,
    selectedTileId: null,
    selectedIndex: null,
    tabs: [],
    activeWorkspaceNumber: 1,
    workspaceNumbers: [1, 2, 3],
  }
  let snapshot: DitBrowseConnectionSnapshot = {
    phase: 'connected',
    connected: true,
    endpoint: 'ws://127.0.0.1:7502/api/ws',
    port: 7502,
    serverVersion: '1',
    status,
    revision: 1,
    catalog: [
      { cameraNumber: 3, title: 'Camera Three', url: 'fixture:three' },
      { cameraNumber: 4, title: 'Camera Four', url: 'fixture:four' },
    ],
    lastError: null,
    reconnectAttempt: 0,
    nextReconnectDelayMs: null,
  }
  const listeners = new Set<(value: DitBrowseConnectionSnapshot) => void>()
  const publish = (value: Partial<DitBrowseStatus>) => {
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      status: { ...snapshot.status!, ...value },
    }
    for (const listener of listeners) listener(snapshot)
    return Promise.resolve(snapshot.status!)
  }
  const client: DitBrowseManagedClient = {
    get snapshot() {
      return snapshot
    },
    start() {},
    stop() {},
    focusCamera: vi.fn((cameraNumber) =>
      publish({ focusMode: true, selectedCameraNumber: cameraNumber }),
    ),
    switchWorkspace: vi.fn((workspaceNumber) =>
      publish({ focusMode: false, activeWorkspaceNumber: workspaceNumber }),
    ),
    showGrid: vi.fn(() => publish({ focusMode: false })),
    cycleWorkspaces: vi.fn(() => publish({ activeWorkspaceNumber: 3 })),
    setGridLocked: vi.fn((locked) => publish({ expansionEnabled: !locked, focusMode: false })),
    toggleGridLocked: vi.fn(() =>
      publish({ expansionEnabled: !snapshot.status!.expansionEnabled, focusMode: false }),
    ),
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const feedback: ModuleFeedback[] = []
  const context: ModuleContext = {
    instanceId: 'dit-matrix',
    scope: {
      kind: 'connection',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
    },
    settings: { port: 7502, requestTimeoutMs: 3500 },
    log() {},
    publishState() {},
    publishEvent() {},
    publishFeedback(value) {
      if (value.id === 'matrix') feedback.push(value)
    },
  }
  const instance = createDitBrowseModule(
    () => new DitBrowseConnectionManager(() => client),
  ).createInstance(context)
  const execution = {
    executionId: 'matrix',
    gesture: 'press' as const,
    wrap: true,
    signal: new AbortController().signal,
    log() {},
  }
  await instance.start()
  try {
    for (const [actionType, actionValue, method, parameter] of [
      ['focus-camera', 3, 'focusCamera', 3],
      ['switch-workspace', 2, 'switchWorkspace', 2],
      ['show-grid', '', 'showGrid', undefined],
      ['cycle-workspaces', '', 'cycleWorkspaces', undefined],
      ['set-grid-lock', 'TRUE', 'setGridLocked', true],
      ['toggle-grid-lock', '', 'toggleGridLocked', undefined],
    ] as const) {
      expect(
        await instance.execute(
          'matrix',
          { values: { actionType, actionValue, feedback: true, feedbackColor: '#123456' } },
          execution,
        ),
      ).toMatchObject({ status: 'success' })
      expect(client[method]).toHaveBeenCalledTimes(1)
      if (parameter !== undefined) expect(client[method]).toHaveBeenCalledWith(parameter)
    }
    const query = {
      version: 2 as const,
      provider: 'matrix-values',
      draft: { actionType: 'focus-camera' },
      search: 'camera',
      cursor: null,
      limit: 1,
      requestRevision: 1,
    }
    const first = await instance.discoverChoices?.(query, { signal: execution.signal })
    expect(first).toMatchObject({
      choices: [{ id: '3', label: '3: Camera Three' }],
      nextCursor: '1',
    })
    expect(
      await instance.discoverChoices?.(
        { ...query, catalogRevision: first!.revision, cursor: first!.nextCursor },
        { signal: execution.signal },
      ),
    ).toMatchObject({ choices: [{ id: '4' }], nextCursor: null })
    expect(
      await instance.discoverChoices?.(
        { ...query, search: '', limit: 10, draft: { actionType: 'switch-workspace' } },
        { signal: execution.signal },
      ),
    ).toMatchObject({ choices: [{ id: '1' }, { id: '2' }, { id: '3' }] })
    const values = {
      actionType: 'toggle-grid-lock',
      feedback: true,
      feedbackColor: '#123456 | #654321',
    }
    await instance.subscribeFeedback?.(
      [
        {
          id: 'matrix',
          fields: { actionId: 'invalid-draft', values: { ...values, feedbackColor: 'unfinished' } },
        },
        { id: 'matrix', fields: { actionId: 'row', values } },
      ],
      { signal: execution.signal },
    )
    expect(feedback.at(-2)).toMatchObject({ state: 'unavailable' })
    expect(feedback.at(-1)).toMatchObject({
      state: 'inactive',
      appearance: { backgroundColor: '#123456' },
    })
    await publish({ expansionEnabled: false })
    expect(feedback.at(-1)).toMatchObject({
      state: 'active',
      appearance: { backgroundColor: '#654321' },
    })
    snapshot = { ...snapshot, connected: false, phase: 'disconnected' }
    for (const listener of listeners) listener(snapshot)
    expect(feedback.at(-1)).toMatchObject({
      state: 'unavailable',
      appearance: { backgroundColor: null },
    })
    expect(client.toggleGridLocked).toHaveBeenCalledTimes(1)
    expect(
      await instance.execute(
        'matrix',
        { values: { actionType: 'focus-camera', actionValue: 0 } },
        execution,
      ),
    ).toMatchObject({ status: 'failure', category: 'invalid-config' })
    expect(client.focusCamera).toHaveBeenCalledTimes(1)
  } finally {
    await instance.dispose()
  }
  expect(listeners.size).toBe(0)
})
