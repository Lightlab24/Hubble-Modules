import type {
  LightEncodeClientSnapshot,
  LightEncodeStateSnapshot,
} from '@hubble/lightencode-client'
import { describe, expect, it } from 'vitest'
import {
  ConnectionIdSchema,
  LightEncodeConnectionDefinitionSchema,
  type LightEncodeConnectionDefinition,
} from '../src/config.js'

import {
  LightEncodeConnectionManager,
  type LightEncodeConnectionManagerError,
  type LightEncodeManagedClient,
} from '../src/lightencode-connection-manager.js'

const CONNECTION_ID = ConnectionIdSchema.parse('11111111-1111-4111-8111-111111111111')
const SECOND_CONNECTION_ID = ConnectionIdSchema.parse('22222222-2222-4222-8222-222222222222')

describe('LightEncodeConnectionManager', () => {
  it('keeps one client for an unchanged enabled connection and updates presentation fields', () => {
    const clients: FakeManagedClient[] = []
    const manager = new LightEncodeConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.host)
      clients.push(client)
      return client
    })

    manager.reconcile([connection()])
    manager.reconcile([connection({ name: 'Renamed Light Encode' })])

    expect(clients).toHaveLength(1)
    expect(clients[0]?.startCalls).toEqual(['127.0.0.1'])
    expect(clients[0]?.stopCalls).toBe(0)
    expect(manager.snapshots()[0]?.definition.name).toBe('Renamed Light Encode')
  })

  it('replaces only the client whose host or request timeout changes', () => {
    const clients: FakeManagedClient[] = []
    const manager = new LightEncodeConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.host)
      clients.push(client)
      return client
    })

    manager.reconcile([
      connection(),
      connection({ connectionId: SECOND_CONNECTION_ID, name: 'Light Encode Backup' }),
    ])
    manager.reconcile([
      connection({ host: 'lightencode.local' }),
      connection({ connectionId: SECOND_CONNECTION_ID, name: 'Light Encode Backup' }),
    ])
    manager.reconcile([
      connection({ host: 'lightencode.local', requestTimeoutMs: 5_000 }),
      connection({ connectionId: SECOND_CONNECTION_ID, name: 'Light Encode Backup' }),
    ])

    expect(clients).toHaveLength(4)
    expect(clients.map(({ startCalls }) => startCalls)).toEqual([
      ['127.0.0.1'],
      ['127.0.0.1'],
      ['lightencode.local'],
      ['lightencode.local'],
    ])
    expect(clients.map(({ stopCalls }) => stopCalls)).toEqual([1, 0, 1, 0])
  })

  it('routes all commands only to the selected connection', async () => {
    const clients = new Map<string, FakeManagedClient>()
    const manager = new LightEncodeConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.host)
      clients.set(definition.connectionId, client)
      return client
    })
    manager.reconcile([
      connection(),
      connection({ connectionId: SECOND_CONNECTION_ID, name: 'Light Encode Backup' }),
    ])

    await manager.toggleAll(CONNECTION_ID)
    await manager.toggleSlot(CONNECTION_ID, 7)
    await manager.toggleTimer(CONNECTION_ID)
    await manager.setTimerMinutes(CONNECTION_ID, 30)

    expect(clients.get(CONNECTION_ID)?.commandCalls).toEqual([
      ['toggleAll'],
      ['toggleSlot', 7],
      ['toggleTimer'],
      ['setTimerMinutes', 30],
    ])
    expect(clients.get(SECOND_CONNECTION_ID)?.commandCalls).toEqual([])
  })

  it('reports an unconfigured connection without invoking a sibling client', async () => {
    const client = new FakeManagedClient('127.0.0.1')
    const manager = new LightEncodeConnectionManager(() => client)
    manager.reconcile([connection()])

    await expect(manager.toggleAll(SECOND_CONNECTION_ID)).rejects.toMatchObject({
      name: 'LightEncodeConnectionManagerError',
      code: 'lightencode_unconfigured',
    } satisfies Partial<LightEncodeConnectionManagerError>)
    expect(client.commandCalls).toEqual([])
  })

  it('removes disabled connections, refreshes enabled clients, and stops cleanly', () => {
    const clients: FakeManagedClient[] = []
    const manager = new LightEncodeConnectionManager((definition) => {
      const client = new FakeManagedClient(definition.host)
      clients.push(client)
      return client
    })
    manager.reconcile([connection()])

    manager.refresh()
    expect(clients).toHaveLength(2)
    expect(clients[0]?.stopCalls).toBe(1)

    manager.reconcile([connection({ enabled: false })])
    expect(clients[1]?.stopCalls).toBe(1)
    expect(manager.snapshots()).toEqual([])

    manager.stop()
    expect(clients[1]?.stopCalls).toBe(1)
  })

  it('publishes current immutable snapshots and isolates observer failures', () => {
    const client = new FakeManagedClient('127.0.0.1')
    const manager = new LightEncodeConnectionManager(() => client)
    const observed: string[][] = []
    manager.subscribe(() => {
      throw new Error('broken observer')
    })
    const unsubscribe = manager.subscribe((snapshots) => {
      observed.push(snapshots.map(({ connection: value }) => value.phase))
    })

    expect(() => {
      manager.reconcile([connection()])
    }).not.toThrow()
    client.publish(snapshot('127.0.0.1', { phase: 'connected', state: state() }))
    unsubscribe()
    manager.stop()

    expect(observed).toContainEqual([])
    expect(observed).toContainEqual(['connected'])
  })
})

