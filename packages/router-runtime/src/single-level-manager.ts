import { connectionCandidates } from '@hubble/module-contracts/settings'
import { type VideohubClientEvent, type VideohubSnapshot } from '@hubble/protocol-videohub'
import type {
  ManagedRouterConnectionSnapshot,
  RouterConfirmedRouteTarget,
  RouterConfirmedRouteTargetListener,
  RouterConfirmedRouteTargetSnapshot,
  RouterConnectionManagerContract,
  RouterConnectionManagerListener,
  RouterDirectRouteInput,
  RouterDirectRouteSubmission,
  RouterRouteStateListener,
} from '@hubble/router-runtime/connection-contract'
import {
  MAX_ROSS_SWP08_ACTIVE_ROUTE_OPERATIONS,
  RossSwp08RoutingState,
  type RossSwp08DestinationPage,
  type RossSwp08DestinationPageRequest,
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateResult,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RoutePageRequest,
  type RossSwp08RoutingStateSnapshot,
  type RossSwp08SourcePage,
} from '@hubble/router-runtime/routing-state'
import {
  applyCatalogSnapshot,
  applyDeviceMetadata,
  applyLabelPhase,
  applySynchronizingDeviceSnapshot,
  hydrateConnectedSnapshot,
  markDisconnected,
  synchronizeAfterCommand,
  type SingleLevelCatalogContext,
} from './single-level-catalog.js'
import {
  completeRouteOperation,
  enqueueCommand,
  executeInterrogation,
  executeRouteRequest,
  queueLegacyRoute,
  type SingleLevelCommandsContext,
} from './single-level-commands.js'
import { MAX_PENDING_LEGACY_ROUTES } from './single-level-limits.js'
import {
  interrogateRejected,
  routeRejected,
  routeRequestHash,
  snapshotInterrogateRequest,
  snapshotRouteRequest,
} from './single-level-requests.js'
import {
  boundedRouteSnapshot,
  emptyRouteSnapshot,
  errorMessage,
  isUnsupportedDimensionsMessage,
  managedSnapshot,
  mapPhase,
  representableCrosspoint,
  requiresNewClient,
  toSwp08Crosspoint,
} from './single-level-snapshot.js'
import {
  type ConfirmedRouteWatch,
  type ManagedEntry,
  type SingleLevelRouterConnectionDefinition,
  type SingleLevelRouterManagedClientFactory,
} from './single-level-types.js'
import {
  assertVideoLevels,
  validateCurrentAddress,
  validateInterrogateRequest,
  validateRouteRequest,
} from './single-level-validation.js'
import {
  invalidateConfirmedRouteWatches,
  publishConfirmedRouteWatch,
  publishConfirmedRouteWatchesFromRoutes,
  publishConfirmedRouteWatchFromRoutes,
  watchConfirmedRouteTarget,
  type SingleLevelWatchesContext,
} from './single-level-watches.js'
import type { ConnectionDefinition } from './types.js'

