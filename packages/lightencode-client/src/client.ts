import { randomUUID } from 'node:crypto'
import {
  LightEncodeCommandError,
  type LightEncodeClientClock,
  type LightEncodeClientOptions,
  type LightEncodeClientSnapshot,
  type LightEncodeCommandErrorCode,
  type LightEncodeConnectionPhase,
  type LightEncodeSnapshotListener,
  type LightEncodeSocket,
  type LightEncodeSocketFactory,
} from './client-models.js'
import {
  EMPTY_CAPABILITIES,
  LIGHTENCODE_DEFAULT_RECONNECT_DELAY_MS,
  LIGHTENCODE_DEFAULT_REQUEST_TIMEOUT_MS,
  LIGHTENCODE_PING_INTERVAL_MS,
  LIGHTENCODE_STALE_INTERVAL_MS,
  SYSTEM_CLOCK,
  defaultSocketFactory,
  positiveInteger,
  unrefTimer,
  validateHost,
} from './client-options.js'
import { LightEncodeCommandTracker } from './commands.js'
import {
  LIGHTENCODE_CLIENT_VERSION,
  LIGHTENCODE_COMPANION_PORT,
  LIGHTENCODE_MAXIMUM_TIMER_MINUTES,
  LIGHTENCODE_MINIMUM_TIMER_MINUTES,
  LightEncodeNdjsonFramer,
  createLightEncodeClientHello,
  encodeLightEncodeClientMessage,
  parseLightEncodeServerMessage,
  type LightEncodeCommandRequest,
  type LightEncodeServerMessage,
  type LightEncodeStateSnapshot,
} from './protocol.js'
import { LightEncodeStateStore, lightEncodePipelineForSlot } from './state.js'

export class LightEncodeClient {
  private readonly commands: LightEncodeCommandTracker

  private readonly clientVersion: string
  private readonly requestTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly pingIntervalMs: number
  private readonly staleIntervalMs: number
  private readonly socketFactory: LightEncodeSocketFactory
  private readonly clock: LightEncodeClientClock
  private readonly requestIdFactory: () => string
  private readonly listeners = new Set<LightEncodeSnapshotListener>()

  private readonly stateStore = new LightEncodeStateStore()
  private readonly framer = new LightEncodeNdjsonFramer()

  private phase: LightEncodeConnectionPhase = 'disconnected'
  private host = ''
  private appVersion: string | null = null
  private capabilities: readonly string[] = EMPTY_CAPABILITIES
  private lastEventAt: string | null = null
  private lastError: string | null = null
  private reconnectAttempt = 0

  private socket: LightEncodeSocket | null = null
  private reconnectTimer: unknown = null
  private pingTimer: unknown = null
  private staleTimer: unknown = null
  private stopped = true
  private generation = 0

  constructor(options: LightEncodeClientOptions = {}) {
    this.clientVersion = options.clientVersion ?? LIGHTENCODE_CLIENT_VERSION
    createLightEncodeClientHello(this.clientVersion)
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? LIGHTENCODE_DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.reconnectDelayMs = positiveInteger(
      options.reconnectDelayMs ?? LIGHTENCODE_DEFAULT_RECONNECT_DELAY_MS,
      'reconnectDelayMs',
    )
    this.pingIntervalMs = positiveInteger(
      options.pingIntervalMs ?? LIGHTENCODE_PING_INTERVAL_MS,
      'pingIntervalMs',
    )
    this.staleIntervalMs = positiveInteger(
      options.staleIntervalMs ?? LIGHTENCODE_STALE_INTERVAL_MS,
      'staleIntervalMs',
    )
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.requestIdFactory = options.requestIdFactory ?? randomUUID

    const client = this
    this.commands = new LightEncodeCommandTracker({
      get socket() {
        return client.socket
      },
      get stateStore() {
        return client.stateStore
      },
      get phase() {
        return client.phase
      },
      get requestIdFactory() {
        return client.requestIdFactory
      },
      get clock() {
        return client.clock
      },
      get lastError() {
        return client.lastError
      },
      set lastError(value) {
        client.lastError = value
      },
      emitSnapshot: (...args) => client.emitSnapshot(...args),
      get requestTimeoutMs() {
        return client.requestTimeoutMs
      },
      writeMessage: (...args) => client.writeMessage(...args),
      handleTransportLoss: (...args) => client.handleTransportLoss(...args),
      get generation() {
        return client.generation
      },
    })
  }

