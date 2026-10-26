import { describe, expect, it } from 'vitest'

import {
  OgpNetstringDecoder,
  encodeOgpNetstring,
  type OgpNetstringFrame,
} from '../src/netstring-codec.js'

function plain(text: string): OgpNetstringFrame {
  return Object.freeze({ text: Buffer.from(text), binary: null })
}

describe('OGP modified netstrings', () => {
  it('uses UTF-8 byte lengths and decodes a frame split at every boundary', () => {
    const encoded = encodeOgpNetstring('{"label":"Café"}')

    expect(encoded.subarray(0, encoded.indexOf(0x3a)).toString('ascii')).toBe('17')

    for (let split = 0; split <= encoded.length; split += 1) {
      const decoder = new OgpNetstringDecoder()
      expect(decoder.push(encoded.subarray(0, split))).toEqual(
        split === encoded.length ? [plain('{"label":"Café"}')] : [],
      )
      if (split < encoded.length) {
        expect(decoder.push(encoded.subarray(split))).toEqual([plain('{"label":"Café"}')])
      }
    }
  })

  it('decodes coalesced plain and empty keepalive frames', () => {
    const decoder = new OgpNetstringDecoder()

    expect(
      decoder.push(
        Buffer.concat([
          encodeOgpNetstring('{"type":"one"}'),
          encodeOgpNetstring(Buffer.alloc(0)),
          encodeOgpNetstring('{"type":"two"}'),
        ]),
      ),
    ).toEqual([plain('{"type":"one"}'), plain(''), plain('{"type":"two"}')])
  })

  it('decodes mixed JSON and binary frames without scanning binary delimiters', () => {
    const decoder = new OgpNetstringDecoder()
    const binary = Buffer.from([0x3a, 0x2c, 0x00, 0xff])

    expect(decoder.push(encodeOgpNetstring('{"zip":"gzip"}', binary))).toEqual([
      Object.freeze({ text: Buffer.from('{"zip":"gzip"}'), binary }),
    ])
  })

  it('rejects malformed and ambiguous length headers', () => {
    for (const encoded of ['-1:x,', '+1:x,', '01:x,', '1,2,3:xabc,', 'x:x,']) {
      expect(() => new OgpNetstringDecoder().push(Buffer.from(encoded))).toThrow(
        /netstring header/iu,
      )
    }
  })

  it('rejects an invalid terminal delimiter and trailing invalid frame', () => {
    expect(() => new OgpNetstringDecoder().push(Buffer.from('1:x;'))).toThrow(/terminator/iu)
    expect(() =>
      new OgpNetstringDecoder().push(
        Buffer.concat([encodeOgpNetstring('{}'), Buffer.from('junk:x,')]),
      ),
    ).toThrow(/netstring header/iu)
  })

  it('enforces text, binary, header, and buffered byte limits', () => {
    expect(() =>
      new OgpNetstringDecoder({ maxTextBytes: 2 }).push(Buffer.from('3:abc,')),
    ).toThrow(/text length/iu)
    expect(() =>
      new OgpNetstringDecoder({ maxBinaryBytes: 2 }).push(Buffer.from('0,3:abc,')),
    ).toThrow(/binary length/iu)
    expect(() =>
      new OgpNetstringDecoder({ maxHeaderBytes: 3 }).push(Buffer.from('1234')),
    ).toThrow(/header/iu)
    expect(() =>
      new OgpNetstringDecoder({ maxBufferedBytes: 4 }).push(Buffer.from('3:ab')),
    ).not.toThrow()
    expect(() =>
      new OgpNetstringDecoder({ maxBufferedBytes: 4 }).push(Buffer.from('3:abc')),
    ).toThrow(/buffer/iu)
  })

  it('drops a partial frame when reset', () => {
    const decoder = new OgpNetstringDecoder()
    expect(decoder.push(Buffer.from('3:a'))).toEqual([])

    decoder.reset()

    expect(decoder.push(Buffer.from('1:z,'))).toEqual([plain('z')])
  })
})
