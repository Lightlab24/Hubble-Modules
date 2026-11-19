import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createModuleDataPublisher, ModuleDataAssembler } from '../src/observations.js'

type Sent = { channel: string; value: unknown }

function fixture(settle?: Parameters<typeof createModuleDataPublisher>[1]) {
  const sent: Sent[] = []
  const assemblers = new Map<string, ModuleDataAssembler>()
  const publisher = createModuleDataPublisher((channel, chunk) => {
    const assembler = assemblers.get(channel) ?? new ModuleDataAssembler()
    assemblers.set(channel, assembler)
    const assembled = assembler.accept(chunk)
    if (assembled.complete) sent.push({ channel, value: assembled.value })
  }, settle)
  return { publisher, sent }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

it('sends the last value of each channel once per turn when no settle time is given', async () => {
  const { publisher, sent } = fixture()
  publisher.publish('snapshots', { revision: 1 })
  publisher.publish('snapshots', { revision: 2 })
  publisher.publish('primary', ['a'])
  expect(sent).toEqual([])
  await Promise.resolve()
  expect(sent).toEqual([
    { channel: 'snapshots', value: { revision: 2 } },
    { channel: 'primary', value: ['a'] },
  ])
  // The next turn's change is its own send, as it always was.
  publisher.publish('snapshots', { revision: 3 })
  await Promise.resolve()
  expect(sent).toHaveLength(3)
})

it('sends a burst that spans several turns once, when it goes quiet', async () => {
  const { publisher, sent } = fixture({ quietMs: 5, maxWaitMs: 20 })
  publisher.publish('snapshots', { level: 1 })
  publisher.publish('primary', ['first'])
  await Promise.resolve()
  vi.advanceTimersByTime(3)
  publisher.publish('snapshots', { level: 17 })
  publisher.publish('primary', ['last'])
  vi.advanceTimersByTime(4)
  // Three milliseconds, then four: never five in a row without a change.
  expect(sent).toEqual([])
  vi.advanceTimersByTime(1)
  expect(sent).toEqual([
    { channel: 'snapshots', value: { level: 17 } },
    { channel: 'primary', value: ['last'] },
  ])
  // A later change starts a new wait of its own.
  publisher.publish('snapshots', { level: 1 })
  vi.advanceTimersByTime(5)
  expect(sent).toHaveLength(3)
})

it('does not hold a stream of changes back for longer than the limit', () => {
  const { publisher, sent } = fixture({ quietMs: 5, maxWaitMs: 20 })
  for (let elapsed = 0; elapsed < 20; elapsed += 4) {
    publisher.publish('snapshots', { elapsed })
    vi.advanceTimersByTime(4)
  }
  // Changes four milliseconds apart never go quiet; the limit sends what there is.
  expect(sent).toEqual([{ channel: 'snapshots', value: { elapsed: 16 } }])
})

it('sends nothing after it is closed', () => {
  const { publisher, sent } = fixture({ quietMs: 5, maxWaitMs: 20 })
  publisher.publish('snapshots', { revision: 1 })
  publisher.close()
  vi.advanceTimersByTime(50)
  publisher.publish('snapshots', { revision: 2 })
  vi.advanceTimersByTime(50)
  expect(sent).toEqual([])
})
