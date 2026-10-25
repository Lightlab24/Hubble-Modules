export interface OgpNetstringFrame {
  readonly text: Buffer
  readonly binary: Buffer | null
}

export interface OgpNetstringDecoderOptions {
  readonly maxTextBytes?: number
  readonly maxBinaryBytes?: number
  readonly maxHeaderBytes?: number
  readonly maxBufferedBytes?: number
}

const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_BINARY_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_HEADER_BYTES = 64
const DEFAULT_MAX_BUFFERED_BYTES = 36 * 1024 * 1024
const COLON = 0x3a
const COMMA = 0x2c

function boundedInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return selected
}

function parseLength(text: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    throw new Error(`Invalid OGP netstring header: ${label} is malformed`)
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid OGP netstring header: ${label} is too large`)
  }
  return value
}

export function encodeOgpNetstring(
  text: string | Buffer,
  binary: Buffer | null = null,
): Buffer {
  const textBytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text)
  const binaryBytes = binary === null ? null : Buffer.from(binary)
  const header =
    binaryBytes === null
      ? `${String(textBytes.length)}:`
      : `${String(textBytes.length)},${String(binaryBytes.length)}:`
  return Buffer.concat([
    Buffer.from(header, 'ascii'),
    textBytes,
    ...(binaryBytes === null ? [] : [binaryBytes]),
    Buffer.from(','),
  ])
}

export class OgpNetstringDecoder {
  private buffer = Buffer.alloc(0)
  private readonly maxTextBytes: number
  private readonly maxBinaryBytes: number
  private readonly maxHeaderBytes: number
  private readonly maxBufferedBytes: number

  public constructor(options: OgpNetstringDecoderOptions = {}) {
    this.maxTextBytes = boundedInteger(
      options.maxTextBytes,
      DEFAULT_MAX_TEXT_BYTES,
      'maxTextBytes',
    )
    this.maxBinaryBytes = boundedInteger(
      options.maxBinaryBytes,
      DEFAULT_MAX_BINARY_BYTES,
      'maxBinaryBytes',
    )
    this.maxHeaderBytes = boundedInteger(
      options.maxHeaderBytes,
      DEFAULT_MAX_HEADER_BYTES,
      'maxHeaderBytes',
    )
    this.maxBufferedBytes = boundedInteger(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      'maxBufferedBytes',
    )
  }

  public push(chunk: Buffer | Uint8Array): readonly OgpNetstringFrame[] {
    if (chunk.length > 0) {
      const combinedLength = this.buffer.length + chunk.length
      if (combinedLength > this.maxBufferedBytes) {
        throw new Error(`OGP netstring buffer exceeds ${String(this.maxBufferedBytes)} bytes`)
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)], combinedLength)
    }

    const frames: OgpNetstringFrame[] = []
    while (this.buffer.length > 0) {
      const colonIndex = this.buffer.indexOf(COLON)
      if (colonIndex < 0) {
        if (this.buffer.length > this.maxHeaderBytes) {
          throw new Error(`OGP netstring header exceeds ${String(this.maxHeaderBytes)} bytes`)
        }
        break
      }
      if (colonIndex > this.maxHeaderBytes) {
        throw new Error(`OGP netstring header exceeds ${String(this.maxHeaderBytes)} bytes`)
      }

      const header = this.buffer.subarray(0, colonIndex).toString('ascii')
      const headerParts = header.split(',')
      if (headerParts.length < 1 || headerParts.length > 2) {
        throw new Error('Invalid OGP netstring header')
      }
      const textLength = parseLength(headerParts[0] ?? '', 'text length')
      const binaryLength =
        headerParts.length === 2 ? parseLength(headerParts[1] ?? '', 'binary length') : null
      if (textLength > this.maxTextBytes) {
        throw new Error(`OGP netstring text length exceeds ${String(this.maxTextBytes)} bytes`)
      }
      if (binaryLength !== null && binaryLength > this.maxBinaryBytes) {
        throw new Error(
          `OGP netstring binary length exceeds ${String(this.maxBinaryBytes)} bytes`,
        )
      }

      const payloadLength = textLength + (binaryLength ?? 0)
      const frameLength = colonIndex + 1 + payloadLength + 1
      if (this.buffer.length < frameLength) break
      if (this.buffer[frameLength - 1] !== COMMA) {
        throw new Error('Invalid OGP netstring terminator')
      }

      const textStart = colonIndex + 1
      const binaryStart = textStart + textLength
      const frame = Object.freeze({
        text: Buffer.from(this.buffer.subarray(textStart, binaryStart)),
        binary:
          binaryLength === null
            ? null
            : Buffer.from(this.buffer.subarray(binaryStart, binaryStart + binaryLength)),
      })
      frames.push(frame)
      this.buffer = this.buffer.subarray(frameLength)
    }
    return frames
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}
