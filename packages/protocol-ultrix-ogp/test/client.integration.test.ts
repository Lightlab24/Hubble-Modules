import net, { type Server, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { UltrixOgpClient, type UltrixOgpClientEvent } from '../src/client.js'
import { decodeOgpFrame, type OgpMessage, type OgpValuePayload } from '../src/messages.js'
import { OgpNetstringDecoder, encodeOgpNetstring } from '../src/netstring-codec.js'

interface FakeUltrix {
  readonly port: number
  readonly messages: OgpMessage[]
  readonly sockets: Set<Socket>
  readonly server: Server
  readonly send: (message: OgpMessage) => void
  readonly postWriteRouteReadbacksSent: () => number
  readonly routeEchoesSent: () => number
  readonly updateMessages: () => readonly OgpMessage[]
  readonly routeWrites: () => readonly OgpMessage[]
  readonly close: () => Promise<void>
}

const openFakes = new Set<FakeUltrix>()

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object')
  }
  return value as Record<string, unknown>
}

function encodeMessage(message: OgpMessage): Buffer {
  return encodeOgpNetstring(JSON.stringify(message))
}

function encodeDevice(payload: Record<string, unknown>): Buffer {
  return encodeOgpNetstring(
    JSON.stringify({ type: 'device', slot: 0, zip: 'gzip' }),
    gzipSync(JSON.stringify(payload)),
  )
}

function subscriptionParams(): Record<string, unknown> {
  return {
    '_d_params.statusByDestination': {
      oid: 'params.statusByDestination',
      type: 'STRUCT_ARRAY',
      value: [],
      constraint: { type: 'STRUCT', templateoid: 'types.statusByDestination' },
    },
    '_d_types.statusByDestination': {
      oid: 'types.statusByDestination',
      type: 'STRUCT',
      value: {
        _d_inputstatus: {
          name: 'Input Status',
          type: 'INT16_ARRAY',
          value: [0, 0],
        },
      },
    },
    'params.controlready': {
      oid: 'params.controlready',
      type: 'INT16',
      value: 1,
    },
    'params.takeError': {
      oid: 'params.takeError',
      type: 'STRING',
      value: 'None|2026-07-30T20:00:00Z',
    },
  }
}

