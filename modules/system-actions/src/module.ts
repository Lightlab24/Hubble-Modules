import { KeyboardBridgeResponseSchema } from '@hubble/module-contracts/keyboard'
import { legacyExecution } from '@hubble/module-runtime-helpers/legacy'
import type { HubbleModule, ModuleJsonValue } from '@hubble/module-sdk'
import { ActionDefinitionSchema, ConnectionDefinitionsSchema } from './config.js'
import { KeyboardActionExecutor } from './keyboard-action-executor.js'

export default {
  createInstance(context) {
    if (context.scope.kind !== 'host' || context.scope.capabilityId !== 'system-actions')
      throw new Error('System actions require their host capability scope')
    const executor = new KeyboardActionExecutor(
      ConnectionDefinitionsSchema.parse(context.settings.connections ?? []),
      async (request) => {
        if (!context.requestHost) throw new Error('Native bridge is unavailable')
        return KeyboardBridgeResponseSchema.parse(
          await context.requestHost(
            'keyboard',
            JSON.parse(JSON.stringify(request)) as ModuleJsonValue,
          ),
        )
      },
    )
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
        const action = ActionDefinitionSchema.parse({
          ...fields,
          type: id,
          interaction: execution.gesture,
          wrap: execution.wrap,
        })
        if (
          action.type !== 'keyboard.send-shortcut' &&
          action.type !== 'system.activate-application' &&
          action.type !== 'system.open-application' &&
          action.type !== 'system.select-menu-item'
        )
          return {
            status: 'failure',
            category: 'invalid-config',
            message: 'Unsupported system action',
          }
        const result = await executor.execute(action, legacyExecution(execution))
        if (result.outcome === 'failure')
          return {
            status: 'failure',
            category: 'rejected',
            code: result.errorCode,
            message: result.errorMessage,
          }
        execution.log({
          level: 'info',
          stage: 'native-response',
          message: 'Signed native bridge reported the system operation completed',
        })
        return {
          status: 'success',
          evidence: {
            kind: 'response',
            summary: 'Signed native bridge reported the requested operation completed',
          },
        }
      },
      dispose() {},
    }
  },
} satisfies HubbleModule
