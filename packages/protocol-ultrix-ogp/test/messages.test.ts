import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  decodeOgpFrame,
  encodeHandshake,
  encodeSubscriptionRequest,
  encodeValueRequest,
  isImplicitHandshakeSuccess,
} from '../src/messages.js'
import { OgpNetstringDecoder, encodeOgpNetstring } from '../src/netstring-codec.js'

function decodedWire(bytes: Buffer) {
  const frames = new OgpNetstringDecoder().push(bytes)
  expect(frames).toHaveLength(1)
  return decodeOgpFrame(frames[0]!)
}

describe('OGP JSON messages', () => {
  it('encodes the safe minimal subscription handshake without force', () => {
    const decoded = decodedWire(
      encodeHandshake({
        trusted: true,
        detail: 'minimal',
        subscriptions: true,
        build: 'Hubble test',
      }),
    )

    expect(decoded).toEqual({
      kind: 'message',
      message: {
        type: 'handshake',
        slot: 0,
        payload: {
          trusted: true,
          force: false,
          detail: 'minimal',
          subscriptions: true,
          build: 'Hubble test',
        },
      },
    })
  })

  it('accepts the first gzip device as implicit handshake success', () => {
    const payload = {
      slot: 0,
      detail: 'minimal',
      subscriptions: true,
      params: {},
    }
    const decoded = decodedWire(
      encodeOgpNetstring(
        JSON.stringify({ slot: 0, type: 'device', zip: 'gzip' }),
        gzipSync(JSON.stringify(payload)),
      ),
    )

    expect(decoded).toEqual({
      kind: 'message',
      message: {
        slot: 0,
        type: 'device',
        zip: 'gzip',
        payload,
      },
    })
    expect(decoded.kind === 'message' && isImplicitHandshakeSuccess(decoded.message)).toBe(true)
  })

  it('decodes empty frames as keepalives', () => {
    expect(decodedWire(encodeOgpNetstring(Buffer.alloc(0)))).toEqual({ kind: 'keepalive' })
  })

  it('encodes subscription and indexed value requests exactly', () => {
    expect(
      decodedWire(
        encodeSubscriptionRequest([
          'params.statusByDestination.0.inputstatus',
          'params.controlready',
          'params.takeError',
        ]),
      ),
    ).toMatchObject({
      kind: 'message',
      message: {
        type: 'device-request',
        slot: 0,
        payload: {
          detail: 'subscription',
          subscription: [
            'params.statusByDestination.0.inputstatus',
            'params.controlready',
            'params.takeError',
          ],
        },
      },
    })
    expect(
      decodedWire(
        encodeValueRequest({
          oid: 'params.basicsources',
          element: true,
          index: 151,
        }),
      ),
    ).toMatchObject({
      kind: 'message',
      message: {
        type: 'value-request',
        payload: { oid: 'params.basicsources', element: true, index: 151 },
      },
    })
  })

  it('recognizes value, multi-value, error, and unknown messages', () => {
    for (const message of [
      {
        type: 'value',
        slot: 0,
        payload: { oid: 'params.controlready', value: 1 },
      },
      {
        type: 'multi-value',
        slot: 0,
        payload: [{ oid: 'params.takeError', value: 'None|Timestamp' }],
      },
      { type: 'error', slot: 0, payload: { reason: 'bad-request' } },
    ]) {
      expect(decodedWire(encodeOgpNetstring(JSON.stringify(message)))).toEqual({
        kind: 'message',
        message,
      })
    }

    expect(
      decodedWire(
        encodeOgpNetstring(JSON.stringify({ type: 'future-message', slot: 0, payload: {} })),
      ),
    ).toMatchObject({ kind: 'unknown', message: { type: 'future-message' } })
  })

  it('rejects corrupt, unsupported, and oversized compressed payloads', () => {
    expect(() =>
      decodedWire(
        encodeOgpNetstring(
          JSON.stringify({ slot: 0, type: 'device', zip: 'gzip' }),
          Buffer.from('not gzip'),
        ),
      ),
    ).toThrow(/gzip/iu)
    expect(() =>
      decodedWire(
        encodeOgpNetstring(
          JSON.stringify({ slot: 0, type: 'device', zip: 'deflate' }),
          gzipSync('{}'),
        ),
      ),
    ).toThrow(/compression/iu)
    expect(() =>
      decodeOgpFrame(
        new OgpNetstringDecoder()
          .push(
            encodeOgpNetstring(
              JSON.stringify({ slot: 0, type: 'device', zip: 'gzip' }),
              gzipSync(JSON.stringify({ value: 'x'.repeat(4_096) })),
            ),
          )
          .at(0)!,
        { maxInflatedBytes: 100 },
      ),
    ).toThrow(/decompress|larger/iu)
  })
})
