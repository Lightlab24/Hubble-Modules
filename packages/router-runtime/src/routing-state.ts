import { randomUUID } from 'node:crypto'
import type { Swp08Crosspoint, Swp08NameCatalogSnapshot } from './models.js'
import {
  type RossSwp08CrosspointDelta,
  type RossSwp08DestinationPage,
  type RossSwp08DestinationPageRequest,
  type RossSwp08DestinationSummary,
  type RossSwp08LabelPhase,
  type RossSwp08RoutePageRequest,
  type RossSwp08RouteStateEvent,
  type RossSwp08RouteStateListener,
  type RossSwp08RouteSyncPhase,
  type RossSwp08RouteVersion,
  type RossSwp08RoutingStateOptions,
  type RossSwp08RoutingStateSnapshot,
  type RossSwp08SourcePage,
  type RouteDeltaInput,
} from './routing-models.js'
import {
  compareNumbers,
  countUnion,
  keysetPage,
  labelMap,
  mapsEqual,
  nestedMapsEqual,
  normalizedSearch,
  resourceMatches,
  UUID_PATTERN,
  validateAddress,
  validateCrosspoint,
  validateDestinationPageRequest,
  validatePageRequest,
  validateRevision,
} from './routing-queries.js'

export class RossSwp08RoutingState {
  readonly #createGeneration: () => string
  readonly #routes = new Map<number, Map<number, number>>()
  readonly #destinationsBySource = new Map<number, Map<number, Set<number>>>()
  readonly #listeners = new Set<RossSwp08RouteStateListener>()
  readonly #eventQueue: RossSwp08RouteStateEvent[] = []
  #sourceLabels = new Map<number, string | null>()
  #destinationLabels = new Map<number, string | null>()
  #generation: string
  #revision = 0
  #phase: RossSwp08RouteSyncPhase = 'stale'
  #labelPhase: RossSwp08LabelPhase = 'loading'
  #labelRevision = 0
  #knownSourceCount = 0
  #knownDestinationCount = 0
  #knownCrosspointCount = 0
  #publishing = false

  constructor(options: RossSwp08RoutingStateOptions = {}) {
    this.#createGeneration = options.createGeneration ?? randomUUID
    this.#generation = this.nextGeneration()
  }

  reset(input: {
    readonly clientRevision: number
    readonly phase: RossSwp08RouteSyncPhase
  }): RossSwp08RoutingStateSnapshot {
    validateRevision(input.clientRevision, 'clientRevision')
    const generation = this.nextGeneration()
    if (generation === this.#generation) {
      throw new Error('Ross route reset generation must differ from the current generation')
    }
    this.#routes.clear()
    this.#destinationsBySource.clear()
    this.#knownSourceCount = this.#sourceLabels.size
    this.#knownDestinationCount = this.#destinationLabels.size
    this.#knownCrosspointCount = 0
    this.#generation = generation
    this.#revision = input.clientRevision
    this.#phase = input.phase

    const snapshot = this.snapshot()
    this.publish(
      Object.freeze({
        type: 'reset',
        version: snapshot.version,
        phase: snapshot.phase,
      }),
    )
    return snapshot
  }

