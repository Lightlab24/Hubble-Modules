import net from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionDefinitionSchema } from '../src/config.js'
import { RossUltrixOgpConnectionManager } from '../src/ross-ultrix-ogp-connection-manager.js'

const CONNECTION_ID = '00000000-0000-4000-8000-000000000301'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
  vi.restoreAllMocks()
})

/** A connection saved before the Simulated setting existed. */
const saved = {
  connectionId: CONNECTION_ID,
  type: 'ross-ultrix-ogp',
  name: 'Ultrix Main',
  enabled: true,
  host: '10.20.70.50',
  port: 5_254,
  sourceLimit: 152,
  destinationLimit: 152,
  levels: 17,
  requestTimeoutMs: 1_000,
  reconnectDelayMs: 2_000,
  schemaVersion: 1,
}

it('reads a connection saved before Simulated existed as a real Ultrix, unchanged', () => {
  expect(ConnectionDefinitionSchema.parse(saved)).toEqual(saved)
})

it('needs a host unless the connection is simulated', () => {
  expect(() => ConnectionDefinitionSchema.parse({ ...saved, host: '' })).toThrow(
    'router host must be a hostname or IP address',
  )
  expect(() =>
    ConnectionDefinitionSchema.parse({ ...saved, simulated: false, host: ' ' }),
  ).toThrow('router host must be a hostname or IP address')
  expect(
    ConnectionDefinitionSchema.parse({ ...saved, simulated: true, host: '' }),
  ).toMatchObject({ simulated: true, host: '' })
  const { host: _host, ...withoutHost } = saved
  expect(ConnectionDefinitionSchema.parse({ ...withoutHost, simulated: true }).host).toBe('')
})

it('runs a simulated Ultrix in the worker: it connects, routes and confirms without the network', async () => {
  const connect = vi.spyOn(net.Socket.prototype, 'connect')
  const factory = vi.fn(() => {
    throw new Error('A simulated router must not create a network client')
  })
  const manager = new RossUltrixOgpConnectionManager(factory)
  cleanup.push(() => {
    manager.stop()
  })
  manager.reconcile([ConnectionDefinitionSchema.parse({ ...saved, simulated: true, host: '' })])
  await vi.waitFor(() => expect(manager.snapshots()[0]?.phase).toBe('connected'))
  expect(factory).not.toHaveBeenCalled()
  const snapshot = manager.snapshots()[0]!
  expect(snapshot.lastError).toBeNull()
  expect(snapshot.sourceCatalog[0]?.label).toBe('Source 1')
  expect(snapshot.sourceCatalog).toHaveLength(saved.sourceLimit)
  expect(manager.routeState(CONNECTION_ID).phase).toBe('ready')

  const watched = vi.fn()
  manager.watchConfirmedRouteTarget(
    { connectionId: CONNECTION_ID, destination: 5, levels: [1, 2] },
    watched,
  )
  await vi.waitFor(() =>
    expect(watched).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'ready',
        sourcesByLevel: new Map([
        [1, 5],
        [2, 5],
      ]),
      }),
    ),
  )
  await manager.directRoute({ connectionId: CONNECTION_ID, source: 9, destination: 5, levels: [2] })
  expect(manager.snapshots()[0]?.routes.routes.get(5)?.get(2)).toBe(9)
  await vi.waitFor(() =>
    expect(watched).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'ready',
        sourcesByLevel: new Map([
        [1, 5],
        [2, 9],
      ]),
      }),
    ),
  )
  expect(connect).not.toHaveBeenCalled()
})
