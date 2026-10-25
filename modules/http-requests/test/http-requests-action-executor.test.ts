import { describe, expect, it, vi } from 'vitest'
import {
  ButtonIdentifierSchema,
  ConnectionDefinitionsSchema,
  GenericHttpDeleteActionDefinitionSchema,
  GenericHttpGetActionDefinitionSchema,
  GenericHttpPatchActionDefinitionSchema,
  GenericHttpPostActionDefinitionSchema,
  GenericHttpPutActionDefinitionSchema,
} from '../src/config.js'

import { ActionAbortedError } from '@hubble/module-contracts/execution'
import { HttpRequestsActionExecutor } from '../src/http-requests-action-executor.js'
import {
  HttpRequestsClientError,
  type HttpRequestsClientContract,
} from '../src/http-requests-client.js'

describe('HttpRequestsActionExecutor', () => {
  it.each([
    [GET_ACTION, { method: 'GET' }],
    [POST_ACTION, { method: 'POST', body: '{"take":true}', contenttype: 'application/json' }],
    [PUT_ACTION, { method: 'PUT', body: 'slot=3', contenttype: 'text/plain' }],
    [PATCH_ACTION, { method: 'PATCH', body: '<take/>', contenttype: 'application/xml' }],
    [DELETE_ACTION, { method: 'DELETE', body: '{"slot":3}' }],
  ] as const)('maps $type through the shared request input', async (action, methodFields) => {
    const request = vi.fn<HttpRequestsClientContract['request']>(() => Promise.resolve())
    const executor = new HttpRequestsActionExecutor(CONNECTIONS, { request })
    const context = executionContext()

    await expect(executor.execute(action, context)).resolves.toEqual({ outcome: 'success' })
    expect(request).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:8080/api',
      proxyAddress: 'http://operator:private@127.0.0.1:8888',
      rejectUnauthorized: false,
      insecureHTTPParser: true,
      requestTimeoutMs: 5_000,
      requestTarget: action.requestTarget,
      header: action.header,
      signal: context.signal,
      ...methodFields,
    })
  })

  it.each(['loopback', 'private-lan', 'public'] as const)(
    'ignores persisted %s targetScope during dispatch',
    async (targetScope) => {
      const request = vi.fn<HttpRequestsClientContract['request']>(() => Promise.resolve())
      const connections = ConnectionDefinitionsSchema.parse([
        { ...CONNECTIONS[0], baseUrl: '', targetScope },
      ])
      const executor = new HttpRequestsActionExecutor(connections, { request })
      const context = executionContext()
      const action = GenericHttpGetActionDefinitionSchema.parse({
        ...GET_ACTION,
        requestTarget: 'http://127.0.0.1:8080/api/start',
      })

      await expect(executor.execute(action, context)).resolves.toEqual({ outcome: 'success' })
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: '',
          method: 'GET',
          requestTarget: 'http://127.0.0.1:8080/api/start',
        }),
      )
      expect(request.mock.calls[0]?.[0]).not.toHaveProperty('targetScope')
    },
  )

  it.each([
    { label: 'missing', connections: ConnectionDefinitionsSchema.parse([]) },
    {
      label: 'disabled',
      connections: ConnectionDefinitionsSchema.parse(
        CONNECTIONS.map((connection) => ({ ...connection, enabled: false })),
      ),
    },
  ])(
    'returns a bounded unconfigured failure for a $label connection',
    async ({ connections }) => {
      const request = vi.fn<HttpRequestsClientContract['request']>(() => Promise.resolve())
      const executor = new HttpRequestsActionExecutor(connections, { request })

      await expect(executor.execute(GET_ACTION, executionContext())).resolves.toEqual({
        outcome: 'failure',
        errorCode: 'generic_http_unconfigured',
        errorMessage: 'HTTP Requests connection is unavailable',
      })
      expect(request).not.toHaveBeenCalled()
    },
  )

  it('captures an immutable connection snapshot at construction', async () => {
    const mutable = structuredClone(CONNECTIONS)
    const request = vi.fn<HttpRequestsClientContract['request']>(() => Promise.resolve())
    const executor = new HttpRequestsActionExecutor(mutable, { request })
    const connection = mutable[0]
    if (connection?.type !== 'generic-http') throw new Error('invalid test fixture')
    Reflect.set(connection, 'baseUrl', 'http://127.0.0.1:9999/leaked')
    Reflect.set(connection, 'proxyAddress', 'http://leaked:secret@127.0.0.1:9998')
    Reflect.set(connection, 'rejectUnauthorized', true)
    Reflect.set(connection, 'insecureHTTPParser', false)

    await executor.execute(GET_ACTION, executionContext())

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:8080/api',
        proxyAddress: 'http://operator:private@127.0.0.1:8888',
        rejectUnauthorized: false,
        insecureHTTPParser: true,
      }),
    )
  })

  it.each([
    ['generic_http_invalid_target', 'HTTP request target is invalid'],
    [
      'generic_http_target_blocked',
      "HTTP request target is not permitted by Hubble's network safety policy",
    ],
    ['generic_http_dns_failed', 'HTTP request target could not be resolved'],
    ['generic_http_timeout', 'HTTP request did not respond before the request timeout'],
    ['generic_http_tls_failed', 'HTTP request could not establish a trusted TLS connection'],
    ['generic_http_redirect_blocked', 'HTTP request exceeded the allowed redirect chain'],
    ['generic_http_rejected', 'HTTP request endpoint rejected the request'],
    ['generic_http_capacity_exceeded', 'HTTP request capacity has been reached'],
    ['generic_http_unavailable', 'HTTP request endpoint is unavailable'],
    ['generic_http_protocol_error', 'HTTP request endpoint returned an invalid response'],
  ] as const)('maps %s to an operator-safe failure', async (code, errorMessage) => {
    const client: Pick<HttpRequestsClientContract, 'request'> = {
      request: () => Promise.reject(new HttpRequestsClientError(code)),
    }
    const executor = new HttpRequestsActionExecutor(CONNECTIONS, client)

    await expect(executor.execute(GET_ACTION, executionContext())).resolves.toEqual({
      outcome: 'failure',
      errorCode: code,
      errorMessage,
    })
  })

  it('does not leak target, proxy, header, body, or raw error details', async () => {
    const privateText = JSON.stringify({
      target: GET_ACTION.requestTarget,
      proxy: CONNECTIONS[0]?.type === 'generic-http' ? CONNECTIONS[0].proxyAddress : '',
      header: POST_ACTION.header,
      body: POST_ACTION.body,
    })
    const executor = new HttpRequestsActionExecutor(CONNECTIONS, {
      request: () => Promise.reject(new Error(privateText)),
    })

    const result = await executor.execute(POST_ACTION, executionContext())

    expect(result).toEqual({
      outcome: 'failure',
      errorCode: 'generic_http_protocol_error',
      errorMessage: 'HTTP request failed unexpectedly',
    })
    expect(JSON.stringify(result)).not.toContain('token=private')
    expect(JSON.stringify(result)).not.toContain('operator:private')
    expect(JSON.stringify(result)).not.toContain('Authorization')
    expect(JSON.stringify(result)).not.toContain('take')
  })

  it('rejects with ActionAbortedError when already aborted', async () => {
    const request = vi.fn<HttpRequestsClientContract['request']>(() => Promise.resolve())
    const executor = new HttpRequestsActionExecutor(CONNECTIONS, { request })
    const controller = new AbortController()
    controller.abort()

    await expect(
      executor.execute(GET_ACTION, executionContext(controller.signal)),
    ).rejects.toBeInstanceOf(ActionAbortedError)
    expect(request).not.toHaveBeenCalled()
  })

  it('propagates client cancellation as ActionAbortedError', async () => {
    const executor = new HttpRequestsActionExecutor(CONNECTIONS, {
      request: () => Promise.reject(new HttpRequestsClientError('aborted')),
    })

    await expect(executor.execute(GET_ACTION, executionContext())).rejects.toBeInstanceOf(
      ActionAbortedError,
    )
  })
})

