import {
  DitBrowseCommandError,
  type DitBrowseConnectionSnapshot,
  type DitBrowseStatus,
} from '@hubble/dit-browse-client'
import { describe, expect, it, vi } from 'vitest'
import {
  ButtonIdentifierSchema,
  DitBrowseFocusCameraActionDefinitionSchema,
  DitBrowseSetGridLockActionDefinitionSchema,
  DitBrowseShowGridActionDefinitionSchema,
  DitBrowseSwitchWorkspaceActionDefinitionSchema,
  DitBrowseToggleGridLockActionDefinitionSchema,
  type DitBrowseFocusCameraActionDefinition,
  type DitBrowseSetGridLockActionDefinition,
  type DitBrowseToggleGridLockActionDefinition,
} from '../src/config.js'

import { DitBrowseActionExecutor } from '../src/dit-browse-action-executor.js'
import type {
  DitBrowseConnectionManagerContract,
  DitBrowseManagedClient,
} from '../src/dit-browse-connection-manager.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

describe('DitBrowseActionExecutor', () => {
  it.each([true, false])(
    'shows the grid without changing expansion=%s',
    async (expansionEnabled) => {
      const showGrid = vi.fn(() =>
        Promise.resolve(status({ expansionEnabled, focusMode: false })),
      )
      const managed = {
        ...client(() => Promise.resolve(status())),
        showGrid,
        setGridLocked: vi.fn(),
        toggleGridLocked: vi.fn(),
      }
      const executor = new DitBrowseActionExecutor(manager(managed))
      const gridAction = DitBrowseShowGridActionDefinitionSchema.parse({
        actionId: 'grid',
        actionColumnId: action().actionColumnId,
        connectionId: CONNECTION_ID,
        interaction: 'press',
        type: 'dit-browse.show-grid',
        enabled: true,
      })
      await expect(executor.execute(gridAction, context())).resolves.toEqual({
        outcome: 'success',
      })
      expect(showGrid).toHaveBeenCalledTimes(1)
      expect(managed.setGridLocked).not.toHaveBeenCalled()
      expect(managed.toggleGridLocked).not.toHaveBeenCalled()
    },
  )

  it('rejects an unconfirmed grid view', async () => {
    const executor = new DitBrowseActionExecutor(
      manager(client(() => Promise.resolve(status({ focusMode: true })))),
    )
    const gridAction = DitBrowseShowGridActionDefinitionSchema.parse({
      actionId: 'grid',
      actionColumnId: action().actionColumnId,
      connectionId: CONNECTION_ID,
      interaction: 'press',
      type: 'dit-browse.show-grid',
      enabled: true,
    })
    await expect(executor.execute(gridAction, context())).resolves.toMatchObject({
      outcome: 'failure',
      errorCode: 'dit_browse_not_confirmed',
    })
  })

  it.each([
    [2, false, false, 'success'],
    [2, true, false, 'success'],
    [1, true, false, 'failure'],
    [2, true, true, 'failure'],
    [undefined, true, false, 'failure'],
  ] as const)(
    'confirms workspace %s with expansion %s and focus %s',
    async (activeWorkspaceNumber, expansionEnabled, focusMode, outcome) => {
      const switchWorkspace = vi.fn(() =>
        Promise.resolve(
          status({
            ...(activeWorkspaceNumber === undefined ? {} : { activeWorkspaceNumber }),
            expansionEnabled,
            focusMode,
          }),
        ),
      )
      const executor = new DitBrowseActionExecutor(manager(client(switchWorkspace)))
      const workspaceAction = DitBrowseSwitchWorkspaceActionDefinitionSchema.parse({
        actionId: 'workspace-2',
        actionColumnId: '22222222-2222-4222-8222-222222222222',
        connectionId: CONNECTION_ID,
        interaction: 'press',
        type: 'dit-browse.switch-workspace',
        enabled: true,
        workspaceNumber: 2,
      })
      await expect(executor.execute(workspaceAction, context())).resolves.toMatchObject({
        outcome,
      })
      expect(switchWorkspace).toHaveBeenCalledWith(2)
    },
  )

  it('succeeds only after strict focus confirmation', async () => {
    const focusCamera = vi.fn(() => Promise.resolve(status({ selectedCameraNumber: 3 })))
    const executor = new DitBrowseActionExecutor(manager(client(focusCamera)))

    await expect(executor.execute(action(), context())).resolves.toEqual({ outcome: 'success' })
    expect(focusCamera).toHaveBeenCalledWith(3)
  })

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    'sets Grid Lock to desired state locked=%s and verifies expansion=%s',
    async (locked, expansionEnabled) => {
      const setGridLocked = vi.fn(() =>
        Promise.resolve(status({ expansionEnabled, focusMode: false })),
      )
      const executor = new DitBrowseActionExecutor(
        manager(client(() => Promise.resolve(status()), true, setGridLocked)),
      )

      await expect(executor.execute(gridAction(locked), context())).resolves.toEqual({
        outcome: 'success',
      })
      expect(setGridLocked).toHaveBeenCalledWith(locked)
    },
  )

  it('toggles Grid Lock exactly once and accepts the returned state', async () => {
    const toggleGridLocked = vi.fn(() =>
      Promise.resolve(status({ expansionEnabled: false, focusMode: false })),
    )
    const executor = new DitBrowseActionExecutor(
      manager(client(() => Promise.resolve(status()), true, undefined, toggleGridLocked)),
    )

    await expect(executor.execute(toggleGridAction(), context())).resolves.toEqual({
      outcome: 'success',
    })
    expect(toggleGridLocked).toHaveBeenCalledTimes(1)
  })

  it.each([
    [true, true, 'enabled'],
    [false, false, 'disabled'],
  ] as const)(
    'fails when DIT Browse does not confirm desired Grid Lock state locked=%s',
    async (locked, expansionEnabled, expectedState) => {
      const executor = new DitBrowseActionExecutor(
        manager(
          client(
            () => Promise.resolve(status()),
            true,
            () => Promise.resolve(status({ expansionEnabled, focusMode: false })),
          ),
        ),
      )

      await expect(executor.execute(gridAction(locked), context())).resolves.toEqual({
        outcome: 'failure',
        errorCode: 'dit_browse_not_confirmed',
        errorMessage: `DIT Browse did not confirm that Grid Lock is ${expectedState}`,
      })
    },
  )

  it.each([
    [status({ expansionEnabled: false, focusMode: false }), 'dit_browse_expansion_disabled'],
    [status({ focusMode: false }), 'dit_browse_not_confirmed'],
    [status({ selectedCameraNumber: 4 }), 'dit_browse_not_confirmed'],
  ] as const)('rejects an unconfirmed returned status', async (returnedStatus, errorCode) => {
    const executor = new DitBrowseActionExecutor(
      manager(client(() => Promise.resolve(returnedStatus))),
    )

    await expect(executor.execute(action(), context())).resolves.toMatchObject({
      outcome: 'failure',
      errorCode,
    })
  })

  it('explains that Grid Lock blocked a successful focus no-op', async () => {
    const executor = new DitBrowseActionExecutor(
      manager(
        client(() => Promise.resolve(status({ expansionEnabled: false, focusMode: false }))),
      ),
    )

    await expect(executor.execute(action(), context())).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'dit_browse_expansion_disabled',
      errorMessage: 'DIT Browse Grid Lock is enabled; camera focus was not performed',
    })
  })

  it('returns a bounded disconnected failure for an absent or offline client', async () => {
    await expect(
      new DitBrowseActionExecutor(manager(null)).execute(action(), context()),
    ).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'dit_browse_disconnected',
      errorMessage: 'DIT Browse is not connected',
    })

    const offline = client(() => Promise.reject(new Error('must not run')), false)
    await expect(
      new DitBrowseActionExecutor(manager(offline)).execute(action(), context()),
    ).resolves.toMatchObject({ outcome: 'failure', errorCode: 'dit_browse_disconnected' })
  })

  it.each([
    ['not_connected', 'dit_browse_disconnected'],
    ['disconnected', 'dit_browse_disconnected'],
    ['protocol_error', 'dit_browse_protocol_error'],
    ['not_found', 'dit_browse_rejected'],
    ['renderer_unavailable', 'dit_browse_rejected'],
    ['timeout', 'dit_browse_timeout'],
    ['internal_error', 'dit_browse_rejected'],
  ] as const)('maps client error %s without exposing raw details', async (code, errorCode) => {
    const executor = new DitBrowseActionExecutor(
      manager(
        client(() =>
          Promise.reject(
            new DitBrowseCommandError(code, 'private URL ws://127.0.0.1:7502/path\nraw frame'),
          ),
        ),
      ),
    )

    const result = await executor.execute(action(), context())
    expect(result).toMatchObject({ outcome: 'failure', errorCode })
    if (result.outcome === 'failure') {
      expect(result.errorMessage).not.toContain('ws://')
      expect(result.errorMessage).not.toContain('raw frame')
    }
  })

  it('identifies the unavailable camera number in a bounded not-found failure', async () => {
    const executor = new DitBrowseActionExecutor(
      manager(
        client(() =>
          Promise.reject(
            new DitBrowseCommandError('not_found', 'private renderer camera detail'),
          ),
        ),
      ),
    )

    await expect(executor.execute(action(), context())).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'dit_browse_rejected',
      errorMessage: 'DIT Browse camera 3 is not in the current camera list',
    })
  })

  it('maps an unknown adapter rejection to a protocol failure', async () => {
    const executor = new DitBrowseActionExecutor(
      manager(client(() => Promise.reject(new Error('private detail')))),
    )
    await expect(executor.execute(action(), context())).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'dit_browse_protocol_error',
      errorMessage: 'DIT Browse command failed unexpectedly',
    })
  })

  it('maps Grid Lock rejections without exposing raw details', async () => {
    const executor = new DitBrowseActionExecutor(
      manager(
        client(
          () => Promise.resolve(status()),
          true,
          () =>
            Promise.reject(
              new DitBrowseCommandError('internal_error', 'private renderer grid detail'),
            ),
        ),
      ),
    )

    await expect(executor.execute(gridAction(true), context())).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'dit_browse_rejected',
      errorMessage: 'DIT Browse could not complete the Grid Lock request',
    })
  })
})

