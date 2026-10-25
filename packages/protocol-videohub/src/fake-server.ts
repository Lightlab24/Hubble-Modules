import net, { type Server, type Socket } from 'node:net'

import { VideohubSectionDecoder } from './decoder.js'
import {
  encodeVideohubBlock,
  encodeVideoOutputRouting,
  type VideohubCrosspoint,
  type VideohubLockState,
  type VideohubOutputLock,
  type VideohubRouterLabel,
} from './protocol.js'

export interface FakeVideohubServerOptions {
  readonly sourceCount?: number
  readonly destinationCount?: number
  readonly listenPort?: number
  readonly modelName?: string
  readonly fragmentInitialDump?: boolean
  readonly malformedInputLabel?: number
  readonly nakRoutes?: boolean
  readonly routeAcknowledgementDelayMs?: number
  readonly applyRouteWrites?: boolean
  readonly suppressRouteUpdates?: boolean
  readonly routeReadbackDelayMs?: number
  readonly inputLabelDeltaDuringRefresh?: VideohubRouterLabel
}

export interface FakeVideohubReplacement {
  readonly sourceCount: number
  readonly destinationCount: number
  readonly modelName?: string
}

function wireLock(state: VideohubLockState): 'U' | 'O' | 'L' {
  if (state === 'owned') return 'O'
  if (state === 'locked') return 'L'
  return 'U'
}

function sortedValues<T extends { readonly address?: number; readonly destination?: number }>(
  values: ReadonlyMap<number, T>,
): readonly T[] {
  return [...values.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)
}

export class FakeVideohubServer {
  public readonly server: Server
  public readonly sockets = new Set<Socket>()
  public readonly routeCommands: VideohubCrosspoint[] = []
  public readonly lockCommands: VideohubOutputLock[] = []
  public routeStatusRequests = 0
  public inputLabelStatusRequests = 0
  public outputLabelStatusRequests = 0

  private readonly options: FakeVideohubServerOptions
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly sources = new Map<number, VideohubRouterLabel>()
  private readonly destinations = new Map<number, VideohubRouterLabel>()
  private readonly routes = new Map<number, VideohubCrosspoint>()
  private readonly locks = new Map<number, VideohubOutputLock>()
  private sourceCountValue: number
  private destinationCountValue: number
  private modelNameValue: string

  private constructor(options: FakeVideohubServerOptions) {
    this.options = Object.freeze({ ...options })
    this.sourceCountValue = options.sourceCount ?? 4
    this.destinationCountValue = options.destinationCount ?? 4
    if (
      !Number.isSafeInteger(this.sourceCountValue) ||
      this.sourceCountValue < 1 ||
      this.sourceCountValue > 65_536 ||
      !Number.isSafeInteger(this.destinationCountValue) ||
      this.destinationCountValue < 1 ||
      this.destinationCountValue > 65_536
    ) {
      throw new RangeError('Fake Videohub dimensions must be integers from 1 to 65536')
    }
    this.modelNameValue =
      options.modelName ??
      `Fake Videohub ${String(this.sourceCountValue)}x${String(this.destinationCountValue)}`
    this.resetState()
    this.server = net.createServer((socket) => {
      this.accept(socket)
    })
  }

  public static async start(
    options: FakeVideohubServerOptions = {},
  ): Promise<FakeVideohubServer> {
    const fake = new FakeVideohubServer(options)
    await new Promise<void>((resolve, reject) => {
      fake.server.once('error', reject)
      fake.server.listen(options.listenPort ?? 0, '127.0.0.1', () => {
        fake.server.off('error', reject)
        resolve()
      })
    })
    return fake
  }

  public get port(): number {
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('Fake server is not open')
    return address.port
  }

  public pushRoute(crosspoint: VideohubCrosspoint): void {
    this.routes.set(crosspoint.destination, Object.freeze({ ...crosspoint }))
    this.broadcast(encodeVideoOutputRouting([crosspoint]))
  }

