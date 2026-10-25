import { connectionCandidates } from '@hubble/module-contracts/settings'
import {
  ConnectionDefinitionsSchema,
  type CyanViewStudioConnectionDefinition,
} from './config.js'

import {
  CyanViewStudioHttpClientError,
  createCyanViewStudioHttpClient,
  type CyanViewStudioHttpClientContract,
} from './cyanview-studio-http-client.js'

export type CyanViewStudioConnectionPhase = 'checking' | 'ready' | 'unavailable'

export type CyanViewStudioConnectionErrorCode =
  | 'cyanview_unconfigured'
  | 'cyanview_unavailable'
  | 'cyanview_timeout'
  | 'cyanview_camera_not_found'
  | 'cyanview_feed_not_found'
  | 'cyanview_feed_id_unsupported'
  | 'cyanview_feed_number_unsupported'
  | 'cyanview_invalid_request'
  | 'cyanview_protocol_error'

export class CyanViewStudioConnectionError extends Error {
  override readonly name = 'CyanViewStudioConnectionError'

  constructor(
    readonly code: CyanViewStudioConnectionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ManagedCyanViewStudioConnectionSnapshot {
  readonly definition: CyanViewStudioConnectionDefinition
  readonly phase: CyanViewStudioConnectionPhase
  readonly apiVersion: string | null
  readonly supportsFeedId: boolean | null
  readonly supportsFeedNumber: boolean | null
  readonly lastEventAt: string | null
  readonly lastError: string | null
}

export type CyanViewStudioConnectionManagerListener = (
  snapshots: readonly ManagedCyanViewStudioConnectionSnapshot[],
) => void

export interface CyanViewStudioConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  selectFeed(connectionId: string, cameraId: string): Promise<void>
  selectFeedByFeedId(connectionId: string, feedId: number): Promise<void>
  selectFeedByNumber(connectionId: string, feedNumber: number): Promise<void>
  snapshots(): readonly ManagedCyanViewStudioConnectionSnapshot[]
  subscribe(listener: CyanViewStudioConnectionManagerListener): () => void
  stop(): void
}

export type CyanViewStudioManagedClientFactory = (
  definition: CyanViewStudioConnectionDefinition,
) => CyanViewStudioHttpClientContract

export interface CyanViewStudioConnectionManagerOptions {
  readonly createClient?: CyanViewStudioManagedClientFactory
  readonly now?: () => Date
}

interface QueueItem {
  readonly generation: number
  readonly run: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

interface ManagedEntry {
  definition: CyanViewStudioConnectionDefinition
  readonly client: CyanViewStudioHttpClientContract
  phase: CyanViewStudioConnectionPhase
  apiVersion: string | null
  supportsFeedId: boolean | null
  supportsFeedNumber: boolean | null
  lastEventAt: string | null
  lastError: string | null
  generation: number
  removed: boolean
  running: boolean
  readonly queue: QueueItem[]
}

export class CyanViewStudioConnectionManager implements CyanViewStudioConnectionManagerContract {
  readonly #entries = new Map<string, ManagedEntry>()
  readonly #listeners = new Set<CyanViewStudioConnectionManagerListener>()
  readonly #createClient: CyanViewStudioManagedClientFactory
  readonly #now: () => Date
  #stopped = false

  constructor(options: CyanViewStudioConnectionManagerOptions = {}) {
    this.#createClient = options.createClient ?? createCyanViewStudioHttpClient
    this.#now = options.now ?? (() => new Date())
  }

  reconcile(connectionValues: readonly unknown[]): void {
    this.assertRunning()
    const connections = ConnectionDefinitionsSchema.parse(
      structuredClone(connectionCandidates(connectionValues, 'cyanview-studio')),
    )
    const enabled = new Map<string, CyanViewStudioConnectionDefinition>(
      connections
        .filter(
          (connection): connection is CyanViewStudioConnectionDefinition =>
            connection.type === 'cyanview-studio' && connection.enabled,
        )
        .map((definition) => [definition.connectionId, definition]),
    )

    for (const [connectionId, entry] of this.#entries) {
      const definition = enabled.get(connectionId)
      if (definition === undefined || requiresNewClient(entry.definition, definition)) {
        this.removeEntry(connectionId, entry)
      } else {
        entry.definition = definition
        enabled.delete(connectionId)
      }
    }

    for (const definition of enabled.values()) this.addEntry(definition)
    this.emit()
  }

