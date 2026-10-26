import assert from 'node:assert/strict'
import { test } from 'node:test'
import module from './module.mjs'

test('instances are independent, cancellation has no effect, and disposal is repeatable', async () => {
  const firstFeedback = []
  const secondFeedback = []
  const first = module.createInstance({
    instanceId: 'first',
    settings: { initialState: false },
    publishState: () => {},
    publishFeedback: (value) => firstFeedback.push(value),
    log() {},
  })
  const second = module.createInstance({
    instanceId: 'second',
    settings: { initialState: false },
    publishState: () => {},
    publishFeedback: (value) => secondFeedback.push(value),
    log() {},
  })
  const execution = {
    executionId: 'test',
    signal: new AbortController().signal,
    gesture: 'press',
    log() {},
  }
  try {
    await first.start()
    await second.start()
    assert.equal((await first.execute('set-state', { active: true }, execution)).status, 'success')
    assert.equal(firstFeedback.at(-1).state, 'active')
    assert.equal(secondFeedback.at(-1).state, 'inactive')
    const cancelled = { ...execution, signal: AbortSignal.abort() }
    assert.equal(
      (await first.execute('set-state', { active: false }, cancelled)).category,
      'cancelled',
    )
    assert.equal(firstFeedback.at(-1).state, 'active')
    await first.dispose()
    await first.dispose()
    assert.equal(firstFeedback.at(-1).state, 'unavailable')
    assert.equal(
      (await first.execute('set-state', { active: false }, execution)).category,
      'unavailable',
    )
  } finally {
    await first.dispose()
    await second.dispose()
  }
})
