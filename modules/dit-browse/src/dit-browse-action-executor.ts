import { DitBrowseCommandError } from '@hubble/dit-browse-client'
import type {
  DitBrowseCycleWorkspacesActionDefinition,
  DitBrowseFocusCameraActionDefinition,
  DitBrowseSetGridLockActionDefinition,
  DitBrowseShowGridActionDefinition,
  DitBrowseSwitchWorkspaceActionDefinition,
  DitBrowseToggleGridLockActionDefinition,
} from './config.js'

import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import type { DitBrowseConnectionManagerContract } from './dit-browse-connection-manager.js'

type DitBrowseActionDefinition =
  | DitBrowseFocusCameraActionDefinition
  | DitBrowseSwitchWorkspaceActionDefinition
  | DitBrowseShowGridActionDefinition
  | DitBrowseCycleWorkspacesActionDefinition
  | DitBrowseSetGridLockActionDefinition
  | DitBrowseToggleGridLockActionDefinition

export class DitBrowseActionExecutor implements TypedActionExecutor<DitBrowseActionDefinition> {
  constructor(private readonly connections: DitBrowseConnectionManagerContract) {}

  async execute(
    action: DitBrowseActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) throw new ActionAbortedError()

    const client = this.connections.client(action.connectionId)
    if (client === null || !client.snapshot.connected) {
      return failure('dit_browse_disconnected', 'DIT Browse is not connected')
    }

    switch (action.type) {
      case 'dit-browse.show-grid':
        return this.showGrid(client, action)
      case 'dit-browse.cycle-workspaces':
        return this.cycleWorkspaces(client, action)
      case 'dit-browse.switch-workspace':
        return this.switchWorkspace(client, action)
      case 'dit-browse.focus-camera':
        return this.focusCamera(client, action)
      case 'dit-browse.set-grid-lock':
        return this.setGridLocked(client, action)
      case 'dit-browse.toggle-grid-lock':
        return this.toggleGridLocked(client, action)
    }
  }

  private async showGrid(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseShowGridActionDefinition,
  ): Promise<AdapterActionResult> {
    try {
      const status = await client.showGrid()
      return status.focusMode
        ? failure('dit_browse_not_confirmed', 'DIT Browse did not confirm the grid view')
        : { outcome: 'success' }
    } catch (error) {
      return mapDitBrowseError(error, action)
    }
  }

  private async cycleWorkspaces(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseCycleWorkspacesActionDefinition,
  ): Promise<AdapterActionResult> {
    try {
      await client.cycleWorkspaces()
      return { outcome: 'success' }
    } catch (error) {
      return mapDitBrowseError(error, action)
    }
  }

  private async switchWorkspace(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseSwitchWorkspaceActionDefinition,
  ): Promise<AdapterActionResult> {
    try {
      const status = await client.switchWorkspace(action.workspaceNumber)
      if (status.activeWorkspaceNumber !== action.workspaceNumber || status.focusMode) {
        return failure(
          'dit_browse_not_confirmed',
          'DIT Browse did not confirm the requested workspace grid',
        )
      }
      return { outcome: 'success' }
    } catch (error) {
      return mapDitBrowseError(error, action)
    }
  }

  private async focusCamera(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseFocusCameraActionDefinition,
  ): Promise<AdapterActionResult> {
    let status
    try {
      status = await client.focusCamera(action.cameraNumber)
    } catch (error) {
      return mapDitBrowseError(error, action)
    }

    if (!status.expansionEnabled) {
      return failure(
        'dit_browse_expansion_disabled',
        'DIT Browse Grid Lock is enabled; camera focus was not performed',
      )
    }
    if (!status.focusMode || status.selectedCameraNumber !== action.cameraNumber) {
      return failure(
        'dit_browse_not_confirmed',
        'DIT Browse did not confirm the requested camera',
      )
    }
    return { outcome: 'success' }
  }

  private async setGridLocked(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseSetGridLockActionDefinition,
  ): Promise<AdapterActionResult> {
    let status
    try {
      status = await client.setGridLocked(action.locked)
    } catch (error) {
      return mapDitBrowseError(error, action)
    }

    if (status.expansionEnabled !== !action.locked) {
      return failure(
        'dit_browse_not_confirmed',
        action.locked
          ? 'DIT Browse did not confirm that Grid Lock is enabled'
          : 'DIT Browse did not confirm that Grid Lock is disabled',
      )
    }
    return { outcome: 'success' }
  }

  private async toggleGridLocked(
    client: NonNullable<ReturnType<DitBrowseConnectionManagerContract['client']>>,
    action: DitBrowseToggleGridLockActionDefinition,
  ): Promise<AdapterActionResult> {
    try {
      await client.toggleGridLocked()
    } catch (error) {
      return mapDitBrowseError(error, action)
    }
    return { outcome: 'success' }
  }
}

