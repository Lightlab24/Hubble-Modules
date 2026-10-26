import type { LiveGradeSelectSlotActionDefinition } from './config.js'

import type {
  ActionExecutionContext,
  AdapterActionResult,
  TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  LiveGradeConnectionError,
  type LiveGradeConnectionManagerContract,
} from './livegrade-connection-manager.js'

export class LiveGradeActionExecutor implements TypedActionExecutor<LiveGradeSelectSlotActionDefinition> {
  constructor(private readonly connections: LiveGradeConnectionManagerContract) {}

  async execute(
    action: LiveGradeSelectSlotActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) {
      return failure('action_exception', 'LiveGrade action was cancelled')
    }
    try {
      await this.connections.selectSlot(action.connectionId, {
        ...(action.application === undefined ? {} : { application: action.application }),
        position: action.sequence,
        query: action.slotId,
      })
      return { outcome: 'success' }
    } catch (error) {
      return mapLiveGradeError(error)
    }
  }
}

function mapLiveGradeError(error: unknown): AdapterActionResult {
  if (!(error instanceof LiveGradeConnectionError)) {
    return failure('livegrade_protocol_error', 'LiveGrade slot control failed unexpectedly')
  }
  switch (error.code) {
    case 'livegrade_not_running':
      return failure(
        'livegrade_not_running',
        'The selected LiveGrade application is not running',
      )
    case 'livegrade_application_ambiguous':
      return failure(
        'livegrade_unconfigured',
        'More than one copy of the selected LiveGrade application is running',
      )
    case 'accessibility_permission_required':
      return failure(
        'livegrade_permission_required',
        'Hubble needs Accessibility permission for LiveGrade slot control',
      )
    case 'livegrade_menu_unavailable':
    case 'livegrade_slots_unavailable':
      return failure(
        'livegrade_menu_unavailable',
        'The configured LiveGrade slot menu is unavailable',
      )
    case 'livegrade_slot_invalid':
    case 'livegrade_slot_not_found':
    case 'livegrade_slot_ambiguous':
    case 'livegrade_slot_mismatch':
      return failure('livegrade_slot_unavailable', 'Requested LiveGrade slot is unavailable')
    case 'livegrade_focus_violation':
      return failure(
        'livegrade_focus_violation',
        'LiveGrade became frontmost; Hubble stopped background slot control',
      )
    case 'livegrade_timeout':
      return failure('livegrade_timeout', 'LiveGrade slot control timed out')
    case 'livegrade_unconfigured':
      return failure('livegrade_unconfigured', 'LiveGrade connection is unavailable')
    default:
      return failure('livegrade_protocol_error', 'LiveGrade did not accept the slot command')
  }
}

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