  refresh(): void {
    this.assertRunning()
    for (const [connectionId, entry] of this.#entries) this.queueProbe(connectionId, entry)
  }

  selectFeed(connectionId: string, cameraIdValue: string): Promise<void> {
    this.assertRunning()
    const entry = this.#entries.get(connectionId)
    if (entry === undefined || entry.removed) {
      return Promise.reject(connectionError('cyanview_unconfigured'))
    }
    const cameraId = canonicalCameraId(cameraIdValue)
    if (cameraId === null) return Promise.reject(connectionError('cyanview_unconfigured'))

    return this.enqueueSelection(connectionId, entry, () => entry.client.selectFeed(cameraId))
  }

  selectFeedByFeedId(connectionId: string, feedId: number): Promise<void> {
    this.assertRunning()
    const entry = this.#entries.get(connectionId)
    if (entry === undefined || entry.removed || !Number.isSafeInteger(feedId)) {
      return Promise.reject(connectionError('cyanview_unconfigured'))
    }

    return this.enqueueSelection(connectionId, entry, () => {
      if (entry.supportsFeedId === false) {
        return Promise.reject(connectionError('cyanview_feed_id_unsupported'))
      }
      return entry.client.selectFeedByFeedId(feedId)
    })
  }

  selectFeedByNumber(connectionId: string, feedNumber: number): Promise<void> {
    this.assertRunning()
    const entry = this.#entries.get(connectionId)
    if (entry === undefined || entry.removed) {
      return Promise.reject(connectionError('cyanview_unconfigured'))
    }
    if (!Number.isSafeInteger(feedNumber) || feedNumber < 1) {
      return Promise.reject(connectionError('cyanview_invalid_request'))
    }

    return this.enqueueSelection(connectionId, entry, () => {
      if (entry.supportsFeedNumber === false) {
        return Promise.reject(connectionError('cyanview_feed_number_unsupported'))
      }
      return entry.client.selectFeedByNumber(feedNumber)
    })
  }

  private enqueueSelection(
    connectionId: string,
    entry: ManagedEntry,
    select: () => Promise<void>,
  ): Promise<void> {
    return this.enqueue(entry, async () => {
      try {
        await select()
      } catch (error: unknown) {
        const mapped =
          error instanceof CyanViewStudioConnectionError ? error : mapClientError(error)
        if (!actionLocal(mapped.code) && this.isCurrent(connectionId, entry)) {
          this.markUnavailable(entry, mapped.message)
          this.emit()
        }
        throw mapped
      }

      if (this.isCurrent(connectionId, entry)) {
        entry.phase = 'ready'
        entry.lastEventAt = this.timestamp()
        entry.lastError = null
        this.emit()
      }
    })
  }

  snapshots(): readonly ManagedCyanViewStudioConnectionSnapshot[] {
    return Object.freeze([...this.#entries.values()].map(managedSnapshot))
  }

  subscribe(listener: CyanViewStudioConnectionManagerListener): () => void {
    if (this.#stopped) {
      try {
        listener(Object.freeze([]))
      } catch {
        // Status observers cannot affect a stopped transport.
      }
      return () => undefined
    }
    this.#listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      // Status observers cannot affect the HTTP transport.
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }

  stop(): void {
    if (this.#stopped) return
    for (const [connectionId, entry] of this.#entries) this.removeEntry(connectionId, entry)
    this.emit()
    this.#listeners.clear()
    this.#stopped = true
  }

  private addEntry(definition: CyanViewStudioConnectionDefinition): void {
    const entry: ManagedEntry = {
      definition,
      client: this.#createClient(definition),
      phase: 'checking',
      apiVersion: null,
      supportsFeedId: null,
      supportsFeedNumber: null,
      lastEventAt: null,
      lastError: null,
      generation: 1,
      removed: false,
      running: false,
      queue: [],
    }
    this.#entries.set(definition.connectionId, entry)
    this.queueProbe(definition.connectionId, entry)
  }

  private removeEntry(connectionId: string, entry: ManagedEntry): void {
    if (this.#entries.get(connectionId) !== entry) return
    this.#entries.delete(connectionId)
    entry.removed = true
    entry.supportsFeedId = null
    entry.supportsFeedNumber = null
    entry.generation += 1
    const error = connectionError('cyanview_unconfigured')
    for (const item of entry.queue.splice(0)) item.reject(error)
  }

  private queueProbe(connectionId: string, entry: ManagedEntry): void {
    void this.enqueue(entry, async () => {
      if (this.isCurrent(connectionId, entry)) {
        entry.phase = 'checking'
        entry.apiVersion = null
        entry.supportsFeedId = null
        entry.supportsFeedNumber = null
        entry.lastError = null
        this.emit()
      }
      try {
        const result = await entry.client.probe()
        if (this.isCurrent(connectionId, entry)) {
          entry.phase = 'ready'
          entry.apiVersion = result.apiVersion
          entry.supportsFeedId = result.supportsFeedId
          entry.supportsFeedNumber = result.supportsFeedNumber
          entry.lastEventAt = this.timestamp()
          entry.lastError = null
          this.emit()
        }
      } catch (error: unknown) {
        const mapped = mapClientError(error)
        if (this.isCurrent(connectionId, entry)) {
          entry.supportsFeedId = null
          entry.supportsFeedNumber = null
          this.markUnavailable(entry, mapped.message)
          this.emit()
        }
        throw mapped
      }
    }).catch(() => undefined)
  }

  private enqueue<TResult>(
    entry: ManagedEntry,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    if (entry.removed) return Promise.reject(connectionError('cyanview_unconfigured'))
    const generation = entry.generation
    const result = new Promise<TResult>((resolve, reject) => {
      entry.queue.push({
        generation,
        run: operation,
        resolve: (value) => {
          resolve(value as TResult)
        },
        reject,
      })
    })
    this.runNext(entry)
    return result
  }

  private runNext(entry: ManagedEntry): void {
    if (entry.running) return
    const item = entry.queue.shift()
    if (item === undefined) return
    if (entry.removed || item.generation !== entry.generation) {
      item.reject(connectionError('cyanview_unconfigured'))
      this.runNext(entry)
      return
    }
    entry.running = true
    void item
      .run()
      .then(item.resolve, item.reject)
      .finally(() => {
        entry.running = false
        this.runNext(entry)
      })
  }

  private isCurrent(connectionId: string, entry: ManagedEntry): boolean {
    return !entry.removed && this.#entries.get(connectionId) === entry
  }

  private markUnavailable(entry: ManagedEntry, message: string): void {
    entry.phase = 'unavailable'
    entry.apiVersion = null
    entry.lastEventAt = this.timestamp()
    entry.lastError = message
  }

  private timestamp(): string {
    const value = this.#now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('CyanView Studio clock returned an invalid date')
    }
    return value.toISOString()
  }

  private emit(): void {
    if (this.#listeners.size === 0) return
    const snapshots = this.snapshots()
    for (const listener of this.#listeners) {
      try {
        listener(snapshots)
      } catch {
        // Status observers cannot affect the HTTP transport or sibling connections.
      }
    }
  }

  private assertRunning(): void {
    if (this.#stopped) throw new Error('CyanView Studio connection manager is stopped')
  }
}

function managedSnapshot(entry: ManagedEntry): ManagedCyanViewStudioConnectionSnapshot {
  return Object.freeze({
    definition: entry.definition,
    phase: entry.phase,
    apiVersion: entry.apiVersion,
    supportsFeedId: entry.supportsFeedId,
    supportsFeedNumber: entry.supportsFeedNumber,
    lastEventAt: entry.lastEventAt,
    lastError: entry.lastError,
  })
}

function requiresNewClient(
  current: CyanViewStudioConnectionDefinition,
  next: CyanViewStudioConnectionDefinition,
): boolean {
  return (
    current.host !== next.host ||
    current.port !== next.port ||
    current.requestTimeoutMs !== next.requestTimeoutMs
  )
}

function canonicalCameraId(value: string): string | null {
  if (typeof value !== 'string') return null
  const cameraId = value.trim()
  return cameraId.length > 0 && Buffer.byteLength(cameraId, 'utf8') <= 64 ? cameraId : null
}

function mapClientError(error: unknown): CyanViewStudioConnectionError {
  if (!(error instanceof CyanViewStudioHttpClientError)) {
    return connectionError('cyanview_protocol_error')
  }
  const codeByClientError = {
    unavailable: 'cyanview_unavailable',
    timeout: 'cyanview_timeout',
    camera_not_found: 'cyanview_camera_not_found',
    feed_not_found: 'cyanview_feed_not_found',
    invalid_request: 'cyanview_invalid_request',
    protocol_error: 'cyanview_protocol_error',
  } as const
  return connectionError(codeByClientError[error.code])
}

function actionLocal(code: CyanViewStudioConnectionErrorCode): boolean {
  return (
    code === 'cyanview_camera_not_found' ||
    code === 'cyanview_feed_not_found' ||
    code === 'cyanview_invalid_request' ||
    code === 'cyanview_feed_id_unsupported' ||
    code === 'cyanview_feed_number_unsupported'
  )
}

function connectionError(
  code: CyanViewStudioConnectionErrorCode,
): CyanViewStudioConnectionError {
  const messages = {
    cyanview_unconfigured: 'CyanView Studio connection is unavailable',
    cyanview_unavailable: 'CyanView Studio is unavailable',
    cyanview_timeout: 'CyanView Studio did not respond before the request timeout',
    cyanview_camera_not_found: 'CyanView Studio could not find the requested camera',
    cyanview_feed_not_found: 'CyanView Studio could not find the requested feed',
    cyanview_feed_id_unsupported:
      'This saved action uses a database Feed ID; add Select Feed and enter the feed number shown in Studio',
    cyanview_feed_number_unsupported:
      'This Studio API does not support feed-number selection; update Studio to use Select Feed',
    cyanview_invalid_request: 'CyanView Studio rejected the feed selection request',
    cyanview_protocol_error: 'CyanView Studio returned an invalid response',
  } as const
  return new CyanViewStudioConnectionError(code, messages[code])
}
