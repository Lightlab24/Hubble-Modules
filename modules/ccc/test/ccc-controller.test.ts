import { RcpSession } from '@hubble/protocol-cyanview-rcp'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CccController, type CccStore } from '../src/ccc-controller.js'
import {
  applyCccMutation,
  CccConfigSchema,
  CyanViewRcpConnectionDefinitionSchema,
  type CccConfig,
  type CccRow,
} from '../src/config.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function packet(header: number, body: Buffer): Buffer {
  let length = body.length
  const bytes: number[] = []
  do {
    let byte = length % 128
    length = Math.floor(length / 128)
    if (length) byte |= 128
    bytes.push(byte)
  } while (length)
  return Buffer.concat([Buffer.from([header, ...bytes]), body])
}
function publish(topic: string, value: string, retained = false) {
  const text = Buffer.from(topic)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(text.length)
  return packet(retained ? 0x31 : 0x30, Buffer.concat([length, text, Buffer.from(value)]))
}
async function broker() {
  const sockets = new Set<Socket>()
  const commands: { topic: string; value: string; header: number }[] = []
  const recordings = new Map<string, string>()
  const controls = {
    acknowledge: true,
    feedback: true,
    retainedFeedback: false,
    ignoredCamera: '',
    ackDelay: 0,
    initialRecording: '0' as string | null,
    variableNd: false,
  }
  let connections = 0
  let inFlight = 0
  let maxInFlight = 0
  const timers: ReturnType<typeof setTimeout>[] = []
  const send = (topic: string, value: string, retained = false) => {
    if (topic.endsWith('/recording')) recordings.set(topic, value)
    for (const socket of sockets) socket.write(publish(topic, value, retained))
  }
  const server = createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        let length = 0
        let offset = 1
        let multiplier = 1
        for (;;) {
          const byte = buffer[offset]
          if (byte === undefined) return
          offset += 1
          length += (byte & 127) * multiplier
          multiplier *= 128
          if (!(byte & 128)) break
        }
        if (buffer.length < offset + length) return
        const header = buffer.readUInt8(0)
        const body = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (header === 0x10) socket.write(Buffer.from([0x20, 2, 0, 0]))
        else if (header === 0x82) {
          let count = 0
          for (let index = 2; index < body.length; count += 1)
            index += body.readUInt16BE(index) + 3
          socket.write(packet(0x90, Buffer.concat([body.subarray(0, 2), Buffer.alloc(count)])))
          socket.write(publish('unit/RCP/rcp_helper/status/volatile/control', 'online', true))
          for (const [id, number] of [
            ['a', '101'],
            ['b', '102'],
          ] as const) {
            socket.write(publish(`unit/${id}/camhead/status/persist/number`, number, true))
            socket.write(
              publish(`unit/${id}/camhead/status/persist/name`, `Camera ${id}`, true),
            )
            socket.write(publish(`unit/${id}/camhead/status/volatile/control`, 'online', true))
            if (controls.variableNd)
              socket.write(
                publish(`unit/${id}/camhead/status/persist/nd_filter_clear`, '0', true),
              )
            if (controls.initialRecording !== null) {
              const recordingTopic = `unit/${id}/camhead/status/volatile/recording`
              recordings.set(recordingTopic, controls.initialRecording)
              socket.write(publish(recordingTopic, controls.initialRecording, true))
            }
          }
        } else if (header >> 4 === 3) {
          const size = body.readUInt16BE(0)
          const topic = body.subarray(2, size + 2).toString()
          const value = body.subarray(size + 4).toString()
          commands.push({ topic, value, header })
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          if (controls.acknowledge && !topic.includes(`/${controls.ignoredCamera}/`)) {
            const acknowledge = () => {
              inFlight -= 1
              socket.write(packet(0x40, body.subarray(size + 2, size + 4)))
            }
            if (controls.ackDelay) timers.push(setTimeout(acknowledge, controls.ackDelay))
            else acknowledge()
          }
          if (!topic.endsWith('/action/set/keyboard')) continue
          const recordingTopic = topic.replace(
            'action/set/keyboard',
            'status/volatile/recording',
          )
          const recording =
            value === 'Rec' || (value === 'RecToggle' && recordings.get(recordingTopic) !== '1')
              ? '1'
              : '0'
          recordings.set(recordingTopic, recording)
          if (controls.feedback)
            socket.write(publish(recordingTopic, recording, controls.retainedFeedback))
        } else if (header === 0xc0) socket.write(Buffer.from([0xd0, 0]))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing broker address')
  cleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  return {
    port: address.port,
    get maxInFlight() {
      return maxInFlight
    },
    commands,
    controls,
    send,
    get connections() {
      return connections
    },
    disconnect() {
      for (const socket of sockets) socket.destroy()
    },
  }
}
const row = (ip: string, number: number | null, enabled = true): CccRow => ({
  rowId: randomUUID(),
  rcpIp: ip,
  cameraNumber: number,
  enabled,
})
type Brokers = Map<string, Awaited<ReturnType<typeof broker>>>
function sessionDefinition(definition: unknown, brokers: Brokers) {
  const parsed = CyanViewRcpConnectionDefinitionSchema.parse(definition)
  const endpoint = brokers.get(parsed.host)
  if (!endpoint) throw new Error('Missing broker fixture')
  return { ...parsed, host: '127.0.0.1', port: endpoint.port, requestTimeoutMs: 150 }
}
describe.each([
  {
    label: 'source',
    create: (store: CccStore, brokers: Brokers) =>
      new CccController(
        store,
        100,
        (definition, changed) =>
          new RcpSession(sessionDefinition(definition, brokers), changed, true),
      ),
  },
])('CCC shared controller ($label)', ({ create }) => {
  async function controller(
    rows: readonly CccRow[],
    brokers: Map<string, Awaited<ReturnType<typeof broker>>>,
  ) {
    const workspaceId = randomUUID()
    let config: CccConfig = CccConfigSchema.parse({ revision: 0, rows })
    const ccc = create(
      {
        read: () => Promise.resolve(config),
        mutate: (request) => {
          if (request.workspaceId !== workspaceId) throw new Error('Wrong workspace')
          config = applyCccMutation(config, request.mutation)
          return Promise.resolve(config)
        },
      },
      brokers,
    )
    cleanups.push(() => {
      ccc.stop()
    })
    await ccc.activate(workspaceId)
    await expect
      .poll(() => ccc.state().rows.filter((item) => item.connection === 'online').length)
      .toBe(
        rows.filter(
          (item) =>
            item.rcpIp && item.cameraNumber !== null && [101, 102].includes(item.cameraNumber),
        ).length,
      )
    return { ccc, workspaceId }
  }

  it('toggles all complete cameras together and serializes repeated presses without changing incomplete rows', async () => {
    const a = await broker()
    const rows = [row('192.0.2.1', 101), row('192.0.2.1', 102, false), row('', null, false)]
    const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
    const toggle = () => ccc.command({ workspaceId, command: 'enable-all-cameras' })
    await toggle()
    expect(ccc.state().config.rows.map((item) => item.enabled)).toEqual([true, true, false])
    await toggle()
    expect(ccc.state().config.rows.map((item) => item.enabled)).toEqual([false, false, false])
    await Promise.all([toggle(), toggle(), toggle()])
    expect(ccc.state().config.rows.map((item) => item.enabled)).toEqual([true, true, false])
    expect(a.commands).toEqual([])
  })

  it.each(['enable-camera', 'disable-camera', 'toggle-camera-enabled'] as const)(
    'uses %s as the same reversible camera toggle',
    async (command) => {
      const a = await broker()
      const camera = row('192.0.2.1', 101, false)
      const { ccc, workspaceId } = await controller([camera], new Map([['192.0.2.1', a]]))
      await ccc.command({ workspaceId, command, rowId: camera.rowId })
      expect(ccc.state().config.rows[0]?.enabled).toBe(true)
      await ccc.command({ workspaceId, command, rowId: camera.rowId })
      expect(ccc.state().config.rows[0]?.enabled).toBe(false)
      expect(a.commands).toEqual([])
    },
  )

  it('pools endpoints, resolves camera numbers, sends explicit nonretained commands without capabilities, and confirms fresh feedback', async () => {
    const a = await broker()
    const b = await broker()
    const rows = [
      row('192.0.2.1', 102),
      row('192.0.2.1', 101, false),
      row('192.0.2.2', 101),
      row('', null),
    ]
    const { ccc, workspaceId } = await controller(
      rows,
      new Map([
        ['192.0.2.1', a],
        ['192.0.2.2', b],
      ]),
    )
    expect(a.connections).toBe(1)
    expect(b.connections).toBe(1)
    expect(ccc.state().rows[0]?.name).toBe('Camera b')
    const roll = await ccc.command({ workspaceId, command: 'roll-enabled-cameras' })
    expect(roll.results.map((result) => result.phase)).toEqual(['confirmed', 'confirmed'])
    expect(a.commands).toEqual([
      { topic: 'unit/b/camhead/action/set/keyboard', value: 'Rec', header: 0x32 },
    ])
    expect(b.commands[0]?.value).toBe('Rec')
    await ccc.command({ workspaceId, command: 'enable-camera', rowId: rows[1]?.rowId ?? '' })
    await ccc.command({ workspaceId, command: 'disable-camera', rowId: rows[0]?.rowId ?? '' })
    await ccc.command({ workspaceId, command: 'stop-enabled-cameras' })
    expect(a.commands[1]).toMatchObject({
      topic: 'unit/a/camhead/action/set/keyboard',
      value: 'Stop',
    })
    expect(ccc.state().config.rows.map((item) => item.enabled)).toEqual([
      false,
      true,
      true,
      true,
    ])
    await expect(
      ccc.command({ workspaceId: randomUUID(), command: 'enable-all-cameras' }),
    ).rejects.toThrow('workspace')
  })

  it('toggles each enabled camera with RecToggle across RCPs and orders repeated presses using fresh feedback', async () => {
    const a = await broker()
    const b = await broker()
    const rows = [row('192.0.2.1', 101), row('192.0.2.1', 102, false), row('192.0.2.2', 101)]
    const { ccc, workspaceId } = await controller(
      rows,
      new Map([
        ['192.0.2.1', a],
        ['192.0.2.2', b],
      ]),
    )
    b.send('unit/a/camhead/status/volatile/recording', '1')
    await expect.poll(() => ccc.state().rows[2]?.recording).toBe('recording')
    const first = await ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })
    expect(first.results.map((result) => result.phase)).toEqual(['confirmed', 'confirmed'])
    expect(ccc.state().rows.map((item) => item.recording)).toEqual([
      'recording',
      'stopped',
      'stopped',
    ])
    const second = ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })
    const third = ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })
    for (const result of await Promise.all([second, third]))
      expect(result.results.map((item) => item.phase)).toEqual(['confirmed', 'confirmed'])
    for (const endpoint of [a, b])
      expect(endpoint.commands).toEqual(
        Array.from({ length: 3 }, () => ({
          topic: 'unit/a/camhead/action/set/keyboard',
          value: 'RecToggle',
          header: 0x32,
        })),
      )
    expect(ccc.state().config.rows).toEqual(rows)
  })

  it.each([
    ['nd-up-enabled-cameras', 'next/nd_filter'],
    ['nd-down-enabled-cameras', 'prev/nd_filter'],
    ['iso-up-enabled-cameras', 'next/master_gain'],
    ['iso-down-enabled-cameras', 'prev/master_gain'],
  ] as const)(
    'sends %s only to the captured enabled cameras without changing recording or selection',
    async (command, topic) => {
      const a = await broker()
      const b = await broker()
      a.controls.initialRecording = '1'
      const rows = [
        row('192.0.2.1', 101),
        row('192.0.2.1', 102, false),
        row('192.0.2.2', 102),
        row('', null),
      ]
      const { ccc, workspaceId } = await controller(
        rows,
        new Map([
          ['192.0.2.1', a],
          ['192.0.2.2', b],
        ]),
      )
      a.send('unit/a/camhead/status/persist/rec_lock', '1')
      await expect.poll(() => ccc.state().rows[0]?.message).toBe('Recording locked')
      const before = ccc.state()
      const result = await ccc.command({ workspaceId, command })
      expect(a.commands).toEqual([
        { topic: `unit/a/camhead/action/${topic}`, value: '', header: 0x32 },
      ])
      expect(b.commands).toEqual([
        { topic: `unit/b/camhead/action/${topic}`, value: '', header: 0x32 },
      ])
      expect(result.results.map(({ phase }) => phase)).toEqual(['sent', 'sent'])
      expect(ccc.state().config).toEqual(before.config)
      expect(ccc.state().rows.map(({ recording }) => recording)).toEqual(
        before.rows.map(({ recording }) => recording),
      )
    },
  )

  it('uses one-stop multipliers for variable ND and preserves rapid up/down ordering and captured targets', async () => {
    const a = await broker()
    a.controls.variableNd = true
    a.controls.ackDelay = 20
    const rows = [row('192.0.2.1', 101)]
    const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
    const up = ccc.command({ workspaceId, command: 'nd-up-enabled-cameras' })
    const down = ccc.command({ workspaceId, command: 'nd-down-enabled-cameras' })
    await ccc.mutate({
      workspaceId,
      mutation: {
        kind: 'replace',
        expectedRevision: 0,
        rows: rows.map((item) => ({ ...item, cameraNumber: 102 })),
      },
    })
    expect((await up).results[0]?.phase).toBe('sent')
    expect((await down).results[0]?.phase).toBe('sent')
    expect(a.commands).toEqual([
      { topic: 'unit/a/camhead/action/mult/nd_filter', value: '2', header: 0x32 },
      { topic: 'unit/a/camhead/action/mult/nd_filter', value: '0.5', header: 0x32 },
    ])
    expect(ccc.state().rows[0]?.lastResult).toBeNull()
  })

  it('sends RecToggle with unknown recording status without inventing a confirmation', async () => {
    const a = await broker()
    a.controls.initialRecording = null
    const { ccc, workspaceId } = await controller(
      [row('192.0.2.1', 101)],
      new Map([['192.0.2.1', a]]),
    )
    expect(ccc.state().rows[0]?.recording).toBe('unknown')
    const result = await ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })
    expect(result.results[0]?.phase).toBe('unconfirmed')
    expect(a.commands).toEqual([
      { topic: 'unit/a/camhead/action/set/keyboard', value: 'RecToggle', header: 0x32 },
    ])
    await expect.poll(() => ccc.state().rows[0]?.recording).toBe('recording')
  })

  it('does not confirm a toggle from retained or unchanged recording feedback', async () => {
    const a = await broker()
    const { ccc, workspaceId } = await controller(
      [row('192.0.2.1', 101)],
      new Map([['192.0.2.1', a]]),
    )
    a.controls.retainedFeedback = true
    expect(
      (await ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })).results[0]
        ?.phase,
    ).toBe('unconfirmed')
    a.controls.feedback = false
    const result = ccc.command({ workspaceId, command: 'roll-toggle-enabled-cameras' })
    await expect.poll(() => a.commands.length).toBe(2)
    a.send('unit/a/camhead/status/volatile/recording', '1')
    expect((await result).results[0]?.phase).toBe('unconfirmed')
  })

  it.each(['roll-enabled-cameras', 'roll-toggle-enabled-cameras'] as const)(
    'continues after offline, locked, missing and ambiguous cameras for %s',
    async (command) => {
      const a = await broker()
      const rows = [row('192.0.2.1', 101), row('192.0.2.1', 102), row('192.0.2.1', 999)]
      const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
      a.send('unit/b/camhead/status/persist/rec_lock', '1')
      await expect.poll(() => ccc.state().rows[1]?.message).toBe('Recording locked')
      const roll = await ccc.command({ workspaceId, command })
      expect(roll.results.map((result) => result.phase)).toEqual([
        'confirmed',
        'error',
        'error',
      ])
      expect(a.commands).toHaveLength(1)
      a.send('unit/a/camhead/status/volatile/control', 'offline')
      a.send('unit/c/camhead/status/persist/number', '102')
      await expect.poll(() => ccc.state().rows[0]?.recording).toBe('unknown')
      expect(
        (await ccc.command({ workspaceId, command: 'stop-enabled-cameras' })).results.every(
          (result) => result.phase === 'error',
        ),
      ).toBe(true)
      expect(ccc.state().config.rows.every((item) => item.enabled)).toBe(true)
    },
  )

  it('snapshots selection and addresses, preserves ordering, clears retargeted feedback and reports unconfirmed sends', async () => {
    const a = await broker()
    a.controls.feedback = false
    const rows = [row('192.0.2.1', 101)]
    const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
    const roll = ccc.command({ workspaceId, command: 'roll-enabled-cameras' })
    const stop = ccc.command({ workspaceId, command: 'stop-enabled-cameras' })
    await ccc.mutate({
      workspaceId,
      mutation: {
        kind: 'replace',
        expectedRevision: 0,
        rows: rows.map((item) => ({ ...item, cameraNumber: 102 })),
      },
    })
    expect(ccc.state().rows[0]?.lastResult).toBeNull()
    expect((await roll).results[0]?.phase).toBe('unconfirmed')
    expect((await stop).results[0]?.phase).toBe('unconfirmed')
    expect(a.commands.map(({ topic, value }) => [topic, value])).toEqual([
      ['unit/a/camhead/action/set/keyboard', 'Rec'],
      ['unit/a/camhead/action/set/keyboard', 'Stop'],
    ])
    expect(ccc.state().rows[0]?.lastResult).toBeNull()
    expect(ccc.state().config.rows[0]?.enabled).toBe(true)
    await expect(
      ccc.mutate({ workspaceId, mutation: { kind: 'replace', expectedRevision: 0, rows } }),
    ).rejects.toThrow('changed')
    a.controls.feedback = true
    a.controls.retainedFeedback = true
    expect(
      (await ccc.command({ workspaceId, command: 'roll-enabled-cameras' })).results[0]?.phase,
    ).toBe('unconfirmed')
  })

  it('bounds concurrent publishes and continues after an individual acknowledgement timeout', async () => {
    const a = await broker()
    const rows = Array.from({ length: 8 }, (_, index) => row('192.0.2.1', 101 + index))
    const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
    for (let index = 2; index < 8; index += 1) {
      a.send(`unit/extra-${String(index)}/camhead/status/persist/number`, String(101 + index))
      a.send(`unit/extra-${String(index)}/camhead/status/volatile/control`, 'online')
    }
    await expect
      .poll(() => ccc.state().rows.filter((item) => item.connection === 'online').length)
      .toBe(8)
    a.controls.ackDelay = 20
    a.controls.ignoredCamera = 'a'
    const batch = await ccc.command({ workspaceId, command: 'roll-enabled-cameras' })
    expect(a.commands).toHaveLength(8)
    expect(a.maxInFlight).toBe(4)
    expect(batch.results[0]?.phase).toBe('error')
    expect(batch.results.slice(1).every((result) => result.phase === 'confirmed')).toBe(true)
  })

  it.each([
    'roll-enabled-cameras',
    'roll-toggle-enabled-cameras',
    'nd-up-enabled-cameras',
    'nd-down-enabled-cameras',
    'iso-up-enabled-cameras',
    'iso-down-enabled-cameras',
  ] as const)(
    'does not replay %s across reconnects and enables complete offline rows only',
    async (command) => {
      const a = await broker()
      const rows = [
        row('192.0.2.1', 101, false),
        row('192.0.2.1', 999, false),
        row('', null, false),
      ]
      const { ccc, workspaceId } = await controller(rows, new Map([['192.0.2.1', a]]))
      await expect(ccc.command({ workspaceId, command })).rejects.toThrow('No complete')
      await ccc.command({ workspaceId, command: 'enable-all-cameras' })
      expect(ccc.state().config.rows.map((item) => item.enabled)).toEqual([true, true, false])
      a.controls.acknowledge = false
      a.controls.feedback = false
      const roll = ccc.command({ workspaceId, command })
      await expect.poll(() => a.commands.length).toBe(1)
      a.disconnect()
      expect((await roll).results[0]?.phase).toBe('error')
      await expect.poll(() => a.connections, { timeout: 4000 }).toBe(2)
      expect(a.commands).toHaveLength(1)
    },
  )
})