  public pushInputLabel(label: VideohubRouterLabel): void {
    this.sources.set(label.address, Object.freeze({ ...label }))
    this.broadcast(
      encodeVideohubBlock('INPUT LABELS', [`${String(label.address - 1)} ${label.name}`]),
    )
  }

  public pushOutputLabel(label: VideohubRouterLabel): void {
    this.destinations.set(label.address, Object.freeze({ ...label }))
    this.broadcast(
      encodeVideohubBlock('OUTPUT LABELS', [`${String(label.address - 1)} ${label.name}`]),
    )
  }

  public pushLock(lock: VideohubOutputLock): void {
    this.locks.set(lock.destination, Object.freeze({ ...lock }))
    this.broadcast(
      encodeVideohubBlock('VIDEO OUTPUT LOCKS', [
        `${String(lock.destination - 1)} ${wireLock(lock.state)}`,
      ]),
    )
  }

  public replaceDevice(replacement: FakeVideohubReplacement): void {
    this.sourceCountValue = replacement.sourceCount
    this.destinationCountValue = replacement.destinationCount
    this.modelNameValue =
      replacement.modelName ??
      `Fake Videohub ${String(replacement.sourceCount)}x${String(replacement.destinationCount)}`
    this.resetState()
    const dump = this.statusDump(false)
    for (const socket of this.sockets) this.writeDump(socket, dump)
  }

  public disconnectClients(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  public async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.disconnectClients()
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }

