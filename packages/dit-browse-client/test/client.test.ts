import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import {
  DitBrowseClient,
  DitBrowseCommandError,
  type DitBrowseClientClock,
} from '../src/client.js'
import {
  DIT_BROWSE_CAPABILITIES,
  DIT_BROWSE_REQUIRED_CAPABILITIES,
  type DitBrowseStatus,
} from '../src/protocol.js'

describe('DitBrowseClient', () => {
  it.each(['connecting', 'handshaking'] as const)(
    'recovers from a silent %s session without restarting',
    async (phase) => {
      const fixture = createFixture()
      fixture.client.start()
      const first = fixture.sockets[0]
      if (!first) throw new Error('Expected initial socket')
      if (phase === 'handshaking') first.open()
      fixture.clock.advanceBy(phase === 'connecting' ? 10_000 : 3_500)
      expect(first.readyState).toBe(WebSocket.CLOSED)
      expect(fixture.client.snapshot.lastError).toMatch(/timed out/iu)
      fixture.clock.advanceBy(1_000)
      const second = fixture.sockets.at(-1)
      if (!second) throw new Error('Expected replacement socket')
      expect(second).not.toBe(first)
      second.open()
      second.receive(serverHello())
      const refresh = second.jsonSent().at(-1)
      if (!isCommand(refresh)) throw new Error('Expected fresh status read')
      second.receive(success(refresh.requestId, status(1)))
      await settleCommandQueue()
      expect(fixture.client.snapshot).toMatchObject({ phase: 'connected', lastError: null })
      fixture.client.stop()
    },
  )

  it('reconnects an unresponsive established session without replaying queued commands', async () => {
    const fixture = await createConnectedFixture()
    const first = fixture.sockets[0]
    if (!first) throw new Error('Expected initial socket')
    const command = fixture.client.focusCamera(7)
    const queued = fixture.client.focusCamera(8)
    const timedOut = expect(command).rejects.toMatchObject({ code: 'timeout' })
    const cancelled = expect(queued).rejects.toMatchObject({ code: 'disconnected' })
    fixture.clock.advanceBy(3_500)
    fixture.clock.advanceBy(1_000)
    const second = fixture.sockets.at(-1)
    if (!second) throw new Error('Expected replacement socket')
    expect(second).not.toBe(first)
    second.open()
    second.receive(serverHello())
    await timedOut
    await cancelled
    await settleCommandQueue()
    expect(second.jsonSent().filter(isCommand)).toEqual([
      expect.objectContaining({ command: { type: 'status' } }),
    ])
    fixture.client.stop()
  })

  it.each(['error', 'invalid-message'] as const)(
    'recovers after %s even when the peer never closes',
    async (failure) => {
      const fixture = await createConnectedFixture()
      const first = fixture.sockets[0]
      if (!first) throw new Error('Expected initial socket')
      if (failure === 'error') first.emit('error', new Error('Transport failed'))
      else first.receiveRaw('{invalid')
      expect(fixture.client.snapshot.phase).toBe('disconnected')
      expect(first.readyState).toBe(WebSocket.CLOSED)
      fixture.clock.advanceBy(1_000)
      const second = fixture.sockets.at(-1)
      if (!second) throw new Error('Expected replacement socket')
      second.open()
      first.receive(serverHello())
      expect(fixture.client.snapshot.phase).toBe('handshaking')
      second.receive(serverHello())
      const refresh = second.jsonSent().at(-1)
      if (!isCommand(refresh)) throw new Error('Expected fresh status read')
      second.receive(success(refresh.requestId, status(1)))
      await settleCommandQueue()
      expect(fixture.client.snapshot).toMatchObject({ phase: 'connected', lastError: null })
      fixture.client.stop()
    },
  )

  it.each([true, false])(
    'sends only showGrid and preserves expansion=%s on repeated presses',
    async (expansionEnabled) => {
      const fixture = await createConnectedFixture()
      const socket = fixture.sockets[0]
      if (socket === undefined) throw new Error('Missing connected socket')
      const before = socket.jsonSent().length
      for (let press = 0; press < 2; press += 1) {
        const pending = fixture.client.showGrid()
        await settleCommandQueue()
        const command = socket.jsonSent().at(-1)
        expect(command).toMatchObject({ command: { type: 'showGrid' } })
        if (!isCommand(command)) throw new Error('Expected command')
        socket.receive(
          success(command.requestId, { ...status(1), expansionEnabled, focusMode: false }),
        )
        await expect(pending).resolves.toMatchObject({ expansionEnabled, focusMode: false })
      }
      expect(socket.jsonSent().slice(before)).toMatchObject([
        { command: { type: 'showGrid' } },
        { command: { type: 'showGrid' } },
      ])
      fixture.client.stop()
    },
  )

  it.each([
    [1, [4, 1, 2], 2],
    [2, [1, 2, 4], 4],
    [4, [1, 2, 4], 1],
    [1, [1], 1],
    [3, [1, 4], 4],
  ] as const)(
    'cycles from %s through %j to %s using fresh status',
    async (active, workspaces, next) => {
      const fixture = await createConnectedFixture()
      const socket = fixture.sockets[0]
      if (socket === undefined) throw new Error('Expected socket')
      const pending = fixture.client.cycleWorkspaces()
      const refresh = socket.jsonSent().at(-1)
      expect(refresh).toMatchObject({ command: { type: 'status' } })
      if (!isCommand(refresh)) throw new Error('Expected status command')
      const current = {
        ...status(1),
        activeWorkspaceNumber: active,
        workspaceNumbers: workspaces,
        expansionEnabled: false,
      }
      socket.receive(success(refresh.requestId, current))
      await settleCommandQueue()
      const change = socket.jsonSent().at(-1)
      expect(change).toMatchObject({
        command: { type: 'switchWorkspace', workspaceNumber: next },
      })
      if (!isCommand(change)) throw new Error('Expected workspace command')
      socket.receive(
        success(change.requestId, {
          ...current,
          activeWorkspaceNumber: next,
          focusMode: false,
        }),
      )
      await expect(pending).resolves.toMatchObject({
        activeWorkspaceNumber: next,
        expansionEnabled: false,
        focusMode: false,
      })
    },
  )

  it('keeps both halves of rapid cycles together and uses the latest list for each press', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (socket === undefined) throw new Error('Expected socket')
    const first = fixture.client.cycleWorkspaces()
    const beforeSecond = socket.sent.length
    const second = fixture.client.cycleWorkspaces()
    expect(socket.sent).toHaveLength(beforeSecond)
    for (const [current, list, next] of [
      [1, [1, 2, 4], 2],
      [4, [1, 4], 1],
    ] as const) {
      const refresh = socket.jsonSent().at(-1)
      expect(refresh).toMatchObject({ command: { type: 'status' } })
      if (!isCommand(refresh)) throw new Error('Expected status command')
      socket.receive(
        success(refresh.requestId, {
          ...status(1),
          activeWorkspaceNumber: current,
          workspaceNumbers: list,
        }),
      )
      await settleCommandQueue()
      const change = socket.jsonSent().at(-1)
      expect(change).toMatchObject({
        command: { type: 'switchWorkspace', workspaceNumber: next },
      })
      if (!isCommand(change)) throw new Error('Expected workspace command')
      socket.receive(
        success(change.requestId, {
          ...status(1),
          activeWorkspaceNumber: next,
          workspaceNumbers: list,
          focusMode: false,
        }),
      )
      await settleCommandQueue()
    }
    await expect(first).resolves.toMatchObject({ activeWorkspaceNumber: 2 })
    await expect(second).resolves.toMatchObject({ activeWorkspaceNumber: 1 })
  })

  it.each([
    {},
    { activeWorkspaceNumber: 1 },
    { activeWorkspaceNumber: 1, workspaceNumbers: [] },
    { workspaceNumbers: [1, 2] },
  ])(
    'refuses to guess a target when workspace status is incomplete: %j',
    async (workspaceStatus) => {
      const fixture = await createConnectedFixture()
      const socket = fixture.sockets[0]
      if (socket === undefined) throw new Error('Expected socket')
      const pending = fixture.client.cycleWorkspaces()
      const refresh = socket.jsonSent().at(-1)
      if (!isCommand(refresh)) throw new Error('Expected status command')
      const sent = socket.sent.length
      socket.receive(success(refresh.requestId, { ...status(1), ...workspaceStatus }))
      await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
      expect(socket.sent).toHaveLength(sent)
    },
  )

  it.each([
    { activeWorkspaceNumber: 1, focusMode: false },
    { activeWorkspaceNumber: 2, focusMode: true },
  ])('requires confirmation of the next workspace grid: %j', async (confirmation) => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (socket === undefined) throw new Error('Expected socket')
    const pending = fixture.client.cycleWorkspaces()
    const refresh = socket.jsonSent().at(-1)
    if (!isCommand(refresh)) throw new Error('Expected status command')
    socket.receive(
      success(refresh.requestId, {
        ...status(1),
        activeWorkspaceNumber: 1,
        workspaceNumbers: [1, 2],
      }),
    )
    await settleCommandQueue()
    const change = socket.jsonSent().at(-1)
    if (!isCommand(change)) throw new Error('Expected workspace command')
    socket.receive(success(change.requestId, { ...status(1), ...confirmation }))
    await expect(pending).rejects.toMatchObject({ code: 'not_confirmed' })
  })

  it('sends a workspace switch and retains the confirmed workspace status', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (socket === undefined) throw new Error('Expected socket')
    const result = fixture.client.switchWorkspace(2)
    const request = socket.jsonSent().at(-1)
    expect(request).toMatchObject({ command: { type: 'switchWorkspace', workspaceNumber: 2 } })
    if (!isCommand(request)) throw new Error('Expected workspace command')
    socket.receive(
      success(request.requestId, {
        ...status(1),
        activeWorkspaceNumber: 2,
        workspaceNumbers: [1, 2],
        focusMode: false,
      }),
    )
    await expect(result).resolves.toMatchObject({ activeWorkspaceNumber: 2 })
    expect(fixture.client.snapshot.status?.workspaceNumbers).toEqual([1, 2])
    const sent = socket.sent.length
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(fixture.client.switchWorkspace(number)).rejects.toMatchObject({
        code: 'bad_request',
      })
    }
    expect(socket.sent.length).toBe(sent)
  })

  it('keeps legacy servers connected and rejects workspace switching without sending it', async () => {
    const fixture = createFixture()
    fixture.client.start()
    const socket = fixture.sockets[0]
    if (socket === undefined) throw new Error('Expected socket')
    socket.open()
    socket.receive({ ...serverHello(), capabilities: DIT_BROWSE_REQUIRED_CAPABILITIES })
    const refresh = socket.jsonSent().at(-1)
    if (!isCommand(refresh)) throw new Error('Expected status command')
    socket.receive(success(refresh.requestId, status(1)))
    await settleCommandQueue()
    const sent = socket.sent.length
    await expect(fixture.client.switchWorkspace(2)).rejects.toMatchObject({
      code: 'unsupported_command',
    })
    await expect(fixture.client.cycleWorkspaces()).rejects.toMatchObject({
      code: 'unsupported_command',
    })
    expect(socket.sent.length).toBe(sent)
    expect(fixture.client.snapshot.connected).toBe(true)
  })

  it('connects only to loopback, handshakes, refreshes, and correlates focus results', async () => {
    const fixture = createFixture()
    fixture.client.start()

    expect(fixture.urls).toEqual(['ws://127.0.0.1:7502/api/ws'])
    expect(fixture.client.snapshot.phase).toBe('connecting')

    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')
    socket.open()
    expect(socket.jsonSent()[0]).toEqual({
      type: 'hello',
      protocol: 'ditbrowse.control',
      protocolVersion: 1,
      client: { name: 'hubble', version: '0.1.0' },
    })

    socket.receive(serverHello())
    expect(fixture.client.snapshot.phase).toBe('connected')
    const refresh = socket.jsonSent()[1]
    expect(refresh).toMatchObject({ type: 'command', command: { type: 'status' } })
    if (!isCommand(refresh)) throw new Error('Expected refresh command')
    socket.receive(success(refresh.requestId, status(1)))
    await settleCommandQueue()

    const focusPromise = fixture.client.focusCamera(3)
    const focus = socket.jsonSent()[2]
    expect(focus).toMatchObject({
      type: 'command',
      command: { type: 'focusCamera', cameraNumber: 3 },
    })
    if (!isCommand(focus)) throw new Error('Expected focus command')
    socket.receive(success(focus.requestId, status(3)))

    await expect(focusPromise).resolves.toMatchObject({ selectedCameraNumber: 3 })
    expect(fixture.client.snapshot.status?.selectedCameraNumber).toBe(3)
    expect(fixture.client.snapshot.serverVersion).toBe('1.0.1')
  })

  it('rejects sanitized server failures and command timeouts', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    const rejected = fixture.client.focusCamera(88)
    const request = socket.jsonSent().at(-1)
    if (!isCommand(request)) throw new Error('Expected focus command')
    socket.receive({
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error: { code: 'not_found', message: '\u0000No camera\n88' },
    })
    await expect(rejected).rejects.toMatchObject({
      name: 'DitBrowseCommandError',
      code: 'not_found',
      message: 'No camera 88',
    })

    const timedOut = fixture.client.focusCamera(99)
    fixture.clock.advanceBy(3_500)
    await expect(timedOut).rejects.toMatchObject({
      name: 'DitBrowseCommandError',
      code: 'timeout',
    })
  })

  it('rejects out-of-range cameras before writing a command frame', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')
    const sentBefore = socket.sent.length

    await expect(fixture.client.focusCamera(1_000_000)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'cameraNumber must be an integer between 1 and 999999',
    })
    expect(socket.sent).toHaveLength(sentBefore)
  })

  it('sets grid lock to a desired state without repeating an already-satisfied toggle', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    const lock = fixture.client.setGridLocked(true)
    const lockRequest = socket.jsonSent().at(-1)
    expect(lockRequest).toMatchObject({ command: { type: 'toggleExpansion' } })
    if (!isCommand(lockRequest)) throw new Error('Expected lock command')
    socket.receive(
      success(lockRequest.requestId, status(1, { expansionEnabled: false, focusMode: false })),
    )
    await expect(lock).resolves.toMatchObject({ expansionEnabled: false, focusMode: false })

    const sentAfterLock = socket.sent.length
    await expect(fixture.client.setGridLocked(true)).resolves.toMatchObject({
      expansionEnabled: false,
    })
    expect(socket.sent).toHaveLength(sentAfterLock)

    const unlock = fixture.client.setGridLocked(false)
    const unlockRequest = socket.jsonSent().at(-1)
    expect(unlockRequest).toMatchObject({ command: { type: 'toggleExpansion' } })
    if (!isCommand(unlockRequest)) throw new Error('Expected unlock command')
    socket.receive(
      success(unlockRequest.requestId, status(1, { expansionEnabled: true, focusMode: false })),
    )
    await expect(unlock).resolves.toMatchObject({ expansionEnabled: true, focusMode: false })

    const sentAfterUnlock = socket.sent.length
    await expect(fixture.client.setGridLocked(false)).resolves.toMatchObject({
      expansionEnabled: true,
    })
    expect(socket.sent).toHaveLength(sentAfterUnlock)
  })

  it('toggles grid lock exactly once for every requested toggle action', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    const toggle = fixture.client.toggleGridLocked()
    const request = socket.jsonSent().at(-1)
    expect(request).toMatchObject({ command: { type: 'toggleExpansion' } })
    if (!isCommand(request)) throw new Error('Expected toggle command')
    socket.receive(
      success(request.requestId, status(1, { expansionEnabled: false, focusMode: false })),
    )

    await expect(toggle).resolves.toMatchObject({ expansionEnabled: false, focusMode: false })
  })

  it('serializes simultaneous state-changing commands and rechecks state inside the queue', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    const firstLock = fixture.client.setGridLocked(true)
    const secondLock = fixture.client.setGridLocked(true)
    const firstRequest = socket.jsonSent().at(-1)
    if (!isCommand(firstRequest)) throw new Error('Expected first lock command')
    expect(firstRequest).toMatchObject({ command: { type: 'toggleExpansion' } })
    const sentBeforeConfirmation = socket.sent.length

    socket.receive(
      success(firstRequest.requestId, status(1, { expansionEnabled: false, focusMode: false })),
    )
    await expect(firstLock).resolves.toMatchObject({ expansionEnabled: false })
    await expect(secondLock).resolves.toMatchObject({ expansionEnabled: false })
    expect(socket.sent).toHaveLength(sentBeforeConfirmation)

    const orderedFixture = await createConnectedFixture()
    const orderedSocket = orderedFixture.sockets[0]
    if (!orderedSocket) throw new Error('Expected ordered socket')
    const focus = orderedFixture.client.focusCamera(3)
    const lockAfterFocus = orderedFixture.client.setGridLocked(true)
    const focusRequest = orderedSocket.jsonSent().at(-1)
    if (!isCommand(focusRequest)) throw new Error('Expected focus command')
    expect(focusRequest).toMatchObject({ command: { type: 'focusCamera', cameraNumber: 3 } })
    const sentWhileFocusPending = orderedSocket.sent.length

    orderedSocket.receive(success(focusRequest.requestId, status(3)))
    await expect(focus).resolves.toMatchObject({ selectedCameraNumber: 3 })
    const lockAfterFocusRequest = orderedSocket.jsonSent().at(-1)
    if (!isCommand(lockAfterFocusRequest)) throw new Error('Expected queued lock command')
    expect(orderedSocket.sent).toHaveLength(sentWhileFocusPending + 1)
    expect(lockAfterFocusRequest).toMatchObject({ command: { type: 'toggleExpansion' } })
    orderedSocket.receive(
      success(
        lockAfterFocusRequest.requestId,
        status(3, { expansionEnabled: false, focusMode: false }),
      ),
    )
    await expect(lockAfterFocus).resolves.toMatchObject({ expansionEnabled: false })
  })

  it('applies only newer status events', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    socket.receive(statusEvent(5, status(5)))
    socket.receive(statusEvent(4, status(4)))

    expect(fixture.client.snapshot.revision).toBe(5)
    expect(fixture.client.snapshot.status?.selectedCameraNumber).toBe(5)
  })

  it('adopts DIT Browse local lock changes without echoing commands and uses them for set actions', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')
    const before = socket.sent.length
    socket.receive(statusEvent(1, status(1, { expansionEnabled: false, focusMode: false })))
    expect(fixture.client.snapshot.status?.expansionEnabled).toBe(false)
    await expect(fixture.client.setGridLocked(true)).resolves.toMatchObject({
      expansionEnabled: false,
    })
    expect(socket.sent).toHaveLength(before)

    socket.receive(statusEvent(2, status(1, { expansionEnabled: true, focusMode: false })))
    expect(fixture.client.snapshot.status?.expansionEnabled).toBe(true)
    await expect(fixture.client.setGridLocked(false)).resolves.toMatchObject({
      expansionEnabled: true,
    })
    expect(socket.sent).toHaveLength(before)
  })

  it('resynchronizes lock state after reconnect without replaying the previous lock', async () => {
    const fixture = await createConnectedFixture()
    const first = fixture.sockets[0]
    if (!first) throw new Error('Expected socket')
    first.receive(statusEvent(20, status(1, { expansionEnabled: false, focusMode: false })))
    first.remoteClose()
    expect(fixture.client.snapshot.status).toBeNull()
    fixture.clock.advanceBy(1_000)
    const second = fixture.sockets[1]
    if (!second) throw new Error('Expected reconnect socket')
    second.open()
    second.receive(serverHello())
    const refresh = second.jsonSent().at(-1)
    if (!isCommand(refresh)) throw new Error('Expected status refresh')
    expect(refresh).toMatchObject({ command: { type: 'status' } })
    second.receive(
      success(refresh.requestId, status(1, { expansionEnabled: true, focusMode: false })),
    )
    second.receive(statusEvent(1, status(1, { expansionEnabled: true, focusMode: false })))
    await settleCommandQueue()
    expect(fixture.client.snapshot.status?.expansionEnabled).toBe(true)
    expect(fixture.client.snapshot.revision).toBe(1)
    expect(second.jsonSent().filter(isCommand)).toEqual([
      expect.objectContaining({ command: { type: 'status' } }),
    ])
  })

  it('rejects pending work, reconnects with bounded delays, and never replays commands', async () => {
    const fixture = await createConnectedFixture()
    const first = fixture.sockets[0]
    if (!first) throw new Error('Expected socket')

    const pending = fixture.client.focusCamera(7)
    const sentBeforeClose = first.sent.length
    first.remoteClose()

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(999)
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(1)
    expect(fixture.sockets).toHaveLength(2)

    const second = fixture.sockets[1]
    if (!second) throw new Error('Expected replacement socket')
    second.open()
    second.receive(serverHello())
    expect(second.jsonSent()).toHaveLength(2)
    expect(second.jsonSent()[1]).toMatchObject({ command: { type: 'status' } })
    expect(first.sent).toHaveLength(sentBeforeClose)

    second.remoteClose()
    fixture.clock.advanceBy(2_000)
    expect(fixture.sockets).toHaveLength(3)
  })

  it('exposes the exact bounded 1/2/5/10 second reconnect schedule', async () => {
    const fixture = await createConnectedFixture()
    const scheduled: Array<{ readonly attempt: number; readonly delayMs: number }> = []
    fixture.client.subscribe((snapshot) => {
      if (snapshot.nextReconnectDelayMs === null) return
      scheduled.push({
        attempt: snapshot.reconnectAttempt,
        delayMs: snapshot.nextReconnectDelayMs,
      })
    })

    const delays = [1_000, 2_000, 5_000, 10_000, 10_000] as const
    for (const delayMs of delays) {
      const socket = fixture.sockets.at(-1)
      if (!socket) throw new Error('Expected socket')
      socket.remoteClose()
      expect(fixture.client.snapshot.nextReconnectDelayMs).toBe(delayMs)
      fixture.clock.advanceBy(delayMs)
      expect(fixture.client.snapshot.nextReconnectDelayMs).toBeNull()
    }

    expect(scheduled).toEqual([
      { attempt: 1, delayMs: 1_000 },
      { attempt: 2, delayMs: 2_000 },
      { attempt: 3, delayMs: 5_000 },
      { attempt: 4, delayMs: 10_000 },
      { attempt: 5, delayMs: 10_000 },
    ])
  })

  it('rejects in-flight work and remains terminal after final stop', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')
    const pending = fixture.client.focusCamera(7)
    const sentBeforeStop = socket.sent.length

    fixture.client.stop()

    await expect(pending).rejects.toMatchObject({ code: 'stopped' })
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'disconnected',
      connected: false,
      reconnectAttempt: 0,
      nextReconnectDelayMs: null,
    })
    fixture.clock.advanceBy(60_000)
    expect(fixture.sockets).toHaveLength(1)
    expect(socket.sent).toHaveLength(sentBeforeStop)
  })

  it('absorbs the expected ws error when a connecting socket is stopped', () => {
    const fixture = createFixture()
    fixture.client.start()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    fixture.client.stop()

    expect(socket.listenerCount('error')).toBe(1)
    expect(() => {
      socket.emit(
        'error',
        new Error('WebSocket was closed before the connection was established'),
      )
    }).not.toThrow()
    expect(socket.listenerCount('error')).toBe(0)
  })

  it('closes malformed sessions and stop prevents any reconnect', async () => {
    const fixture = await createConnectedFixture()
    const socket = fixture.sockets[0]
    if (!socket) throw new Error('Expected socket')

    const pending = fixture.client.focusCamera(4)
    socket.receiveRaw('{bad json')
    expect(socket.closeCalls).toEqual([{ code: 1002, reason: 'Protocol error' }])
    socket.remoteClose()
    await expect(pending).rejects.toBeInstanceOf(DitBrowseCommandError)
    expect(fixture.client.snapshot.lastError).toBe('Invalid DIT Browse server message')

    fixture.client.stop()
    fixture.clock.advanceBy(60_000)
    expect(fixture.sockets).toHaveLength(1)
    expect(fixture.client.snapshot.phase).toBe('disconnected')
  })
})

