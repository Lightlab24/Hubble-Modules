import type {
  OgpCrosspoint,
  UltrixOgpClientEvent,
  UltrixOgpSnapshot,
} from '@hubble/protocol-ultrix-ogp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RossUltrixOgpConnectionDefinitionSchema,
  type RossUltrixOgpConnectionDefinition,
} from '../src/config.js'

import {
  RossUltrixOgpConnectionManager,
  type RossUltrixOgpManagedClient,
} from '../src/ross-ultrix-ogp-connection-manager.js'

const CONNECTION_ID = '00000000-0000-4000-8000-000000000010'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function definition(
  overrides: Partial<RossUltrixOgpConnectionDefinition> = {},
): RossUltrixOgpConnectionDefinition {
  return RossUltrixOgpConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'ross-ultrix-ogp',
    name: 'Ultrix OGP',
    enabled: true,
    host: '10.20.70.50',
    port: 5_254,
    sourceLimit: 152,
    destinationLimit: 152,
    levels: 17,
    requestTimeoutMs: 1_000,
    reconnectDelayMs: 2_000,
    schemaVersion: 1,
    ...overrides,
  })
}

function frozenRoutes(routes: readonly OgpCrosspoint[]): readonly OgpCrosspoint[] {
  return Object.freeze(
    routes
      .map((crosspoint) => Object.freeze({ ...crosspoint }))
      .sort((left, right) => left.destination - right.destination || left.level - right.level),
  )
}

function replaceRoutes(
  routes: readonly OgpCrosspoint[],
  source: number,
  destination: number,
  levels: readonly number[],
): readonly OgpCrosspoint[] {
  const replacements = new Map(
    levels.map((level) => [
      `${String(destination)}:${String(level)}`,
      Object.freeze({ source, destination, level }),
    ]),
  )
  const retained = routes.filter(
    ({ destination: routeDestination, level }) =>
      !replacements.has(`${String(routeDestination)}:${String(level)}`),
  )
  return frozenRoutes([...retained, ...replacements.values()])
}

class FakeClient implements RossUltrixOgpManagedClient {
  readonly listeners = new Set<(event: UltrixOgpClientEvent) => void>()
  readonly setCrosspoint = vi.fn(
    (input: {
      readonly source: number
      readonly destination: number
      readonly levels?: readonly number[]
    }) => {
      const levels = input.levels ?? Array.from({ length: 17 }, (_, index) => index + 1)
      const previousRevision = this.value.revision
      this.value = {
        ...this.value,
        revision: previousRevision + 1,
        routes: replaceRoutes(this.value.routes, input.source, input.destination, levels),
      }
      this.emit({
        type: 'routes',
        previousRevision,
        revision: this.value.revision,
        crosspoints: Object.freeze(
          levels.map((level) => ({
            destination: input.destination,
            level,
            source: input.source,
          })),
        ),
      })
      return Promise.resolve()
    },
  )
  readonly refreshNames = vi.fn(() => Promise.resolve())
  readonly refreshRoutes = vi.fn(() => Promise.resolve())
  readonly readDestination = vi.fn(
    (destination: number, levels?: readonly number[]): Promise<readonly OgpCrosspoint[]> => {
      const selected = levels ?? Array.from({ length: 17 }, (_, index) => index + 1)
      return Promise.resolve(
        Object.freeze(
          selected.map((level) => ({
            destination,
            level,
            source:
              this.value.routes.find(
                (route) => route.destination === destination && route.level === level,
              )?.source ?? null,
          })),
        ),
      )
    },
  )
  value: UltrixOgpSnapshot = {
    phase: 'disconnected',
    revision: 0,
    catalogRevision: 1,
    controlReady: true,
    takeError: null,
    sources: Object.freeze(
      Array.from({ length: 152 }, (_, index) => ({
        address: index + 1,
        label: `SRC ${String(index + 1)}`,
        description: null,
      })),
    ),
    destinations: Object.freeze(
      Array.from({ length: 152 }, (_, index) => ({
        address: index + 1,
        label: `DST ${String(index + 1)}`,
        description: null,
      })),
    ),
    levels: Object.freeze(
      Array.from({ length: 17 }, (_, index) => ({
        level: index + 1,
        label: index === 0 ? 'VID' : `AUD ${String(index)}`,
      })),
    ),
    routes: frozenRoutes(
      Array.from({ length: 17 }, (_, index) => ({
        destination: 1,
        level: index + 1,
        source: 18,
      })),
    ),
    subscriptions: Object.freeze([
      'params.statusByDestination.0.inputstatus',
      'params.controlready',
      'params.takeError',
    ]),
    multiSetEnabled: true,
    lastError: null,
  }

