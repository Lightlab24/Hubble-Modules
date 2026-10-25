import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { type CyanViewRcpConnectionDefinition } from './config.js'
import {
  CyanViewRcpConnectionError,
  unavailable,
  type CyanViewCameraObservation,
  type CyanViewCameraParameterStep,
  type CyanViewCameraTarget,
  type ManagedCyanViewRcpConnectionSnapshot,
  type Panel,
  type PendingCommand,
} from './models.js'
import { FILTERS, MAX_ENTITIES, MAX_PACKET_BYTES, mqttText, packet } from './mqtt.js'

export class RcpSession {
  definition: CyanViewRcpConnectionDefinition
  #socket: Socket | undefined
  #buffer: Buffer = Buffer.alloc(0)
  #connected = false
  #subscribed = false
  #stopped = false
  #awaitingPing = false
  #reconnect: ReturnType<typeof setTimeout> | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #discovery: ReturnType<typeof setTimeout> | undefined
  #panels = new Map<string, Panel>()
  #cameras = new Map<string, number>()
  #feedback = new Map<string, CyanViewCameraObservation>()
  #sequence = 0
  #generation = 0
  #pending = new Map<number, PendingCommand>()
  #nextPacketId = 2
  #phase: ManagedCyanViewRcpConnectionSnapshot['phase'] = 'checking'
  #lastError: string | null = null
  #lastEventAt: string | null = null

  constructor(
    definition: CyanViewRcpConnectionDefinition,
    private readonly changed: () => void,
    private readonly cameraFeedback = false,
  ) {
    this.definition = definition
    this.connect()
  }

