import {
  VideohubError,
  type VideohubClientEvent,
  type VideohubCrosspoint,
  type VideohubSnapshot,
} from '@hubble/protocol-videohub'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BlackmagicVideohubConnectionDefinitionSchema,
  type BlackmagicVideohubConnectionDefinition,
} from '../src/config.js'

import {
  BlackmagicVideohubConnectionManager,
  type BlackmagicVideohubManagedClient,
} from '../src/blackmagic-videohub-connection-manager.js'

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001'

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function definition(
  overrides: Partial<BlackmagicVideohubConnectionDefinition> = {},
): BlackmagicVideohubConnectionDefinition {
  return BlackmagicVideohubConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'blackmagic-videohub',
    name: 'Videohub Main',
    enabled: true,
    host: '10.0.0.40',
    port: 9_990,
    sourceLimit: 3,
    destinationLimit: 2,
    requestTimeoutMs: 1_000,
    reconnectDelayMs: 2_000,
    schemaVersion: 1,
    ...overrides,
  })
}

class FakeVideohubClient implements BlackmagicVideohubManagedClient {
  readonly listeners = new Set<(event: VideohubClientEvent) => void>()
  readonly refreshNames = vi.fn(() => Promise.resolve())
  readonly refreshRoutes = vi.fn(() => Promise.resolve())
  readonly readDestination = vi.fn((destination: number) => {
    const crosspoint = this.current.routes.find((route) => route.destination === destination)
    if (crosspoint === undefined) throw new Error('destination has no route')
    return Promise.resolve(crosspoint)
  })
  setCrosspointGate: Promise<void> | null = null
  readonly setCrosspoint = vi.fn(async (crosspoint: VideohubCrosspoint): Promise<void> => {
    const lock = this.current.locks.find(
      ({ destination }) => destination === crosspoint.destination,
    )
    if (lock?.state === 'locked') {
      throw new VideohubError('locked', 'output is locked by another client')
    }
    if (this.setCrosspointGate !== null) await this.setCrosspointGate
    this.publishRoute(crosspoint.source, crosspoint.destination)
  })
  current: VideohubSnapshot = {
    phase: 'disconnected',
    revision: 1,
    catalogRevision: 1,
    confirmedOperationSequence: 0,
    protocolVersion: '2.3',
    deviceStatus: 'present',
    modelName: 'Blackmagic Videohub 12G 40x40',
    detectedSourceCount: 4,
    detectedDestinationCount: 3,
    sourceCount: 3,
    destinationCount: 2,
    sources: [
      { address: 1, name: 'CAM 1' },
      { address: 2, name: 'CAM 2' },
      { address: 3, name: 'CAM 3' },
    ],
    destinations: [
      { address: 1, name: 'PROGRAM' },
      { address: 2, name: 'CLEAN' },
    ],
    routes: [
      { destination: 1, source: 1 },
      { destination: 2, source: 2 },
    ],
    locks: [
      { destination: 1, state: 'unlocked' },
      { destination: 2, state: 'unlocked' },
    ],
    labelsDegraded: false,
    catalogStale: false,
    lastError: null,
  }

  readonly connect = vi.fn((): Promise<void> => {
    this.current = { ...this.current, phase: 'connected', catalogStale: false, lastError: null }
    this.emit({ type: 'phase', phase: 'connected', error: null })
    return Promise.resolve()
  })

  readonly disconnect = vi.fn(() => {
    if (this.current.phase === 'disconnected') return
    this.current = { ...this.current, phase: 'disconnected', catalogStale: true }
    this.emit({ type: 'phase', phase: 'disconnected', error: null })
  })

  snapshot(): VideohubSnapshot {
    return this.current
  }

