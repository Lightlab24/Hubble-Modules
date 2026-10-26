import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent'
import { describe, expect, it, vi } from 'vitest'

import {
  HTTP_REQUESTS_BODY_MAX_BYTES,
  HTTP_REQUESTS_GLOBAL_CAPACITY,
  HTTP_REQUESTS_HEADER_MAX_BYTES,
  HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES,
  HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
  HttpRequestsClient,
  type HttpRequestsInput,
  type HttpRequestsRequestRunner,
  type HttpRequestsTransportResponse,
} from '../src/http-requests-client.js'

describe('HttpRequestsClient', () => {
  it('retains fixed runtime, per-origin, header, and payload bounds', () => {
    expect(HTTP_REQUESTS_GLOBAL_CAPACITY).toBe(32)
    expect(HTTP_REQUESTS_PER_ORIGIN_CAPACITY).toBe(4)
    expect(HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES).toBe(16 * 1_024)
    expect(HTTP_REQUESTS_BODY_MAX_BYTES).toBe(262_144)
    expect(HTTP_REQUESTS_HEADER_MAX_BYTES).toBe(65_536)
  })

  it.each([
    ['GET', undefined, undefined],
    ['POST', '{}', 'application/json'],
    ['PUT', '{}', 'application/json'],
    ['PATCH', '{}', 'application/json'],
    ['DELETE', '{}', undefined],
  ] as const)(
    'dispatches %s through the shared Got request path',
    async (method, body, contenttype) => {
      const requestRunner = successfulRunner()
      const client = new HttpRequestsClient({ requestRunner })

      await client.request(
        input(method, {
          ...(body === undefined ? {} : { body }),
          ...(contenttype === undefined ? {} : { contenttype }),
        }),
      )

      expect(requestRunner).toHaveBeenCalledOnce()
      expect(requestRunner.mock.calls[0]?.[1]).toMatchObject({
        method,
        maxHeaderSize: HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES,
        responseType: 'text',
        resolveBodyOnly: false,
        throwHttpErrors: false,
        https: { rejectUnauthorized: true },
      })
    },
  )

  it('parses JSON body and lets the selected content type override custom casing', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('POST', {
        body: '{"take":true,"slot":3}',
        contenttype: 'application/json',
        header: '{"content-type":"private/wrong","X-Control":"yes"}',
      }),
    )

    const options = requestRunner.mock.calls[0]?.[1]
    expect(options?.json).toEqual({ take: true, slot: 3 })
    expect(options?.body).toBeUndefined()
    expect(options?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Control': 'yes',
    })
  })

  it('sends a parsed JSON string as an unquoted raw body like upstream', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('POST', { body: '"take\\\\nnext"', contenttype: 'application/json' }),
    )

    expect(requestRunner.mock.calls[0]?.[1]).toMatchObject({
      body: 'take\nnext',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(requestRunner.mock.calls[0]?.[1].json).toBeUndefined()
  })

  it('sends no body when the parsed JSON value is null', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(input('POST', { body: 'null', contenttype: 'application/json' }))

    expect(requestRunner.mock.calls[0]?.[1].body).toBeUndefined()
    expect(requestRunner.mock.calls[0]?.[1].json).toBeUndefined()
  })

  it.each([
    { label: 'number', body: '42', expected: 42 },
    { label: 'boolean', body: 'true', expected: true },
    { label: 'object', body: '{"take":true}', expected: { take: true } },
    { label: 'array', body: '[1,2]', expected: [1, 2] },
  ])('supplies a parsed JSON $label through Got json', async ({ body, expected }) => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(input('POST', { body, contenttype: 'application/json' }))

    expect(requestRunner.mock.calls[0]?.[1].json).toEqual(expected)
    expect(requestRunner.mock.calls[0]?.[1].body).toBeUndefined()
  })

  it('uses an empty JSON body as upstream default object data', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    for (const body of ['', '   ']) {
      await client.request(input('POST', { body, contenttype: 'application/json' }))
    }

    expect(requestRunner.mock.calls.map((call) => call[1].json)).toEqual([{}, {}])
  })

  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'stringifies the upstream default object for an empty non-JSON %s body',
    async (method) => {
      const requestRunner = successfulRunner()
      const client = new HttpRequestsClient({ requestRunner })

      for (const body of ['', '   ']) {
        await client.request(input(method, { body, contenttype: 'text/plain' }))
      }

      expect(requestRunner.mock.calls.map((call) => call[1].body)).toEqual([
        '[object Object]',
        '[object Object]',
      ])
    },
  )

  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'converts literal newline escapes for non-JSON %s bodies',
    async (method) => {
      const requestRunner = successfulRunner()
      const client = new HttpRequestsClient({ requestRunner })

      await client.request(
        input(method, { body: 'start\\nnext\\nend', contenttype: 'text/plain' }),
      )

      expect(requestRunner.mock.calls[0]?.[1]).toMatchObject({
        body: 'start\nnext\nend',
        headers: { 'Content-Type': 'text/plain' },
      })
    },
  )

  it('sends DELETE body without injecting a content type', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(input('DELETE', { body: 'one\\ntwo', header: '{"X-Delete":"yes"}' }))

    expect(requestRunner.mock.calls[0]?.[1]).toMatchObject({
      body: 'one\ntwo',
      headers: { 'X-Delete': 'yes' },
    })
    expect(requestRunner.mock.calls[0]?.[1].headers).not.toHaveProperty('Content-Type')
  })

  it('stringifies the upstream default object for an empty DELETE body', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    for (const body of ['', '   ']) await client.request(input('DELETE', { body }))

    expect(requestRunner.mock.calls.map((call) => call[1].body)).toEqual([
      '[object Object]',
      '[object Object]',
    ])
  })

  it.each([
    {
      label: 'malformed JSON body',
      change: { body: '{', contenttype: 'application/json' as const },
    },
    { label: 'malformed header', change: { header: '{' } },
    { label: 'array header', change: { header: '[]' } },
    { label: 'null header', change: { header: 'null' } },
    { label: 'scalar header', change: { header: 'true' } },
  ])('rejects $label before transport without exposing its value', async ({ change }) => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await expect(client.request(input('POST', change))).rejects.toMatchObject({
      code: 'generic_http_invalid_target',
      message: 'HTTP request target is invalid',
    })
    expect(requestRunner).not.toHaveBeenCalled()
  })

  it('enforces evaluated body and header UTF-8 byte limits', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await expect(
      client.request(
        input('DELETE', {
          body: 'é'.repeat(HTTP_REQUESTS_BODY_MAX_BYTES / 2 + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'generic_http_invalid_target' })
    await expect(
      client.request(
        input('GET', {
          header: `{"X":"${'é'.repeat(HTTP_REQUESTS_HEADER_MAX_BYTES / 2)}"}`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'generic_http_invalid_target' })
    expect(requestRunner).not.toHaveBeenCalled()
  })

  it('composes a trimmed relative value by literal Base URL concatenation', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('GET', {
        baseUrl: 'http://device.internal/api?macro=',
        requestTarget: '  Record%20A  ',
      }),
    )

    expect(requestRunner.mock.calls[0]?.[0]).toBe('http://device.internal/api?macro=Record%20A')
  })

  it('sends the configured Base URL itself when the request target is blank', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(input('GET', { baseUrl: 'http://device.internal', requestTarget: '' }))

    expect(requestRunner.mock.calls[0]?.[0]).toBe('http://device.internal')
  })

  it('does not normalize or encode the literally composed request string', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('GET', {
        baseUrl: 'http://device.internal/api/',
        requestTarget: '  ../take value  ',
      }),
    )

    expect(requestRunner.mock.calls[0]?.[0]).toBe('http://device.internal/api/../take value')
  })

  it('lets an absolute HTTP URL override a different configured Base URL', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('GET', {
        baseUrl: 'http://ignored.internal/api/',
        requestTarget: 'https://selected.example:8443/take?slot=3',
      }),
    )

    expect(requestRunner.mock.calls[0]?.[0]).toBe('https://selected.example:8443/take?slot=3')
  })

  it('rejects blank-Base relative input before transport', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await expect(
      client.request(input('GET', { baseUrl: '', requestTarget: '/relative' })),
    ).rejects.toMatchObject({ code: 'generic_http_invalid_target' })
    expect(requestRunner).not.toHaveBeenCalled()
  })

  it('constructs both upstream proxy agents and preserves proxy credentials inside them', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(
      input('GET', { proxyAddress: 'http://operator:private@proxy.internal:8080' }),
    )

    const agent = requestRunner.mock.calls[0]?.[1].agent
    expect(agent?.http).toBeInstanceOf(HttpProxyAgent)
    expect(agent?.https).toBeInstanceOf(HttpsProxyAgent)
    expect((Reflect.get(agent?.http as object, 'proxy') as URL).href).toBe(
      'http://operator:private@proxy.internal:8080/',
    )
    expect((Reflect.get(agent?.https as object, 'proxy') as URL).href).toBe(
      'http://operator:private@proxy.internal:8080/',
    )
  })

  it('rejects invalid proxy configuration before transport', async () => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await expect(
      client.request(input('GET', { proxyAddress: 'socks://proxy.internal:1080' })),
    ).rejects.toMatchObject({ code: 'generic_http_invalid_target' })
    expect(requestRunner).not.toHaveBeenCalled()
  })

  it.each([true, false])('passes rejectUnauthorized=%s to Got', async (rejectUnauthorized) => {
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner })

    await client.request(input('GET', { rejectUnauthorized }))

    expect(requestRunner.mock.calls[0]?.[1].https).toEqual({ rejectUnauthorized })
  })

  it('injects the native insecure parser only when explicitly enabled', async () => {
    const strictRunner = successfulRunner()
    const insecureRunner = successfulRunner()
    const strictClient = new HttpRequestsClient({ requestRunner: strictRunner })
    const insecureClient = new HttpRequestsClient({ requestRunner: insecureRunner })

    await strictClient.request(input('GET'))
    await insecureClient.request(input('GET', { insecureHTTPParser: true }))

    expect(strictRunner.mock.calls[0]?.[1].request).toBeUndefined()
    expect(insecureRunner.mock.calls[0]?.[1].request).toBeTypeOf('function')
  })

  it.each(['GET', 'POST', 'PUT', 'PATCH'] as const)(
    'maps a final non-ok %s response to a rejected action result',
    async (method) => {
      const client = new HttpRequestsClient({ requestRunner: responseRunner(500, false) })

      await expect(
        client.request(
          input(method, {
            ...(method === 'GET'
              ? {}
              : { body: '{}', contenttype: 'application/json' as const }),
          }),
        ),
      ).rejects.toMatchObject({
        code: 'generic_http_rejected',
        message: 'HTTP request endpoint rejected the request',
      })
    },
  )

  it('treats every received DELETE status as success', async () => {
    const client = new HttpRequestsClient({ requestRunner: responseRunner(503, false) })

    await expect(client.request(input('DELETE', { body: '{}' }))).resolves.toBeUndefined()
  })

  it.each([
    ['ERR_INVALID_CHAR', 'generic_http_invalid_target', 'HTTP request target is invalid'],
    ['ERR_INVALID_HTTP_TOKEN', 'generic_http_invalid_target', 'HTTP request target is invalid'],
    ['ENOTFOUND', 'generic_http_dns_failed', 'HTTP request target could not be resolved'],
    [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'generic_http_tls_failed',
      'HTTP request could not establish a trusted TLS connection',
    ],
    [
      'ERR_TOO_MANY_REDIRECTS',
      'generic_http_redirect_blocked',
      'HTTP request exceeded the allowed redirect chain',
    ],
    [
      'HPE_INVALID_HEADER_TOKEN',
      'generic_http_protocol_error',
      'HTTP request endpoint returned an invalid response',
    ],
    ['ECONNREFUSED', 'generic_http_unavailable', 'HTTP request endpoint is unavailable'],
  ] as const)('redacts transport error %s as %s', async (transportCode, code, message) => {
    const privateText = 'https://operator:secret@private.example/token=secret'
    const requestRunner = vi.fn<HttpRequestsRequestRunner>(() =>
      Promise.reject(Object.assign(new Error(privateText), { code: transportCode })),
    )
    const client = new HttpRequestsClient({ requestRunner })

    const result = client.request(
      input('GET', { requestTarget: 'http://device.internal/private?token=secret' }),
    )
    await expect(result).rejects.toMatchObject({ code, message })
    await expect(result).rejects.not.toThrow(privateText)
  })

  it('uses one absolute deadline and aborts the whole request chain', async () => {
    let expire = (): void => undefined
    const clearTimeout = vi.fn()
    const requestRunner = abortAwareRunner()
    const client = new HttpRequestsClient({
      requestRunner,
      scheduleTimeout(callback) {
        expire = callback
        return Object.freeze({})
      },
      clearTimeout,
    })

    const pending = client.request(input('GET'))
    await vi.waitFor(() => {
      expect(requestRunner).toHaveBeenCalledOnce()
    })
    expire()

    await expect(pending).rejects.toMatchObject({ code: 'generic_http_timeout' })
    expect(requestRunner.mock.calls[0]?.[1].signal?.aborted).toBe(true)
    expect(clearTimeout).toHaveBeenCalledOnce()
  })

  it('maps an external abort to cancellation and clears its deadline', async () => {
    const controller = new AbortController()
    const clearTimeout = vi.fn()
    const requestRunner = abortAwareRunner()
    const client = new HttpRequestsClient({ requestRunner, clearTimeout })

    const pending = client.request(input('GET', { signal: controller.signal }))
    await vi.waitFor(() => {
      expect(requestRunner).toHaveBeenCalledOnce()
    })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(clearTimeout).toHaveBeenCalledOnce()
  })

  it('fails closed at both global and per-origin capacity bounds', async () => {
    const controlled = controlledRunner()
    const client = new HttpRequestsClient({
      requestRunner: controlled.runner,
      globalCapacity: 2,
      perOriginCapacity: 1,
    })

    const first = client.request(input('GET', { requestTarget: 'http://one.internal/a' }))
    await vi.waitFor(() => {
      expect(controlled.runner).toHaveBeenCalledOnce()
    })
    await expect(
      client.request(input('GET', { requestTarget: 'http://one.internal/b' })),
    ).rejects.toMatchObject({ code: 'generic_http_capacity_exceeded' })

    const second = client.request(input('GET', { requestTarget: 'http://two.internal/a' }))
    await vi.waitFor(() => {
      expect(controlled.runner).toHaveBeenCalledTimes(2)
    })
    await expect(
      client.request(input('GET', { requestTarget: 'http://three.internal/a' })),
    ).rejects.toMatchObject({ code: 'generic_http_capacity_exceeded' })

    controlled.resolveAll()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('holds capacity until the underlying Got operation settles after abort', async () => {
    const controlled = controlledRunner()
    const controller = new AbortController()
    const client = new HttpRequestsClient({
      requestRunner: controlled.runner,
      globalCapacity: 1,
      perOriginCapacity: 1,
    })

    const first = client.request(input('GET', { signal: controller.signal }))
    await vi.waitFor(() => {
      expect(controlled.runner).toHaveBeenCalledOnce()
    })
    controller.abort()
    await expect(
      client.request(input('GET', { requestTarget: 'http://other.internal/a' })),
    ).rejects.toMatchObject({ code: 'generic_http_capacity_exceeded' })

    controlled.resolveAll()
    await expect(first).rejects.toMatchObject({ code: 'aborted' })
    const next = client.request(input('GET', { requestTarget: 'http://other.internal/a' }))
    await vi.waitFor(() => {
      expect(controlled.runner).toHaveBeenCalledTimes(2)
    })
    controlled.resolveAll()
    await expect(next).resolves.toBeUndefined()
  })

  it('stops idempotently, aborts active work, and rejects future requests', async () => {
    const requestRunner = abortAwareRunner()
    const client = new HttpRequestsClient({ requestRunner })
    const pending = client.request(input('GET'))
    await vi.waitFor(() => {
      expect(requestRunner).toHaveBeenCalledOnce()
    })

    client.stop()
    client.stop()

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await expect(client.request(input('GET'))).rejects.toMatchObject({
      code: 'generic_http_unavailable',
    })
    expect(requestRunner).toHaveBeenCalledOnce()
  })

  it('rejects already-aborted work before consuming capacity or transport', async () => {
    const controller = new AbortController()
    controller.abort()
    const requestRunner = successfulRunner()
    const client = new HttpRequestsClient({ requestRunner, globalCapacity: 1 })

    await expect(
      client.request(input('GET', { signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'aborted' })
    await expect(client.request(input('GET'))).resolves.toBeUndefined()
    expect(requestRunner).toHaveBeenCalledOnce()
  })
})

function input(
  method: HttpRequestsInput['method'],
  changes: Partial<HttpRequestsInput> = {},
): HttpRequestsInput {
  return {
    method,
    baseUrl: '',
    proxyAddress: '',
    rejectUnauthorized: true,
    insecureHTTPParser: false,
    requestTimeoutMs: 5_000,
    requestTarget: 'http://device.internal/api/take?token=private',
    header: '',
    signal: new AbortController().signal,
    ...changes,
  }
}

function successfulRunner() {
  return responseRunner(204, true)
}

function responseRunner(statusCode: number, ok: boolean) {
  return vi.fn<HttpRequestsRequestRunner>(() => Promise.resolve({ ok, statusCode }))
}

function abortAwareRunner() {
  return vi.fn<HttpRequestsRequestRunner>(
    (_url, options) =>
      new Promise<HttpRequestsTransportResponse>((_resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) {
          reject(Object.assign(new Error('private abort reason'), { code: 'ERR_ABORTED' }))
          return
        }
        signal?.addEventListener(
          'abort',
          () => {
            reject(Object.assign(new Error('private abort reason'), { code: 'ERR_ABORTED' }))
          },
          { once: true },
        )
      }),
  )
}

function controlledRunner() {
  const pending: Array<(response: HttpRequestsTransportResponse) => void> = []
  const runner = vi.fn<HttpRequestsRequestRunner>(
    () =>
      new Promise<HttpRequestsTransportResponse>((resolve) => {
        pending.push(resolve)
      }),
  )
  return {
    runner,
    resolveAll() {
      for (const resolve of pending.splice(0)) resolve({ ok: true, statusCode: 204 })
    },
  }
}
