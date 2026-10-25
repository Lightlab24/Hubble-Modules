import dgram from 'node:dgram'
import { once } from 'node:events'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TslReceiver } from '../src/receiver.js'
import { packet31, packet50, stream50 } from './fixtures/tsl-packets.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})

describe('TSL live receivers', () => {
  it('filters TCP senders before accepting tally and bounds concurrent clients and discovery memory', async () => {
    const settings = {
      protocol: '5.0' as const,
      transport: 'tcp' as const,
      bindAddress: '127.0.0.1',
      port: 0,
      sourceAddress: '192.0.2.1',
      staleAfterMs: 0,
    }
    const filtered = new TslReceiver(settings, () => undefined)
    cleanup.push(() => filtered.stop())
    await filtered.start()
    await filtered.start()
    const rejected = net.connect(filtered.boundPort ?? 0, '127.0.0.1')
    await once(rejected, 'close')
    expect(filtered.snapshot().displays).toEqual([])

    const receiver = new TslReceiver(
      { ...settings, sourceAddress: '127.0.0.1' },
      () => undefined,
    )
    cleanup.push(() => receiver.stop())
    await receiver.start()
    const clients: net.Socket[] = []
    for (let i = 0; i < 8; i++) {
      const client = net.connect(receiver.boundPort ?? 0, '127.0.0.1')
      clients.push(client)
      cleanup.push(() => {
        client.destroy()
      })
      await once(client, 'connect')
    }
    const overflow = net.connect(receiver.boundPort ?? 0, '127.0.0.1')
    await once(overflow, 'close')
    const sender = clients[0]
    if (sender === undefined) throw new Error('Missing sender')
    sender.write(Buffer.from([254, 2, 255, 255]))
    sender.write(stream50(packet50(0, [])))
    for (let base = 0; base < 4097; base += 300) {
      sender.write(
        stream50(
          packet50(
            0,
            Array.from({ length: Math.min(300, 4097 - base) }, (_, i) => ({
              address: base + i,
              control: 4,
              label: '',
            })),
          ),
        ),
      )
    }
    await expect.poll(() => receiver.resolve(0, 4096)?.text).toBe(1)
    expect(receiver.snapshot().displays).toHaveLength(4096)
    expect(receiver.resolve(0, 0)).toBeUndefined()
    expect(receiver.snapshot().invalidPackets).toBe(1)
    await receiver.stop()
    expect(receiver.boundPort).toBeUndefined()
    expect(receiver.health()).toEqual({ phase: 'stopped', error: null })
  })

  it('does not clear a newer TCP sender when the older sender disconnects', async () => {
    const receiver = new TslReceiver(
      {
        protocol: '3.1',
        transport: 'tcp',
        bindAddress: '127.0.0.1',
        port: 0,
        sourceAddress: '',
        staleAfterMs: 0,
      },
      () => undefined,
    )
    cleanup.push(() => receiver.stop())
    await receiver.start()
    const first = net.connect(receiver.boundPort ?? 0, '127.0.0.1')
    const second = net.connect(receiver.boundPort ?? 0, '127.0.0.1')
    cleanup.push(() => {
      first.destroy()
      second.destroy()
    })
    await Promise.all([once(first, 'connect'), once(second, 'connect')])
    first.write(packet31(1, 2, 'FIRST'))
    await expect.poll(() => receiver.resolve(0, 1)?.label).toBe('FIRST')
    second.write(packet31(1, 0, 'SECOND'))
    await expect.poll(() => receiver.resolve(0, 1)?.label).toBe('SECOND')
    first.end()
    await once(first, 'close')
    expect(receiver.resolve(0, 1)).toMatchObject({ fresh: true, label: 'SECOND' })
    second.end()
    await expect.poll(() => receiver.resolve(0, 1)).toBeUndefined()
  })
  it('discovers UDP labels, refreshes all four flags and expires configured stale state', async () => {
    let now = 1000
    const receiver = new TslReceiver(
      {
        protocol: '3.1',
        transport: 'udp',
        bindAddress: '127.0.0.1',
        port: 0,
        sourceAddress: '',
        staleAfterMs: 1000,
      },
      () => undefined,
      () => now,
    )
    cleanup.push(() => receiver.stop())
    await receiver.start()
    const sender = dgram.createSocket('udp4')
    cleanup.push(() => {
      sender.close()
    })
    sender.send(packet31(4, 15, 'CAM FOUR'), receiver.boundPort, '127.0.0.1')
    await expect.poll(() => receiver.resolve(0, 4)?.label).toBe('CAM FOUR')
    sender.send(packet31(4, 0, 'UPDATED'), receiver.boundPort, '127.0.0.1')
    await expect.poll(() => receiver.resolve(0, 4)?.flags).toEqual([false, false, false, false])
    now = 2000
    receiver.expire()
    expect(receiver.resolve(0, 4)).toBeUndefined()
    expect(receiver.snapshot().displays[0]).toMatchObject({ fresh: false, label: 'UPDATED' })
    receiver.expire()
    sender.send(packet31(4, 2, 'FRESH'), receiver.boundPort, '127.0.0.1')
    await expect.poll(() => receiver.resolve(0, 4)?.label).toBe('FRESH')
    receiver.expire()
    expect(receiver.resolve(0, 4)?.fresh).toBe(true)
  })

  it('reassembles real TCP frames and clears the sender’s state on disconnect', async () => {
    const receiver = new TslReceiver(
      {
        protocol: '5.0',
        transport: 'tcp',
        bindAddress: '127.0.0.1',
        port: 0,
        sourceAddress: '',
        staleAfterMs: 0,
      },
      () => undefined,
    )
    cleanup.push(() => receiver.stop())
    await receiver.start()
    const socket = net.connect(receiver.boundPort ?? 0, '127.0.0.1')
    cleanup.push(() => {
      socket.destroy()
    })
    await once(socket, 'connect')
    const bytes = stream50(
      packet50(3, [
        { address: 254, control: 4, label: 'CAM' },
        { address: 2, control: 16, label: 'OTHER' },
      ]),
    )
    socket.write(bytes.subarray(0, 7))
    socket.write(bytes.subarray(7))
    await expect.poll(() => receiver.snapshot().displays.length).toBe(2)
    expect(receiver.resolve(0, 254)).toBeUndefined()
    expect(receiver.resolve(3, 254)?.text).toBe(1)
    socket.end()
    await expect.poll(() => receiver.resolve(3, 254)).toBeUndefined()
  })

  it('applies broadcast ordering without merging different screens', async () => {
    const receiver = new TslReceiver(
      {
        protocol: '5.0',
        transport: 'udp',
        bindAddress: '127.0.0.1',
        port: 0,
        sourceAddress: '',
        staleAfterMs: 0,
      },
      () => undefined,
    )
    cleanup.push(() => receiver.stop())
    await receiver.start()
    const sender = dgram.createSocket('udp4')
    cleanup.push(() => {
      sender.close()
    })
    sender.send(
      packet50(65535, [{ address: 65535, control: 4, label: 'ALL' }]),
      receiver.boundPort,
      '127.0.0.1',
    )
    await expect.poll(() => receiver.resolve(4, 1)?.text).toBe(1)
    sender.send(
      packet50(4, [{ address: 1, control: 0, label: 'OFF' }]),
      receiver.boundPort,
      '127.0.0.1',
    )
    await expect.poll(() => receiver.resolve(4, 1)?.text).toBe(0)
    expect(receiver.resolve(5, 1)?.text).toBe(1)
    receiver.expire()
    expect(receiver.resolve(5, 1)?.fresh).toBe(true)
  })

  it('reports an occupied listener port without throwing or disrupting its owner', async () => {
    const first = new TslReceiver(
      {
        protocol: '3.1',
        transport: 'udp',
        bindAddress: '127.0.0.1',
        port: 0,
        sourceAddress: '',
        staleAfterMs: 0,
      },
      () => undefined,
    )
    cleanup.push(() => first.stop())
    await first.start()
    const second = new TslReceiver(
      {
        protocol: '3.1',
        transport: 'udp',
        bindAddress: '127.0.0.1',
        port: first.boundPort ?? 0,
        sourceAddress: '',
        staleAfterMs: 0,
      },
      () => undefined,
    )
    cleanup.push(() => second.stop())
    await second.start()
    expect(second.snapshot()).toMatchObject({ phase: 'error' })
    expect(first.snapshot().phase).toBe('listening')
  })
})
