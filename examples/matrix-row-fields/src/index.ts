import {
  parseModuleMatrixValue,
  resolveModuleMatrixField,
  type HubbleModule,
  type ModuleValues,
} from '@hubble/module-sdk'
import { matrix } from './manifest.js'

function row(fields: ModuleValues) {
  if (!fields.values || typeof fields.values !== 'object' || Array.isArray(fields.values))
    throw new Error('Missing row values')
  const values = fields.values
  return Object.fromEntries(
    matrix.fields.map((field) => [
      field.id,
      parseModuleMatrixValue(resolveModuleMatrixField(field, values), values[field.id]),
    ]),
  )
}

export default {
  migrateSavedActions(items, from, to) {
    if (from !== 1 || to !== 2) throw new Error('Unsupported saved-action version')
    return items.map((item) =>
      !item.matrix
        ? item
        : {
            ...item,
            matrix: {
              ...item.matrix,
              fields: {
                'module.colors': { mode: 'literal', source: '#333333 | #16A34A' },
                ...item.matrix.fields,
              },
            },
          },
    )
  },
  createInstance(context) {
    return {
      start() {},
      dispose() {},
      execute(id, fields, execution) {
        if (execution.signal.aborted)
          return { status: 'failure', category: 'cancelled', message: 'Cancelled' }
        if (id !== matrix.actionId)
          return { status: 'failure', category: 'invalid-config', message: 'Unknown action' }
        try {
          const values = row(fields)
          context.publishState({
            phase: 'ready',
            message: null,
            observedAt: new Date().toISOString(),
            values: { applied: values['module.value']! },
          })
          return { status: 'success', evidence: { kind: 'local', summary: 'Local value recorded' } }
        } catch {
          return {
            status: 'failure',
            category: 'invalid-config',
            message: 'Correct the row value before applying',
          }
        }
      },
      subscribeFeedback(subscriptions) {
        for (const subscription of subscriptions) {
          if (subscription.id !== matrix.feedbackId) continue
          try {
            const values = row(subscription.fields)
            const active =
              Number(values['module.value']) >= (values.actionType === 'percent' ? 50 : 4)
            const colors = String(values['module.colors'])
              .split('|')
              .map((value) => value.trim())
            context.publishFeedback({
              ...subscription,
              state: active ? 'active' : 'inactive',
              observedAt: new Date().toISOString(),
              appearance: {
                backgroundColor: active ? colors.at(-1)! : colors.length === 2 ? colors[0]! : null,
              },
            })
          } catch {
            context.publishFeedback({
              ...subscription,
              state: 'unavailable',
              observedAt: null,
              appearance: { backgroundColor: null },
            })
          }
        }
      },
    }
  },
} satisfies HubbleModule
