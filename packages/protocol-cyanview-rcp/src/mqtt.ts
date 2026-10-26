export const FILTERS = [
  '+/+/rcp/status/volatile/active_camera',
  '+/+/rcp_helper/status/volatile/control',
  '+/+/camhead/status/persist/number',
] as const

export const MAX_PACKET_BYTES = 262_144

export const MAX_ENTITIES = 1_024

export function mqttText(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

export function packet(header: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  let remaining = payload.length
  const length: number[] = []
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 128
    length.push(byte)
  } while (remaining > 0)
  return Buffer.concat([Buffer.from([header, ...length]), payload])
}
