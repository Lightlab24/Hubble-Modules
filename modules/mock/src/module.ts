import { SystemClock } from '@hubble/module-contracts/execution'
import { legacyExecution } from '@hubble/module-runtime-helpers/legacy'
import type { HubbleModule } from '@hubble/module-sdk'
import { MockActionDefinitionSchema } from './config.js'
import { MockActionExecutor } from './mock-action-executor.js'

export default {
  createInstance(context) {
    if (context.scope.kind !== 'host' || context.scope.capabilityId !== 'mock')
      throw new Error('Mock requires its host capability scope')
    const executor = new MockActionExecutor(new SystemClock())
    return {
      start() {
        context.publishState({
          phase: 'ready',
          message: null,
          observedAt: new Date().toISOString(),
          values: {},
        })
      },
      async execute(id, fields, execution) {
        const action = MockActionDefinitionSchema.parse({
          ...fields,
          type: id,
          interaction: execution.gesture,
          wrap: execution.wrap,
        })
        const result = await executor.execute(action, legacyExecution(execution))
        if (result.outcome === 'failure')
          return {
            status: 'failure',
            category: 'rejected',
            code: result.errorCode,
            message: result.errorMessage,
          }
        return {
          status: 'success',
          evidence: { kind: 'local', summary: 'Local simulated action completed' },
        }
      },
      dispose() {},
    }
  },
} satisfies HubbleModule
