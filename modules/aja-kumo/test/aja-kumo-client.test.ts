import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AjaKumoConnectionDefinitionSchema,
  type AjaKumoConnectionDefinition,
} from '../src/config.js'

import { AjaKumoClient } from '../src/aja-kumo-client.js'
import { AjaKumoConnectionManager } from '../src/aja-kumo-connection-manager.js'
import { FakeAjaKumo } from './fixtures/fake-aja-kumo.mjs'

let server: FakeAjaKumo
const clients: Pick<AjaKumoClient, 'disconnect'>[] = []
const managers: Pick<AjaKumoConnectionManager, 'stop'>[] = []

beforeEach(async () => {
  server = new FakeAjaKumo()
  await server.start()
})
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  for (const client of clients.splice(0)) client.disconnect()
  await server.stop()
})

function definition(
  overrides: Partial<AjaKumoConnectionDefinition> = {},
): AjaKumoConnectionDefinition {
  return AjaKumoConnectionDefinitionSchema.parse({
    connectionId: '00000000-0000-4000-8000-000000000001',
    type: 'aja-kumo',
    name: 'KUMO',
    enabled: true,
    host: '127.0.0.1',
    port: server.port,
    requestTimeoutMs: 500,
    reconnectDelayMs: 100,
    schemaVersion: 1,
    ...overrides,
  })
}

const Client = AjaKumoClient,
  Manager = AjaKumoConnectionManager,
  Router = AjaKumoConnectionManager
