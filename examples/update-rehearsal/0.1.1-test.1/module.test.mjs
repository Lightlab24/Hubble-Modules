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

test('patch adds toggle while preserving set-state and cancellation',async()=>{const observations=[];const instance=module.createInstance({settings:{initialState:false},publishState(){},publishFeedback:f=>observations.push(f),log(){}});const execution={executionId:'patch',signal:new AbortController().signal,gesture:'press',log(){}};try{await instance.start();assert.equal((await instance.execute('toggle-state',{},execution)).status,'success');assert.equal(observations.at(-1).state,'active');assert.equal((await instance.execute('toggle-state',{}, {...execution,signal:AbortSignal.abort()})).category,'cancelled');assert.equal(observations.at(-1).state,'active');assert.equal((await instance.execute('set-state',{active:false},execution)).status,'success');assert.equal(observations.at(-1).state,'inactive')}finally{await instance.dispose()}})