function action(): DitBrowseFocusCameraActionDefinition {
  return DitBrowseFocusCameraActionDefinitionSchema.parse({
    actionId: 'dit-focus-camera',
    interaction: 'press',
    actionColumnId: '22222222-2222-4222-8222-222222222222',
    type: 'dit-browse.focus-camera',
    connectionId: CONNECTION_ID,
    enabled: true,
    cameraNumber: 3,
    drivesTally: false,
  })
}

function gridAction(locked: boolean): DitBrowseSetGridLockActionDefinition {
  return DitBrowseSetGridLockActionDefinitionSchema.parse({
    actionId: 'dit-set-grid-lock',
    interaction: 'press',
    actionColumnId: '44444444-4444-4444-8444-444444444444',
    type: 'dit-browse.set-grid-lock',
    connectionId: CONNECTION_ID,
    enabled: true,
    locked,
    drivesTally: true,
  })
}

function toggleGridAction(): DitBrowseToggleGridLockActionDefinition {
  return DitBrowseToggleGridLockActionDefinitionSchema.parse({
    actionId: 'dit-toggle-grid-lock',
    interaction: 'press',
    actionColumnId: '55555555-5555-4555-8555-555555555555',
    type: 'dit-browse.toggle-grid-lock',
    connectionId: CONNECTION_ID,
    enabled: true,
    drivesTally: true,
  })
}

