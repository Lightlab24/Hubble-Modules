import type { MockActionDefinition } from './config.js'

import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type RuntimeClock,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'

export class MockActionExecutor implements TypedActionExecutor<MockActionDefinition> {
  constructor(private readonly clock: RuntimeClock) {}

  execute(
    action: MockActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) {
      return Promise.reject(new ActionAbortedError())
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let cancelSchedule = (): void => undefined

      const cleanup = (): void => {
        cancelSchedule()
        context.signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(new ActionAbortedError())
      }

      context.signal.addEventListener('abort', onAbort, { once: true })
      cancelSchedule = this.clock.schedule(action.delayMs, () => {
        if (settled) {
          return
        }
        settled = true
        cleanup()

        if (action.outcome === 'success') {
          resolve({ outcome: 'success' })
        } else {
          resolve({
            outcome: 'failure',
            errorCode: 'mock_failure',
            errorMessage: action.failureMessage ?? 'Mock action failed',
          })
        }
      })

      if (context.signal.aborted) {
        onAbort()
      }
    })
  }
}