  subscribe(listener: (event: VideohubClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishRoute(source: number, destination: number): void {
    const previousRevision = this.current.revision
    const crosspoint = { source, destination }
    this.current = {
      ...this.current,
      revision: previousRevision + 1,
      routes: this.current.routes.map((route) =>
        route.destination === destination ? crosspoint : route,
      ),
    }
    this.emit({
      type: 'route',
      crosspoint,
      previousRevision,
      revision: this.current.revision,
    })
  }

  publishForeignLock(destination: number): void {
    const lock = { destination, state: 'locked' as const }
    this.current = {
      ...this.current,
      locks: this.current.locks.map((entry) =>
        entry.destination === destination ? lock : entry,
      ),
    }
    this.emit({ type: 'lock', lock })
  }

  replaceWithSmallerDevice(): void {
    this.current = {
      ...this.current,
      revision: this.current.revision + 1,
      detectedSourceCount: 1,
      detectedDestinationCount: 1,
      sourceCount: 1,
      destinationCount: 1,
      sources: [{ address: 1, name: 'CAM 1' }],
      destinations: [{ address: 1, name: 'PROGRAM' }],
      routes: [{ destination: 1, source: 1 }],
      locks: [{ destination: 1, state: 'unlocked' }],
    }
    this.emit({
      type: 'device',
      device: {
        deviceStatus: this.current.deviceStatus,
        modelName: this.current.modelName,
        detectedSourceCount: this.current.detectedSourceCount,
        detectedDestinationCount: this.current.detectedDestinationCount,
        sourceCount: this.current.sourceCount,
        destinationCount: this.current.destinationCount,
      },
    })
  }

  publishUnavailableDevice(status: 'absent' | 'needs-update'): void {
    this.current = {
      ...this.current,
      phase: 'synchronizing',
      deviceStatus: status,
      modelName: null,
      detectedSourceCount: null,
      detectedDestinationCount: null,
      sourceCount: null,
      destinationCount: null,
      sources: [],
      destinations: [],
      routes: [],
      locks: [],
      lastError:
        status === 'needs-update'
          ? 'Videohub device firmware needs an update'
          : 'Videohub device is not present',
    }
    this.emit({ type: 'phase', phase: 'synchronizing', error: this.current.lastError })
    this.emit({
      type: 'device',
      device: {
        deviceStatus: this.current.deviceStatus,
        modelName: this.current.modelName,
        detectedSourceCount: this.current.detectedSourceCount,
        detectedDestinationCount: this.current.detectedDestinationCount,
        sourceCount: this.current.sourceCount,
        destinationCount: this.current.destinationCount,
      },
    })
  }

  loseConnection(error = 'socket closed'): void {
    this.current = {
      ...this.current,
      phase: 'disconnected',
      catalogStale: true,
      lastError: error,
    }
    this.emit({ type: 'phase', phase: 'disconnected', error })
  }

  private emit(event: VideohubClientEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

const managers: BlackmagicVideohubConnectionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop()
})

async function readyManager(): Promise<{
  client: FakeVideohubClient
  manager: BlackmagicVideohubConnectionManager
}> {
  const client = new FakeVideohubClient()
  const manager = new BlackmagicVideohubConnectionManager(() => client)
  managers.push(manager)
  manager.reconcile([definition()])
  await vi.waitFor(() => {
    expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
  })
  return { client, manager }
}

describe('BlackmagicVideohubConnectionManager', () => {
  it('keeps routing ready while surfacing degraded numeric label synchronization', async () => {
    const client = new FakeVideohubClient()
    client.current = { ...client.current, labelsDegraded: true }
    const manager = new BlackmagicVideohubConnectionManager(() => client)
    managers.push(manager)
    manager.reconcile([definition()])

    await vi.waitFor(() => {
      expect(manager.routeState(CONNECTION_ID)).toMatchObject({
        phase: 'ready',
        labelPhase: 'degraded',
      })
    })
    expect(manager.snapshots()[0]?.phase).toBe('connected')
  })

  it('projects detected dimensions through local caps with one video level', async () => {
    const { manager } = await readyManager()

    const snapshot = manager.snapshots()[0]
    expect(snapshot).toMatchObject({
      phase: 'connected',
      deviceStatus: 'present',
      deviceModel: 'Blackmagic Videohub 12G 40x40',
      detectedSourceCount: 4,
      detectedDestinationCount: 3,
      effectiveSourceCount: 3,
      effectiveDestinationCount: 2,
      catalogStale: false,
    })
    expect(snapshot?.sourceCatalog.map(({ address, label }) => [address, label])).toEqual([
      [1, 'CAM 1'],
      [2, 'CAM 2'],
      [3, 'CAM 3'],
    ])
    expect(manager.routeState(CONNECTION_ID)).toMatchObject({
      knownSourceCount: 3,
      knownDestinationCount: 2,
      knownCrosspointCount: 2,
    })
    expect(
      manager.queryRouteDestinations(CONNECTION_ID, {
        afterAddress: null,
        limit: 10,
        search: null,
        source: null,
        levels: [],
      }).entries,
    ).toEqual([
      { address: 1, label: 'PROGRAM', routes: [{ level: 1, source: 1 }] },
      { address: 2, label: 'CLEAN', routes: [{ level: 1, source: 2 }] },
    ])
  })

  it('surfaces attached-device absence and firmware-update states while synchronizing', async () => {
    const { client, manager } = await readyManager()

    client.publishUnavailableDevice('needs-update')
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'connecting',
      deviceStatus: 'needs-update',
      deviceModel: null,
      detectedSourceCount: null,
      detectedDestinationCount: null,
      sourceCatalog: [],
      destinationCatalog: [],
      catalogStale: false,
    })

    client.publishUnavailableDevice('absent')
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'connecting',
      deviceStatus: 'absent',
      deviceModel: null,
      sourceCatalog: [],
      destinationCatalog: [],
      catalogStale: false,
    })
  })

  it('publishes external route changes to route state and confirmed feedback', async () => {
    const { client, manager } = await readyManager()
    const feedback = vi.fn()
    manager.watchConfirmedRouteTarget(
      { connectionId: CONNECTION_ID, destination: 1, levels: [1] },
      feedback,
    )

    client.publishRoute(3, 1)

    expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(3)
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'ready',
        sourcesByLevel: new Map([[1, 3]]),
      }),
    )

    client.loseConnection()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'disconnected',
      catalogStale: true,
      deviceStatus: 'present',
      deviceModel: 'Blackmagic Videohub 12G 40x40',
      detectedSourceCount: 4,
      detectedDestinationCount: 3,
    })
    expect(manager.snapshots()[0]?.sourceCatalog).toHaveLength(3)
    expect(manager.snapshots()[0]?.destinationCatalog).toHaveLength(2)
    expect(manager.snapshots()[0]?.routes.routes.size).toBe(0)
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'pending', lastError: 'socket closed' }),
    )
  })

  it('confirms direct routes, rejects foreign locks, and never accepts non-video levels', async () => {
    const { client, manager } = await readyManager()

    await expect(
      manager.directRoute({
        connectionId: CONNECTION_ID,
        source: 3,
        destination: 1,
        levels: [1],
      }),
    ).resolves.toBeUndefined()
    expect(client.setCrosspoint).toHaveBeenCalledWith({ source: 3, destination: 1 })
    expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(3)

    client.publishForeignLock(2)
    await expect(
      manager.directRoute({ connectionId: CONNECTION_ID, source: 1, destination: 2 }),
    ).rejects.toMatchObject({ code: 'locked' })
    expect(manager.snapshots()[0]?.lockedDestinationCount).toBe(1)

    expect(() =>
      manager.directRoute({
        connectionId: CONNECTION_ID,
        source: 1,
        destination: 1,
        levels: [2],
      }),
    ).toThrow('only video level 1')
  })

  it('invalidates selections and watches that fall outside smaller detected dimensions', async () => {
    const { client, manager } = await readyManager()
    await manager.selectSource(CONNECTION_ID, 3, [1])
    manager.selectDestination(CONNECTION_ID, 2)
    const feedback = vi.fn()
    manager.watchConfirmedRouteTarget(
      { connectionId: CONNECTION_ID, destination: 2, levels: [1] },
      feedback,
    )

    client.replaceWithSmallerDevice()

    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'connected',
      effectiveSourceCount: 1,
      effectiveDestinationCount: 1,
      selectedSource: null,
      selectedDestination: null,
    })
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'pending',
        lastError: 'Videohub destination is outside the detected range',
      }),
    )
    expect(() =>
      manager.directRoute({ connectionId: CONNECTION_ID, source: 2, destination: 1 }),
    ).toThrow('source must be an integer from 1 to 1')
  })

  it('fences queued routes on disconnect and never replays them in a later epoch', async () => {
    const { client, manager } = await readyManager()
    const gate = deferred<undefined>()
    client.setCrosspointGate = gate.promise

    const uncertain = manager.directRoute({
      connectionId: CONNECTION_ID,
      source: 3,
      destination: 1,
    })
    const queued = manager.directRoute({
      connectionId: CONNECTION_ID,
      source: 1,
      destination: 2,
    })
    await vi.waitFor(() => {
      expect(client.setCrosspoint).toHaveBeenCalledOnce()
    })
    client.loseConnection()
    gate.resolve(undefined)

    await expect(uncertain).rejects.toThrow('not connected')
    await expect(queued).rejects.toThrow('not connected')
    expect(client.setCrosspoint).toHaveBeenCalledOnce()
  })

  it('returns a conflict without writing when Router-page expected readback is stale', async () => {
    const { client, manager } = await readyManager()
    const version = manager.routeState(CONNECTION_ID).version

    const result = await manager.routeCrosspoints({
      operationId: '00000000-0000-4000-8000-000000000010',
      connectionId: CONNECTION_ID,
      version,
      mappings: [
        {
          mappingId: '00000000-0000-4000-8000-000000000011',
          source: 3,
          destination: 1,
          levels: [1],
          expected: [{ level: 1, source: 2 }],
        },
      ],
    })

    expect(result).toMatchObject({
      status: 'partial',
      outcomes: [{ outcome: 'conflict', destination: 1, level: 1 }],
    })
    expect(client.setCrosspoint).not.toHaveBeenCalled()
  })

  it('reports every remaining destination as not attempted after a multi-route conflict', async () => {
    const { client, manager } = await readyManager()
    const version = manager.routeState(CONNECTION_ID).version

    const result = await manager.routeCrosspoints({
      operationId: '00000000-0000-4000-8000-000000000020',
      connectionId: CONNECTION_ID,
      version,
      mappings: [
        {
          mappingId: '00000000-0000-4000-8000-000000000021',
          source: 3,
          destination: 1,
          levels: [1],
          expected: [{ level: 1, source: 2 }],
        },
        {
          mappingId: '00000000-0000-4000-8000-000000000022',
          source: 1,
          destination: 2,
          levels: [1],
          expected: [{ level: 1, source: 2 }],
        },
      ],
    })

    expect(result).toMatchObject({
      status: 'partial',
      outcomes: [
        { outcome: 'conflict', destination: 1, level: 1 },
        { outcome: 'not_attempted', destination: 2, level: 1 },
      ],
    })
    expect(client.setCrosspoint).not.toHaveBeenCalled()
  })

  it('interrogates multiple destinations with one complete routing refresh', async () => {
    const { client, manager } = await readyManager()

    const result = await manager.interrogateRouteTargets({
      requestId: '00000000-0000-4000-8000-000000000012',
      connectionId: CONNECTION_ID,
      generation: manager.routeState(CONNECTION_ID).version.generation,
      targets: [
        { destination: 1, levels: [1] },
        { destination: 2, levels: [1] },
      ],
    })

    expect(result).toMatchObject({
      status: 'acknowledged',
      outcomes: [
        { destination: 1, level: 1, outcome: 'acknowledged' },
        { destination: 2, level: 1, outcome: 'acknowledged' },
      ],
    })
    expect(client.refreshRoutes).toHaveBeenCalledOnce()
    expect(client.readDestination).not.toHaveBeenCalled()
  })

  it('preserves the original targeted name-refresh failure for action error mapping', async () => {
    const { client, manager } = await readyManager()
    const failure = new VideohubError('timeout', 'Videohub acknowledgement timed out')
    client.refreshNames.mockRejectedValueOnce(failure)

    await expect(manager.refreshNames(CONNECTION_ID)).rejects.toBe(failure)
  })
})