describe('AJA KUMO transport and selected-driver manager', () => {
  function client(
    overrides: Partial<AjaKumoConnectionDefinition> = {},
  ): Pick<AjaKumoClient, keyof AjaKumoClient> {
    const instance = new Client(definition(overrides))
    clients.push(instance)
    return instance
  }
  it('discovers all eight salvo names and follows live renames with numbered fallback', async () => {
    server.replies.set('get:eParamID_Salvo2', { status: 404, value: {} })
    const kumo = client({ sourceLimit: 1, destinationLimit: 1 })
    await kumo.connect()
    expect(kumo.salvoCatalog()).toHaveLength(8)
    expect(kumo.salvoCatalog()).toContainEqual({ address: 8, name: 'Preset 8' })
    expect(kumo.salvoCatalog()).toContainEqual({ address: 2, name: '' })
    server.emit({ param_id: 'eParamID_Salvo8', str_value: { name: 'Backup\nShow' } })
    await vi.waitFor(() => {
      expect(kumo.salvoCatalog()).toContainEqual({ address: 8, name: 'Backup Show' })
    })
    kumo.disconnect()
    expect(kumo.salvoCatalog()).toEqual([])
  })
  it('recalls device presets with authentication and reads actual routes, respecting locked outputs', async () => {
    server.password = 'salvo & password'
    server.locks.add(2)
    const kumo = client({ password: server.password, destinationLimit: 2 })
    await kumo.connect()
    // Firmware may omit route events; the recall still explicitly reads the resulting routes.
    const emit = vi.spyOn(server, 'emit').mockImplementation(() => {})
    await kumo.recallSalvo(8)
    expect(server.salvoRecalls).toEqual([8])
    expect(server.routes.get(4)).toBe(1) // Device preset is not limited by Hubble's caps.
    expect(kumo.snapshot().routes).toEqual([
      { destination: 1, source: 4 },
      { destination: 2, source: 2 },
    ])
    expect(server.writes).toEqual([])
    emit.mockRestore()
  })
  it('rejects invalid, cancelled, and unacknowledged recalls without optimistic feedback', async () => {
    const kumo = client()
    await kumo.connect()
    for (const number of [0, 9, 1.5, NaN]) {
      await expect(kumo.recallSalvo(number)).rejects.toThrow(/salvo.*1 to 8/iu)
    }
    await expect(kumo.recallSalvo(1, AbortSignal.abort())).rejects.toThrow()
    expect(server.salvoRecalls).toEqual([])
    server.replies.set('set:eParamID_TakeSalvo', { value: { value: 0 } })
    await expect(kumo.recallSalvo(1)).rejects.toThrow(/not acknowledged/iu)
    expect(kumo.snapshot().routes).toContainEqual({ destination: 1, source: 1 })
    server.replies.delete('set:eParamID_TakeSalvo')
    server.rejectWrites = true
    await expect(kumo.recallSalvo(1)).rejects.toThrow(/rejected/iu)
    expect(server.salvoRecalls).toEqual([])
  })
  it.each(['cancel', 'reconnect'] as const)(
    'fences a queued salvo after %s without replay',
    async (reason) => {
      const config = definition({ requestTimeoutMs: 2_000 })
      const manager = new Router()
      managers.push(manager)
      manager.reconcile([config])
      await vi.waitFor(() => {
        expect(manager.snapshots()[0]?.phase).toBe('connected')
      })
      server.holdReads = true
      const route = manager
        .submitDirectRoute({ connectionId: config.connectionId, source: 2, destination: 1 })
        .catch(() => {})
      await vi.waitFor(() => {
        expect(server.heldReads).toHaveLength(1)
      })
      const cancellation = new AbortController()
      const recalled = expect(
        manager.recallSalvo(config.connectionId, 8, cancellation.signal),
      ).rejects.toThrow()
      if (reason === 'cancel') cancellation.abort()
      else manager.refresh()
      server.holdReads = false
      for (const finish of server.heldReads.splice(0)) finish()
      await route
      await recalled
      await vi.waitFor(() => {
        expect(manager.snapshots()[0]?.phase).toBe('connected')
      })
      expect(server.salvoRecalls).toEqual([])
      await manager.recallSalvo(config.connectionId, 8)
      expect(server.salvoRecalls).toEqual([8])
      expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(4)
      expect(manager.snapshots()[0]?.salvoCatalog).toContainEqual({
        address: 8,
        name: 'Preset 8',
      })
    },
  )
  it.each([
    { key: 'connect:', value: { connectionid: 'invalid' }, error: /connection ID/iu },
    { key: 'connect:', value: null, error: /JSON data/iu },
    { key: 'connect:', body: '{', error: /invalid JSON/iu },
    { key: 'connect:', body: ' '.repeat(1_048_577), error: /size limit/iu },
    { key: 'connect:', status: 503, value: {}, error: /HTTP 503/iu },
    { key: 'get:eParamID_NumberOfSources', value: { value: 1.5 }, error: /integer/iu },
    { key: 'get:eParamID_NumberOfDestinations', value: { value: 0 }, error: /integer/iu },
    { key: 'get:eParamID_XPT_Destination1_Locked', value: { value: 2 }, error: /lock state/iu },
  ])(
    'rejects an invalid device response at $key ($error)',
    async ({ key, error, ...reply }) => {
      server.replies.set(key, reply)
      const kumo = client()
      await expect(kumo.connect()).rejects.toThrow(error)
      expect(kumo.snapshot().phase).toBe('disconnected')
      expect(kumo.snapshot().routes).toEqual([])
      expect(server.writes).toEqual([])
    },
  )
  it('keeps routing available when older firmware omits optional names and locks', async () => {
    server.replies.set('get:eParamID_KumoProductID', { value: {} })
    server.replies.set('get:eParamID_XPT_Source1_Line_1', { status: 404, value: {} })
    server.replies.set('get:eParamID_XPT_Destination1_Locked', { status: 404, value: {} })
    const kumo = client()
    await kumo.connect()
    expect(kumo.snapshot()).toMatchObject({
      phase: 'connected',
      modelName: 'AJA KUMO',
      labelsDegraded: true,
    })
    expect(kumo.snapshot().sources).toContainEqual({ address: 1, name: '' })
    await kumo.setCrosspoint({ source: 2, destination: 1 })
    expect(server.writes).toEqual([{ source: 2, destination: 1 }])
  })
  it('updates both label lines and lock events while ignoring unconfigured addresses and unrelated events', async () => {
    const kumo = client({ sourceLimit: 2, destinationLimit: 2 })
    const observer = vi.fn(() => {
      throw new Error('Observer failed')
    })
    const unsubscribe = kumo.subscribe(observer)
    await kumo.connect()
    server.emit({})
    server.emit({ param_id: 'eParamID_Unrelated', int_value: 1 })
    server.route(4, 3)
    server.emit({ param_id: 'eParamID_XPT_Source4_Line_1', str_value: 'Outside cap' })
    server.emit({ param_id: 'eParamID_XPT_Destination4_Locked', int_value: 1 })
    server.emit({ param_id: 'eParamID_XPT_Source2_Line_2', str_value: 'Stage\nLeft' })
    server.emit({ param_id: 'eParamID_XPT_Destination1_Line_1', str_value: 'PGM' })
    server.emit({ param_id: 'eParamID_XPT_Destination1_Line_2', str_value: null })
    server.emit({ param_id: 'eParamID_XPT_Destination1_Locked', int_value: '1' })
    await vi.waitFor(() => {
      expect(kumo.snapshot().sources).toContainEqual({
        address: 2,
        name: 'Source 2 Stage Left',
      })
      expect(kumo.snapshot().destinations).toContainEqual({ address: 1, name: 'PGM' })
      expect(kumo.snapshot().locks).toContainEqual({ destination: 1, state: 'locked' })
    })
    expect(kumo.snapshot().routes).toHaveLength(2)
    expect(kumo.snapshot().sources).toHaveLength(2)
    expect(kumo.snapshot().locks).toHaveLength(2)
    expect(observer).toHaveBeenCalled()
    unsubscribe()
    observer.mockClear()
    server.emit({ param_id: 'eParamID_XPT_Destination1_Locked', int_value: '0' })
    await vi.waitFor(() => {
      expect(kumo.snapshot().locks).toContainEqual({ destination: 1, state: 'unlocked' })
    })
    expect(observer).not.toHaveBeenCalled()
  })
  it.each([
    { param_id: 'eParamID_NumberOfSources', int_value: 8 },
    { param_id: 'eParamID_XPT_Destination1_Locked', int_value: 7 },
    { param_id: 'eParamID_XPT_Destination1_Status', int_value: 0 },
  ])('clears feedback when the event stream requires resynchronization: %j', async (event) => {
    const kumo = client()
    await kumo.connect()
    server.emit(event)
    await vi.waitFor(() => {
      expect(kumo.snapshot().phase).toBe('disconnected')
    })
    expect(kumo.snapshot().routes).toEqual([])
    expect(server.writes).toEqual([])
  })
  it('rejects malformed event batches and does not execute commands while disconnected', async () => {
    const kumo = client()
    await expect(kumo.refreshNames()).rejects.toThrow(/not connected/iu)
    await expect(kumo.readDestination(1)).rejects.toThrow(/not connected/iu)
    await expect(kumo.setCrosspoint({ source: 1, destination: 1 })).rejects.toThrow(
      /not connected/iu,
    )
    server.malformedEvents = true
    await kumo.connect()
    await vi.waitFor(() => {
      expect(kumo.snapshot().phase).toBe('disconnected')
    })
    expect(kumo.snapshot().lastError).toMatch(/invalid configuration events/iu)
    expect(server.writes).toEqual([])
  })
  it('discovers dimensions, two-line names, routes, and locks, then confirms HTTP routing', async () => {
    server.locks.add(4)
    const kumo = client()
    await kumo.connect()
    expect(kumo.snapshot()).toMatchObject({
      phase: 'connected',
      detectedSourceCount: 4,
      detectedDestinationCount: 4,
      sourceCount: 4,
      destinationCount: 4,
      modelName: 'KUMO Test Router',
      sources: [
        { address: 1, name: 'Source 1 Studio' },
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    })
    expect(kumo.snapshot().locks).toContainEqual({ destination: 4, state: 'locked' })
    await kumo.setCrosspoint({ source: 3, destination: 1 })
    expect(server.writes).toEqual([{ source: 3, destination: 1 }])
    expect(kumo.snapshot().routes).toContainEqual({ source: 3, destination: 1 })
    expect(kumo.snapshot().confirmedOperationSequence).toBe(1)
  })
  it('authenticates with an encoded form and keeps the session cookie for reads, events, and writes', async () => {
    server.password = 'a&b=secret + ü'
    const kumo = client({ password: server.password })
    await kumo.connect()
    await kumo.setCrosspoint({ source: 2, destination: 1 })
    expect(server.writes).toHaveLength(1)
    expect(server.requests.every((url) => !url.toString().includes('secret'))).toBe(true)
  })
  it('rejects missing and wrong passwords without claiming a healthy connection', async () => {
    server.password = 'secret'
    const missing = client()
    await expect(missing.connect()).rejects.toThrow(/authentication/iu)
    expect(missing.snapshot().phase).toBe('disconnected')
    const wrong = client({ password: 'wrong' })
    await expect(wrong.connect()).rejects.toThrow(/authentication failed/iu)
    expect(server.writes).toEqual([])
  })
  it('discards an expired login cookie and ignores malformed cookie headers', async () => {
    server.password = 'secret'
    server.replies.set('get:eParamID_KumoProductID', {
      value: { value_name: 'KUMO' },
      headers: { 'Set-Cookie': ['malformed-cookie', 'kumo_session=; Max-Age=0; Path=/'] },
    })
    const kumo = client({ password: server.password })
    await expect(kumo.connect()).rejects.toThrow(/authentication required/iu)
    expect(kumo.snapshot().phase).toBe('disconnected')
    expect(server.writes).toEqual([])
  })
  it('tracks external routing and name changes, including routes outside local source caps', async () => {
    const kumo = client({ sourceLimit: 2, destinationLimit: 2 })
    await kumo.connect()
    server.route(1, 2)
    server.emit({ param_id: 'eParamID_XPT_Source2_Line_1', str_value: 'Camera B' })
    await vi.waitFor(() => {
      expect(kumo.snapshot().routes).toContainEqual({ source: 2, destination: 1 })
      expect(kumo.snapshot().sources).toContainEqual({ address: 2, name: 'Camera B Studio' })
    })
    server.route(1, 4)
    await vi.waitFor(() => {
      expect(kumo.snapshot().routes.some(({ destination }) => destination === 1)).toBe(false)
    })
    await expect(kumo.setCrosspoint({ source: 3, destination: 1 })).rejects.toThrow(/integer/iu)
    expect(server.writes).toEqual([])
  })
  it('checks current device locks even when firmware emits no lock event', async () => {
    const kumo = client()
    await kumo.connect()
    server.locks.add(1)
    await expect(kumo.setCrosspoint({ source: 2, destination: 1 })).rejects.toThrow(/locked/iu)
    expect(server.writes).toEqual([])
    server.locks.delete(1)
    await kumo.setCrosspoint({ source: 2, destination: 1 })
    expect(server.writes).toHaveLength(1)
  })
  it('does not report success when a write is rejected or readback disagrees', async () => {
    const kumo = client()
    await kumo.connect()
    server.rejectWrites = true
    await expect(kumo.setCrosspoint({ source: 2, destination: 1 })).rejects.toThrow(
      /rejected/iu,
    )
    server.rejectWrites = false
    server.ignoreWrites = true
    await expect(kumo.setCrosspoint({ source: 2, destination: 1 })).rejects.toThrow(
      /not confirmed/iu,
    )
    expect(kumo.snapshot().confirmedOperationSequence).toBe(0)
    expect(kumo.snapshot().routes).toContainEqual({ source: 1, destination: 1 })
  })
  it('accepts an empty write response only when the route readback matches', async () => {
    const kumo = client()
    await kumo.connect()
    server.replies.set('set:eParamID_XPT_Destination1_Status', { body: '' })
    await kumo.setCrosspoint({ source: 1, destination: 1 })
    expect(kumo.snapshot().confirmedOperationSequence).toBe(1)
    await expect(kumo.setCrosspoint({ source: 2, destination: 1 })).rejects.toThrow(
      /not confirmed/iu,
    )
    expect(kumo.snapshot().confirmedOperationSequence).toBe(1)
  })
  it('does not overwrite newer event feedback with an older in-flight read', async () => {
    const kumo = client()
    await kumo.connect()
    server.holdReads = true
    const read = kumo.readDestination(1)
    await vi.waitFor(() => {
      expect(server.heldReads).toHaveLength(1)
    })
    server.route(1, 3)
    await vi.waitFor(() => {
      expect(kumo.snapshot().routes).toContainEqual({ source: 3, destination: 1 })
    })
    server.heldReads.shift()?.()
    expect(await read).toEqual({ source: 3, destination: 1 })
  })
  it('fences late responses when disabled and times out stalled requests', async () => {
    const kumo = client({ requestTimeoutMs: 100 })
    await kumo.connect()
    server.holdReads = true
    await expect(kumo.readDestination(1)).rejects.toThrow(/timed out/iu)
    const pending = kumo.readDestination(2)
    const rejected = expect(pending).rejects.toThrow()
    kumo.disconnect()
    await rejected
    for (const finish of server.heldReads) finish()
    expect(kumo.snapshot()).toMatchObject({ phase: 'disconnected', routes: [], sources: [] })
  })
  it('rejects invalid device dimensions', async () => {
    server.invalidCounts = true
    await expect(client().connect()).rejects.toThrow(/integer from 1 to 64/iu)
  })
  it('uses the shared router manager for confirmed routes and reconnects with a new event session', async () => {
    const config = definition()
    const manager = new Manager()
    managers.push(manager)
    manager.reconcile([config])
    await vi.waitFor(() => {
      expect(manager.snapshots()[0]?.phase).toBe('connected')
    })
    const initialGeneration = manager.routeState(config.connectionId).version.generation
    const feedback = vi.fn()
    manager.watchConfirmedRouteTarget(
      { connectionId: config.connectionId, destination: 1, levels: [1] },
      feedback,
    )
    await manager.directRoute({ connectionId: config.connectionId, source: 3, destination: 1 })
    expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(3)
    expect(feedback.mock.lastCall?.[0]).toMatchObject({
      phase: 'ready',
      sourcesByLevel: new Map([[1, 3]]),
    })
    manager.refresh()
    await vi.waitFor(() => {
      expect(manager.snapshots()[0]?.phase).toBe('connected')
    })
    expect(server.sessions.size).toBe(2)
    expect(manager.routeState(config.connectionId).version.generation).not.toBe(
      initialGeneration,
    )
    manager.reconcile([{ ...config, enabled: false }])
    expect(manager.snapshots()).toEqual([])
    expect(() =>
      manager.directRoute({ connectionId: config.connectionId, source: 1, destination: 1 }),
    ).toThrow()
  })
  it('clears feedback after a broken event stream and resynchronizes without replaying writes', async () => {
    const config = definition({ reconnectDelayMs: 100 })
    const manager = new Manager()
    managers.push(manager)
    const phases: string[] = []
    manager.subscribe((snapshots) => {
      for (const snapshot of snapshots) phases.push(snapshot.phase)
    })
    manager.reconcile([config])
    await vi.waitFor(() => {
      expect(manager.snapshots()[0]?.phase).toBe('connected')
    })
    await vi.waitFor(() => {
      expect(server.waiting.size).toBe(1)
    })
    for (const response of server.waiting.values()) response.destroy()
    server.routes.set(1, 4)
    await vi.waitFor(() => {
      expect(server.sessions.size).toBeGreaterThan(1)
      expect(manager.snapshots()[0]?.phase).toBe('connected')
      expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(4)
    })
    expect(phases).toContain('disconnected')
    expect(server.writes).toEqual([])
  })
})