  readonly connect = vi.fn(() => {
    if (this.value.phase === 'connected') return Promise.resolve()
    this.value = { ...this.value, phase: 'connected' }
    this.emit({ type: 'phase', phase: 'connected', error: null })
    return Promise.resolve()
  })

  readonly disconnect = vi.fn(() => {
    if (this.value.phase === 'disconnected') return
    this.value = { ...this.value, phase: 'disconnected' }
    this.emit({ type: 'phase', phase: 'disconnected', error: null })
  })

  snapshot(): UltrixOgpSnapshot {
    return this.value
  }

  subscribe(listener: (event: UltrixOgpClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  externalRoute(source: number, destination: number, level: number): void {
    const previousRevision = this.value.revision
    this.value = {
      ...this.value,
      revision: previousRevision + 1,
      routes: replaceRoutes(this.value.routes, source, destination, [level]),
    }
    this.emit({
      type: 'route',
      previousRevision,
      revision: this.value.revision,
      crosspoint: { source, destination, level },
    })
  }

  observeRoute(source: number, destination: number, level: number): void {
    this.emit({
      type: 'route-observation',
      revision: this.value.revision,
      crosspoint: { source, destination, level },
    })
  }

  loseConnection(error = 'connection lost'): void {
    this.value = { ...this.value, phase: 'disconnected', lastError: error }
    this.emit({ type: 'phase', phase: 'disconnected', error })
  }

  staleRouteEvent(source: number, destination: number, level: number): void {
    this.emit({
      type: 'route',
      previousRevision: this.value.revision + 10,
      revision: this.value.revision + 11,
      crosspoint: { source, destination, level },
    })
  }

  emitTakeError(error: string): void {
    this.value = { ...this.value, takeError: error }
    this.emit({ type: 'take-error', error })
  }

  private emit(event: UltrixOgpClientEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

const managers: RossUltrixOgpConnectionManager[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const manager of managers.splice(0)) manager.stop()
})

async function readyManager(
  connection = definition(),
): Promise<{ readonly client: FakeClient; readonly manager: RossUltrixOgpConnectionManager }> {
  const client = new FakeClient()
  const manager = new RossUltrixOgpConnectionManager(() => client)
  managers.push(manager)
  manager.reconcile([connection])
  await vi.waitFor(() => {
    expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
  })
  return { client, manager }
}

describe('RossUltrixOgpConnectionManager', () => {
  it('replaces the transport immediately on an IP change and ignores the old client', async () => {
    const clients: FakeClient[] = []
    const createClient = vi.fn<(definition: RossUltrixOgpConnectionDefinition) => FakeClient>(
      () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
    )
    const manager = new RossUltrixOgpConnectionManager(createClient)
    managers.push(manager)
    manager.reconcile([definition()])
    await vi.waitFor(() => {
      expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
    })
    const old = clients[0]
    if (old === undefined) throw new Error('Missing original OGP client')
    manager.reconcile([{ ...definition(), host: '10.20.70.51' }])
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient.mock.calls[1]?.[0]).toMatchObject({ host: '10.20.70.51' })
    expect(old.listeners.size).toBe(0)
    await vi.waitFor(() => {
      expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
    })
    old.loseConnection()
    expect(manager.snapshots()[0]?.definition.host).toBe('10.20.70.51')
    expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
  })

  it('keeps tracked OGP acceptance on the existing settled boundary', async () => {
    const { client, manager } = await readyManager()
    const heldRoute = deferred<void>()
    client.setCrosspoint.mockImplementationOnce(() => heldRoute.promise)

    const submission = manager.submitDirectRouteTracked({
      connectionId: CONNECTION_ID,
      source: 27,
      destination: 7,
      levels: [1],
    })
    const accepted = vi.fn()
    const settled = vi.fn()
    void submission.accepted.then(accepted, accepted)
    void submission.settled.then(settled, settled)

    await vi.waitFor(() => {
      expect(client.setCrosspoint).toHaveBeenCalledWith({
        source: 27,
        destination: 7,
        levels: [1],
      })
    })
    expect(submission.submissionId).toMatch(/^ogp:/u)
    expect(accepted).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()

    heldRoute.reject(new Error('Ultrix OGP route was not confirmed for destination 7'))
    await expect(submission.accepted).rejects.toThrow(/not confirmed/iu)
    await expect(submission.settled).rejects.toThrow(/not confirmed/iu)
    expect(accepted).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledOnce()
  })

  it('publishes independent ready snapshots for two watched destinations without mutation', async () => {
    const { client, manager } = await readyManager()
    client.externalRoute(21, 7, 1)
    client.externalRoute(22, 7, 2)
    client.externalRoute(31, 8, 1)
    client.externalRoute(32, 8, 2)
    client.setCrosspoint.mockClear()

    const destination7 = vi.fn()
    const destination8 = vi.fn()
    const unwatch7 = manager.watchConfirmedRouteTarget(
      { connectionId: CONNECTION_ID, destination: 7, levels: [1, 2] },
      destination7,
    )
    const unwatch8 = manager.watchConfirmedRouteTarget(
      { connectionId: CONNECTION_ID, destination: 8, levels: [1, 2] },
      destination8,
    )

    expect(destination7.mock.calls[0]?.[0]).toMatchObject({
      destination: 7,
      phase: 'pending',
    })
    expect(destination8.mock.calls[0]?.[0]).toMatchObject({
      destination: 8,
      phase: 'pending',
    })
    await vi.waitFor(() => {
      expect(destination7).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phase: 'ready',
          sourcesByLevel: new Map([
            [1, 21],
            [2, 22],
          ]),
        }),
      )
      expect(destination8).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phase: 'ready',
          sourcesByLevel: new Map([
            [1, 31],
            [2, 32],
          ]),
        }),
      )
    })
    expect(client.readDestination).toHaveBeenCalledWith(7, [1, 2])
    expect(client.readDestination).toHaveBeenCalledWith(8, [1, 2])
    expect(client.setCrosspoint).not.toHaveBeenCalled()

    client.externalRoute(23, 7, 1)
    expect(destination7).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'ready',
        sourcesByLevel: new Map([
          [1, 23],
          [2, 22],
        ]),
      }),
    )
    expect(destination8).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'ready',
        sourcesByLevel: new Map([
          [1, 31],
          [2, 32],
        ]),
      }),
    )
    expect(client.setCrosspoint).not.toHaveBeenCalled()

    unwatch7()
    unwatch8()
  })

  it('hydrates bounded catalogs and subscribed crosspoints before becoming ready', async () => {
    const { manager } = await readyManager()
    const snapshot = manager.snapshots()[0]

    expect(snapshot).toMatchObject({
      phase: 'connected',
      routeTransport: 'connected',
      selectedSource: null,
      selectedDestination: 1,
    })
    expect(snapshot?.sourceCatalog).toHaveLength(152)
    expect(snapshot?.destinationCatalog).toHaveLength(152)
    expect(snapshot?.routes.routes.get(1)?.get(1)).toBe(18)
    expect(manager.routeState(CONNECTION_ID)).toMatchObject({
      phase: 'ready',
      labelPhase: 'ready',
      knownSourceCount: 152,
      knownDestinationCount: 152,
    })
  })

  it('does not attribute router-wide take errors to the Hubble connection', async () => {
    const client = new FakeClient()
    client.value = { ...client.value, takeError: 'Breakaway Error|external route' }
    const manager = new RossUltrixOgpConnectionManager(() => client)
    managers.push(manager)

    manager.reconcile([definition()])
    await vi.waitFor(() => {
      expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
    })
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'connected',
      lastError: null,
    })

    client.emitTakeError('Take Error|another controller')

    expect(manager.snapshots()[0]?.lastError).toBeNull()
  })

  it('disconnects and fences a connected client when post-connect hydration fails', async () => {
    vi.useFakeTimers()
    const client = new FakeClient()
    client.value = { ...client.value, controlReady: false }
    const manager = new RossUltrixOgpConnectionManager(() => client)
    managers.push(manager)

    manager.reconcile([definition({ reconnectDelayMs: 100 })])
    await Promise.resolve()
    await Promise.resolve()

    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(client.snapshot().phase).toBe('disconnected')
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'disconnected',
      routeTransport: 'disconnected',
      lastError: 'Ultrix routing control is not ready',
    })
    expect(manager.routeState(CONNECTION_ID).phase).toBe('stale')

    client.value = { ...client.value, controlReady: true }
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()

    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
    expect(client.setCrosspoint).not.toHaveBeenCalled()
  })

  it('stages source without routing and preserves manual Take level masks', async () => {
    const { client, manager } = await readyManager()
    manager.selectDestination(CONNECTION_ID, 9)
    await manager.selectSource(CONNECTION_ID, 21, [1, 3, 5])
    expect(client.setCrosspoint).not.toHaveBeenCalled()
    await manager.take(CONNECTION_ID, [1, 3, 5])
    expect(client.setCrosspoint).toHaveBeenCalledWith({
      source: 21,
      destination: 9,
      levels: [1, 3, 5],
    })
  })

  it('keeps submitted routes pending through confirmation and propagates a late rejection', async () => {
    const { client, manager } = await readyManager()
    manager.selectDestination(CONNECTION_ID, 9)

    await manager.submitSelectSource(CONNECTION_ID, 21, [1, 3])
    expect(client.setCrosspoint).not.toHaveBeenCalled()

    const manualTakeConfirmation = deferred<void>()
    client.setCrosspoint.mockImplementationOnce(() => manualTakeConfirmation.promise)
    const manualTake = manager.submitTake(CONNECTION_ID, [1, 3])
    const manualTakeSettled = vi.fn()
    void manualTake.then(manualTakeSettled, manualTakeSettled)

    await vi.waitFor(() => {
      expect(client.setCrosspoint).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    expect(manualTakeSettled).not.toHaveBeenCalled()
    manualTakeConfirmation.resolve(undefined)
    await expect(manualTake).resolves.toBeUndefined()

    const directRouteConfirmation = deferred<void>()
    client.setCrosspoint.mockImplementationOnce(() => directRouteConfirmation.promise)
    const directRoute = manager.submitDirectRoute({
      connectionId: CONNECTION_ID,
      source: 43,
      destination: 7,
      levels: [4],
    })
    const directRouteSettled = vi.fn()
    void directRoute.then(directRouteSettled, directRouteSettled)

    await vi.waitFor(() => {
      expect(client.setCrosspoint).toHaveBeenCalledTimes(2)
    })
    await Promise.resolve()
    expect(directRouteSettled).not.toHaveBeenCalled()
    directRouteConfirmation.reject(
      new Error('Ultrix OGP route was not confirmed for destination 7'),
    )
    await expect(directRoute).rejects.toThrow(/route was not confirmed for destination 7/iu)
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'connected',
      lastError:
        'Last submitted route failed: Ultrix OGP route was not confirmed for destination 7',
    })
  })

  it('expands blank levels to every configured level and direct routes without changing selection', async () => {
    const { client, manager } = await readyManager()

    await manager.directRoute({
      connectionId: CONNECTION_ID,
      source: 12,
      destination: 15,
    })

    expect(client.setCrosspoint).toHaveBeenCalledWith({
      source: 12,
      destination: 15,
      levels: Array.from({ length: 17 }, (_, index) => index + 1),
    })
    expect(manager.snapshots()[0]).toMatchObject({
      selectedSource: null,
      selectedDestination: 1,
    })
  })

  it('publishes external subscribed route changes as confirmed feedback', async () => {
    const { client, manager } = await readyManager()
    const listener = vi.fn()
    const unsubscribe = manager.subscribePrimaryRouteFeedback(listener)
    listener.mockClear()

    client.externalRoute(27, 7, 1)

    expect(listener).toHaveBeenCalledOnce()
    expect(manager.snapshots()[0]?.routes.routes.get(7)?.get(1)).toBe(27)
    unsubscribe()
  })

  it('keeps a 17-level unchanged OGP row out of every public route stream', async () => {
    const { client, manager } = await readyManager()
    const snapshots = vi.fn()
    const primaryFeedback = vi.fn()
    const routeState = vi.fn()
    const unsubscribeSnapshots = manager.subscribe(snapshots)
    const unsubscribePrimary = manager.subscribePrimaryRouteFeedback(primaryFeedback)
    const unsubscribeRouteState = manager.subscribeRouteState(CONNECTION_ID, routeState)
    snapshots.mockClear()
    primaryFeedback.mockClear()

    for (let level = 1; level <= 17; level += 1) {
      client.observeRoute(18, 1, level)
    }

    expect(routeState).not.toHaveBeenCalled()
    expect(snapshots).not.toHaveBeenCalled()
    expect(primaryFeedback).not.toHaveBeenCalled()

    client.externalRoute(27, 7, 1)

    expect(routeState).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'delta',
        crosspoints: [
          expect.objectContaining({
            matrix: 1,
            source: 27,
            destination: 7,
            level: 1,
          }),
        ],
      }),
    )
    expect(snapshots).toHaveBeenCalledOnce()
    expect(primaryFeedback).toHaveBeenCalledOnce()
    expect(manager.snapshots()[0]?.routes.routes.get(7)?.get(1)).toBe(27)
    unsubscribeRouteState()
    unsubscribePrimary()
    unsubscribeSnapshots()
  })

  it('refreshes names and performs exact destination readback without polling', async () => {
    const { client, manager } = await readyManager()
    client.value = {
      ...client.value,
      catalogRevision: client.value.catalogRevision + 1,
      sources: Object.freeze([
        { address: 1, label: 'CAM A', description: null },
        ...client.value.sources.slice(1),
      ]),
    }

    await manager.refreshNames(CONNECTION_ID)
    const result = await manager.interrogateRouteTargets({
      requestId: 'readback-1',
      connectionId: CONNECTION_ID,
      generation: manager.routeState(CONNECTION_ID).version.generation,
      targets: [{ destination: 1, levels: [1, 2] }],
    })

    expect(client.refreshNames).toHaveBeenCalledOnce()
    expect(manager.snapshots()[0]?.sourceCatalog[0]?.label).toBe('CAM A')
    expect(client.readDestination).toHaveBeenCalledWith(1, [1, 2])
    expect(result.status).toBe('acknowledged')
  })

  it('preserves idempotent operation IDs and rejects conflicting reuse', async () => {
    const { client, manager } = await readyManager()
    const request = {
      operationId: 'route-operation-1',
      connectionId: CONNECTION_ID,
      version: manager.routeState(CONNECTION_ID).version,
      mappings: [
        {
          mappingId: 'mapping-1',
          source: 21,
          destination: 1,
          levels: [1],
          expected: [{ level: 1, source: 18 }],
        },
      ],
    } as const

    const first = await manager.routeCrosspoints(request)
    const replay = await manager.routeCrosspoints(request)
    const conflict = await manager.routeCrosspoints({
      ...request,
      mappings: [
        {
          ...request.mappings[0],
          source: 22,
        },
      ],
    })

    expect(first).toMatchObject({ status: 'acknowledged' })
    expect(replay).toEqual(first)
    expect(client.setCrosspoint).toHaveBeenCalledOnce()
    expect(conflict).toEqual({
      status: 'rejected',
      operationId: request.operationId,
      code: 'operation_id_conflict',
    })
  })

  it('returns atomic partial outcomes when the expected route no longer matches', async () => {
    const { client, manager } = await readyManager()
    const result = await manager.routeCrosspoints({
      operationId: 'route-operation-2',
      connectionId: CONNECTION_ID,
      version: manager.routeState(CONNECTION_ID).version,
      mappings: [
        {
          mappingId: 'mapping-1',
          source: 21,
          destination: 1,
          levels: [1, 2, 3],
          expected: [
            { level: 1, source: 18 },
            { level: 2, source: 99 },
            { level: 3, source: 18 },
          ],
        },
      ],
    })

    expect(client.setCrosspoint).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      status: 'partial',
      outcomes: [
        { level: 1, outcome: 'acknowledged' },
        { level: 2, outcome: 'conflict' },
        { level: 3, outcome: 'not_attempted' },
      ],
    })
  })

  it('rejects stale subscription revisions and restores the authoritative snapshot', async () => {
    const { client, manager } = await readyManager()

    client.staleRouteEvent(99, 1, 1)

    expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(18)
    expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')
  })

  it('retains selection but fences and never replays a take across reconnect', async () => {
    vi.useFakeTimers()
    const { client, manager } = await readyManager(definition({ reconnectDelayMs: 100 }))
    manager.selectDestination(CONNECTION_ID, 9)
    await manager.selectSource(CONNECTION_ID, 21, [1])
    client.setCrosspoint.mockClear()

    client.loseConnection()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'disconnected',
      routeTransport: 'disconnected',
      selectedSource: 21,
      selectedDestination: 9,
    })
    expect(manager.routeState(CONNECTION_ID).phase).toBe('stale')

    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()

    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(client.setCrosspoint).not.toHaveBeenCalled()
    expect(manager.snapshots()[0]).toMatchObject({
      selectedSource: 21,
      selectedDestination: 9,
    })
  })
})
