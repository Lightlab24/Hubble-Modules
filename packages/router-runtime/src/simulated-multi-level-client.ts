import type {
  OgpCrosspoint,
  OgpLevel,
  OgpRouterLabel,
  UltrixOgpConnectionPhase,
  UltrixOgpSnapshot,
} from '@hubble/protocol-ultrix-ogp'
import type {
  MultiLevelRouterClientEvent,
  MultiLevelRouterConnectionDefinition,
  MultiLevelRouterManagedClient,
} from './multi-level-types.js'
import {
  SIMULATED_ROUTER_LATENCY_MS,
  SimulatedCommandQueue,
  assertAddress,
  initialSource,
  simulatedLatency,
  type SimulatedRouterOptions,
} from './simulated-router.js'

const EMPTY = Object.freeze([]) as readonly never[]
const QUARTZ_LEVEL_LETTERS = 'VABCDEFGHIJKLMNOPQRSTUWXYZ'
/** Quartz reports a destination locked from any panel as owner 255. */
const QUARTZ_LOCKED = 255

/**
 * A simulated Ultrix or Quartz, sized by Sources, Destinations and Levels. Every
 * level of each output starts on the input with the same number, and routes
 * stay while the module runs, as a router keeps them between client connections.
 */
export class SimulatedMultiLevelRouterClient implements MultiLevelRouterManagedClient {
  readonly #listeners = new Set<(event: MultiLevelRouterClientEvent) => void>()
  readonly #queue = new SimulatedCommandQueue()
  /** Sources by destination, one entry per level. */
  readonly #routes = new Map<number, number[]>()
  readonly #sources: readonly OgpRouterLabel[]
  readonly #destinations: readonly OgpRouterLabel[]
  readonly #levels: readonly OgpLevel[]
  readonly #multiSetEnabled: boolean
  readonly #latencyMs: number
  readonly label: string
  readonly sourceCount: number
  readonly destinationCount: number
  readonly levelCount: number
  #phase: UltrixOgpConnectionPhase = 'disconnected'
  #epoch = 0
  #revision = 0
  #catalogRevision = 0
  #connecting: Promise<void> | null = null
  #snapshot: UltrixOgpSnapshot | null = null

