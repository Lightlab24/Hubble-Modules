import type {
  VideohubClientEvent,
  VideohubCrosspoint,
  VideohubOutputLock,
  VideohubRouterLabel,
  VideohubSnapshot,
} from '@hubble/protocol-videohub'
import type { SingleLevelRouterManagedClient } from '@hubble/router-runtime/single-level-manager'
import { setTimeout as delay } from 'node:timers/promises'
import type { AjaKumoConnectionDefinition } from './config.js'
import { emptySnapshot } from './kumo-state.js'
import { KumoHttpError, KumoHttpTransport, boundedRequests } from './kumo-transport.js'
import {
  EVENT_TIMEOUT_MS,
  type JsonObject,
  LOCK_REFRESH_MS,
  address,
  label,
  locked,
  object,
  salvoName,
} from './kumo-values.js'

export class AjaKumoClient implements SingleLevelRouterManagedClient {
  readonly #listeners = new Set<(event: VideohubClientEvent) => void>()
  readonly #transport: KumoHttpTransport
  readonly #routes = new Map<number, number>()
  readonly #locks = new Map<number, VideohubOutputLock>()
  readonly #sourceLines = new Map<number, [string, string]>()
  readonly #destinationLines = new Map<number, [string, string]>()
  readonly #salvoNames = new Map<number, string>()
  readonly #observations = new Map<number, number>()
  #lifetime = new AbortController()
  #state: VideohubSnapshot = emptySnapshot()
  #connectionId: string | null = null
  #lockRefresh: NodeJS.Timeout | null = null

  constructor(private readonly definition: AjaKumoConnectionDefinition) {
    this.#transport = new KumoHttpTransport(definition)
  }

  snapshot(): VideohubSnapshot {
    return this.#state
  }

