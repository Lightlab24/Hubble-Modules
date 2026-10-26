import WebSocket, { type RawData } from 'ws'
import {
  DitBrowseCommandError,
  type DitBrowseClientClock,
  type DitBrowseClientOptions,
  type DitBrowseConnectionPhase,
  type DitBrowseConnectionSnapshot,
  type DitBrowseSnapshotListener,
  type DitBrowseSocketFactory,
} from './client-models.js'
import {
  DIT_BROWSE_DEFAULT_PORT,
  DIT_BROWSE_DEFAULT_RECONNECT_DELAYS_MS,
  DIT_BROWSE_DEFAULT_REQUEST_TIMEOUT_MS,
  SYSTEM_CLOCK,
  rawDataText,
  unrefTimer,
  validatePort,
  validatePositiveDuration,
  validateReconnectDelays,
} from './client-options.js'
import { DitBrowseCommandQueue } from './commands.js'
import {
  DIT_BROWSE_MAX_CAMERA_NUMBER,
  DIT_BROWSE_WEBSOCKET_PATH,
  DitBrowseCommandSchema,
  createDitBrowseClientHello,
  parseDitBrowseServerMessage,
  sanitizeDitBrowseBoundaryText,
  type DitBrowseCommand,
  type DitBrowseServerMessage,
  type DitBrowseStatus,
} from './protocol.js'
import {
  applyDitBrowseStatus,
  createEmptyDitBrowseState,
  type DitBrowseState,
} from './state.js'

export class DitBrowseClient {
  private readonly commands: DitBrowseCommandQueue

  private readonly clientName: string
  private readonly clientVersion: string
  private readonly requestTimeoutMs: number
  private readonly reconnectDelaysMs: readonly number[]
  private readonly socketFactory: DitBrowseSocketFactory
  private readonly clock: DitBrowseClientClock
  private readonly listeners = new Set<DitBrowseSnapshotListener>()

  private port: number
  private phase: DitBrowseConnectionPhase = 'disconnected'
  private connectionState: DitBrowseState = createEmptyDitBrowseState()
  private serverVersion: string | null = null
  private capabilities: readonly string[] = []
  private lastError: string | null = null
  private socket: WebSocket | null = null
  private reconnectTimer: unknown = null
  private connectionTimer: unknown = null
  private stopped = true
  private generation = 0
  private reconnectAttempt = 0
  private nextReconnectDelayMs: number | null = null

  constructor(options: DitBrowseClientOptions) {
    this.port = validatePort(options.port ?? DIT_BROWSE_DEFAULT_PORT)
    this.clientName = options.clientName
    this.clientVersion = options.clientVersion
    createDitBrowseClientHello(this.clientName, this.clientVersion)
    this.requestTimeoutMs = validatePositiveDuration(
      options.requestTimeoutMs ?? DIT_BROWSE_DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.reconnectDelaysMs = validateReconnectDelays(
      options.reconnectDelaysMs ?? DIT_BROWSE_DEFAULT_RECONNECT_DELAYS_MS,
    )
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url))
    this.clock = options.clock ?? SYSTEM_CLOCK

