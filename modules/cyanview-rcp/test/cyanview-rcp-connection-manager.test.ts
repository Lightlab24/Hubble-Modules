import { CyanViewRcpConnectionManager } from '@hubble/protocol-cyanview-rcp'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CyanViewRcpConnectionDefinitionSchema } from '../src/config.js'

const ID = '11111111-1111-4111-8111-111111111111'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

function publish(topic: string, value: string, retained = true): Buffer {
  const name = Buffer.from(topic)
  const payload = Buffer.concat([Buffer.from([0, name.length]), name, Buffer.from(value)])
  return Buffer.concat([Buffer.from([retained ? 0x31 : 0x30, payload.length]), payload])
}
async function broker(
  options: { ack?: boolean; discover?: boolean; silent?: boolean; ping?: boolean } = {},
) {
  const sockets = new Set<Socket>()
  const commands: { topic: string; value: string; header: number }[] = []
  const connects: Buffer[] = []
  const subscriptions: Buffer[] = []
  let pingCount = 0
  let current: Socket | undefined
  const server = createServer((socket) => {
    current = socket
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
    socket.on('error', () => undefined)
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2 && buffer.length >= buffer.readUInt8(1) + 2) {
        const header = buffer.readUInt8(0)
        const body = buffer.subarray(2, buffer.readUInt8(1) + 2)
        buffer = buffer.subarray(buffer.readUInt8(1) + 2)
        if (header === 0x10) {
          connects.push(body)
          if (options.silent !== true) {
            socket.write(Buffer.from([0x20]))
            socket.write(Buffer.from([2, 0, 0]))
          }
        } else if (header === 0x82) {
          subscriptions.push(body)
          socket.write(Buffer.from([0x90, 5, 0, 1, 0, 0, 0]))
          if (options.discover !== false)
            socket.write(
              Buffer.concat([
                publish('unit/RCP-1/rcp/status/volatile/active_camera', 'camera-b'),
                publish('unit/RCP-1/rcp_helper/status/volatile/control', 'online'),
                publish('unit/camera-a/camhead/status/persist/number', '102'),
                publish('unit/camera-b/camhead/status/persist/number', '104'),
              ]),
            )
        } else if (header >> 4 === 3) {
          const length = body.readUInt16BE(0)
          commands.push({
            topic: body.subarray(2, length + 2).toString(),
            value: body.subarray(length + 4).toString(),
            header,
          })
          if (options.ack !== false)
            socket.write(
              Buffer.concat([Buffer.from([0x40, 2]), body.subarray(length + 2, length + 4)]),
            )
        } else if (header === 0xc0) {
          pingCount += 1
          if (options.ping !== false) socket.write(Buffer.from([0xd0, 0]))
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  return {
    get pingCount() {
      return pingCount
    },
    port: address.port,
    commands,
    connects,
    subscriptions,
    send: (topic: string, value: string, retained = false) =>
      current?.write(publish(topic, value, retained)),
    raw: (bytes: number[]) => current?.write(Buffer.from(bytes)),
    disconnect: () => current?.destroy(),
  }
}
function manager(port: number, timeout = 300) {
  const manager = new CyanViewRcpConnectionManager()
  cleanups.push(() => {
    manager.stop()
  })
  const definition = CyanViewRcpConnectionDefinitionSchema.parse({
    connectionId: ID,
    type: 'cyanview-rcp',
    name: 'RCP',
    host: '127.0.0.1',
    port,
    requestTimeoutMs: timeout,
    enabled: true,
    schemaVersion: 1,
  })
  manager.reconcile([definition])
  return { manager, definition }
}
async function ready(manager: CyanViewRcpConnectionManager) {
  await expect.poll(() => manager.snapshots()[0]?.phase).toBe('ready')
}

describe('CyanView RCP MQTT control', () => {
  it('clears feedback when the broker stops answering keepalive pings', async () => {
    const fake = await broker({ ping: false })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect.poll(() => fake.pingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connections.snapshots()[0]).toMatchObject({
      phase: 'unavailable',
      activeCameraNumber: null,
      lastError: 'CyanView RCP stopped responding',
    })
  })

  it('discovers the panel, publishes a non-retained camera number, and uses only incoming state for feedback', async () => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    expect(connections.snapshots()[0]).toMatchObject({
      panelId: 'RCP-1',
      activeCameraNumber: 104,
      lastError: null,
    })
    expect(fake.connects[0]?.subarray(0, 10)).toEqual(
      Buffer.from([0, 4, 77, 81, 84, 84, 4, 2, 0, 20]),
    )
    expect(fake.subscriptions[0]?.toString()).toContain('+/+/rcp/status/volatile/active_camera')
    expect(fake.subscriptions[0]?.toString()).not.toContain('#')
    await connections.selectCamera(ID, 102)
    expect(fake.commands).toEqual([
      { topic: 'unit/RCP-1/rcp/action/set/active_camera_number', value: '102', header: 0x32 },
    ])
    expect(connections.snapshots()[0]?.activeCameraNumber).toBe(104)
    fake.send('unit/RCP-1/rcp/status/volatile/active_camera', 'camera-a')
    await expect.poll(() => connections.snapshots()[0]?.activeCameraNumber).toBe(102)
    fake.send('unit/camera-a/camhead/status/persist/number', '')
    await expect.poll(() => connections.snapshots()[0]?.activeCameraNumber).toBeNull()
  })

  it('rejects invalid and unknown targets without publishing', async () => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    for (const number of [0, -1, 1.2, 1_000_000, NaN])
      await expect(connections.selectCamera(ID, number)).rejects.toMatchObject({
        code: 'cyanview_invalid_request',
      })
    await expect(connections.selectCamera(ID, 103)).rejects.toMatchObject({
      code: 'cyanview_camera_not_found',
    })
    await expect(connections.selectCamera('missing', 102)).rejects.toMatchObject({
      code: 'cyanview_unconfigured',
    })
    await expect(connections.selectCamera(ID, 102, AbortSignal.abort())).rejects.toThrow(
      'cancelled',
    )
    expect(fake.commands).toEqual([])
  })

  it('clears stale feedback and rejects pending commands on disconnect, then reconnects without replay', async () => {
    const fake = await broker({ ack: false })
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    const pending = expect(connections.selectCamera(ID, 102)).rejects.toMatchObject({
      code: 'cyanview_unavailable',
    })
    await expect.poll(() => fake.commands.length).toBe(1)
    fake.disconnect()
    await pending
    expect(connections.snapshots()[0]).toMatchObject({
      phase: 'unavailable',
      activeCameraNumber: null,
      panelId: null,
    })
    await expect.poll(() => fake.connects.length, { timeout: 4000 }).toBe(2)
    await ready(connections)
    expect(fake.commands).toHaveLength(1)
  })

  it('disables selection for offline or ambiguous panels and reports missing discovery', async () => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    fake.send('unit/RCP-1/rcp_helper/status/volatile/control', 'offline')
    await expect.poll(() => connections.snapshots()[0]?.lastError).toContain('offline')
    await expect(connections.selectCamera(ID, 102)).rejects.toThrow('offline')
    fake.send('unit/RCP-1/rcp_helper/status/volatile/control', 'online')
    await ready(connections)
    fake.send('unit/RCP-2/rcp/status/volatile/active_camera', 'camera-a')
    await expect.poll(() => connections.snapshots()[0]?.lastError).toContain('More than one')
    await expect(connections.selectCamera(ID, 102)).rejects.toThrow('More than one')
    expect(connections.snapshots()[0]?.activeCameraNumber).toBeNull()
    const empty = await broker({ discover: false })
    const { manager: noPanel } = manager(empty.port)
    await expect.poll(() => noPanel.snapshots()[0]?.lastError).toContain('No CyanView RCP')
  })

  it('bounds pending work, times out without replay, and handles cancellation', async () => {
    const fake = await broker({ ack: false })
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    const controller = new AbortController()
    const aborted = expect(
      connections.selectCamera(ID, 102, controller.signal),
    ).rejects.toThrow('cancelled')
    controller.abort()
    await aborted
    const pending = Array.from({ length: 16 }, () =>
      expect(connections.selectCamera(ID, 104)).rejects.toMatchObject({
        code: 'cyanview_timeout',
      }),
    )
    await expect(connections.selectCamera(ID, 102)).rejects.toThrow('too many')
    await Promise.all(pending)
    expect(fake.commands).toHaveLength(17)
  })

  it('reconciles settings, refreshes, removes sessions, and isolates observers', async () => {
    const fake = await broker()
    const { manager: connections, definition } = manager(fake.port)
    const listener = vi.fn()
    const unsubscribe = connections.subscribe(listener)
    connections.subscribe(() => {
      throw new Error('observer')
    })
    await ready(connections)
    connections.reconcile([{ ...definition, name: 'Renamed' }])
    expect(connections.snapshots()[0]?.definition.name).toBe('Renamed')
    expect(fake.connects).toHaveLength(1)
    connections.refresh()
    await expect.poll(() => fake.connects.length).toBe(2)
    await ready(connections)
    connections.reconcile([{ ...definition, requestTimeoutMs: 400 }])
    await expect.poll(() => fake.connects.length).toBe(3)
    connections.reconcile([{ ...definition, enabled: false }])
    expect(connections.snapshots()).toEqual([])
    unsubscribe()
    connections.stop()
    expect(() => {
      connections.reconcile([])
    }).toThrow('stopped')
    expect(listener).toHaveBeenCalled()
  })

  it.each([
    [0x20, 2, 0, 5],
    [0x30, 255, 255, 255, 255],
    [0x30, 2, 255, 255],
    [0xe0, 0],
  ])('rejects malformed or unexpected packets %j', async (...bytes) => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    fake.raw(bytes)
    await expect.poll(() => connections.snapshots()[0]?.lastError).toContain('invalid MQTT')
    expect(connections.snapshots()[0]?.activeCameraNumber).toBeNull()
  })

  it('times out a broker that never completes the MQTT handshake', async () => {
    const fake = await broker({ silent: true })
    const { manager: connections } = manager(fake.port, 100)
    await expect.poll(() => connections.snapshots()[0]?.lastError).toContain('timed out')
  })
})