async function startFakeUltrix(options: {
  readonly echoRouteWrites: boolean
  readonly requireControllerIdentity?: boolean
  readonly requiredPanelId?: number
  readonly applyRouteWrites?: boolean
  readonly ignoreRouteReadbackAfterWrite?: boolean
  readonly routeReadbackDelayAfterWriteMs?: number
  readonly routeEchoDelayMsByLevel?: readonly number[]
  readonly staleRouteReadbackAfterWrite?: boolean
  readonly multiSetEnabled?: boolean | null
  readonly shortRouteRowOnSync?: boolean
  readonly staleControlReadyResponseAfterPush?: boolean
  readonly staleRouteResponseAfterPush?: boolean
  readonly staleTakeErrorResponseAfterPush?: boolean
  readonly refuseFirstHandshake?: boolean
  readonly holdFirstCatalogRead?: boolean
  readonly destinationCount?: number
}): Promise<FakeUltrix> {
  const messages: OgpMessage[] = []
  const sockets = new Set<Socket>()
  const routeRows = [
    {
      inputstatus: options.shortRouteRowOnSync ? [0] : [0, 1],
      lockstatus: [0, 0],
      lockowner: [0, 0],
    },
    { inputstatus: [1, 0], lockstatus: [0, 0], lockowner: [0, 0] },
  ]
  const initialRouteRows = routeRows.map((row) => ({
    inputstatus: [...row.inputstatus],
    lockstatus: [...row.lockstatus],
    lockowner: [...row.lockowner],
  }))
  while (routeRows.length < (options.destinationCount ?? 2)) {
    routeRows.push({
      inputstatus: [0, 1],
      lockstatus: [0, 0],
      lockowner: [0, 0],
    })
  }
  let handshakeCount = 0
  let catalogReadHeld = false
  let controlReadyRaceInjected = false
  let routeRaceInjected = false
  let takeErrorRaceInjected = false
  let routeWriteSeen = false
  let routeEchoesSent = 0
  let postWriteRouteReadbacksSent = 0
  const routeEchoTimers = new Set<NodeJS.Timeout>()
  const routeReadbackTimers = new Set<NodeJS.Timeout>()

  const sendTo = (socket: Socket, bytes: Buffer, fragmented = false): void => {
    if (!fragmented || bytes.length < 2) {
      socket.write(bytes)
      return
    }
    socket.write(bytes.subarray(0, 1))
    setImmediate(() => {
      if (!socket.destroyed) socket.write(bytes.subarray(1))
    })
  }

  const respondToValueRequest = (socket: Socket, payload: Record<string, unknown>): void => {
    const oid = payload.oid
    const index = payload.index
    let value: unknown
    let postWriteRouteReadback = false
    if (oid === 'params.basicsources' && Number.isInteger(index)) {
      if (options.holdFirstCatalogRead === true && !catalogReadHeld) {
        catalogReadHeld = true
        return
      }
      value = {
        id: index,
        name: `SRC ${String((index as number) + 1)}`,
        description: '',
      }
    } else if (oid === 'params.basicdests' && Number.isInteger(index)) {
      value = {
        id: index,
        name: `DST ${String((index as number) + 1)}`,
        description: '',
      }
    } else if (oid === 'params.levels') {
      value = [
        { id: 0, name: 'VID' },
        { id: 1, name: 'AUD' },
      ]
    } else if (oid === 'params.statusByDestination' && Number.isInteger(index)) {
      const row = routeRows[index as number]
      if (routeWriteSeen && options.ignoreRouteReadbackAfterWrite === true) return
      if (
        options.staleRouteResponseAfterPush === true &&
        index === 0 &&
        row !== undefined &&
        !routeRaceInjected
      ) {
        routeRaceInjected = true
        value = {
          inputstatus: [...row.inputstatus],
          lockstatus: [...row.lockstatus],
        }
        row.inputstatus[0] = 2
        sendTo(
          socket,
          encodeMessage({
            type: 'value',
            slot: 1,
            payload: {
              oid: 'params.statusByDestination',
              element: true,
              index: 0,
              value: {
                inputstatus: [...row.inputstatus],
                lockstatus: [...row.lockstatus],
              },
            },
          }),
        )
      } else {
        const selectedRow =
          routeWriteSeen && options.staleRouteReadbackAfterWrite === true
            ? initialRouteRows[index as number]
            : row
        value =
          selectedRow === undefined
            ? undefined
            : {
                inputstatus: [...selectedRow.inputstatus],
                lockstatus: [...selectedRow.lockstatus],
                lockowner: [...selectedRow.lockowner],
              }
        postWriteRouteReadback = routeWriteSeen
      }
    } else if (oid === 'params.controlready') {
      value = 1
      if (options.staleControlReadyResponseAfterPush === true && !controlReadyRaceInjected) {
        controlReadyRaceInjected = true
        sendTo(
          socket,
          encodeMessage({
            type: 'value',
            slot: 1,
            payload: { oid: 'params.controlready', value: 0 },
          }),
        )
      }
    } else if (oid === 'params.takeError') {
      value = 'None|2026-07-30T20:00:00Z'
      if (options.staleTakeErrorResponseAfterPush === true && !takeErrorRaceInjected) {
        takeErrorRaceInjected = true
        sendTo(
          socket,
          encodeMessage({
            type: 'value',
            slot: 1,
            payload: {
              oid: 'params.takeError',
              value: 'Failed|2026-07-30T20:00:01Z',
            },
          }),
        )
      }
    } else {
      sendTo(
        socket,
        encodeMessage({
          type: 'error',
          slot: 0,
          payload: { reason: `unsupported ${String(oid)}` },
        }),
      )
      return
    }
    const response = encodeMessage({
      type: 'value',
      slot: 0,
      payload: { ...payload, value },
    })
    const sendResponse = (): void => {
      if (socket.destroyed) return
      if (postWriteRouteReadback) postWriteRouteReadbacksSent += 1
      sendTo(socket, response)
    }
    const delayMs = postWriteRouteReadback ? (options.routeReadbackDelayAfterWriteMs ?? 0) : 0
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        routeReadbackTimers.delete(timer)
        sendResponse()
      }, delayMs)
      routeReadbackTimers.add(timer)
    } else {
      sendResponse()
    }
  }

  const controllerIdentityBySocket = new WeakMap<Socket, number>()

  const applyRouteWrite = (socket: Socket, payloadValue: unknown): void => {
    const payload = objectValue(payloadValue) as unknown as OgpValuePayload
    const routeMatch =
      typeof payload.oid === 'string'
        ? /^params\.statusByDestination\.(\d+)\.inputstatus$/u.exec(payload.oid)
        : null
    if (payload.oid === 'params.statusByDestination.0.lockowner') {
      if (
        payload.element !== true ||
        payload.index !== 0 ||
        !Number.isInteger(payload.value) ||
        (payload.value as number) < 1
      ) {
        throw new Error('Fake received an unsafe route-controller identity write')
      }
      controllerIdentityBySocket.set(socket, payload.value as number)
      return
    }
    if (
      routeMatch === null ||
      payload.element !== true ||
      !Number.isInteger(payload.index) ||
      !Number.isInteger(payload.value)
    ) {
      throw new Error('Fake received an unsafe route write')
    }
    const destinationIndex = Number(routeMatch[1])
    const row = routeRows[destinationIndex]
    if (row === undefined) throw new Error('Fake received an out-of-range route write')
    if (
      options.requireControllerIdentity === true &&
      controllerIdentityBySocket.get(socket) !== (options.requiredPanelId ?? 1999)
    ) {
      return
    }
    routeWriteSeen = true
    if (options.applyRouteWrites !== false) {
      row.inputstatus[payload.index as number] = payload.value as number
    }
    if (options.applyRouteWrites !== false && options.echoRouteWrites) {
      const sendEcho = (): void => {
        if (socket.destroyed) return
        routeEchoesSent += 1
        sendTo(socket, encodeMessage({ type: 'value', slot: 0, payload: { ...payload } }))
      }
      const delayMs = options.routeEchoDelayMsByLevel?.[payload.index as number] ?? 0
      if (delayMs > 0) {
        const timer = setTimeout(() => {
          routeEchoTimers.delete(timer)
          sendEcho()
        }, delayMs)
        routeEchoTimers.add(timer)
      } else {
        sendEcho()
      }
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    const decoder = new OgpNetstringDecoder()
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const decoded = decodeOgpFrame(frame)
        if (decoded.kind !== 'message') continue
        const message = decoded.message
        messages.push(message)
        if (message.type === 'handshake') {
          handshakeCount += 1
          if (options.refuseFirstHandshake === true && handshakeCount === 1) {
            sendTo(
              socket,
              encodeMessage({
                type: 'handshake',
                slot: 0,
                payload: { disconnect: true, reason: 'refused' },
              }),
            )
            continue
          }
          sendTo(
            socket,
            encodeDevice({
              slot: 0,
              detail: 'minimal',
              subscriptions: true,
              params: {},
            }),
            true,
          )
        } else if (message.type === 'device-request') {
          const advertisedMultiSet =
            options.multiSetEnabled === undefined ? true : options.multiSetEnabled
          sendTo(
            socket,
            encodeDevice({
              slot: 0,
              detail: 'subscription',
              subscriptions: true,
              subscription: [
                'params.statusByDestination',
                'params.controlready',
                'params.takeError',
              ],
              ...(advertisedMultiSet === null
                ? {}
                : { 'multi-set-enabled': advertisedMultiSet }),
              params: subscriptionParams(),
            }),
            true,
          )
        } else if (message.type === 'value-request') {
          respondToValueRequest(socket, objectValue(message.payload))
        } else if (message.type === 'value') {
          applyRouteWrite(socket, message.payload)
        } else if (message.type === 'multi-value') {
          if (!Array.isArray(message.payload)) {
            throw new Error('Fake received invalid multi-value')
          }
          for (const payload of message.payload) applyRouteWrite(socket, payload)
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fake address')
  const fake: FakeUltrix = {
    port: address.port,
    messages,
    sockets,
    server,
    send: (message) => {
      for (const socket of sockets) sendTo(socket, encodeMessage(message))
    },
    postWriteRouteReadbacksSent: () => postWriteRouteReadbacksSent,
    routeEchoesSent: () => routeEchoesSent,
    updateMessages: () =>
      messages.filter((message) => message.type === 'value' || message.type === 'multi-value'),
    routeWrites: () =>
      messages.flatMap((message) => {
        if (message.type === 'value') {
          const payload = objectValue(message.payload)
          return typeof payload.oid === 'string' && payload.oid.endsWith('.inputstatus')
            ? [message]
            : []
        }
        if (message.type !== 'multi-value' || !Array.isArray(message.payload)) return []
        const routePayloads = message.payload.filter((entry) => {
          const payload = objectValue(entry)
          return typeof payload.oid === 'string' && payload.oid.endsWith('.inputstatus')
        })
        return routePayloads.length === 0 ? [] : [{ ...message, payload: routePayloads }]
      }),
    close: async () => {
      for (const timer of routeEchoTimers) clearTimeout(timer)
      routeEchoTimers.clear()
      for (const timer of routeReadbackTimers) clearTimeout(timer)
      routeReadbackTimers.clear()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      openFakes.delete(fake)
    },
  }
  openFakes.add(fake)
  return fake
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  await Promise.all([...openFakes].map((fake) => fake.close()))
})

describe('UltrixOgpClient', () => {
  it('reports an explicit session refusal and can reconnect without restarting the client', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      refuseFirstHandshake: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 500,
    })
    await expect(client.connect()).rejects.toThrow(/router refused.*refused/iu)
    expect(fake.messages.map(({ type }) => type)).toEqual(['handshake'])
    await client.connect()
    expect(client.snapshot().phase).toBe('connected')
    expect(fake.messages.filter(({ type }) => type === 'handshake')).toHaveLength(2)
    for (const message of fake.messages.filter(({ type }) => type === 'handshake')) {
      expect(message.payload).toMatchObject({ force: false })
    }
    client.disconnect()
  })

  it('does not let cancelled synchronization disconnect the replacement session', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      holdFirstCatalogRead: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
    })
    const first = client.connect()
    const cancelled = expect(first).rejects.toThrow(/disconnected/iu)
    await waitFor(() => fake.messages.some(({ type }) => type === 'value-request'))
    client.disconnect()
    const replacement = client.connect()
    await cancelled
    await replacement
    expect(client.snapshot()).toMatchObject({
      phase: 'connected',
      lastError: null,
    })
    client.disconnect()
  })

  it('loads 100 sources and destinations without a 72-entry limit', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      destinationCount: 100,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 100,
      destinationLimit: 100,
      requestTimeoutMs: 1_000,
    })
    await client.connect()
    expect(client.snapshot().sources).toHaveLength(100)
    expect(client.snapshot().destinations).toHaveLength(100)
    expect(client.snapshot().routes).toHaveLength(200)
    client.disconnect()
  })

  it('cancels queued reads and takes when the connection changes', async () => {
    const fake = await startFakeUltrix({ echoRouteWrites: true })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
    })
    await client.connect()
    const read = expect(client.readDestination(1)).rejects.toThrow(/connection changed/iu)
    const take = expect(client.setCrosspoint({ source: 3, destination: 1 })).rejects.toThrow(
      /connection changed/iu,
    )
    client.disconnect()
    const replacement = client.connect()
    await Promise.all([read, take, replacement])
    expect(fake.routeWrites()).toEqual([])
    expect(client.snapshot().phase).toBe('connected')
    client.disconnect()
  })

  it('subscribes to the parent route status and prefixes every atomic route batch with panel identity', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      requireControllerIdentity: true,
      requiredPanelId: 2345,
      multiSetEnabled: null,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
      panelId: 2345,
    })

    await client.connect()
    expect(client.snapshot().multiSetEnabled).toBe(true)
    const subscriptionRequest = fake.messages.find(
      (message) => message.type === 'device-request',
    )
    expect(subscriptionRequest?.payload).toMatchObject({
      subscription: ['params.statusByDestination', 'params.controlready', 'params.takeError'],
    })

    const updatesBefore = fake.updateMessages().length
    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })
    expect(fake.updateMessages().slice(updatesBefore)).toEqual([
      expect.objectContaining({
        type: 'multi-value',
        payload: [
          {
            oid: 'params.statusByDestination.0.lockowner',
            element: true,
            index: 0,
            value: 2345,
          },
          {
            oid: 'params.statusByDestination.1.inputstatus',
            element: true,
            index: 0,
            value: 2,
          },
          {
            oid: 'params.statusByDestination.1.inputstatus',
            element: true,
            index: 1,
            value: 2,
          },
        ],
      }),
    ])
    expect(
      client
        .snapshot()
        .routes.filter((route) => route.destination === 2)
        .map((route) => route.source),
    ).toEqual([3, 3])

    const updatesBeforeSingleLevel = fake.updateMessages().length
    await client.setCrosspoint({ source: 3, destination: 1, levels: [1] })
    expect(fake.updateMessages().slice(updatesBeforeSingleLevel)).toEqual([
      expect.objectContaining({
        type: 'multi-value',
        payload: [
          {
            oid: 'params.statusByDestination.0.lockowner',
            element: true,
            index: 0,
            value: 2345,
          },
          {
            oid: 'params.statusByDestination.0.inputstatus',
            element: true,
            index: 0,
            value: 2,
          },
        ],
      }),
    ])

    client.disconnect()
    await fake.close()
  })

  it('uses panel 1999 before each serialized route batch when multi-set is unavailable', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      multiSetEnabled: false,
      requireControllerIdentity: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()
    const updatesBefore = fake.updateMessages().length
    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })
    expect(
      fake
        .updateMessages()
        .slice(updatesBefore)
        .map((message) => message.payload),
    ).toEqual([
      {
        oid: 'params.statusByDestination.0.lockowner',
        element: true,
        index: 0,
        value: 1999,
      },
      {
        oid: 'params.statusByDestination.1.inputstatus',
        element: true,
        index: 0,
        value: 2,
      },
      {
        oid: 'params.statusByDestination.1.inputstatus',
        element: true,
        index: 1,
        value: 2,
      },
    ])

    client.disconnect()
    await fake.close()
  })

  it('synchronizes bounded catalogs and routes, accepts pushes, and confirms a multi-level take', async () => {
    const fake = await startFakeUltrix({ echoRouteWrites: true })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })
    const events: UltrixOgpClientEvent[] = []
    client.subscribe((event) => events.push(event))

    await client.connect()

    expect(client.snapshot()).toMatchObject({
      phase: 'connected',
      controlReady: true,
      takeError: 'None|2026-07-30T20:00:00Z',
      multiSetEnabled: true,
      subscriptions: ['params.statusByDestination', 'params.controlready', 'params.takeError'],
      sources: [
        { address: 1, label: 'SRC 1' },
        { address: 2, label: 'SRC 2' },
        { address: 3, label: 'SRC 3' },
      ],
      destinations: [
        { address: 1, label: 'DST 1' },
        { address: 2, label: 'DST 2' },
      ],
      levels: [
        { level: 1, label: 'VID' },
        { level: 2, label: 'AUD' },
      ],
    })
    const handshake = fake.messages.find((message) => message.type === 'handshake')
    expect(handshake?.payload).toMatchObject({
      trusted: true,
      force: false,
      detail: 'minimal',
      subscriptions: true,
    })
    const sourceIndexes = fake.messages
      .filter(
        (message) =>
          message.type === 'value-request' &&
          objectValue(message.payload).oid === 'params.basicsources',
      )
      .map((message) => objectValue(message.payload).index)
    const destinationIndexes = fake.messages
      .filter(
        (message) =>
          message.type === 'value-request' &&
          objectValue(message.payload).oid === 'params.basicdests',
      )
      .map((message) => objectValue(message.payload).index)
    expect(sourceIndexes).toEqual([0, 1, 2])
    expect(destinationIndexes).toEqual([0, 1])

    fake.send({
      type: 'value',
      slot: 1,
      payload: {
        oid: 'params.statusByDestination.0.inputstatus',
        element: true,
        index: 0,
        value: 2,
      },
    })
    fake.send({ type: 'future-heartbeat', slot: 1, payload: {} })
    fake.send({
      type: 'error',
      slot: 1,
      payload: { reason: 'controlled-test' },
    })
    for (const socket of fake.sockets) socket.write(encodeOgpNetstring(Buffer.alloc(0)))
    await waitFor(() =>
      client
        .snapshot()
        .routes.some(
          (route) => route.destination === 1 && route.level === 1 && route.source === 3,
        ),
    )
    expect(
      events.some((event) => event.type === 'protocol-error' && event.code === 'device-error'),
    ).toBe(true)

    const revisionBeforeMultiValue = client.snapshot().revision
    const routeEventsBeforeMultiValue = events.filter(
      (event) => event.type === 'route' || event.type === 'routes',
    ).length
    fake.send({
      type: 'multi-value',
      slot: 0,
      payload: [
        {
          oid: 'params.statusByDestination.0.inputstatus',
          element: true,
          index: 0,
          value: 1,
        },
        {
          oid: 'params.statusByDestination.0.inputstatus',
          element: true,
          index: 1,
          value: 2,
        },
      ],
    })
    await waitFor(() => client.snapshot().revision === revisionBeforeMultiValue + 1)
    expect(
      events
        .filter((event) => event.type === 'route' || event.type === 'routes')
        .slice(routeEventsBeforeMultiValue),
    ).toEqual([
      expect.objectContaining({
        type: 'routes',
        previousRevision: revisionBeforeMultiValue,
        revision: revisionBeforeMultiValue + 1,
        crosspoints: [
          { destination: 1, level: 1, source: 2 },
          { destination: 1, level: 2, source: 3 },
        ],
      }),
    ])

    const writeCountBefore = fake.routeWrites().length
    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })
    const writes = fake.routeWrites().slice(writeCountBefore)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      type: 'multi-value',
      payload: [
        {
          oid: 'params.statusByDestination.1.inputstatus',
          element: true,
          index: 0,
          value: 2,
        },
        {
          oid: 'params.statusByDestination.1.inputstatus',
          element: true,
          index: 1,
          value: 2,
        },
      ],
    })
    expect(
      client
        .snapshot()
        .routes.filter((route) => route.destination === 2)
        .map((route) => route.source),
    ).toEqual([3, 3])

    const writesBeforeInvalid = fake.routeWrites().length
    await expect(
      client.setCrosspoint({ source: 4, destination: 1, levels: [1] }),
    ).rejects.toThrow(/source/iu)
    expect(fake.routeWrites()).toHaveLength(writesBeforeInvalid)

    client.disconnect()
    await fake.close()
  })

  it('uses one targeted destination readback after a missing echo and never resends the route', async () => {
    const fake = await startFakeUltrix({ echoRouteWrites: false })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 75,
      connectTimeoutMs: 3_000,
    })
    await client.connect()
    const requestsBefore = fake.messages.length

    await client.setCrosspoint({ source: 3, destination: 1, levels: [1] })

    expect(fake.routeWrites()).toHaveLength(1)
    const followupRequests = fake.messages.slice(requestsBefore).filter((message) => {
      if (message.type !== 'value-request') return false
      const payload = objectValue(message.payload)
      return (
        payload.oid === 'params.statusByDestination' &&
        payload.element === true &&
        payload.index === 0
      )
    })
    expect(followupRequests).toHaveLength(1)
    expect(
      client.snapshot().routes.find((route) => route.destination === 1 && route.level === 1)
        ?.source,
    ).toBe(3)

    client.disconnect()
    await fake.close()
  })

  it('confirms every requested level with one readback after the first fast route echo', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      routeEchoDelayMsByLevel: [0, 5_000],
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 500,
      connectTimeoutMs: 3_000,
    })
    await client.connect()
    const messagesBefore = fake.messages.length

    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })

    expect(fake.routeEchoesSent()).toBe(1)
    expect(fake.routeWrites()).toHaveLength(1)
    const followupRequests = fake.messages.slice(messagesBefore).filter((message) => {
      if (message.type !== 'value-request') return false
      const payload = objectValue(message.payload)
      return (
        payload.oid === 'params.statusByDestination' &&
        payload.element === true &&
        payload.index === 1
      )
    })
    expect(followupRequests).toHaveLength(1)
    expect(
      client
        .snapshot()
        .routes.filter((route) => route.destination === 2)
        .map((route) => route.source),
    ).toEqual([3, 3])

    client.disconnect()
    await fake.close()
  })

  it('returns on full subscription confirmation while an early readback is still pending', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      ignoreRouteReadbackAfterWrite: true,
      routeEchoDelayMsByLevel: [0, 20],
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 75,
      connectTimeoutMs: 3_000,
    })
    await client.connect()

    await expect(
      client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] }),
    ).resolves.toBeUndefined()
    expect(fake.routeEchoesSent()).toBe(2)
    expect(
      client
        .snapshot()
        .routes.filter((route) => route.destination === 2)
        .map((route) => route.source),
    ).toEqual([3, 3])

    await new Promise((resolve) => setTimeout(resolve, 100))
    client.disconnect()
    await fake.close()
  })

  it('does not let a late stale early readback overwrite full subscription confirmation', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      routeEchoDelayMsByLevel: [0, 20],
      routeReadbackDelayAfterWriteMs: 100,
      staleRouteReadbackAfterWrite: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })
    await client.connect()

    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })
    expect(fake.routeEchoesSent()).toBe(2)
    await waitFor(() => fake.postWriteRouteReadbacksSent() === 1)
    expect(
      client
        .snapshot()
        .routes.filter((route) => route.destination === 2)
        .map((route) => route.source),
    ).toEqual([3, 3])

    client.disconnect()
    await fake.close()
  })

  it('rejects an ignored route after a missing echo and one unchanged destination readback', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: false,
      applyRouteWrites: false,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 75,
      connectTimeoutMs: 3_000,
    })
    await client.connect()
    const messagesBefore = fake.messages.length

    await expect(
      client.setCrosspoint({ source: 3, destination: 1, levels: [1] }),
    ).rejects.toThrow(/route was not confirmed for destination 1/iu)

    expect(fake.routeWrites()).toHaveLength(1)
    const followupRequests = fake.messages.slice(messagesBefore).filter((message) => {
      if (message.type !== 'value-request') return false
      const payload = objectValue(message.payload)
      return (
        payload.oid === 'params.statusByDestination' &&
        payload.element === true &&
        payload.index === 0
      )
    })
    expect(followupRequests).toHaveLength(1)
    expect(
      client.snapshot().routes.find((route) => route.destination === 1 && route.level === 1)
        ?.source,
    ).toBe(1)

    client.disconnect()
    await fake.close()
  })

  it('replays a subscribed route delta after an older initial row response', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      staleRouteResponseAfterPush: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()

    expect(
      client.snapshot().routes.find((route) => route.destination === 1 && route.level === 1)
        ?.source,
    ).toBe(3)

    client.disconnect()
    await fake.close()
  })

  it('replays subscribed control readiness after an older initial status response', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      staleControlReadyResponseAfterPush: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()

    expect(client.snapshot().controlReady).toBe(false)
    await expect(
      client.setCrosspoint({ source: 3, destination: 1, levels: [1] }),
    ).rejects.toThrow(/control is not ready/iu)
    expect(fake.routeWrites()).toHaveLength(0)

    client.disconnect()
    await fake.close()
  })

  it('keeps a subscribed take failure diagnostic without blocking a later route', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      staleTakeErrorResponseAfterPush: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()

    expect(client.snapshot().takeError).toBe('Failed|2026-07-30T20:00:01Z')
    await expect(
      client.setCrosspoint({ source: 3, destination: 1, levels: [1] }),
    ).resolves.toBeUndefined()
    expect(fake.routeWrites()).toHaveLength(1)

    client.disconnect()
    await fake.close()
  })

  it('does not cancel a pending route when another controller reports a take error', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      routeEchoDelayMsByLevel: [40],
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()
    const route = client.setCrosspoint({
      source: 3,
      destination: 1,
      levels: [1],
    })
    await waitFor(() => fake.routeWrites().length === 1)
    fake.send({
      type: 'value',
      slot: 1,
      payload: {
        oid: 'params.takeError',
        value: 'Breakaway Error|external route',
      },
    })

    await expect(route).resolves.toBeUndefined()
    expect(client.snapshot().takeError).toBe('Breakaway Error|external route')

    client.disconnect()
    await fake.close()
  })

  it('cleans up a pending confirmation when a socket write throws synchronously', async () => {
    const fake = await startFakeUltrix({ echoRouteWrites: true })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })
    await client.connect()
    const internals = client as unknown as {
      readonly socket: Socket | null
      readonly requests: { readonly routeConfirmations: Set<unknown> }
    }
    if (internals.socket === null) throw new Error('Client socket is unavailable')
    const write = vi.spyOn(internals.socket, 'write').mockImplementation(() => {
      throw new Error('synthetic socket write failure')
    })

    await expect(
      client.setCrosspoint({ source: 3, destination: 1, levels: [1] }),
    ).rejects.toThrow(/synthetic socket write failure/iu)
    expect(internals.requests.routeConfirmations.size).toBe(0)

    write.mockRestore()
    await expect(
      client.setCrosspoint({ source: 3, destination: 1, levels: [1] }),
    ).resolves.toBeUndefined()
    client.disconnect()
    await fake.close()
  })

  it('uses serialized value writes when the device explicitly disables multi-set support', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      multiSetEnabled: false,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()
    expect(client.snapshot().multiSetEnabled).toBe(false)
    const writesBefore = fake.routeWrites().length

    await client.setCrosspoint({ source: 3, destination: 2, levels: [1, 2] })

    const writes = fake.routeWrites().slice(writesBefore)
    expect(writes).toHaveLength(2)
    expect(writes.map(({ type }) => type)).toEqual(['value', 'value'])
    expect(writes.map(({ payload }) => payload)).toEqual([
      {
        oid: 'params.statusByDestination.1.inputstatus',
        element: true,
        index: 0,
        value: 2,
      },
      {
        oid: 'params.statusByDestination.1.inputstatus',
        element: true,
        index: 1,
        value: 2,
      },
    ])

    client.disconnect()
    await fake.close()
  })

  it('rejects an initial destination row that omits configured levels', async () => {
    const fake = await startFakeUltrix({
      echoRouteWrites: true,
      shortRouteRowOnSync: true,
    })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await expect(client.connect()).rejects.toThrow(/at least 2 levels/iu)
    expect(client.snapshot().phase).toBe('disconnected')

    client.disconnect()
    await fake.close()
  })

  it('disconnects instead of retaining stale levels after a short live destination row', async () => {
    const fake = await startFakeUltrix({ echoRouteWrites: true })
    const client = new UltrixOgpClient({
      host: '127.0.0.1',
      port: fake.port,
      levels: 2,
      sourceLimit: 3,
      destinationLimit: 2,
      requestTimeoutMs: 250,
      connectTimeoutMs: 3_000,
    })

    await client.connect()
    fake.send({
      type: 'value',
      slot: 0,
      payload: {
        oid: 'params.statusByDestination',
        element: true,
        index: 0,
        value: { inputstatus: [0] },
      },
    })
    await waitFor(() => client.snapshot().phase === 'disconnected')
    expect(client.snapshot().lastError).toMatch(/at least 2 levels/iu)

    client.disconnect()
    await fake.close()
  })
})
