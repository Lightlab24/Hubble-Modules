import type { RuntimeClock } from './execution.js'

interface ScheduledTask {
  dueAt: number
  order: number
  task: () => void
  cancelled: boolean
}

export class FakeClock implements RuntimeClock {
  readonly #epochMs: number
  readonly #tasks: ScheduledTask[] = []
  #elapsedMs = 0
  #nextOrder = 0

  constructor(start: Date) {
    this.#epochMs = start.getTime()
  }

  now(): Date {
    return new Date(this.#epochMs + this.#elapsedMs)
  }

  monotonicMs(): number {
    return this.#elapsedMs
  }

  schedule(delayMs: number, task: () => void): () => void {
    const scheduled: ScheduledTask = {
      dueAt: this.#elapsedMs + delayMs,
      order: this.#nextOrder,
      task,
      cancelled: false,
    }
    this.#nextOrder += 1
    this.#tasks.push(scheduled)

    return () => {
      scheduled.cancelled = true
    }
  }

  advanceBy(delayMs: number): void {
    const target = this.#elapsedMs + delayMs

    for (;;) {
      const next = this.#tasks
        .filter((task) => !task.cancelled && task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0]
      if (next === undefined) {
        break
      }

      next.cancelled = true
      this.#elapsedMs = next.dueAt
      next.task()
    }

    this.#elapsedMs = target
  }

  pendingTaskCount(): number {
    return this.#tasks.filter((task) => !task.cancelled).length
  }
}
