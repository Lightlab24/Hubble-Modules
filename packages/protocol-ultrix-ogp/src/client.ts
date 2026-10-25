import net, { type Socket } from 'node:net'
import type {
  OgpNameCatalogSnapshot,
  UltrixOgpClientEvent,
  UltrixOgpClientOptions,
  UltrixOgpConnectionPhase,
  UltrixOgpSnapshot,
} from './client-types.js'
import {
  controlReadyValue,
  errorMessage,
  immutableCrosspoint,
  objectValue,
  positiveInteger,
  referenceKey,
  routeKey,
  sortedLabels,
  sortedLevels,
  sortedRoutes,
  takeErrorValue,
} from './client-values.js'
import { UltrixOgpRequests } from './requests.js'
import { performSetCrosspoint } from './route-write.js'
export type * from './client-types.js'

import {
  decodeOgpFrame,
  encodeHandshake,
  encodeSubscriptionRequest,
  isImplicitHandshakeSuccess,
  type OgpMessage,
  type OgpValuePayload,
} from './messages.js'
import { OgpNetstringDecoder } from './netstring-codec.js'
import {
  CONTROL_READY_OID,
  DEFAULT_OGP_PANEL_ID,
  ROUTE_STATUS_OID,
  ROUTE_SUBSCRIPTION_OID,
  TAKE_ERROR_OID,
  parseCatalogElement,
  parseDestinationStatus,
  parseLevels,
  parseRouteValue,
  validateDeviceParameterDescriptors,
  type OgpCrosspoint,
  type OgpLevel,
  type OgpRouteLimits,
  type OgpRouterLabel,
} from './ultrix-parameters.js'

const REQUIRED_SUBSCRIPTIONS = Object.freeze([
  ROUTE_SUBSCRIPTION_OID,
  CONTROL_READY_OID,
  TAKE_ERROR_OID,
])

export class UltrixOgpClient {
  private readonly requests: UltrixOgpRequests
  private readonly options: UltrixOgpClientOptions
  private readonly limits: OgpRouteLimits
  private readonly panelId: number
  private readonly socketFactory: () => Socket
  private readonly listeners = new Set<(event: UltrixOgpClientEvent) => void>()
  private readonly decoder = new OgpNetstringDecoder()
  private readonly sources = new Map<number, OgpRouterLabel>()
  private readonly destinations = new Map<number, OgpRouterLabel>()
  private readonly routes = new Map<string, OgpCrosspoint>()
  private readonly bufferedSubscriptionRoutes = new Map<string, OgpCrosspoint>()
  private bufferedSubscriptionControlReady: boolean | null = null
  private bufferedSubscriptionTakeError: string | null = null
  private socket: Socket | null = null
  private connectionGeneration = 0
  private phase: UltrixOgpConnectionPhase = 'disconnected'
  private revision = 0
  private catalogRevision = 0
  private controlReady = false
  private takeError: string | null = null
  private levelCatalog: readonly OgpLevel[] = Object.freeze([])
  private subscriptions: readonly string[] = Object.freeze([])
  private multiSetEnabled = false
  private lastError: string | null = null
  private connectPromise: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private subscriptionRequested = false
  private synchronizationStarted = false
  private bufferSubscriptionRoutes = false
  private routeWriteTail: Promise<void> = Promise.resolve()

  public constructor(options: UltrixOgpClientOptions) {
    if (options.host.trim().length === 0) throw new Error('host must not be empty')
    positiveInteger(options.port, 'port', 65_535)
    positiveInteger(options.levels, 'levels', 256)
    positiveInteger(options.sourceLimit, 'sourceLimit', 65_536)
    positiveInteger(options.destinationLimit, 'destinationLimit', 65_536)
    positiveInteger(options.requestTimeoutMs, 'requestTimeoutMs', 120_000)
    if (options.connectTimeoutMs !== undefined) {
      positiveInteger(options.connectTimeoutMs, 'connectTimeoutMs', 120_000)
    }
    this.panelId = positiveInteger(options.panelId ?? DEFAULT_OGP_PANEL_ID, 'panelId', 65_535)
    this.requests = new UltrixOgpRequests(options.requestTimeoutMs, {
      generation: () => this.connectionGeneration,
      requireActiveConnection: () => this.requireActiveConnection(),
      assertGeneration: (value) => this.assertGeneration(value),
      write: (bytes) => this.write(bytes),
    })
    this.options = Object.freeze({ ...options })
    this.limits = Object.freeze({
      levels: options.levels,
      sourceLimit: options.sourceLimit,
      destinationLimit: options.destinationLimit,
    })
    this.socketFactory = options.socketFactory ?? (() => new net.Socket())
  }