  replaceRoutes(input: {
    readonly clientRevision: number
    readonly crosspoints: readonly Swp08Crosspoint[]
  }): RossSwp08RoutingStateSnapshot {
    validateRevision(input.clientRevision, 'clientRevision')
    const routes = new Map<number, Map<number, number>>()
    for (const crosspoint of input.crosspoints) {
      validateCrosspoint(crosspoint)
      let levels = routes.get(crosspoint.destination)
      if (levels === undefined) {
        levels = new Map()
        routes.set(crosspoint.destination, levels)
      }
      if (levels.has(crosspoint.level)) {
        throw new Error(
          `Ross route snapshot contains duplicate destination ${String(crosspoint.destination)} level ${String(crosspoint.level)}`,
        )
      }
      levels.set(crosspoint.level, crosspoint.source)
    }
    if (this.#revision === input.clientRevision && nestedMapsEqual(this.#routes, routes)) {
      return this.snapshot()
    }

    this.#routes.clear()
    this.#destinationsBySource.clear()
    this.#knownSourceCount = this.#sourceLabels.size
    this.#knownDestinationCount = this.#destinationLabels.size
    this.#knownCrosspointCount = 0
    for (const [destination, levels] of routes) {
      const destinationWasKnown = this.#destinationLabels.has(destination)
      const nextLevels = new Map<number, number>()
      this.#routes.set(destination, nextLevels)
      if (!destinationWasKnown) this.#knownDestinationCount += 1
      for (const [level, source] of levels) {
        const sourceWasKnown =
          this.#sourceLabels.has(source) || this.#destinationsBySource.has(source)
        nextLevels.set(level, source)
        this.addReverseRoute(source, level, destination)
        this.#knownCrosspointCount += 1
        if (!sourceWasKnown) this.#knownSourceCount += 1
      }
    }
    const generation = this.nextGeneration()
    if (generation === this.#generation) {
      throw new Error(
        'Ross route replacement generation must differ from the current generation',
      )
    }
    this.#generation = generation
    this.#revision = input.clientRevision

    const snapshot = this.snapshot()
    this.publish(
      Object.freeze({
        type: 'reset',
        version: snapshot.version,
        phase: snapshot.phase,
      }),
    )
    return snapshot
  }

  apply(input: RouteDeltaInput): RossSwp08RoutingStateSnapshot {
    validateRevision(input.previousRevision, 'previousRevision')
    validateRevision(input.revision, 'revision')
    if (input.previousRevision !== this.#revision || input.revision !== this.#revision + 1) {
      throw new Error(
        `Ross route revision gap: expected ${String(this.#revision)} -> ${String(this.#revision + 1)}, received ${String(input.previousRevision)} -> ${String(input.revision)}`,
      )
    }
    if (input.crosspoints.length === 0) {
      throw new Error('Ross route delta does not change any crosspoints')
    }

    const targets = new Set<string>()
    const enriched: RossSwp08CrosspointDelta[] = []
    for (const crosspoint of input.crosspoints) {
      validateCrosspoint(crosspoint)
      const key = `${String(crosspoint.destination)}:${String(crosspoint.level)}`
      if (targets.has(key)) {
        throw new Error(
          `Ross route delta contains duplicate destination ${String(crosspoint.destination)} level ${String(crosspoint.level)}`,
        )
      }
      targets.add(key)
      const previousSource = this.source(crosspoint.destination, crosspoint.level)
      if (previousSource === crosspoint.source) {
        throw new Error(
          `Ross route delta does not change destination ${String(crosspoint.destination)} level ${String(crosspoint.level)}`,
        )
      }
      enriched.push(Object.freeze({ ...crosspoint, previousSource }))
    }

    for (const crosspoint of enriched) {
      const sourceWasKnown =
        this.#sourceLabels.has(crosspoint.source) ||
        this.#destinationsBySource.has(crosspoint.source)
      if (crosspoint.previousSource !== null) {
        this.removeReverseRoute(
          crosspoint.previousSource,
          crosspoint.level,
          crosspoint.destination,
        )
        if (
          !this.#sourceLabels.has(crosspoint.previousSource) &&
          !this.#destinationsBySource.has(crosspoint.previousSource)
        ) {
          this.#knownSourceCount -= 1
        }
      }

      let levels = this.#routes.get(crosspoint.destination)
      if (levels === undefined) {
        levels = new Map()
        this.#routes.set(crosspoint.destination, levels)
        if (!this.#destinationLabels.has(crosspoint.destination)) {
          this.#knownDestinationCount += 1
        }
      }
      if (!levels.has(crosspoint.level)) this.#knownCrosspointCount += 1
      levels.set(crosspoint.level, crosspoint.source)
      this.addReverseRoute(crosspoint.source, crosspoint.level, crosspoint.destination)
      if (!sourceWasKnown) this.#knownSourceCount += 1
    }

    this.#revision = input.revision
    const snapshot = this.snapshot()
    this.publish(
      Object.freeze({
        type: 'delta',
        generation: this.#generation,
        previousRevision: input.previousRevision,
        revision: input.revision,
        crosspoints: Object.freeze(enriched),
        knownSourceCount: snapshot.knownSourceCount,
        knownDestinationCount: snapshot.knownDestinationCount,
        knownCrosspointCount: snapshot.knownCrosspointCount,
      }),
    )
    return snapshot
  }

