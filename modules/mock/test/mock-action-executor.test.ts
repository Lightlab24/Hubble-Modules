import { describe, expect, it } from 'vitest'
import { ButtonIdentifierSchema } from '../src/config.js'

import { ActionAbortedError } from '@hubble/module-contracts/execution'
import { FakeClock } from '@hubble/module-contracts/testing'
import { MockActionExecutor } from '../src/mock-action-executor.js'

const EXECUTION_ID = '00000000-0000-4000-8000-000000000020'

describe('MockActionExecutor', () => {
  it('returns success only after the declared delay', async () => {
    const clock = new FakeClock(new Date('2026-07-14T12:00:00.000Z'))
    const executor = new MockActionExecutor(clock)
    let settled = false
    const resultPromise = executor
      .execute(
        {
          actionId: 'ok',
          interaction: 'press',
          type: 'mock',
          enabled: true,
          delayMs: 40,
          outcome: 'success',
        },
        {
          executionId: EXECUTION_ID,
          buttonNumber: ButtonIdentifierSchema.parse('1'),
          interaction: 'press',
          wrap: true,
          signal: new AbortController().signal,
        },
      )
      .finally(() => {
        settled = true
      })

    clock.advanceBy(39)
    await Promise.resolve()
    expect(settled).toBe(false)

    clock.advanceBy(1)
    await expect(resultPromise).resolves.toEqual({ outcome: 'success' })
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('returns the declared mock failure after its delay', async () => {
    const clock = new FakeClock(new Date('2026-07-14T12:00:00.000Z'))
    const executor = new MockActionExecutor(clock)
    const resultPromise = executor.execute(
      {
        actionId: 'bad',
        interaction: 'press',
        type: 'mock',
        enabled: true,
        delayMs: 80,
        outcome: 'failure',
        failureMessage: 'Simulated failure',
      },
      {
        executionId: EXECUTION_ID,
        buttonNumber: ButtonIdentifierSchema.parse('2'),
        interaction: 'press',
        wrap: true,
        signal: new AbortController().signal,
      },
    )

    clock.advanceBy(80)
    await expect(resultPromise).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'mock_failure',
      errorMessage: 'Simulated failure',
    })
  })

  it('rejects an abort immediately and removes its scheduled callback', async () => {
    const clock = new FakeClock(new Date('2026-07-14T12:00:00.000Z'))
    const executor = new MockActionExecutor(clock)
    const controller = new AbortController()
    const resultPromise = executor.execute(
      {
        actionId: 'slow',
        interaction: 'press',
        type: 'mock',
        enabled: true,
        delayMs: 1_000,
        outcome: 'success',
      },
      {
        executionId: EXECUTION_ID,
        buttonNumber: ButtonIdentifierSchema.parse('1'),
        interaction: 'press',
        wrap: true,
        signal: controller.signal,
      },
    )

    expect(clock.pendingTaskCount()).toBe(1)
    controller.abort()

    await expect(resultPromise).rejects.toBeInstanceOf(ActionAbortedError)
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('rejects a signal that was already aborted without scheduling', async () => {
    const clock = new FakeClock(new Date('2026-07-14T12:00:00.000Z'))
    const executor = new MockActionExecutor(clock)
    const controller = new AbortController()
    controller.abort()

    await expect(
      executor.execute(
        {
          actionId: 'never-started',
          interaction: 'press',
          type: 'mock',
          enabled: true,
          delayMs: 1_000,
          outcome: 'success',
        },
        {
          executionId: EXECUTION_ID,
          buttonNumber: ButtonIdentifierSchema.parse('1'),
          interaction: 'press',
          wrap: true,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeInstanceOf(ActionAbortedError)
    expect(clock.pendingTaskCount()).toBe(0)
  })
})