function context() {
  return {
    executionId: '33333333-3333-4333-8333-333333333333',
    buttonNumber: ButtonIdentifierSchema.parse('1'),
    interaction: 'press' as const,
    wrap: true,
    signal: new AbortController().signal,
  }
}

function client(
  focusCamera: (cameraNumber: number) => Promise<DitBrowseStatus>,
  connected = true,
  setGridLocked: (locked: boolean) => Promise<DitBrowseStatus> = () =>
    Promise.resolve(status({ expansionEnabled: false, focusMode: false })),
  toggleGridLocked: () => Promise<DitBrowseStatus> = () =>
    Promise.resolve(status({ expansionEnabled: false, focusMode: false })),
): DitBrowseManagedClient {
  return {
    snapshot: connectionSnapshot(connected),
    start: () => undefined,
    stop: () => undefined,
    focusCamera,
    switchWorkspace: focusCamera,
    showGrid: () => focusCamera(1),
    cycleWorkspaces: () => focusCamera(1),
    setGridLocked,
    toggleGridLocked,
    subscribe: () => () => undefined,
  }
}

function manager(
  managedClient: DitBrowseManagedClient | null,
): DitBrowseConnectionManagerContract {
  return {
    reconcile: () => undefined,
    refresh: () => undefined,
    client: (connectionId) => (connectionId === CONNECTION_ID ? managedClient : null),
    snapshots: () => [],
    subscribe: () => () => undefined,
    stop: () => undefined,
  }
}

function connectionSnapshot(connected: boolean): DitBrowseConnectionSnapshot {
  return {
    phase: connected ? 'connected' : 'disconnected',
    connected,
    endpoint: 'ws://127.0.0.1:7502/api/ws',
    port: 7502,
    serverVersion: connected ? '1.0.1' : null,
    status: null,
    revision: -1,
    catalog: [],
    lastError: null,
    reconnectAttempt: 0,
    nextReconnectDelayMs: null,
  }
}

function status(overrides: Partial<DitBrowseStatus> = {}): DitBrowseStatus {
  return {
    expansionEnabled: true,
    focusMode: true,
    selectedCameraNumber: 3,
    selectedTileId: 'tile-camera-3',
    selectedIndex: 3,
    tabs: [
      {
        index: 3,
        tileId: 'tile-camera-3',
        cameraId: 'camera-3',
        cameraNumber: 3,
        title: 'Camera 3',
        url: 'https://example.invalid/camera/3',
      },
    ],
    ...overrides,
  }
}
