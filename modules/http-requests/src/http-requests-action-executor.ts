import { connectionCandidates } from '@hubble/module-contracts/settings'
import type { GenericHttpActionDefinition, GenericHttpConnectionDefinition } from './config.js'
import { ConnectionDefinitionsSchema } from './config.js'

import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  HttpRequestsClientError,
  type HttpRequestsClientContract,
  type HttpRequestsClientErrorCode,
  type HttpRequestsInput,
} from './http-requests-client.js'

type StableHttpRequestsFailureCode = Exclude<HttpRequestsClientErrorCode, 'aborted'>

const SAFE_FAILURE_MESSAGES = Object.freeze({
  generic_http_invalid_target: 'HTTP request target is invalid',
  generic_http_target_blocked:
    "HTTP request target is not permitted by Hubble's network safety policy",
  generic_http_dns_failed: 'HTTP request target could not be resolved',
  generic_http_timeout: 'HTTP request did not respond before the request timeout',
  generic_http_tls_failed: 'HTTP request could not establish a trusted TLS connection',
  generic_http_redirect_blocked: 'HTTP request exceeded the allowed redirect chain',
  generic_http_rejected: 'HTTP request endpoint rejected the request',
  generic_http_capacity_exceeded: 'HTTP request capacity has been reached',
  generic_http_unavailable: 'HTTP request endpoint is unavailable',
  generic_http_protocol_error: 'HTTP request endpoint returned an invalid response',
} satisfies Readonly<Record<StableHttpRequestsFailureCode, string>>)

export class HttpRequestsActionExecutor implements TypedActionExecutor<GenericHttpActionDefinition> {
  readonly #connections: ReadonlyMap<string, GenericHttpConnectionDefinition>

  constructor(
    values: readonly unknown[],
    private readonly client: Pick<HttpRequestsClientContract, 'request'>,
  ) {
    const connections = ConnectionDefinitionsSchema.parse(
      connectionCandidates(values, 'generic-http'),
    )
    const enabledConnections = new Map<string, GenericHttpConnectionDefinition>()
    for (const connection of connections) {
      if (connection.type !== 'generic-http' || !connection.enabled) continue
      enabledConnections.set(
        connection.connectionId,
        Object.freeze(structuredClone(connection)),
      )
    }
    this.#connections = enabledConnections
  }

  async execute(
    action: GenericHttpActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) throw new ActionAbortedError()

    const connection = this.#connections.get(action.connectionId)
    if (connection === undefined) {
      return failure('generic_http_unconfigured', 'HTTP Requests connection is unavailable')
    }

    try {
      await this.client.request(requestInput(action, connection, context.signal))
      return { outcome: 'success' }
    } catch (error: unknown) {
      if (error instanceof HttpRequestsClientError) {
        if (error.code === 'aborted') throw new ActionAbortedError()
        return failure(error.code, SAFE_FAILURE_MESSAGES[error.code])
      }
      return failure('generic_http_protocol_error', 'HTTP request failed unexpectedly')
    }
  }
}

function requestInput(
  action: GenericHttpActionDefinition,
  connection: GenericHttpConnectionDefinition,
  signal: AbortSignal,
): HttpRequestsInput {
  const common = {
    baseUrl: connection.baseUrl,
    proxyAddress: connection.proxyAddress,
    rejectUnauthorized: connection.rejectUnauthorized,
    insecureHTTPParser: connection.insecureHTTPParser,
    requestTimeoutMs: connection.requestTimeoutMs,
    requestTarget: action.requestTarget,
    header: action.header,
    signal,
  } as const

  switch (action.type) {
    case 'generic-http.get':
      return { ...common, method: 'GET' }
    case 'generic-http.post':
      return {
        ...common,
        method: 'POST',
        body: action.body,
        contenttype: action.contenttype,
      }
    case 'generic-http.put':
      return {
        ...common,
        method: 'PUT',
        body: action.body,
        contenttype: action.contenttype,
      }
    case 'generic-http.patch':
      return {
        ...common,
        method: 'PATCH',
        body: action.body,
        contenttype: action.contenttype,
      }
    case 'generic-http.delete':
      return { ...common, method: 'DELETE', body: action.body }
  }
}

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
