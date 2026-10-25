import { LightEncodeCommandError } from '@hubble/lightencode-client'
import type { LightEncodeActionDefinition } from './config.js'

import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  LightEncodeConnectionManagerError,
  type LightEncodeConnectionManagerContract,
} from './lightencode-connection-manager.js'

export class LightEncodeActionExecutor implements TypedActionExecutor<LightEncodeActionDefinition> {
  constructor(private readonly connections: LightEncodeConnectionManagerContract) {}

  async execute(
    action: LightEncodeActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) throw new ActionAbortedError()

    try {
      switch (action.type) {
        case 'lightencode.record-toggle-all':
          await this.connections.toggleAll(action.connectionId)
          return { outcome: 'success' }
        case 'lightencode.record-toggle-slot':
          await this.connections.toggleSlot(action.connectionId, action.slotNumber)
          return { outcome: 'success' }
        case 'lightencode.timer-toggle':
          await this.connections.toggleTimer(action.connectionId)
          return { outcome: 'success' }
        case 'lightencode.timer-set-minutes':
          await this.connections.setTimerMinutes(action.connectionId, action.minutes)
          return { outcome: 'success' }
      }
      return assertNever(action)
    } catch (error) {
      return mapLightEncodeError(error, action)
    }
  }
}

function assertNever(value: never): never {
  void value
  throw new Error('Unsupported Light Encode action type')
}

function mapLightEncodeError(
  error: unknown,
  action: LightEncodeActionDefinition,
): AdapterActionResult {
  if (error instanceof LightEncodeConnectionManagerError) {
    return failure('lightencode_unconfigured', 'Light Encode connection is unavailable')
  }
  if (!(error instanceof LightEncodeCommandError)) {
    return failure('lightencode_protocol_error', 'Light Encode command failed unexpectedly')
  }

  switch (error.code) {
    case 'disconnected':
      return failure(
        'lightencode_disconnected',
        'Light Encode disconnected before confirmation',
      )
    case 'command_timeout':
      return failure(
        'lightencode_timeout',
        'Light Encode did not confirm the command before the request timeout',
      )
    case 'slot_not_found':
      return failure(
        'lightencode_slot_not_found',
        'The requested Light Encode slot is unavailable',
      )
    case 'rejected':
      if (
        action.type === 'lightencode.record-toggle-slot' &&
        Reflect.get(error, 'serverCode') === 'pipeline_not_found'
      ) {
        return failure(
          'lightencode_slot_not_found',
          'The requested Light Encode slot is unavailable',
        )
      }
      return failure('lightencode_rejected', 'Light Encode rejected the requested command')
    case 'state_not_confirmed':
      return failure(
        'lightencode_not_confirmed',
        'Light Encode did not confirm the requested state',
      )
    case 'duplicate_request':
    case 'protocol_error':
      return failure('lightencode_protocol_error', 'Light Encode returned an invalid response')
  }
}

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
