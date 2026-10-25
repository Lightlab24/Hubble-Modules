import net, { type Socket } from 'node:net'
import type {
  VideohubClientEvent,
  VideohubClientOptions,
  VideohubConnectionPhase,
  VideohubDeviceSnapshot,
  VideohubRouteResult,
  VideohubSnapshot,
} from './client-types.js'
import {
  coversAddresses,
  disconnectedError,
  errorMessage,
  immutableDevice,
  positiveInteger,
  sortedLabels,
  sortedLocks,
  sortedRoutes,
} from './client-values.js'
import { VideohubNameCatalog } from './name-catalog.js'
import { VideohubRequests } from './requests.js'
import { performSetCrosspoints } from './route-write.js'
export type * from './client-types.js'

import { VideohubSectionDecoder } from './decoder.js'
import {
  MAX_VIDEOHUB_ADDRESS,
  VideohubError,
  assertHubbleAddress,
  encodePing,
  encodeStatusRequest,
  immutableCrosspoint,
  immutableLock,
  type VideohubCrosspoint,
  type VideohubDeviceStatus,
  type VideohubErrorCode,
  type VideohubOutputLock,
  type VideohubProtocolMessage,
  type VideohubStatusHeader,
} from './protocol.js'

export class VideohubClient {
  private readonly requests: VideohubRequests
  private readonly catalog: VideohubNameCatalog
  private readonly options: VideohubClientOptions
  private readonly socketFactory: () => Socket
  private readonly listeners = new Set<(event: VideohubClientEvent) => void>()
  private readonly routes = new Map<number, VideohubCrosspoint>()
  private readonly locks = new Map<number, VideohubOutputLock>()
  private socket: Socket | null = null
  private decoder: VideohubSectionDecoder
  private epoch = 0
  private deviceGeneration = 0
  private phase: VideohubConnectionPhase = 'disconnected'
  private revision = 0
  private confirmedOperationSequence = 0
  private protocolVersion: string | null = null
  private deviceStatus: VideohubDeviceStatus = 'unknown'
  private modelName: string | null = null
  private detectedSourceCount: number | null = null
  private detectedDestinationCount: number | null = null
  private sourceCount: number | null = null
  private destinationCount: number | null = null
  private catalogIdentity: Readonly<{
    modelName: string | null
    sourceCount: number
    destinationCount: number
  }> | null = null
  private lastError: string | null = null
  private routesHydrated = false
  private locksHydrated = false
  private connectPromise: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private synchronizationTimer: NodeJS.Timeout | null = null
  private commandTail: Promise<void> = Promise.resolve()

  public constructor(options: VideohubClientOptions) {
    if (options.host.trim().length === 0) throw new Error('host must not be empty')
    positiveInteger(options.port, 'port', 65_535)
    positiveInteger(options.requestTimeoutMs, 'requestTimeoutMs', 120_000)
    if (options.connectTimeoutMs !== undefined) {
      positiveInteger(options.connectTimeoutMs, 'connectTimeoutMs', 120_000)
    }
    if (options.sourceLimit !== undefined) {
      positiveInteger(options.sourceLimit, 'sourceLimit', MAX_VIDEOHUB_ADDRESS)
    }
    if (options.destinationLimit !== undefined) {
      positiveInteger(options.destinationLimit, 'destinationLimit', MAX_VIDEOHUB_ADDRESS)
    }
    if (options.maxBufferedBytes !== undefined) {
      positiveInteger(options.maxBufferedBytes, 'maxBufferedBytes', 64 * 1_048_576)
    }
    this.options = Object.freeze({ ...options })
    this.socketFactory = options.socketFactory ?? (() => new net.Socket())
    this.requests = new VideohubRequests(options.requestTimeoutMs, {
      epoch: () => this.epoch,
      requireActiveConnection: () => this.requireActiveConnection(),
      write: (bytes) => this.write(bytes),
      failConnection: (error) => this.failConnection(error),
    })
    this.catalog = new VideohubNameCatalog({
      requireDetectedSourceCount: () => this.requireDetectedSourceCount(),
      requireDetectedDestinationCount: () => this.requireDetectedDestinationCount(),
      sourceCount: () => this.sourceCount,
      destinationCount: () => this.destinationCount,
      detectedSourceCount: () => this.detectedSourceCount,
      detectedDestinationCount: () => this.detectedDestinationCount,
      emit: (event) => this.emit(event),
    })
    this.decoder = this.createDecoder()
  }

