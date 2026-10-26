export function packet31(address = 1, flags = 2, label = 'CAM 1'): Buffer {
  const packet = Buffer.alloc(18, 0x20)
  packet[0] = 0x80 + address
  packet[1] = flags | 0x30
  packet.write(label, 2, 16, 'ascii')
  return packet
}

export function packet50(
  screen: number,
  displays: readonly { address: number; control: number; label: string }[],
  unicode = false,
): Buffer {
  const messages = displays.map(({ address, control, label }) => {
    const text = Buffer.from(label, unicode ? 'utf16le' : 'ascii')
    const message = Buffer.alloc(6 + text.length)
    message.writeUInt16LE(address)
    message.writeUInt16LE(control, 2)
    message.writeUInt16LE(text.length, 4)
    text.copy(message, 6)
    return message
  })
  const header = Buffer.alloc(6)
  header.writeUInt16LE(4 + messages.reduce((sum, message) => sum + message.length, 0))
  header[3] = unicode ? 1 : 0
  header.writeUInt16LE(screen, 4)
  return Buffer.concat([header, ...messages])
}

export function stream50(packet: Buffer): Buffer {
  return Buffer.from([
    0xfe,
    2,
    ...Array.from(packet).flatMap((byte) => (byte === 0xfe ? [byte, byte] : [byte])),
  ])
}