  salvoCatalog(): readonly VideohubRouterLabel[] {
    return Object.freeze(
      [...this.#salvoNames]
        .sort(([left], [right]) => left - right)
        .map(([address, name]) => Object.freeze({ address, name })),
    )
  }

  subscribe(listener: (event: VideohubClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async connect(): Promise<void> {
    this.disconnect()
    this.#lifetime = new AbortController()
    const signal = this.#lifetime.signal
    this.#phase('connecting', null)
    try {
      if (this.definition.password !== '') {
        const body = new URLSearchParams({
          password_provided: this.definition.password,
        }).toString()
        const response = object(
          await this.#transport.request('/authenticator/login', signal, body),
        )
        if (response.login !== 'success') throw new Error('AJA KUMO authentication failed')
      }
      const session = object(await this.#config({ action: 'connect' }, signal))
      if (
        (typeof session.connectionid !== 'string' &&
          typeof session.connectionid !== 'number') ||
        !/^[0-9]+$/u.test(String(session.connectionid))
      )
        throw new Error('AJA KUMO returned an invalid connection ID')
      this.#connectionId = String(session.connectionid)
      this.#phase('synchronizing', null)
      const sources = address((await this.#get('eParamID_NumberOfSources', signal)).value)
      const destinations = address(
        (await this.#get('eParamID_NumberOfDestinations', signal)).value,
      )
      const product = await this.#get('eParamID_KumoProductID', signal)
      this.#state = Object.freeze({
        ...this.#state,
        deviceStatus: 'present',
        modelName: label(product.value_name) || 'AJA KUMO',
        detectedSourceCount: sources,
        detectedDestinationCount: destinations,
        sourceCount: Math.min(sources, this.definition.sourceLimit ?? sources),
        destinationCount: Math.min(
          destinations,
          this.definition.destinationLimit ?? destinations,
        ),
      })
      await this.refreshNames()
      await this.refreshRoutes()
      await this.#refreshLocks(signal)
      signal.throwIfAborted()
      this.#phase('connected', null)
      void this.#watchEvents(signal)
      this.#scheduleLockRefresh(signal)
    } catch (error) {
      if (!signal.aborted) this.#fail(error)
      throw error
    }
  }

  disconnect(): void {
    const wasDisconnected = this.#state.phase === 'disconnected'
    this.#lifetime.abort()
    if (this.#lockRefresh !== null) clearTimeout(this.#lockRefresh)
    this.#lockRefresh = null
    this.#connectionId = null
    this.#transport.clear()
    this.#routes.clear()
    this.#locks.clear()
    this.#observations.clear()
    this.#sourceLines.clear()
    this.#destinationLines.clear()
    this.#salvoNames.clear()
    this.#state = emptySnapshot(this.#state.confirmedOperationSequence)
    if (!wasDisconnected) this.#phase('disconnected', null)
  }

  async refreshNames(): Promise<void> {
    const signal = this.#signal()
    const requests: (() => Promise<void>)[] = []
    let degraded = false
    for (const kind of ['Source', 'Destination'] as const) {
      const count = kind === 'Source' ? this.#state.sourceCount : this.#state.destinationCount
      const lines = kind === 'Source' ? this.#sourceLines : this.#destinationLines
      for (let number = 1; number <= (count ?? 0); number += 1) {
        requests.push(async () => {
          try {
            const first = await this.#get(
              `eParamID_XPT_${kind}${String(number)}_Line_1`,
              signal,
            )
            const second = await this.#get(
              `eParamID_XPT_${kind}${String(number)}_Line_2`,
              signal,
            )
            lines.set(number, [label(first.value), label(second.value)])
          } catch (error) {
            signal.throwIfAborted()
            // Older firmware can omit names. Routing still works with numbered labels.
            if (!(error instanceof KumoHttpError) || error.status !== 404) throw error
            degraded = true
            lines.set(number, ['', ''])
          }
        })
      }
    }
    for (let number = 1; number <= 8; number += 1) {
      requests.push(async () => {
        try {
          const result = await this.#get(`eParamID_Salvo${String(number)}`, signal)
          this.#salvoNames.set(number, salvoName(result.value))
        } catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof KumoHttpError) || error.status !== 404) throw error
          this.#salvoNames.set(number, '')
        }
      })
    }
    await boundedRequests(requests)
    signal.throwIfAborted()
    this.#publishNames(degraded)
  }

  async refreshRoutes(): Promise<void> {
    const signal = this.#signal()
    await boundedRequests(
      Array.from({ length: this.#state.destinationCount ?? 0 }, (_, index) => async () => {
        await this.#readDestination(index + 1, signal)
      }),
    )
  }

  async readDestination(destination: number): Promise<VideohubCrosspoint> {
    this.#assertConnected()
    address(destination, this.#state.destinationCount ?? 0)
    return this.#readDestination(destination, this.#signal())
  }

  async setCrosspoint(crosspoint: VideohubCrosspoint): Promise<void> {
    this.#assertConnected()
    address(crosspoint.source, this.#state.sourceCount ?? 0)
    address(crosspoint.destination, this.#state.destinationCount ?? 0)
    const signal = this.#signal()
    // Read locks immediately before writing: firmware does not reliably emit lock events.
    const lock = await this.#readLock(crosspoint.destination, signal)
    if (lock?.state === 'locked') throw new Error('AJA KUMO output is locked')
    await this.#config(
      {
        action: 'set',
        paramid: `eParamID_XPT_Destination${String(crosspoint.destination)}_Status`,
        value: String(crosspoint.source),
      },
      signal,
    )
    const confirmed = await this.#readDestination(crosspoint.destination, signal)
    signal.throwIfAborted()
    if (confirmed.source !== crosspoint.source)
      throw new Error('AJA KUMO route was not confirmed')
    this.#state = Object.freeze({
      ...this.#state,
      confirmedOperationSequence: this.#state.confirmedOperationSequence + 1,
    })
  }

  async recallSalvo(salvo: number, cancellation?: AbortSignal): Promise<void> {
    this.#assertConnected()
    if (!Number.isInteger(salvo) || salvo < 1 || salvo > 8) {
      throw new RangeError('AJA KUMO salvo must be an integer from 1 to 8')
    }
    const lifetime = this.#signal()
    const signal =
      cancellation === undefined ? lifetime : AbortSignal.any([lifetime, cancellation])
    const result = object(
      await this.#config(
        {
          action: 'set',
          paramid: 'eParamID_TakeSalvo',
          value: String(salvo),
        },
        signal,
      ),
    )
    if (result.value !== salvo && result.value !== String(salvo)) {
      throw new Error('AJA KUMO salvo recall was not acknowledged')
    }
    // Acknowledgement confirms the recall request, not that every output switched.
    // Read the actual routes, including any outputs the router kept locked.
    await boundedRequests(
      Array.from({ length: this.#state.destinationCount ?? 0 }, (_, index) => async () => {
        await this.#readDestination(index + 1, signal)
      }),
    )
    signal.throwIfAborted()
  }

