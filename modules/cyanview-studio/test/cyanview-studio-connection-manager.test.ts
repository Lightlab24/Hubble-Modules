import { describe, expect, it, vi } from 'vitest'
import {
  CyanViewStudioConnectionDefinitionSchema,
  type CyanViewStudioConnectionDefinition,
} from '../src/config.js'

import {
  CyanViewStudioConnectionManager,
  type ManagedCyanViewStudioConnectionSnapshot,
} from '../src/cyanview-studio-connection-manager.js'
import {
  CyanViewStudioHttpClientError,
  type CyanViewStudioHttpClientContract,
} from '../src/cyanview-studio-http-client.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

describe('CyanViewStudioConnectionManager', () => {
  it('checks each newly enabled endpoint once without polling and publishes immutable status', async () => {
    const client = new FakeClient()
    const manager = new CyanViewStudioConnectionManager({
      createClient: () => client,
      now: () => new Date('2026-08-06T01:02:03.000Z'),
    })
    const observed: (readonly ManagedCyanViewStudioConnectionSnapshot[])[] = []
    manager.subscribe(() => {
      throw new Error('broken observer')
    })
    manager.subscribe((snapshots) => observed.push(snapshots))

    manager.reconcile([connection()])
    await flush()

    expect(client.probe).toHaveBeenCalledOnce()
    expect(manager.snapshots()).toEqual([
      {
        definition: connection(),
        phase: 'ready',
        apiVersion: '1.7.2',
        supportsFeedNumber: true,
        supportsFeedId: true,
        lastEventAt: '2026-08-06T01:02:03.000Z',
        lastError: null,
      },
    ])
    manager.reconcile([connection({ name: 'Renamed CyanView' })])
    await flush()
    expect(client.probe).toHaveBeenCalledOnce()
    expect(observed.length).toBeGreaterThan(1)
    manager.stop()
  })

  it('does not gate actions on a failed probe and lets a successful POST restore ready', async () => {
    const client = new FakeClient()
    client.probe.mockRejectedValueOnce(
      new CyanViewStudioHttpClientError('unavailable', 'private endpoint detail'),
    )
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()

    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'unavailable',
      apiVersion: null,
      supportsFeedNumber: null,
      supportsFeedId: null,
      lastError: 'CyanView Studio is unavailable',
    })

    await expect(manager.selectFeed(CONNECTION_ID, 'CAM-A')).resolves.toBeUndefined()
    expect(client.selectFeed).toHaveBeenCalledWith('CAM-A')
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      apiVersion: null,
      supportsFeedNumber: null,
      supportsFeedId: null,
      lastError: null,
    })

    await expect(manager.selectFeedByFeedId(CONNECTION_ID, 15)).resolves.toBeUndefined()
    expect(client.selectFeedByFeedId).toHaveBeenCalledWith(15)
    manager.stop()
  })

  it('rejects a feed-ID selection queued behind a probe that reports known unsupported', async () => {
    const probe = deferred<{
      apiVersion: string
      supportsFeedId: boolean
      supportsFeedNumber: boolean
    }>()
    const client = new FakeClient()
    client.probe.mockImplementationOnce(() => probe.promise)
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    const observed: (readonly ManagedCyanViewStudioConnectionSnapshot[])[] = []
    manager.subscribe((snapshots) => observed.push(snapshots))

    manager.reconcile([connection()])
    const selection = manager.selectFeedByFeedId(CONNECTION_ID, 15)
    await flush()
    expect(client.selectFeedByFeedId).not.toHaveBeenCalled()

    probe.resolve({
      apiVersion: 'camera-only',
      supportsFeedNumber: false,
      supportsFeedId: false,
    })
    await expect(selection).rejects.toMatchObject({ code: 'cyanview_feed_id_unsupported' })
    expect(client.selectFeedByFeedId).not.toHaveBeenCalled()
    expect(observed.some((snapshots) => snapshots[0]?.supportsFeedId === false)).toBe(true)
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      supportsFeedNumber: false,
      supportsFeedId: false,
      lastError: null,
    })
    manager.stop()
  })

  it('queues feed numbers behind the current API probe without reinterpreting legacy IDs', async () => {
    const probe = deferred<{
      apiVersion: string
      supportsFeedId: boolean
      supportsFeedNumber: boolean
    }>()
    const client = new FakeClient()
    client.probe.mockImplementationOnce(() => probe.promise)
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    const selection = manager.selectFeedByNumber(CONNECTION_ID, 2)
    expect(client.selectFeedByNumber).not.toHaveBeenCalled()
    probe.resolve({ apiVersion: '1.0.0', supportsFeedId: false, supportsFeedNumber: true })
    await expect(selection).resolves.toBeUndefined()
    expect(client.selectFeedByNumber).toHaveBeenCalledExactlyOnceWith(2)
    await expect(manager.selectFeedByFeedId(CONNECTION_ID, 15)).rejects.toMatchObject({
      code: 'cyanview_feed_id_unsupported',
    })
    expect(client.selectFeedByFeedId).not.toHaveBeenCalled()
    expect(client.selectFeedByNumber).toHaveBeenCalledOnce()
    expect(manager.snapshots()[0]).toMatchObject({ phase: 'ready', lastError: null })
    manager.stop()
  })

  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53])(
    'rejects invalid feed number %s without sending it',
    async (value) => {
      const client = new FakeClient()
      const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
      manager.reconcile([connection()])
      await expect(manager.selectFeedByNumber(CONNECTION_ID, value)).rejects.toMatchObject({
        code: 'cyanview_invalid_request',
      })
      expect(client.selectFeedByNumber).not.toHaveBeenCalled()
      manager.stop()
    },
  )

  it('reports unsupported feed numbers without making a healthy older API unavailable', async () => {
    const client = new FakeClient()
    client.probe.mockResolvedValue({
      apiVersion: 'old',
      supportsFeedId: true,
      supportsFeedNumber: false,
    })
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await expect(manager.selectFeedByNumber(CONNECTION_ID, 1)).rejects.toMatchObject({
      code: 'cyanview_feed_number_unsupported',
    })
    expect(client.selectFeedByNumber).not.toHaveBeenCalled()
    expect(manager.snapshots()[0]).toMatchObject({ phase: 'ready', lastError: null })
    manager.stop()
  })

  it('serializes commands FIFO per connection', async () => {
    const first = deferred<void>()
    const client = new FakeClient()
    client.selectFeed
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve())
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()

    const firstSelection = manager.selectFeed(CONNECTION_ID, 'CAM-A')
    const secondSelection = manager.selectFeed(CONNECTION_ID, 'CAM-B')
    await flush()
    expect(client.selectFeed.mock.calls).toEqual([['CAM-A']])

    first.resolve()
    await expect(firstSelection).resolves.toBeUndefined()
    await expect(secondSelection).resolves.toBeUndefined()
    expect(client.selectFeed.mock.calls).toEqual([['CAM-A'], ['CAM-B']])
    manager.stop()
  })

  it('serializes camera and feed-ID selections through the same FIFO', async () => {
    const first = deferred<void>()
    const client = new FakeClient()
    client.selectFeed.mockImplementationOnce(() => first.promise)
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()

    const cameraSelection = manager.selectFeed(CONNECTION_ID, 'CAM-A')
    const feedSelection = manager.selectFeedByFeedId(CONNECTION_ID, 15)
    await flush()
    expect(client.selectFeed.mock.calls).toEqual([['CAM-A']])
    expect(client.selectFeedByFeedId).not.toHaveBeenCalled()

    first.resolve()
    await expect(cameraSelection).resolves.toBeUndefined()
    await expect(feedSelection).resolves.toBeUndefined()
    expect(client.selectFeedByFeedId).toHaveBeenCalledWith(15)
    manager.stop()
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects malformed feed ID %s before enqueueing or calling the client',
    async (feedId) => {
      const client = new FakeClient()
      const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
      manager.reconcile([connection()])
      await flush()

      await expect(manager.selectFeedByFeedId(CONNECTION_ID, feedId)).rejects.toMatchObject({
        code: 'cyanview_unconfigured',
      })
      expect(client.selectFeedByFeedId).not.toHaveBeenCalled()
      manager.stop()
    },
  )

  it('invalidates queued-before-start work on disable while allowing an in-flight POST to settle', async () => {
    const active = deferred<void>()
    const client = new FakeClient()
    client.selectFeed.mockImplementationOnce(() => active.promise)
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()

    const sent = manager.selectFeed(CONNECTION_ID, 'CAM-A')
    const queued = manager.selectFeedByFeedId(CONNECTION_ID, 15)
    await flush()
    expect(client.selectFeed).toHaveBeenCalledOnce()

    manager.reconcile([connection({ enabled: false })])
    await expect(queued).rejects.toMatchObject({ code: 'cyanview_unconfigured' })
    expect(manager.snapshots()).toEqual([])

    active.resolve()
    await expect(sent).resolves.toBeUndefined()
    expect(client.selectFeed).toHaveBeenCalledOnce()
    expect(client.selectFeedByFeedId).not.toHaveBeenCalled()
    manager.stop()
  })

  it('replaces endpoint clients, invalidates old queued work, and checks the replacement', async () => {
    const oldProbe = deferred<{
      apiVersion: string
      supportsFeedId: boolean
      supportsFeedNumber: boolean
    }>()
    const oldClient = new FakeClient()
    oldClient.probe.mockImplementationOnce(() => oldProbe.promise)
    const replacementProbe = deferred<{
      apiVersion: string
      supportsFeedId: boolean
      supportsFeedNumber: boolean
    }>()
    const replacement = new FakeClient()
    replacement.probe.mockImplementationOnce(() => replacementProbe.promise)
    const clients = [oldClient, replacement]
    const manager = new CyanViewStudioConnectionManager({
      createClient: () => clients.shift()!,
    })
    manager.reconcile([connection()])
    const queued = manager.selectFeed(CONNECTION_ID, 'CAM-A')

    manager.reconcile([connection({ port: 4174 })])
    await expect(queued).rejects.toMatchObject({ code: 'cyanview_unconfigured' })
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'checking',
      supportsFeedNumber: null,
      supportsFeedId: null,
    })
    replacementProbe.resolve({
      apiVersion: '1.7.2',
      supportsFeedNumber: true,
      supportsFeedId: true,
    })
    await flush()
    expect(replacement.probe).toHaveBeenCalledOnce()
    expect(manager.snapshots()[0]?.definition.port).toBe(4174)

    oldProbe.resolve({ apiVersion: 'old', supportsFeedNumber: false, supportsFeedId: false })
    await flush()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      apiVersion: '1.7.2',
      supportsFeedNumber: true,
      supportsFeedId: true,
    })
    manager.stop()
  })

  it.each([
    ['camera_not_found', 'cyanview_camera_not_found'],
    ['feed_not_found', 'cyanview_feed_not_found'],
    ['invalid_request', 'cyanview_invalid_request'],
  ] as const)(
    'keeps %s action-local without degrading ready state',
    async (clientCode, code) => {
      const client = new FakeClient()
      const error = new CyanViewStudioHttpClientError(clientCode, 'private response detail')
      if (clientCode === 'feed_not_found')
        client.selectFeedByFeedId.mockRejectedValueOnce(error)
      else client.selectFeed.mockRejectedValueOnce(error)
      const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
      manager.reconcile([connection()])
      await flush()
      const before = manager.snapshots()[0]

      const result =
        clientCode === 'feed_not_found'
          ? manager.selectFeedByFeedId(CONNECTION_ID, 15)
          : manager.selectFeed(CONNECTION_ID, 'CAM-A')
      await expect(result).rejects.toMatchObject({ code })
      expect(manager.snapshots()[0]).toEqual(before)
      manager.stop()
    },
  )

  it('runs exactly one probe for every explicit refresh', async () => {
    const client = new FakeClient()
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()

    manager.refresh()
    await flush()

    expect(client.probe).toHaveBeenCalledTimes(2)
    manager.stop()
  })

  it('resets capability while refreshing and leaves it unknown after a failed probe', async () => {
    const client = new FakeClient()
    const manager = new CyanViewStudioConnectionManager({ createClient: () => client })
    manager.reconcile([connection()])
    await flush()
    expect(manager.snapshots()[0]?.supportsFeedId).toBe(true)

    const refresh = deferred<{
      apiVersion: string
      supportsFeedId: boolean
      supportsFeedNumber: boolean
    }>()
    client.probe.mockImplementationOnce(() => refresh.promise)
    manager.refresh()
    await flush()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'checking',
      supportsFeedNumber: null,
      supportsFeedId: null,
    })

    refresh.reject(new CyanViewStudioHttpClientError('unavailable', 'private refresh detail'))
    await flush()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'unavailable',
      supportsFeedNumber: null,
      supportsFeedId: null,
    })

    await expect(manager.selectFeedByFeedId(CONNECTION_ID, 15)).resolves.toBeUndefined()
    expect(client.selectFeedByFeedId).toHaveBeenCalledWith(15)
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      supportsFeedNumber: null,
      supportsFeedId: null,
    })
    manager.stop()
  })
})

class FakeClient implements CyanViewStudioHttpClientContract {
  readonly probe = vi.fn(() =>
    Promise.resolve({ apiVersion: '1.7.2', supportsFeedNumber: true, supportsFeedId: true }),
  )
  readonly selectFeed = vi.fn<(cameraId: string) => Promise<void>>(() => Promise.resolve())
  readonly selectFeedByNumber = vi.fn<(feedNumber: number) => Promise<void>>(() =>
    Promise.resolve(),
  )
  readonly selectFeedByFeedId = vi.fn<(feedId: number) => Promise<void>>(() =>
    Promise.resolve(),
  )
}

function connection(
  overrides: Partial<CyanViewStudioConnectionDefinition> = {},
): CyanViewStudioConnectionDefinition {
  return CyanViewStudioConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'cyanview-studio',
    name: 'CyanView Studio',
    enabled: true,
    host: '127.0.0.1',
    port: 4173,
    requestTimeoutMs: 1_500,
    schemaVersion: 1,
    ...overrides,
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
