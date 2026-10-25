import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  CyanViewRcpConnectionError,
  type CyanViewRcpConnectionManagerContract,
} from '@hubble/protocol-cyanview-rcp'
import type { CyanViewRcpActionDefinition } from './config.js'

export class CyanViewRcpActionExecutor implements TypedActionExecutor<CyanViewRcpActionDefinition> {
  constructor(private readonly connections: CyanViewRcpConnectionManagerContract) {}
  async execute(
    action: CyanViewRcpActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    requireNotAborted(context.signal)
    try {
      switch (action.type) {
        case 'cyanview-rcp.select-camera':
          await this.connections.selectCamera(
            action.connectionId,
            action.cameraNumber,
            context.signal,
          )
          break
        case 'cyanview-rcp.record-camera':
          await this.connections.recordCamera(
            action.connectionId,
            action.cameraNumber,
            context.signal,
          )
          break
        case 'cyanview-rcp.record-group-all':
          await this.connections.recordGroupAll(action.connectionId, context.signal)
          break
      }
      return { outcome: 'success' }
    } catch (error: unknown) {
      requireNotAborted(context.signal)
      return {
        outcome: 'failure',
        errorCode:
          error instanceof CyanViewRcpConnectionError ? error.code : 'cyanview_protocol_error',
        errorMessage:
          error instanceof CyanViewRcpConnectionError
            ? error.message
            : 'CyanView RCP command failed',
      }
    }
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ActionAbortedError()
}