  constructor(
    definition: MultiLevelRouterConnectionDefinition,
    options: SimulatedRouterOptions = {},
  ) {
    const quartz = definition.type === 'evertz-quartz'
    this.sourceCount = definition.sourceLimit
    this.destinationCount = definition.destinationLimit
    this.levelCount = definition.levels
    assertAddress(this.sourceCount, 65_536, 'Simulated router sources')
    assertAddress(this.destinationCount, 65_536, 'Simulated router destinations')
    assertAddress(this.levelCount, quartz ? QUARTZ_LEVEL_LETTERS.length : 256, 'Simulated router levels')
    this.label = quartz ? 'Simulated Quartz' : 'Simulated Ultrix'
    this.#multiSetEnabled = !quartz
    this.#latencyMs = options.latencyMs ?? SIMULATED_ROUTER_LATENCY_MS
    this.#sources = labels('Source', this.sourceCount)
    this.#destinations = labels('Destination', this.destinationCount)
    // Quartz names its levels by letter, V first. An Ultrix of 17 levels is video and 16 audio.
    this.#levels = Object.freeze(
      Array.from({ length: this.levelCount }, (_, index) =>
        Object.freeze({
          level: index + 1,
          label: quartz
            ? (QUARTZ_LEVEL_LETTERS[index] ?? '')
            : index === 0
              ? 'Video'
              : `Audio ${String(index)}`,
        }),
      ),
    )
    for (let destination = 1; destination <= this.destinationCount; destination += 1)
      this.#routes.set(
        destination,
        Array.from({ length: this.levelCount }, () =>
          initialSource(destination, this.sourceCount),
        ),
      )
  }

  connect(): Promise<void> {
    if (this.#phase === 'connected') return Promise.resolve()
    if (this.#connecting !== null) return this.#connecting
    const epoch = ++this.#epoch
    this.#transition('connecting')
    const connecting = simulatedLatency(this.#latencyMs).then(() => {
      if (epoch !== this.#epoch) throw new Error(`${this.label} connection was closed`)
      this.#revision += 1
      this.#catalogRevision += 1
      this.#transition('connected')
    })
    this.#connecting = connecting
    const clear = () => {
      if (this.#connecting === connecting) this.#connecting = null
    }
    connecting.then(clear, clear)
    return connecting
  }

  disconnect(): void {
    this.#epoch += 1
    this.#connecting = null
    if (this.#phase !== 'disconnected') this.#transition('disconnected')
  }

  snapshot(): UltrixOgpSnapshot {
    this.#snapshot ??= this.#buildSnapshot()
    return this.#snapshot
  }

  subscribe(listener: (event: MultiLevelRouterClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  refreshNames(): Promise<void> {
    return this.command(() => {
      this.#catalogRevision += 1
      this.#invalidate()
      const snapshot = this.snapshot()
      this.emit({
        type: 'names',
        names: Object.freeze({
          revision: snapshot.catalogRevision,
          sources: snapshot.sources,
          destinations: snapshot.destinations,
        }),
      })
    })
  }

  refreshRoutes(): Promise<void> {
    return this.command(() => undefined)
  }

  async readDestination(
    destination: number,
    levels?: readonly number[],
  ): Promise<readonly OgpCrosspoint[]> {
    assertAddress(destination, this.destinationCount, 'destination')
    const selected = this.#selectLevels(levels)
    return this.command(() => {
      const sources = this.#routes.get(destination) ?? []
      return Object.freeze(
        selected.map((level) =>
          Object.freeze({ destination, level, source: sources[level - 1] ?? null }),
        ),
      )
    })
  }

  async setCrosspoint(input: {
    readonly source: number
    readonly destination: number
    readonly levels?: readonly number[]
  }): Promise<void> {
    assertAddress(input.source, this.sourceCount, 'source')
    assertAddress(input.destination, this.destinationCount, 'destination')
    const levels = this.#selectLevels(input.levels)
    return this.command(() => {
      this.checkWritable(input.destination)
      const sources = this.#routes.get(input.destination)
      if (sources === undefined) throw new Error(`${this.label} has no such destination`)
      const changed: OgpCrosspoint[] = []
      for (const level of levels) {
        if (sources[level - 1] === input.source) continue
        sources[level - 1] = input.source
        changed.push(
          Object.freeze({ destination: input.destination, level, source: input.source }),
        )
      }
      if (changed.length === 0) return
      const previousRevision = this.#revision
      this.#revision += 1
      this.#invalidate()
      const [only] = changed
      if (changed.length === 1 && only !== undefined)
        this.emit({ type: 'route', crosspoint: only, previousRevision, revision: this.#revision })
      else
        this.emit({
          type: 'routes',
          crosspoints: Object.freeze(changed),
          previousRevision,
          revision: this.#revision,
        })
    })
  }

  /** A router subclass refuses a write here, as Quartz does for a locked destination. */
  protected checkWritable(_destination: number): void {}

  protected get connected(): boolean {
    return this.#phase === 'connected'
  }

  protected command<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    try {
      this.#requireConnected()
      signal?.throwIfAborted()
    } catch (error) {
      return Promise.reject(error as Error)
    }
    const epoch = this.#epoch
    return this.#queue.run(async () => {
      this.#requireConnected(epoch)
      await simulatedLatency(this.#latencyMs)
      this.#requireConnected(epoch)
      signal?.throwIfAborted()
      return operation()
    })
  }

  protected emit(event: MultiLevelRouterClientEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // Observers cannot interrupt the simulated router.
      }
    }
  }

  #selectLevels(levels: readonly number[] | undefined): readonly number[] {
    const selected =
      levels === undefined || levels.length === 0
        ? Array.from({ length: this.levelCount }, (_, index) => index + 1)
        : [...levels]
    const unique = new Set<number>()
    for (const level of selected) {
      assertAddress(level, this.levelCount, 'level')
      if (unique.has(level)) throw new Error(`Duplicate route level ${String(level)}`)
      unique.add(level)
    }
    return Object.freeze([...unique].sort((left, right) => left - right))
  }

  #requireConnected(epoch = this.#epoch): void {
    if (this.#phase !== 'connected' || epoch !== this.#epoch)
      throw new Error(`${this.label} is not connected`)
  }

  #transition(phase: UltrixOgpConnectionPhase): void {
    this.#phase = phase
    this.#invalidate()
    this.emit({ type: 'phase', phase, error: null })
  }

  #invalidate(): void {
    this.#snapshot = null
  }

  #buildSnapshot(): UltrixOgpSnapshot {
    const connected = this.#phase === 'connected'
    const routes: OgpCrosspoint[] = []
    if (connected)
      for (const [destination, sources] of [...this.#routes].sort(
        ([left], [right]) => left - right,
      ))
        sources.forEach((source, index) => {
          routes.push(Object.freeze({ destination, level: index + 1, source }))
        })
    return Object.freeze({
      phase: this.#phase,
      revision: this.#revision,
      catalogRevision: this.#catalogRevision,
      controlReady: connected,
      takeError: null,
      sources: connected ? this.#sources : EMPTY,
      destinations: connected ? this.#destinations : EMPTY,
      levels: connected ? this.#levels : EMPTY,
      routes: Object.freeze(routes),
      subscriptions: connected ? Object.freeze(['simulated-router']) : EMPTY,
      multiSetEnabled: connected && this.#multiSetEnabled,
      lastError: null,
    })
  }
}