  private resetState(): void {
    this.sources.clear()
    this.destinations.clear()
    this.routes.clear()
    this.locks.clear()
    for (let address = 1; address <= this.sourceCountValue; address += 1) {
      this.sources.set(address, Object.freeze({ address, name: `Input ${String(address)}` }))
    }
    for (let address = 1; address <= this.destinationCountValue; address += 1) {
      this.destinations.set(
        address,
        Object.freeze({ address, name: `Output ${String(address)}` }),
      )
      this.routes.set(
        address,
        Object.freeze({
          destination: address,
          source: ((address - 1) % this.sourceCountValue) + 1,
        }),
      )
      this.locks.set(address, Object.freeze({ destination: address, state: 'unlocked' }))
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('close', () => this.sockets.delete(socket))
    // Test clients and development shells may reset a TCP connection instead of
    // completing an orderly FIN handshake. Keep that peer-local transport event
    // from terminating the reusable simulator process.
    socket.on('error', () => this.sockets.delete(socket))
    const decoder = new VideohubSectionDecoder()
    socket.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) this.handleClientMessage(socket, message)
    })
    this.writeDump(socket, this.statusDump(true))
  }

  private handleClientMessage(
    socket: Socket,
    message: ReturnType<VideohubSectionDecoder['push']>[number],
  ): void {
    if (message.type === 'video-output-routing') {
      if (message.crosspoints.length === 0) {
        this.routeStatusRequests += 1
        socket.write('ACK\n\n')
        socket.write(this.routeBlock())
        return
      }
      this.routeCommands.push(...message.crosspoints)
      if (this.options.nakRoutes === true) {
        this.writeRouteAcknowledgement(socket, 'NAK\n\n')
        return
      }
      this.writeRouteAcknowledgement(socket, 'ACK\n\n')
      if (this.options.applyRouteWrites !== false) {
        for (const crosspoint of message.crosspoints) {
          this.routes.set(crosspoint.destination, Object.freeze({ ...crosspoint }))
        }
      }
      if (
        this.options.suppressRouteUpdates !== true &&
        this.options.applyRouteWrites !== false
      ) {
        const send = (): void => {
          if (!socket.destroyed) this.broadcast(encodeVideoOutputRouting(message.crosspoints))
        }
        const delay = this.options.routeReadbackDelayMs ?? 0
        if (delay > 0) {
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            send()
          }, delay)
          this.timers.add(timer)
        } else {
          send()
        }
      }
      return
    }
    if (message.type === 'input-labels' && message.labels.length === 0) {
      this.inputLabelStatusRequests += 1
      socket.write('ACK\n\n')
      socket.write(this.inputLabelBlock())
      return
    }
    if (message.type === 'output-labels' && message.labels.length === 0) {
      this.outputLabelStatusRequests += 1
      socket.write('ACK\n\n')
      if (this.options.inputLabelDeltaDuringRefresh !== undefined) {
        this.pushInputLabel(this.options.inputLabelDeltaDuringRefresh)
      }
      socket.write(this.outputLabelBlock())
      return
    }
    if (message.type === 'video-output-locks') {
      if (message.locks.length === 0) {
        socket.write('ACK\n\n')
        socket.write(this.lockBlock())
      } else {
        this.lockCommands.push(...message.locks)
        socket.write('ACK\n\n')
      }
      return
    }
    if (message.type === 'unknown' && message.header === 'PING') socket.write('ACK\n\n')
  }

  private statusDump(includePreamble: boolean): readonly Buffer[] {
    const blocks: Buffer[] = []
    if (includePreamble) {
      blocks.push(encodeVideohubBlock('PROTOCOL PREAMBLE', ['Version: 2.3']))
    }
    blocks.push(
      encodeVideohubBlock('VIDEOHUB DEVICE', [
        'Device present: true',
        `Model name: ${this.modelNameValue}`,
        `Video inputs: ${String(this.sourceCountValue)}`,
        'Video processing units: 0',
        `Video outputs: ${String(this.destinationCountValue)}`,
        'Video monitoring outputs: 0',
        'Serial ports: 0',
      ]),
      this.inputLabelBlock(),
      this.outputLabelBlock(),
      this.routeBlock(),
      this.lockBlock(),
    )
    return Object.freeze(blocks)
  }

  private inputLabelBlock(): Buffer {
    const lines = sortedValues(this.sources).map((label) =>
      this.options.malformedInputLabel === label.address
        ? `not-a-valid-label-for-${String(label.address)}`
        : `${String(label.address - 1)} ${label.name}`,
    )
    return encodeVideohubBlock('INPUT LABELS', lines)
  }

  private outputLabelBlock(): Buffer {
    return encodeVideohubBlock(
      'OUTPUT LABELS',
      sortedValues(this.destinations).map(
        (label) => `${String(label.address - 1)} ${label.name}`,
      ),
    )
  }

  private routeBlock(): Buffer {
    return encodeVideoOutputRouting(sortedValues(this.routes))
  }

  private lockBlock(): Buffer {
    return encodeVideohubBlock(
      'VIDEO OUTPUT LOCKS',
      sortedValues(this.locks).map(
        (lock) => `${String(lock.destination - 1)} ${wireLock(lock.state)}`,
      ),
    )
  }

  private writeDump(socket: Socket, blocks: readonly Buffer[]): void {
    if (this.options.fragmentInitialDump !== true) {
      for (const block of blocks) socket.write(block)
      return
    }
    const bytes = Buffer.concat(blocks)
    const sizes = [1, 2, 5, 3, 11, 7]
    let offset = 0
    let index = 0
    while (offset < bytes.length) {
      const size = sizes[index % sizes.length] ?? 1
      socket.write(bytes.subarray(offset, Math.min(bytes.length, offset + size)))
      offset += size
      index += 1
    }
  }

  private writeRouteAcknowledgement(socket: Socket, acknowledgement: string): void {
    const delay = this.options.routeAcknowledgementDelayMs ?? 0
    if (delay <= 0) {
      socket.write(acknowledgement)
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!socket.destroyed) socket.write(acknowledgement)
    }, delay)
    this.timers.add(timer)
  }

  private broadcast(bytes: Buffer): void {
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(bytes)
    }
  }
}
