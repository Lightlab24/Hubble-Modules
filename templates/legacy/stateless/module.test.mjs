import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestModule } from './module.mjs'
test('observes a response without claiming device confirmation, and propagates cancellation', async () => {
  const signal = new AbortController().signal
  const observations = []
  const instance = createRequestModule(async (url, options) => {
    assert.equal(url.href, 'http://127.0.0.1:9999/status')
    assert.equal(options.signal, signal)
    return new Response(null, { status: 204 })
  }).createInstance({
    settings: { baseUrl: 'http://127.0.0.1:9999' },
    publishState: (value) => observations.push(value),
  })
  instance.start()
  const result = await instance.execute(
    'get-status',
    {},
    { signal, log: (value) => observations.push(value) },
  )
  assert.equal(result.status, 'success')
  assert.equal(result.evidence.kind, 'response')
  assert.ok(observations.some((value) => value.stage === 'response-observed'))
  instance.dispose()
  assert.equal((await instance.execute('get-status', {}, { signal })).category, 'unavailable')
})