  snapshot(): ManagedCyanViewRcpConnectionSnapshot {
    const selected = this.selectedPanel()
    return Object.freeze({
      definition: this.definition,
      phase: this.#phase,
      panelId: this.#phase === 'ready' ? (selected?.[0].split('/')[1] ?? null) : null,
      activeCameraNumber:
        this.#phase === 'ready' && selected !== null && selected[1].activeCamera !== null
          ? (this.#cameras.get(
              `${selected[0].slice(0, selected[0].indexOf('/'))}/${selected[1].activeCamera}`,
            ) ?? null)
          : null,
      lastEventAt: this.#lastEventAt,
      lastError: this.#lastError,
    })
  }

  cameraObservations(): readonly CyanViewCameraObservation[] {
    return [...this.#feedback.values()]
  }

  resolveCamera(
    cameraNumber: number,
    operation: 'recording' | 'adjustment' = 'recording',
  ): CyanViewCameraTarget {
    this.requirePanel()
    const matches = [...this.#feedback.values()].filter((item) => item.number === cameraNumber)
    if (matches.length !== 1)
      throw unavailable(
        matches.length
          ? 'Camera number is ambiguous on this RCP'
          : 'Camera number was not found on this RCP',
      )
    const observation = matches[0]
    const camera = observation?.address
    if (!observation || !camera || observation.online !== true)
      throw unavailable('Camera is offline or has not reported availability')
    if (operation === 'recording' && observation.recordingLocked)
      throw unavailable('Camera recording is locked')
    return { address: camera, generation: this.#generation, observation }
  }

  async sendCameraCommand(
    target: CyanViewCameraTarget,
    value: 'Rec' | 'Stop' | 'RecToggle',
    signal?: AbortSignal,
  ): Promise<void> {
    const current = this.requireCameraTarget(target)
    if (current.recordingLocked) throw unavailable('Camera recording is locked')
    await this.publishCommand(`${target.address}/camhead/action/set/keyboard`, value, signal)
  }

  async stepCameraParameter(
    target: CyanViewCameraTarget,
    step: CyanViewCameraParameterStep,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = this.requireCameraTarget(target)
    // CyanView reports nd_filter_clear only for variable ND. Those cameras use
    // multiplicative adjustments; other cameras step through their available values.
    const variableNd = step.parameter === 'nd_filter' && current.variableNd
    await this.publishCommand(
      `${target.address}/camhead/action/${variableNd ? 'mult' : step.direction}/${step.parameter}`,
      variableNd ? (step.direction === 'next' ? '2' : '0.5') : '',
      signal,
    )
  }

  private requireCameraTarget(target: CyanViewCameraTarget): CyanViewCameraObservation {
    if (!this.#subscribed || target.generation !== this.#generation)
      throw unavailable(
        'RCP disconnected after the command was accepted; command was not replayed',
      )
    const current = this.#feedback.get(target.address)
    if (current?.online !== true) throw unavailable('Camera is offline')
    return current
  }

  async selectCamera(cameraNumber: number, signal?: AbortSignal): Promise<void> {
    const { panel } = this.cameraTarget(cameraNumber)
    await this.publishCommand(
      `${panel}/rcp/action/set/active_camera_number`,
      String(cameraNumber),
      signal,
    )
  }

  async recordCamera(cameraNumber: number, signal?: AbortSignal): Promise<void> {
    const { camera } = this.cameraTarget(cameraNumber)
    await this.publishCommand(`${camera}/camhead/action/set/keyboard`, 'RecToggle', signal)
  }

  async recordGroupAll(signal?: AbortSignal): Promise<void> {
    const panel = this.requirePanel()
    const root = panel.slice(0, panel.indexOf('/'))
    // The RCP expands this one group command to its members. Publishing per camera as
    // well would toggle those cameras twice and could undo the requested operation.
    await this.publishCommand(`${root}/All/camgroup/action/set/keyboard`, 'RecToggle', signal)
  }

  private requirePanel(): string {
    const selected = this.selectedPanel()
    if (this.#phase !== 'ready' || selected === null || this.#socket === undefined) {
      throw unavailable(this.#lastError ?? undefined)
    }
    return selected[0]
  }

  private cameraTarget(cameraNumber: number): { panel: string; camera: string } {
    if (!Number.isSafeInteger(cameraNumber) || cameraNumber < 1 || cameraNumber > 999_999) {
      throw new CyanViewRcpConnectionError(
        'cyanview_invalid_request',
        'Enter a camera number from 1 to 999999',
      )
    }
    const panel = this.requirePanel()
    const root = panel.slice(0, panel.indexOf('/'))
    const cameras = [...this.#cameras].filter(
      ([id, number]) => id.startsWith(`${root}/`) && number === cameraNumber,
    )
    const camera = cameras[0]?.[0]
    if (camera === undefined)
      throw new CyanViewRcpConnectionError(
        'cyanview_camera_not_found',
        'The requested camera number was not found on this RCP',
      )
    if (cameras.length !== 1)
      throw new CyanViewRcpConnectionError(
        'cyanview_invalid_request',
        'More than one camera uses the requested number on this RCP',
      )
    return { panel, camera }
  }

  private publishCommand(topic: string, value: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true)
      return Promise.reject(unavailable('CyanView RCP command was cancelled'))
    if (this.#pending.size >= 16)
      return Promise.reject(unavailable('CyanView RCP has too many pending commands'))
    const id = this.#nextPacketId
    this.#nextPacketId = id === 65_535 ? 2 : id + 1
    const idBytes = Buffer.alloc(2)
    idBytes.writeUInt16BE(id)
    return new Promise<void>((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.#pending.get(id)
        if (pending === undefined) return
        this.#pending.delete(id)
        pending.cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        finish(
          new CyanViewRcpConnectionError(
            'cyanview_timeout',
            'CyanView RCP did not acknowledge the command before the timeout',
          ),
        )
      }, this.definition.requestTimeoutMs)
      timer.unref()
      const abort = () => {
        finish(unavailable('CyanView RCP command was cancelled'))
      }
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      // QoS 1 acknowledges delivery to the broker. Only incoming status changes drive feedback.
      this.#socket?.write(
        packet(0x32, Buffer.concat([mqttText(topic), idBytes, Buffer.from(value)])),
      )
    })
  }

  refresh(): void {
    this.disconnect(unavailable('Refreshing CyanView RCP connection'))
    clearTimeout(this.#reconnect)
    this.#phase = 'checking'
    this.#lastError = null
    this.connect()
    this.changed()
  }

  stop(): void {
    this.#stopped = true
    this.disconnect(unavailable('CyanView RCP connection was removed'))
    clearTimeout(this.#reconnect)
  }

  private connect(): void {
    if (this.#stopped) return
    const host = this.definition.host.replace(/^\[|\]$/gu, '')
    const socket = createConnection({ host, port: this.definition.port })
    this.#socket = socket
    socket.setNoDelay(true)
    socket.setTimeout(this.definition.requestTimeoutMs)
    socket.on('connect', () => {
      if (this.#socket !== socket) return
      socket.write(
        packet(
          0x10,
          Buffer.concat([
            mqttText('MQTT'),
            Buffer.from([4, 2, 0, 20]),
            mqttText(`hubble-${randomUUID()}`),
          ]),
        ),
      )
    })
    socket.on('data', (data) => {
      if (this.#socket !== socket) return
      try {
        this.receive(data)
      } catch {
        this.disconnect(
          new CyanViewRcpConnectionError(
            'cyanview_protocol_error',
            'CyanView RCP returned an invalid MQTT response',
          ),
        )
      }
    })
    socket.on('timeout', () => {
      if (this.#socket === socket)
        this.disconnect(
          new CyanViewRcpConnectionError(
            'cyanview_timeout',
            'CyanView RCP connection timed out',
          ),
        )
    })
    socket.on('error', () => {
      if (this.#socket === socket) this.disconnect(unavailable())
    })
    socket.on('close', () => {
      if (this.#socket === socket) this.disconnect(unavailable())
    })
  }

  private disconnect(error: CyanViewRcpConnectionError): void {
    const socket = this.#socket
    this.#socket = undefined
    socket?.destroy()
    clearInterval(this.#heartbeat)
    clearTimeout(this.#discovery)
    this.#discovery = undefined
    this.#connected = false
    this.#subscribed = false
    this.#awaitingPing = false
    this.#buffer = Buffer.alloc(0)
    this.#panels.clear()
    this.#cameras.clear()
    this.#feedback.clear()
    this.#generation += 1
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
    this.#phase = 'unavailable'
    this.#lastError = error.message
    this.#lastEventAt = new Date().toISOString()
    this.changed()
    clearTimeout(this.#reconnect)
    if (!this.#stopped) {
      this.#reconnect = setTimeout(() => {
        this.connect()
      }, 2_000)
      this.#reconnect.unref()
    }
  }

  private receive(data: Buffer): void {
    if (this.#buffer.length + data.length > MAX_PACKET_BYTES)
      throw new Error('packet too large')
    this.#buffer = Buffer.concat([this.#buffer, data])
    while (this.#buffer.length >= 2) {
      let length = 0
      let offset = 1
      let multiplier = 1
      for (;;) {
        const byte = this.#buffer[offset]
        if (byte === undefined) return
        length += (byte & 127) * multiplier
        offset += 1
        if (length > MAX_PACKET_BYTES) throw new Error('packet too large')
        if ((byte & 128) === 0) break
        if (offset === 5) throw new Error('invalid packet length')
        multiplier *= 128
      }
      if (this.#buffer.length < offset + length) return
      const header = this.#buffer.readUInt8(0)
      const body = this.#buffer.subarray(offset, offset + length)
      this.#buffer = this.#buffer.subarray(offset + length)
      this.handlePacket(header, body)
    }
  }

  private handlePacket(header: number, body: Buffer): void {
    if (header === 0x20) {
      if (this.#connected || body.length !== 2 || body[0] !== 0 || body[1] !== 0)
        throw new Error('connection refused')
      this.#connected = true
      this.#socket?.write(
        packet(
          0x82,
          Buffer.concat([
            Buffer.from([0, 1]),
            ...FILTERS.map((filter) =>
              this.cameraFeedback && filter.endsWith('/number')
                ? '+/+/camhead/status/#'
                : filter,
            ).flatMap((filter) => [mqttText(filter), Buffer.from([0])]),
          ]),
        ),
      )
      return
    }
    if (!this.#connected) throw new Error('missing CONNACK')
    if (header === 0x90) {
      if (
        this.#subscribed ||
        body.length !== FILTERS.length + 2 ||
        body.readUInt16BE(0) !== 1 ||
        body.subarray(2).some((value) => value !== 0)
      )
        throw new Error('subscription refused')
      this.#subscribed = true
      this.#socket?.setTimeout(0)
      this.#heartbeat = setInterval(() => {
        if (this.#awaitingPing) {
          this.disconnect(unavailable('CyanView RCP stopped responding'))
          return
        }
        this.#awaitingPing = true
        this.#socket?.write(packet(0xc0))
      }, 10_000)
      this.#heartbeat.unref()
      this.updateState()
      return
    }
    if (header === 0xd0 && body.length === 0) {
      this.#awaitingPing = false
      return
    }
    if (header === 0x40 && body.length === 2) {
      const id = body.readUInt16BE(0)
      const pending = this.#pending.get(id)
      if (pending !== undefined) {
        this.#pending.delete(id)
        pending.cleanup()
        pending.resolve()
      }
      return
    }
    if (header >> 4 !== 3 || body.length < 2) throw new Error('unexpected MQTT packet')
    const qos = (header >> 1) & 3
    if (qos > 1) throw new Error('unsupported QoS')
    const topicLength = body.readUInt16BE(0)
    const payloadOffset = topicLength + 2 + (qos === 1 ? 2 : 0)
    if (topicLength === 0 || body.length < payloadOffset) throw new Error('invalid publish')
    const topic = body.subarray(2, topicLength + 2).toString('utf8')
    if (qos === 1)
      this.#socket?.write(packet(0x40, body.subarray(topicLength + 2, payloadOffset)))
    const payload = body.subarray(payloadOffset).toString('utf8')
    if (payload.length > 253) return
    const [root, entity, domain, status, scope, field, extra] = topic.split('/')
    if (!root || !entity || status !== 'status' || extra !== undefined) return
    const key = `${root}/${entity}`
    if (domain === 'camhead') {
      if (!this.#feedback.has(key) && this.#feedback.size >= MAX_ENTITIES) return
      const prior = this.#feedback.get(key) ?? {
        address: key,
        number: null,
        name: '',
        online: null,
        recording: null,
        recordingLocked: false,
        recordingSequence: 0,
        variableNd: false,
      }
      let next = prior
      if (scope === 'persist' && field === 'number')
        next = { ...prior, number: /^[1-9]\d{0,5}$/u.test(payload) ? Number(payload) : null }
      else if (scope === 'persist' && field === 'name') next = { ...prior, name: payload }
      else if (scope === 'persist' && field === 'rec_lock')
        next = { ...prior, recordingLocked: payload === '1' }
      else if (scope === 'persist' && field === 'nd_filter_clear')
        next = { ...prior, variableNd: payload === '0' || payload === '1' }
      else if (scope === 'volatile' && field === 'control')
        next = {
          ...prior,
          online: payload === 'online',
          ...(payload === 'online' ? {} : { recording: null }),
        }
      else if (scope === 'volatile' && field === 'recording')
        next = {
          ...prior,
          recording: payload === '1' ? true : payload === '0' ? false : null,
          recordingSequence: (header & 1) === 0 ? ++this.#sequence : 0,
        }
      this.#feedback.set(key, next)
      this.changed()
      if (field !== 'number') return
    }
    if (domain === 'camhead' && scope === 'persist' && field === 'number') {
      if (!/^[1-9]\d{0,5}$/u.test(payload)) this.#cameras.delete(key)
      else if (
        /^[1-9]\d{0,5}$/u.test(payload) &&
        (this.#cameras.has(key) || this.#cameras.size < MAX_ENTITIES)
      )
        this.#cameras.set(key, Number(payload))
    } else if (
      (domain === 'rcp' && scope === 'volatile' && field === 'active_camera') ||
      (domain === 'rcp_helper' && scope === 'volatile' && field === 'control')
    ) {
      if (!this.#panels.has(key) && this.#panels.size >= 32) throw new Error('too many panels')
      const panel = this.#panels.get(key) ?? { activeCamera: null, online: null }
      if (domain === 'rcp') panel.activeCamera = payload || null
      else panel.online = payload === 'online'
      this.#panels.set(key, panel)
    } else return
    this.#lastEventAt = new Date().toISOString()
    this.updateState()
  }

  private selectedPanel(): [string, Panel] | null {
    return this.#panels.size === 1 ? ([...this.#panels][0] ?? null) : null
  }

  private updateState(): void {
    if (!this.#subscribed) return
    // Settle retained discovery before allowing the first command; later ambiguity also disables selection.
    if (this.#discovery !== undefined) return
    this.#discovery = setTimeout(() => {
      this.#discovery = undefined
      const selected = this.selectedPanel()
      this.#lastError =
        this.#panels.size > 1
          ? 'More than one RCP was found on this broker; connect to the intended panel directly'
          : selected === null
            ? 'No CyanView RCP panel was found on this broker'
            : selected[1].online === false
              ? 'CyanView RCP control is offline'
              : null
      this.#phase = this.#lastError === null ? 'ready' : 'unavailable'
      this.changed()
    }, 100)
    this.#discovery.unref()
    if (this.#panels.size > 1 || this.selectedPanel()?.[1].online === false) {
      this.#phase = 'checking'
      this.#lastError = null
      this.changed()
    }
  }
}
