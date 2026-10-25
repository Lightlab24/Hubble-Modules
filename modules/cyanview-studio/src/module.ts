import { legacyExecution, managedModule } from '@hubble/module-runtime-helpers/managed'
import type { HubbleModule } from '@hubble/module-sdk'
import { z } from 'zod'
import { actionSchemas, type ActionDefinition } from './actions.js'
import { ConnectionDefinitionSchema, type ConnectionDefinition } from './config.js'
import { CyanViewStudioActionExecutor } from './cyanview-studio-action-executor.js'
import { CyanViewStudioConnectionManager } from './cyanview-studio-connection-manager.js'

const module: HubbleModule = managedModule<ConnectionDefinition, ActionDefinition>(
  'cyanview-studio',
  (definition) => {
    const manager = new CyanViewStudioConnectionManager()
    const executor = new CyanViewStudioActionExecutor(manager)
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
        if (method === 'selectFeed')
          return manager.selectFeed(
            definition.connectionId,
            z.string().min(1).max(64).parse(value),
          )
        if (method === 'selectFeedByNumber')
          return manager.selectFeedByNumber(
            definition.connectionId,
            z.int().min(1).parse(value),
          )
        if (method === 'selectFeedByFeedId')
          return manager.selectFeedByFeedId(definition.connectionId, z.int().parse(value))
        throw new Error('Unsupported module service')
      },
      execute: (action, execution) => {
        if (
          action.type !== 'cyanview-studio.select-feed' &&
          action.type !== 'cyanview-studio.select-feed-id' &&
          action.type !== 'cyanview-studio.select-feed-number'
        )
          throw new Error('Unsupported CyanView Studio action')
        return executor.execute(action, legacyExecution(execution))
      },
    }
  },
  { kind: 'response', summary: 'CyanView Studio returned a successful command response' },
  { connection: ConnectionDefinitionSchema, actions: actionSchemas },
)

export default module
