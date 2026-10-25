import type { UltrixOgpSnapshot } from '@hubble/protocol-ultrix-ogp'
import type {
  MultiLevelRouterClientEvent,
  MultiLevelRouterManagedClient,
} from '@hubble/router-runtime/multi-level-manager'
import { Socket } from 'node:net'
import type { EvertzQuartzConnectionDefinition } from '../config.js'
import {
  QUARTZ_LEVELS,
  QuartzFrameDecoder,
  encodeQuartzRoute,
  parseQuartzMessage,
  quartzAddress,
  quartzLevelLetters,
  type QuartzCrosspoint,
  type QuartzMessage,
} from './codec.js'
import {
  LINK_PING_INTERVAL_MS,
  LINK_PONG_TIMEOUT_MS,
  QuartzCommandError,
  asError,
} from './models.js'
import { QuartzRequestQueue } from './requests.js'

export class EvertzQuartzClient implements MultiLevelRouterManagedClient {
  readonly #listeners = new Set<(event: MultiLevelRouterClientEvent) => void>()
  readonly #routes = new Map<string, QuartzCrosspoint>()
  readonly #sources = new Map<number, string>()
  readonly #destinations = new Map<number, string>()
  readonly #locks = new Map<number, number>()
  #phase: UltrixOgpSnapshot['phase'] = 'disconnected'
  #socket: Socket | null = null
  readonly #requests: QuartzRequestQueue
  #takeTail: Promise<void> = Promise.resolve()
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #pingTimer: ReturnType<typeof setTimeout> | null = null
  #connectPromise: Promise<void> | null = null
  #revision = 0
  #catalogRevision = 0
  #epoch = 0
  #lastError: string | null = null

