import {
  DitBrowseClient,
  type DitBrowseConnectionSnapshot,
  type DitBrowseStatus,
} from '@hubble/dit-browse-client'
import { connectionCandidates } from '@hubble/module-contracts/settings'
import { ConnectionDefinitionsSchema, type DitBrowseConnectionDefinition } from './config.js'

const CLIENT_NAME = 'Hubble'
const CLIENT_VERSION = '1.0.5'

export interface DitBrowseManagedClient {
  readonly snapshot: DitBrowseConnectionSnapshot
  start(port?: number): void
  stop(): void
  focusCamera(cameraNumber: number): Promise<DitBrowseStatus>
  switchWorkspace(workspaceNumber: number): Promise<DitBrowseStatus>
  showGrid(): Promise<DitBrowseStatus>
  cycleWorkspaces(): Promise<DitBrowseStatus>
  setGridLocked(locked: boolean): Promise<DitBrowseStatus>
  toggleGridLocked(): Promise<DitBrowseStatus>
  subscribe(listener: (snapshot: DitBrowseConnectionSnapshot) => void): () => void
}

export type DitBrowseManagedClientFactory = (
  definition: DitBrowseConnectionDefinition,
) => DitBrowseManagedClient

export interface ManagedDitBrowseConnectionSnapshot {
  readonly definition: DitBrowseConnectionDefinition
  readonly connection: DitBrowseConnectionSnapshot
}

export type DitBrowseConnectionManagerListener = (
  snapshots: readonly ManagedDitBrowseConnectionSnapshot[],
) => void

export interface DitBrowseConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  client(connectionId: string): DitBrowseManagedClient | null
  snapshots(): readonly ManagedDitBrowseConnectionSnapshot[]
  subscribe(listener: DitBrowseConnectionManagerListener): () => void
  stop(): void
}

interface ManagedEntry {
  definition: DitBrowseConnectionDefinition
  readonly client: DitBrowseManagedClient
  unsubscribe: () => void
}

export class DitBrowseConnectionManager implements DitBrowseConnectionManagerContract {
  private readonly entries = new Map<string, ManagedEntry>()
  private readonly listeners = new Set<DitBrowseConnectionManagerListener>()

  constructor(
    private readonly createClient: DitBrowseManagedClientFactory = defaultClientFactory,
  ) {}

  reconcile(connectionValues: readonly unknown[]): void {
    const connections = ConnectionDefinitionsSchema.parse(
      structuredClone(connectionCandidates(connectionValues, 'dit-browse')),
    )
    const enabled = new Map<string, DitBrowseConnectionDefinition>(
      connections
        .filter(
          (connection): connection is DitBrowseConnectionDefinition =>
            connection.type === 'dit-browse' && connection.enabled,
        )
        .map((connection) => [connection.connectionId, connection]),
    )

    for (const [connectionId, entry] of this.entries) {
      const definition = enabled.get(connectionId)
      if (definition === undefined || requiresNewClient(entry.definition, definition)) {
        this.removeEntry(connectionId, entry)
      } else {
        entry.definition = definition
        enabled.delete(connectionId)
      }
    }

    for (const definition of enabled.values()) {
      this.addEntry(definition)
    }
    this.emit()
  }

  refresh(): void {
    const entries = [...this.entries.entries()]
    for (const [connectionId, entry] of entries) this.removeEntry(connectionId, entry)
    for (const [, entry] of entries) this.addEntry(entry.definition)
    this.emit()
  }

  client(connectionId: string): DitBrowseManagedClient | null {
    return this.entries.get(connectionId)?.client ?? null
  }

  snapshots(): readonly ManagedDitBrowseConnectionSnapshot[] {
    return Object.freeze(
      [...this.entries.values()].map((entry) =>
        Object.freeze({
          definition: entry.definition,
          connection: entry.client.snapshot,
        }),
      ),
    )
  }

  subscribe(listener: DitBrowseConnectionManagerListener): () => void {
    this.listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      // Connection observers must never affect transport lifecycle.
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  stop(): void {
    for (const [connectionId, entry] of this.entries) {
      this.removeEntry(connectionId, entry)
    }
    this.emit()
  }

  private addEntry(definition: DitBrowseConnectionDefinition): void {
    const client = this.createClient(definition)
    const entry: ManagedEntry = {
      definition,
      client,
      unsubscribe: () => undefined,
    }
    this.entries.set(definition.connectionId, entry)
    entry.unsubscribe = client.subscribe(() => {
      if (this.entries.get(definition.connectionId) === entry) this.emit()
    })
    client.start(definition.port)
  }

  private removeEntry(connectionId: string, entry: ManagedEntry): void {
    this.entries.delete(connectionId)
    entry.unsubscribe()
    entry.client.stop()
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const snapshots = this.snapshots()
    for (const listener of this.listeners) {
      try {
        listener(snapshots)
      } catch {
        // Connection observers must never affect transport lifecycle.
      }
    }
  }
}

function requiresNewClient(
  current: DitBrowseConnectionDefinition,
  next: DitBrowseConnectionDefinition,
): boolean {
  return current.port !== next.port || current.requestTimeoutMs !== next.requestTimeoutMs
}

function defaultClientFactory(
  definition: DitBrowseConnectionDefinition,
): DitBrowseManagedClient {
  return new DitBrowseClient({
    port: definition.port,
    requestTimeoutMs: definition.requestTimeoutMs,
    clientName: CLIENT_NAME,
    clientVersion: CLIENT_VERSION,
  })
}