async function createConnectedFixture() {
  const fixture = createFixture()
  fixture.client.start()
  const socket = fixture.sockets[0]
  if (!socket) throw new Error('Expected socket')
  socket.open()
  socket.receive(serverHello())
  const refresh = socket.jsonSent().at(-1)
  if (!isCommand(refresh)) throw new Error('Expected initial status command')
  socket.receive(success(refresh.requestId, status(1, { focusMode: false })))
  await settleCommandQueue()
  return fixture
}

async function settleCommandQueue(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

function createFixture() {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const client = new DitBrowseClient({
    port: 7502,
    clientName: 'hubble',
    clientVersion: '0.1.0',
    clock,
    socketFactory: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
  return { client, clock, sockets, urls }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  readonly sent: string[] = []
  readonly closeCalls: Array<{ readonly code: number; readonly reason: string }> = []

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  receive(value: unknown): void {
    this.receiveRaw(JSON.stringify(value))
  }

  receiveRaw(value: string): void {
    this.emit('message', Buffer.from(value), false)
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = WebSocket.CLOSING
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED
  }

  remoteClose(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close', 1006, Buffer.alloc(0))
  }

  jsonSent(): unknown[] {
    return this.sent.map((message) => JSON.parse(message) as unknown)
  }
}

class FakeClock implements DitBrowseClientClock {
  private nowMs = 1_000
  private nextId = 1
  private readonly timers = new Map<
    number,
    { readonly deadline: number; readonly callback: () => void }
  >()

  now(): number {
    return this.nowMs
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { deadline: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  advanceBy(delayMs: number): void {
    const target = this.nowMs + delayMs
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((left, right) => left[1].deadline - right[1].deadline || left[0] - right[0])[0]
      if (!due) break
      this.nowMs = due[1].deadline
      this.timers.delete(due[0])
      due[1].callback()
    }
    this.nowMs = target
  }
}

function serverHello() {
  return {
    type: 'hello',
    protocol: 'ditbrowse.control',
    protocolVersion: 1,
    server: { name: 'DIT Browse', version: '1.0.1' },
    capabilities: DIT_BROWSE_CAPABILITIES,
  }
}

function status(
  selectedCameraNumber: number,
  overrides: Partial<DitBrowseStatus> = {},
): DitBrowseStatus {
  const cameraNumberText = String(selectedCameraNumber)
  return {
    expansionEnabled: true,
    focusMode: true,
    selectedCameraNumber,
    selectedTileId: `tile-${cameraNumberText}`,
    selectedIndex: 1,
    tabs: [
      {
        index: 1,
        tileId: `tile-${cameraNumberText}`,
        cameraId: `camera-${cameraNumberText}`,
        cameraNumber: selectedCameraNumber,
        title: `CAM ${cameraNumberText}`,
        url: `http://camera-${cameraNumberText}/`,
      },
    ],
    ...overrides,
  }
}

function success(requestId: string, nextStatus: DitBrowseStatus) {
  return { type: 'result', requestId, ok: true, status: nextStatus }
}

function statusEvent(revision: number, nextStatus: DitBrowseStatus) {
  return { type: 'event', event: 'status', revision, status: nextStatus }
}

function isCommand(value: unknown): value is { readonly requestId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'command' &&
    'requestId' in value &&
    typeof value.requestId === 'string'
  )
}