export class SingleLevelRouterConnectionManager implements RouterConnectionManagerContract {
  #singleLevelCatalogContext: SingleLevelCatalogContext = {
    publishConfirmedRouteWatchesFromRoutes: (...args) =>
      this.publishConfirmedRouteWatchesFromRoutes(...args),
    invalidateConfirmedRouteWatches: (...args) => this.invalidateConfirmedRouteWatches(...args),
  }

  #singleLevelWatchesContext: SingleLevelWatchesContext = {
    requireEntry: (...args) => this.requireEntry(...args),
  }

  #singleLevelCommandsContext: SingleLevelCommandsContext = {
    assertConnected: (...args) => this.assertConnected(...args),
    assertConnectedOrConfirmedAfterFence: (...args) =>
      this.assertConnectedOrConfirmedAfterFence(...args),
    synchronizeAfterCommand: (...args) => this.synchronizeAfterCommand(...args),
    emit: (...args) => this.emit(...args),
    entryConnected: (...args) => this.entryConnected(...args),
    isCurrentEntry: (connectionId, entry) => this.#entries.get(connectionId) === entry,
  }

  readonly #entries = new Map<string, ManagedEntry>()
  readonly #definitions = new Map<string, SingleLevelRouterConnectionDefinition>()
  readonly #listeners = new Set<RouterConnectionManagerListener>()
  readonly #primaryListeners = new Set<RouterConnectionManagerListener>()
  #stopped = false
  #nextSubmissionSequence = 0

  constructor(
    private readonly connectionType: SingleLevelRouterConnectionDefinition['type'],
    private readonly createClient: SingleLevelRouterManagedClientFactory,
  ) {}

  reconcile(values: readonly unknown[]): void {
    // Composition validates the selected driver's schema; unrelated host records are ignored.
    const connections = connectionCandidates(
      values,
      this.connectionType,
    ) as ConnectionDefinition[]
    this.assertRunning()
    this.#definitions.clear()
    for (const connection of connections) {
      if (
        (connection.type === 'blackmagic-videohub' || connection.type === 'aja-kumo') &&
        connection.type === this.connectionType
      ) {
        this.#definitions.set(connection.connectionId, connection)
      }
    }
    const enabled = new Map<string, SingleLevelRouterConnectionDefinition>(
      connections
        .filter(
          (connection): connection is SingleLevelRouterConnectionDefinition =>
            (connection.type === 'blackmagic-videohub' || connection.type === 'aja-kumo') &&
            connection.type === this.connectionType &&
            connection.enabled,
        )
        .map((definition) => [definition.connectionId, definition] as const),
    )

    for (const [connectionId, entry] of this.#entries) {
      const next = enabled.get(connectionId)
      if (next === undefined || requiresNewClient(entry.definition, next)) {
        this.removeEntry(connectionId, entry)
        continue
      }
      const reconnectDelayChanged = entry.definition.reconnectDelayMs !== next.reconnectDelayMs
      entry.definition = next
      if (reconnectDelayChanged && entry.phase === 'disconnected') {
        this.clearReconnect(entry)
        this.scheduleReconnect(connectionId, entry)
      }
      enabled.delete(connectionId)
    }

    for (const definition of enabled.values()) this.addEntry(definition)
    this.emit()
  }

  refresh(): void {
    this.assertRunning()
    for (const [connectionId, entry] of this.#entries) {
      this.clearReconnect(entry)
      entry.transportEpoch += 1
      entry.lastError = null
      entry.suppressDisconnectEvent = true
      try {
        entry.client.disconnect()
      } finally {
        entry.suppressDisconnectEvent = false
      }
      this.markDisconnected(entry, null)
      void this.connectEntry(connectionId, entry)
    }
    this.emit()
  }

  async refreshNames(connectionId?: string): Promise<void> {
    this.assertRunning()
    const entries =
      connectionId === undefined
        ? [...this.#entries.entries()]
        : [[connectionId, this.requireEntry(connectionId)] as const]
    const results = await Promise.allSettled(
      entries.map(async ([entryConnectionId, entry]) => {
        const epoch = entry.transportEpoch
        this.assertConnected(entryConnectionId, entry, epoch)
        await entry.client.refreshNames()
        this.assertConnected(entryConnectionId, entry, epoch)
        this.applyCatalogSnapshot(entry, entry.client.snapshot())
        entry.catalogStale = false
        this.emit()
      }),
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (failures.length > 0) {
      if (connectionId !== undefined && failures.length === 1) throw failures[0]
      throw new AggregateError(failures, 'Router name refresh failed')
    }
  }

  snapshots(): readonly ManagedRouterConnectionSnapshot[] {
    this.assertRunning()
    return Object.freeze([...this.#entries.values()].map(managedSnapshot))
  }

  async recallSalvo(connectionId: string, salvo: number, signal?: AbortSignal): Promise<void> {
    this.assertRunning()
    signal?.throwIfAborted()
    const entry = this.requireEntry(connectionId)
    if (entry.definition.type !== 'aja-kumo' || entry.client.recallSalvo === undefined) {
      throw new Error('This router does not support salvo recall')
    }
    if (!Number.isInteger(salvo) || salvo < 1 || salvo > 8) {
      throw new RangeError('AJA KUMO salvo must be an integer from 1 to 8')
    }
    if (entry.pendingLegacyRoutes >= MAX_PENDING_LEGACY_ROUTES) {
      throw new Error('Router route submission queue capacity exceeded')
    }
    const epoch = entry.transportEpoch
    this.assertConnected(connectionId, entry, epoch)
    entry.pendingLegacyRoutes += 1
    try {
      await this.enqueueCommand(entry, async () => {
        signal?.throwIfAborted()
        this.assertConnected(connectionId, entry, epoch)
        if (entry.client.recallSalvo === undefined)
          throw new Error('This router does not support salvo recall')
        await entry.client.recallSalvo(salvo, signal)
        this.assertConnected(connectionId, entry, epoch)
        this.synchronizeAfterCommand(entry)
        this.emit()
      })
    } catch (error) {
      if (this.#entries.get(connectionId) === entry) {
        entry.lastError = `Last salvo recall failed: ${errorMessage(error)}`
        this.emit()
      }
      throw error
    } finally {
      entry.pendingLegacyRoutes = Math.max(0, entry.pendingLegacyRoutes - 1)
    }
  }

  subscribe(listener: RouterConnectionManagerListener): () => void {
    this.assertRunning()
    this.#listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      this.#listeners.delete(listener)
    }
    return () => this.#listeners.delete(listener)
  }

  subscribePrimaryRouteFeedback(listener: RouterConnectionManagerListener): () => void {
    this.assertRunning()
    this.#primaryListeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      this.#primaryListeners.delete(listener)
    }
    return () => this.#primaryListeners.delete(listener)
  }

  routeState(connectionId: string): RossSwp08RoutingStateSnapshot {
    return this.requireEntry(connectionId).routing.snapshot()
  }

  queryRouteSources(
    connectionId: string,
    request: RossSwp08RoutePageRequest,
  ): RossSwp08SourcePage {
    return this.requireEntry(connectionId).routing.sourcePage(request)
  }

  queryRouteDestinations(
    connectionId: string,
    request: RossSwp08DestinationPageRequest,
  ): RossSwp08DestinationPage {
    return this.requireEntry(connectionId).routing.destinationPage(request)
  }

  subscribeRouteState(connectionId: string, listener: RouterRouteStateListener): () => void {
    return this.requireEntry(connectionId).routing.subscribe(listener)
  }

  routeCrosspoints(
    request: RossSwp08RouteCrosspointsRequest,
  ): Promise<RossSwp08RouteCrosspointsResult> {
    this.assertRunning()
    const definition = this.#definitions.get(request.connectionId)
    if (definition === undefined) {
      return Promise.resolve(routeRejected(request.operationId, 'connection_unavailable'))
    }
    if (!definition.enabled)
      return Promise.resolve(routeRejected(request.operationId, 'disabled'))
    const entry = this.#entries.get(request.connectionId)
    if (entry === undefined) {
      return Promise.resolve(routeRejected(request.operationId, 'connection_unavailable'))
    }

    const snapshot = snapshotRouteRequest(request)
    const hash = routeRequestHash(snapshot)
    const active = entry.activeRouteOperations.get(snapshot.operationId)
    if (active !== undefined) {
      return active.hash === hash
        ? active.promise
        : Promise.resolve(routeRejected(snapshot.operationId, 'operation_id_conflict'))
    }
    const completed = entry.completedRouteOperations.get(snapshot.operationId)
    if (completed !== undefined) {
      return completed.hash === hash
        ? Promise.resolve(completed.result)
        : Promise.resolve(routeRejected(snapshot.operationId, 'operation_id_conflict'))
    }
    const validation = validateRouteRequest(entry, snapshot)
    if (validation !== null)
      return Promise.resolve(routeRejected(snapshot.operationId, validation))
    if (entry.activeRouteOperations.size >= MAX_ROSS_SWP08_ACTIVE_ROUTE_OPERATIONS) {
      return Promise.resolve(routeRejected(snapshot.operationId, 'operation_capacity_exceeded'))
    }

    const epoch = entry.transportEpoch
    const execution = this.enqueueCommand(entry, () =>
      this.executeRouteRequest(snapshot.connectionId, entry, epoch, snapshot),
    )
    const tracked = execution.then(
      (result) => {
        this.completeRouteOperation(entry, snapshot.operationId, hash, result)
        return result
      },
      () => {
        entry.activeRouteOperations.delete(snapshot.operationId)
        throw new Error('Router route command failed unexpectedly')
      },
    )
    entry.activeRouteOperations.set(snapshot.operationId, { hash, promise: tracked })
    return tracked
  }

  interrogateRouteTargets(
    request: RossSwp08InterrogateRequest,
  ): Promise<RossSwp08InterrogateResult> {
    this.assertRunning()
    const definition = this.#definitions.get(request.connectionId)
    if (definition === undefined) {
      return Promise.resolve(interrogateRejected(request.requestId, 'connection_unavailable'))
    }
    if (!definition.enabled) {
      return Promise.resolve(interrogateRejected(request.requestId, 'disabled'))
    }
    const entry = this.#entries.get(request.connectionId)
    if (entry === undefined) {
      return Promise.resolve(interrogateRejected(request.requestId, 'connection_unavailable'))
    }
    const snapshot = snapshotInterrogateRequest(request)
    const validation = validateInterrogateRequest(entry, snapshot)
    if (validation !== null) {
      return Promise.resolve(interrogateRejected(snapshot.requestId, validation))
    }
    const epoch = entry.transportEpoch
    return this.enqueueCommand(entry, () =>
      this.executeInterrogation(snapshot.connectionId, entry, epoch, snapshot),
    )
  }

  selectDestination(connectionId: string, destination: number): void {
    const entry = this.requireEntry(connectionId)
    validateCurrentAddress(entry, destination, 'destination')
    entry.selectedDestination = destination
    this.emit()
  }

  selectSource(
    connectionId: string,
    source: number,
    levels?: readonly number[],
  ): Promise<void> {
    assertVideoLevels(levels)
    const entry = this.requireEntry(connectionId)
    validateCurrentAddress(entry, source, 'source')
    entry.selectedSource = source
    this.emit()
    return Promise.resolve()
  }

  submitSelectSource(
    connectionId: string,
    source: number,
    levels?: readonly number[],
  ): Promise<void> {
    return this.selectSource(connectionId, source, levels)
  }

  async take(connectionId: string, levels?: readonly number[]): Promise<void> {
    assertVideoLevels(levels)
    const entry = this.requireEntry(connectionId)
    if (entry.selectedSource === null) {
      throw new Error('Router selected source is not configured')
    }
    if (entry.selectedDestination === null) {
      throw new Error('Router selected destination is not configured')
    }
    await this.queueLegacyRoute(
      connectionId,
      entry,
      entry.selectedSource,
      entry.selectedDestination,
    )
  }

  submitTake(connectionId: string, levels?: readonly number[]): Promise<void> {
    return this.take(connectionId, levels)
  }

  directRoute(input: RouterDirectRouteInput): Promise<void> {
    assertVideoLevels(input.levels)
    return this.queueLegacyRoute(
      input.connectionId,
      this.requireEntry(input.connectionId),
      input.source,
      input.destination,
    )
  }

  async submitDirectRoute(input: RouterDirectRouteInput): Promise<void> {
    await this.submitDirectRouteTracked(input).accepted
  }

  submitDirectRouteTracked(input: RouterDirectRouteInput): RouterDirectRouteSubmission {
    assertVideoLevels(input.levels)
    const settled = this.queueLegacyRoute(
      input.connectionId,
      this.requireEntry(input.connectionId),
      input.source,
      input.destination,
    )
    const sequence = this.#nextSubmissionSequence
    this.#nextSubmissionSequence += 1
    return Object.freeze({
      submissionId: `videohub:${input.connectionId}:${String(sequence)}`,
      accepted: settled,
      settled,
    })
  }

  watchConfirmedRouteTarget(
    target: RouterConfirmedRouteTarget,
    listener: RouterConfirmedRouteTargetListener,
  ): () => void {
    return watchConfirmedRouteTarget(this.#singleLevelWatchesContext, target, listener)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const [connectionId, entry] of this.#entries) this.removeEntry(connectionId, entry)
    this.#definitions.clear()
    this.#listeners.clear()
    this.#primaryListeners.clear()
  }

  private addEntry(definition: SingleLevelRouterConnectionDefinition): void {
    const client = this.createClient(definition)
    const entry: ManagedEntry = {
      definition,
      client,
      routing: new RossSwp08RoutingState(),
      phase: mapPhase(client.snapshot().phase),
      selectedSource: null,
      selectedDestination: null,
      routes: emptyRouteSnapshot(),
      sourceCatalog: Object.freeze([]),
      destinationCatalog: Object.freeze([]),
      lastError: null,
      deviceStatus: 'unknown',
      deviceModel: null,
      detectedSourceCount: null,
      detectedDestinationCount: null,
      effectiveSourceCount: null,
      effectiveDestinationCount: null,
      catalogStale: false,
      lockedDestinationCount: 0,
      transportEpoch: 0,
      pendingLegacyRoutes: 0,
      commandTail: Promise.resolve(),
      reconnectTimer: null,
      suppressDisconnectEvent: false,
      unsubscribe: () => undefined,
      activeRouteOperations: new Map(),
      completedRouteOperations: new Map(),
      confirmedRouteWatches: new Map(),
    }
    this.#entries.set(definition.connectionId, entry)
    entry.unsubscribe = client.subscribe((event) => {
      if (this.#entries.get(definition.connectionId) !== entry) return
      this.handleClientEvent(definition.connectionId, entry, event)
    })
    void this.connectEntry(definition.connectionId, entry)
  }

  private async connectEntry(connectionId: string, entry: ManagedEntry): Promise<void> {
    if (this.#entries.get(connectionId) !== entry) return
    this.clearReconnect(entry)
    const epoch = entry.transportEpoch
    entry.phase = 'connecting'
    this.emit()
    try {
      await entry.client.connect()
      if (!this.entryConnected(connectionId, entry, epoch)) return
      this.hydrateConnectedSnapshot(entry)
      this.emit()
    } catch (error: unknown) {
      if (this.#entries.get(connectionId) !== entry || entry.transportEpoch !== epoch) return
      entry.transportEpoch += 1
      entry.suppressDisconnectEvent = true
      try {
        entry.client.disconnect()
      } finally {
        entry.suppressDisconnectEvent = false
      }
      this.markDisconnected(entry, errorMessage(error))
      this.scheduleReconnect(connectionId, entry)
      this.emit()
    }
  }

  private handleClientEvent(
    connectionId: string,
    entry: ManagedEntry,
    event: VideohubClientEvent,
  ): void {
    if (event.type === 'phase') {
      if (entry.suppressDisconnectEvent) return
      const previousPhase = entry.phase
      entry.phase = mapPhase(event.phase)
      entry.deviceStatus = entry.client.snapshot().deviceStatus
      entry.lastError = event.error
      if (event.phase === 'connected') {
        this.clearReconnect(entry)
        try {
          this.hydrateConnectedSnapshot(entry)
        } catch (error: unknown) {
          entry.lastError = `Router state invalid: ${errorMessage(error)}`
          entry.routing.markDegraded()
        }
      } else if (event.phase === 'disconnected') {
        entry.transportEpoch += 1
        this.markDisconnected(entry, event.error)
        this.scheduleReconnect(connectionId, entry)
      } else {
        if (previousPhase === 'connected') {
          entry.transportEpoch += 1
          entry.completedRouteOperations.clear()
          entry.routes = emptyRouteSnapshot()
          entry.catalogStale =
            entry.sourceCatalog.length > 0 || entry.destinationCatalog.length > 0
          this.invalidateConfirmedRouteWatches(entry, 'Router readback is resynchronizing')
        }
        entry.routing.markStale()
      }
      this.emit()
      return
    }
    if (event.type === 'device') {
      try {
        const snapshot = entry.client.snapshot()
        if (snapshot.phase === 'connected') this.hydrateConnectedSnapshot(entry)
        else this.applySynchronizingDeviceSnapshot(entry, snapshot)
      } catch (error: unknown) {
        entry.lastError = `Router state invalid: ${errorMessage(error)}`
        entry.routing.markDegraded()
      }
      this.emit()
      return
    }
    if (entry.client.snapshot().phase !== 'connected') return

    try {
      switch (event.type) {
        case 'routes-reset':
          entry.completedRouteOperations.clear()
          entry.routes = emptyRouteSnapshot()
          entry.routing.reset({ clientRevision: event.revision, phase: 'stale' })
          this.invalidateConfirmedRouteWatches(entry, 'Router readback is resynchronizing')
          break
        case 'names':
          this.applyCatalogSnapshot(entry, entry.client.snapshot())
          this.applyLabelPhase(entry, entry.client.snapshot())
          entry.catalogStale = false
          break
        case 'route':
        case 'routes': {
          const crosspoints = event.type === 'route' ? [event.crosspoint] : event.crosspoints
          if (crosspoints.some((crosspoint) => !representableCrosspoint(entry, crosspoint))) {
            this.hydrateConnectedSnapshot(entry)
            break
          }
          entry.routing.apply({
            previousRevision: event.previousRevision,
            revision: event.revision,
            crosspoints: crosspoints.map(toSwp08Crosspoint),
          })
          entry.routes = boundedRouteSnapshot(entry, entry.client.snapshot())
          this.publishConfirmedRouteWatchesFromRoutes(entry)
          break
        }
        case 'route-observation':
          return
        case 'lock':
        case 'locks':
          this.applyDeviceMetadata(entry, entry.client.snapshot())
          break
        case 'protocol-error':
          entry.lastError = event.message
          break
      }
    } catch (error: unknown) {
      entry.lastError = `Router state invalid: ${errorMessage(error)}`
      try {
        this.hydrateConnectedSnapshot(entry)
      } catch {
        entry.routing.markDegraded()
      }
    }
    this.emit()
  }

  private hydrateConnectedSnapshot(entry: ManagedEntry): void {
    return hydrateConnectedSnapshot(this.#singleLevelCatalogContext, entry)
  }

  private applyDeviceMetadata(entry: ManagedEntry, snapshot: VideohubSnapshot): void {
    return applyDeviceMetadata(this.#singleLevelCatalogContext, entry, snapshot)
  }

  private applySynchronizingDeviceSnapshot(
    entry: ManagedEntry,
    snapshot: VideohubSnapshot,
  ): void {
    return applySynchronizingDeviceSnapshot(this.#singleLevelCatalogContext, entry, snapshot)
  }

  private applyCatalogSnapshot(entry: ManagedEntry, snapshot: VideohubSnapshot): void {
    return applyCatalogSnapshot(this.#singleLevelCatalogContext, entry, snapshot)
  }

  private applyLabelPhase(entry: ManagedEntry, snapshot: VideohubSnapshot): void {
    return applyLabelPhase(this.#singleLevelCatalogContext, entry, snapshot)
  }

  private markDisconnected(entry: ManagedEntry, error: string | null): void {
    return markDisconnected(this.#singleLevelCatalogContext, entry, error)
  }

  private queueLegacyRoute(
    connectionId: string,
    entry: ManagedEntry,
    source: number,
    destination: number,
  ): Promise<void> {
    return queueLegacyRoute(
      this.#singleLevelCommandsContext,
      connectionId,
      entry,
      source,
      destination,
    )
  }

  private synchronizeAfterCommand(entry: ManagedEntry): void {
    return synchronizeAfterCommand(this.#singleLevelCatalogContext, entry)
  }

  private async executeRouteRequest(
    connectionId: string,
    entry: ManagedEntry,
    epoch: number,
    request: RossSwp08RouteCrosspointsRequest,
  ): Promise<RossSwp08RouteCrosspointsResult> {
    return executeRouteRequest(
      this.#singleLevelCommandsContext,
      connectionId,
      entry,
      epoch,
      request,
    )
  }

  private async executeInterrogation(
    connectionId: string,
    entry: ManagedEntry,
    epoch: number,
    request: RossSwp08InterrogateRequest,
  ): Promise<RossSwp08InterrogateResult> {
    return executeInterrogation(
      this.#singleLevelCommandsContext,
      connectionId,
      entry,
      epoch,
      request,
    )
  }

  private publishConfirmedRouteWatchesFromRoutes(entry: ManagedEntry): void {
    return publishConfirmedRouteWatchesFromRoutes(this.#singleLevelWatchesContext, entry)
  }

  private publishConfirmedRouteWatchFromRoutes(
    entry: ManagedEntry,
    watch: ConfirmedRouteWatch,
  ): void {
    return publishConfirmedRouteWatchFromRoutes(this.#singleLevelWatchesContext, entry, watch)
  }

  private invalidateConfirmedRouteWatches(entry: ManagedEntry, error: string): void {
    return invalidateConfirmedRouteWatches(this.#singleLevelWatchesContext, entry, error)
  }

  private publishConfirmedRouteWatch(
    watch: ConfirmedRouteWatch,
    snapshot: RouterConfirmedRouteTargetSnapshot,
  ): void {
    return publishConfirmedRouteWatch(this.#singleLevelWatchesContext, watch, snapshot)
  }

  private enqueueCommand<T>(entry: ManagedEntry, operation: () => Promise<T>): Promise<T> {
    return enqueueCommand(this.#singleLevelCommandsContext, entry, operation)
  }

  private completeRouteOperation(
    entry: ManagedEntry,
    operationId: string,
    hash: string,
    result: RossSwp08RouteCrosspointsResult,
  ): void {
    return completeRouteOperation(
      this.#singleLevelCommandsContext,
      entry,
      operationId,
      hash,
      result,
    )
  }

  private assertConnected(connectionId: string, entry: ManagedEntry, epoch: number): void {
    if (!this.entryConnected(connectionId, entry, epoch)) {
      if (isUnsupportedDimensionsMessage(entry.lastError ?? '')) {
        throw new RangeError(entry.lastError ?? 'Router reported unsupported dimensions')
      }
      throw new Error('Router is not connected')
    }
    if (entry.routing.snapshot().phase !== 'ready') {
      throw new Error('Router is not synchronized')
    }
  }

  private assertConnectedOrConfirmedAfterFence(
    connectionId: string,
    entry: ManagedEntry,
    epoch: number,
    previousConfirmedOperationSequence: number,
  ): void {
    if (this.entryConnected(connectionId, entry, epoch)) return
    if (
      entry.client.snapshot().confirmedOperationSequence > previousConfirmedOperationSequence
    ) {
      return
    }
    this.assertConnected(connectionId, entry, epoch)
  }

  private entryConnected(connectionId: string, entry: ManagedEntry, epoch: number): boolean {
    return (
      this.#entries.get(connectionId) === entry &&
      entry.transportEpoch === epoch &&
      entry.phase === 'connected' &&
      entry.client.snapshot().phase === 'connected'
    )
  }

  private scheduleReconnect(connectionId: string, entry: ManagedEntry): void {
    if (
      entry.reconnectTimer !== null ||
      this.#entries.get(connectionId) !== entry ||
      this.#stopped
    ) {
      return
    }
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      void this.connectEntry(connectionId, entry)
    }, entry.definition.reconnectDelayMs)
    entry.reconnectTimer.unref()
  }

  private clearReconnect(entry: ManagedEntry): void {
    if (entry.reconnectTimer === null) return
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
  }

  private removeEntry(connectionId: string, entry: ManagedEntry): void {
    this.#entries.delete(connectionId)
    entry.transportEpoch += 1
    this.clearReconnect(entry)
    entry.unsubscribe()
    entry.client.disconnect()
    entry.routing.markStale()
    for (const watch of entry.confirmedRouteWatches.values()) watch.listeners.clear()
    entry.confirmedRouteWatches.clear()
  }

  private requireEntry(connectionId: string): ManagedEntry {
    this.assertRunning()
    const entry = this.#entries.get(connectionId)
    if (entry === undefined) {
      throw new Error(`Router connection ${connectionId} is not available`)
    }
    return entry
  }

  private emit(): void {
    if (this.#stopped) return
    const snapshots = Object.freeze([...this.#entries.values()].map(managedSnapshot))
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshots)
      } catch {
        // Observers cannot affect the Videohub transport.
      }
    }
    for (const listener of [...this.#primaryListeners]) {
      try {
        listener(snapshots)
      } catch {
        // Feedback observers cannot affect the Videohub transport.
      }
    }
  }

  private assertRunning(): void {
    if (this.#stopped) throw new Error('Router connection manager is stopped')
  }
}
export {
  type SingleLevelRouterConnectionDefinition,
  type SingleLevelRouterManagedClient,
  type SingleLevelRouterManagedClientFactory,
} from './single-level-types.js'
