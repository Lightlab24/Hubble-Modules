import net, { type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvertzQuartzConnectionDefinitionSchema,
  type EvertzQuartzConnectionDefinition,
} from '../src/config.js'
import { EvertzQuartzConnectionManager } from '../src/evertz-quartz-connection-manager.js'
import { EvertzQuartzClient } from '../src/quartz/client.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function simulator(
  override?: (command: string, socket: Socket) => boolean,
  overrides: Partial<EvertzQuartzConnectionDefinition> = {},
) {
  const commands: string[] = []
  const sockets = new Set<Socket>()
  const routes = new Map([
    ['V1', 1],
    ['A1', 1],
    ['V2', 2],
    ['A2', 2],
  ])
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString('ascii')
      let end: number
      while ((end = buffer.indexOf('\r')) >= 0) {
        const command = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        commands.push(command)
        if (override?.(command, socket)) continue
        const read = /^\.I([A-Z])(\d+)$/u.exec(command)
        const take = /^\.S([A-Z]+)(\d+),(\d+)$/u.exec(command)
        const name = /^\.R([SD])(\d+)$/u.exec(command)
        const lock = /^\.B([LUI])(\d+)$/u.exec(command)
        if (command === '.#01') socket.write('.A\r')
        else if (read !== null)
          socket.write(
            `.A${read[1] ?? ''}${read[2] ?? ''},${String(routes.get(`${read[1] ?? ''}${read[2] ?? ''}`) ?? 1)}\r`,
          )
        else if (take !== null) {
          let changed = ''
          for (const level of take[1] ?? '') {
            const key = `${level}${take[2] ?? ''}`
            if (routes.get(key) !== Number(take[3])) changed += level
            routes.set(key, Number(take[3]))
          }
          socket.write('.A\r')
          if (changed !== '') socket.write(`.U${changed}${take[2] ?? ''},${take[3] ?? ''}\r`)
        } else if (name !== null)
          socket.write(
            `.RA${name[1] ?? ''}${name[2] ?? ''},${name[1] === 'S' ? 'Camera' : 'Monitor'} ${name[2] ?? ''}\r`,
          )
        else if (lock !== null)
          socket.write(`.BA${lock[2] ?? ''},${lock[1] === 'L' ? '255' : '0'}\r`)
        else if (command === '.F3') socket.write('.A\r')
        else socket.write('.E\r')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
  })
  const address = server.address() as net.AddressInfo
  const definition = EvertzQuartzConnectionDefinitionSchema.parse({
    connectionId: 'a073f4cf-2251-44ee-afc9-ec2b097d2f90',
    type: 'evertz-quartz',
    name: 'Quartz simulator',
    enabled: true,
    host: '127.0.0.1',
    port: address.port,
    sourceLimit: 2,
    destinationLimit: 2,
    levelSystem: '8-level',
    levels: 2,
    refreshIntervalSeconds: 60,
    requestTimeoutMs: 200,
    reconnectDelayMs: 100,
    schemaVersion: 1,
    ...overrides,
  })
  const client = new EvertzQuartzClient(definition)
  cleanup.push(() => {
    client.disconnect()
  })
  return { client, commands, sockets, routes, definition, server }
}

async function ready(client: EvertzQuartzClient, routeCount = 4): Promise<void> {
  await client.connect()
  await expect.poll(() => client.snapshot().routes.length).toBe(routeCount)
}

