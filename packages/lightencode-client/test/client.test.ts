import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
  LIGHTENCODE_COMPANION_PORT,
  LightEncodeClient,
  LightEncodeCommandError,
  type LightEncodeClientClock,
  type LightEncodeSocket,
} from '../src/client.js'
import type { LightEncodeStateSnapshot } from '../src/protocol.js'

const SESSION_ONE = '49fd5ac4-8c89-4f15-a596-bec3667d5be8'
const SESSION_TWO = 'a55fe1af-8ab8-469e-aa45-904983c78ea6'
const FIRST_ID = 'd396fe70-517f-416c-882b-c831795ad942'
const SECOND_ID = 'd7621840-e45b-4ce4-aab4-15f0918bf28f'
const REQUEST_IDS = [
  'fa121667-ff11-4180-a68b-5d99dd671fb5',
  'f88ed959-a219-4c18-b290-55ef6936b1da',
  '19aaea78-3dcb-4168-a2f0-172179043b29',
  '534b3a42-6242-4af5-900d-43b9a419dca4',
] as const

describe('LightEncodeClient', () => {
  it('sends the canonical hello and becomes ready only after ack plus state', () => {
    const fixture = createFixture()
    const snapshots: string[] = []
    const unsubscribe = fixture.client.subscribe((snapshot) => snapshots.push(snapshot.phase))

    fixture.client.start('10.20.30.40')
    expect(fixture.endpoints).toEqual([
      { host: '10.20.30.40', port: LIGHTENCODE_COMPANION_PORT },
    ])
    expect(fixture.client.snapshot.phase).toBe('connecting')

    const socket = currentSocket(fixture)
    socket.connect()
    expect(socket.jsonSent()[0]).toEqual({
      type: 'hello',
      protocol: 'lightencode-companion',
      protocolVersion: 1,
      client: 'bitfocus-companion',
      clientVersion: '0.1.0',
    })
    expect(fixture.client.snapshot.phase).toBe('handshaking')

    socket.receive(helloAck(SESSION_ONE))
    expect(fixture.client.snapshot.phase).toBe('handshaking')
    expect(fixture.client.snapshot.state).toBeNull()

    socket.receive(state(1))
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'connected',
      host: '10.20.30.40',
      port: 59_613,
      appVersion: '1.0.0',
      sessionId: SESSION_ONE,
      reconnectAttempt: 0,
      lastError: null,
    })
    expect(fixture.client.snapshot.capabilities).toEqual([
      'record.toggleAll',
      'record.togglePipeline',
      'timer.toggle',
      'timer.set',
    ])
    expect(fixture.client.snapshot.lastEventAt).toBe('1970-01-01T00:00:01.000Z')
    expect(snapshots).toContain('handshaking')
    unsubscribe()
  })

  it('accepts node:net hosts and rejects URL-shaped, credentialed, and bracketed input', () => {
    for (const host of ['encoder.local', '127.0.0.1', '2001:db8::1']) {
      const fixture = createFixture()
      fixture.client.start(host)
      expect(fixture.endpoints).toEqual([{ host, port: 59_613 }])
      fixture.client.stop()
    }

    for (const host of [
      '',
      'http://encoder.local',
      'user@encoder.local',
      'encoder.local/path',
      'encoder.local?query',
      'encoder.local#fragment',
      'encoder local',
      ' encoder.local',
      'encoder.local ',
      '\tencoder.local',
      'encoder.local\n',
      '[2001:db8::1]',
      '2001:db8::zz',
    ]) {
      const fixture = createFixture()
      expect(() => {
        fixture.client.start(host)
      }).toThrow('Light Encode host')
      expect(fixture.endpoints).toEqual([])
    }
  })

  it('maps a slot to the newest top-to-bottom pipeline UUID before sending', async () => {
    const fixture = connectedFixture([
      { id: FIRST_ID, recordingState: 'idle' },
      { id: SECOND_ID, recordingState: 'idle' },
    ])
    const socket = currentSocket(fixture)
    socket.receive(state(2, [{ id: SECOND_ID }, { id: FIRST_ID }]))

    const command = fixture.client.toggleSlot(1)
    const sent = lastCommand(socket)
    expect(sent).toMatchObject({
      id: REQUEST_IDS[0],
      name: 'record.togglePipeline',
      target: { scope: 'pipeline', pipelineId: SECOND_ID },
      args: {},
    })
    socket.receive(
      successfulResponse(sent.id, 3, {
        kind: 'pipelinesRecording',
        pipelineIds: [SECOND_ID],
        recording: true,
      }),
    )
    socket.receive(state(3, [{ id: SECOND_ID, recordingState: 'recording' }, { id: FIRST_ID }]))

    await expect(command).resolves.toMatchObject({ revision: 3 })

    const sentBeforeMissing = socket.sent.length
    await expect(fixture.client.toggleSlot(3)).rejects.toMatchObject({
      name: 'LightEncodeCommandError',
      code: 'slot_not_found',
    })
    expect(socket.sent).toHaveLength(sentBeforeMissing)
  })

  it('waits for both response and state in either arrival order', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)

    const toggle = fixture.client.toggleTimer()
    const toggleRequest = lastCommand(socket)
    socket.receive(
      successfulResponse(toggleRequest.id, 2, { kind: 'timerEnabled', enabled: true }),
    )
    await settle()
    expect(await fixture.pendingState(toggle)).toBe(true)
    socket.receive(state(2, [], { timerEnabled: true }))
    await expect(toggle).resolves.toMatchObject({ app: { timerEnabled: true } })

    const minutes = fixture.client.setTimerMinutes(45)
    const minutesRequest = lastCommand(socket)
    socket.receive(state(3, [], { timerEnabled: true, timerMinutes: 45 }))
    socket.receive(
      successfulResponse(minutesRequest.id, 3, { kind: 'timerMinutes', minutes: 45 }),
    )
    await expect(minutes).resolves.toMatchObject({ app: { timerMinutes: 45 } })
  })

  it('correlates out-of-order and uppercase response IDs and ignores duplicate responses', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)
    const first = fixture.client.setTimerMinutes(10)
    const firstRequest = lastCommand(socket)
    const second = fixture.client.setTimerMinutes(20)
    const secondRequest = lastCommand(socket)

    socket.receive(state(2, [], { timerMinutes: 20 }))
    socket.receive(
      successfulResponse(secondRequest.id.toUpperCase(), 2, {
        kind: 'timerMinutes',
        minutes: 20,
      }),
    )
    await expect(second).resolves.toMatchObject({ app: { timerMinutes: 20 } })
    socket.receive(
      successfulResponse(secondRequest.id, 2, { kind: 'timerMinutes', minutes: 20 }),
    )

    socket.receive(state(3, [], { timerMinutes: 10 }))
    socket.receive(
      successfulResponse(firstRequest.id, 3, { kind: 'timerMinutes', minutes: 10 }),
    )
    await expect(first).resolves.toMatchObject({ app: { timerMinutes: 10 } })
  })

  it('rejects duplicate generated request IDs without writing a second command', async () => {
    const fixture = connectedFixture([], { requestIds: [REQUEST_IDS[0], REQUEST_IDS[0]] })
    const socket = currentSocket(fixture)
    const first = fixture.client.toggleTimer()
    const sentBeforeDuplicate = socket.sent.length

    await expect(fixture.client.toggleAll()).rejects.toMatchObject({
      code: 'duplicate_request',
    })
    expect(socket.sent).toHaveLength(sentBeforeDuplicate)

    socket.receive(
      successfulResponse(REQUEST_IDS[0], 2, { kind: 'timerEnabled', enabled: true }),
    )
    socket.receive(state(2, [], { timerEnabled: true }))
    await expect(first).resolves.toMatchObject({ revision: 2 })
  })

  it('rejects reuse of a completed request ID without writing a second toggle', async () => {
    const fixture = connectedFixture([], { requestIds: [REQUEST_IDS[0], REQUEST_IDS[0]] })
    const socket = currentSocket(fixture)
    const first = fixture.client.toggleTimer()
    socket.receive(
      successfulResponse(REQUEST_IDS[0], 2, { kind: 'timerEnabled', enabled: true }),
    )
    socket.receive(state(2, [], { timerEnabled: true }))
    await expect(first).resolves.toMatchObject({ revision: 2 })
    const sentBeforeDuplicate = socket.sent.length

    await expect(fixture.client.toggleAll()).rejects.toMatchObject({
      code: 'duplicate_request',
      requestId: REQUEST_IDS[0],
    })
    expect(socket.sent).toHaveLength(sentBeforeDuplicate)
    expect(socket.commands()).toHaveLength(1)
  })

  it('uses one deadline, never retries, and distinguishes response and state timeouts', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)
    const noResponse = fixture.client.toggleTimer()
    const noResponseRejection = expect(noResponse).rejects.toMatchObject({
      code: 'command_timeout',
    })
    const firstCommandCount = socket.commands().length
    fixture.clock.advanceBy(4_000)
    await noResponseRejection
    expect(socket.commands()).toHaveLength(firstCommandCount)

    const noState = fixture.client.setTimerMinutes(30)
    const request = lastCommand(socket)
    socket.receive(successfulResponse(request.id, 2, { kind: 'timerMinutes', minutes: 30 }))
    const noStateRejection = expect(noState).rejects.toMatchObject({
      code: 'state_not_confirmed',
    })
    fixture.clock.advanceBy(4_000)
    await noStateRejection
    expect(socket.commands()).toHaveLength(firstCommandCount + 1)
  })

  it('maps negative responses to a stable rejected error with the server code', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)
    const command = fixture.client.toggleAll()
    const request = lastCommand(socket)
    socket.receive({
      type: 'response',
      id: request.id,
      ok: false,
      code: 'nothing_to_record',
      message: '\u0000No sources\nare enabled',
      stateRevision: 1,
      confirmation: null,
      failures: null,
    })

    await expect(command).rejects.toMatchObject({
      name: 'LightEncodeCommandError',
      code: 'rejected',
      serverCode: 'nothing_to_record',
      message: 'No sources are enabled',
    })
  })

  it('rejects pending commands on disconnect, reconnects, and never replays them', async () => {
    const fixture = connectedFixture()
    const firstSocket = currentSocket(fixture)
    const command = fixture.client.toggleTimer()
    const commandCount = firstSocket.commands().length
    firstSocket.remoteClose()

    await expect(command).rejects.toMatchObject({ code: 'disconnected' })
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'disconnected',
      state: null,
      reconnectAttempt: 1,
    })
    fixture.clock.advanceBy(1_999)
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(1)
    expect(fixture.sockets).toHaveLength(2)

    const replacement = currentSocket(fixture)
    replacement.connect()
    replacement.receive(helloAck(SESSION_ONE))
    replacement.receive(state(1))
    expect(replacement.commands()).toHaveLength(0)
    expect(firstSocket.commands()).toHaveLength(commandCount)
  })

  it('sends ping every five seconds and immediately replaces a 15-second stale connection', () => {
    const fixture = connectedFixture()
    const first = currentSocket(fixture)
    fixture.clock.advanceBy(5_000)
    expect(first.jsonSent().at(-1)).toEqual({ type: 'ping', timestamp: 6_000 })
    first.receive({ type: 'pong', timestamp: 6_000 })

    fixture.clock.advanceBy(14_999)
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(1)
    expect(first.destroyed).toBe(true)
    expect(fixture.sockets).toHaveLength(2)
    expect(fixture.client.snapshot.reconnectAttempt).toBe(1)
  })

  it('bounds an incomplete TCP connect by the stale interval without replaying commands', () => {
    const fixture = createFixture()
    fixture.client.start('127.0.0.1')
    const first = currentSocket(fixture)

    fixture.clock.advanceBy(14_999)
    expect(fixture.sockets).toHaveLength(1)
    expect(first.destroyed).toBe(false)

    fixture.clock.advanceBy(1)
    expect(first.destroyed).toBe(true)
    expect(fixture.sockets).toHaveLength(2)
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'connecting',
      reconnectAttempt: 1,
    })
    expect(first.commands()).toEqual([])
    expect(currentSocket(fixture).commands()).toEqual([])
  })

  it('delays unsupported-protocol handshake reconnects and sends only a new hello', () => {
    const fixture = createFixture()
    fixture.client.start('127.0.0.1')
    const first = currentSocket(fixture)
    first.connect()
    first.receive({
      type: 'error',
      code: 'unsupported_protocol',
      message: 'Expected lightencode-companion version 1',
    })

    expect(first.destroyed).toBe(true)
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'disconnected',
      reconnectAttempt: 1,
    })
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(1_999)
    expect(fixture.sockets).toHaveLength(1)

    fixture.clock.advanceBy(1)
    expect(fixture.sockets).toHaveLength(2)
    const replacement = currentSocket(fixture)
    replacement.connect()
    expect(replacement.jsonSent()).toEqual([
      expect.objectContaining({ type: 'hello', protocolVersion: 1 }),
    ])
    expect(replacement.commands()).toEqual([])
  })

  it('fences pending work when the Light Encode process session changes', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)
    const command = fixture.client.toggleTimer()
    socket.receive(helloAck(SESSION_TWO))

    await expect(command).rejects.toMatchObject({ code: 'disconnected' })
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'handshaking',
      sessionId: SESSION_TWO,
      state: null,
    })
    socket.receive(state(1, [], { timerMinutes: 45 }))
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'connected',
      sessionId: SESSION_TWO,
      state: { app: { timerMinutes: 45 } },
    })
  })

  it('cleans up on reconfiguration and remains terminal after stop', async () => {
    const fixture = connectedFixture()
    const first = currentSocket(fixture)
    const pending = fixture.client.toggleTimer()

    fixture.client.start('lightencode-studio.local')
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    expect(first.destroyed).toBe(true)
    expect(fixture.endpoints.at(-1)).toEqual({
      host: 'lightencode-studio.local',
      port: 59_613,
    })

    const second = currentSocket(fixture)
    second.connect()
    fixture.client.stop()
    expect(second.destroyed).toBe(true)
    expect(fixture.client.snapshot).toMatchObject({
      phase: 'disconnected',
      appVersion: null,
      sessionId: null,
      state: null,
      reconnectAttempt: 0,
    })
    fixture.clock.advanceBy(60_000)
    expect(fixture.sockets).toHaveLength(2)
  })

  it('isolates malformed protocol data to the current transport', async () => {
    const fixture = connectedFixture()
    const socket = currentSocket(fixture)
    const pending = fixture.client.toggleTimer()
    socket.receiveRaw('{bad json}\n')

    await expect(pending).rejects.toBeInstanceOf(LightEncodeCommandError)
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(socket.destroyed).toBe(true)
    expect(fixture.sockets).toHaveLength(1)
    expect(fixture.client.snapshot.lastError).toBe('Invalid Light Encode protocol data')
    fixture.clock.advanceBy(1_999)
    expect(fixture.sockets).toHaveLength(1)
    fixture.clock.advanceBy(1)
    expect(fixture.sockets).toHaveLength(2)
    expect(currentSocket(fixture).commands()).toEqual([])
  })
})

