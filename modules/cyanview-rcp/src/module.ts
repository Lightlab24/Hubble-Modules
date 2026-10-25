import { legacyExecution, managedModule } from '@hubble/module-runtime-helpers/managed'
import type { HubbleModule } from '@hubble/module-sdk'
import { CyanViewRcpConnectionManager } from '@hubble/protocol-cyanview-rcp'
import { z } from 'zod'
import { actionSchemas, type ActionDefinition } from './actions.js'
import { ConnectionDefinitionSchema, type ConnectionDefinition } from './config.js'
import { CyanViewRcpActionExecutor } from './cyanview-rcp-action-executor.js'

const module: HubbleModule = managedModule<ConnectionDefinition, ActionDefinition>(
  'cyanview-rcp',
  (definition) => {
    const manager = new CyanViewRcpConnectionManager()
    const executor = new CyanViewRcpActionExecutor(manager)
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
        if (method === 'selectCamera')
          return manager.selectCamera(
            definition.connectionId,
            z.int().positive().parse(value),
            signal,
          )
        if (method === 'recordCamera')
          return manager.recordCamera(
            definition.connectionId,
            z.int().positive().parse(value),
            signal,
          )
        if (method === 'recordGroupAll')
          return manager.recordGroupAll(definition.connectionId, signal)
        throw new Error('Unsupported module service')
      },
      execute: (action, execution) => {
        if (
          action.type !== 'cyanview-rcp.select-camera' &&
          action.type !== 'cyanview-rcp.record-camera' &&
          action.type !== 'cyanview-rcp.record-group-all'
        )
          throw new Error('Unsupported CyanView RCP action')
        return executor.execute(action, legacyExecution(execution))
      },
    }
  },
  {
    kind: 'response',
    summary: 'RCP command completed at its existing protocol acknowledgement boundary',
  },
  { connection: ConnectionDefinitionSchema, actions: actionSchemas },
)

export default module
