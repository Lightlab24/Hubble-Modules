import { type ActiveAbortReason, type HttpRequestsClientErrorCode } from './http-models.js'

export class HttpRequestsClientError extends Error {
  override readonly name = 'HttpRequestsClientError'

  constructor(readonly code: HttpRequestsClientErrorCode) {
    super(ERROR_MESSAGES[code])
  }
}

export const ERROR_MESSAGES = Object.freeze({
  aborted: 'HTTP request was canceled',
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
} satisfies Readonly<Record<HttpRequestsClientErrorCode, string>>)

export const TLS_ERROR_CODES = new Set([
  'CERT_EXPIRED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

export const DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'ENODATA', 'ENOTFOUND'])

export const INVALID_REQUEST_ERROR_CODES = new Set([
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
])

export const PROTOCOL_ERROR_CODES = new Set([
  'ERR_BODY_PARSE_FAILURE',
  'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
  'HPE_INVALID_CONSTANT',
  'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_VERSION',
  'HPE_UNEXPECTED_CONTENT_LENGTH',
])

export function abortReasonError(reason: ActiveAbortReason): HttpRequestsClientError | null {
  if (reason === 'deadline') return clientError('generic_http_timeout')
  if (reason === 'caller' || reason === 'stop') return clientError('aborted')
  return null
}

export function mapTransportError(error: unknown): HttpRequestsClientError {
  const code = transportErrorCode(error)
  const name = errorName(error)
  if (code === 'ERR_TOO_MANY_REDIRECTS' || name === 'MaxRedirectsError') {
    return clientError('generic_http_redirect_blocked')
  }
  if (DNS_ERROR_CODES.has(code)) return clientError('generic_http_dns_failed')
  if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
    return clientError('generic_http_tls_failed')
  }
  if (INVALID_REQUEST_ERROR_CODES.has(code)) return clientError('generic_http_invalid_target')
  if (PROTOCOL_ERROR_CODES.has(code) || code.startsWith('HPE_')) {
    return clientError('generic_http_protocol_error')
  }
  if (error instanceof TypeError || code === 'ERR_GOT_REQUEST_ERROR') {
    return clientError('generic_http_invalid_target')
  }
  return clientError('generic_http_unavailable')
}

export function transportErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}

export function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  return typeof error.name === 'string' ? error.name : ''
}

export function clientError(code: HttpRequestsClientErrorCode): HttpRequestsClientError {
  return new HttpRequestsClientError(code)
}
