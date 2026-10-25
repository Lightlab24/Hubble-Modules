import WebSocket from 'ws'
import {
  DitBrowseCommandError,
  type DitBrowseClientClock,
  type DitBrowseConnectionPhase,
  type PendingRequest,
} from './client-models.js'
import { unrefTimer } from './client-options.js'
import {
  DitBrowseCommandSchema,
  createDitBrowseCommandMessage,
  type DitBrowseCommand,
  type DitBrowseCommandResult,
  type DitBrowseStatus,
} from './protocol.js'

export interface CommandContext {
  socket: WebSocket | null
  phase: DitBrowseConnectionPhase
  capabilities: readonly string[]
  clock: DitBrowseClientClock
  recordError(message: string): void
  recoverConnection(error: DitBrowseCommandError, socket: WebSocket): void
  requestTimeoutMs: number
  generation: number
  failProtocol(message: string, socket: WebSocket): void
  lastError: string | null
  acceptStatus(status: DitBrowseStatus, revision?: number): void
}

export class DitBrowseCommandQueue {
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  private readonly commandQueue: Array<() => void> = []
  private commandRunning = false
  constructor(private readonly context: CommandContext) {}
  async sendCommandNow(command: DitBrowseCommand): Promise<DitBrowseStatus> {
    const parsedCommand = DitBrowseCommandSchema.safeParse(command)
    if (!parsedCommand.success) {
      throw new DitBrowseCommandError('bad_request', 'Invalid DIT Browse command')
    }

    const socket = this.context.socket
    if (this.context.phase !== 'connected' || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new DitBrowseCommandError('not_connected', 'DIT Browse is not connected')
    }

    if (
      command.type === 'switchWorkspace' &&
      !this.context.capabilities.includes('switchWorkspace')
    ) {
      throw new DitBrowseCommandError(
        'unsupported_command',
        'Update DIT Browse to use workspace switching',
      )
    }

    this.requestCounter += 1
    const requestId = `${this.context.clock.now().toString(36)}-${this.requestCounter.toString(36)}`
    const promise = new Promise<DitBrowseStatus>((resolve, reject) => {
      const timeout = this.context.clock.setTimeout(() => {
        this.pending.delete(requestId)
        const error = new DitBrowseCommandError(
          'timeout',
          'DIT Browse command timed out',
          requestId,
        )
        this.context.recordError(error.message)
        reject(error)
        this.context.recoverConnection(error, socket)
      }, this.context.requestTimeoutMs)
      unrefTimer(timeout)
      this.pending.set(requestId, { resolve, reject, timeout })
    })

    try {
      socket.send(JSON.stringify(createDitBrowseCommandMessage(requestId, parsedCommand.data)))
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending) {
        this.context.clock.clearTimeout(pending.timeout)
        this.pending.delete(requestId)
        const commandError = new DitBrowseCommandError(
          'disconnected',
          error instanceof Error ? error.message : 'Could not send DIT Browse command',
          requestId,
        )
        this.context.recordError(commandError.message)
        pending.reject(commandError)
        this.context.recoverConnection(commandError, socket)
      }
    }

    return promise
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.context.generation
    return new Promise<T>((resolve, reject) => {
      this.commandQueue.push(() => {
        const complete = async (): Promise<void> => {
          try {
            if (generation !== this.context.generation) {
              throw new DitBrowseCommandError('disconnected', 'DIT Browse connection changed')
            }
            resolve(await operation())
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new DitBrowseCommandError(
                    'protocol_error',
                    'DIT Browse command failed unexpectedly',
                  ),
            )
          } finally {
            this.commandRunning = false
            this.runNextCommand()
          }
        }
        void complete()
      })
      this.runNextCommand()
    })
  }

  runNextCommand(): void {
    if (this.commandRunning) return
    const next = this.commandQueue.shift()
    if (next === undefined) return
    this.commandRunning = true
    next()
  }

  handleResult(message: DitBrowseCommandResult, socket: WebSocket): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.context.clock.clearTimeout(pending.timeout)
    this.pending.delete(message.requestId)

    if (!message.ok) {
      const error = new DitBrowseCommandError(
        message.error.code,
        message.error.message,
        message.requestId,
      )
      this.context.recordError(error.message)
      pending.reject(error)
      return
    }
    if (!message.status) {
      const error = new DitBrowseCommandError(
        'protocol_error',
        'DIT Browse result did not include status',
        message.requestId,
      )
      pending.reject(error)
      this.context.failProtocol(error.message, socket)
      return
    }

    this.context.lastError = null
    this.context.acceptStatus(message.status)
    pending.resolve(message.status)
  }

  rejectPending(error: DitBrowseCommandError): void {
    for (const pending of this.pending.values()) {
      this.context.clock.clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
