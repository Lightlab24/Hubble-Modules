import type {
  VideohubClientEvent,
  VideohubConnectionPhase,
  VideohubCrosspoint,
  VideohubOutputLock,
  VideohubRouterLabel,
  VideohubSnapshot,
} from '@hubble/protocol-videohub'
import {
  SIMULATED_KUMO_SIZE,
  SIMULATED_ROUTER_LATENCY_MS,
  SIMULATED_VIDEOHUB_SIZE,
  SimulatedCommandQueue,
  assertAddress,
  initialSource,
  simulatedLatency,
  type SimulatedRouterOptions,
} from './simulated-router.js'
import type {
  SingleLevelRouterConnectionDefinition,
  SingleLevelRouterManagedClient,
} from './single-level-types.js'

const EMPTY = Object.freeze([]) as readonly never[]

/**
 * A simulated Videohub or KUMO. It is sized by Sources and Destinations, or by
 * a common model when they are blank, starts with each output on its own input,
 * and keeps its routes while the module runs, as a router keeps them between
 * client connections.
 */
export class SimulatedSingleLevelRouterClient implements SingleLevelRouterManagedClient {
  readonly #listeners = new Set<(event: VideohubClientEvent) => void>()
  readonly #queue = new SimulatedCommandQueue()
  readonly #routes = new Map<number, number>()
  readonly #sources: readonly VideohubRouterLabel[]
  readonly #destinations: readonly VideohubRouterLabel[]
  readonly #locks: readonly VideohubOutputLock[]
  readonly #modelName: string
  readonly #protocolVersion: string | null
  readonly #latencyMs: number
  readonly #label: string
  readonly sourceCount: number
  readonly destinationCount: number
  #phase: VideohubConnectionPhase = 'disconnected'
  #epoch = 0
  #revision = 0
  #catalogRevision = 0
  #confirmedOperationSequence = 0
  #connecting: Promise<void> | null = null
  #snapshot: VideohubSnapshot | null = null

