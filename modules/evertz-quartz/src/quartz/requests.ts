import type { Socket } from 'node:net'
import type { QuartzMessage } from './codec.js'
import type { PendingRequest } from './models.js'

export interface QuartzTransportContext {
  readonly epoch: number
  readonly socket: Socket | null
  readonly disconnected: boolean
  readonly requestTimeoutMs: number
  close(error: Error): void
}

/** Serializes commands because Quartz replies carry no request identity. */
export class QuartzRequestQueue {
  #pending: PendingRequest | null = null
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly context: QuartzTransportContext) {}
  get pendingCommand(): string | null {
    return this.#pending?.command ?? null
  }
  request(
    command: string,
    accept: (message: QuartzMessage) => boolean,
    signal?: AbortSignal,
    options: { retryEveryMs?: number; timeoutMs?: number; ignoreErrors?: boolean } = {},
  ): Promise<void> {
    const epoch = this.context.epoch
    const result = this.#tail.then(() => {
      if (epoch !== this.context.epoch)
        throw new Error('Quartz connection changed during the operation')
      if (signal?.aborted) throw new Error('Quartz command cancelled before dispatch')
      const socket = this.context.socket
      if (socket === null || socket.destroyed || this.context.disconnected)
        throw new Error('Quartz is disconnected')
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // There are no request IDs. A timed-out reply must never satisfy a later command.
          this.context.close(new Error(`Quartz request timed out: ${command.trim()}`))
        }, options.timeoutMs ?? this.context.requestTimeoutMs)
        const write = () => {
          if (epoch !== this.context.epoch) return
          socket.write(command, 'ascii', (error) => {
            if (error != null && epoch === this.context.epoch) this.context.close(error)
          })
        }
        const retryTimer =
          options.retryEveryMs === undefined ? null : setInterval(write, options.retryEveryMs)
        retryTimer?.unref()
        this.#pending = {
          command,
          accept,
          resolve,
          reject,
          timer,
          retryTimer,
          ignoreErrors: options.ignoreErrors ?? false,
        }
        write()
      })
    })
    this.#tail = result.catch(() => undefined)
    return result
  }
  private clearPending(): void {
    if (this.#pending === null) return
    clearTimeout(this.#pending.timer)
    if (this.#pending.retryTimer !== null) clearInterval(this.#pending.retryTimer)
    this.#pending = null
  }
  receive(message: QuartzMessage, error?: Error): void {
    const pending = this.#pending
    if (pending === null) return
    if (error !== undefined) {
      if (!pending.ignoreErrors) {
        this.clearPending()
        pending.reject(error)
      }
    } else if (pending.accept(message)) {
      this.clearPending()
      pending.resolve()
    }
  }
  close(error: Error): void {
    if (this.#pending !== null) {
      const pending = this.#pending
      this.clearPending()
      pending.reject(error)
    }
  }
}