  get snapshot(): LightEncodeClientSnapshot {
    return Object.freeze({
      phase: this.phase,
      host: this.host,
      port: LIGHTENCODE_COMPANION_PORT,
      appVersion: this.appVersion,
      sessionId: this.stateStore.sessionId,
      capabilities: this.capabilities,
      state: this.stateStore.snapshot,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
    })
  }

  subscribe(listener: LightEncodeSnapshotListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  start(host: string): void {
    const nextHost = validateHost(host)
    this.stopped = false
    this.generation += 1
    this.clearReconnectTimer()
    this.clearConnectionTimers()
    this.commands.rejectPending(
      new LightEncodeCommandError('disconnected', 'Light Encode connection reconfigured'),
    )
    this.detachSocket()
    this.resetServerState()
    this.framer.reset()
    this.host = nextHost
    this.lastEventAt = null
    this.lastError = null
    this.reconnectAttempt = 0
    this.connect(this.generation)
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearReconnectTimer()
    this.clearConnectionTimers()
    this.commands.rejectPending(
      new LightEncodeCommandError('disconnected', 'Light Encode client stopped'),
    )
    this.detachSocket()
    this.resetServerState()
    this.framer.reset()
    this.phase = 'disconnected'
    this.reconnectAttempt = 0
    this.emitSnapshot()
  }

  toggleAll(): Promise<LightEncodeStateSnapshot> {
    return this.commands.sendCommand('record.toggleAll', { scope: 'all' }, {})
  }

  toggleSlot(slotNumber: number): Promise<LightEncodeStateSnapshot> {
    const state = this.stateStore.snapshot
    const pipeline = state ? lightEncodePipelineForSlot(state, slotNumber) : undefined
    if (!pipeline) {
      return Promise.reject(
        new LightEncodeCommandError(
          'slot_not_found',
          `Light Encode slot ${String(slotNumber)} does not exist`,
        ),
      )
    }
    return this.commands.sendCommand(
      'record.togglePipeline',
      { scope: 'pipeline', pipelineId: pipeline.pipelineId },
      {},
    )
  }

  toggleTimer(): Promise<LightEncodeStateSnapshot> {
    return this.commands.sendCommand('timer.toggle', { scope: 'app' }, {})
  }

  setTimerMinutes(minutes: number): Promise<LightEncodeStateSnapshot> {
    if (
      !Number.isSafeInteger(minutes) ||
      minutes < LIGHTENCODE_MINIMUM_TIMER_MINUTES ||
      minutes > LIGHTENCODE_MAXIMUM_TIMER_MINUTES
    ) {
      return Promise.reject(
        new LightEncodeCommandError(
          'rejected',
          'Light Encode timer minutes must be an integer from 0 to 1440',
        ),
      )
    }
    return this.commands.sendCommand('timer.set', { scope: 'app' }, { minutes })
  }

  private connect(generation: number): void {
    if (this.stopped || generation !== this.generation) return
    this.phase = 'connecting'
    this.emitSnapshot()

    let socket: LightEncodeSocket
    try {
      socket = this.socketFactory(this.host, LIGHTENCODE_COMPANION_PORT)
    } catch {
      this.lastError = 'Could not connect to Light Encode'
      this.phase = 'disconnected'
      this.scheduleReconnect(generation, false)
      return
    }
    this.socket = socket

    socket.on('connect', () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleConnect(socket, generation)
    })
    socket.on('data', (data) => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleData(socket, generation, data)
    })
    socket.on('end', () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleTransportLoss(socket, generation, 'Light Encode closed the connection')
    })
    socket.on('error', () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleTransportLoss(socket, generation, 'Light Encode TCP connection failed')
    })
    socket.on('close', () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleTransportLoss(socket, generation, 'Light Encode disconnected')
    })
    this.refreshStaleTimer(socket, generation)
  }

  private handleConnect(socket: LightEncodeSocket, generation: number): void {
    this.clearConnectionTimers()
    this.resetServerState()
    this.framer.reset()
    this.phase = 'handshaking'
    this.emitSnapshot()

    try {
      this.writeMessage(socket, createLightEncodeClientHello(this.clientVersion))
    } catch {
      this.handleTransportLoss(
        socket,
        generation,
        'Could not send the Light Encode hello handshake',
      )
      return
    }
    this.refreshStaleTimer(socket, generation)
    this.schedulePing(socket, generation)
  }

  private handleData(socket: LightEncodeSocket, generation: number, data: Buffer): void {
    this.refreshStaleTimer(socket, generation)
    let rawMessages: unknown[]
    try {
      rawMessages = this.framer.push(data)
    } catch {
      this.failProtocol(socket, generation, 'Invalid Light Encode protocol data')
      return
    }

    for (const rawMessage of rawMessages) {
      if (!this.isCurrentSocket(socket, generation)) return
      let message: LightEncodeServerMessage
      try {
        message = parseLightEncodeServerMessage(rawMessage)
      } catch {
        this.failProtocol(socket, generation, 'Invalid Light Encode protocol data')
        return
      }
      this.lastEventAt = new Date(this.clock.now()).toISOString()
      this.handleMessage(socket, generation, message)
    }
  }

  private handleMessage(
    socket: LightEncodeSocket,
    generation: number,
    message: LightEncodeServerMessage,
  ): void {
    if (message.type === 'helloAck') {
      if (this.phase !== 'handshaking' && this.phase !== 'connected') {
        this.failProtocol(socket, generation, 'Unexpected Light Encode hello acknowledgment')
        return
      }
      if (this.stateStore.sessionId !== null) {
        this.commands.rejectPending(
          new LightEncodeCommandError('disconnected', 'Light Encode process session changed'),
        )
      }
      this.commands.setSession(message.sessionId)
      this.stateStore.applyHello(message)
      this.appVersion = message.appVersion
      this.capabilities = message.capabilities
      this.phase = 'handshaking'
      this.emitSnapshot()
      return
    }

    if (message.type === 'ping') {
      try {
        this.writeMessage(socket, { type: 'pong', timestamp: message.timestamp })
      } catch {
        this.handleTransportLoss(socket, generation, 'Could not send Light Encode keepalive')
        return
      }
      this.emitSnapshot()
      return
    }
    if (message.type === 'pong') {
      this.emitSnapshot()
      return
    }

    if (message.type === 'state') {
      if (
        this.stateStore.sessionId === null ||
        (this.phase !== 'handshaking' && this.phase !== 'connected')
      ) {
        this.failProtocol(socket, generation, 'Light Encode sent state before the handshake')
        return
      }
      const applied = this.stateStore.applyState(message)
      if (applied.accepted) {
        if (this.phase === 'handshaking') {
          this.phase = 'connected'
          this.reconnectAttempt = 0
          this.lastError = null
        }
        this.commands.resolveConfirmedCommands()
      }
      this.emitSnapshot()
      return
    }

    if (this.phase !== 'connected') {
      if (message.type === 'error') {
        this.failProtocol(socket, generation, message.message)
      } else {
        this.failProtocol(
          socket,
          generation,
          'Light Encode sent a command response before publishing initial state',
        )
      }
      return
    }

    if (message.type === 'response') {
      this.commands.handleCommandResponse(message)
      this.emitSnapshot()
      return
    }
    this.commands.handleErrorResponse(message)
    this.emitSnapshot()
  }

  private schedulePing(socket: LightEncodeSocket, generation: number): void {
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null
      if (!this.isCurrentSocket(socket, generation)) return
      try {
        this.writeMessage(socket, { type: 'ping', timestamp: Math.trunc(this.clock.now()) })
      } catch {
        this.handleTransportLoss(socket, generation, 'Could not send Light Encode keepalive')
        return
      }
      this.schedulePing(socket, generation)
    }, this.pingIntervalMs)
    unrefTimer(this.pingTimer)
  }

  private refreshStaleTimer(socket: LightEncodeSocket, generation: number): void {
    if (this.staleTimer !== null) this.clock.clearTimeout(this.staleTimer)
    this.staleTimer = this.clock.setTimeout(() => {
      this.staleTimer = null
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleTransportLoss(socket, generation, 'Light Encode connection became stale', true)
    }, this.staleIntervalMs)
    unrefTimer(this.staleTimer)
  }

  private failProtocol(socket: LightEncodeSocket, generation: number, message: string): void {
    this.handleTransportLoss(socket, generation, message, false, 'protocol_error')
  }

  private handleTransportLoss(
    socket: LightEncodeSocket,
    generation: number,
    message: string,
    reconnectImmediately = false,
    pendingCode: LightEncodeCommandErrorCode = 'disconnected',
  ): void {
    if (!this.isCurrentSocket(socket, generation)) return
    this.clearConnectionTimers()
    this.detachSocket(socket)
    const error = new LightEncodeCommandError(pendingCode, message)
    this.commands.rejectPending(error)
    this.resetServerState()
    this.framer.reset()
    this.lastError = error.message
    this.phase = 'disconnected'
    this.scheduleReconnect(generation, reconnectImmediately)
  }

  private scheduleReconnect(generation: number, immediately: boolean): void {
    if (this.stopped || generation !== this.generation || this.reconnectTimer !== null) {
      this.emitSnapshot()
      return
    }
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, Number.MAX_SAFE_INTEGER)
    this.emitSnapshot()
    if (immediately) {
      this.connect(generation)
      return
    }
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null
      this.connect(generation)
    }, this.reconnectDelayMs)
    unrefTimer(this.reconnectTimer)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearConnectionTimers(): void {
    if (this.pingTimer !== null) this.clock.clearTimeout(this.pingTimer)
    if (this.staleTimer !== null) this.clock.clearTimeout(this.staleTimer)
    this.pingTimer = null
    this.staleTimer = null
  }

  private detachSocket(expected?: LightEncodeSocket): void {
    const socket = this.socket
    if (!socket || (expected && socket !== expected)) return
    this.socket = null
    socket.removeAllListeners()
    socket.once('error', () => undefined)
    try {
      socket.destroy()
    } catch {
      // Destroying a socket during its opening handshake can throw in test and platform shims.
    }
  }

  private resetServerState(): void {
    this.stateStore.clear()
    this.appVersion = null
    this.capabilities = EMPTY_CAPABILITIES
  }

  private writeMessage(
    socket: LightEncodeSocket,
    message:
      | LightEncodeCommandRequest
      | ReturnType<typeof createLightEncodeClientHello>
      | { readonly type: 'ping'; readonly timestamp: number }
      | { readonly type: 'pong'; readonly timestamp: number },
  ): void {
    socket.write(encodeLightEncodeClientMessage(message))
  }

  private isCurrentSocket(socket: LightEncodeSocket, generation: number): boolean {
    return socket === this.socket && generation === this.generation
  }

  private emitSnapshot(): void {
    const snapshot = this.snapshot
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers are isolated from transport and command state.
      }
    }
  }
}
export {
  LightEncodeCommandError,
  type LightEncodeClientClock,
  type LightEncodeClientOptions,
  type LightEncodeClientSnapshot,
  type LightEncodeCommandErrorCode,
  type LightEncodeConnectionPhase,
  type LightEncodeSnapshotListener,
  type LightEncodeSocket,
  type LightEncodeSocketFactory,
} from './client-models.js'
export {
  LIGHTENCODE_DEFAULT_RECONNECT_DELAY_MS,
  LIGHTENCODE_DEFAULT_REQUEST_TIMEOUT_MS,
  LIGHTENCODE_PING_INTERVAL_MS,
  LIGHTENCODE_STALE_INTERVAL_MS,
} from './client-options.js'
export { LIGHTENCODE_COMPANION_PORT } from './protocol.js'
