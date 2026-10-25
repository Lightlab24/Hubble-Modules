/** TSL UMD 3.1 and 5.0, https://tslproducts.com/wp-content/uploads/TSL-UMD-protocol.pdf */
export type TslProtocol = '3.1' | '5.0'
export type TslColor = 0 | 1 | 2 | 3

export interface TslDisplay {
  readonly protocol: TslProtocol
  readonly screen: number
  readonly address: number
  readonly label: string
  readonly flags: readonly boolean[]
  readonly left: TslColor
  readonly text: TslColor
  readonly right: TslColor
  readonly brightness: number
}

export class TslPacketError extends Error {}

export function parseTslPacket(protocol: TslProtocol, data: Buffer): readonly TslDisplay[] {
  return protocol === '3.1' ? parse31(data) : parse50(data)
}

function parse31(data: Buffer): readonly TslDisplay[] {
  if (data.length === 0 || data.length > 2048 || data.length % 18 !== 0) {
    throw new TslPacketError('TSL 3.1 requires complete 18-byte records')
  }
  const displays: TslDisplay[] = []
  for (let offset = 0; offset < data.length; offset += 18) {
    const header = data.readUInt8(offset)
    const control = data.readUInt8(offset + 1)
    if (header < 0x80 || header > 0xfe || (control & 0xc0) !== 0) {
      throw new TslPacketError('Invalid TSL 3.1 address or control byte')
    }
    const label = data.subarray(offset + 2, offset + 18)
    // Some senders pad with NUL instead of spaces. Accept that interoperable form.
    if (label.some((byte) => byte !== 0 && (byte < 0x20 || byte > 0x7e))) {
      throw new TslPacketError('Invalid TSL 3.1 label')
    }
    displays.push({
      protocol: '3.1',
      screen: 0,
      address: header - 0x80,
      label: label.toString('ascii').replace(/\0.*$/u, '').trimEnd(),
      flags: [0, 1, 2, 3].map((bit) => (control & (1 << bit)) !== 0),
      left: 0,
      text: 0,
      right: 0,
      brightness: (control >> 4) & 3,
    })
  }
  return displays
}

function parse50(data: Buffer): readonly TslDisplay[] {
  if (data.length < 6 || data.length > 2048 || data.readUInt16LE(0) !== data.length - 2) {
    throw new TslPacketError('Invalid TSL 5.0 packet byte count')
  }
  const flags = data.readUInt8(3)
  if (data.readUInt8(2) !== 0 || (flags & 0xfe) !== 0) {
    // Screen/control payloads are undefined in the public 5.0 specification.
    throw new TslPacketError('Unsupported TSL 5.0 version or screen control data')
  }
  const screen = data.readUInt16LE(4)
  const displays: TslDisplay[] = []
  for (let offset = 6; offset < data.length; ) {
    if (data.length - offset < 6) throw new TslPacketError('Truncated TSL 5.0 display')
    const address = data.readUInt16LE(offset)
    const control = data.readUInt16LE(offset + 2)
    const length = data.readUInt16LE(offset + 4)
    if ((control & 0xff00) !== 0)
      throw new TslPacketError('Unsupported TSL 5.0 display control data')
    offset += 6
    if (length > data.length - offset || ((flags & 1) !== 0 && length % 2 !== 0)) {
      throw new TslPacketError('Invalid TSL 5.0 text length')
    }
    const text = data.subarray(offset, offset + length)
    let label: string
    try {
      label =
        (flags & 1) !== 0
          ? new TextDecoder('utf-16le', { fatal: true }).decode(text)
          : text.toString('ascii')
      if ((flags & 1) === 0 && text.some((byte) => byte > 0x7f)) throw new Error('non-ASCII')
    } catch {
      throw new TslPacketError('Invalid TSL 5.0 text encoding')
    }
    displays.push({
      protocol: '5.0',
      screen,
      address,
      label: label.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trimEnd(),
      flags: [],
      left: ((control >> 4) & 3) as TslColor,
      text: ((control >> 2) & 3) as TslColor,
      right: (control & 3) as TslColor,
      brightness: (control >> 6) & 3,
    })
    offset += length
  }
  return displays
}

/** Bounded incremental TCP decoder. 5.0 uses the standard FE/02, FE/FE wrapper. */
export class TslStreamDecoder {
  readonly #protocol: TslProtocol
  #bytes: number[] = []
  #escaped = false
  #inPacket = false
  constructor(protocol: TslProtocol) {
    this.#protocol = protocol
  }

  push(
    chunk: Buffer,
    onError: (error: TslPacketError) => void = () => undefined,
  ): readonly TslDisplay[] {
    const displays: TslDisplay[] = []
    for (const byte of chunk) {
      if (this.#protocol === '3.1') {
        if (byte >= 0x80) this.#bytes = []
        if (this.#bytes.length === 0 && (byte < 0x80 || byte > 0xfe)) continue
        this.#bytes.push(byte)
        if (this.#bytes.length === 18) this.#finish(displays, onError)
        continue
      }
      if (this.#escaped) {
        this.#escaped = false
        if (byte === 0x02) {
          if (this.#bytes.length > 0)
            onError(new TslPacketError('Truncated TSL 5.0 stream packet'))
          this.#bytes = []
          this.#inPacket = true
          continue
        }
        if (byte !== 0xfe) {
          this.#bytes = []
          this.#inPacket = false
          onError(new TslPacketError('Invalid TSL 5.0 stream escape'))
          continue
        }
      } else if (byte === 0xfe) {
        this.#escaped = true
        continue
      }
      if (!this.#inPacket) continue
      this.#bytes.push(byte)
      if (this.#bytes.length >= 2) {
        const size = (this.#bytes[0] ?? 0) + ((this.#bytes[1] ?? 0) << 8) + 2
        if (size < 6 || size > 2048) {
          this.#bytes = []
          this.#inPacket = false
          onError(new TslPacketError('Invalid TSL 5.0 stream byte count'))
        } else if (this.#bytes.length === size) {
          this.#finish(displays, onError)
          this.#inPacket = false
        }
      }
    }
    return displays
  }

  #finish(displays: TslDisplay[], onError: (error: TslPacketError) => void): void {
    const packet = Buffer.from(this.#bytes)
    this.#bytes = []
    try {
      displays.push(...parseTslPacket(this.#protocol, packet))
    } catch (error) {
      onError(error instanceof TslPacketError ? error : new TslPacketError(String(error)))
    }
  }
}
