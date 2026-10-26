import { legacyExecution, managedModule } from '@hubble/module-runtime-helpers/managed'
import type { HubbleModule } from '@hubble/module-sdk'
import { z } from 'zod'
import { actionSchemas, type ActionDefinition } from './actions.js'
import {
  ConnectionDefinitionSchema,
  LiveGradeApplicationSchema,
  LiveGradeSlotPositionSchema,
  type ConnectionDefinition,
} from './config.js'
import { LiveGradeActionExecutor } from './livegrade-action-executor.js'
import { LiveGradeConnectionManager } from './livegrade-connection-manager.js'
import {
  LiveGradeHelperClientError,
  LiveGradeHelperResponseSchema,
} from './livegrade-helper-client.js'

const module: HubbleModule = managedModule<ConnectionDefinition, ActionDefinition>(
  'livegrade',
  (definition, context) => {
    const manager = new LiveGradeConnectionManager({
      createClient: (target) => {
        const invoke = async (method: string, timeoutMs: number, position?: number) => {
          if (!context.requestHost) throw new Error('Native LiveGrade bridge unavailable')
          try {
            return LiveGradeHelperResponseSchema.parse(
              await context.requestHost('livegrade', {
                method,
                generation: target.generation,
                edition: target.edition,
                timeoutMs,
                ...(position === undefined ? {} : { position }),
              }),
            )
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : null
            if (
              code === 'helper_timeout' ||
              code === 'helper_launch_failed' ||
              code === 'helper_failed' ||
              code === 'helper_invalid_response'
            )
              throw new LiveGradeHelperClientError(
                code,
                error instanceof Error ? error.message : 'Native helper failed',
              )
            throw error
          }
        }
        return {
          probe: (timeout) => invoke('probe', timeout),
          requestAccessibilityPermission: (timeout) => invoke('permission', timeout),
          selectSlot: (input) => invoke('select', input.timeoutMs, input.position),
        }
      },
    })
    const executor = new LiveGradeActionExecutor(manager)
    return {
      start: () => {
        manager.reconcile([definition])
      },
      stop: () => {
        manager.stop()
      },
      subscribe: (listener) => manager.subscribe(listener),
      call(method, value, signal) {
        if (signal.aborted) throw new Error('Cancelled before native dispatch')
        if (method === 'requestAccessibilityPermission')
          return manager.requestAccessibilityPermission(definition.connectionId)
        if (method === 'selectSlot') {
          const input = z
            .strictObject({
              application: LiveGradeApplicationSchema.optional(),
              position: LiveGradeSlotPositionSchema.nullable(),
              query: z.string().max(512),
            })
            .parse(value)
          return manager.selectSlot(definition.connectionId, {
            position: input.position,
            query: input.query,
            ...(input.application ? { application: input.application } : {}),
          })
        }
        throw new Error('Unsupported LiveGrade service')
      },
      execute(action, execution) {
        if (action.type !== 'livegrade.select-slot')
          throw new Error('Unsupported LiveGrade action')
        return executor.execute(action, legacyExecution(execution))
      },
    }
  },
  {
    kind: 'state-confirmed',
    summary: 'The native helper observed the selected LiveGrade menu slot',
  },
  { connection: ConnectionDefinitionSchema, actions: actionSchemas },
)

export default module