  constructor(
    private readonly definition: EvertzQuartzConnectionDefinition,
    private readonly socketFactory: () => Socket = () => new Socket(),
  ) {
    const client = this
    this.#requests = new QuartzRequestQueue({
      get epoch() {
        return client.#epoch
      },
      get socket() {
        return client.#socket
      },
      get disconnected() {
        return client.#phase === 'disconnected'
      },
      get requestTimeoutMs() {
        return client.definition.requestTimeoutMs
      },
      close: (error) => client.close(error),
    })
  }

  snapshot(): UltrixOgpSnapshot {
    const labels = (names: Map<number, string>) =>
      [...names].map(([address, name]) => ({ address, label: name, description: null }))
    return {
      phase: this.#phase,
      revision: this.#revision,
      catalogRevision: this.#catalogRevision,
      controlReady: this.#phase === 'connected',
      takeError: null,
      sources: labels(this.#sources),
      destinations: labels(this.#destinations),
      levels: Array.from({ length: this.definition.levels }, (_, index) => ({
        level: index + 1,
        label: QUARTZ_LEVELS[index] ?? '',
      })),
      routes: [...this.#routes.values()],
      // Quartz sends updates automatically; there is no subscription command.
      subscriptions: this.#phase === 'connected' ? ['quartz-unsolicited-updates'] : [],
      multiSetEnabled: false,
      lastError: this.#lastError,
    }
  }

  subscribe(listener: (event: MultiLevelRouterClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  connect(): Promise<void> {
    if (this.#connectPromise !== null) return this.#connectPromise
    if (this.#phase === 'connected') return Promise.resolve()
    const promise = this.open()
    this.#connectPromise = promise
    void promise
      .finally(() => {
        if (this.#connectPromise === promise) this.#connectPromise = null
      })
      .catch(() => undefined)
    return promise
  }

  disconnect(): void {
    this.close(new Error('Quartz connection closed'))
  }

  async refreshNames(): Promise<void> {
    const epoch = this.#epoch
    for (const [kind, limit, names] of [
      ['S', this.definition.sourceLimit, this.#sources],
      ['D', this.definition.destinationLimit, this.#destinations],
    ] as const) {
      const refreshed = new Map<number, string>()
      for (let address = 1; address <= limit; address += 1) {
        this.assertEpoch(epoch)
        try {
          let name = ''
          await this.#requests.request(`.R${kind}${String(address)}\r`, (message) => {
            if (message.type !== 'name' || message.kind !== kind) return false
            if (message.address !== null && Number(message.address) !== address) return false
            name = message.name
            return true
          })
          refreshed.set(address, name)
        } catch (error) {
          // Name read support varies by controller. Do not repeatedly ask an unsupported
          // command or scan beyond the first rejected address. Numeric labels stay usable.
          if (!(error instanceof QuartzCommandError)) throw error
          break
        }
      }
      this.assertEpoch(epoch)
      for (let address = 1; address <= limit; address += 1) {
        if (!refreshed.has(address))
          refreshed.set(
            address,
            `${kind === 'S' ? 'Source' : 'Destination'} ${String(address)}`,
          )
      }
      names.clear()
      for (const [address, name] of refreshed) names.set(address, name)
    }
    this.#catalogRevision += 1
    const snapshot = this.snapshot()
    this.emit({
      type: 'names',
      names: {
        revision: this.#catalogRevision,
        sources: snapshot.sources,
        destinations: snapshot.destinations,
      },
    })
  }

  async refreshRoutes(): Promise<void> {
    const epoch = this.#epoch
    for (
      let destination = 1;
      destination <= this.definition.destinationLimit;
      destination += 1
    ) {
      this.assertEpoch(epoch)
      await this.readDestination(destination)
    }
  }

  async readDestination(
    destination: number,
    levels?: readonly number[],
  ): Promise<readonly QuartzCrosspoint[]> {
    quartzAddress(destination, this.definition.destinationLimit)
    const selected = this.levels(levels)
    const result: QuartzCrosspoint[] = []
    const epoch = this.#epoch
    // AN65 specifies one level per interrogation. A multi-level take does not imply
    // that a controller implements multi-level interrogation.
    for (const level of selected) {
      this.assertEpoch(epoch)
      await this.#requests.request(
        `.I${quartzLevelLetters([level], this.definition.levels)}${String(destination)}\r`,
        (message) => {
          if (message.type !== 'routes' || message.update) return false
          const crosspoint = message.crosspoints.find(
            (item) => item.destination === destination && item.level === level,
          )
          if (crosspoint === undefined) return false
          result.push(crosspoint)
          return true
        },
      )
    }
    return result
  }

  async setCrosspoint(input: {
    source: number
    destination: number
    levels?: readonly number[]
  }): Promise<void> {
    quartzAddress(input.source, this.definition.sourceLimit)
    quartzAddress(input.destination, this.definition.destinationLimit)
    const levels = this.levels(input.levels)
    const epoch = this.#epoch
    // Serialize the complete take/readback operation, including the cached-state
    // check. A queued take must see the result of the preceding take.
    const operation = this.#takeTail.then(async () => {
      this.assertEpoch(epoch)
      if (this.#phase !== 'connected') throw new Error('Quartz is disconnected')
      await this.takeCrosspoint(input.source, input.destination, levels)
    })
    this.#takeTail = operation.catch(() => undefined)
    return operation
  }

  private async takeCrosspoint(
    source: number,
    destination: number,
    levels: readonly number[],
  ): Promise<void> {
    const awaiting = new Set(
      levels.filter(
        (level) =>
          this.#routes.get(`${String(destination)}:${String(level)}`)?.source !== source,
      ),
    )
    // CyanView: unchanged crosspoints may produce no update at all. The live
    // routing table already confirms these levels; do not wait for another .U.
    if (awaiting.size === 0) return
    await this.#requests.request(
      encodeQuartzRoute(source, destination, levels, this.definition.levels),
      (message) => {
        if (message.type !== 'routes') return false
        for (const crosspoint of message.crosspoints) {
          if (crosspoint.destination === destination && crosspoint.source === source)
            awaiting.delete(crosspoint.level)
        }
        return awaiting.size === 0
      },
    )
    const confirmed = await this.readDestination(destination, levels)
    if (confirmed.some((crosspoint) => crosspoint.source !== source)) {
      throw new Error('Quartz route readback differs from the requested source')
    }
  }

  async setDestinationLock(
    destination: number,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    quartzAddress(destination, this.definition.destinationLimit)
    const owner = await this.lockRequest(
      `.B${locked ? 'L' : 'U'}${String(destination)}\r`,
      destination,
      signal,
    )
    if ((owner !== 0) !== locked)
      throw new Error('Quartz destination lock did not reach the requested state')
  }

  readDestinationLock(destination: number): Promise<number> {
    quartzAddress(destination, this.definition.destinationLimit)
    return this.lockRequest(`.BI${String(destination)}\r`, destination)
  }

  destinationLocks(): ReadonlyMap<number, number> {
    return new Map(this.#locks)
  }

  async recallSalvo(salvo: number, signal?: AbortSignal): Promise<void> {
    // AN65 section 3.3 documents system salvos 1..32. MAGNUM extensions require
    // controller-specific documentation; never turn an arbitrary preset ID into a take.
    quartzAddress(salvo, 32)
    await this.#requests.request(
      `.F${String(salvo)}\r`,
      (message) => message.type === 'ack',
      signal,
    )
    await this.refreshRoutes()
  }

  private async lockRequest(
    command: string,
    destination: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let owner = 0
    await this.#requests.request(
      command,
      (message) => {
        if (message.type !== 'lock' || message.destination !== destination) return false
        owner = message.owner
        return true
      },
      signal,
    )
    return owner
  }

  private async synchronizeRoutes(epoch: number): Promise<void> {
    for (
      let destination = 1;
      destination <= this.definition.destinationLimit;
      destination += 1
    ) {
      this.assertEpoch(epoch)
      for (const level of this.levels()) {
        try {
          await this.readDestination(destination, [level])
        } catch (error) {
          // A rejected address/level does not mean the Quartz link is offline.
          // receive() publishes the error; leave this crosspoint unknown.
          if (!(error instanceof QuartzCommandError)) throw error
        }
      }
    }
  }

  private async open(): Promise<void> {
    const epoch = ++this.#epoch
    const socket = this.socketFactory()
    this.#socket = socket
    this.#lastError = null
    this.#routes.clear()
    this.#sources.clear()
    this.#destinations.clear()
    this.#locks.clear()
    const decoder = new QuartzFrameDecoder()
    this.phase('connecting')
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    socket.on('data', (chunk: Buffer) => {
      if (epoch !== this.#epoch) return
      try {
        for (const frame of decoder.push(chunk)) {
          if (epoch !== this.#epoch) return
          const message = parseQuartzMessage(frame)
          if (message !== null) this.receive(message)
        }
      } catch (error) {
        this.close(asError(error))
      }
    })
    socket.on('error', (error) => {
      if (epoch === this.#epoch) this.close(error)
    })
    socket.on('close', () => {
      if (epoch === this.#epoch) this.close(new Error('Quartz socket disconnected'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          finish(new Error('Quartz connection timed out'))
        }, this.definition.requestTimeoutMs)
        const onClose = () => {
          finish(new Error('Quartz connection closed while connecting'))
        }
        const onError = (error: Error) => {
          finish(error)
        }
        const onConnect = () => {
          finish()
        }
        const finish = (error?: Error) => {
          clearTimeout(timer)
          socket.off('close', onClose)
          socket.off('error', onError)
          socket.off('connect', onConnect)
          if (error === undefined) resolve()
          else reject(error)
        }
        socket.once('close', onClose)
        socket.once('error', onError)
        socket.once('connect', onConnect)
        socket.connect(this.definition.port, this.definition.host)
      })
      this.assertEpoch(epoch)
      this.phase('synchronizing')
      await this.ping()
      this.assertEpoch(epoch)
      // The first .A establishes a live Quartz endpoint. Labels and locks are
      // optional extensions, not prerequisites for basic routing.
      for (let address = 1; address <= this.definition.sourceLimit; address += 1)
        this.#sources.set(address, `Source ${String(address)}`)
      for (let address = 1; address <= this.definition.destinationLimit; address += 1)
        this.#destinations.set(address, `Destination ${String(address)}`)
      this.#catalogRevision += 1
      this.phase('connected')
      this.schedulePing(epoch)
      void this.synchronizeRoutes(epoch)
        .then(() => {
          if (epoch === this.#epoch) this.schedulePoll(epoch)
        })
        .catch((error: unknown) => {
          if (epoch === this.#epoch) this.close(asError(error))
        })
    } catch (error) {
      if (epoch === this.#epoch) this.close(asError(error))
      throw error
    }
  }

  private receive(message: QuartzMessage): void {
    // AN65 section 4.3: a controller reset invalidates previously read state,
    // including a partially completed startup. An initial power-up banner before
    // any route state arrives is harmless and must not cause a reconnect loop.
    if (
      message.type === 'reset' &&
      this.#routes.size > 0 &&
      (this.#phase === 'connected' || this.#phase === 'synchronizing')
    ) {
      this.close(new Error('Quartz controller restarted; resynchronization required'))
      return
    }
    if (message.type === 'routes') {
      const changed: QuartzCrosspoint[] = []
      for (const item of message.crosspoints) {
        if (
          item.level > this.definition.levels ||
          item.destination > this.definition.destinationLimit
        )
          continue
        // Retain unknown sources numerically. The manager presents sources
        // outside the configured catalog as unknown, without dropping the link.
        const key = `${String(item.destination)}:${String(item.level)}`
        if (this.#routes.get(key)?.source === item.source) continue
        this.#routes.set(key, item)
        changed.push(item)
      }
      if (changed.length > 0) {
        const previousRevision = this.#revision++
        this.emit({
          type: 'routes',
          crosspoints: changed,
          previousRevision,
          revision: this.#revision,
        })
      }
    } else if (message.type === 'lock') {
      if (message.destination <= this.definition.destinationLimit) {
        this.#locks.set(message.destination, message.owner)
        this.emit({ type: 'locks' })
      }
    }
    if (message.type === 'error') {
      const error = new QuartzCommandError(
        `Quartz rejected ${this.#requests.pendingCommand?.trim() ?? 'a command'}; check supported commands, address limits, and level mapping`,
      )
      this.#lastError = error.message
      this.emit({
        type: 'protocol-error',
        code: 'quartz-command-rejected',
        message: error.message,
      })
      this.#requests.receive(message, error)
    } else this.#requests.receive(message)
  }

  private ping(): Promise<void> {
    // ACKs carry no request ID: this proves link liveness, never a route take.
    // Use the request queue so pings cannot overlap ACK-based salvo commands.
    return this.#requests.request('.#01\r', (message) => message.type === 'ack', undefined, {
      retryEveryMs: LINK_PING_INTERVAL_MS,
      timeoutMs: Math.max(LINK_PONG_TIMEOUT_MS, this.definition.requestTimeoutMs),
      ignoreErrors: true,
    })
  }

  private schedulePing(epoch: number): void {
    this.#pingTimer = setTimeout(() => {
      this.#pingTimer = null
      if (epoch !== this.#epoch) return
      void this.ping()
        .then(() => {
          if (epoch === this.#epoch) this.schedulePing(epoch)
        })
        .catch((error: unknown) => {
          if (epoch === this.#epoch) this.close(asError(error))
        })
    }, LINK_PING_INTERVAL_MS)
    this.#pingTimer.unref()
  }

  private schedulePoll(epoch: number): void {
    const seconds = this.definition.refreshIntervalSeconds
    if (seconds === 0) return
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null
      if (epoch !== this.#epoch) return
      void this.synchronizeRoutes(epoch)
        .then(() => {
          if (epoch === this.#epoch && this.#phase === 'connected') this.schedulePoll(epoch)
        })
        .catch((error: unknown) => {
          if (epoch === this.#epoch) this.close(asError(error))
        })
    }, seconds * 1000)
    this.#pollTimer.unref()
  }

  private close(error: Error): void {
    const socket = this.#socket
    this.#socket = null
    this.#epoch += 1
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer)
    this.#pollTimer = null
    if (this.#pingTimer !== null) clearTimeout(this.#pingTimer)
    this.#pingTimer = null
    this.#requests.close(error)
    socket?.destroy()
    this.#locks.clear()
    this.#lastError = error.message
    this.phase('disconnected')
  }

  private levels(levels?: readonly number[]): readonly number[] {
    const selected =
      levels === undefined || levels.length === 0
        ? Array.from({ length: this.definition.levels }, (_, index) => index + 1)
        : [...new Set(levels)]
    quartzLevelLetters(selected, this.definition.levels)
    return selected
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch) throw new Error('Quartz connection changed during the operation')
  }

  private phase(phase: UltrixOgpSnapshot['phase']): void {
    this.#phase = phase
    this.emit({ type: 'phase', phase, error: this.#lastError })
  }

  private emit(event: MultiLevelRouterClientEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
export { QuartzCommandError } from './models.js'
