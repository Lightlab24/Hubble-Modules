import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LiveGradeConnectionDefinitionSchema,
  liveGradeActionApplication,
  type LiveGradeApplication,
} from '../src/config.js'

import type { LiveGradeConnectionError } from '../src/livegrade-connection-manager.js'
import {
  LiveGradeConnectionManager,
  type LiveGradeManagedClientFactory,
} from '../src/livegrade-connection-manager.js'
import type {
  LiveGradeHelperClientContract,
  LiveGradeHelperResponse,
} from '../src/livegrade-helper-client.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

function connection(enabled = true, generation: 6 | 7 = 6) {
  return LiveGradeConnectionDefinitionSchema.parse({
    connectionId: CONNECTION_ID,
    type: 'livegrade',
    name: 'LiveGrade Studio',
    enabled,
    generation,
    requestTimeoutMs: 1_500,
    schemaVersion: 1,
  })
}

function ready(selected: LiveGradeHelperResponse['selected'] = null): LiveGradeHelperResponse {
  return {
    protocolVersion: 1,
    phase: 'ready',
    applicationVersion: '6.5.6',
    slots: Object.freeze([
      Object.freeze({ position: 1, menuTitle: 'A' }),
      Object.freeze({ position: 3, menuTitle: 'C' }),
    ]),
    selected,
    focusViolation: false,
    errorCode: null,
    message: null,
  }
}

function readyWithSlots(
  slots: LiveGradeHelperResponse['slots'],
  selected: LiveGradeHelperResponse['selected'] = null,
): LiveGradeHelperResponse {
  return { ...ready(), applicationVersion: '7.2', slots, selected }
}

function permissionRequired(): LiveGradeHelperResponse {
  return {
    protocolVersion: 1,
    phase: 'permission-required',
    applicationVersion: '6.5.6',
    slots: Object.freeze([]),
    selected: null,
    focusViolation: false,
    errorCode: 'accessibility_permission_required',
    message: 'Enable Hubble in System Settings → Privacy & Security → Accessibility',
  }
}

class FakeHelperClient implements LiveGradeHelperClientContract {
  readonly probe = vi.fn(() => Promise.resolve(ready()))
  readonly requestAccessibilityPermission = vi.fn(() => Promise.resolve(ready()))
  readonly selectSlot = vi.fn((input: { position: number }) =>
    Promise.resolve(
      ready({ position: input.position, menuTitle: input.position === 3 ? 'C' : 'A' }),
    ),
  )
}

function unavailableClient(): LiveGradeHelperClientContract {
  const probe = () =>
    Promise.resolve<LiveGradeHelperResponse>({
      ...permissionRequired(),
      phase: 'not-running',
      applicationVersion: null,
      errorCode: 'livegrade_not_running',
      message: 'Application is not running',
    })
  return { probe, requestAccessibilityPermission: probe, selectSlot: probe }
}

