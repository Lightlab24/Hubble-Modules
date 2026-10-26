import { afterEach, describe, expect, it } from 'vitest'

import {
  FakeVideohubServer,
  VideohubClient,
  VideohubError,
  type FakeVideohubServerOptions,
  type VideohubClientEvent,
} from '../src/index.js'

const openServers = new Set<FakeVideohubServer>()

async function startServer(
  options: FakeVideohubServerOptions = {},
): Promise<FakeVideohubServer> {
  const server = await FakeVideohubServer.start(options)
  openServers.add(server)
  return server
}

function clientFor(
  server: FakeVideohubServer,
  options: Partial<ConstructorParameters<typeof VideohubClient>[0]> = {},
): VideohubClient {
  return new VideohubClient({
    host: '127.0.0.1',
    port: server.port,
    requestTimeoutMs: 80,
    connectTimeoutMs: 500,
    ...options,
  })
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
  message = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()))
  openServers.clear()
})

describe('VideohubClient', () => {
  it('hydrates immutable detected and capped state from a fragmented initial dump', async () => {
    const server = await startServer({
      sourceCount: 4,
      destinationCount: 3,
      fragmentInitialDump: true,
    })
    const client = clientFor(server, { sourceLimit: 3, destinationLimit: 2 })

    await client.connect()
    const snapshot = client.snapshot()
    expect(snapshot).toMatchObject({
      phase: 'connected',
      protocolVersion: '2.3',
      deviceStatus: 'present',
      modelName: 'Fake Videohub 4x3',
      detectedSourceCount: 4,
      detectedDestinationCount: 3,
      sourceCount: 3,
      destinationCount: 2,
      catalogStale: false,
      labelsDegraded: false,
    })
    expect(snapshot.sources.map((entry) => entry.address)).toEqual([1, 2, 3])
    expect(snapshot.destinations.map((entry) => entry.address)).toEqual([1, 2])
    expect(snapshot.routes).toEqual([
      { destination: 1, source: 1 },
      { destination: 2, source: 2 },
    ])
    expect(snapshot.locks).toEqual([
      { destination: 1, state: 'unlocked' },
      { destination: 2, state: 'unlocked' },
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sources)).toBe(true)

    client.disconnect()
  })

  it('retains only the stale catalog while resetting every transport hydration field on reconnect', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    const client = clientFor(server)
    await client.connect()
    server.pushInputLabel({ address: 1, name: 'Camera A' })
    await waitFor(() => client.snapshot().sources[0]?.name === 'Camera A')

    server.disconnectClients()
    await waitFor(() => client.snapshot().phase === 'disconnected')
    const reconnect = client.connect()
    expect(client.snapshot()).toMatchObject({
      phase: 'connecting',
      protocolVersion: null,
      deviceStatus: 'unknown',
      modelName: null,
      detectedSourceCount: null,
      detectedDestinationCount: null,
      sourceCount: null,
      destinationCount: null,
      catalogStale: true,
      sources: [
        { address: 1, name: 'Camera A' },
        { address: 2, name: 'Input 2' },
      ],
      routes: [],
      locks: [],
    })

    await reconnect
    expect(client.snapshot()).toMatchObject({
      phase: 'connected',
      protocolVersion: '2.3',
      deviceStatus: 'present',
      catalogStale: false,
    })
    client.disconnect()
  })

  it('keeps full route truth internally while hiding sources above the effective cap', async () => {
    const server = await startServer({ sourceCount: 4, destinationCount: 4 })
    const client = clientFor(server, { sourceLimit: 2 })
    const events: VideohubClientEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.connect()

    // Destinations 3 and 4 initially point at detected sources 3 and 4. Those
    // crosspoints remain authoritative internally, but cannot be exposed to a
    // capped catalog, selector, or tally consumer.
    expect(client.snapshot().routes).toEqual([
      { destination: 1, source: 1 },
      { destination: 2, source: 2 },
    ])

    server.pushRoute({ destination: 1, source: 4 })
    await waitFor(() => !client.snapshot().routes.some(({ destination }) => destination === 1))
    expect(client.snapshot().routes).toEqual([{ destination: 2, source: 2 }])
    expect(
      events.some(
        (event) =>
          event.type === 'route' &&
          event.crosspoint.destination === 1 &&
          event.crosspoint.source === 4,
      ),
    ).toBe(true)

    server.pushRoute({ destination: 1, source: 2 })
    await waitFor(
      () => client.snapshot().routes.find(({ destination }) => destination === 1)?.source === 2,
    )
    expect(client.snapshot().routes[0]).toEqual({ destination: 1, source: 2 })
    client.disconnect()
  })

  it('falls back to numeric labels when a complete label block has malformed rows', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      malformedInputLabel: 2,
    })
    const client = clientFor(server)
    await client.connect()

    expect(client.snapshot()).toMatchObject({
      labelsDegraded: true,
      sources: [
        { address: 1, name: 'Input 1' },
        { address: 2, name: 'Input 2' },
      ],
    })
    client.disconnect()
  })

  it('degrades unsafe labels during initial hydration without disabling routing', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    server.pushInputLabel({ address: 1, name: 'Camera\tOne' })
    server.pushOutputLabel({ address: 2, name: '🎥'.repeat(129) })
    const client = clientFor(server)

    await client.connect()

    expect(client.snapshot()).toMatchObject({
      phase: 'connected',
      labelsDegraded: true,
      sources: [
        { address: 1, name: 'Input 1' },
        { address: 2, name: 'Input 2' },
      ],
      destinations: [
        { address: 1, name: 'Output 1' },
        { address: 2, name: 'Output 2' },
      ],
    })
    await expect(client.setCrosspoint({ destination: 1, source: 2 })).resolves.toBeUndefined()
    client.disconnect()
  })

  it('degrades unsafe live label deltas while preserving the connected router', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    const client = clientFor(server)
    await client.connect()

    server.pushInputLabel({ address: 2, name: 'Camera\u2028Two' })
    server.pushOutputLabel({ address: 1, name: 'Program\u0007' })

    await waitFor(
      () =>
        client.snapshot().labelsDegraded &&
        client.snapshot().sources[1]?.name === 'Input 2' &&
        client.snapshot().destinations[0]?.name === 'Output 1',
      500,
      'unsafe live labels to use numeric fallbacks',
    )
    expect(client.snapshot().phase).toBe('connected')
    client.disconnect()
  })

  it('publishes pushed route, label, and lock changes from other clients', async () => {
    const server = await startServer({ sourceCount: 3, destinationCount: 2 })
    const client = clientFor(server)
    const events: VideohubClientEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.connect()

    server.pushRoute({ destination: 1, source: 3 })
    server.pushInputLabel({ address: 3, name: 'Graphics' })
    server.pushLock({ destination: 2, state: 'locked' })

    await waitFor(
      () =>
        client.snapshot().routes[0]?.source === 3 &&
        client.snapshot().sources[2]?.name === 'Graphics' &&
        client.snapshot().locks[1]?.state === 'locked',
    )
    expect(events.some((event) => event.type === 'route')).toBe(true)
    expect(events.some((event) => event.type === 'names')).toBe(true)
    expect(events.some((event) => event.type === 'lock')).toBe(true)
    client.disconnect()
  })

  it('treats an already confirmed route as an idempotent no-op', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    const client = clientFor(server)
    await client.connect()

    await client.setCrosspoint({ destination: 1, source: 1 })
    expect(server.routeCommands).toHaveLength(0)
    await expect(client.ping()).resolves.toBeUndefined()
    client.disconnect()
  })

  it('returns ordered per-destination outcomes for a mixed route block', async () => {
    const server = await startServer({ sourceCount: 3, destinationCount: 3 })
    const client = clientFor(server)
    await client.connect()
    server.pushLock({ destination: 2, state: 'locked' })
    await waitFor(() => client.snapshot().locks[1]?.state === 'locked')

    const results = await client.setCrosspoints([
      { destination: 1, source: 1 },
      { destination: 2, source: 3 },
      { destination: 3, source: 1 },
    ])

    expect(results.map((result) => result.status)).toEqual(['unchanged', 'failed', 'confirmed'])
    expect(results[1]).toMatchObject({ error: { code: 'locked' } })
    expect(server.routeCommands).toEqual([{ destination: 3, source: 1 }])
    client.disconnect()
  })

  it('atomically refreshes names and replays a concurrent pushed label delta', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      inputLabelDeltaDuringRefresh: { address: 2, name: 'Late Graphics' },
    })
    const client = clientFor(server)
    const nameEvents: VideohubClientEvent[] = []
    client.subscribe((event) => {
      if (event.type === 'names') nameEvents.push(event)
    })
    await client.connect()
    const before = nameEvents.length

    await client.refreshNames()

    expect(server.inputLabelStatusRequests).toBe(1)
    expect(server.outputLabelStatusRequests).toBe(1)
    expect(client.snapshot().sources[1]).toEqual({ address: 2, name: 'Late Graphics' })
    expect(nameEvents).toHaveLength(before + 1)
    client.disconnect()
  })

  it('sanitizes an unsafe label delta buffered during an atomic name refresh', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      inputLabelDeltaDuringRefresh: { address: 2, name: 'Late\tGraphics' },
    })
    const client = clientFor(server)
    await client.connect()

    await client.refreshNames()

    expect(client.snapshot()).toMatchObject({
      phase: 'connected',
      labelsDegraded: true,
      sources: [
        { address: 1, name: 'Input 1' },
        { address: 2, name: 'Input 2' },
      ],
    })
    client.disconnect()
  })

  it('does not resolve a route from ACK until authoritative readback arrives', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      routeReadbackDelayMs: 50,
    })
    const client = clientFor(server)
    await client.connect()

    let resolved = false
    const route = client.setCrosspoint({ destination: 1, source: 2 }).then(() => {
      resolved = true
    })
    await waitFor(() => server.routeCommands.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(resolved).toBe(false)
    await route
    expect(client.snapshot().routes[0]).toEqual({ destination: 1, source: 2 })
    client.disconnect()
  })

  it('rejects NAK and known foreign locks without claiming or changing locks', async () => {
    const rejecting = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      nakRoutes: true,
    })
    const rejectedClient = clientFor(rejecting)
    await rejectedClient.connect()
    await expect(
      rejectedClient.setCrosspoint({ destination: 1, source: 2 }),
    ).rejects.toMatchObject({
      code: 'rejected',
    })
    rejectedClient.disconnect()

    const locked = await startServer({ sourceCount: 2, destinationCount: 2 })
    const lockedClient = clientFor(locked)
    await lockedClient.connect()
    locked.pushLock({ destination: 1, state: 'locked' })
    await waitFor(() => lockedClient.snapshot().locks[0]?.state === 'locked')
    await expect(
      lockedClient.setCrosspoint({ destination: 1, source: 2 }),
    ).rejects.toMatchObject({
      code: 'locked',
    })
    expect(locked.routeCommands).toHaveLength(0)
    expect(locked.lockCommands).toHaveLength(0)
    lockedClient.disconnect()
  })

  it('requests one full route refresh after ambiguous confirmation timeout', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      suppressRouteUpdates: true,
    })
    const client = clientFor(server, { requestTimeoutMs: 30 })
    await client.connect()

    await client.setCrosspoint({ destination: 1, source: 2 })
    expect(server.routeStatusRequests).toBe(1)
    expect(client.snapshot().routes[0]).toEqual({ destination: 1, source: 2 })
    client.disconnect()
  })

  it('reports conflicting readback after the one allowed refresh', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      suppressRouteUpdates: true,
      applyRouteWrites: false,
    })
    const client = clientFor(server, { requestTimeoutMs: 25 })
    await client.connect()

    await expect(client.setCrosspoint({ destination: 1, source: 2 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof VideohubError && error.code === 'conflicting-readback',
    )
    expect(server.routeStatusRequests).toBe(1)
    client.disconnect()
  })

  it('fences a delayed ACK before reconnecting so it cannot acknowledge a later command', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      routeAcknowledgementDelayMs: 100,
    })
    const client = clientFor(server, { requestTimeoutMs: 25 })
    await client.connect()

    await client.setCrosspoint({ destination: 1, source: 2 })
    expect(server.routeStatusRequests).toBe(1)
    await waitFor(() => client.snapshot().phase === 'disconnected')
    expect(client.snapshot()).toMatchObject({ phase: 'disconnected', routes: [], locks: [] })

    await client.connect()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await expect(client.ping()).resolves.toBeUndefined()
    expect(server.routeCommands).toEqual([{ destination: 1, source: 2 }])
    client.disconnect()
  })

  it('fences a late NAK before reconnecting so it cannot reject a later command', async () => {
    const server = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      nakRoutes: true,
      routeAcknowledgementDelayMs: 100,
    })
    const client = clientFor(server, { requestTimeoutMs: 25 })
    await client.connect()

    await expect(client.setCrosspoint({ destination: 1, source: 2 })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(server.routeStatusRequests).toBe(1)
    expect(client.snapshot().phase).toBe('disconnected')

    await client.connect()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await expect(client.ping()).resolves.toBeUndefined()
    client.disconnect()
  })

  it('fails in-flight work on disconnect and never replays it after reconnect', async () => {
    const first = await startServer({
      sourceCount: 2,
      destinationCount: 2,
      routeReadbackDelayMs: 200,
    })
    const client = clientFor(first, { requestTimeoutMs: 300 })
    await client.connect()
    const pending = client.setCrosspoint({ destination: 1, source: 2 })
    const queued = client.setCrosspoint({ destination: 2, source: 1 })
    await waitFor(() => first.routeCommands.length === 1)
    first.disconnectClients()
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' })

    await client.connect()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(first.routeCommands).toHaveLength(1)
    client.disconnect()
  })

  it('invalidates state and rehydrates when the server reports a replacement device', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    const client = clientFor(server)
    const events: VideohubClientEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.connect()

    server.replaceDevice({ sourceCount: 3, destinationCount: 1, modelName: 'Replacement 3x1' })
    await waitFor(
      () =>
        client.snapshot().phase === 'connected' &&
        client.snapshot().modelName === 'Replacement 3x1',
    )
    expect(client.snapshot()).toMatchObject({
      detectedSourceCount: 3,
      detectedDestinationCount: 1,
      sourceCount: 3,
      destinationCount: 1,
    })
    expect(events.some((event) => event.type === 'routes-reset')).toBe(true)
    client.disconnect()
  })

  it('retains a stale catalog but clears confirmed routes when disconnected', async () => {
    const server = await startServer({ sourceCount: 2, destinationCount: 2 })
    const client = clientFor(server)
    await client.connect()
    server.disconnectClients()
    await waitFor(() => client.snapshot().phase === 'disconnected')

    expect(client.snapshot()).toMatchObject({ catalogStale: true, routes: [], locks: [] })
    expect(client.snapshot().sources).toHaveLength(2)
    client.disconnect()
  })

  it('returns a rejecting Promise when synchronous socket setup fails', async () => {
    const client = new VideohubClient({
      host: '127.0.0.1',
      port: 9990,
      requestTimeoutMs: 80,
      socketFactory: () => {
        throw new Error('socket factory exploded')
      },
    })

    const connection = client.connect()
    expect(connection).toBeInstanceOf(Promise)
    await expect(connection).rejects.toMatchObject({
      code: 'disconnected',
      message: 'Unable to start Videohub connection: socket factory exploded',
    })
    expect(client.snapshot().phase).toBe('disconnected')
  })
})