const CONNECTIONS = ConnectionDefinitionsSchema.parse([
  {
    connectionId: '11111111-1111-4111-8111-111111111111',
    type: 'generic-http',
    name: 'HTTP Requests',
    enabled: true,
    baseUrl: 'http://127.0.0.1:8080/api',
    targetScope: 'loopback',
    proxyAddress: 'http://operator:private@127.0.0.1:8888',
    rejectUnauthorized: false,
    insecureHTTPParser: true,
    requestTimeoutMs: 5_000,
    schemaVersion: 1,
  },
])

const IDENTITY = {
  actionColumnId: '22222222-2222-4222-8222-222222222222',
  interaction: 'press',
  connectionId: '11111111-1111-4111-8111-111111111111',
  enabled: true,
} as const

const GET_ACTION = GenericHttpGetActionDefinitionSchema.parse({
  ...IDENTITY,
  actionId: 'http-get',
  type: 'generic-http.get',
  requestTarget: '/get?token=private',
  header: '{"Authorization":"Bearer private"}',
})

const POST_ACTION = GenericHttpPostActionDefinitionSchema.parse({
  ...IDENTITY,
  actionId: 'http-post',
  type: 'generic-http.post',
  requestTarget: '/post?token=private',
  body: '{"take":true}',
  header: '{"Authorization":"Bearer private"}',
  contenttype: 'application/json',
})

const PUT_ACTION = GenericHttpPutActionDefinitionSchema.parse({
  ...IDENTITY,
  actionId: 'http-put',
  type: 'generic-http.put',
  requestTarget: '/put',
  body: 'slot=3',
  header: '',
  contenttype: 'text/plain',
})

const PATCH_ACTION = GenericHttpPatchActionDefinitionSchema.parse({
  ...IDENTITY,
  actionId: 'http-patch',
  type: 'generic-http.patch',
  requestTarget: '/patch',
  body: '<take/>',
  header: '',
  contenttype: 'application/xml',
})

const DELETE_ACTION = GenericHttpDeleteActionDefinitionSchema.parse({
  ...IDENTITY,
  actionId: 'http-delete',
  type: 'generic-http.delete',
  requestTarget: '/delete',
  body: '{"slot":3}',
  header: '',
})

function executionContext(signal = new AbortController().signal) {
  return {
    executionId: '33333333-3333-4333-8333-333333333333',
    buttonNumber: ButtonIdentifierSchema.parse('1'),
    interaction: 'press' as const,
    wrap: true,
    signal,
  }
}