  public connect(): Promise<void> {
    if (this.phase === 'connected') return Promise.resolve()
    if (this.connectPromise !== null) return this.connectPromise

    const generation = ++this.connectionGeneration
    this.lastError = null
    this.subscriptionRequested = false
    this.synchronizationStarted = false
    this.bufferSubscriptionRoutes = false
    this.clearBufferedSubscriptionDeltas()
    this.decoder.reset()
    this.transition('connecting', null)
    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })
    this.connectPromise = promise

    let socket: Socket
    try {
      socket = this.socketFactory()
      this.socket = socket
      this.bindSocket(socket)
      socket.connect({ host: this.options.host, port: this.options.port })
    } catch (error) {
      this.failConnection(new Error(`Unable to start OGP connection: ${errorMessage(error)}`))
      return promise
    }

    const timeoutMs =
      this.options.connectTimeoutMs ?? Math.max(10_000, this.options.requestTimeoutMs * 4)
    this.connectTimer = setTimeout(() => {
      if (generation !== this.connectionGeneration) return
      this.failConnection(new Error('Ultrix OGP connection timed out during synchronization'))
    }, timeoutMs)
    return promise
  }

  public disconnect(): void {
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.finishDisconnected(null)
  }

  public async refreshNames(): Promise<void> {
    this.requireActiveConnection()
    const generation = this.connectionGeneration
    const sourceReferences = Array.from({ length: this.options.sourceLimit }, (_, index) =>
      Object.freeze({
        oid: 'params.basicsources',
        element: true as const,
        index,
      }),
    )
    const destinationReferences = Array.from(
      { length: this.options.destinationLimit },
      (_, index) =>
        Object.freeze({
          oid: 'params.basicdests',
          element: true as const,
          index,
        }),
    )
    const values = await this.requests.requestValues([
      ...sourceReferences,
      ...destinationReferences,
    ])
    this.assertGeneration(generation)
    const nextSources = new Map<number, OgpRouterLabel>()
    const nextDestinations = new Map<number, OgpRouterLabel>()
    for (const reference of sourceReferences) {
      const payload = values.get(referenceKey(reference))
      if (payload === undefined) throw new Error('Missing OGP source catalog response')
      const label = parseCatalogElement('params.basicsources', reference.index, payload.value)
      nextSources.set(label.address, label)
    }
    for (const reference of destinationReferences) {
      const payload = values.get(referenceKey(reference))
      if (payload === undefined) throw new Error('Missing OGP destination catalog response')
      const label = parseCatalogElement('params.basicdests', reference.index, payload.value)
      nextDestinations.set(label.address, label)
    }
    this.sources.clear()
    this.destinations.clear()
    for (const [address, label] of nextSources) this.sources.set(address, label)
    for (const [address, label] of nextDestinations) this.destinations.set(address, label)
    this.catalogRevision += 1
    this.emit({ type: 'names', names: this.nameSnapshot() })
  }

  public async refreshRoutes(): Promise<void> {
    this.requireActiveConnection()
    const generation = this.connectionGeneration
    const references = Array.from({ length: this.options.destinationLimit }, (_, index) =>
      Object.freeze({
        oid: ROUTE_STATUS_OID,
        element: true as const,
        index,
      }),
    )
    const values = await this.requests.requestValues(references)
    this.assertGeneration(generation)
    for (const reference of references) {
      const payload = values.get(referenceKey(reference))
      if (payload === undefined) throw new Error('Missing OGP destination status response')
      this.applyCrosspoints(parseDestinationStatus(reference.index, payload.value, this.limits))
    }
  }

  public async readDestination(
    destination: number,
    levels?: readonly number[],
  ): Promise<readonly OgpCrosspoint[]> {
    this.validateDestination(destination)
    const selectedLevels = this.validateLevels(levels)
    this.requireActiveConnection()
    const generation = this.connectionGeneration
    const crosspoints = await this.requestDestination(destination)
    this.assertGeneration(generation)
    this.applyCrosspoints(crosspoints)
    const selected = new Set(selectedLevels)
    return Object.freeze(crosspoints.filter((entry) => selected.has(entry.level)))
  }

  private async requestDestination(
    destination: number,
    suppressRouteApplication = false,
  ): Promise<readonly OgpCrosspoint[]> {
    const generation = this.connectionGeneration
    const reference = Object.freeze({
      oid: ROUTE_STATUS_OID,
      element: true as const,
      index: destination - 1,
    })
    const values = await this.requests.requestValues([reference], suppressRouteApplication)
    this.assertGeneration(generation)
    const payload = values.get(referenceKey(reference))
    if (payload === undefined) throw new Error('Missing OGP destination readback')
    return parseDestinationStatus(destination - 1, payload.value, this.limits)
  }

  public async setCrosspoint(input: {
    readonly source: number
    readonly destination: number
    readonly levels?: readonly number[]
  }): Promise<void> {
    this.validateSource(input.source)
    this.validateDestination(input.destination)
    const levels = this.validateLevels(input.levels)
    this.requireConnected()
    const generation = this.connectionGeneration
    const task = this.routeWriteTail.then(() => {
      this.assertGeneration(generation)
      return performSetCrosspoint(
        {
          controlReady: this.controlReady,
          multiSetEnabled: this.multiSetEnabled,
          panelId: this.panelId,
          routes: this.routes,
          requests: this.requests,
          requireConnected: () => this.requireConnected(),
          write: (bytes) => this.write(bytes),
          assertGeneration: (value) => this.assertGeneration(value),
          requestDestination: (destination, suppress) =>
            this.requestDestination(destination, suppress),
          readDestination: (destination, levels) => this.readDestination(destination, levels),
          applyCrosspoints: (crosspoints) => this.applyCrosspoints(crosspoints),
        },
        { source: input.source, destination: input.destination, levels },
        generation,
      )
    })
    this.routeWriteTail = task.then(
      () => undefined,
      () => undefined,
    )
    await task
  }

  public snapshot(): UltrixOgpSnapshot {
    return Object.freeze({
      phase: this.phase,
      revision: this.revision,
      catalogRevision: this.catalogRevision,
      controlReady: this.controlReady,
      takeError: this.takeError,
      sources: sortedLabels(this.sources),
      destinations: sortedLabels(this.destinations),
      levels: sortedLevels(this.levelCatalog),
      routes: sortedRoutes(this.routes),
      subscriptions: Object.freeze([...this.subscriptions]),
      multiSetEnabled: this.multiSetEnabled,
      lastError: this.lastError,
    })
  }

  public subscribe(listener: (event: UltrixOgpClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bindSocket(socket: Socket): void {
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    socket.on('connect', () => {
      if (socket !== this.socket) return
      this.transition('handshaking', null)
      this.write(
        encodeHandshake({
          trusted: true,
          detail: 'minimal',
          subscriptions: true,
          build: 'Hubble Ross Ultrix OGP',
        }),
      )
    })
    socket.on('data', (chunk: Buffer) => {
      if (socket !== this.socket) return
      try {
        for (const frame of this.decoder.push(chunk)) {
          if (socket !== this.socket) break
          const decoded = decodeOgpFrame(frame)
          if (decoded.kind === 'keepalive' || decoded.kind === 'unknown') continue
          this.handleMessage(decoded.message)
        }
      } catch (error) {
        this.failConnection(
          new Error(`Invalid Ultrix OGP stream: ${errorMessage(error)}`),
          'invalid-stream',
        )
      }
    })
    socket.on('error', (error) => {
      if (socket !== this.socket) return
      this.failConnection(new Error(`Ultrix OGP socket error: ${error.message}`))
    })
    socket.on('close', () => {
      if (socket !== this.socket) return
      this.socket = null
      this.finishDisconnected(
        this.phase === 'disconnected' ? this.lastError : 'Ultrix OGP socket closed',
      )
    })
  }

  private handleMessage(message: OgpMessage): void {
    if (message.type === 'handshake') {
      const payload = objectValue(message.payload, 'OGP handshake payload')
      if (payload.disconnect === true) {
        const reason =
          typeof payload.reason === 'string'
            ? payload.reason
                .replace(/\p{Cc}/gu, ' ')
                .trim()
                .slice(0, 160)
            : 'no reason supplied'
        this.failConnection(
          new Error(
            `Ultrix OGP router refused the connection (${reason}). Check other active OGP clients and the router's session settings.`,
          ),
          'handshake-rejected',
        )
      }
      return
    }
    if (message.type === 'device') {
      this.handleDevice(message)
      return
    }
    if (message.type === 'value') {
      this.handleValuePayload(
        message.payload,
        false,
        message.slot !== undefined && message.slot !== 0,
      )
      return
    }
    if (message.type === 'multi-value') {
      if (!Array.isArray(message.payload)) {
        throw new Error('OGP multi-value payload must be an array')
      }
      const crosspoints = message.payload.flatMap(
        (payload) =>
          this.handleValuePayload(
            payload,
            true,
            message.slot !== undefined && message.slot !== 0,
          ) ?? [],
      )
      this.applyOrBufferCrosspoints(
        crosspoints,
        message.slot !== undefined && message.slot !== 0,
      )
      return
    }
    if (message.type === 'error') {
      const payload =
        typeof message.payload === 'object' && message.payload !== null
          ? JSON.stringify(message.payload)
          : String(message.payload)
      this.emit({
        type: 'protocol-error',
        code: 'device-error',
        message: payload,
      })
      return
    }
    if (message.type === 'restart') {
      this.failConnection(new Error('Ultrix OGP device restarted'), 'device-restart')
    }
  }

  private handleDevice(message: OgpMessage): void {
    if (this.phase === 'handshaking') {
      if (!isImplicitHandshakeSuccess(message)) {
        throw new Error('Ultrix OGP handshake did not return a device document')
      }
      this.transition('synchronizing', null)
      if (!this.subscriptionRequested) {
        this.subscriptionRequested = true
        this.write(encodeSubscriptionRequest(REQUIRED_SUBSCRIPTIONS))
      }
      return
    }
    if (this.phase !== 'synchronizing' && this.phase !== 'connected') return
    const payload = objectValue(message.payload, 'OGP device payload')
    if (payload.detail !== 'subscription') return
    const subscriptions = payload.subscription
    if (
      !Array.isArray(subscriptions) ||
      subscriptions.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('OGP subscription device is missing its subscription list')
    }
    const subscriptionSet = new Set(subscriptions as string[])
    if (
      !(subscriptionSet.has(ROUTE_SUBSCRIPTION_OID) || subscriptionSet.has(ROUTE_STATUS_OID)) ||
      !subscriptionSet.has(CONTROL_READY_OID) ||
      !subscriptionSet.has(TAKE_ERROR_OID)
    ) {
      throw new Error('OGP device did not accept all required route subscriptions')
    }
    this.subscriptions = Object.freeze([...(subscriptions as string[])])
    const validated = validateDeviceParameterDescriptors(payload.params)
    this.multiSetEnabled =
      typeof payload['multi-set-enabled'] === 'boolean'
        ? payload['multi-set-enabled']
        : (validated.multiSetEnabled ?? true)
    this.setControlReady(validated.controlReady)
    this.setTakeError(validated.takeError)
    for (let index = 0; index < validated.statusRows.length; index += 1) {
      this.applyCrosspoints(
        parseDestinationStatus(index, validated.statusRows[index], this.limits),
      )
    }
    if (!this.synchronizationStarted) {
      this.synchronizationStarted = true
      const generation = this.connectionGeneration
      void this.synchronize(generation).catch((error: unknown) => {
        // A refresh may already have opened a replacement socket before this rejection runs.
        if (generation !== this.connectionGeneration) return
        this.failConnection(
          new Error(`Ultrix OGP synchronization failed: ${errorMessage(error)}`),
          'synchronization-failed',
        )
      })
    }
  }

  private async synchronize(generation: number): Promise<void> {
    this.bufferSubscriptionRoutes = true
    this.clearBufferedSubscriptionDeltas()
    try {
      await this.refreshNames()
      this.assertGeneration(generation)
      const levelsReference = Object.freeze({ oid: 'params.levels' })
      const levelValues = await this.requests.requestValues([levelsReference])
      this.assertGeneration(generation)
      const levelsPayload = levelValues.get(referenceKey(levelsReference))
      if (levelsPayload === undefined) throw new Error('Missing OGP level catalog response')
      this.levelCatalog = parseLevels(levelsPayload.value, this.options.levels)
      this.emit({ type: 'levels', levels: sortedLevels(this.levelCatalog) })
      await this.refreshRoutes()
      this.assertGeneration(generation)
      const controlReference = Object.freeze({ oid: CONTROL_READY_OID })
      const takeErrorReference = Object.freeze({ oid: TAKE_ERROR_OID })
      const statusValues = await this.requests.requestValues([
        controlReference,
        takeErrorReference,
      ])
      this.assertGeneration(generation)
      const control = statusValues.get(referenceKey(controlReference))
      const takeError = statusValues.get(referenceKey(takeErrorReference))
      if (control === undefined || takeError === undefined) {
        throw new Error('Missing OGP control status response')
      }
      this.setControlReady(control.value)
      this.setTakeError(takeError.value)
      this.bufferSubscriptionRoutes = false
      this.replayBufferedSubscriptionDeltas()
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.bufferSubscriptionRoutes = false
        this.clearBufferedSubscriptionDeltas()
      }
      throw error
    }
    this.transition('connected', null)
    this.clearConnectTimer()
    const resolve = this.connectResolve
    this.connectResolve = null
    this.connectReject = null
    this.connectPromise = null
    resolve?.()
  }

  private handleValuePayload(
    value: unknown,
    deferRoutes = false,
    subscription = false,
  ): readonly OgpCrosspoint[] | null {
    const payload = objectValue(value, 'OGP value payload') as unknown as OgpValuePayload
    if (typeof payload.oid !== 'string') throw new Error('OGP value payload is missing its OID')
    const suppressRouteApplication = !subscription && this.requests.observePendingValue(payload)

    const crosspoints = parseRouteValue(payload, this.limits)
    if (crosspoints !== null) {
      if (!deferRoutes && !suppressRouteApplication) {
        this.applyOrBufferCrosspoints(crosspoints, subscription)
      }
      return crosspoints
    }
    if (payload.oid === CONTROL_READY_OID) {
      this.applyOrBufferControlReady(payload.value, subscription)
      return null
    }
    if (payload.oid === TAKE_ERROR_OID) this.applyOrBufferTakeError(payload.value, subscription)
    return null
  }

  private applyOrBufferCrosspoints(
    crosspoints: readonly OgpCrosspoint[],
    subscription: boolean,
  ): void {
    if (subscription && this.bufferSubscriptionRoutes) {
      for (const crosspoint of crosspoints) {
        this.bufferedSubscriptionRoutes.set(
          routeKey(crosspoint.destination, crosspoint.level),
          immutableCrosspoint(crosspoint),
        )
      }
      return
    }
    this.applyCrosspoints(crosspoints)
  }

  private replayBufferedSubscriptionDeltas(): void {
    const crosspoints = [...this.bufferedSubscriptionRoutes.values()]
    const controlReady = this.bufferedSubscriptionControlReady
    const takeError = this.bufferedSubscriptionTakeError
    this.clearBufferedSubscriptionDeltas()
    this.applyCrosspoints(crosspoints)
    if (controlReady !== null) this.setControlReady(controlReady)
    if (takeError !== null) this.setTakeError(takeError)
  }

  private clearBufferedSubscriptionDeltas(): void {
    this.bufferedSubscriptionRoutes.clear()
    this.bufferedSubscriptionControlReady = null
    this.bufferedSubscriptionTakeError = null
  }

  private applyOrBufferControlReady(value: unknown, subscription: boolean): void {
    const ready = controlReadyValue(value)
    if (subscription && this.bufferSubscriptionRoutes) {
      this.bufferedSubscriptionControlReady = ready
      return
    }
    this.setControlReady(ready)
  }

  private applyOrBufferTakeError(value: unknown, subscription: boolean): void {
    const error = takeErrorValue(value)
    if (subscription && this.bufferSubscriptionRoutes) {
      this.bufferedSubscriptionTakeError = error
      return
    }
    this.setTakeError(error)
  }

  private applyCrosspoints(crosspoints: readonly OgpCrosspoint[]): void {
    if (crosspoints.length === 0) return
    const immutable = crosspoints.map(immutableCrosspoint)
    const changed = immutable.filter((entry) => {
      const previous = this.routes.get(routeKey(entry.destination, entry.level))
      return previous === undefined || previous.source !== entry.source
    })
    const previousRevision = this.revision
    if (changed.length > 0) {
      this.revision += 1
      for (const entry of changed) {
        this.routes.set(routeKey(entry.destination, entry.level), entry)
      }
      if (changed.length === 1) {
        this.emit({
          type: 'route',
          crosspoint: changed[0]!,
          previousRevision,
          revision: this.revision,
        })
      } else {
        this.emit({
          type: 'routes',
          crosspoints: Object.freeze([...changed]),
          previousRevision,
          revision: this.revision,
        })
      }
    }
    for (const entry of immutable) {
      this.requests.observeRouteConfirmation(entry)
      this.emit({
        type: 'route-observation',
        crosspoint: entry,
        revision: this.revision,
      })
    }
  }

  private setControlReady(value: unknown): void {
    const ready = controlReadyValue(value)
    if (ready === this.controlReady) return
    this.controlReady = ready
    this.emit({ type: 'control-ready', ready })
  }

  private setTakeError(value: unknown): void {
    const takeError = takeErrorValue(value)
    if (takeError === this.takeError) return
    this.takeError = takeError
    this.emit({ type: 'take-error', error: takeError })
  }

  private validateSource(source: number): void {
    positiveInteger(source, 'source', this.options.sourceLimit)
  }

  private validateDestination(destination: number): void {
    positiveInteger(destination, 'destination', this.options.destinationLimit)
  }

  private validateLevels(levels: readonly number[] | undefined): readonly number[] {
    const selected =
      levels === undefined
        ? Array.from({ length: this.options.levels }, (_, index) => index + 1)
        : [...levels]
    if (selected.length === 0) throw new Error('At least one OGP route level is required')
    const unique = new Set<number>()
    for (const level of selected) {
      positiveInteger(level, 'level', this.options.levels)
      if (unique.has(level)) throw new Error(`Duplicate OGP route level ${String(level)}`)
      unique.add(level)
    }
    return Object.freeze([...unique].sort((left, right) => left - right))
  }

  private nameSnapshot(): OgpNameCatalogSnapshot {
    return Object.freeze({
      revision: this.catalogRevision,
      sources: sortedLabels(this.sources),
      destinations: sortedLabels(this.destinations),
    })
  }

  private requireActiveConnection(): void {
    if (
      this.socket === null ||
      (this.phase !== 'synchronizing' && this.phase !== 'connected')
    ) {
      throw new Error('Ultrix OGP client is not connected')
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.connectionGeneration) {
      throw new Error('Ultrix OGP connection changed; operation cancelled')
    }
  }

  private requireConnected(): void {
    if (this.socket === null || this.phase !== 'connected') {
      throw new Error('Ultrix OGP client is not connected')
    }
  }

  private write(bytes: Buffer): void {
    const socket = this.socket
    if (socket === null || socket.destroyed) throw new Error('Ultrix OGP socket is not open')
    socket.write(bytes)
  }

  private transition(phase: UltrixOgpConnectionPhase, error: string | null): void {
    this.phase = phase
    this.lastError = error
    this.emit({ type: 'phase', phase, error })
  }

  private emit(event: UltrixOgpClientEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private failConnection(error: Error, code = 'connection-failed'): void {
    this.emit({ type: 'protocol-error', code, message: error.message })
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.finishDisconnected(error.message, error)
  }

  private finishDisconnected(message: string | null, cause?: Error): void {
    this.connectionGeneration += 1
    this.clearConnectTimer()
    const error = cause ?? new Error(message ?? 'Ultrix OGP client disconnected')
    this.requests.rejectAll(error)
    this.bufferSubscriptionRoutes = false
    this.clearBufferedSubscriptionDeltas()
    const reject = this.connectReject
    this.connectResolve = null
    this.connectReject = null
    this.connectPromise = null
    reject?.(error)
    if (this.routes.size > 0) {
      const previousRevision = this.revision
      this.routes.clear()
      this.revision += 1
      this.emit({
        type: 'routes-reset',
        previousRevision,
        revision: this.revision,
      })
    }
    this.controlReady = false
    this.subscriptions = Object.freeze([])
    this.multiSetEnabled = false
    if (this.phase !== 'disconnected' || this.lastError !== message) {
      this.transition('disconnected', message)
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }
}
