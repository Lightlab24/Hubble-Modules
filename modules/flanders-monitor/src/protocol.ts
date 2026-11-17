/**
 * A key press is one 12-byte packet:
 *
 *   01 06 <crc hi> <crc lo> 00 01 00 <key> 00 00 00 00
 *
 * The checksum is CRC-16/X-25 (reflected polynomial 0x1021, start 0xFFFF,
 * final XOR 0xFFFF) over the whole packet with the two checksum bytes set to
 * zero, written high byte first. It reproduces every packet in FSI's shell
 * scripts byte for byte (see test/protocol.test.ts).
 */
export function crc16x25(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return (crc ^ 0xffff) & 0xffff;
}

export function keyPacket(code: number): Buffer {
  if (!Number.isInteger(code) || code < 0 || code > 0xff)
    throw new RangeError("A key code is one byte");
  const packet = Buffer.from([0x01, 0x06, 0, 0, 0x00, 0x01, 0x00, code, 0, 0, 0, 0]);
  const crc = crc16x25(packet);
  packet[2] = crc >>> 8;
  packet[3] = crc & 0xff;
  return packet;
}

/** Reads a key packet back, or null when it isn't one with a good checksum. */
export function decodeKeyPacket(packet: Uint8Array): number | null {
  if (packet.length !== 12 || packet[0] !== 0x01 || packet[1] !== 0x06) return null;
  const copy = Buffer.from(packet);
  const sent = (copy[2]! << 8) | copy[3]!;
  copy[2] = 0;
  copy[3] = 0;
  return crc16x25(copy) === sent && copy[5] === 0x01 ? copy[7]! : null;
}
