import { legacyExecution, managedModule } from '@hubble/module-runtime-helpers/managed'
import type { HubbleModule } from '@hubble/module-sdk'
import { z } from 'zod'
import { actionSchemas, type ActionDefinition } from './actions.js'
import { ConnectionDefinitionSchema, type ConnectionDefinition } from './config.js'
import { LightEncodeActionExecutor } from './lightencode-action-executor.js'
import { LightEncodeConnectionManager } from './lightencode-connection-manager.js'

export function createLightEncodeModule(
  createManager = () => new LightEncodeConnectionManager(),
): HubbleModule {
  return managedModule<ConnectionDefinition, ActionDefinition>(
    'lightencode',
    (definition) => {
      const manager = createManager()
      const executor = new LightEncodeActionExecutor(manager)
      return {
        start: () => {
          manager.reconcile([definition])
        },
        stop: () => {
          manager.stop()
        },
        subscribe: (listener) => manager.subscribe(listener),
        call(method, value, signal) {
          if (signal.aborted) throw new Error('Cancelled before dispatch')
          if (method === 'toggleAll') return manager.toggleAll(definition.connectionId)
          if (method === 'toggleSlot')
            return manager.toggleSlot(
              definition.connectionId,
              z.int().min(1).max(999).parse(value),
            )
          if (method === 'toggleTimer') return manager.toggleTimer(definition.connectionId)
          if (method === 'setTimerMinutes')
            return manager.setTimerMinutes(
              definition.connectionId,
              z.int().min(0).max(1440).parse(value),
            )
          throw new Error('Unsupported module service')
        },
        execute: (action, execution) => {
          if (
            action.type !== 'lightencode.record-toggle-all' &&
            action.type !== 'lightencode.record-toggle-slot' &&
            action.type !== 'lightencode.timer-toggle' &&
            action.type !== 'lightencode.timer-set-minutes'
          )
            throw new Error('Unsupported Light Encode action')
          return executor.execute(action, legacyExecution(execution))
        },
      }
    },
    { kind: 'state-confirmed', summary: 'Light Encode confirmed the requested state' },
    { connection: ConnectionDefinitionSchema, actions: actionSchemas },
  )
}
const module: HubbleModule = createLightEncodeModule()
export default module
