import type {
  ActionExecutionContext,
  AdapterActionResult,
} from '@hubble/module-contracts/execution'
import type { ModuleActionResult, ModuleExecutionContext } from '@hubble/module-sdk'

export function legacyExecution(context: ModuleExecutionContext): ActionExecutionContext {
  return {
    executionId: context.executionId,
    interaction: context.gesture,
    wrap: context.wrap,
    signal: context.signal,
    buttonNumber: '1',
  }
}
export function legacyResult(
  result: AdapterActionResult,
  kind: 'response' | 'state-confirmed',
): ModuleActionResult {
  if (result.outcome === 'success')
    return {
      status: 'success',
      evidence: {
        kind,
        summary:
          kind === 'response'
            ? 'HTTP endpoint returned a successful response'
            : 'DIT Browse reported the requested state',
      },
    }
  const category = result.errorCode.includes('timeout')
    ? 'timeout'
    : result.errorCode.includes('disconnected') ||
        result.errorCode.includes('unavailable') ||
        result.errorCode.includes('unconfigured')
      ? 'unavailable'
      : result.errorCode.includes('invalid')
        ? 'invalid-config'
        : 'rejected'
  return { status: 'failure', category, code: result.errorCode, message: result.errorMessage }
}
