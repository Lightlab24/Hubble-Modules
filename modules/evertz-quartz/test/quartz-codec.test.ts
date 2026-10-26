import { describe, expect, it } from 'vitest'
import {
  QuartzFrameDecoder,
  encodeQuartzRoute,
  parseQuartzMessage,
  quartzLevelLetters,
} from '../src/quartz/codec.js'

describe('Evertz AN65 Quartz framing and commands', () => {
  it('encodes the documented multi-level destination/source order and CR terminator', () => {
    expect(encodeQuartzRoute(2, 1, [1, 2, 3, 4], 8)).toBe('.SVABC1,2\r')
    expect(encodeQuartzRoute(3, 9, [4], 16)).toBe('.SC9,3\r')
    expect(quartzLevelLetters([26, 22, 23, 1], 26)).toBe('VUWZ')
    expect(() => encodeQuartzRoute(0, 1, [1], 8)).toThrow()
    expect(() => encodeQuartzRoute(1, 1, [9], 8)).toThrow()
  })

  it('decodes AN65 updates and concatenated route-list replies', () => {
    expect(parseQuartzMessage('.UAB001,002')).toEqual({
      type: 'routes',
      update: true,
      crosspoints: [
        { level: 2, destination: 1, source: 2 },
        { level: 3, destination: 1, source: 2 },
      ],
    })
    expect(parseQuartzMessage('.AV001,002V002,003')).toEqual({
      type: 'routes',
      update: false,
      crosspoints: [
        { level: 1, destination: 1, source: 2 },
        { level: 1, destination: 2, source: 3 },
      ],
    })
    expect(parseQuartzMessage('.UV1,2junk')).toBeNull()
    expect(parseQuartzMessage('.UV0,2')).toBeNull()
    expect(parseQuartzMessage('.A')).toEqual({ type: 'ack' })
    expect(parseQuartzMessage('.E')).toEqual({ type: 'error' })
  })

  it('preserves indexed and legacy name responses and numeric lock ownership', () => {
    expect(parseQuartzMessage('.RAS005,CAMERA 5')).toEqual({
      type: 'name',
      kind: 'S',
      address: '005',
      name: 'CAMERA 5',
    })
    expect(parseQuartzMessage('.RADMONITOR ')).toEqual({
      type: 'name',
      kind: 'D',
      address: null,
      name: 'MONITOR',
    })
    expect(parseQuartzMessage('.BA12,0')).toEqual({ type: 'lock', destination: 12, owner: 0 })
    expect(parseQuartzMessage('.BA12,254')).toEqual({
      type: 'lock',
      destination: 12,
      owner: 254,
    })
    expect(parseQuartzMessage('.BA12,255')).toEqual({
      type: 'lock',
      destination: 12,
      owner: 255,
    })
    expect(parseQuartzMessage('.BA12,256')).toBeNull()
  })

  it('handles split/coalesced TCP frames, CRLF, Unicode names, and bounded input', () => {
    const decoder = new QuartzFrameDecoder()
    expect(decoder.push(Buffer.from('.UV001,'))).toEqual([])
    expect(decoder.push(Buffer.from('002\r\n.A\r\n.RAS1,Caméra\r'))).toEqual([
      '.UV001,002',
      '.A',
      '.RAS1,Caméra',
    ])
    expect(() => decoder.push(Buffer.alloc(65_537, 65))).toThrow('64 KiB')
  })

  it('parses the exact CyanView examples numerically across fragmented TCP chunks', () => {
    const decoder = new QuartzFrameDecoder()
    expect(decoder.push(Buffer.from('.AV05'))).toEqual([])
    const frames = decoder.push(Buffer.from('5,06\r.UVAB055,04\r.A\r.E\r.unknown\r'))
    expect(frames.map(parseQuartzMessage)).toEqual([
      {
        type: 'routes',
        update: false,
        crosspoints: [{ destination: 55, source: 6, level: 1 }],
      },
      {
        type: 'routes',
        update: true,
        crosspoints: [
          { destination: 55, source: 4, level: 1 },
          { destination: 55, source: 4, level: 2 },
          { destination: 55, source: 4, level: 3 },
        ],
      },
      { type: 'ack' },
      { type: 'error' },
      null,
    ])
    expect(encodeQuartzRoute(6, 55, [1], 1)).toBe('.SV55,6\r')
  })
})