describe('CyanView RCP recording commands', () => {
  it('resolves a camera number independently of panel selection and publishes each toggle only once', async () => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    await connections.recordCamera(ID, 102)
    await connections.recordCamera(ID, 104)
    await connections.recordGroupAll(ID)
    expect(fake.commands).toEqual([
      { topic: 'unit/camera-a/camhead/action/set/keyboard', value: 'RecToggle', header: 0x32 },
      { topic: 'unit/camera-b/camhead/action/set/keyboard', value: 'RecToggle', header: 0x32 },
      { topic: 'unit/All/camgroup/action/set/keyboard', value: 'RecToggle', header: 0x32 },
    ])
    expect(connections.snapshots()[0]?.activeCameraNumber).toBe(104)
  })
  it('rejects invalid, missing, ambiguous and cancelled camera targets without sending a toggle', async () => {
    const fake = await broker()
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    for (const camera of [0, -1, 1.5, 1_000_000, NaN])
      await expect(connections.recordCamera(ID, camera)).rejects.toMatchObject({
        code: 'cyanview_invalid_request',
      })
    await expect(connections.recordCamera(ID, 103)).rejects.toMatchObject({
      code: 'cyanview_camera_not_found',
    })
    await expect(connections.recordCamera('missing', 102)).rejects.toMatchObject({
      code: 'cyanview_unconfigured',
    })
    await expect(connections.recordGroupAll('missing')).rejects.toMatchObject({
      code: 'cyanview_unconfigured',
    })
    await expect(connections.recordCamera(ID, 102, AbortSignal.abort())).rejects.toThrow(
      'cancelled',
    )
    await expect(connections.recordGroupAll(ID, AbortSignal.abort())).rejects.toThrow(
      'cancelled',
    )
    fake.send('unit/duplicate/camhead/status/persist/number', '102')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(connections.recordCamera(ID, 102)).rejects.toThrow('More than one camera')
    fake.send('unit/RCP-1/rcp_helper/status/volatile/control', 'offline')
    await expect.poll(() => connections.snapshots()[0]?.phase).toBe('unavailable')
    await expect(connections.recordGroupAll(ID)).rejects.toThrow('offline')
    expect(fake.commands).toEqual([])
  })
  it('does not replay a recording toggle after lost acknowledgement and reconnect', async () => {
    const fake = await broker({ ack: false })
    const { manager: connections } = manager(fake.port)
    await ready(connections)
    const result = expect(connections.recordGroupAll(ID)).rejects.toMatchObject({
      code: 'cyanview_unavailable',
    })
    await expect.poll(() => fake.commands.length).toBe(1)
    fake.disconnect()
    await result
    await expect.poll(() => fake.connects.length, { timeout: 4000 }).toBe(2)
    await ready(connections)
    expect(fake.commands).toHaveLength(1)
  })
})
