import { ActionAbortedError } from '@hubble/module-contracts/execution'
import { randomUUID } from 'node:crypto'
import { withModuleMatrix } from '@hubble/module-runtime-helpers/matrix'
import { choicePage } from '@hubble/module-runtime-helpers/choices'
import { matrix, matrixAction, matrixFeedback } from './matrix.js'
import { legacyExecution, legacyResult } from '@hubble/module-runtime-helpers/legacy'
import type { HubbleModule, ModuleState } from '@hubble/module-sdk'
import {
  DitBrowseConnectionDefinitionSchema,
  DitBrowseCycleWorkspacesActionDefinitionSchema,
  DitBrowseFocusCameraActionDefinitionSchema,
  DitBrowseSetGridLockActionDefinitionSchema,
  DitBrowseShowGridActionDefinitionSchema,
  DitBrowseSwitchWorkspaceActionDefinitionSchema,
  DitBrowseToggleGridLockActionDefinitionSchema,
} from './config.js'
import { DitBrowseActionExecutor } from './dit-browse-action-executor.js'
import { DitBrowseConnectionManager } from './dit-browse-connection-manager.js'

const schemas = {
  'dit-browse.focus-camera': DitBrowseFocusCameraActionDefinitionSchema,
  'dit-browse.switch-workspace': DitBrowseSwitchWorkspaceActionDefinitionSchema,
  'dit-browse.show-grid': DitBrowseShowGridActionDefinitionSchema,
  'dit-browse.cycle-workspaces': DitBrowseCycleWorkspacesActionDefinitionSchema,
  'dit-browse.set-grid-lock': DitBrowseSetGridLockActionDefinitionSchema,
  'dit-browse.toggle-grid-lock': DitBrowseToggleGridLockActionDefinitionSchema,
} as const

export function createDitBrowseModule(
  createManager = () => new DitBrowseConnectionManager(),
): HubbleModule {
  const module = {
    createInstance(context) {
      if (context.scope.kind !== 'connection')
        throw new Error('DIT Browse requires a connection scope')
      const definition = DitBrowseConnectionDefinitionSchema.parse({
        ...context.settings,
        connectionId: context.scope.connectionId,
        type: 'dit-browse',
        name: context.settings.name ?? 'DIT Browse',
        enabled: true,
        schemaVersion: 1,
      })
      const manager = createManager()
      const executor = new DitBrowseActionExecutor(manager)
      let unsubscribe = () => {}
      let started = false
      let lastPhase = ''
      return {
        start() {
          started = true
          unsubscribe = manager.subscribe((snapshots) => {
            const snapshot = snapshots[0]?.connection
            if (!snapshot || !started) return
            const phase = snapshot.connected
              ? 'ready'
              : snapshot.phase === 'disconnected'
                ? 'unavailable'
                : 'connecting'
            const observedAt = new Date().toISOString()
            context.publishState({
              phase,
              message: snapshot.connected ? null : 'Waiting for DIT Browse',
              observedAt,
              values: {
                legacySnapshot: JSON.parse(JSON.stringify(snapshot)) as ModuleState['values'],
              },
            })
            if (snapshot.phase !== lastPhase) {
              lastPhase = snapshot.phase
              context.log({
                level: 'info',
                stage: 'connection-state',
                message: `Observed DIT Browse connection phase: ${lastPhase}`,
              })
            }
            context.publishFeedback({
              id: 'grid-locked',
              state:
                !snapshot.connected || snapshot.status === null
                  ? 'unavailable'
                  : snapshot.status.expansionEnabled
                    ? 'inactive'
                    : 'active',
              observedAt: snapshot.connected && snapshot.status ? observedAt : null,
            })
          })
          manager.reconcile([definition])
        },
        async execute(id, fields, execution) {
          if (!started)
            return {
              status: 'failure',
              category: 'unavailable',
              message: 'DIT Browse module is stopped',
            }
          const schema = Object.hasOwn(schemas, id)
            ? schemas[id as keyof typeof schemas]
            : undefined
          if (!schema)
            return {
              status: 'failure',
              category: 'invalid-config',
              message: 'Unknown DIT Browse action',
            }
          const action = schema.safeParse({
            actionId: randomUUID(),
            actionColumnId: randomUUID(),
            enabled: true,
            ...fields,
            type: id,
            connectionId: definition.connectionId,
            interaction: execution.gesture,
            wrap: execution.wrap,
          })
          if (!action.success)
            return {
              status: 'failure',
              category: 'invalid-config',
              message: 'Invalid DIT Browse action configuration',
            }
          execution.log({
            level: 'debug',
            stage: 'dispatch',
            message: 'Validated action passed to DIT Browse client',
          })
          try {
            const result = legacyResult(
              await executor.execute(action.data, legacyExecution(execution)),
              'state-confirmed',
            )
            if (execution.signal.aborted)
              return {
                status: 'failure',
                category: 'cancelled',
                message: 'DIT Browse action cancelled; dispatched work is not replayed',
              }
            execution.log({
              level: result.status === 'success' ? 'info' : 'error',
              stage: result.status === 'success' ? 'state-confirmed' : 'command-failed',
              message: result.status === 'success' ? result.evidence.summary : result.message,
            })
            return result
          } catch (error) {
            if (error instanceof ActionAbortedError)
              return {
                status: 'failure',
                category: 'cancelled',
                message: 'DIT Browse action cancelled before dispatch',
              }
            return {
              status: 'failure',
              category: 'internal',
              message: 'DIT Browse action failed unexpectedly',
            }
          }
        },
        discoverChoices(query) {
          const snapshot = manager.snapshots()[0]?.connection
          if (query.provider !== 'matrix-values')
            throw new Error('Unknown DIT Browse choice provider')
          const choices =
            query.draft.actionType === 'set-grid-lock'
              ? [
                  { id: 'TRUE', label: 'Lock grid' },
                  { id: 'FALSE', label: 'Unlock grid' },
                ]
              : !snapshot?.connected
                ? []
                : query.draft.actionType === 'focus-camera'
                  ? snapshot.catalog.map((camera) => ({
                      id: String(camera.cameraNumber),
                      label: `${camera.cameraNumber}: ${camera.title}`.slice(0, 160),
                    }))
                  : query.draft.actionType === 'switch-workspace'
                    ? (snapshot.status?.workspaceNumbers ?? []).map((number) => ({
                        id: String(number),
                        label: `Workspace ${number}`,
                      }))
                    : []
          return choicePage(query, choices)
        },
        choices(provider) {
          const snapshot = manager.snapshots()[0]?.connection
          if (!snapshot?.connected) return []
          if (provider === 'cameras')
            return snapshot.catalog.map((camera) => ({
              id: String(camera.cameraNumber),
              label: `${String(camera.cameraNumber)}: ${camera.title}`,
            }))
          if (provider === 'workspaces')
            return (snapshot.status?.workspaceNumbers ?? []).map((number) => ({
              id: String(number),
              label: `Workspace ${String(number)}`,
            }))
          return []
        },
        dispose() {
          started = false
          unsubscribe()
          manager.stop()
        },
      }
    },
  } satisfies HubbleModule
  return withModuleMatrix(module, matrix, matrixAction, matrixFeedback)
}
export default createDitBrowseModule()
