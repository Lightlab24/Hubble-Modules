import { expect, it, vi } from 'vitest'
import type { ModuleContext, ModuleSavedActions } from '@hubble/module-sdk'
import module from '../src/index.js'

it('changes row limits and colour decisions through module declarations without host calls', async () => {
  const context: ModuleContext = {
    instanceId: 'example',
    scope: {
      kind: 'connection',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
    },
    settings: {},
    publishState: vi.fn(),
    publishFeedback: vi.fn(),
    log: vi.fn(),
    requestHost: vi.fn(),
  }
  const instance = module.createInstance(context)
  const execution = {
    executionId: 'example',
    signal: new AbortController().signal,
    gesture: 'press' as const,
    wrap: false,
    log() {},
  }
  const values = { actionType: 'count', 'module.value': 75, 'module.colors': '#123456 | #654321' }
  expect(await instance.execute('apply', { values }, execution)).toMatchObject({
    status: 'failure',
    category: 'invalid-config',
  })
  expect(context.publishState).not.toHaveBeenCalled()
  expect(
    await instance.execute('apply', { values: { ...values, actionType: 'percent' } }, execution),
  ).toMatchObject({ status: 'success' })
  instance.subscribeFeedback([
    { id: 'level', fields: { values: { ...values, actionType: 'percent' } } },
  ])
  expect(context.publishFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'active', appearance: { backgroundColor: '#654321' } }),
  )
  expect(context.requestHost).not.toHaveBeenCalled()
})

it('adds a source default while retaining formulas and unknown saved fields', () => {
  const items: ModuleSavedActions = [
    {
      key: 'stable-row',
      actionId: { mode: 'literal', source: 'apply' },
      actionFields: { mode: 'literal', source: '{}' },
      feedback: { mode: 'literal', source: '' },
      matrix: {
        id: 'counter',
        fields: {
          'module.value': { mode: 'formula', source: '=A2' },
          'module.old': { mode: 'literal', source: 'retained' },
        },
      },
    },
  ]
  const migrated = module.migrateSavedActions(items, 1, 2)
  expect(migrated[0]?.matrix?.fields).toEqual({
    ...items[0]?.matrix?.fields,
    'module.colors': { mode: 'literal', source: '#333333 | #16A34A' },
  })
  expect(items[0]?.matrix?.fields['module.colors']).toBeUndefined()
})