function applicationClient(client: FakeHelperClient, application: LiveGradeApplication = '6') {
  return (definition: Parameters<LiveGradeManagedClientFactory>[0]) =>
    liveGradeActionApplication('select-slot', definition) === application
      ? client
      : unavailableClient()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LiveGradeConnectionManager', () => {
  it.each(['response', 'failure'] as const)(
    're-enables while an old probe is pending and ignores its late %s',
    async (outcome) => {
      vi.useFakeTimers()
      const oldClient = new FakeHelperClient()
      const newClient = new FakeHelperClient()
      let finishProbe!: (response: LiveGradeHelperResponse) => void
      let failProbe!: (error: Error) => void
      oldClient.probe.mockReturnValueOnce(
        new Promise<LiveGradeHelperResponse>((resolve, reject) => {
          finishProbe = resolve
          failProbe = reject
        }),
      )
      let currentClient = oldClient
      const manager = new LiveGradeConnectionManager({
        createClient: (definition) => applicationClient(currentClient)(definition),
      })
      manager.reconcile([connection()])
      await vi.advanceTimersByTimeAsync(0)
      expect(oldClient.probe).toHaveBeenCalledOnce()
      manager.reconcile([connection(false)])
      expect(manager.snapshots()).toEqual([])
      manager.refresh()
      await vi.advanceTimersByTimeAsync(0)
      expect(oldClient.probe).toHaveBeenCalledOnce()

      currentClient = newClient
      manager.reconcile([connection()])
      await vi.advanceTimersByTimeAsync(0)
      expect(newClient.probe).toHaveBeenCalledOnce()
      expect(manager.snapshots()[0]).toMatchObject({
        phase: 'ready',
        definition: { enabled: true },
      })
      if (outcome === 'response') finishProbe(permissionRequired())
      else failProbe(new Error('Late helper failure'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(oldClient.probe).toHaveBeenCalledOnce()
      expect(newClient.probe).toHaveBeenCalledTimes(2)
      expect(manager.snapshots()[0]).toMatchObject({ phase: 'ready', errorCode: null })
      manager.reconcile([connection(false)])
      expect(manager.snapshots()).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(newClient.probe).toHaveBeenCalledTimes(2)
      manager.stop()
    },
  )

  it('routes four action applications through one connection with independent catalogs', async () => {
    vi.useFakeTimers()
    const applications = ['pro6', '6', '7', 'frontier'] as const
    const clients = new Map(
      applications.map((application, index) => {
        const client = new FakeHelperClient()
        const slot = { position: index + 1, menuTitle: `Camera ${application}` }
        client.probe.mockResolvedValue(readyWithSlots([slot]))
        client.selectSlot.mockResolvedValue(readyWithSlots([slot], slot))
        return [application, client] as const
      }),
    )
    const manager = new LiveGradeConnectionManager({
      createClient: (definition) => {
        const client = clients.get(liveGradeActionApplication('select-slot', definition))
        if (client === undefined) throw new Error('Fixture LiveGrade application is missing')
        return client
      },
    })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.snapshots()).toHaveLength(1)
    expect(manager.snapshots()[0]?.applications).toHaveLength(4)
    for (const [index, application] of applications.entries()) {
      await expect(
        manager.selectSlot(CONNECTION_ID, {
          application,
          position: null,
          query: `Camera ${application}`,
        }),
      ).resolves.toEqual({ position: index + 1, menuTitle: `Camera ${application}` })
    }
    for (const client of clients.values()) expect(client.selectSlot).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('rejects an unavailable selected app even when another app is ready', async () => {
    vi.useFakeTimers()
    const studio = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({ createClient: applicationClient(studio) })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.snapshots()[0]?.phase).toBe('ready')
    await expect(
      manager.selectSlot(CONNECTION_ID, { application: 'frontier', position: 3, query: 'C' }),
    ).rejects.toMatchObject({ code: 'livegrade_not_running' })
    expect(studio.selectSlot).not.toHaveBeenCalled()
    manager.stop()
  })
  it('routes independent LG7 and Frontier catalogs and selections to their configured clients', async () => {
    vi.useFakeTimers()
    const standard = new FakeHelperClient()
    const frontier = new FakeHelperClient()
    const frontierId = '22222222-2222-4222-8222-222222222222'
    const manager = new LiveGradeConnectionManager({
      createClient: (definition) => (definition.edition === 'frontier' ? frontier : standard),
    })
    manager.reconcile([
      connection(true, 7),
      LiveGradeConnectionDefinitionSchema.parse({
        ...connection(true, 7),
        connectionId: frontierId,
        name: 'Frontier',
        edition: 'frontier',
      }),
    ])
    await vi.advanceTimersByTimeAsync(0)
    await manager.selectSlot(frontierId, { position: 3, query: 'C' })
    expect(frontier.selectSlot).toHaveBeenCalledOnce()
    expect(standard.selectSlot).not.toHaveBeenCalled()
    await manager.selectSlot(CONNECTION_ID, { position: 1, query: 'A' })
    expect(standard.selectSlot).toHaveBeenCalledOnce()
    expect(frontier.selectSlot).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('replaces the client and ignores a late catalog when changing the application', async () => {
    vi.useFakeTimers()
    const standard = new FakeHelperClient()
    const frontier = new FakeHelperClient()
    let finishProbe: (response: LiveGradeHelperResponse) => void = () => {
      throw new Error('Probe not started')
    }
    const late = new Promise<LiveGradeHelperResponse>((resolve) => {
      finishProbe = resolve
    })
    standard.probe.mockReturnValueOnce(late)
    frontier.probe.mockResolvedValue({ ...ready(), applicationVersion: '7.2-beauty-2' })
    const manager = new LiveGradeConnectionManager({
      createClient: (definition) => (definition.edition === 'frontier' ? frontier : standard),
    })
    manager.reconcile([connection(true, 7)])
    await vi.advanceTimersByTimeAsync(0)
    const queued = manager
      .selectSlot(CONNECTION_ID, { position: 3, query: 'C' })
      .catch((error: unknown) => error)
    manager.reconcile([{ ...connection(true, 7), edition: 'frontier' }])
    await vi.advanceTimersByTimeAsync(0)
    finishProbe({ ...ready(), applicationVersion: '7.2.2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await queued).toMatchObject({ code: 'livegrade_unconfigured' })
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      applicationVersion: '7.2-beauty-2',
    })
    await manager.selectSlot(CONNECTION_ID, { position: 3, query: 'C' })
    expect(frontier.selectSlot).toHaveBeenCalledOnce()
    expect(standard.selectSlot).not.toHaveBeenCalled()
    manager.stop()
  })

  it('silently probes the first enabled LiveGrade connection without requesting Accessibility', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })

    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)

    expect(client.probe).toHaveBeenCalledOnce()
    expect(client.probe).toHaveBeenCalledWith(1_500)
    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      applicationVersion: '6.5.6',
    })
    manager.stop()
  })

  it('silently probes every enabled LiveGrade generation without requesting Accessibility', async () => {
    vi.useFakeTimers()
    const studioClient = new FakeHelperClient()
    const liveGrade7Client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: (definition) => {
        const application = liveGradeActionApplication('select-slot', definition)
        return definition.connectionId === CONNECTION_ID
          ? application === '6'
            ? studioClient
            : unavailableClient()
          : application === '7'
            ? liveGrade7Client
            : unavailableClient()
      },
    })
    const liveGrade7 = LiveGradeConnectionDefinitionSchema.parse({
      ...connection(true, 7),
      connectionId: '22222222-2222-4222-8222-222222222222',
      name: 'LiveGrade 7',
    })

    manager.reconcile([connection(), liveGrade7])
    await vi.advanceTimersByTimeAsync(0)

    expect(studioClient.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(liveGrade7Client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(studioClient.probe).toHaveBeenCalledOnce()
    expect(liveGrade7Client.probe).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('publishes missing permission and recognizes a later grant on the normal refresh', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    client.probe.mockResolvedValueOnce(permissionRequired()).mockResolvedValueOnce(ready())
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })

    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'permission-required',
      errorCode: 'accessibility_permission_required',
    })
    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(client.probe).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(client.probe).toHaveBeenCalledTimes(2)
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      errorCode: null,
    })
    manager.stop()
  })

  it('keeps application recovery non-prompting and scoped to a silent selected-connection probe', async () => {
    vi.useFakeTimers()
    const studioClient = new FakeHelperClient()
    const liveGrade7Client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: (definition) => {
        const application = liveGradeActionApplication('select-slot', definition)
        return definition.connectionId === CONNECTION_ID
          ? application === '6'
            ? studioClient
            : unavailableClient()
          : application === '7'
            ? liveGrade7Client
            : unavailableClient()
      },
    })
    const liveGrade7 = LiveGradeConnectionDefinitionSchema.parse({
      ...connection(true, 7),
      connectionId: '22222222-2222-4222-8222-222222222222',
      name: 'LiveGrade 7',
    })
    manager.reconcile([connection(), liveGrade7])
    await vi.advanceTimersByTimeAsync(0)

    await manager.requestAccessibilityPermission(CONNECTION_ID)

    expect(studioClient.probe).toHaveBeenCalledTimes(2)
    expect(studioClient.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(liveGrade7Client.requestAccessibilityPermission).not.toHaveBeenCalled()
    manager.stop()
  })

  it('probes enabled Studio connections and publishes the ordered A-Z catalog', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
      pollIntervalMs: 3_000,
    })

    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)

    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(client.probe).toHaveBeenCalledWith(1_500)
    expect(manager.snapshots()[0]).toMatchObject({
      phase: 'ready',
      applicationVersion: '6.5.6',
      slots: [
        { position: 1, menuTitle: 'A' },
        { position: 3, menuTitle: 'C' },
      ],
    })
    manager.stop()
  })

  it('uses a ten-second default scan and publishes a changed slot list on the next scan', async () => {
    vi.useFakeTimers()
    const initialSlots = Object.freeze([Object.freeze({ position: 1, menuTitle: 'A' })])
    const changedSlots = Object.freeze([
      ...initialSlots,
      Object.freeze({ position: 2, menuTitle: 'B' }),
    ])
    const client = new FakeHelperClient()
    client.probe
      .mockResolvedValueOnce(readyWithSlots(initialSlots))
      .mockResolvedValueOnce(readyWithSlots(changedSlots))
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })

    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)
    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(client.probe).toHaveBeenCalledTimes(1)
    expect(manager.snapshots()[0]?.slots).toEqual(initialSlots)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(client.probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.probe).toHaveBeenCalledTimes(2)
    expect(manager.snapshots()[0]?.slots).toEqual(changedSlots)
    manager.stop()
  })

  it('refreshes immediately with a silent probe and does not repeat the Accessibility prompt', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)
    manager.refresh()
    await vi.advanceTimersByTimeAsync(0)

    expect(client.requestAccessibilityPermission).not.toHaveBeenCalled()
    expect(client.probe).toHaveBeenCalledTimes(2)
    manager.stop()
  })

  it('serializes selection and requires the helper to confirm the exact slot', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)

    await manager.selectSlot(CONNECTION_ID, { position: 3, query: 'C' })

    expect(client.selectSlot).toHaveBeenCalledWith({
      position: 3,
      timeoutMs: 1_500,
    })
    manager.stop()
  })

  it('resolves a LiveGrade 7 letter or number against the current menu order', async () => {
    vi.useFakeTimers()
    const slots = Object.freeze([
      Object.freeze({ position: 1, menuTitle: '[1] A - In 1' }),
      Object.freeze({ position: 12, menuTitle: '[12] L - In 12' }),
    ])
    const client = new FakeHelperClient()
    client.probe.mockResolvedValue(readyWithSlots(slots))
    client.selectSlot.mockImplementation(({ position }: { position: number }) =>
      Promise.resolve(
        readyWithSlots(slots, slots.find((slot) => slot.position === position) ?? null),
      ),
    )
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '7'),
    })
    manager.reconcile([connection(true, 7)])
    await vi.advanceTimersByTimeAsync(0)

    await expect(
      manager.selectSlot(CONNECTION_ID, { position: null, query: 'L' }),
    ).resolves.toEqual({ position: 12, menuTitle: '[12] L - In 12' })
    await expect(
      manager.selectSlot(CONNECTION_ID, { position: null, query: '12' }),
    ).resolves.toEqual({ position: 12, menuTitle: '[12] L - In 12' })
    expect(client.selectSlot).toHaveBeenNthCalledWith(1, { position: 12, timeoutMs: 1_500 })
    expect(client.selectSlot).toHaveBeenNthCalledWith(2, { position: 12, timeoutMs: 1_500 })
    manager.stop()
  })

  it('refreshes a changed LiveGrade 7 menu once before declaring a query unavailable', async () => {
    vi.useFakeTimers()
    const initialSlots = Object.freeze([
      Object.freeze({ position: 1, menuTitle: '[1] A - In 1' }),
    ])
    const refreshedSlots = Object.freeze([
      ...initialSlots,
      Object.freeze({ position: 2, menuTitle: '[2] B - In 2' }),
    ])
    const client = new FakeHelperClient()
    client.probe
      .mockResolvedValueOnce(readyWithSlots(initialSlots))
      .mockResolvedValueOnce(readyWithSlots(refreshedSlots))
    client.selectSlot.mockResolvedValueOnce(
      readyWithSlots(refreshedSlots, refreshedSlots[1] ?? null),
    )
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '7'),
    })
    manager.reconcile([connection(true, 7)])
    await vi.advanceTimersByTimeAsync(0)

    await expect(
      manager.selectSlot(CONNECTION_ID, { position: null, query: 'B' }),
    ).resolves.toEqual({ position: 2, menuTitle: '[2] B - In 2' })
    expect(client.probe).toHaveBeenCalledTimes(2)
    expect(client.selectSlot).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('never guesses when a LiveGrade 7 alias is ambiguous', async () => {
    vi.useFakeTimers()
    const slots = Object.freeze([
      Object.freeze({ position: 1, menuTitle: 'A - Main' }),
      Object.freeze({ position: 2, menuTitle: 'A - Backup' }),
    ])
    const client = new FakeHelperClient()
    client.probe.mockResolvedValue(readyWithSlots(slots))
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '7'),
    })
    manager.reconcile([connection(true, 7)])
    await vi.advanceTimersByTimeAsync(0)

    await expect(
      manager.selectSlot(CONNECTION_ID, { position: null, query: 'A' }),
    ).rejects.toMatchObject({ code: 'livegrade_slot_ambiguous' })
    expect(client.probe).toHaveBeenCalledTimes(2)
    expect(client.selectSlot).not.toHaveBeenCalled()
    manager.stop()
  })

  it('surfaces focus violations and never retries with a foreground fallback', async () => {
    vi.useFakeTimers()
    const client = new FakeHelperClient()
    client.selectSlot.mockResolvedValueOnce({
      ...ready({ position: 3, menuTitle: 'C' }),
      phase: 'error',
      focusViolation: true,
      errorCode: 'livegrade_focus_violation',
      message: 'LiveGrade Studio became frontmost while switching slots',
    })
    const manager = new LiveGradeConnectionManager({
      createClient: applicationClient(client, '6'),
    })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)

    await expect(
      manager.selectSlot(CONNECTION_ID, { position: 3, query: 'C' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiveGradeConnectionError>>({
        code: 'livegrade_focus_violation',
      }),
    )
    expect(client.selectSlot).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('removes disabled connections and rejects their actions independently', async () => {
    vi.useFakeTimers()
    const manager = new LiveGradeConnectionManager({
      createClient: () => new FakeHelperClient(),
    })
    manager.reconcile([connection()])
    await vi.advanceTimersByTimeAsync(0)
    manager.reconcile([connection(false)])

    expect(manager.snapshots()).toEqual([])
    await expect(
      manager.selectSlot(CONNECTION_ID, { position: 1, query: 'A' }),
    ).rejects.toMatchObject({
      code: 'livegrade_unconfigured',
    })
    manager.stop()
  })
})