describe('native Evertz Quartz TCP client', () => {
  it('sends the CyanView link test only after TCP succeeds, including recovery from refusal', async () => {
    const { client, definition, commands, server } = await simulator()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )

    await expect(client.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(client.snapshot().phase).toBe('disconnected')
    expect(commands).toEqual([])

    await new Promise<void>((resolve) =>
      server.listen(definition.port, definition.host, resolve),
    )
    await ready(client)
    expect(commands[0]).toBe('.#01')
    expect(client.snapshot().phase).toBe('connected')
  })

  it('allows independent clients to use the same configured MAGNUM TCP port', async () => {
    const { client, definition, sockets } = await simulator(undefined, {
      levelSystem: 'magnum',
    })
    const secondClient = new EvertzQuartzClient(definition)
    cleanup.push(() => {
      secondClient.disconnect()
    })

    await Promise.all([client.connect(), secondClient.connect()])
    expect(sockets.size).toBe(2)
    expect(client.snapshot().controlReady).toBe(true)
    expect(secondClient.snapshot().controlReady).toBe(true)
    await client.readDestination(1)
    await secondClient.readDestination(2)
    expect(sockets.size).toBe(2)
  })

  it('accepts the AN65 power-up banner before the first route reply', async () => {
    const { client } = await simulator((command, socket) => {
      if (command !== '.IV1') return false
      socket.write('\r.P\r.AV1,1\r')
      return true
    })
    await ready(client)
    expect(client.snapshot().controlReady).toBe(true)
  })

  it('invalidates partial startup state after an AN65 reset and starts a fresh synchronization', async () => {
    let resetSent = false
    const { client, routes } = await simulator((command, socket) => {
      if (command !== '.IA1' || resetSent) return false
      resetSent = true
      routes.set('V1', 2)
      socket.write('\r.P\r.AA1,1\r')
      return true
    })

    await client.connect()
    await expect.poll(() => client.snapshot().phase).toBe('disconnected')
    expect(client.snapshot().lastError).toContain('restarted')
    expect(client.snapshot().controlReady).toBe(false)
    await ready(client)
    expect(client.snapshot().routes).toContainEqual({ level: 1, destination: 1, source: 2 })
    expect(client.snapshot().controlReady).toBe(true)
  })

  it('discards remaining frames from a TCP chunk after an AN65 reset invalidates the session', async () => {
    const { client, sockets } = await simulator()
    await ready(client)
    for (const socket of sockets) socket.write('\r.P\r.UV1,2\r')

    await expect.poll(() => client.snapshot().phase).toBe('disconnected')
    expect(client.snapshot().routes).toContainEqual({ level: 1, destination: 1, source: 1 })
  })

  it('supports a configured MAGNUM interface across all 26 Quartz level letters', async () => {
    const { client, commands } = await simulator(undefined, {
      levelSystem: 'magnum',
      levels: 26,
    })
    await ready(client, 52)
    expect(commands).toContain('.IZ2')
    expect(client.snapshot().routes).toHaveLength(52)
    expect(client.snapshot().levels.at(-1)).toEqual({ level: 26, label: 'Z' })
    await client.setCrosspoint({ source: 2, destination: 1, levels: [1, 26] })
    expect(commands.slice(-3)).toEqual(['.SVZ1,2', '.IV1', '.IZ1'])
  })

  it('resynchronizes manager state after a controller drops the TCP connection', async () => {
    const { definition, commands, sockets, routes } = await simulator()
    const manager = new EvertzQuartzConnectionManager()
    cleanup.push(() => {
      manager.stop()
    })
    manager.reconcile([definition])
    await expect.poll(() => manager.snapshots()[0]?.routes.routes.get(2)?.get(2)).toBe(2)
    expect(manager.snapshots()[0]?.destinationLocks).toEqual([])
    await manager.directRoute({
      connectionId: definition.connectionId,
      source: 2,
      destination: 1,
      levels: [1, 2],
    })
    expect(manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(2)
    for (const socket of sockets) socket.write('.BA2,5\r')
    await expect
      .poll(() => manager.snapshots()[0]?.destinationLocks)
      .toContainEqual({ destination: 2, owner: 5 })
    routes.set('V1', 1)
    for (const socket of sockets) socket.destroy()
    await expect.poll(() => commands.filter((c) => c === '.#01').length).toBe(2)
    await expect.poll(() => manager.snapshots()[0]?.phase).toBe('connected')
    await expect.poll(() => manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(1)
  })

  it('keeps optional names and locks out of startup and reports explicit lock rejection without disconnecting', async () => {
    const { client, commands } = await simulator((command, socket) => {
      if (command === '.BI1') {
        socket.write('.E\r')
        return true
      }
      return false
    })
    await ready(client)
    expect(commands.some((command) => /^\.[RB]/u.test(command))).toBe(false)
    await expect(client.readDestinationLock(1)).rejects.toThrow('Quartz rejected .BI1')
    expect(commands).not.toContain('.BI2')
    expect(client.destinationLocks().size).toBe(0)
    expect(client.snapshot().phase).toBe('connected')
  })

  it('synchronizes configured bounds and confirms a multi-level take by update and readback', async () => {
    const { client, commands, sockets } = await simulator()
    await ready(client)
    expect(client.snapshot().phase).toBe('connected')
    expect(client.snapshot().sources[0]?.label).toBe('Source 1')
    expect(commands).toEqual(['.#01', '.IV1', '.IA1', '.IV2', '.IA2'])
    await client.setCrosspoint({ source: 2, destination: 1, levels: [1, 2] })
    expect(commands.slice(-3)).toEqual(['.SVA1,2', '.IV1', '.IA1'])
    for (const socket of sockets) socket.write('.UV2,1\r')
    await expect
      .poll(
        () =>
          client
            .snapshot()
            .routes.find(({ destination, level }) => destination === 2 && level === 1)?.source,
      )
      .toBe(1)
  })

  it('uses Evertz destination-only lock syntax and system salvo acknowledgement', async () => {
    const { client, commands } = await simulator()
    await ready(client)
    await client.setDestinationLock(2, true)
    expect(client.destinationLocks().get(2)).toBe(255)
    await client.setDestinationLock(2, false)
    expect(await client.readDestinationLock(2)).toBe(0)
    await client.recallSalvo(3)
    expect(commands).toEqual(expect.arrayContaining(['.BL2', '.BU2', '.BI2', '.F3']))
    await expect(client.recallSalvo(33)).rejects.toThrow()
  })

  it('accepts legacy unindexed names and stops scanning a rejected name table', async () => {
    const { client, commands } = await simulator((command, socket) => {
      if (command === '.RS1') {
        socket.write('.RASCAMERA 1\r')
        return true
      }
      if (command === '.RD1') {
        socket.write('.E\r')
        return true
      }
      return false
    })
    await ready(client)
    await client.refreshNames()
    expect(client.snapshot().sources[0]?.label).toBe('CAMERA 1')
    expect(commands).not.toContain('.RD2')
    expect(client.snapshot().phase).toBe('connected')
  })

  it('never treats a bare acknowledgement as a confirmed route and cancels queued work on timeout', async () => {
    const { client, commands } = await simulator((command, socket) => {
      if (command.startsWith('.S')) {
        socket.write('.A\r')
        return true
      }
      return false
    })
    await ready(client)
    const take = client.setCrosspoint({ source: 2, destination: 1, levels: [1] })
    await expect.poll(() => commands.includes('.SV1,2')).toBe(true)
    const lock = client.setDestinationLock(2, true)
    const result = await Promise.allSettled([take, lock])
    expect(result.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
    expect(client.snapshot().phase).toBe('disconnected')
    expect(commands).not.toContain('.BL2')
    await ready(client)
    expect(client.snapshot().phase).toBe('connected')
  })

  it('logs rejected watched crosspoints without dropping a live Quartz session', async () => {
    const { client } = await simulator((command, socket) => {
      if (command === '.IV2') {
        socket.write('.E\r')
        return true
      }
      return false
    })
    await ready(client, 3)
    expect(client.snapshot().lastError).toContain('Quartz rejected .IV2')
    expect(
      client
        .snapshot()
        .routes.some(({ destination, level }) => destination === 2 && level === 1),
    ).toBe(false)
    expect(client.snapshot().phase).toBe('connected')
  })

  it('retries the link test every second and waits for a bare ACK before sending interrogation commands', async () => {
    let pings = 0
    const { client, commands } = await simulator((command, socket) => {
      if (command !== '.#01') return false
      pings += 1
      if (pings === 1) socket.write('.AV001,001\r.unsupported\r.E\r')
      else socket.write('.A\r')
      return true
    })
    const connecting = client.connect()
    await expect.poll(() => pings).toBe(1)
    expect(client.snapshot().controlReady).toBe(false)
    expect(commands).toEqual(['.#01'])
    await connecting
    expect(commands.slice(0, 2)).toEqual(['.#01', '.#01'])
    expect(client.snapshot().controlReady).toBe(true)
  })

  it('reports the link online after the first ACK while watched routes are still being read', async () => {
    const { client, commands } = await simulator((command) => command.startsWith('.I'))
    await client.connect()
    expect(client.snapshot().controlReady).toBe(true)
    expect(client.snapshot().routes).toEqual([])
    expect(commands[0]).toBe('.#01')
  })

  it('uses Quartz ping keep-alives even with route polling disabled, and stops them on disconnect', async () => {
    const { client, commands } = await simulator(undefined, { refreshIntervalSeconds: 0 })
    await ready(client)
    await expect
      .poll(() => commands.filter((c) => c === '.#01').length, { timeout: 2500 })
      .toBe(2)
    expect(commands.filter((c) => c.startsWith('.I'))).toHaveLength(4)
    client.disconnect()
    const count = commands.length
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(commands).toHaveLength(count)
  })

  it('disconnects an open socket when repeated Quartz keep-alives receive no ACK', async () => {
    let firstPing = true
    const { client, commands } = await simulator(
      (command) => {
        if (command !== '.#01') return false
        if (firstPing) {
          firstPing = false
          return false
        }
        return true
      },
      { refreshIntervalSeconds: 0 },
    )
    await ready(client)
    await expect.poll(() => client.snapshot().phase, { timeout: 7500 }).toBe('disconnected')
    expect(client.snapshot().lastError).toContain('.#01')
    expect(commands.filter((c) => c === '.#01').length).toBeGreaterThanOrEqual(5)
  }, 10_000)

  it('completes an already-routed take without waiting for a nonexistent update', async () => {
    const { client, commands } = await simulator()
    await ready(client)
    const before = commands.length
    await client.setCrosspoint({ source: 1, destination: 1, levels: [1, 2] })
    expect(commands).toHaveLength(before)
    expect(client.snapshot().phase).toBe('connected')
  })

  it('waits only for changed levels and serializes repeated takes against the latest routing table', async () => {
    const { client, routes } = await simulator()
    routes.set('V1', 2)
    await ready(client)
    await client.setCrosspoint({ source: 2, destination: 1, levels: [1, 2] })
    await Promise.all([
      client.setCrosspoint({ source: 1, destination: 1, levels: [1, 2] }),
      client.setCrosspoint({ source: 2, destination: 1, levels: [1, 2] }),
    ])
    expect(
      client
        .snapshot()
        .routes.filter(({ destination }) => destination === 1)
        .every(({ source }) => source === 2),
    ).toBe(true)
    expect(client.snapshot().phase).toBe('connected')
  })

  it('accepts padded .AV and .UVAB feedback and ignores unconfigured levels and destinations', async () => {
    const { client, sockets } = await simulator(undefined, { levels: 1 })
    await ready(client, 2)
    for (const socket of sockets)
      socket.write('.UVAB001,002\r.UA002,001\r.UV999,002\r.unknown\r')
    await expect
      .poll(() => client.snapshot().routes.find(({ destination }) => destination === 1)?.source)
      .toBe(2)
    expect(client.snapshot().routes).toHaveLength(2)
    expect(client.snapshot().routes.find(({ destination }) => destination === 2)?.source).toBe(
      2,
    )
    expect(client.snapshot().phase).toBe('connected')
  })

  it('accepts an interrogation-format route confirmation without treating the bare ACK as confirmation', async () => {
    const { client, routes } = await simulator((command, socket) => {
      if (command !== '.SV1,2') return false
      routes.set('V1', 2)
      socket.write('.A\r.AV001,002\r')
      return true
    })
    await ready(client)
    await client.setCrosspoint({ source: 2, destination: 1, levels: [1] })
    expect(client.snapshot().routes).toContainEqual({ destination: 1, level: 1, source: 2 })
  })

  it('retains an unknown source and clears previous feedback without disconnecting the manager', async () => {
    const { client, definition, sockets } = await simulator()
    const manager = new EvertzQuartzConnectionManager()
    cleanup.push(() => {
      manager.stop()
    })
    await ready(client)
    manager.reconcile([definition])
    await expect.poll(() => manager.snapshots()[0]?.routes.routes.get(1)?.get(1)).toBe(1)
    for (const socket of sockets) socket.write('.UV001,055\r')
    await expect
      .poll(
        () =>
          client
            .snapshot()
            .routes.find(({ destination, level }) => destination === 1 && level === 1)?.source,
      )
      .toBe(55)
    await expect
      .poll(() => manager.snapshots()[0]?.routes.routes.get(1)?.get(1))
      .toBeUndefined()
    expect(client.snapshot().phase).toBe('connected')
    expect(manager.snapshots()[0]?.phase).toBe('connected')
    await expect(client.setCrosspoint({ source: 55, destination: 1 })).rejects.toThrow()
  })

  it('accepts an unknown source in the initial interrogation and keeps command errors nonfatal', async () => {
    const { client, routes, sockets } = await simulator()
    routes.set('V1', 55)
    await ready(client)
    expect(await client.readDestination(1, [1])).toEqual([
      { destination: 1, source: 55, level: 1 },
    ])
    for (const socket of sockets) socket.write('.E\r.UV001,002\r')
    await expect
      .poll(
        () =>
          client
            .snapshot()
            .routes.find(({ destination, level }) => destination === 1 && level === 1)?.source,
      )
      .toBe(2)
    expect(client.snapshot().lastError).toContain('Quartz rejected')
    expect(client.snapshot().phase).toBe('connected')
  })
})
