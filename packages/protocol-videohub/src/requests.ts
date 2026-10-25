import { errorMessage } from './client-values.js'
import {
  VideohubError,
  type VideohubCrosspoint,
  type VideohubProtocolMessage,
} from './protocol.js'

interface PendingAcknowledgement {
  readonly epoch: number
  readonly resolve: () => void
  readonly reject: (error: VideohubError) => void
  readonly timer: NodeJS.Timeout
}

interface MessageWaiter {
  readonly epoch: number
  readonly predicate: (message: VideohubProtocolMessage) => boolean
  readonly resolve: (message: VideohubProtocolMessage) => void
  readonly reject: (error: VideohubError) => void
  readonly timer: NodeJS.Timeout
}

interface MessageWaiterHandle {
  readonly promise: Promise<VideohubProtocolMessage>
  readonly cancel: () => void
}

interface RouteConfirmation {
  readonly epoch: number
  readonly expected: ReadonlyMap<number, number>
  readonly resolve: () => void
  readonly reject: (error: VideohubError) => void
  readonly timer: NodeJS.Timeout
}

interface RouteConfirmationHandle {
  readonly pending: RouteConfirmation
  readonly promise: Promise<void>
}

interface RequestTransport {
  epoch(): number
  requireActiveConnection(): void
  write(bytes: Buffer): void
  failConnection(error: VideohubError): void
}

/** Owns pending reply lifetimes; no command can survive a transport/device fence. */
export class VideohubRequests {
  private readonly messageWaiters = new Set<MessageWaiter>()
  private readonly routeConfirmations = new Set<RouteConfirmation>()
  private pendingAck: PendingAcknowledgement | null = null
  private acknowledgementStreamDesynchronized = false
  public constructor(
    private readonly timeoutMs: number,
    private readonly port: RequestTransport,
  ) {}
  public sendWithAcknowledgement(bytes: Buffer, fenceOnTimeout = true): Promise<void> {
    this.port.requireActiveConnection()
    if (this.acknowledgementStreamDesynchronized) {
      return Promise.reject(
        new VideohubError(
          'disconnected',
          'Videohub acknowledgement stream is awaiting a reconnect',
        ),
      )
    }
    if (this.pendingAck !== null) {
      return Promise.reject(
        new VideohubError('protocol-error', 'A Videohub acknowledgement is already pending'),
      )
    }
    const epoch = this.port.epoch()
    return new Promise<void>((resolve, reject) => {
      const pending: PendingAcknowledgement = {
        epoch,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingAck !== pending) return
          this.pendingAck = null
          const error = new VideohubError('timeout', 'Videohub acknowledgement timed out')
          this.acknowledgementStreamDesynchronized = true
          reject(error)
          if (fenceOnTimeout) this.port.failConnection(error)
        }, this.timeoutMs),
      }
      this.pendingAck = pending
      try {
        this.port.write(bytes)
      } catch (error) {
        clearTimeout(pending.timer)
        this.pendingAck = null
        reject(
          error instanceof VideohubError
            ? error
            : new VideohubError('disconnected', errorMessage(error), {
                cause: error,
              }),
        )
      }
    })
  }

  public settleAcknowledgement(acknowledged: boolean, epoch: number): void {
    const pending = this.pendingAck
    if (pending === null || pending.epoch !== epoch) return
    this.pendingAck = null
    clearTimeout(pending.timer)
    if (acknowledged) pending.resolve()
    else pending.reject(new VideohubError('rejected', 'Videohub rejected the command with NAK'))
  }

  public fenceDesynchronizedAcknowledgements(): void {
    if (!this.acknowledgementStreamDesynchronized) return
    this.port.failConnection(
      new VideohubError(
        'timeout',
        'Videohub acknowledgement timed out; reconnecting before another command',
      ),
    )
  }

  public createMessageWaiter(
    predicate: (message: VideohubProtocolMessage) => boolean,
  ): MessageWaiterHandle {
    const epoch = this.port.epoch()
    let pending: MessageWaiter
    const promise = new Promise<VideohubProtocolMessage>((resolve, reject) => {
      pending = {
        epoch,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.messageWaiters.delete(pending)
          reject(new VideohubError('timeout', 'Videohub status refresh timed out'))
        }, this.timeoutMs),
      }
      this.messageWaiters.add(pending)
    })
    void promise.catch(() => undefined)
    return Object.freeze({
      promise,
      cancel: () => {
        if (!this.messageWaiters.delete(pending)) return
        clearTimeout(pending.timer)
      },
    })
  }

  public notifyMessageWaiters(message: VideohubProtocolMessage, epoch: number): void {
    for (const waiter of [...this.messageWaiters]) {
      if (waiter.epoch !== epoch || !waiter.predicate(message)) continue
      this.messageWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  }

  public createRouteConfirmation(
    crosspoints: readonly VideohubCrosspoint[],
  ): RouteConfirmationHandle {
    const expected = new Map(
      crosspoints.map((crosspoint) => [crosspoint.destination, crosspoint.source] as const),
    )
    let pending!: RouteConfirmation
    const promise = new Promise<void>((resolve, reject) => {
      pending = {
        epoch: this.port.epoch(),
        expected,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.routeConfirmations.delete(pending)
          reject(new VideohubError('timeout', 'Videohub route confirmation timed out'))
        }, this.timeoutMs),
      }
      this.routeConfirmations.add(pending)
    })
    void promise.catch(() => undefined)
    return Object.freeze({ pending, promise })
  }

  public observeRouteConfirmations(routes: ReadonlyMap<number, VideohubCrosspoint>): void {
    for (const confirmation of [...this.routeConfirmations]) {
      const complete = [...confirmation.expected].every(
        ([destination, source]) => routes.get(destination)?.source === source,
      )
      if (!complete) continue
      this.routeConfirmations.delete(confirmation)
      clearTimeout(confirmation.timer)
      confirmation.resolve()
    }
  }

  public cancelRouteConfirmation(confirmation: RouteConfirmation): void {
    if (!this.routeConfirmations.delete(confirmation)) return
    clearTimeout(confirmation.timer)
  }

  public rejectAll(error: VideohubError): void {
    if (this.pendingAck !== null) {
      clearTimeout(this.pendingAck.timer)
      this.pendingAck.reject(error)
      this.pendingAck = null
    }
    for (const waiter of this.messageWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.messageWaiters.clear()
    for (const confirmation of this.routeConfirmations) {
      clearTimeout(confirmation.timer)
      confirmation.reject(error)
    }
    this.routeConfirmations.clear()
  }
  public resetEpoch(): void {
    this.acknowledgementStreamDesynchronized = false
  }
}
