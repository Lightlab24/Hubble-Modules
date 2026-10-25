import { connectionCandidates } from '@hubble/module-contracts/settings'
import { type UltrixOgpSnapshot } from '@hubble/protocol-ultrix-ogp'
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
  assertLevelCatalog,
  hydrateConnectedSnapshot,
  synchronizeAfterCommand,
  type MultiLevelCatalogContext,
} from './multi-level-catalog.js'
import {
  completeRouteOperation,
  enqueueCommand,
  executeInterrogation,
  executeRouteRequest,
  queueLegacyRoute,
  type MultiLevelCommandsContext,
} from './multi-level-commands.js'
import {
  interrogateRejected,
  routeRejected,
  routeRequestHash,
  snapshotInterrogateRequest,
  snapshotRouteRequest,
} from './multi-level-requests.js'
import {
  boundedRouteSnapshot,
  emptyRouteSnapshot,
  errorMessage,
  managedSnapshot,
  mapPhase,
  ogpCrosspointToSwp08,
  representableCrosspoint,
  requiresNewClient,
} from './multi-level-snapshot.js'
import {
  type ConfirmedRouteWatch,
  type ManagedEntry,
  type MultiLevelRouterClientEvent,
  type MultiLevelRouterConnectionDefinition,
  type MultiLevelRouterManagedClientFactory,
} from './multi-level-types.js'
import {
  routeLevels,
  validateAddress,
  validateInterrogateRequest,
  validateRouteRequest,
} from './multi-level-validation.js'
import {
  invalidateConfirmedRouteWatches,
  publishConfirmedRouteWatch,
  publishConfirmedRouteWatchesFromRoutes,
  runAllConfirmedRouteWatches,
  runConfirmedRouteWatch,
  watchConfirmedRouteTarget,
  type MultiLevelWatchesContext,
} from './multi-level-watches.js'
import { type ConnectionDefinition } from './types.js'

export class MultiLevelRouterConnectionManager implements RouterConnectionManagerContract {
  #multiLevelCatalogContext: MultiLevelCatalogContext = {}