type Fixture = ReturnType<typeof createFixture>

function createFixture(options: { readonly requestIds?: readonly string[] } = {}) {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const endpoints: Array<{ readonly host: string; readonly port: number }> = []
  const requestIds = [...(options.requestIds ?? REQUEST_IDS)]
  let requestIndex = 0
  const client = new LightEncodeClient({
    clientVersion: '0.1.0',
    requestTimeoutMs: 4_000,
    reconnectDelayMs: 2_000,
    clock,
    requestIdFactory: () => requestIds[requestIndex++] ?? REQUEST_IDS[3],
    socketFactory: (host, port) => {
      endpoints.push({ host, port })
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  return {
    client,
    clock,
    sockets,
    endpoints,
    pendingState: async (promise: Promise<unknown>) => {
      const marker = Symbol('pending')
      return (await Promise.race([promise, Promise.resolve(marker)])) === marker
    },
  }
}

function connectedFixture(
  pipelines: PipelineInput[] = [],
  options: { readonly requestIds?: readonly string[] } = {},
): Fixture {
  const fixture = createFixture(options)
  fixture.client.start('127.0.0.1')
  const socket = currentSocket(fixture)
  socket.connect()
  socket.receive(helloAck(SESSION_ONE))
  socket.receive(state(1, pipelines))
  return fixture
}

function currentSocket(fixture: Fixture): FakeSocket {
  const socket = fixture.sockets.at(-1)
  if (!socket) throw new Error('Expected Light Encode socket')
  return socket
}

class FakeSocket extends EventEmitter implements LightEncodeSocket {
  readonly sent: string[] = []
  destroyed = false

  write(data: string | Uint8Array): boolean {
    this.sent.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    return true
  }

  override removeAllListeners(event?: string | symbol): this {
    return super.removeAllListeners(event)
  }

  connect(): void {
    this.emit('connect')
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  receive(message: unknown): void {
    this.receiveRaw(`${JSON.stringify(message)}\n`)
  }

  receiveRaw(data: string | Buffer): void {
    this.emit('data', typeof data === 'string' ? Buffer.from(data) : data)
  }

  remoteClose(): void {
    this.emit('close', false)
  }

  jsonSent(): Array<Record<string, unknown>> {
    return this.sent
      .flatMap((payload) => payload.split('\n'))
      .filter(Boolean)
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
  }

  commands(): Array<Record<string, unknown>> {
    return this.jsonSent().filter((message) => message.type === 'command')
  }
}

class FakeClock implements LightEncodeClientClock {
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

function helloAck(sessionId: string) {
  return {
    type: 'helloAck',
    protocol: 'lightencode-companion',
    protocolVersion: 1,
    appVersion: '1.0.0',
    sessionId,
    capabilities: ['record.toggleAll', 'record.togglePipeline', 'timer.toggle', 'timer.set'],
  }
}

type PipelineInput = {
  readonly id: string
  readonly recordingState?: 'idle' | 'recording' | 'finishing' | 'error'
}

function state(
  revision: number,
  pipelines: PipelineInput[] = [],
  app: { readonly timerEnabled?: boolean; readonly timerMinutes?: number } = {},
): LightEncodeStateSnapshot {
  return {
    type: 'state',
    revision,
    app: {
      anyRecording: pipelines.some((pipeline) => pipeline.recordingState === 'recording'),
      timerEnabled: app.timerEnabled ?? false,
      timerMinutes: app.timerMinutes ?? 0,
    },
    pipelines: pipelines.map((pipeline, index) => ({
      pipelineId: pipeline.id,
      cameraId: `CAM${String(index + 1)}`,
      recordingEnabled: true,
      canStartRecording: true,
      recordingState: pipeline.recordingState ?? 'idle',
      errorMessage: null,
    })),
  }
}

function successfulResponse(id: string, stateRevision: number, confirmation: unknown) {
  return {
    type: 'response',
    id,
    ok: true,
    code: null,
    message: 'Accepted',
    stateRevision,
    confirmation,
    failures: null,
  }
}

function lastCommand(socket: FakeSocket): Record<string, unknown> & { readonly id: string } {
  const command = socket.commands().at(-1)
  if (!command || typeof command.id !== 'string') throw new Error('Expected command')
  return { ...command, id: command.id }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}
