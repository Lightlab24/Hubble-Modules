/**
 * Shared pieces of the simulated routers. A simulated router lives inside the
 * worker: it answers the same client calls as a real one and emits the same
 * events, so routing, tally and confirmed-route watches behave as with gear,
 * and nothing goes on the network.
 */

/** A write takes about as long as a quick router on a local network. */
export const SIMULATED_ROUTER_LATENCY_MS = 4

/** Videohub and KUMO find their size on the device; a blank setting gets these. */
export const SIMULATED_VIDEOHUB_SIZE = 40
export const SIMULATED_KUMO_SIZE = 32

export interface SimulatedRouterOptions {
  /** How long each write and read takes, in milliseconds. Tests use 0. */
  readonly latencyMs?: number
}

export function simulatedLatency(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** A fresh router routes each output from the input with the same number. */
export function initialSource(destination: number, sourceCount: number): number {
  return ((destination - 1) % sourceCount) + 1
}

export function assertAddress(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${String(maximum)}`)
  }
}

/** Runs one command at a time, in order, like a router's own command queue. */
export class SimulatedCommandQueue {
  #tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(operation)
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
}
