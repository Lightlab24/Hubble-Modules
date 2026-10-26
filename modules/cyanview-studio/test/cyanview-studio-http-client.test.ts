import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  CYANVIEW_STUDIO_RESPONSE_MAX_BYTES,
  CyanViewStudioHttpClient,
  CyanViewStudioHttpClientError,
  type CyanViewStudioFetch,
  type CyanViewStudioResponseLike,
} from '../src/cyanview-studio-http-client.js'

describe('CyanViewStudioHttpClient', () => {
  it('checks the bounded OpenAPI document for the exact Select Feed POST route', async () => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>().mockResolvedValue(
      jsonResponse(200, {
        openapi: '3.1.0',
        info: { title: 'CyanView Studio', version: ' 1.7.2 ' },
        paths: {
          '/api/control/feed': {
            post: {
              parameters: [
                queryParameter('project_id', 'integer'),
                queryParameter('feed_id', 'integer'),
                queryParameter('camera_id', 'string'),
              ],
              responses: {},
            },
          },
        },
      }),
    )
    const client = createClient(fetchStudio)

    await expect(client.probe()).resolves.toEqual({
      apiVersion: '1.7.2',
      supportsFeedId: true,
      supportsFeedNumber: false,
    })
    expect(fetchStudio).toHaveBeenCalledOnce()
    expect(fetchStudio.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4173/api/openapi')
    expect(fetchStudio.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      method: 'GET',
      redirect: 'error',
    })
  })

  it('sends one bodyless unauthenticated POST with URLSearchParams camera encoding', async () => {
    const fetchStudio = vi
      .fn<CyanViewStudioFetch>()
      .mockResolvedValue(jsonResponse(200, { status: 'ok' }))
    const client = createClient(fetchStudio)

    await expect(client.selectFeed('CAM / A+B?')).resolves.toBeUndefined()

    expect(fetchStudio).toHaveBeenCalledOnce()
    expect(fetchStudio.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:4173/api/control/feed?camera_id=CAM+%2F+A%2BB%3F',
    )
    const init = fetchStudio.mock.calls[0]?.[1]
    expect(init).toMatchObject({
      credentials: 'omit',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      method: 'POST',
      redirect: 'error',
    })
    expect(init).not.toHaveProperty('body')
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('recognizes the current Studio OpenAPI contract with visible feed numbers', async () => {
    const document: unknown = JSON.parse(
      readFileSync(new URL('./fixtures/cyanview-studio-openapi.json', import.meta.url), 'utf8'),
    )
    const client = createClient(
      vi.fn<CyanViewStudioFetch>().mockResolvedValue(jsonResponse(200, document)),
    )
    await expect(client.probe()).resolves.toEqual({
      apiVersion: '1.0.0',
      supportsFeedId: false,
      supportsFeedNumber: true,
    })
  })

  it.each([1, 2, 10, Number.MAX_SAFE_INTEGER])(
    'sends visible feed number %s as the only selector on one bodyless POST',
    async (feedNumber) => {
      const fetchStudio = vi
        .fn<CyanViewStudioFetch>()
        .mockResolvedValue(jsonResponse(200, { status: 'ok' }))
      const client = createClient(fetchStudio)

      await expect(client.selectFeedByNumber(feedNumber)).resolves.toBeUndefined()

      expect(fetchStudio).toHaveBeenCalledOnce()
      const endpoint = new URL(fetchStudio.mock.calls[0]?.[0] ?? '')
      expect([...endpoint.searchParams.entries()]).toEqual([
        ['feed_number', String(feedNumber)],
      ])
      const init = fetchStudio.mock.calls[0]?.[1]
      expect(init).toMatchObject({
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
        method: 'POST',
        redirect: 'error',
      })
      expect(init).not.toHaveProperty('body')
      expect(init?.headers).not.toHaveProperty('Authorization')
    },
  )

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2 ** 53,
  ])('rejects malformed visible feed number %s before fetch', async (feedNumber) => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>()

    await expect(
      createClient(fetchStudio).selectFeedByNumber(feedNumber),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    expect(fetchStudio).not.toHaveBeenCalled()
  })

  it.each([Number.MIN_SAFE_INTEGER, 0, 15, Number.MAX_SAFE_INTEGER])(
    'sends safe integer feed ID %s as the only selector on one bodyless POST',
    async (feedId) => {
      const fetchStudio = vi
        .fn<CyanViewStudioFetch>()
        .mockResolvedValue(jsonResponse(200, { status: 'ok' }))
      const client = createClient(fetchStudio)

      await expect(client.selectFeedByFeedId(feedId)).resolves.toBeUndefined()

      expect(fetchStudio).toHaveBeenCalledOnce()
      const endpoint = new URL(fetchStudio.mock.calls[0]?.[0] ?? '')
      expect([...endpoint.searchParams.entries()]).toEqual([['feed_id', String(feedId)]])
      const init = fetchStudio.mock.calls[0]?.[1]
      expect(init).toMatchObject({
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
        method: 'POST',
        redirect: 'error',
      })
      expect(init).not.toHaveProperty('body')
      expect(init?.headers).not.toHaveProperty('Authorization')
    },
  )

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53])(
    'rejects malformed feed ID %s before fetch',
    async (feedId) => {
      const fetchStudio = vi.fn<CyanViewStudioFetch>()

      await expect(createClient(fetchStudio).selectFeedByFeedId(feedId)).rejects.toMatchObject({
        code: 'invalid_request',
      })
      expect(fetchStudio).not.toHaveBeenCalled()
    },
  )

  it('maps a feed-ID 404 specifically and never retries', async () => {
    const fetchStudio = vi
      .fn<CyanViewStudioFetch>()
      .mockResolvedValue(jsonResponse(404, { private: 'do not expose' }))

    const error = await createClient(fetchStudio)
      .selectFeedByFeedId(15)
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CyanViewStudioHttpClientError)
    expect(error).toMatchObject({ code: 'feed_not_found' })
    expect(String(error)).not.toContain('15')
    expect(String(error)).not.toContain('do not expose')
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it('keeps camera-only OpenAPI contracts ready and reports feed ID as unsupported', async () => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>().mockResolvedValue(
      jsonResponse(200, {
        info: { version: 'camera-only' },
        paths: {
          '/api/control/feed': {
            post: { parameters: [queryParameter('camera_id', 'string')] },
          },
        },
      }),
    )

    await expect(createClient(fetchStudio).probe()).resolves.toEqual({
      apiVersion: 'camera-only',
      supportsFeedId: false,
      supportsFeedNumber: false,
    })
  })

  it.each([
    [[queryParameter('feed_id', 'integer')]],
    [[queryParameter('camera_id', 'integer'), queryParameter('feed_id', 'integer')]],
    [[{ ...queryParameter('camera_id', 'string'), in: 'header' }]],
    [[{ ...queryParameter('camera_id', 'string'), required: true }]],
    [[{ ...queryParameter('camera_id', 'string'), required: 'false' }]],
  ])(
    'rejects OpenAPI contracts without an optional camera_id string query',
    async (parameters) => {
      const fetchStudio = vi.fn<CyanViewStudioFetch>().mockResolvedValue(
        jsonResponse(200, {
          info: { version: 'invalid' },
          paths: { '/api/control/feed': { post: { parameters } } },
        }),
      )

      await expect(createClient(fetchStudio).probe()).rejects.toMatchObject({
        code: 'protocol_error',
      })
    },
  )

  it.each([
    [[queryParameter('camera_id', 'string')]],
    [[queryParameter('camera_id', 'string'), queryParameter('feed_id', 'string')]],
    [
      [
        queryParameter('camera_id', 'string'),
        { ...queryParameter('feed_id', 'integer'), in: 'header' },
      ],
    ],
    [
      [
        queryParameter('camera_id', 'string'),
        { ...queryParameter('feed_id', 'integer'), required: true },
      ],
    ],
    [
      [
        queryParameter('camera_id', 'string'),
        { ...queryParameter('feed_id', 'integer'), required: 'false' },
      ],
    ],
  ])('reports feed ID unsupported for absent or incorrect metadata', async (parameters) => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>().mockResolvedValue(
      jsonResponse(200, {
        info: { version: 'camera-compatible' },
        paths: { '/api/control/feed': { post: { parameters } } },
      }),
    )

    await expect(createClient(fetchStudio).probe()).resolves.toEqual({
      apiVersion: 'camera-compatible',
      supportsFeedId: false,
      supportsFeedNumber: false,
    })
  })

  it('uses Content-Length only as an early bound when decoded bytes have a different length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ status: 'ok' }))
    const fetchStudio = once(
      byteResponse(200, bytes, { declaredLength: bytes.byteLength + 17 }),
    )

    await expect(createClient(fetchStudio).selectFeed('CAM-1')).resolves.toBeUndefined()
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it.each(['invalid', String(CYANVIEW_STUDIO_RESPONSE_MAX_BYTES + 1)])(
    'cancels a response body rejected from Content-Length %s before reading it',
    async (declaredLength) => {
      const cancel = vi.fn(() => Promise.resolve())
      const fetchStudio = once(
        byteResponse(200, new TextEncoder().encode(JSON.stringify({ status: 'ok' })), {
          declaredLength,
          cancel,
        }),
      )

      await expect(createClient(fetchStudio).selectFeed('CAM-1')).rejects.toMatchObject({
        code: 'protocol_error',
      })
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetchStudio).toHaveBeenCalledOnce()
    },
  )

  it('accepts the full configured port range when URL normalizes HTTP port 80', async () => {
    const fetchStudio = vi
      .fn<CyanViewStudioFetch>()
      .mockResolvedValue(jsonResponse(200, { status: 'ok' }))
    const client = new CyanViewStudioHttpClient({
      host: 'cyanview.local',
      port: 80,
      requestTimeoutMs: 1_500,
      fetch: fetchStudio,
      scheduleTimeout: () => Object.freeze({}),
      clearTimeout: () => undefined,
    })

    await expect(client.selectFeed('CAM-A')).resolves.toBeUndefined()
    expect(fetchStudio.mock.calls[0]?.[0]).toBe(
      'http://cyanview.local/api/control/feed?camera_id=CAM-A',
    )
  })

  it.each([
    [404, 'camera_not_found'],
    [422, 'invalid_request'],
    [302, 'protocol_error'],
    [503, 'unavailable'],
  ] as const)(
    'maps HTTP %i without retrying or exposing a response body',
    async (status, code) => {
      const fetchStudio = vi
        .fn<CyanViewStudioFetch>()
        .mockResolvedValue(jsonResponse(status, { private: 'do not expose' }))
      const client = createClient(fetchStudio)

      const error = await client.selectFeed('PRIVATE-CAMERA').catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(CyanViewStudioHttpClientError)
      expect(error).toMatchObject({ code })
      expect(String(error)).not.toContain('PRIVATE-CAMERA')
      expect(String(error)).not.toContain('do not expose')
      expect(fetchStudio).toHaveBeenCalledOnce()
    },
  )

  it('rejects malformed, non-strict, missing-route, and oversized success documents', async () => {
    const responses = [
      byteResponse(200, new TextEncoder().encode('{')),
      jsonResponse(200, { status: 'ok', selected: 'private' }),
      jsonResponse(200, {
        info: { version: '1.0' },
        paths: { '/api/control/feed': { get: {} } },
      }),
      byteResponse(200, new Uint8Array(CYANVIEW_STUDIO_RESPONSE_MAX_BYTES + 1)),
    ] as const

    await expect(createClient(once(responses[0])).selectFeed('CAM-1')).rejects.toMatchObject({
      code: 'protocol_error',
    })
    await expect(createClient(once(responses[1])).selectFeed('CAM-1')).rejects.toMatchObject({
      code: 'protocol_error',
    })
    await expect(createClient(once(responses[2])).probe()).rejects.toMatchObject({
      code: 'protocol_error',
    })
    await expect(createClient(once(responses[3])).selectFeed('CAM-1')).rejects.toMatchObject({
      code: 'protocol_error',
    })
  })

  it('bounds the whole response read with one timeout and never retries an ambiguous POST', async () => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('private timeout detail'))
        })
      })
    })
    const client = new CyanViewStudioHttpClient({
      host: '127.0.0.1',
      port: 4173,
      requestTimeoutMs: 1_500,
      fetch: fetchStudio,
      scheduleTimeout: (callback) => {
        queueMicrotask(callback)
        return Object.freeze({})
      },
      clearTimeout: () => undefined,
    })

    await expect(client.selectFeed('CAM-1')).rejects.toMatchObject({ code: 'timeout' })
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it.each([
    [204, 'unavailable'],
    [302, 'protocol_error'],
    [401, 'unavailable'],
    [503, 'unavailable'],
  ])(
    'rejects HTTP %s during capability discovery without reading the error body',
    async (status, code) => {
      const cancel = vi.fn(() => Promise.reject(new Error('connection closed')))
      const fetchStudio = once(byteResponse(status, new Uint8Array([1]), { cancel }))

      await expect(createClient(fetchStudio).probe()).rejects.toMatchObject({ code })
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetchStudio).toHaveBeenCalledOnce()
    },
  )

  it.each([
    null,
    [],
    {},
    { paths: null },
    { paths: { '/api/control/feed': null } },
    { paths: { '/api/control/feed': { post: null } } },
    { paths: { '/api/control/feed': { post: {} } } },
  ])('rejects missing or malformed OpenAPI structure: %j', async (document) => {
    await expect(createClient(once(jsonResponse(200, document))).probe()).rejects.toMatchObject(
      {
        code: 'protocol_error',
      },
    )
  })

  it.each([undefined, null, 1, '', '   ', 'v'.repeat(129), '1.0\nprivate', '1.0\u2028private'])(
    'rejects an absent or invalid API version: %j',
    async (version) => {
      const document = {
        info: { version },
        paths: {
          '/api/control/feed': {
            post: { parameters: [queryParameter('camera_id', 'string')] },
          },
        },
      }
      await expect(
        createClient(once(jsonResponse(200, document))).probe(),
      ).rejects.toMatchObject({
        code: 'protocol_error',
      })
    },
  )

  it.each([
    undefined,
    {},
    [null],
    [{ in: 'query', name: 'camera_id' }],
    [{ in: 'query', name: 'camera_id', schema: null }],
  ])('rejects malformed query metadata: %j', async (parameters) => {
    const document = {
      info: { version: '1.0' },
      paths: { '/api/control/feed': { post: { parameters } } },
    }
    await expect(createClient(once(jsonResponse(200, document))).probe()).rejects.toMatchObject(
      {
        code: 'protocol_error',
      },
    )
  })

  it('accepts optional query parameters when required is omitted', async () => {
    const document = {
      info: { version: '1.0' },
      paths: {
        '/api/control/feed': {
          post: {
            parameters: [
              { in: 'query', name: 'camera_id', schema: { type: 'string' } },
              { in: 'query', name: 'feed_number', schema: { type: 'integer' } },
            ],
          },
        },
      },
    }
    await expect(createClient(once(jsonResponse(200, document))).probe()).resolves.toEqual({
      apiVersion: '1.0',
      supportsFeedId: false,
      supportsFeedNumber: true,
    })
  })

  it.each([200, 404])('handles HTTP %s with a missing body', async (status) => {
    const fetchStudio = once({ status, headers: { get: () => null }, body: null })
    await expect(createClient(fetchStudio).selectFeedByNumber(1)).rejects.toMatchObject({
      code: status === 404 ? 'feed_not_found' : 'protocol_error',
    })
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it.each(['0', String(Number.MAX_SAFE_INTEGER + 1)])(
    'rejects an unusable Content-Length of %s and cancels the body',
    async (declaredLength) => {
      const cancel = vi.fn(() => Promise.resolve())
      const fetchStudio = once(
        byteResponse(200, new Uint8Array([1]), { declaredLength, cancel }),
      )
      await expect(createClient(fetchStudio).selectFeedByNumber(1)).rejects.toMatchObject({
        code: 'protocol_error',
      })
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each([
    ['missing chunk', [{ done: false }]],
    ['empty chunk', [{ done: false, value: new Uint8Array() }]],
    ['empty stream', [{ done: true }]],
    [
      'oversized stream',
      [{ done: false, value: new Uint8Array(CYANVIEW_STUDIO_RESPONSE_MAX_BYTES + 1) }],
    ],
  ] as const)('rejects a %s without relying on Content-Length', async (_label, chunks) => {
    const pending = [...chunks]
    const reader = {
      read: vi.fn(() => Promise.resolve(pending.shift() ?? { done: true })),
      cancel: vi.fn(() => Promise.reject(new Error('connection closed'))),
      releaseLock: vi.fn(),
    }
    const fetchStudio = once({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => reader },
    })
    await expect(createClient(fetchStudio).selectFeedByNumber(1)).rejects.toMatchObject({
      code: 'protocol_error',
    })
    expect(reader.releaseLock).toHaveBeenCalledOnce()
    expect(reader.cancel).toHaveBeenCalledTimes(chunks[0].done ? 0 : 1)
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it('releases a failed stream and reports a bounded protocol error without retrying', async () => {
    const reader = {
      read: vi.fn(() => Promise.reject(new Error('private socket detail'))),
      cancel: vi.fn(() => Promise.resolve()),
      releaseLock: vi.fn(),
    }
    const fetchStudio = once({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => reader },
    })
    const error = await createClient(fetchStudio)
      .selectFeedByNumber(1)
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'protocol_error' })
    expect(String(error)).not.toContain('private socket detail')
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
    expect(fetchStudio).toHaveBeenCalledOnce()
  })

  it.each(['::1', '[::1]'])(
    'accepts the IPv6 host %s with the configured port',
    async (host) => {
      const fetchStudio = once(jsonResponse(200, { status: 'ok' }))
      const client = new CyanViewStudioHttpClient({
        host,
        port: 4173,
        requestTimeoutMs: 1_500,
        fetch: fetchStudio,
      })
      await expect(client.selectFeedByNumber(1)).resolves.toBeUndefined()
      expect(fetchStudio).toHaveBeenCalledWith(
        'http://[::1]:4173/api/control/feed?feed_number=1',
        expect.objectContaining({ method: 'POST' }),
      )
    },
  )

  it.each([
    { host: 'invalid host', port: 4173, requestTimeoutMs: 1_500 },
    { host: 'user@studio.local', port: 4173, requestTimeoutMs: 1_500 },
    { host: 'studio.local/path', port: 4173, requestTimeoutMs: 1_500 },
    { host: 'studio.local?query', port: 4173, requestTimeoutMs: 1_500 },
    { host: 'studio.local#fragment', port: 4173, requestTimeoutMs: 1_500 },
    { host: 'studio.local', port: 0, requestTimeoutMs: 1_500 },
    { host: 'studio.local', port: 65_536, requestTimeoutMs: 1_500 },
    { host: 'studio.local', port: 1.5, requestTimeoutMs: 1_500 },
    { host: 'studio.local', port: 4173, requestTimeoutMs: 0 },
    { host: 'studio.local', port: 4173, requestTimeoutMs: 1.5 },
  ])('rejects an invalid endpoint or timeout before making a request: %j', (options) => {
    const fetchStudio = vi.fn<CyanViewStudioFetch>()
    expect(() => new CyanViewStudioHttpClient({ ...options, fetch: fetchStudio })).toThrow(
      CyanViewStudioHttpClientError,
    )
    expect(fetchStudio).not.toHaveBeenCalled()
  })
})