  #multiLevelWatchesContext: MultiLevelWatchesContext = {
    requireEntry: (...args) => this.requireEntry(...args),
    isCurrentEntry: (connectionId, entry) => this.#entries.get(connectionId) === entry,
  }

  #multiLevelCommandsContext: MultiLevelCommandsContext = {
    assertConnected: (...args) => this.assertConnected(...args),
    synchronizeAfterCommand: (...args) => this.synchronizeAfterCommand(...args),
    emit: (...args) => this.emit(...args),
    entryConnected: (...args) => this.entryConnected(...args),
    isCurrentEntry: (connectionId, entry) => this.#entries.get(connectionId) === entry,
  }

  readonly #entries = new Map<string, ManagedEntry>()
  readonly #definitions = new Map<string, MultiLevelRouterConnectionDefinition>()
  readonly #listeners = new Set<RouterConnectionManagerListener>()
  readonly #primaryListeners = new Set<RouterConnectionManagerListener>()
  #stopped = false
  #nextTrackedDirectRouteSubmissionSequence = 0

  constructor(
    private readonly adapterType: MultiLevelRouterConnectionDefinition['type'],
    private readonly createClient: MultiLevelRouterManagedClientFactory,
  ) {}

  reconcile(values: readonly unknown[]): void {
    // Composition validates the selected driver's schema; unrelated host records are ignored.
    const connections = connectionCandidates(
      values,
      this.adapterType,
    ) as ConnectionDefinition[]
    this.assertRunning()
    this.#definitions.clear()
    for (const connection of connections) {
      if (connection.type === this.adapterType) {
        this.#definitions.set(connection.connectionId, connection)
      }
    }
    const enabled = new Map<string, MultiLevelRouterConnectionDefinition>(
      connections
        .filter(
          (connection): connection is MultiLevelRouterConnectionDefinition =>
            connection.type === this.adapterType && connection.enabled,
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

  async recallSalvo(connectionId: string, salvo: number, signal?: AbortSignal): Promise<void> {
    const entry = this.requireEntry(connectionId)
    if (signal?.aborted) throw new Error('Quartz salvo cancelled')
    if (entry.client.recallSalvo === undefined)
      throw new Error('This router does not support salvo recall')
    await entry.client.recallSalvo(salvo, signal)
  }

  async setDestinationLock(
    connectionId: string,
    destination: number,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.requireEntry(connectionId)
    if (entry.client.setDestinationLock === undefined)
      throw new Error('This router does not support destination locks')
    await entry.client.setDestinationLock(destination, locked, signal)
  }

  refresh(): void {
    this.assertRunning()
    for (const [connectionId, entry] of this.#entries) {
      this.clearReconnect(entry)
      entry.transportEpoch += 1
      entry.lastError = null
      entry.client.disconnect()
      this.clearReconnect(entry)
      entry.phase = 'disconnected'
      entry.routing.markStale()
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
        this.assertConnected(entryConnectionId, entry, entry.transportEpoch)
        await entry.client.refreshNames()
        if (this.#entries.get(entryConnectionId) !== entry) return
        this.applyCatalogSnapshot(entry, entry.client.snapshot())
        this.emit()
      }),
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Router name refresh failed')
    }
  }

  snapshots(): readonly ManagedRouterConnectionSnapshot[] {
    this.assertRunning()
    return Object.freeze([...this.#entries.values()].map(managedSnapshot))
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
      if (completed.hash !== hash) {
        return Promise.resolve(routeRejected(snapshot.operationId, 'operation_id_conflict'))
      }
      entry.completedRouteOperations.delete(snapshot.operationId)
      entry.completedRouteOperations.set(snapshot.operationId, completed)
      return Promise.resolve(completed.result)
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
        throw new Error('Router command failed unexpectedly')
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
    ).catch(() => {
      throw new Error('Router interrogation failed unexpectedly')
    })
  }

  selectDestination(connectionId: string, destination: number): void {
    const entry = this.requireEntry(connectionId)
    validateAddress(destination, entry.definition.destinationLimit, 'destination')
    entry.selectedDestination = destination
    this.emit()
  }

  selectSource(
    ...[connectionId, source]: Parameters<RouterConnectionManagerContract['selectSource']>
  ): Promise<void> {
    try {
      const entry = this.requireEntry(connectionId)
      validateAddress(source, entry.definition.sourceLimit, 'source')
      entry.selectedSource = source
      this.emit()
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  submitSelectSource(
    ...args: Parameters<RouterConnectionManagerContract['selectSource']>
  ): Promise<void> {
    return this.selectSource(...args)
  }

  async take(connectionId: string, levels?: readonly number[]): Promise<void> {
    const entry = this.requireEntry(connectionId)
    if (entry.selectedSource === null) {
      throw new Error('Ross selected source is not configured')
    }
    const destination = entry.selectedDestination
    if (destination === null) throw new Error('Ross selected destination is not configured')
    await this.queueLegacyRoute(
      connectionId,
      entry,
      entry.selectedSource,
      destination,
      routeLevels(entry.definition, levels),
    )
  }

  async submitTake(connectionId: string, levels?: readonly number[]): Promise<void> {
    const entry = this.requireEntry(connectionId)
    if (entry.selectedSource === null) {
      throw new Error('Ross selected source is not configured')
    }
    const destination = entry.selectedDestination
    if (destination === null) throw new Error('Ross selected destination is not configured')
    await this.queueLegacyRoute(
      connectionId,
      entry,
      entry.selectedSource,
      destination,
      routeLevels(entry.definition, levels),
    )
  }

  directRoute(input: RouterDirectRouteInput): Promise<void> {
    const entry = this.requireEntry(input.connectionId)
    return this.queueLegacyRoute(
      input.connectionId,
      entry,
      input.source,
      input.destination,
      routeLevels(entry.definition, input.levels),
    )
  }

  async submitDirectRoute(input: RouterDirectRouteInput): Promise<void> {
    await this.submitDirectRouteTracked(input).accepted
  }

  submitDirectRouteTracked(input: RouterDirectRouteInput): RouterDirectRouteSubmission {
    const entry = this.requireEntry(input.connectionId)
    const settled = this.queueLegacyRoute(
      input.connectionId,
      entry,
      input.source,
      input.destination,
      routeLevels(entry.definition, input.levels),
    )
    const submissionSequence = this.#nextTrackedDirectRouteSubmissionSequence
    this.#nextTrackedDirectRouteSubmissionSequence += 1
    return Object.freeze({
      submissionId: `${this.adapterType === 'ross-ultrix-ogp' ? 'ogp' : 'quartz'}:${input.connectionId}:${String(submissionSequence)}`,
      accepted: settled,
      settled,
    })
  }

  watchConfirmedRouteTarget(
    target: RouterConfirmedRouteTarget,
    listener: RouterConfirmedRouteTargetListener,
  ): () => void {
    return watchConfirmedRouteTarget(this.#multiLevelWatchesContext, target, listener)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const [connectionId, entry] of this.#entries) this.removeEntry(connectionId, entry)
    this.#definitions.clear()
    this.#listeners.clear()
    this.#primaryListeners.clear()
  }

  private addEntry(definition: MultiLevelRouterConnectionDefinition): void {
    const client = this.createClient(definition)
    const entry: ManagedEntry = {
      definition,
      client,
      routing: new RossSwp08RoutingState(),
      phase: mapPhase(client.snapshot().phase),
      selectedSource: null,
      selectedDestination: 1,
      routes: emptyRouteSnapshot(),
      sourceCatalog: Object.freeze([]),
      destinationCatalog: Object.freeze([]),
      lastError: null,
      transportEpoch: 0,
      pendingLegacyRoutes: 0,
      commandTail: Promise.resolve(),
      reconnectTimer: null,
      retryDisconnectInProgress: false,
      unsubscribe: () => undefined,
      activeRouteOperations: new Map(),
      completedRouteOperations: new Map(),
      confirmedRouteWatches: new Map(),
      confirmedRouteWatchTail: Promise.resolve(),
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
      if (
        this.#entries.get(connectionId) !== entry ||
        entry.transportEpoch !== epoch ||
        entry.client.snapshot().phase !== 'connected'
      ) {
        return
      }
      this.hydrateConnectedSnapshot(entry)
      this.runAllConfirmedRouteWatches(connectionId, entry)
      this.emit()
    } catch (error: unknown) {
      if (this.#entries.get(connectionId) !== entry || entry.transportEpoch !== epoch) return
      const failure = errorMessage(error)
      entry.transportEpoch += 1
      entry.retryDisconnectInProgress = true
      try {
        entry.client.disconnect()
      } finally {
        entry.retryDisconnectInProgress = false
      }
      if (this.#entries.get(connectionId) !== entry) return
      this.clearReconnect(entry)
      entry.phase = 'disconnected'
      entry.lastError = failure
      entry.routing.markStale()
      this.invalidateConfirmedRouteWatches(entry, failure)
      this.scheduleReconnect(connectionId, entry)
      this.emit()
    }
  }

  private handleClientEvent(
    connectionId: string,
    entry: ManagedEntry,
    event: MultiLevelRouterClientEvent,
  ): void {
    try {
      if (entry.retryDisconnectInProgress) {
        if (event.type === 'phase' && event.phase === 'disconnected') {
          entry.phase = 'disconnected'
          entry.routing.markStale()
        }
        return
      }
      if (event.type === 'phase') {
        entry.phase = mapPhase(event.phase)
        entry.lastError = event.error
        if (event.phase === 'connected') {
          this.clearReconnect(entry)
          this.hydrateConnectedSnapshot(entry)
          this.runAllConfirmedRouteWatches(connectionId, entry)
        } else if (event.phase === 'disconnected') {
          entry.transportEpoch += 1
          entry.routing.markStale()
          this.invalidateConfirmedRouteWatches(
            entry,
            event.error ?? 'Router confirmed route readback disconnected',
          )
          this.scheduleReconnect(connectionId, entry)
        } else {
          entry.routing.markStale()
        }
        this.emit()
        return
      }

      if (entry.client.snapshot().phase !== 'connected') return
      switch (event.type) {
        case 'locks':
          break
        case 'names':
          this.applyCatalogSnapshot(entry, entry.client.snapshot())
          entry.routing.markLabelsReady()
          break
        case 'levels':
          this.assertLevelCatalog(entry, entry.client.snapshot())
          break
        case 'routes-reset':
          this.hydrateConnectedSnapshot(entry)
          this.publishConfirmedRouteWatchesFromRoutes(entry)
          break
        case 'route':
        case 'routes': {
          const crosspoints = event.type === 'route' ? [event.crosspoint] : event.crosspoints
          if (crosspoints.some((crosspoint) => !representableCrosspoint(entry, crosspoint))) {
            this.hydrateConnectedSnapshot(entry)
            this.publishConfirmedRouteWatchesFromRoutes(entry)
            break
          }
          entry.routing.apply({
            previousRevision: event.previousRevision,
            revision: event.revision,
            crosspoints: crosspoints.map(ogpCrosspointToSwp08),
          })
          entry.routes = boundedRouteSnapshot(entry.definition, entry.client.snapshot())
          this.publishConfirmedRouteWatchesFromRoutes(entry)
          break
        }
        case 'route-observation':
          // The OGP client has already used this unchanged value to settle any pending
          // command confirmation. Only route/routes events change authoritative state.
          return
        case 'control-ready':
          if (event.ready && entry.client.snapshot().subscriptions.length > 0) {
            entry.routing.markReady()
          } else entry.routing.markDegraded()
          break
        case 'take-error':
          return
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
    return hydrateConnectedSnapshot(this.#multiLevelCatalogContext, entry)
  }

  private runConfirmedRouteWatch(
    connectionId: string,
    entry: ManagedEntry,
    watch: ConfirmedRouteWatch,
  ): void {
    return runConfirmedRouteWatch(this.#multiLevelWatchesContext, connectionId, entry, watch)
  }

  private runAllConfirmedRouteWatches(connectionId: string, entry: ManagedEntry): void {
    return runAllConfirmedRouteWatches(this.#multiLevelWatchesContext, connectionId, entry)
  }

  private publishConfirmedRouteWatchesFromRoutes(entry: ManagedEntry): void {
    return publishConfirmedRouteWatchesFromRoutes(this.#multiLevelWatchesContext, entry)
  }

  private invalidateConfirmedRouteWatches(entry: ManagedEntry, error: string): void {
    return invalidateConfirmedRouteWatches(this.#multiLevelWatchesContext, entry, error)
  }

  private publishConfirmedRouteWatch(
    watch: ConfirmedRouteWatch,
    snapshot: RouterConfirmedRouteTargetSnapshot,
  ): void {
    return publishConfirmedRouteWatch(this.#multiLevelWatchesContext, watch, snapshot)
  }

  private applyCatalogSnapshot(entry: ManagedEntry, snapshot: UltrixOgpSnapshot): void {
    return applyCatalogSnapshot(this.#multiLevelCatalogContext, entry, snapshot)
  }

  private assertLevelCatalog(entry: ManagedEntry, snapshot: UltrixOgpSnapshot): void {
    return assertLevelCatalog(this.#multiLevelCatalogContext, entry, snapshot)
  }

  private queueLegacyRoute(
    connectionId: string,
    entry: ManagedEntry,
    source: number,
    destination: number,
    levels: readonly number[],
  ): Promise<void> {
    return queueLegacyRoute(
      this.#multiLevelCommandsContext,
      connectionId,
      entry,
      source,
      destination,
      levels,
    )
  }

  private synchronizeAfterCommand(entry: ManagedEntry): void {
    return synchronizeAfterCommand(this.#multiLevelCatalogContext, entry)
  }

  private async executeRouteRequest(
    connectionId: string,
    entry: ManagedEntry,
    epoch: number,
    request: RossSwp08RouteCrosspointsRequest,
  ): Promise<RossSwp08RouteCrosspointsResult> {
    return executeRouteRequest(
      this.#multiLevelCommandsContext,
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
      this.#multiLevelCommandsContext,
      connectionId,
      entry,
      epoch,
      request,
    )
  }

  private enqueueCommand<T>(entry: ManagedEntry, operation: () => Promise<T>): Promise<T> {
    return enqueueCommand(this.#multiLevelCommandsContext, entry, operation)
  }

  private completeRouteOperation(
    entry: ManagedEntry,
    operationId: string,
    hash: string,
    result: RossSwp08RouteCrosspointsResult,
  ): void {
    return completeRouteOperation(
      this.#multiLevelCommandsContext,
      entry,
      operationId,
      hash,
      result,
    )
  }

  private assertConnected(connectionId: string, entry: ManagedEntry, epoch: number): void {
    if (!this.entryConnected(connectionId, entry, epoch)) {
      throw new Error('Router connection is not connected')
    }
    if (entry.routing.snapshot().phase !== 'ready') {
      throw new Error('Router connection is not synchronized')
    }
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
    for (const watch of entry.confirmedRouteWatches.values()) {
      watch.running = false
      watch.runId += 1
      watch.listeners.clear()
    }
    entry.confirmedRouteWatches.clear()
    this.clearReconnect(entry)
    entry.unsubscribe()
    entry.client.disconnect()
    entry.routing.markStale()
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
        // Observers cannot affect the OGP transport.
      }
    }
    for (const listener of [...this.#primaryListeners]) {
      try {
        listener(snapshots)
      } catch {
        // Feedback observers cannot affect the OGP transport.
      }
    }
  }

  private assertRunning(): void {
    if (this.#stopped) throw new Error('Router connection manager is stopped')
  }
}
export {
  type MultiLevelRouterClientEvent,
  type MultiLevelRouterManagedClient,
  type MultiLevelRouterManagedClientFactory,
} from './multi-level-types.js'
