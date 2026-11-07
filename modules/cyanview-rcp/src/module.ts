import { managedModule } from '@hubble/module-runtime-helpers/managed'
import { withModuleMatrix } from '@hubble/module-runtime-helpers/matrix'
import { matrix, matrixAction, matrixFeedback } from './matrix.js'
import type { HubbleModule } from '@hubble/module-sdk'
import { CyanViewRcpConnectionManager } from '@hubble/protocol-cyanview-rcp'
import { z } from 'zod'
import { legacyActionSchemas, type ActionDefinition } from './actions.js'
import { ConnectionDefinitionSchema, type ConnectionDefinition } from './config.js'

/** This module only switches cameras. These IDs stay declared so rows saved by older versions load. */
const refusedActions = new Set([
  'cyanview-rcp.record-camera',
  'cyanview-rcp.record-group-all',
  'cyanview-rcp.start-enabled-cameras',
  'cyanview-rcp.stop-enabled-cameras',
])
const SWITCHING_ONLY =
  'CyanView RCP only switches cameras. Use the Cyanview module or CCC to record. No recording command was sent.'

export function createCyanViewRcpModule(
  createManager: () => Pick<
    CyanViewRcpConnectionManager,
    'reconcile' | 'stop' | 'subscribe' | 'selectCamera'
  > = () => new CyanViewRcpConnectionManager(),
): HubbleModule {
  const module: HubbleModule = {
    createInstance(context) {
      if (context.scope.kind !== 'connection' || !context.modules)
        throw new Error('CyanView RCP requires a connection and module exchange')
      const connectionId = context.scope.connectionId
      const modules = context.modules
      const definition = ConnectionDefinitionSchema.parse({
        ...context.settings,
        name: context.settings.name ?? 'CyanView RCP',
        type: 'cyanview-rcp',
        connectionId,
        enabled: true,
        schemaVersion: 1,
      })
      const selection = managedModule<ConnectionDefinition, ActionDefinition>(
        'cyanview-rcp',
        () => {
          const manager = createManager()
          return {
            start: () => manager.reconcile([definition]),
            stop: () => manager.stop(),
            subscribe: (listener) => manager.subscribe(listener),
            async call(method, value, signal) {
              if (method !== 'selectCamera') throw new Error('Unsupported selection service')
              await manager.selectCamera(connectionId, z.int().positive().parse(value), signal)
            },
            async execute(action, execution) {
              if (action.type !== 'cyanview-rcp.select-camera')
                throw new Error(SWITCHING_ONLY)
              await manager.selectCamera(connectionId, action.cameraNumber, execution.signal)
              return { outcome: 'success' as const }
            },
          }
        },
        { kind: 'response', summary: 'RCP acknowledged camera selection' },
        { connection: ConnectionDefinitionSchema, actions: legacyActionSchemas },
      ).createInstance(context)
      return {
        async start() {
          await selection.start()
          await modules.publish('connection', 1, JSON.parse(JSON.stringify(definition)))
        },
        queryData(query) {
          if (query.id !== 'connection' || query.version !== 1)
            throw new Error('Unknown RCP data query')
          return JSON.parse(JSON.stringify(definition))
        },
        async execute(id, fields, execution) {
          if (!refusedActions.has(id)) return selection.execute(id, fields, execution)
          execution.log({ level: 'error', stage: 'not-supported', message: SWITCHING_ONLY })
          return { status: 'failure', category: 'rejected', message: SWITCHING_ONLY }
        },
        async call(method, value, execution) {
          return (await selection.call?.(method, value, execution)) ?? null
        },
        async dispose() {
          await selection.dispose()
        },
      }
    },
  }
  return withModuleMatrix(module, matrix, matrixAction, matrixFeedback, ['driver.snapshots'])
}
export default createCyanViewRcpModule()
