import { describe, expect, it } from 'vitest'

import {
  LIGHTENCODE_CAPABILITIES,
  LIGHTENCODE_CLIENT_ID,
  LIGHTENCODE_CLIENT_VERSION,
  LIGHTENCODE_MAXIMUM_MESSAGE_BYTES,
  LightEncodeNdjsonFramer,
  LightEncodeProtocolValidationError,
  createLightEncodeClientHello,
  createLightEncodeCommand,
  parseLightEncodeServerMessage,
} from '../src/protocol.js'

const REQUEST_ID = 'fa121667-ff11-4180-a68b-5d99dd671fb5'
const PIPELINE_ID = 'd396fe70-517f-416c-882b-c831795ad942'
const SESSION_ID = '49fd5ac4-8c89-4f15-a596-bec3667d5be8'

describe('Light Encode protocol', () => {
  it('creates the canonical Hubble hello and UUID-correlated commands', () => {
    expect(createLightEncodeClientHello()).toEqual({
      type: 'hello',
      protocol: 'lightencode-companion',
      protocolVersion: 1,
      client: LIGHTENCODE_CLIENT_ID,
      clientVersion: LIGHTENCODE_CLIENT_VERSION,
    })

    expect(
      createLightEncodeCommand(
        'record.togglePipeline',
        { scope: 'pipeline', pipelineId: PIPELINE_ID },
        {},
        REQUEST_ID,
      ),
    ).toEqual({
      type: 'command',
      id: REQUEST_ID,
      name: 'record.togglePipeline',
      target: { scope: 'pipeline', pipelineId: PIPELINE_ID },
      args: {},
    })
    expect(createLightEncodeCommand('timer.set', { scope: 'app' }, { minutes: 30 }).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
  })

  it('parses canonical hello, state, response, error, ping, and pong fixtures', () => {
    const fixtures = [
      helloAck(),
      stateMessage(143),
      response({ kind: 'pipelinesRecording', pipelineIds: [PIPELINE_ID], recording: true }),
      response({ kind: 'timerEnabled', enabled: true }),
      response({ kind: 'timerMinutes', minutes: 30 }),
      {
        type: 'response',
        id: REQUEST_ID.toUpperCase(),
        ok: false,
        code: 'pipeline_busy',
        message: 'CAM1 is still finishing',
        stateRevision: 143,
        confirmation: null,
        failures: null,
      },
      { type: 'error', id: REQUEST_ID, code: 'protocol_error', message: 'Bad command' },
      { type: 'ping', timestamp: 1_783_621_200_000 },
      { type: 'pong', timestamp: 1_783_621_200_000 },
    ]

    expect(fixtures.map((fixture) => parseLightEncodeServerMessage(fixture).type)).toEqual([
      'helloAck',
      'state',
      'response',
      'response',
      'response',
      'response',
      'error',
      'ping',
      'pong',
    ])
  })

  it('strictly rejects invalid or semantically incomplete inbound shapes', () => {
    const invalid = [
      { ...helloAck(), extra: true },
      { ...helloAck(), protocolVersion: 2 },
      { ...helloAck(), sessionId: 'not-a-uuid' },
      { ...helloAck(), capabilities: [...LIGHTENCODE_CAPABILITIES, 4] },
      { ...helloAck(), capabilities: LIGHTENCODE_CAPABILITIES.slice(0, -1) },
      { ...stateMessage(1), revision: -1 },
      {
        ...stateMessage(1),
        app: { anyRecording: false, timerEnabled: false, timerMinutes: 1_441 },
      },
      {
        ...stateMessage(1),
        pipelines: [
          {
            ...stateMessage(1).pipelines[0],
            recordingState: 'paused',
          },
        ],
      },
      {
        type: 'response',
        id: REQUEST_ID,
        ok: true,
        code: null,
        message: null,
        stateRevision: 2,
        confirmation: null,
        failures: null,
      },
      response({ kind: 'timerMinutes', minutes: 1_441 }),
      { type: 'error', code: '', message: 'No code' },
      { type: 'pong', timestamp: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'unknown' },
    ]

    for (const value of invalid) {
      expect(() => parseLightEncodeServerMessage(value)).toThrow(
        LightEncodeProtocolValidationError,
      )
    }
  })

  it('requires all version-one capabilities while tolerating future extras', () => {
    expect(
      parseLightEncodeServerMessage({
        ...helloAck(),
        capabilities: [...LIGHTENCODE_CAPABILITIES, 'future.readonlyCapability'],
      }),
    ).toMatchObject({ type: 'helloAck' })
  })

  it('normalizes current Swift failure keys to the documented protocol shape', () => {
    const parsed = parseLightEncodeServerMessage({
      type: 'response',
      id: REQUEST_ID,
      ok: false,
      code: 'partial_failure',
      message: 'Some recording sources did not start',
      stateRevision: 143,
      confirmation: null,
      failures: [
        {
          pipelineID: PIPELINE_ID.toUpperCase(),
          cameraID: 'CAM1',
          code: 'pipeline_not_ready',
          reason: 'Source is not ready',
        },
      ],
    })

    expect(parsed.type).toBe('response')
    if (parsed.type !== 'response') throw new Error('Expected response')
    expect(parsed.failures).toEqual([
      {
        pipelineId: PIPELINE_ID.toUpperCase(),
        cameraId: 'CAM1',
        code: 'pipeline_not_ready',
        reason: 'Source is not ready',
      },
    ])
  })

  it('sanitizes and bounds server-owned diagnostic text', () => {
    const parsed = parseLightEncodeServerMessage({
      type: 'response',
      id: REQUEST_ID,
      ok: false,
      code: 'pipeline_busy',
      message: `\u0000CAM1\n${'x'.repeat(800)}`,
      stateRevision: 3,
      confirmation: null,
      failures: null,
    })

    expect(parsed.type).toBe('response')
    if (parsed.type !== 'response') throw new Error('Expected response')
    expect(parsed.message).not.toMatch(/[\u0000\r\n]/u)
    expect(parsed.message).toHaveLength(512)
  })
})

describe('LightEncodeNdjsonFramer', () => {
  it('accepts split frames, CRLF, empty lines, and several frames per read', () => {
    const framer = new LightEncodeNdjsonFramer()
    expect(framer.push(Buffer.from('{"type":"pong",'))).toEqual([])
    expect(
      framer.push(
        Buffer.from(
          '"timestamp":42}\r\n\n{"type":"ping","timestamp":43}\n{"type":"pong","timestamp":43}\n',
        ),
      ),
    ).toEqual([
      { type: 'pong', timestamp: 42 },
      { type: 'ping', timestamp: 43 },
      { type: 'pong', timestamp: 43 },
    ])
  })

  it('rejects invalid JSON and UTF-8 without retaining the consumed bad frame', () => {
    const malformed = new LightEncodeNdjsonFramer()
    expect(() =>
      malformed.push(Buffer.from('{bad json}\n{"type":"pong","timestamp":3}\n')),
    ).toThrow('invalid JSON')
    expect(malformed.push(Buffer.alloc(0))).toEqual([{ type: 'pong', timestamp: 3 }])

    const invalidUtf8 = new LightEncodeNdjsonFramer()
    expect(() =>
      invalidUtf8.push(
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
      ),
    ).toThrow('UTF-8')
  })

  it('enforces the 256 KiB limit for terminated and unterminated frames', () => {
    const unterminated = new LightEncodeNdjsonFramer()
    expect(() =>
      unterminated.push(Buffer.alloc(LIGHTENCODE_MAXIMUM_MESSAGE_BYTES + 1, 0x41)),
    ).toThrow('exceeds 256 KiB')

    const terminated = new LightEncodeNdjsonFramer()
    expect(() =>
      terminated.push(
        Buffer.concat([
          Buffer.alloc(LIGHTENCODE_MAXIMUM_MESSAGE_BYTES + 1, 0x41),
          Buffer.from('\n'),
        ]),
      ),
    ).toThrow('exceeds 256 KiB')

    const trailing = new LightEncodeNdjsonFramer()
    expect(() =>
      trailing.push(
        Buffer.concat([
          Buffer.from('{"type":"pong","timestamp":1}\n'),
          Buffer.alloc(LIGHTENCODE_MAXIMUM_MESSAGE_BYTES + 1, 0x41),
        ]),
      ),
    ).toThrow('exceeds 256 KiB')
  })
})

function helloAck() {
  return {
    type: 'helloAck',
    protocol: 'lightencode-companion',
    protocolVersion: 1,
    appVersion: '1.0.0',
    sessionId: SESSION_ID,
    capabilities: LIGHTENCODE_CAPABILITIES,
  }
}

function response(confirmation: unknown) {
  return {
    type: 'response',
    id: REQUEST_ID,
    ok: true,
    code: null,
    message: 'Accepted',
    stateRevision: 143,
    confirmation,
    failures: null,
  }
}

function stateMessage(revision: number) {
  return {
    type: 'state',
    revision,
    app: { anyRecording: true, timerEnabled: true, timerMinutes: 30 },
    pipelines: [
      {
        pipelineId: PIPELINE_ID,
        cameraId: 'CAM1',
        recordingEnabled: true,
        canStartRecording: true,
        recordingState: 'recording',
        errorMessage: null,
      },
    ],
  }
}
