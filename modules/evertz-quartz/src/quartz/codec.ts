import { StringDecoder } from 'node:string_decoder'

/** Evertz AN65 revision 1.4, sections 3 and 4. Numbers on the wire are one based. */
export const QUARTZ_LEVELS = 'VABCDEFGHIJKLMNOPQRSTUWXYZ'

export interface QuartzCrosspoint {
  readonly destination: number
  readonly source: number
  readonly level: number
}

export type QuartzMessage =
  | Readonly<{ type: 'ack' | 'error' | 'reset' }>
  | Readonly<{ type: 'routes'; update: boolean; crosspoints: readonly QuartzCrosspoint[] }>
  | Readonly<{ type: 'lock'; destination: number; owner: number }>
  | Readonly<{ type: 'name'; kind: 'S' | 'D' | 'L'; address: string | null; name: string }>

export function quartzAddress(value: number, maximum = 65_536): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Quartz address must be an integer from 1 to ${String(maximum)}`)
  }
  return value
}

export function quartzLevelLetters(levels: readonly number[], maximum: number): string {
  if (levels.length === 0) throw new RangeError('Select at least one Quartz level')
  return [...new Set(levels)]
    .sort((a, b) => a - b)
    .map((level) => QUARTZ_LEVELS[quartzAddress(level, maximum) - 1])
    .join('')
}

export function encodeQuartzRoute(
  source: number,
  destination: number,
  levels: readonly number[],
  maximumLevels: number,
): string {
  return `.S${quartzLevelLetters(levels, maximumLevels)}${String(quartzAddress(destination))},${String(quartzAddress(source))}\r`
}

export function parseQuartzMessage(frame: string): QuartzMessage | null {
  if (frame === '.A') return { type: 'ack' }
  if (frame === '.E') return { type: 'error' }
  if (frame === '.P') return { type: 'reset' }
  const lock = /^\.BA([0-9]+),([0-9]+)$/u.exec(frame)
  if (lock !== null) {
    const destination = Number(lock[1])
    const owner = Number(lock[2])
    return validAddress(destination) && Number.isInteger(owner) && owner >= 0 && owner <= 255
      ? { type: 'lock', destination, owner }
      : null
  }
  const name = /^\.RA([SDL])(.*)$/u.exec(frame)
  if (name !== null) {
    const kind = name[1] as 'S' | 'D' | 'L'
    const value = name[2] ?? ''
    const indexed = /^(\d+|[A-Z]),(.*)$/u.exec(value)
    return {
      type: 'name',
      kind,
      address: indexed?.[1] ?? null,
      name: (indexed?.[2] ?? value).trim(),
    }
  }
  if (!frame.startsWith('.U') && !frame.startsWith('.A')) return null
  const payload = frame.slice(2)
  const pattern = /([A-Z]+)([0-9]+),([0-9]+)/guy
  const crosspoints: QuartzCrosspoint[] = []
  let offset = 0
  while (offset < payload.length) {
    const match = pattern.exec(payload)
    if (match === null) return null
    const letters = match[1] ?? ''
    const destination = Number(match[2])
    const source = Number(match[3])
    if (!validAddress(destination) || !validAddress(source)) return null
    for (const letter of letters) {
      const level = QUARTZ_LEVELS.indexOf(letter) + 1
      if (level === 0) return null
      crosspoints.push({ destination, source, level })
    }
    offset = pattern.lastIndex
  }
  return crosspoints.length > 0
    ? { type: 'routes', update: frame[1] === 'U', crosspoints }
    : null
}

function validAddress(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_536
}

/** TCP chunks are not messages. Accept CR or CRLF, and bound incomplete input. */
export class QuartzFrameDecoder {
  readonly #decoder = new StringDecoder('utf8')
  #buffer = ''

  push(chunk: Buffer): readonly string[] {
    this.#buffer += this.#decoder.write(chunk)
    const frames: string[] = []
    let end: number
    while ((end = this.#buffer.indexOf('\r')) >= 0) {
      if (end > 65_536) throw new Error('Quartz response exceeds 64 KiB')
      const frame = this.#buffer.slice(0, end).replace(/^\n/u, '')
      this.#buffer = this.#buffer.slice(end + 1)
      if (frame !== '') frames.push(frame)
    }
    if (this.#buffer.length > 65_536) throw new Error('Quartz response exceeds 64 KiB')
    return frames
  }
}
