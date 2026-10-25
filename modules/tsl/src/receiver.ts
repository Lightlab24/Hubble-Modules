import dgram from 'node:dgram'
import net from 'node:net'
import {
  parseTslPacket,
  TslStreamDecoder,
  type TslDisplay,
  type TslProtocol,
} from './protocol.js'

export interface TslReceiverSettings {
  readonly protocol: TslProtocol
  readonly transport: 'udp' | 'tcp'
  readonly bindAddress: string
  readonly port: number
  readonly sourceAddress: string
  /** Zero supports senders that transmit only on change. */
  readonly staleAfterMs: number
}

export interface TslDiscoveredDisplay extends TslDisplay {
  readonly sourceAddress: string
  readonly sourcePort: number
  readonly lastSeen: number
  readonly sequence: number
  readonly fresh: boolean
}

export interface TslReceiverSnapshot {
  readonly phase: 'stopped' | 'listening' | 'error'
  readonly error: string | null
  readonly invalidPackets: number
  readonly displays: readonly TslDiscoveredDisplay[]
}

const MAX_DISCOVERED_DISPLAYS = 4096
const MAX_TCP_CLIENTS = 8

export type TslReceiverContract = Pick<
  TslReceiver,
  'start' | 'stop' | 'snapshot' | 'health' | 'resolve'
>

export class TslReceiver {
  readonly #settings: TslReceiverSettings
  readonly #changed: () => void
  readonly #now: () => number
  readonly #entries = new Map<string, TslDiscoveredDisplay & { owner: object }>()
  readonly #clients = new Set<net.Socket>()
  #udp: dgram.Socket | undefined
  #tcp: net.Server | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #phase: TslReceiverSnapshot['phase'] = 'stopped'
  #error: string | null = null
  #sequence = 0
  #invalidPackets = 0

  constructor(settings: TslReceiverSettings, changed: () => void, now = Date.now) {
    this.#settings = settings
    this.#changed = changed
    this.#now = now
  }

