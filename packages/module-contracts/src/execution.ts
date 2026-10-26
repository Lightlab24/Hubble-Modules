import type { LegacyActionFailureCode } from './legacy-errors.js'
import type { ButtonInteraction } from './types.js'
export interface RuntimeClock {
  now(): Date
  monotonicMs(): number
  schedule(delayMs: number, task: () => void): () => void
}

export class SystemClock implements RuntimeClock {
  now(): Date {
    return new Date()
  }

  monotonicMs(): number {
    return performance.now()
  }

  schedule(delayMs: number, task: () => void): () => void {
    const handle = setTimeout(task, delayMs)
    handle.unref()
    return () => {
      clearTimeout(handle)
    }
  }
}

export interface ActionExecutionContext {
  executionId: string
  buttonNumber: string
  /**
   * The exact physical gesture. Rotary adapters should use
   * rotationStepForInteraction and stepOrderedListIndex from
   * button-interaction-policy so direction and wrapping stay consistent.
   */
  interaction: ButtonInteraction
  /** Effective row policy; legacy and Press interactions resolve to wrapping. */
  wrap: boolean
  signal: AbortSignal
}

export type AdapterActionResult =
  | { outcome: 'success' }
  | { outcome: 'failure'; errorCode: LegacyActionFailureCode; errorMessage: string }

export interface TypedActionExecutor<TAction> {
  execute(action: TAction, context: ActionExecutionContext): Promise<AdapterActionResult>
}

export class ActionAbortedError extends Error {
  override readonly name = 'ActionAbortedError'

  constructor() {
    super('action execution was aborted')
  }
}
