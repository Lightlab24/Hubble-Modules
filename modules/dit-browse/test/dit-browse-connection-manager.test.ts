import type { DitBrowseConnectionSnapshot, DitBrowseStatus } from '@hubble/dit-browse-client'
import { describe, expect, it, vi } from 'vitest'
import {
  DitBrowseConnectionDefinitionSchema,
  type DitBrowseConnectionDefinition,
} from '../src/config.js'

import {
  DitBrowseConnectionManager,
  type DitBrowseManagedClient,
} from '../src/dit-browse-connection-manager.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

describe('DitBrowseConnectionManager', () => {
  it('keeps one persistent client for an unchanged enabled connection', () => {
    const clients: FakeManagedClient[] = []
    const manager = new DitBrowseConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.port)
      clients.push(client)
      return client
    })

    manager.reconcile([connection()])
    manager.reconcile([connection({ name: 'Renamed DIT Browse' })])

    expect(clients).toHaveLength(1)
    expect(clients[0]?.startCalls).toEqual([7502])
    expect(clients[0]?.stopCalls).toBe(0)
    expect(manager.snapshots()[0]?.definition.name).toBe('Renamed DIT Browse')
    expect(manager.client(CONNECTION_ID)).toBe(clients[0])
  })

  it('replaces only clients whose transport settings changed', () => {
    const clients: FakeManagedClient[] = []
    const manager = new DitBrowseConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.port)
      clients.push(client)
      return client
    })

    manager.reconcile([connection()])
    manager.reconcile([connection({ port: 7503 })])
    manager.reconcile([connection({ port: 7503, requestTimeoutMs: 2000 })])

    expect(clients).toHaveLength(3)
    expect(clients.map(({ startCalls }) => startCalls)).toEqual([[7502], [7503], [7503]])
    expect(clients.map(({ stopCalls }) => stopCalls)).toEqual([1, 1, 0])
  })

  it('refreshes an enabled connection with a new immediate client attempt', () => {
    const clients: FakeManagedClient[] = []
    const manager = new DitBrowseConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.port)
      clients.push(client)
      return client
    })
    manager.reconcile([connection()])

    manager.refresh()

    expect(clients).toHaveLength(2)
    expect(clients[0]?.stopCalls).toBe(1)
    expect(clients[1]?.startCalls).toEqual([7502])
    expect(manager.client(CONNECTION_ID)).toBe(clients[1])
  })

  it('removes disabled and deleted clients and rejects no sibling lifecycle', () => {
    const first = new FakeManagedClient(7502)
    const second = new FakeManagedClient(7503)
    const createClient = vi.fn((definition: DitBrowseConnectionDefinition) =>
      definition.connectionId === CONNECTION_ID ? first : second,
    )
    const manager = new DitBrowseConnectionManager(createClient)
    const secondDefinition = connection({
      connectionId: '22222222-2222-4222-8222-222222222222',
      name: 'DIT Browse Backup',
      port: 7503,
    })

    manager.reconcile([connection(), secondDefinition])
    manager.reconcile([connection({ enabled: false }), secondDefinition])

    expect(first.stopCalls).toBe(1)
    expect(second.stopCalls).toBe(0)
    expect(manager.client(CONNECTION_ID)).toBeNull()
    expect(manager.client(secondDefinition.connectionId)).toBe(second)

    manager.stop()
    expect(second.stopCalls).toBe(1)
    expect(manager.snapshots()).toEqual([])
  })

  it('publishes immutable snapshots and isolates observer failures', () => {
    const client = new FakeManagedClient(7502)
    const manager = new DitBrowseConnectionManager(() => client)
    const observed: number[] = []
    manager.subscribe(() => {
      throw new Error('broken observer')
    })
    const unsubscribe = manager.subscribe((snapshots) => observed.push(snapshots.length))

    expect(() => {
      manager.reconcile([connection()])
    }).not.toThrow()
    client.publish({
      ...client.snapshot,
      phase: 'disconnected',
      reconnectAttempt: 2,
      nextReconnectDelayMs: 2_000,
    })
    expect(manager.snapshots()[0]?.connection).toMatchObject({
      reconnectAttempt: 2,
      nextReconnectDelayMs: 2_000,
    })
    unsubscribe()
    manager.stop()

    expect(observed).toEqual([0, 1, 1, 1])
  })

  it('re-enables immediately and ignores callbacks from the stopped client', () => {
    const clients: FakeManagedClient[] = []
    const manager = new DitBrowseConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.port)
      clients.push(client)
      return client
    })
    const observed = vi.fn()
    manager.subscribe(observed)
    manager.reconcile([connection()])
    const oldClient = clients[0]
    if (oldClient === undefined) throw new Error('Missing original client')
    const lateNotification = oldClient.pendingNotification()

    manager.reconcile([connection({ enabled: false })])
    expect(manager.client(CONNECTION_ID)).toBeNull()
    expect(oldClient.stopCalls).toBe(1)
    manager.refresh()
    expect(clients).toHaveLength(1)

    manager.reconcile([connection()])
    expect(clients).toHaveLength(2)
    expect(clients[1]?.startCalls).toEqual([7502])
    const before = observed.mock.calls.length
    lateNotification()
    oldClient.publish({ ...oldClient.snapshot, lastError: 'Late connection failure' })
    expect(observed).toHaveBeenCalledTimes(before)
    expect(manager.client(CONNECTION_ID)).toBe(clients[1])
    expect(manager.snapshots()[0]).toMatchObject({
      definition: { enabled: true },
      connection: { phase: 'disconnected', lastError: null },
    })
    manager.reconcile([connection({ enabled: false })])
    expect(clients[1]?.stopCalls).toBe(1)
    manager.stop()
  })
})