  health(): Pick<TslReceiverSnapshot, 'phase' | 'error'> {
    return { phase: this.#phase, error: this.#error }
  }

  snapshot(): TslReceiverSnapshot {
    return {
      phase: this.#phase,
      error: this.#error,
      invalidPackets: this.#invalidPackets,
      displays: [...this.#entries.values()].map((entry) => ({
        protocol: entry.protocol,
        screen: entry.screen,
        address: entry.address,
        label: entry.label,
        flags: entry.flags,
        left: entry.left,
        text: entry.text,
        right: entry.right,
        brightness: entry.brightness,
        sourceAddress: entry.sourceAddress,
        sourcePort: entry.sourcePort,
        lastSeen: entry.lastSeen,
        sequence: entry.sequence,
        fresh: entry.fresh,
      })),
    }
  }

  get boundPort(): number | undefined {
    try {
      const address = this.#udp?.address() ?? this.#tcp?.address()
      return address !== null && typeof address === 'object' ? address.port : undefined
    } catch {
      return undefined
    }
  }

  resolve(screen: number, address: number): TslDiscoveredDisplay | undefined {
    let latest: TslDiscoveredDisplay | undefined
    for (const key of [
      `${String(screen)}:${String(address)}`,
      `${String(screen)}:65535`,
      `65535:${String(address)}`,
      '65535:65535',
    ]) {
      const entry = this.#entries.get(key)
      if (entry !== undefined && (latest === undefined || entry.sequence > latest.sequence))
        latest = entry
    }
    return latest?.fresh === true ? latest : undefined
  }

  async start(): Promise<void> {
    if (this.#udp !== undefined || this.#tcp !== undefined) return
    this.#error = null
    const ready = () => {
      this.#phase = 'listening'
      this.#changed()
    }
    const failed = (error: Error) => {
      this.#phase = 'error'
      this.#error = error.message.slice(0, 256)
      this.#entries.clear()
      this.#changed()
    }
    if (this.#settings.transport === 'udp') {
      const socket = dgram.createSocket('udp4')
      this.#udp = socket
      socket.on('error', failed)
      socket.on('message', (data, source) => {
        if (!this.#acceptSource(source.address)) return
        try {
          this.#ingest(
            parseTslPacket(this.#settings.protocol, data),
            source.address,
            source.port,
            socket,
          )
        } catch {
          this.#invalidPackets += 1
        }
      })
      await new Promise<void>((resolve) => {
        socket.once('listening', () => {
          ready()
          resolve()
        })
        socket.once('error', () => {
          resolve()
        })
        socket.bind(this.#settings.port, this.#settings.bindAddress)
      })
    } else {
      const server = net.createServer((socket) => {
        const address = socket.remoteAddress?.replace(/^::ffff:/u, '') ?? ''
        if (this.#clients.size >= MAX_TCP_CLIENTS || !this.#acceptSource(address)) {
          socket.destroy()
          return
        }
        this.#clients.add(socket)
        socket.setNoDelay(true)
        const decoder = new TslStreamDecoder(this.#settings.protocol)
        socket.on('data', (data) => {
          this.#ingest(
            decoder.push(data, () => {
              this.#invalidPackets += 1
            }),
            address,
            socket.remotePort ?? 0,
            socket,
          )
        })
        socket.on('error', () => socket.destroy())
        socket.on('close', () => {
          this.#clients.delete(socket)
          let changed = false
          for (const [key, entry] of this.#entries) {
            if (entry.owner !== socket) continue
            this.#entries.set(key, { ...entry, fresh: false })
            changed = true
          }
          if (changed) this.#changed()
        })
      })
      this.#tcp = server
      server.on('error', failed)
      await new Promise<void>((resolve) => {
        server.once('listening', () => {
          ready()
          resolve()
        })
        server.once('error', () => {
          resolve()
        })
        server.listen(this.#settings.port, this.#settings.bindAddress)
      })
    }
    if (this.#settings.staleAfterMs > 0 && this.#phase === 'listening') {
      this.#timer = setInterval(
        () => {
          this.expire()
        },
        Math.min(1000, this.#settings.staleAfterMs),
      )
      this.#timer.unref()
    }
  }

  expire(): void {
    const timeout = this.#settings.staleAfterMs
    if (timeout === 0) return
    const now = this.#now()
    let changed = false
    for (const [key, entry] of this.#entries) {
      if (!entry.fresh || now - entry.lastSeen < timeout) continue
      this.#entries.set(key, { ...entry, fresh: false })
      changed = true
    }
    if (changed) this.#changed()
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    for (const socket of this.#clients) socket.destroy()
    this.#clients.clear()
    const udp = this.#udp
    const tcp = this.#tcp
    this.#udp = undefined
    this.#tcp = undefined
    await Promise.all([
      new Promise<void>((resolve) => {
        if (udp === undefined) resolve()
        else {
          try {
            udp.close(() => {
              resolve()
            })
          } catch {
            resolve()
          }
        }
      }),
      new Promise<void>((resolve) => {
        if (tcp === undefined) resolve()
        else
          tcp.close(() => {
            resolve()
          })
      }),
    ])
    this.#entries.clear()
    this.#phase = 'stopped'
    this.#changed()
  }

  #acceptSource(address: string): boolean {
    return this.#settings.sourceAddress === '' || address === this.#settings.sourceAddress
  }

  #ingest(
    displays: readonly TslDisplay[],
    sourceAddress: string,
    sourcePort: number,
    owner: object,
  ): void {
    if (displays.length === 0) return
    const lastSeen = this.#now()
    for (const display of displays) {
      const key = `${String(display.screen)}:${String(display.address)}`
      this.#entries.delete(key)
      this.#entries.set(key, {
        ...display,
        sourceAddress,
        sourcePort,
        owner,
        lastSeen,
        sequence: ++this.#sequence,
        fresh: true,
      })
      if (this.#entries.size > MAX_DISCOVERED_DISPLAYS) {
        const oldest = this.#entries.keys().next().value
        if (oldest !== undefined) this.#entries.delete(oldest)
      }
    }
    this.#changed()
  }
}