    const client = this
    this.commands = new DitBrowseCommandQueue({
      get socket() {
        return client.socket
      },
      get phase() {
        return client.phase
      },
      get capabilities() {
        return client.capabilities
      },
      get clock() {
        return client.clock
      },
      recordError: (...args) => client.recordError(...args),
      recoverConnection: (...args) => client.recoverConnection(...args),
      get requestTimeoutMs() {
        return client.requestTimeoutMs
      },
      get generation() {
        return client.generation
      },
      failProtocol: (...args) => client.failProtocol(...args),
      get lastError() {
        return client.lastError
      },
      set lastError(value) {
        client.lastError = value
      },
      acceptStatus: (...args) => client.acceptStatus(...args),
    })
  }

  get snapshot(): DitBrowseConnectionSnapshot {
    return Object.freeze({
      phase: this.phase,
      connected: this.phase === 'connected',
      endpoint: this.endpoint,
      port: this.port,
      serverVersion: this.serverVersion,
      status: this.connectionState.status,
      revision: this.connectionState.revision,
      catalog: this.connectionState.catalog,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      nextReconnectDelayMs: this.nextReconnectDelayMs,
    })
  }

  subscribe(listener: DitBrowseSnapshotListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  start(port = this.port): void {
    this.port = validatePort(port)
    this.stopped = false
    this.restartConnection('reconfigured')
  }

  reconfigure(port: number): void {
    const validated = validatePort(port)
    if (!this.stopped && validated === this.port) return
    this.port = validated
    this.stopped = false
    this.restartConnection('reconfigured')
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearReconnectTimer()
    this.reconnectAttempt = 0
    this.commands.rejectPending(
      new DitBrowseCommandError('stopped', 'DIT Browse connection stopped'),
    )
    this.disconnectSocket()
    this.connectionState = createEmptyDitBrowseState()
    this.serverVersion = null
    this.capabilities = []
    this.setPhase('disconnected')
  }

  async focusCamera(cameraNumber: number): Promise<DitBrowseStatus> {
    if (
      !Number.isSafeInteger(cameraNumber) ||
      cameraNumber < 1 ||
      cameraNumber > DIT_BROWSE_MAX_CAMERA_NUMBER
    ) {
      throw new DitBrowseCommandError(
        'bad_request',
        'cameraNumber must be an integer between 1 and 999999',
      )
    }
    return this.sendCommand({ type: 'focusCamera', cameraNumber })
  }

  async switchWorkspace(workspaceNumber: number): Promise<DitBrowseStatus> {
    return this.sendCommand({ type: 'switchWorkspace', workspaceNumber })
  }

  async cycleWorkspaces(): Promise<DitBrowseStatus> {
    // Keep the fresh status read and switch together, including for rapid button presses.
    return this.commands.enqueue(async () => {
      if (this.phase === 'connected' && !this.capabilities.includes('switchWorkspace')) {
        throw new DitBrowseCommandError(
          'unsupported_command',
          'Update DIT Browse to use workspace switching',
        )
      }
      const generation = this.generation
      const current = await this.commands.sendCommandNow({ type: 'status' })
      if (generation !== this.generation) {
        throw new DitBrowseCommandError('reconfigured', 'DIT Browse connection changed')
      }
      const workspaces = [...new Set(current.workspaceNumbers ?? [])].sort((a, b) => a - b)
      const active = current.activeWorkspaceNumber
      const next =
        active === undefined ? undefined : (workspaces.find((n) => n > active) ?? workspaces[0])
      if (next === undefined) {
        throw new DitBrowseCommandError(
          'protocol_error',
          'DIT Browse did not report its workspaces',
        )
      }
      const confirmed = await this.commands.sendCommandNow({
        type: 'switchWorkspace',
        workspaceNumber: next,
      })
      if (confirmed.activeWorkspaceNumber !== next || confirmed.focusMode) {
        throw new DitBrowseCommandError(
          'not_confirmed',
          'DIT Browse did not confirm the next workspace grid',
        )
      }
      return confirmed
    })
  }

  async setGridLocked(locked: boolean): Promise<DitBrowseStatus> {
    if (typeof locked !== 'boolean') {
      throw new DitBrowseCommandError('bad_request', 'locked must be a boolean')
    }

    return this.commands.enqueue(async () => {
      const generation = this.generation
      const currentStatus =
        this.connectionState.status ?? (await this.commands.sendCommandNow({ type: 'status' }))
      if (generation !== this.generation) {
        throw new DitBrowseCommandError('disconnected', 'DIT Browse connection changed')
      }
      if (currentStatus.expansionEnabled === !locked) return currentStatus
      return this.commands.sendCommandNow({ type: 'toggleExpansion' })
    })
  }

  async showGrid(): Promise<DitBrowseStatus> {
    return this.sendCommand({ type: 'showGrid' })
  }

  async toggleGridLocked(): Promise<DitBrowseStatus> {
    return this.sendCommand({ type: 'toggleExpansion' })
  }

  async refreshStatus(): Promise<DitBrowseStatus> {
    return this.sendCommand({ type: 'status' })
  }

  async sendCommand(command: DitBrowseCommand): Promise<DitBrowseStatus> {
    const parsedCommand = DitBrowseCommandSchema.safeParse(command)
    if (!parsedCommand.success) {
      throw new DitBrowseCommandError('bad_request', 'Invalid DIT Browse command')
    }

    return this.commands.enqueue(() => this.commands.sendCommandNow(parsedCommand.data))
  }

  private get endpoint(): string {
    return `ws://127.0.0.1:${String(this.port)}${DIT_BROWSE_WEBSOCKET_PATH}`
  }

  private restartConnection(reason: 'reconfigured'): void {
    this.generation += 1
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.commands.rejectPending(
      new DitBrowseCommandError(reason, 'DIT Browse connection reconfigured'),
    )
    this.disconnectSocket()
    this.connectionState = createEmptyDitBrowseState()
    this.serverVersion = null
    this.capabilities = []
    this.lastError = null
    this.connect(this.generation)
  }

  private connect(generation: number): void {
    if (this.stopped || generation !== this.generation) return
    this.setPhase('connecting')

    let socket: WebSocket
    try {
      socket = this.socketFactory(this.endpoint)
    } catch (error) {
      this.recordError(
        error instanceof Error ? error.message : 'Could not connect to DIT Browse',
      )
      this.setPhase('disconnected')
      this.scheduleReconnect(generation)
      return
    }
    this.socket = socket
    this.armConnectionTimeout(generation, socket, Math.max(10_000, this.requestTimeoutMs))

    socket.on('open', () => {
      if (!this.isCurrentSocket(generation, socket)) return
      this.setPhase('handshaking')
      this.armConnectionTimeout(generation, socket, this.requestTimeoutMs)
      try {
        socket.send(
          JSON.stringify(createDitBrowseClientHello(this.clientName, this.clientVersion)),
        )
      } catch (error) {
        this.failProtocol(
          error instanceof Error ? error.message : 'Could not send DIT Browse hello',
          socket,
        )
      }
    })

    socket.on('message', (data) => {
      if (!this.isCurrentSocket(generation, socket)) return
      this.handleRawMessage(data, socket)
    })

    socket.on('error', (error) => {
      if (!this.isCurrentSocket(generation, socket)) return
      this.recoverConnection(new DitBrowseCommandError('disconnected', error.message), socket)
    })

    socket.on('close', () => {
      if (!this.isCurrentSocket(generation, socket)) return
      this.recoverConnection(
        new DitBrowseCommandError('disconnected', this.lastError ?? 'DIT Browse disconnected'),
        socket,
      )
    })
  }

  private handleRawMessage(data: RawData, socket: WebSocket): void {
    let message: DitBrowseServerMessage
    try {
      const raw = JSON.parse(rawDataText(data)) as unknown
      message = parseDitBrowseServerMessage(raw)
    } catch {
      this.failProtocol('Invalid DIT Browse server message', socket)
      return
    }
    this.handleMessage(message, socket)
  }

  private handleMessage(message: DitBrowseServerMessage, socket: WebSocket): void {
    if (message.type === 'hello') {
      if (this.phase !== 'handshaking') {
        this.failProtocol('Unexpected DIT Browse hello', socket)
        return
      }
      this.serverVersion = message.server.version
      this.clearConnectionTimer()
      this.capabilities = message.capabilities
      this.reconnectAttempt = 0
      this.nextReconnectDelayMs = null
      this.lastError = null
      this.setPhase('connected')
      void this.refreshStatus().catch(() => undefined)
      return
    }

    if (this.phase !== 'connected') {
      this.failProtocol(
        'DIT Browse sent a message before completing the hello handshake',
        socket,
      )
      return
    }

    if (message.type === 'event') {
      this.acceptStatus(message.status, message.revision)
      return
    }
    if (message.type === 'result') {
      this.commands.handleResult(message, socket)
      return
    }
    this.failProtocol(message.error.message, socket)
  }

  private acceptStatus(status: DitBrowseStatus, revision?: number): void {
    const applied = applyDitBrowseStatus(this.connectionState, status, revision)
    if (!applied.accepted) return
    this.connectionState = applied.state
    this.emitSnapshot()
  }

  private failProtocol(message: string, socket: WebSocket): void {
    const error = new DitBrowseCommandError('protocol_error', message)
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close(1002, 'Protocol error')
    } catch {
      // Recovery terminates a transport even when the closing handshake cannot start.
    } finally {
      this.recoverConnection(error, socket)
    }
  }

  private armConnectionTimeout(generation: number, socket: WebSocket, timeoutMs: number): void {
    this.clearConnectionTimer()
    this.connectionTimer = this.clock.setTimeout(() => {
      if (!this.isCurrentSocket(generation, socket)) return
      const stage = this.phase === 'handshaking' ? 'hello handshake' : 'WebSocket connection'
      this.recoverConnection(
        new DitBrowseCommandError('timeout', `DIT Browse ${stage} timed out`),
        socket,
      )
    }, timeoutMs)
    unrefTimer(this.connectionTimer)
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer !== null) this.clock.clearTimeout(this.connectionTimer)
    this.connectionTimer = null
  }

  private recoverConnection(error: DitBrowseCommandError, socket: WebSocket): void {
    if (socket !== this.socket) return
    this.generation += 1
    this.lastError = error.message
    this.commands.rejectPending(error)
    this.disconnectSocket()
    this.serverVersion = null
    this.capabilities = []
    this.connectionState = createEmptyDitBrowseState()
    this.setPhase('disconnected')
    this.scheduleReconnect(this.generation)
  }

  private scheduleReconnect(generation: number): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    const delay = this.reconnectDelaysMs[index] ?? 10_000
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, Number.MAX_SAFE_INTEGER)
    this.nextReconnectDelayMs = delay
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null
      this.nextReconnectDelayMs = null
      this.connect(generation)
    }, delay)
    unrefTimer(this.reconnectTimer)
    this.emitSnapshot()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.nextReconnectDelayMs = null
  }

  private disconnectSocket(): void {
    this.clearConnectionTimer()
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    socket.removeAllListeners()
    // ws emits this expected error asynchronously when terminate() aborts a
    // still-connecting handshake. Retain one bounded listener after removing
    // the normal lifecycle listeners so shutdown cannot become an uncaught
    // process error.
    socket.once('error', () => undefined)
    try {
      socket.terminate()
    } catch {
      // ws can throw when a socket is stopped before the opening handshake completes.
    }
  }

  private isCurrentSocket(generation: number, socket: WebSocket): boolean {
    return generation === this.generation && socket === this.socket
  }

  private recordError(message: string): void {
    this.lastError = sanitizeDitBrowseBoundaryText(message)
    this.emitSnapshot()
  }

  private setPhase(phase: DitBrowseConnectionPhase): void {
    this.phase = phase
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    const snapshot = this.snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}
export {
  DitBrowseCommandError,
  type DitBrowseClientClock,
  type DitBrowseClientErrorCode,
  type DitBrowseClientOptions,
  type DitBrowseConnectionPhase,
  type DitBrowseConnectionSnapshot,
  type DitBrowseSnapshotListener,
  type DitBrowseSocketFactory,
} from './client-models.js'
export {
  DIT_BROWSE_DEFAULT_PORT,
  DIT_BROWSE_DEFAULT_RECONNECT_DELAYS_MS,
  DIT_BROWSE_DEFAULT_REQUEST_TIMEOUT_MS,
} from './client-options.js'