  observe(crosspoint: Swp08Crosspoint, clientRevision = this.#revision): void {
    validateRevision(clientRevision, 'clientRevision')
    validateCrosspoint(crosspoint)
    if (clientRevision !== this.#revision) {
      throw new Error(
        `Ross route observation revision ${String(clientRevision)} does not match current revision ${String(this.#revision)}`,
      )
    }
    if (this.source(crosspoint.destination, crosspoint.level) !== crosspoint.source) {
      throw new Error(
        `Ross route observation does not match destination ${String(crosspoint.destination)} level ${String(crosspoint.level)}`,
      )
    }
    this.publish(
      Object.freeze({
        type: 'observation',
        version: this.version(),
        crosspoint: Object.freeze({ ...crosspoint }),
      }),
    )
  }

  replaceCatalogs(catalogs: Swp08NameCatalogSnapshot): RossSwp08RoutingStateSnapshot {
    const sourceLabels = labelMap(catalogs.sources, 'source')
    const destinationLabels = labelMap(catalogs.destinations, 'destination')
    const sourcesChanged = !mapsEqual(this.#sourceLabels, sourceLabels)
    const destinationsChanged = !mapsEqual(this.#destinationLabels, destinationLabels)
    if (!sourcesChanged && !destinationsChanged) return this.snapshot()

    this.#sourceLabels = sourceLabels
    this.#destinationLabels = destinationLabels
    this.#knownSourceCount = countUnion(this.#sourceLabels, this.#destinationsBySource)
    this.#knownDestinationCount = countUnion(this.#destinationLabels, this.#routes)
    this.#labelRevision += 1
    const snapshot = this.snapshot()
    this.publish(
      Object.freeze({
        type: 'catalog',
        version: snapshot.version,
        labelRevision: snapshot.labelRevision,
        sourcesChanged,
        destinationsChanged,
        knownSourceCount: snapshot.knownSourceCount,
        knownDestinationCount: snapshot.knownDestinationCount,
      }),
    )
    return snapshot
  }

  markReady(): void {
    this.setPhase('ready')
  }

  markDegraded(): void {
    this.setPhase('degraded')
  }

  markStale(): void {
    this.setPhase('stale')
  }

  markLabelsLoading(): void {
    this.setLabelPhase('loading')
  }

  markLabelsReady(): void {
    this.setLabelPhase('ready')
  }

  markLabelsDegraded(): void {
    this.setLabelPhase('degraded')
  }

  source(destination: number, level: number): number | null {
    validateAddress(destination, 'destination')
    validateAddress(level, 'level')
    return this.#routes.get(destination)?.get(level) ?? null
  }

  destinations(source: number, level: number): readonly number[] {
    validateAddress(source, 'source')
    validateAddress(level, 'level')
    return Object.freeze(
      [...(this.#destinationsBySource.get(source)?.get(level) ?? [])].sort(compareNumbers),
    )
  }

  knownSources(): readonly number[] {
    const addresses = new Set(this.#sourceLabels.keys())
    for (const source of this.#destinationsBySource.keys()) addresses.add(source)
    return Object.freeze([...addresses].sort(compareNumbers))
  }

  knownDestinations(): readonly number[] {
    const addresses = new Set(this.#destinationLabels.keys())
    for (const destination of this.#routes.keys()) addresses.add(destination)
    return Object.freeze([...addresses].sort(compareNumbers))
  }

  destinationSummary(
    destination: number,
    configuredLevelCount: number,
  ): RossSwp08DestinationSummary {
    validateAddress(destination, 'destination')
    validateAddress(configuredLevelCount, 'configuredLevelCount')
    const levels = this.#routes.get(destination)
    const sources = new Set<number>()
    let knownLevelCount = 0
    for (let level = 1; level <= configuredLevelCount; level += 1) {
      const source = levels?.get(level)
      if (source === undefined) continue
      knownLevelCount += 1
      sources.add(source)
    }

    if (knownLevelCount === 0) {
      return Object.freeze({
        kind: 'unknown',
        knownLevelCount: 0,
        totalLevelCount: configuredLevelCount,
      })
    }
    if (knownLevelCount < configuredLevelCount) {
      return Object.freeze({
        kind: 'partial',
        sources: Object.freeze([...sources].sort(compareNumbers)),
        knownLevelCount,
        totalLevelCount: configuredLevelCount,
      })
    }
    if (sources.size > 1) {
      return Object.freeze({
        kind: 'mixed',
        sources: Object.freeze([...sources].sort(compareNumbers)),
        knownLevelCount,
        totalLevelCount: configuredLevelCount,
      })
    }

    const source = [...sources][0] as number
    return Object.freeze({
      kind: 'uniform',
      source,
      knownLevelCount,
      totalLevelCount: configuredLevelCount,
    })
  }

  sourcePage(request: RossSwp08RoutePageRequest): RossSwp08SourcePage {
    validatePageRequest(request)
    const search = normalizedSearch(request.search)
    const matches = this.knownSources().filter((address) =>
      resourceMatches(address, this.#sourceLabels.get(address) ?? null, search),
    )
    const page = keysetPage(matches, request.afterAddress, request.limit)
    return Object.freeze({
      version: this.version(),
      labelRevision: this.#labelRevision,
      entries: Object.freeze(
        page.addresses.map((address) =>
          Object.freeze({ address, label: this.#sourceLabels.get(address) ?? null }),
        ),
      ),
      nextAfterAddress: page.nextAfterAddress,
      totalCount: matches.length,
    })
  }

  destinationPage(request: RossSwp08DestinationPageRequest): RossSwp08DestinationPage {
    validateDestinationPageRequest(request)
    const search = normalizedSearch(request.search)
    const sourceDestinations =
      request.source === null
        ? null
        : this.destinationsForSource(request.source, request.levels)
    const candidates =
      sourceDestinations === null
        ? this.knownDestinations()
        : [...sourceDestinations].sort(compareNumbers)
    const matches = candidates.filter((address) =>
      resourceMatches(address, this.#destinationLabels.get(address) ?? null, search),
    )
    const page = keysetPage(matches, request.afterAddress, request.limit)
    return Object.freeze({
      version: this.version(),
      labelRevision: this.#labelRevision,
      entries: Object.freeze(
        page.addresses.map((address) => {
          const levels = this.#routes.get(address)
          const routes = Object.freeze(
            [...(levels ?? [])]
              .sort(([left], [right]) => compareNumbers(left, right))
              .map(([level, source]) => Object.freeze({ level, source })),
          )
          return Object.freeze({
            address,
            label: this.#destinationLabels.get(address) ?? null,
            routes,
          })
        }),
      ),
      nextAfterAddress: page.nextAfterAddress,
      totalCount: matches.length,
    })
  }

  snapshot(): RossSwp08RoutingStateSnapshot {
    return Object.freeze({
      version: this.version(),
      phase: this.#phase,
      labelPhase: this.#labelPhase,
      labelRevision: this.#labelRevision,
      knownSourceCount: this.#knownSourceCount,
      knownDestinationCount: this.#knownDestinationCount,
      knownCrosspointCount: this.#knownCrosspointCount,
    })
  }

  subscribe(listener: RossSwp08RouteStateListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  private destinationsForSource(source: number, levels: readonly number[]): Set<number> {
    const destinations = new Set<number>()
    const byLevel = this.#destinationsBySource.get(source)
    if (byLevel === undefined) return destinations
    const selectedLevels = levels.length === 0 ? byLevel.keys() : levels
    for (const level of selectedLevels) {
      for (const destination of byLevel.get(level) ?? []) destinations.add(destination)
    }
    return destinations
  }

  private addReverseRoute(source: number, level: number, destination: number): void {
    let byLevel = this.#destinationsBySource.get(source)
    if (byLevel === undefined) {
      byLevel = new Map()
      this.#destinationsBySource.set(source, byLevel)
    }
    let destinations = byLevel.get(level)
    if (destinations === undefined) {
      destinations = new Set()
      byLevel.set(level, destinations)
    }
    destinations.add(destination)
  }

  private removeReverseRoute(source: number, level: number, destination: number): void {
    const byLevel = this.#destinationsBySource.get(source)
    const destinations = byLevel?.get(level)
    if (byLevel === undefined || destinations === undefined) return
    destinations.delete(destination)
    if (destinations.size === 0) byLevel.delete(level)
    if (byLevel.size === 0) this.#destinationsBySource.delete(source)
  }

  private setPhase(phase: RossSwp08RouteSyncPhase): void {
    if (phase === this.#phase) return
    this.#phase = phase
    this.publish(Object.freeze({ type: 'phase', version: this.version(), phase }))
  }

  private setLabelPhase(phase: RossSwp08LabelPhase): void {
    if (phase === this.#labelPhase) return
    this.#labelPhase = phase
    this.publish(
      Object.freeze({
        type: 'label-phase',
        version: this.version(),
        labelRevision: this.#labelRevision,
        phase,
      }),
    )
  }

  private version(): RossSwp08RouteVersion {
    return Object.freeze({ generation: this.#generation, revision: this.#revision })
  }

  private nextGeneration(): string {
    const generation = this.#createGeneration()
    if (typeof generation !== 'string' || !UUID_PATTERN.test(generation)) {
      throw new TypeError('Ross route generation must be an RFC 4122 UUID')
    }
    return generation
  }

  private publish(event: RossSwp08RouteStateEvent): void {
    this.#eventQueue.push(event)
    if (this.#publishing) return
    this.#publishing = true
    try {
      while (this.#eventQueue.length > 0) {
        const next = this.#eventQueue.shift()
        if (next === undefined) continue
        for (const listener of [...this.#listeners]) {
          try {
            listener(next)
          } catch {
            // Observers cannot interrupt authoritative route-state transitions.
          }
        }
      }
    } finally {
      this.#publishing = false
    }
  }
}
export {
  MAX_ROSS_SWP08_ACTIVE_ROUTE_OPERATIONS,
  MAX_ROSS_SWP08_COMMAND_TARGETS,
  MAX_ROSS_SWP08_COMPLETED_ROUTE_OPERATIONS,
  MAX_ROSS_SWP08_INTERROGATE_DESTINATIONS,
  MAX_ROSS_SWP08_ROUTE_MAPPINGS,
  type RossSwp08CrosspointDelta,
  type RossSwp08DestinationPage,
  type RossSwp08DestinationPageRequest,
  type RossSwp08DestinationSummary,
  type RossSwp08InterrogateDispatchOutcome,
  type RossSwp08InterrogateRequest,
  type RossSwp08InterrogateRequestCode,
  type RossSwp08InterrogateResult,
  type RossSwp08InterrogateTarget,
  type RossSwp08InterrogateTargetOutcome,
  type RossSwp08LabelPhase,
  type RossSwp08RouteCrosspointsRequest,
  type RossSwp08RouteCrosspointsResult,
  type RossSwp08RouteDispatchOutcome,
  type RossSwp08RouteMapping,
  type RossSwp08RoutePageRequest,
  type RossSwp08RouteReadStamp,
  type RossSwp08RouteRequestCode,
  type RossSwp08RouteStateEvent,
  type RossSwp08RouteStateListener,
  type RossSwp08RouteSyncPhase,
  type RossSwp08RouteTargetOutcome,
  type RossSwp08RouteVersion,
  type RossSwp08RoutingStateOptions,
  type RossSwp08RoutingStateSnapshot,
  type RossSwp08SourcePage,
} from './routing-models.js'