class FakeManagedClient implements LightEncodeManagedClient {
  readonly startCalls: string[] = []
  readonly commandCalls: (readonly [string] | readonly [string, number])[] = []
  stopCalls = 0
  snapshot: LightEncodeClientSnapshot
  readonly #listeners = new Set<(value: LightEncodeClientSnapshot) => void>()

  constructor(host: string) {
    this.snapshot = snapshot(host)
  }

  start(host: string): void {
    this.startCalls.push(host)
  }

  stop(): void {
    this.stopCalls += 1
  }

  toggleAll(): Promise<LightEncodeStateSnapshot> {
    this.commandCalls.push(['toggleAll'])
    return Promise.resolve(state())
  }

  toggleSlot(slotNumber: number): Promise<LightEncodeStateSnapshot> {
    this.commandCalls.push(['toggleSlot', slotNumber])
    return Promise.resolve(state())
  }

  toggleTimer(): Promise<LightEncodeStateSnapshot> {
    this.commandCalls.push(['toggleTimer'])
    return Promise.resolve(state())
  }

  setTimerMinutes(minutes: number): Promise<LightEncodeStateSnapshot> {
    this.commandCalls.push(['setTimerMinutes', minutes])
    return Promise.resolve(state())
  }

  subscribe(listener: (value: LightEncodeClientSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(value: LightEncodeClientSnapshot): void {
    this.snapshot = value
    for (const listener of this.#listeners) listener(value)
  }
}

function connection(
  overrides: Partial<LightEncodeConnectionDefinition> = {},
): LightEncodeConnectionDefinition {
  return LightEncodeConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'lightencode',
    name: 'Light Encode',
    enabled: true,
    host: '127.0.0.1',
    port: 59_613,
    requestTimeoutMs: 4_000,
    schemaVersion: 1,
    ...overrides,
  })
}

function snapshot(
  host: string,
  overrides: Partial<LightEncodeClientSnapshot> = {},
): LightEncodeClientSnapshot {
  return Object.freeze({
    phase: 'disconnected',
    host,
    port: 59_613,
    appVersion: null,
    sessionId: null,
    capabilities: Object.freeze([]),
    state: null,
    lastEventAt: null,
    lastError: null,
    reconnectAttempt: 0,
    ...overrides,
  })
}

function state(): LightEncodeStateSnapshot {
  return Object.freeze({
    type: 'state',
    revision: 1,
    app: Object.freeze({ anyRecording: false, timerEnabled: false, timerMinutes: 30 }),
    pipelines: Object.freeze([]),
  })
}