  async #readDestination(
    destination: number,
    signal: AbortSignal,
  ): Promise<VideohubCrosspoint> {
    const observation = this.#observations.get(destination) ?? 0
    const result = await this.#get(
      `eParamID_XPT_Destination${String(destination)}_Status`,
      signal,
    )
    const source = address(result.value, this.#state.detectedSourceCount ?? 0)
    // An event received while this read was in flight is newer than that read's baseline.
    if ((this.#observations.get(destination) ?? 0) === observation)
      this.#route(destination, source)
    return Object.freeze({ destination, source: this.#routes.get(destination) ?? source })
  }

  async #readLock(
    destination: number,
    signal: AbortSignal,
  ): Promise<VideohubOutputLock | null> {
    try {
      const result = await this.#get(
        `eParamID_XPT_Destination${String(destination)}_Locked`,
        signal,
      )
      const lock = Object.freeze({
        destination,
        state: locked(result.value) ? 'locked' : 'unlocked',
      } as const)
      this.#locks.set(destination, lock)
      this.#state = Object.freeze({
        ...this.#state,
        locks: Object.freeze([...this.#locks.values()]),
      })
      this.#emit({ type: 'lock', lock })
      return lock
    } catch (error) {
      if (error instanceof KumoHttpError && error.status === 404) return null
      throw error
    }
  }

  async #refreshLocks(signal: AbortSignal): Promise<void> {
    await boundedRequests(
      Array.from({ length: this.#state.destinationCount ?? 0 }, (_, index) => async () => {
        await this.#readLock(index + 1, signal)
      }),
    )
  }

  #scheduleLockRefresh(signal: AbortSignal): void {
    if (signal.aborted) return
    this.#lockRefresh = setTimeout(() => {
      this.#lockRefresh = null
      void this.#refreshLocks(signal).then(
        () => {
          this.#scheduleLockRefresh(signal)
        },
        (error: unknown) => {
          if (!signal.aborted) this.#fail(error)
        },
      )
    }, LOCK_REFRESH_MS)
    this.#lockRefresh.unref()
  }

  async #watchEvents(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const events = await this.#config(
          {
            action: 'wait_for_config_events',
            connectionid: this.#connectionId ?? '',
          },
          signal,
          EVENT_TIMEOUT_MS,
        )
        if (!Array.isArray(events))
          throw new Error('AJA KUMO returned invalid configuration events')
        for (const item of events) this.#event(object(item))
        await delay(25, undefined, { signal })
      }
    } catch (error) {
      if (!signal.aborted) this.#fail(error)
    }
  }

  #event(event: JsonObject): void {
    if (typeof event.param_id !== 'string') return
    const salvo = /^eParamID_Salvo([1-8])$/u.exec(event.param_id)
    if (salvo !== null) {
      this.#salvoNames.set(Number(salvo[1]), salvoName(event.str_value))
      this.#publishNames(this.#state.labelsDegraded)
      return
    }
    const route = /^eParamID_XPT_Destination([0-9]+)_Status$/u.exec(event.param_id)
    if (route !== null) {
      const destination = address(route[1], this.#state.detectedDestinationCount ?? 0)
      const source = address(event.int_value, this.#state.detectedSourceCount ?? 0)
      if (destination <= (this.#state.destinationCount ?? 0)) {
        this.#observations.set(destination, (this.#observations.get(destination) ?? 0) + 1)
        this.#route(destination, source)
      }
      return
    }
    const name = /^eParamID_XPT_(Source|Destination)([0-9]+)_Line_([12])$/u.exec(event.param_id)
    if (name !== null) {
      const source = name[1] === 'Source'
      const number = address(
        name[2],
        source
          ? (this.#state.detectedSourceCount ?? 0)
          : (this.#state.detectedDestinationCount ?? 0),
      )
      if (
        number > (source ? (this.#state.sourceCount ?? 0) : (this.#state.destinationCount ?? 0))
      )
        return
      const lines = source ? this.#sourceLines : this.#destinationLines
      const current = lines.get(number) ?? ['', '']
      lines.set(
        number,
        name[3] === '1'
          ? [label(event.str_value), current[1]]
          : [current[0], label(event.str_value)],
      )
      this.#publishNames(this.#state.labelsDegraded)
      return
    }
    const lock = /^eParamID_XPT_Destination([0-9]+)_Locked$/u.exec(event.param_id)
    if (lock !== null) {
      const destination = address(lock[1], this.#state.detectedDestinationCount ?? 0)
      if (destination > (this.#state.destinationCount ?? 0)) return
      const update = Object.freeze({
        destination,
        state: locked(event.int_value) ? 'locked' : 'unlocked',
      } as const)
      this.#locks.set(destination, update)
      this.#state = Object.freeze({
        ...this.#state,
        locks: Object.freeze([...this.#locks.values()]),
      })
      this.#emit({ type: 'lock', lock: update })
    }
    if (
      /^eParamID_(NumberOfSources|NumberOfDestinations|KumoProductID)$/u.test(event.param_id)
    ) {
      throw new Error('AJA KUMO device configuration changed; reconnecting')
    }
  }

  #route(destination: number, source: number): void {
    if (this.#routes.get(destination) === source) return
    this.#routes.set(destination, source)
    const previousRevision = this.#state.revision
    this.#state = Object.freeze({
      ...this.#state,
      revision: previousRevision + 1,
      routes: Object.freeze(
        [...this.#routes]
          .filter(([, value]) => value <= (this.#state.sourceCount ?? 0))
          .map(([destination, source]) => Object.freeze({ destination, source })),
      ),
    })
    this.#emit({
      type: 'route',
      crosspoint: Object.freeze({ destination, source }),
      previousRevision,
      revision: this.#state.revision,
    })
  }

  #publishNames(degraded: boolean): void {
    const catalog = (lines: Map<number, [string, string]>): readonly VideohubRouterLabel[] =>
      Object.freeze(
        [...lines]
          .sort(([left], [right]) => left - right)
          .map(([address, parts]) =>
            Object.freeze({ address, name: parts.filter(Boolean).join(' ').slice(0, 128) }),
          ),
      )
    this.#state = Object.freeze({
      ...this.#state,
      sources: catalog(this.#sourceLines),
      destinations: catalog(this.#destinationLines),
      catalogRevision: this.#state.catalogRevision + 1,
      labelsDegraded: degraded,
      catalogStale: false,
    })
    this.#emit({
      type: 'names',
      names: {
        revision: this.#state.catalogRevision,
        sources: this.#state.sources,
        destinations: this.#state.destinations,
        degraded,
        stale: false,
      },
    })
  }

  #get(paramid: string, signal: AbortSignal): Promise<JsonObject> {
    return this.#config({ action: 'get', paramid }, signal).then(object)
  }

  #config(
    params: Record<string, string>,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.#transport.request(
      `/config?${new URLSearchParams({ configid: '0', ...params })}`,
      signal,
      undefined,
      timeoutMs,
    )
  }

  #signal(): AbortSignal {
    this.#lifetime.signal.throwIfAborted()
    if (this.#connectionId === null) throw new Error('AJA KUMO is not connected')
    return this.#lifetime.signal
  }

  #assertConnected(): void {
    if (this.#state.phase !== 'connected') throw new Error('AJA KUMO is not connected')
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : 'AJA KUMO protocol error'
    this.disconnect()
    this.#phase('disconnected', message)
  }

  #phase(phase: VideohubSnapshot['phase'], error: string | null): void {
    this.#state = Object.freeze({ ...this.#state, phase, lastError: error })
    this.#emit({ type: 'phase', phase, error })
  }

  #emit(event: VideohubClientEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        /* Observers cannot interrupt the router transport. */
      }
    }
  }
}