function mapDitBrowseError(
  error: unknown,
  action: DitBrowseActionDefinition,
): AdapterActionResult {
  if (!(error instanceof DitBrowseCommandError)) {
    return failure('dit_browse_protocol_error', 'DIT Browse command failed unexpectedly')
  }

  switch (error.code) {
    case 'not_connected':
    case 'disconnected':
    case 'stopped':
    case 'reconfigured':
      return failure('dit_browse_disconnected', 'DIT Browse disconnected before confirmation')
    case 'unsupported_command':
      return failure('dit_browse_rejected', 'Update DIT Browse to use workspace switching')
    case 'not_confirmed':
      return failure(
        'dit_browse_not_confirmed',
        'DIT Browse did not confirm the next workspace grid',
      )
    case 'protocol_error':
      return failure('dit_browse_protocol_error', 'DIT Browse returned an invalid response')
    case 'timeout':
      return failure(
        'dit_browse_timeout',
        'DIT Browse did not respond before the request timeout',
      )
    case 'bad_request':
    case 'not_found':
    case 'renderer_unavailable':
    case 'internal_error':
      return failure('dit_browse_rejected', vendorRejectionMessage(error.code, action))
  }
}

function vendorRejectionMessage(
  code: DitBrowseCommandError['code'],
  action: DitBrowseActionDefinition,
): string {
  if (action.type === 'dit-browse.show-grid') {
    return 'DIT Browse could not show the grid view'
  }
  if (action.type === 'dit-browse.cycle-workspaces') {
    return 'DIT Browse could not complete the workspace cycle; check its available workspaces'
  }
  if (action.type === 'dit-browse.switch-workspace') {
    if (code === 'not_found')
      return `DIT Browse workspace ${String(action.workspaceNumber)} is not in the current camera list`
    if (code === 'renderer_unavailable') return 'DIT Browse is not ready to switch workspaces'
    return 'DIT Browse could not complete the workspace request'
  }
  const isGridLock =
    action.type === 'dit-browse.set-grid-lock' || action.type === 'dit-browse.toggle-grid-lock'
  switch (code) {
    case 'not_found':
      return isGridLock
        ? 'DIT Browse rejected the Grid Lock request'
        : `DIT Browse camera ${String(action.cameraNumber)} is not in the current camera list`
    case 'renderer_unavailable':
      return isGridLock
        ? 'DIT Browse is not ready to change Grid Lock'
        : 'DIT Browse is not ready to switch cameras'
    case 'bad_request':
      return isGridLock
        ? 'DIT Browse rejected the Grid Lock request'
        : 'DIT Browse rejected the camera request'
    case 'internal_error':
      return isGridLock
        ? 'DIT Browse could not complete the Grid Lock request'
        : 'DIT Browse could not complete the camera request'
    default:
      return isGridLock
        ? 'DIT Browse rejected the Grid Lock request'
        : 'DIT Browse rejected the camera request'
  }
}

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