class FakeManagedClient implements DitBrowseManagedClient {
  readonly startCalls: number[] = []
  stopCalls = 0
  snapshot: DitBrowseConnectionSnapshot
  private readonly listeners = new Set<(snapshot: DitBrowseConnectionSnapshot) => void>()

  constructor(port: number) {
    this.snapshot = snapshot(port)
  }

  start(port = this.snapshot.port): void {
    this.startCalls.push(port)
  }

  stop(): void {
    this.stopCalls += 1
  }

  showGrid(): Promise<DitBrowseStatus> {
    return this.cycleWorkspaces()
  }

  cycleWorkspaces(): Promise<DitBrowseStatus> {
    return Promise.reject(new Error('not used'))
  }

  switchWorkspace(): Promise<DitBrowseStatus> {
    return Promise.reject(new Error('not used'))
  }

  focusCamera(): Promise<DitBrowseStatus> {
    return Promise.reject(new Error('not used'))
  }

  setGridLocked(): Promise<DitBrowseStatus> {
    return Promise.reject(new Error('not used'))
  }

  toggleGridLocked(): Promise<DitBrowseStatus> {
    return Promise.reject(new Error('not used'))
  }

  subscribe(listener: (snapshot: DitBrowseConnectionSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(next: DitBrowseConnectionSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener(next)
  }

  pendingNotification(): () => void {
    const listeners = [...this.listeners]
    return () => {
      for (const listener of listeners) listener(this.snapshot)
    }
  }
}

function connection(
  overrides: Partial<{
    connectionId: string
    name: string
    enabled: boolean
    port: number
    requestTimeoutMs: number
  }> = {},
): DitBrowseConnectionDefinition {
  return DitBrowseConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'dit-browse',
    name: 'DIT Browse Local',
    enabled: true,
    port: 7502,
    requestTimeoutMs: 3500,
    schemaVersion: 1,
    ...overrides,
  })
}

function snapshot(port: number): DitBrowseConnectionSnapshot {
  return Object.freeze({
    phase: 'disconnected',
    connected: false,
    endpoint: `ws://127.0.0.1:${String(port)}/api/ws`,
    port,
    serverVersion: null,
    status: null,
    revision: -1,
    catalog: Object.freeze([]),
    lastError: null,
    reconnectAttempt: 0,
    nextReconnectDelayMs: null,
  })
}
