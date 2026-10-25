import { managedModule } from '@hubble/module-runtime-helpers/managed'
import type { HubbleModule } from '@hubble/module-sdk'
import { actionSchemas, type ActionDefinition } from './actions.js'
import { ConnectionDefinitionSchema, type ConnectionDefinition } from './config.js'
import { TslReceiver } from './receiver.js'

const module: HubbleModule = managedModule<ConnectionDefinition, ActionDefinition>(
  'tsl',
  (definition, context) => {
    if (definition.type !== 'tsl') throw new Error('Invalid TSL connection')
    let listener: (snapshots: readonly unknown[]) => void = () => {}
    const receiver = new TslReceiver(definition, () => {
      emit()
    })
    const emit = () => {
      const state = receiver.snapshot()
      listener([{ definition, phase: state.phase, lastError: state.error, state }])
    }
    return {
      start: () => receiver.start(),
      stop: () => receiver.stop(),
      subscribe: (callback) => {
        listener = callback
        emit()
        return () => {
          listener = () => {}
        }
      },
      async execute(action) {
        if (!context.requestHost) throw new Error('Host tally controls unavailable')
        if (action.type === 'tsl.tally-feedback') return { outcome: 'success' }
        try {
          if (action.type === 'tsl.tally-switch')
            await context.requestHost('tsl', {
              method:
                action.followMode === 'toggle' ? 'toggle-tally-follow' : 'set-tally-follow',
              enabled: action.followMode === 'follow',
            })
          else if (action.type === 'tsl.follow')
            await context.requestHost('tsl', {
              method:
                action.followMode === 'toggle' ? 'toggle-column-follow' : 'set-column-follow',
              columnId: action.actionColumnId,
              enabled: action.followMode === 'follow',
            })
          else if (action.type === 'tsl.set-indication')
            await context.requestHost('tsl', {
              method: 'set-indication',
              columnId: action.targetColumnId,
              enabled: action.indication,
            })
          else throw new Error('Unsupported TSL action')
          return { outcome: 'success' }
        } catch {
          return {
            outcome: 'failure',
            errorCode: 'action_exception',
            errorMessage:
              action.type === 'tsl.tally-switch'
                ? 'TALLY Switch follow state could not be saved'
                : action.type === 'tsl.follow'
                  ? 'Button tally follow state could not be saved'
                  : 'TSL indication could not be saved; check the target feedback column',
          }
        }
      },
    }
  },
  { kind: 'local', summary: 'Host confirmed the requested tally control state was saved' },
  { connection: ConnectionDefinitionSchema, actions: actionSchemas },
)

export default module
