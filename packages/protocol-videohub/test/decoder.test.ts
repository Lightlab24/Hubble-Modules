import { describe, expect, it } from 'vitest'

import {
  MAX_VIDEOHUB_ADDRESS,
  VideohubDecodeError,
  VideohubSectionDecoder,
  encodeStatusRequest,
  encodeVideoOutputRouting,
  fromVideohubAddress,
  toVideohubAddress,
} from '../src/index.js'

describe('VideohubSectionDecoder', () => {
  it('decodes fragmented and coalesced LF blocks', () => {
    const decoder = new VideohubSectionDecoder()
    expect(decoder.push('PROTOCOL PRE')).toEqual([])
    expect(
      decoder.push('AMBLE:\nVersion: 2.3\n\nINPUT LABELS:\n0 Camera 1\n1 Camera 2\n\nACK\n\n'),
    ).toEqual([
      { type: 'protocol-preamble', version: '2.3', major: 2, minor: 3 },
      {
        type: 'input-labels',
        labels: [
          { address: 1, name: 'Camera 1' },
          { address: 2, name: 'Camera 2' },
        ],
      },
      { type: 'ack' },
    ])
  })

  it('supports CRLF and CR split across chunks without inventing blank lines', () => {
    const decoder = new VideohubSectionDecoder()
    expect(decoder.push('OUTPUT LABELS:\r')).toEqual([])
    expect(decoder.push('\n0 Program\r\n1 Preview\r')).toEqual([])
    expect(decoder.push('\n\r\nNAK\r\r')).toEqual([
      {
        type: 'output-labels',
        labels: [
          { address: 1, name: 'Program' },
          { address: 2, name: 'Preview' },
        ],
      },
      { type: 'nak' },
    ])
  })

  it('preserves unsafe Unicode line separators for catalog-boundary sanitization', () => {
    const decoder = new VideohubSectionDecoder()
    expect(decoder.push('INPUT LABELS:\n0 Camera\u2028One\n\n')).toEqual([
      {
        type: 'input-labels',
        labels: [{ address: 1, name: 'Camera\u2028One' }],
      },
    ])
  })

  it('ignores unknown lines and preserves unknown blocks for forward compatibility', () => {
    const decoder = new VideohubSectionDecoder()
    expect(
      decoder.push(
        'VIDEOHUB DEVICE:\nDevice present: true\nModel name: 20x20\nVideo inputs: 20\nVideo outputs: 20\nFuture field: yes\n\nFUTURE STATUS:\nanything goes\n\n',
      ),
    ).toEqual([
      {
        type: 'device',
        status: 'present',
        modelName: '20x20',
        videoInputs: 20,
        videoOutputs: 20,
      },
      { type: 'unknown', header: 'FUTURE STATUS', lines: ['anything goes'] },
    ])
  })

  it('rejects malformed or unsupported device dimensions', () => {
    const decoder = new VideohubSectionDecoder()
    expect(() =>
      decoder.push(
        'VIDEOHUB DEVICE:\nDevice present: true\nModel name: Broken\nVideo inputs: sixteen\nVideo outputs: 16\n\n',
      ),
    ).toThrow(VideohubDecodeError)

    decoder.reset()
    expect(() =>
      decoder.push(
        `VIDEOHUB DEVICE:\nDevice present: true\nModel name: Huge\nVideo inputs: ${String(MAX_VIDEOHUB_ADDRESS + 1)}\nVideo outputs: 1\n\n`,
      ),
    ).toThrow(/Video inputs must be an integer from 1 to 65536/u)
  })

  it('bounds an unterminated block', () => {
    const decoder = new VideohubSectionDecoder({ maxBufferedBytes: 24 })
    expect(() => decoder.push('INPUT LABELS:\n0 ' + 'x'.repeat(30))).toThrow(
      /exceeded 24 bytes/u,
    )
  })

  it('converts addresses only at the wire boundary and encodes commands', () => {
    expect(toVideohubAddress(1)).toBe(0)
    expect(toVideohubAddress(65_536)).toBe(65_535)
    expect(fromVideohubAddress(0)).toBe(1)
    expect(fromVideohubAddress(65_535)).toBe(65_536)
    expect(() => toVideohubAddress(0)).toThrow(RangeError)
    expect(() => fromVideohubAddress(65_536)).toThrow(RangeError)
    expect(encodeVideoOutputRouting([{ destination: 8, source: 3 }]).toString()).toBe(
      'VIDEO OUTPUT ROUTING:\n7 2\n\n',
    )
    expect(encodeStatusRequest('VIDEO OUTPUT ROUTING').toString()).toBe(
      'VIDEO OUTPUT ROUTING:\n\n',
    )
  })
})