/**
 * Quartz also locks destinations and recalls system salvos 1–32. A lock refuses
 * takes to that destination until it is unlocked. A new controller's salvos
 * are empty, so a recall changes no routes.
 */
export class SimulatedQuartzRouterClient extends SimulatedMultiLevelRouterClient {
  readonly #locks = new Map<number, number>()

  destinationLocks(): ReadonlyMap<number, number> {
    return this.connected ? new Map(this.#locks) : new Map()
  }

  setDestinationLock(destination: number, locked: boolean, signal?: AbortSignal): Promise<void> {
    try {
      assertAddress(destination, this.destinationCount, 'destination')
    } catch (error) {
      return Promise.reject(error as Error)
    }
    return this.command(() => {
      this.#locks.set(destination, locked ? QUARTZ_LOCKED : 0)
      this.emit({ type: 'locks' })
    }, signal)
  }

  recallSalvo(salvo: number, signal?: AbortSignal): Promise<void> {
    try {
      assertAddress(salvo, 32, 'Quartz salvo')
    } catch (error) {
      return Promise.reject(error as Error)
    }
    return this.command(() => undefined, signal)
  }

  protected override checkWritable(destination: number): void {
    if ((this.#locks.get(destination) ?? 0) !== 0)
      throw new Error(
        `Quartz rejected the take: destination ${String(destination)} is locked`,
      )
  }
}

export function createSimulatedMultiLevelClient(
  definition: MultiLevelRouterConnectionDefinition,
  options: SimulatedRouterOptions = {},
): MultiLevelRouterManagedClient {
  return definition.type === 'evertz-quartz'
    ? new SimulatedQuartzRouterClient(definition, options)
    : new SimulatedMultiLevelRouterClient(definition, options)
}

function labels(prefix: string, count: number): readonly OgpRouterLabel[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        address: index + 1,
        label: `${prefix} ${String(index + 1)}`,
        description: null,
      }),
    ),
  )
}
