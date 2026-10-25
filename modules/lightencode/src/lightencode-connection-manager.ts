import {
  LightEncodeClient,
  type LightEncodeClientSnapshot,
  type LightEncodeStateSnapshot,
} from '@hubble/lightencode-client'
import { connectionCandidates } from '@hubble/module-contracts/settings'
import { ConnectionDefinitionsSchema, type LightEncodeConnectionDefinition } from './config.js'

const CLIENT_VERSION = '1.0.5'

export interface LightEncodeManagedClient {
  readonly snapshot: LightEncodeClientSnapshot
  start(host: string): void
  stop(): void
  toggleAll(): Promise<LightEncodeStateSnapshot>
  toggleSlot(slotNumber: number): Promise<LightEncodeStateSnapshot>
  toggleTimer(): Promise<LightEncodeStateSnapshot>
  setTimerMinutes(minutes: number): Promise<LightEncodeStateSnapshot>
  subscribe(listener: (snapshot: LightEncodeClientSnapshot) => void): () => void
}

export type LightEncodeManagedClientFactory = (
  definition: LightEncodeConnectionDefinition,
) => LightEncodeManagedClient

export interface ManagedLightEncodeConnectionSnapshot {
  readonly definition: LightEncodeConnectionDefinition
  readonly connection: LightEncodeClientSnapshot
}

export type LightEncodeConnectionManagerListener = (
  snapshots: readonly ManagedLightEncodeConnectionSnapshot[],
) => void

export interface LightEncodeConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  toggleAll(connectionId: string): Promise<LightEncodeStateSnapshot>
  toggleSlot(connectionId: string, slotNumber: number): Promise<LightEncodeStateSnapshot>
  toggleTimer(connectionId: string): Promise<LightEncodeStateSnapshot>
  setTimerMinutes(connectionId: string, minutes: number): Promise<LightEncodeStateSnapshot>
  snapshots(): readonly ManagedLightEncodeConnectionSnapshot[]
  subscribe(listener: LightEncodeConnectionManagerListener): () => void
  stop(): void
}

export class LightEncodeConnectionManagerError extends Error {
  override readonly name = 'LightEncodeConnectionManagerError'

  constructor(
    readonly code: 'lightencode_unconfigured',
    message: string,
  ) {
    super(message)
  }
}

interface ManagedEntry {
  definition: LightEncodeConnectionDefinition
  readonly client: LightEncodeManagedClient
  unsubscribe: () => void
}

/** Owns exactly one persistent Light Encode client per enabled physical connection. */
export class LightEncodeConnectionManager implements LightEncodeConnectionManagerContract {
  readonly #entries = new Map<string, ManagedEntry>()
  readonly #listeners = new Set<LightEncodeConnectionManagerListener>()

  constructor(
    private readonly createClient: LightEncodeManagedClientFactory = defaultClientFactory,
  ) {}

  reconcile(connectionValues: readonly unknown[]): void {
    const connections = ConnectionDefinitionsSchema.parse(
      structuredClone(connectionCandidates(connectionValues, 'lightencode')),
    )
    const enabled = new Map<string, LightEncodeConnectionDefinition>(
      connections
        .filter(
          (connection): connection is LightEncodeConnectionDefinition =>
            connection.type === 'lightencode' && connection.enabled,
        )
        .map((connection) => [connection.connectionId, connection]),
    )

    for (const [connectionId, entry] of this.#entries) {
      const definition = enabled.get(connectionId)
      if (definition === undefined || requiresNewClient(entry.definition, definition)) {
        this.#removeEntry(connectionId, entry)
      } else {
        entry.definition = definition
        enabled.delete(connectionId)
      }
    }

    for (const definition of enabled.values()) this.#addEntry(definition)
    this.#emit()
  }

  refresh(): void {
    const entries = [...this.#entries.entries()]
    for (const [connectionId, entry] of entries) this.#removeEntry(connectionId, entry)
    for (const [, entry] of entries) this.#addEntry(entry.definition)
    this.#emit()
  }

  client(connectionId: string): LightEncodeManagedClient | null {
    return this.#entries.get(connectionId)?.client ?? null
  }

  async toggleAll(connectionId: string): Promise<LightEncodeStateSnapshot> {
    return this.#requireClient(connectionId).toggleAll()
  }

  async toggleSlot(
    connectionId: string,
    slotNumber: number,
  ): Promise<LightEncodeStateSnapshot> {
    return this.#requireClient(connectionId).toggleSlot(slotNumber)
  }

  async toggleTimer(connectionId: string): Promise<LightEncodeStateSnapshot> {
    return this.#requireClient(connectionId).toggleTimer()
  }

  async setTimerMinutes(
    connectionId: string,
    minutes: number,
  ): Promise<LightEncodeStateSnapshot> {
    return this.#requireClient(connectionId).setTimerMinutes(minutes)
  }

  snapshots(): readonly ManagedLightEncodeConnectionSnapshot[] {
    return Object.freeze(
      [...this.#entries.values()].map((entry) =>
        Object.freeze({
          definition: entry.definition,
          connection: entry.client.snapshot,
        }),
      ),
    )
  }

  subscribe(listener: LightEncodeConnectionManagerListener): () => void {
    this.#listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      // Connection observers must never affect transport lifecycle.
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }

  stop(): void {
    for (const [connectionId, entry] of this.#entries) this.#removeEntry(connectionId, entry)
    this.#emit()
  }

  #requireClient(connectionId: string): LightEncodeManagedClient {
    const client = this.client(connectionId)
    if (client !== null) return client
    throw new LightEncodeConnectionManagerError(
      'lightencode_unconfigured',
      'Light Encode connection is not configured',
    )
  }

  #addEntry(definition: LightEncodeConnectionDefinition): void {
    const client = this.createClient(definition)
    const entry: ManagedEntry = {
      definition,
      client,
      unsubscribe: () => undefined,
    }
    this.#entries.set(definition.connectionId, entry)
    entry.unsubscribe = client.subscribe(() => {
      if (this.#entries.get(definition.connectionId) === entry) this.#emit()
    })
    try {
      client.start(definition.host)
    } catch (error) {
      this.#removeEntry(definition.connectionId, entry)
      throw error
    }
  }

  #removeEntry(connectionId: string, entry: ManagedEntry): void {
    if (this.#entries.get(connectionId) !== entry) return
    this.#entries.delete(connectionId)
    entry.unsubscribe()
    entry.client.stop()
  }

  #emit(): void {
    if (this.#listeners.size === 0) return
    const snapshots = this.snapshots()
    for (const listener of this.#listeners) {
      try {
        listener(snapshots)
      } catch {
        // Connection observers must never affect transport lifecycle.
      }
    }
  }
}

function requiresNewClient(
  current: LightEncodeConnectionDefinition,
  next: LightEncodeConnectionDefinition,
): boolean {
  return current.host !== next.host || current.requestTimeoutMs !== next.requestTimeoutMs
}

function defaultClientFactory(
  definition: LightEncodeConnectionDefinition,
): LightEncodeManagedClient {
  return new LightEncodeClient({
    clientVersion: CLIENT_VERSION,
    requestTimeoutMs: definition.requestTimeoutMs,
  })
}