  constructor(
    definition: SingleLevelRouterConnectionDefinition,
    options: SimulatedRouterOptions = {},
  ) {
    const kumo = definition.type === 'aja-kumo'
    const fallback = kumo ? SIMULATED_KUMO_SIZE : SIMULATED_VIDEOHUB_SIZE
    this.sourceCount = definition.sourceLimit ?? fallback
    this.destinationCount = definition.destinationLimit ?? fallback
    assertAddress(this.sourceCount, 65_536, 'Simulated router sources')
    assertAddress(this.destinationCount, 65_536, 'Simulated router destinations')
    this.#label = kumo ? 'Simulated AJA KUMO' : 'Simulated Videohub'
    this.#modelName = `${kumo ? 'Simulated KUMO' : 'Simulated Videohub'} ${String(
      this.sourceCount,
    )}x${String(this.destinationCount)}`
    this.#protocolVersion = kumo ? null : '2.8'
    this.#latencyMs = options.latencyMs ?? SIMULATED_ROUTER_LATENCY_MS
    // A new Videohub names its ports Input/Output; a new KUMO Source/Dest.
    const [input, output] = kumo ? ['Source', 'Dest'] : ['Input', 'Output']
    this.#sources = labels(input, this.sourceCount)
    this.#destinations = labels(output, this.destinationCount)
    this.#locks = Object.freeze(
      Array.from({ length: this.destinationCount }, (_, index) =>
        Object.freeze({ destination: index + 1, state: 'unlocked' as const }),
      ),
    )
    for (let destination = 1; destination <= this.destinationCount; destination += 1)
      this.#routes.set(destination, initialSource(destination, this.sourceCount))
  }

  connect(): Promise<void> {
    if (this.#phase === 'connected') return Promise.resolve()
    if (this.#connecting !== null) return this.#connecting
    const epoch = ++this.#epoch
    this.#transition('connecting')
    const connecting = simulatedLatency(this.#latencyMs).then(() => {
      if (epoch !== this.#epoch) throw new Error(`${this.#label} connection was closed`)
      // A new session reads the router afresh, as a real client does.
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

  snapshot(): VideohubSnapshot {
    this.#snapshot ??= this.#buildSnapshot()
    return this.#snapshot
  }

  subscribe(listener: (event: VideohubClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  refreshNames(): Promise<void> {
    return this.#command(() => {
      this.#catalogRevision += 1
      this.#invalidate()
      const snapshot = this.snapshot()
      this.#emit({
        type: 'names',
        names: Object.freeze({
          revision: snapshot.catalogRevision,
          sources: snapshot.sources,
          destinations: snapshot.destinations,
          degraded: false,
          stale: false,
        }),
      })
    })
  }

  refreshRoutes(): Promise<void> {
    // Nothing else changes a simulated router, so a full read matches what is held.
    return this.#command(() => undefined)
  }

  async readDestination(destination: number): Promise<VideohubCrosspoint> {
    assertAddress(destination, this.destinationCount, 'destination')
    return this.#command(() =>
      Object.freeze({ destination, source: this.#routes.get(destination) ?? 1 }),
    )
  }

  async setCrosspoint(input: VideohubCrosspoint): Promise<void> {
    assertAddress(input.source, this.sourceCount, 'source')
    assertAddress(input.destination, this.destinationCount, 'destination')
    return this.#command(() => {
      if (this.#routes.get(input.destination) !== input.source) {
        this.#routes.set(input.destination, input.source)
        const previousRevision = this.#revision
        this.#revision += 1
        this.#invalidate()
        const crosspoint = Object.freeze({
          destination: input.destination,
          source: input.source,
        })
        this.#emit({ type: 'route', crosspoint, previousRevision, revision: this.#revision })
        this.#emit({ type: 'route-observation', crosspoint, revision: this.#revision })
      }
      // Like the hardware clients, count every confirmed write, unchanged or not.
      this.#confirmedOperationSequence += 1
      this.#invalidate()
    })
  }

  protected command<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    return this.#command(operation, signal)
  }

  #command<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
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

  #requireConnected(epoch = this.#epoch): void {
    if (this.#phase !== 'connected' || epoch !== this.#epoch)
      throw new Error(`${this.#label} is not connected`)
  }

  #transition(phase: VideohubConnectionPhase): void {
    this.#phase = phase
    this.#invalidate()
    this.#emit({ type: 'phase', phase, error: null })
  }

  #invalidate(): void {
    this.#snapshot = null
  }

  #buildSnapshot(): VideohubSnapshot {
    const connected = this.#phase === 'connected'
    return Object.freeze({
      phase: this.#phase,
      revision: this.#revision,
      catalogRevision: this.#catalogRevision,
      confirmedOperationSequence: this.#confirmedOperationSequence,
      protocolVersion: connected ? this.#protocolVersion : null,
      deviceStatus: connected ? 'present' : 'unknown',
      modelName: connected ? this.#modelName : null,
      detectedSourceCount: connected ? this.sourceCount : null,
      detectedDestinationCount: connected ? this.destinationCount : null,
      sourceCount: connected ? this.sourceCount : null,
      destinationCount: connected ? this.destinationCount : null,
      sources: connected ? this.#sources : EMPTY,
      destinations: connected ? this.#destinations : EMPTY,
      routes: connected
        ? Object.freeze(
            [...this.#routes]
              .sort(([left], [right]) => left - right)
              .map(([destination, source]) => Object.freeze({ destination, source })),
          )
        : EMPTY,
      locks: connected ? this.#locks : EMPTY,
      labelsDegraded: false,
      catalogStale: false,
      lastError: null,
    })
  }

  #emit(event: VideohubClientEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // Observers cannot interrupt the simulated router.
      }
    }
  }
}

/** A KUMO also recalls salvos. A new KUMO's eight salvos are empty, so a recall changes no routes. */
export class SimulatedKumoRouterClient extends SimulatedSingleLevelRouterClient {
  readonly #salvos = Object.freeze(
    Array.from({ length: 8 }, (_, index) =>
      Object.freeze({ address: index + 1, name: `Salvo ${String(index + 1)}` }),
    ),
  )

  salvoCatalog(): readonly VideohubRouterLabel[] {
    return this.#salvos
  }

  recallSalvo(salvo: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(salvo) || salvo < 1 || salvo > 8)
      return Promise.reject(new RangeError('AJA KUMO salvo must be an integer from 1 to 8'))
    return this.command(() => undefined, signal)
  }
}

export function createSimulatedSingleLevelClient(
  definition: SingleLevelRouterConnectionDefinition,
  options: SimulatedRouterOptions = {},
): SingleLevelRouterManagedClient {
  return definition.type === 'aja-kumo'
    ? new SimulatedKumoRouterClient(definition, options)
    : new SimulatedSingleLevelRouterClient(definition, options)
}

function labels(prefix: string, count: number): readonly VideohubRouterLabel[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({ address: index + 1, name: `${prefix} ${String(index + 1)}` }),
    ),
  )
}