function createClient(fetchStudio: CyanViewStudioFetch): CyanViewStudioHttpClient {
  return new CyanViewStudioHttpClient({
    host: '127.0.0.1',
    port: 4173,
    requestTimeoutMs: 1_500,
    fetch: fetchStudio,
    scheduleTimeout: () => Object.freeze({}),
    clearTimeout: () => undefined,
  })
}

function once(response: CyanViewStudioResponseLike): CyanViewStudioFetch {
  return vi.fn<CyanViewStudioFetch>().mockResolvedValue(response)
}

function jsonResponse(status: number, value: unknown) {
  return byteResponse(status, new TextEncoder().encode(JSON.stringify(value)))
}

function queryParameter(name: string, type: 'integer' | 'string') {
  return { in: 'query', name, required: false, schema: { type } }
}

function byteResponse(
  status: number,
  bytes: Uint8Array,
  options: Readonly<{
    declaredLength?: number | string
    cancel?: () => Promise<void>
  }> = {},
) {
  let offset = 0
  let completed = false
  return Object.freeze({
    status,
    headers: Object.freeze({
      get: (name: string) =>
        name.toLocaleLowerCase('en-US') === 'content-length'
          ? String(options.declaredLength ?? bytes.byteLength)
          : null,
    }),
    body: Object.freeze({
      getReader: () =>
        Object.freeze({
          read: () => {
            if (completed) return Promise.resolve({ done: true })
            completed = true
            const value = bytes.subarray(offset)
            offset = bytes.byteLength
            return Promise.resolve({ done: false, value })
          },
          cancel: () => {
            completed = true
            return options.cancel?.() ?? Promise.resolve()
          },
          releaseLock: () => undefined,
        }),
    }),
  })
}