  public connect(): Promise<void> {
    if (this.phase === 'connected') return Promise.resolve()
    if (this.connectPromise !== null) return this.connectPromise
    if (this.socket !== null) {
      return Promise.reject(
        new VideohubError('protocol-error', 'Videohub socket is already active'),
      )
    }
    this.epoch += 1
    const epoch = this.epoch
    this.lastError = null
    this.decoder = this.createDecoder()
    this.resetSessionForReconnect()
    this.transition('connecting', null)
    const connection = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })
    this.connectPromise = connection
    this.armSynchronizationTimer(epoch, 'Videohub connection timed out during synchronization')

    try {
      const socket = this.socketFactory()
      this.socket = socket
      this.bindSocket(socket, epoch)
      socket.connect({ host: this.options.host, port: this.options.port })
    } catch (error) {
      this.failConnection(
        new VideohubError(
          'disconnected',
          `Unable to start Videohub connection: ${errorMessage(error)}`,
        ),
      )
    }
    return connection
  }

  public disconnect(): void {
    const socket = this.socket
    this.socket = null
    this.epoch += 1
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.finishDisconnected(null)
  }

  public snapshot(): VideohubSnapshot {
    return Object.freeze({
      phase: this.phase,
      revision: this.revision,
      catalogRevision: this.catalog.catalogRevision,
      confirmedOperationSequence: this.confirmedOperationSequence,
      protocolVersion: this.protocolVersion,
      deviceStatus: this.deviceStatus,
      modelName: this.modelName,
      detectedSourceCount: this.detectedSourceCount,
      detectedDestinationCount: this.detectedDestinationCount,
      sourceCount: this.sourceCount,
      destinationCount: this.destinationCount,
      sources: sortedLabels(this.catalog.sources, this.sourceCount),
      destinations: sortedLabels(this.catalog.destinations, this.destinationCount),
      routes: sortedRoutes(this.routes, this.sourceCount, this.destinationCount),
      locks: sortedLocks(this.locks, this.destinationCount),
      labelsDegraded: this.catalog.labelsDegraded,
      catalogStale: this.catalog.catalogStale,
      lastError: this.lastError,
    })
  }

  public subscribe(listener: (event: VideohubClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public refreshNames(): Promise<void> {
    return this.enqueueCommand(async () => {
      this.requireConnected()
      this.catalog.nameRefreshActive = true
      this.catalog.refreshedSources = null
      this.catalog.refreshedDestinations = null
      this.catalog.bufferedSourceLabelDeltas.clear()
      this.catalog.bufferedDestinationLabelDeltas.clear()
      let completed = false
      try {
        const input = await this.requestCompleteBlock('INPUT LABELS', true)
        const output = await this.requestCompleteBlock('OUTPUT LABELS', true)
        if (input.type !== 'input-labels' || output.type !== 'output-labels') {
          throw new VideohubError('protocol-error', 'Videohub returned the wrong label block')
        }
        this.catalog.replaceBothCatalogs(input.labels, output.labels)
        completed = true
      } finally {
        if (!completed) this.catalog.replayBufferedNameDeltas()
        this.catalog.nameRefreshActive = false
        this.catalog.refreshedSources = null
        this.catalog.refreshedDestinations = null
        this.catalog.bufferedSourceLabelDeltas.clear()
        this.catalog.bufferedDestinationLabelDeltas.clear()
      }
    })
  }

  public refreshRoutes(): Promise<void> {
    return this.enqueueCommand(async () => {
      this.requireConnected()
      await this.requestCompleteBlock('VIDEO OUTPUT ROUTING', true)
    })
  }

  public ping(): Promise<void> {
    return this.enqueueCommand(async () => {
      this.requireConnected()
      await this.requests.sendWithAcknowledgement(encodePing())
    })
  }

  public readDestination(destination: number): Promise<VideohubCrosspoint> {
    this.validateDestination(destination)
    return this.enqueueCommand(async () => {
      this.requireConnected()
      await this.requestCompleteBlock('VIDEO OUTPUT ROUTING', true)
      const route = this.routes.get(destination)
      if (route === undefined) {
        throw new VideohubError(
          'protocol-error',
          `Videohub did not report destination ${String(destination)}`,
        )
      }
      return immutableCrosspoint(route)
    })
  }

  public async setCrosspoint(crosspoint: VideohubCrosspoint): Promise<void> {
    const [result] = await this.setCrosspoints([crosspoint])
    if (result === undefined) throw new Error('Videohub route result is missing')
    if (result.status === 'failed') throw result.error
    this.confirmedOperationSequence += 1
  }

  public setCrosspoints(
    crosspoints: readonly VideohubCrosspoint[],
  ): Promise<readonly VideohubRouteResult[]> {
    if (crosspoints.length === 0) return Promise.resolve(Object.freeze([]))
    const normalized = crosspoints.map((crosspoint) => {
      this.validateSource(crosspoint.source)
      this.validateDestination(crosspoint.destination)
      return immutableCrosspoint(crosspoint)
    })
    const destinations = new Set<number>()
    for (const crosspoint of normalized) {
      if (destinations.has(crosspoint.destination)) {
        throw new Error(`Duplicate Videohub destination ${String(crosspoint.destination)}`)
      }
      destinations.add(crosspoint.destination)
    }
    return this.enqueueCommand(() =>
      performSetCrosspoints(
        {
          requireConnected: () => this.requireConnected(),
          validateSource: (value) => this.validateSource(value),
          validateDestination: (value) => this.validateDestination(value),
          locks: this.locks,
          routes: this.routes,
          requests: this.requests,
          requestCompleteBlock: (header, acknowledgement) =>
            this.requestCompleteBlock(header, acknowledgement),
        },
        normalized,
      ),
    )
  }

  private bindSocket(socket: Socket, epoch: number): void {
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    socket.on('connect', () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.transition('synchronizing', null)
    })
    socket.on('data', (chunk: Buffer) => {
      if (!this.isCurrentSocket(socket, epoch)) return
      try {
        for (const message of this.decoder.push(chunk)) this.handleMessage(message, epoch)
      } catch (error) {
        const code: VideohubErrorCode = /must be an integer from 1 to 65536/iu.test(
          errorMessage(error),
        )
          ? 'unsupported-dimensions'
          : 'protocol-error'
        this.emit({
          type: 'protocol-error',
          code,
          message: errorMessage(error),
        })
        this.failConnection(
          new VideohubError(code, `Invalid Videohub stream: ${errorMessage(error)}`, {
            cause: error,
          }),
        )
      }
    })
    socket.on('error', (error) => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.failConnection(
        new VideohubError('disconnected', `Videohub socket error: ${error.message}`, {
          cause: error,
        }),
      )
    })
    socket.on('close', () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.socket = null
      this.finishDisconnected(
        this.phase === 'disconnected'
          ? this.lastError
          : (this.lastError ?? 'Videohub socket closed'),
      )
    })
  }

  private handleMessage(message: VideohubProtocolMessage, epoch: number): void {
    if (message.type === 'ack') {
      this.requests.settleAcknowledgement(true, epoch)
      this.requests.notifyMessageWaiters(message, epoch)
      return
    }
    if (message.type === 'nak') {
      this.requests.settleAcknowledgement(false, epoch)
      this.requests.notifyMessageWaiters(message, epoch)
      return
    }
    switch (message.type) {
      case 'protocol-preamble':
        if (message.major !== 2) {
          throw new VideohubError(
            'protocol-error',
            `Unsupported Videohub protocol major version ${String(message.major)}`,
          )
        }
        this.protocolVersion = message.version
        break
      case 'device':
        this.handleDevice(message, epoch)
        break
      case 'input-labels':
        this.catalog.handleInputLabels(message.labels)
        break
      case 'output-labels':
        this.catalog.handleOutputLabels(message.labels)
        break
      case 'video-output-routing':
        this.handleRoutes(message.crosspoints)
        break
      case 'video-output-locks':
        this.handleLocks(message.locks)
        break
      case 'unknown':
        break
    }
    this.requests.notifyMessageWaiters(message, epoch)
    this.maybeConnected()
  }

  private handleDevice(
    device: Extract<VideohubProtocolMessage, { type: 'device' }>,
    epoch: number,
  ): void {
    if (this.protocolVersion === null) {
      throw new VideohubError(
        'protocol-error',
        'VIDEOHUB DEVICE arrived before protocol preamble',
      )
    }
    if (this.deviceStatus !== 'unknown') this.cancelInflightForDeviceChange()
    const preserveStaleCatalog =
      this.catalog.catalogStale &&
      this.catalogIdentity !== null &&
      device.status === 'present' &&
      device.modelName === this.catalogIdentity.modelName &&
      device.videoInputs === this.catalogIdentity.sourceCount &&
      device.videoOutputs === this.catalogIdentity.destinationCount
    this.deviceGeneration += 1
    this.resetForDevice(preserveStaleCatalog)
    this.deviceStatus = device.status
    this.modelName = device.modelName
    this.detectedSourceCount = device.videoInputs
    this.detectedDestinationCount = device.videoOutputs
    if (device.status === 'present') {
      if (device.videoInputs === null || device.videoOutputs === null) {
        throw new VideohubError('unsupported-dimensions', 'Videohub dimensions are unavailable')
      }
      this.sourceCount = Math.min(
        device.videoInputs,
        this.options.sourceLimit ?? device.videoInputs,
      )
      this.destinationCount = Math.min(
        device.videoOutputs,
        this.options.destinationLimit ?? device.videoOutputs,
      )
      this.lastError = null
    } else {
      this.sourceCount = null
      this.destinationCount = null
      this.lastError =
        device.status === 'needs-update'
          ? 'Videohub device firmware needs an update'
          : 'Videohub device is not present'
    }
    this.transition('synchronizing', this.lastError)
    this.armSynchronizationTimer(epoch, 'Videohub device did not complete its status dump')
    this.emit({ type: 'device', device: this.deviceSnapshot() })
  }

  private resetForDevice(preserveStaleCatalog = false): void {
    this.catalog.inputLabelsHydrated = false
    this.catalog.outputLabelsHydrated = false
    this.routesHydrated = false
    this.locksHydrated = false
    this.catalog.labelsDegraded = false
    this.catalog.catalogStale = preserveStaleCatalog
    if (!preserveStaleCatalog) {
      this.catalog.sources.clear()
      this.catalog.destinations.clear()
      this.catalogIdentity = null
      this.catalog.catalogRevision += 1
      this.emit({ type: 'names', names: this.catalog.nameSnapshot() })
    }
    this.clearConfirmedRoutes()
  }

  private handleRoutes(crosspoints: readonly VideohubCrosspoint[]): void {
    const destinationCount = this.requireDetectedDestinationCount()
    const sourceCount = this.requireDetectedSourceCount()
    const valid = crosspoints.filter(
      (crosspoint) =>
        crosspoint.destination <= destinationCount && crosspoint.source <= sourceCount,
    )
    if (!this.routesHydrated) {
      if (
        !coversAddresses(
          valid.map((entry) => entry.destination),
          destinationCount,
        )
      ) {
        throw new VideohubError(
          'protocol-error',
          'Initial VIDEO OUTPUT ROUTING block did not cover every detected destination',
        )
      }
      this.routesHydrated = true
      this.applyRoutes(valid, true)
      return
    }
    const complete = coversAddresses(
      valid.map((entry) => entry.destination),
      destinationCount,
    )
    this.applyRoutes(valid, complete)
  }

  private handleLocks(locks: readonly VideohubOutputLock[]): void {
    const destinationCount = this.requireDetectedDestinationCount()
    const valid = locks.filter((lock) => lock.destination <= destinationCount)
    if (!this.locksHydrated) {
      if (
        !coversAddresses(
          valid.map((entry) => entry.destination),
          destinationCount,
        )
      ) {
        throw new VideohubError(
          'protocol-error',
          'Initial VIDEO OUTPUT LOCKS block did not cover every detected destination',
        )
      }
      this.locksHydrated = true
      this.applyLocks(valid, true)
      return
    }
    const complete = coversAddresses(
      valid.map((entry) => entry.destination),
      destinationCount,
    )
    this.applyLocks(valid, complete)
  }

  private maybeConnected(): void {
    if (
      this.deviceStatus !== 'present' ||
      !this.catalog.inputLabelsHydrated ||
      !this.catalog.outputLabelsHydrated ||
      !this.routesHydrated ||
      !this.locksHydrated
    ) {
      return
    }
    this.catalog.catalogStale = false
    this.catalogIdentity = Object.freeze({
      modelName: this.modelName,
      sourceCount: this.requireDetectedSourceCount(),
      destinationCount: this.requireDetectedDestinationCount(),
    })
    this.lastError = null
    this.clearSynchronizationTimer()
    this.transition('connected', null)
    this.emit({ type: 'device', device: this.deviceSnapshot() })
    const resolve = this.connectResolve
    this.connectResolve = null
    this.connectReject = null
    this.connectPromise = null
    resolve?.()
  }

  private requestCompleteBlock(
    header: VideohubStatusHeader,
    awaitAcknowledgement: boolean,
  ): Promise<VideohubProtocolMessage> {
    const waiter = this.requests.createMessageWaiter((message) =>
      this.isCompleteBlock(header, message),
    )
    const request = async (): Promise<VideohubProtocolMessage> => {
      try {
        if (awaitAcknowledgement) {
          await this.requests.sendWithAcknowledgement(encodeStatusRequest(header))
        } else {
          this.write(encodeStatusRequest(header))
        }
        return await waiter.promise
      } catch (error) {
        waiter.cancel()
        throw error
      }
    }
    return request()
  }

  private isCompleteBlock(
    header: VideohubStatusHeader,
    message: VideohubProtocolMessage,
  ): boolean {
    if (header === 'INPUT LABELS' && message.type === 'input-labels') {
      return coversAddresses(
        message.labels.map((entry) => entry.address),
        this.requireDetectedSourceCount(),
      )
    }
    if (header === 'OUTPUT LABELS' && message.type === 'output-labels') {
      return coversAddresses(
        message.labels.map((entry) => entry.address),
        this.requireDetectedDestinationCount(),
      )
    }
    if (header === 'VIDEO OUTPUT ROUTING' && message.type === 'video-output-routing') {
      return coversAddresses(
        message.crosspoints.map((entry) => entry.destination),
        this.requireDetectedDestinationCount(),
      )
    }
    if (header === 'VIDEO OUTPUT LOCKS' && message.type === 'video-output-locks') {
      return coversAddresses(
        message.locks.map((entry) => entry.destination),
        this.requireDetectedDestinationCount(),
      )
    }
    return false
  }

  private applyRoutes(crosspoints: readonly VideohubCrosspoint[], replace: boolean): void {
    const previous = new Map(this.routes)
    if (replace) this.routes.clear()
    for (const crosspoint of crosspoints) {
      this.routes.set(crosspoint.destination, immutableCrosspoint(crosspoint))
    }
    const effectiveMaximum = this.destinationCount
    const changed = crosspoints
      .filter(
        (crosspoint) =>
          (effectiveMaximum === null || crosspoint.destination <= effectiveMaximum) &&
          previous.get(crosspoint.destination)?.source !== crosspoint.source,
      )
      .map(immutableCrosspoint)
    const previousRevision = this.revision
    if (changed.length > 0) {
      this.revision += 1
      if (changed.length === 1) {
        const crosspoint = changed[0]
        if (crosspoint !== undefined) {
          this.emit({
            type: 'route',
            crosspoint,
            previousRevision,
            revision: this.revision,
          })
        }
      } else {
        this.emit({
          type: 'routes',
          crosspoints: Object.freeze(changed),
          previousRevision,
          revision: this.revision,
        })
      }
    }
    this.requests.observeRouteConfirmations(this.routes)
    for (const crosspoint of crosspoints) {
      if (effectiveMaximum !== null && crosspoint.destination > effectiveMaximum) continue
      this.emit({
        type: 'route-observation',
        crosspoint: immutableCrosspoint(crosspoint),
        revision: this.revision,
      })
    }
  }

  private applyLocks(locks: readonly VideohubOutputLock[], replace: boolean): void {
    const previous = new Map(this.locks)
    if (replace) this.locks.clear()
    for (const lock of locks) this.locks.set(lock.destination, immutableLock(lock))
    const changed = locks
      .filter(
        (lock) =>
          (this.destinationCount === null || lock.destination <= this.destinationCount) &&
          previous.get(lock.destination)?.state !== lock.state,
      )
      .map(immutableLock)
    const lock = changed[0]
    if (changed.length === 1 && lock !== undefined) this.emit({ type: 'lock', lock })
    else if (changed.length > 1) this.emit({ type: 'locks', locks: Object.freeze(changed) })
  }

  private deviceSnapshot(): VideohubDeviceSnapshot {
    return immutableDevice({
      deviceStatus: this.deviceStatus,
      modelName: this.modelName,
      detectedSourceCount: this.detectedSourceCount,
      detectedDestinationCount: this.detectedDestinationCount,
      sourceCount: this.sourceCount,
      destinationCount: this.destinationCount,
    })
  }

  private clearConfirmedRoutes(): void {
    const previousRevision = this.revision
    const hadRoutes = this.routes.size > 0 || this.locks.size > 0
    this.routes.clear()
    this.locks.clear()
    if (!hadRoutes) return
    this.revision += 1
    this.emit({
      type: 'routes-reset',
      previousRevision,
      revision: this.revision,
    })
  }

  private cancelInflightForDeviceChange(): void {
    const error = new VideohubError(
      'protocol-error',
      'Videohub device changed while an operation was in flight',
    )
    this.requests.rejectAll(error)
    this.catalog.nameRefreshActive = false
    this.catalog.refreshedSources = null
    this.catalog.refreshedDestinations = null
    this.catalog.bufferedSourceLabelDeltas.clear()
    this.catalog.bufferedDestinationLabelDeltas.clear()
  }

  private validateSource(source: number): void {
    assertHubbleAddress(source, 'source')
    const maximum = this.sourceCount ?? this.options.sourceLimit ?? MAX_VIDEOHUB_ADDRESS
    if (source > maximum) {
      throw new RangeError(`source must be an integer from 1 to ${String(maximum)}`)
    }
  }

  private validateDestination(destination: number): void {
    assertHubbleAddress(destination, 'destination')
    const maximum =
      this.destinationCount ?? this.options.destinationLimit ?? MAX_VIDEOHUB_ADDRESS
    if (destination > maximum) {
      throw new RangeError(`destination must be an integer from 1 to ${String(maximum)}`)
    }
  }

  private requireDetectedSourceCount(): number {
    if (this.deviceStatus !== 'present' || this.detectedSourceCount === null) {
      throw new VideohubError('protocol-error', 'Videohub source dimensions are unavailable')
    }
    return this.detectedSourceCount
  }

  private requireDetectedDestinationCount(): number {
    if (this.deviceStatus !== 'present' || this.detectedDestinationCount === null) {
      throw new VideohubError(
        'protocol-error',
        'Videohub destination dimensions are unavailable',
      )
    }
    return this.detectedDestinationCount
  }

  private requireActiveConnection(): void {
    if (this.socket === null || this.phase === 'disconnected') throw disconnectedError()
  }

  private requireConnected(): void {
    if (this.socket === null || this.phase !== 'connected') throw disconnectedError()
  }

  private write(bytes: Buffer): void {
    this.requireActiveConnection()
    const socket = this.socket
    if (socket === null || socket.destroyed || !socket.writable) throw disconnectedError()
    socket.write(bytes)
  }

  private enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
    const submissionEpoch = this.epoch
    const submissionDeviceGeneration = this.deviceGeneration
    const task = this.commandTail.then(() => {
      if (
        submissionEpoch !== this.epoch ||
        submissionDeviceGeneration !== this.deviceGeneration
      ) {
        throw disconnectedError(
          'Videohub is not connected to the session that queued this command',
        )
      }
      return operation()
    })
    this.commandTail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private isCurrentSocket(socket: Socket, epoch: number): boolean {
    return socket === this.socket && epoch === this.epoch
  }

  /**
   * Start every transport epoch without trusting hydration from the previous
   * socket. The last fully synchronized catalogs are intentionally retained as
   * stale operator context until the new device identity and label blocks have
   * been validated.
   */
  private resetSessionForReconnect(): void {
    this.protocolVersion = null
    this.deviceStatus = 'unknown'
    this.modelName = null
    this.detectedSourceCount = null
    this.detectedDestinationCount = null
    this.sourceCount = null
    this.destinationCount = null
    this.catalog.inputLabelsHydrated = false
    this.catalog.outputLabelsHydrated = false
    this.routesHydrated = false
    this.locksHydrated = false
    this.catalog.labelsDegraded = false
    this.requests.resetEpoch()
    this.catalog.nameRefreshActive = false
    this.catalog.refreshedSources = null
    this.catalog.refreshedDestinations = null
    this.catalog.bufferedSourceLabelDeltas.clear()
    this.catalog.bufferedDestinationLabelDeltas.clear()
    this.clearConfirmedRoutes()
    this.catalog.catalogStale =
      this.catalog.sources.size > 0 || this.catalog.destinations.size > 0
  }

  private createDecoder(): VideohubSectionDecoder {
    return new VideohubSectionDecoder(
      this.options.maxBufferedBytes === undefined
        ? {}
        : { maxBufferedBytes: this.options.maxBufferedBytes },
    )
  }

  private transition(phase: VideohubConnectionPhase, error: string | null): void {
    const changed = this.phase !== phase || this.lastError !== error
    this.phase = phase
    this.lastError = error
    if (changed) this.emit({ type: 'phase', phase, error })
  }

  private emit(event: VideohubClientEvent): void {
    const immutable = Object.freeze({ ...event })
    for (const listener of this.listeners) listener(immutable)
  }

  private armSynchronizationTimer(epoch: number, message: string): void {
    this.clearSynchronizationTimer()
    const timeoutMs =
      this.options.connectTimeoutMs ?? Math.max(10_000, this.options.requestTimeoutMs * 4)
    this.synchronizationTimer = setTimeout(() => {
      if (epoch !== this.epoch) return
      this.failConnection(new VideohubError('timeout', message))
    }, timeoutMs)
  }

  private clearSynchronizationTimer(): void {
    if (this.synchronizationTimer !== null) clearTimeout(this.synchronizationTimer)
    this.synchronizationTimer = null
  }

  private failConnection(error: VideohubError): void {
    this.lastError = error.message
    const socket = this.socket
    this.socket = null
    this.epoch += 1
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.finishDisconnected(error.message, error)
  }

  private finishDisconnected(error: string | null, cause?: VideohubError): void {
    this.clearSynchronizationTimer()
    const rejection = cause ?? disconnectedError(error ?? undefined)
    this.requests.rejectAll(rejection)
    this.catalog.nameRefreshActive = false
    this.catalog.refreshedSources = null
    this.catalog.refreshedDestinations = null
    this.catalog.bufferedSourceLabelDeltas.clear()
    this.catalog.bufferedDestinationLabelDeltas.clear()
    this.clearConfirmedRoutes()
    this.catalog.catalogStale =
      this.catalog.sources.size > 0 || this.catalog.destinations.size > 0
    if (this.catalog.catalogStale) {
      this.catalog.catalogRevision += 1
      this.emit({ type: 'names', names: this.catalog.nameSnapshot() })
    }
    this.transition('disconnected', error)
    const reject = this.connectReject
    this.connectResolve = null
    this.connectReject = null
    this.connectPromise = null
    reject?.(rejection)
  }
}
