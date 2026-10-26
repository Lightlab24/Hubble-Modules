import {
  LightEncodeCommandError,
  type LightEncodeClientClock,
  type LightEncodeCommandErrorCode,
  type LightEncodeConnectionPhase,
  type LightEncodeSocket,
  type PendingCommand,
} from './client-models.js'
import { LIGHTENCODE_SERVER_REQUEST_CACHE_SIZE, unrefTimer } from './client-options.js'
import {
  createLightEncodeClientHello,
  createLightEncodeCommand,
  type LightEncodeCommandArguments,
  type LightEncodeCommandName,
  type LightEncodeCommandRequest,
  type LightEncodeCommandResponse,
  type LightEncodeCommandTarget,
  type LightEncodeServerMessage,
  type LightEncodeStateSnapshot,
} from './protocol.js'
import { LightEncodeStateStore, matchesLightEncodeConfirmation } from './state.js'

export interface CommandContext {
  socket: LightEncodeSocket | null
  stateStore: LightEncodeStateStore
  phase: LightEncodeConnectionPhase
  requestIdFactory: () => string
  clock: LightEncodeClientClock
  lastError: string | null
  emitSnapshot(): void
  requestTimeoutMs: number
  writeMessage(
    socket: LightEncodeSocket,
    message:
      | LightEncodeCommandRequest
      | ReturnType<typeof createLightEncodeClientHello>
      | { readonly type: 'ping'; readonly timestamp: number }
      | { readonly type: 'pong'; readonly timestamp: number },
  ): void
  handleTransportLoss(
    socket: LightEncodeSocket,
    generation: number,
    message: string,
    reconnectImmediately?: boolean,
    pendingCode?: LightEncodeCommandErrorCode,
  ): void
  generation: number
}

export class LightEncodeCommandTracker {
  private readonly pending = new Map<string, PendingCommand>()
  private readonly usedRequestIds = new Set<string>()
  private requestIdSessionId: string | null = null
  constructor(private readonly context: CommandContext) {}
  sendCommand(
    name: LightEncodeCommandName,
    target: LightEncodeCommandTarget,
    args: LightEncodeCommandArguments,
  ): Promise<LightEncodeStateSnapshot> {
    const socket = this.context.socket
    const sessionId = this.context.stateStore.sessionId
    if (this.context.phase !== 'connected' || !socket || sessionId === null) {
      return Promise.reject(
        new LightEncodeCommandError('disconnected', 'Light Encode is not connected'),
      )
    }

    let request: LightEncodeCommandRequest
    try {
      request = createLightEncodeCommand(name, target, args, this.context.requestIdFactory())
    } catch {
      return Promise.reject(
        new LightEncodeCommandError('protocol_error', 'Could not create Light Encode command'),
      )
    }
    const requestKey = request.id.toLowerCase()
    if (this.usedRequestIds.has(requestKey)) {
      return Promise.reject(
        new LightEncodeCommandError(
          'duplicate_request',
          'Light Encode command ID was already used for this app session',
          request.id,
        ),
      )
    }
    this.rememberRequestId(requestKey)

    const promise = new Promise<LightEncodeStateSnapshot>((resolve, reject) => {
      const timeout = this.context.clock.setTimeout(() => {
        const pending = this.pending.get(requestKey)
        if (!pending) return
        const error = new LightEncodeCommandError(
          pending.response ? 'state_not_confirmed' : 'command_timeout',
          pending.response
            ? 'Light Encode did not publish the confirmed state before the deadline'
            : 'Light Encode command timed out',
          pending.requestId,
        )
        this.context.lastError = error.message
        this.rejectPendingCommand(requestKey, pending, error)
        this.context.emitSnapshot()
      }, this.context.requestTimeoutMs)
      unrefTimer(timeout)
      this.pending.set(requestKey, {
        requestId: request.id,
        sessionId,
        resolve,
        reject,
        timeout,
        response: null,
      })
    })

    try {
      this.context.writeMessage(socket, request)
    } catch {
      this.context.handleTransportLoss(
        socket,
        this.context.generation,
        'Could not send Light Encode command',
      )
    }
    return promise
  }

  handleCommandResponse(response: LightEncodeCommandResponse): void {
    const requestKey = response.id.toLowerCase()
    const pending = this.pending.get(requestKey)
    if (!pending) return
    if (pending.sessionId !== this.context.stateStore.sessionId) {
      this.rejectPendingCommand(
        requestKey,
        pending,
        new LightEncodeCommandError(
          'disconnected',
          'Light Encode process session changed',
          pending.requestId,
        ),
      )
      return
    }

    if (!response.ok) {
      const serverCode = response.code ?? 'command_failed'
      const error = new LightEncodeCommandError(
        'rejected',
        response.message ?? 'Light Encode rejected the command',
        pending.requestId,
        serverCode,
      )
      this.context.lastError = error.message
      this.rejectPendingCommand(requestKey, pending, error)
      return
    }

    pending.response = response
    this.resolvePendingIfConfirmed(requestKey, pending)
  }

  handleErrorResponse(response: Extract<LightEncodeServerMessage, { type: 'error' }>): void {
    const requestKey = response.id?.toLowerCase()
    const pending = requestKey ? this.pending.get(requestKey) : undefined
    if (!requestKey || !pending) {
      this.context.lastError = response.message
      return
    }
    const error = new LightEncodeCommandError(
      'rejected',
      response.message,
      pending.requestId,
      response.code,
    )
    this.context.lastError = error.message
    this.rejectPendingCommand(requestKey, pending, error)
  }

  resolveConfirmedCommands(): void {
    for (const [requestKey, pending] of [...this.pending]) {
      this.resolvePendingIfConfirmed(requestKey, pending)
    }
  }

  resolvePendingIfConfirmed(requestKey: string, pending: PendingCommand): void {
    const response = pending.response
    const snapshot = this.context.stateStore.snapshot
    if (
      !response ||
      pending.sessionId !== this.context.stateStore.sessionId ||
      !matchesLightEncodeConfirmation(snapshot, response.stateRevision, response.confirmation)
    ) {
      return
    }
    if (!snapshot) return
    this.context.clock.clearTimeout(pending.timeout)
    this.pending.delete(requestKey)
    this.context.lastError = null
    pending.resolve(snapshot)
  }

  rejectPendingCommand(
    requestKey: string,
    pending: PendingCommand,
    error: LightEncodeCommandError,
  ): void {
    this.context.clock.clearTimeout(pending.timeout)
    this.pending.delete(requestKey)
    pending.reject(error)
  }

  rejectPending(error: LightEncodeCommandError): void {
    for (const [requestKey, pending] of [...this.pending]) {
      const requestError = new LightEncodeCommandError(
        error.code,
        error.message,
        pending.requestId,
        error.serverCode,
      )
      this.rejectPendingCommand(requestKey, pending, requestError)
    }
  }

  rememberRequestId(requestKey: string): void {
    this.usedRequestIds.add(requestKey)
    if (this.usedRequestIds.size <= LIGHTENCODE_SERVER_REQUEST_CACHE_SIZE) return
    const oldestRequestKey = this.usedRequestIds.values().next().value
    if (oldestRequestKey !== undefined) this.usedRequestIds.delete(oldestRequestKey)
  }

  setSession(sessionId: string): void {
    if (this.requestIdSessionId !== sessionId) {
      this.usedRequestIds.clear()
      this.requestIdSessionId = sessionId
    }
  }
}
