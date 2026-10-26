import { type Headers, type OptionsOfTextResponseBodyWrapped } from 'got'
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent'
import { GenericHttpContentTypeSchema } from './config.js'
import { clientError } from './http-errors.js'
import {
  type HttpRequestsInput,
  type HttpRequestsMethod,
  type PreparedRequest,
  type ResolvedRequestUrl,
} from './http-models.js'
import {
  BASE_URL_MAX_BYTES,
  HTTP_REQUESTS_BODY_MAX_BYTES,
  HTTP_REQUESTS_HEADER_MAX_BYTES,
  HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES,
  PROXY_ADDRESS_MAX_BYTES,
  REQUEST_TARGET_MAX_BYTES,
  REQUEST_TIMEOUT_MS_MAX,
  REQUEST_TIMEOUT_MS_MIN,
} from './http-options.js'
import { insecureNativeRequest } from './http-transport.js'

export function prepareRequest(input: HttpRequestsInput): PreparedRequest {
  validateCommonInput(input)
  const endpoint = resolveHttpRequestUrl(input.baseUrl, input.requestTarget)
  const headers = parseHeaders(input.header)
  const options: OptionsOfTextResponseBodyWrapped = {
    headers,
    https: { rejectUnauthorized: input.rejectUnauthorized },
    maxHeaderSize: HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES,
    method: input.method,
    resolveBodyOnly: false,
    responseType: 'text',
    throwHttpErrors: false,
  }

  if (input.insecureHTTPParser) options.request = insecureNativeRequest
  if (input.proxyAddress !== '') {
    validateProxyAddress(input.proxyAddress)
    options.agent = {
      http: new HttpProxyAgent({ proxy: input.proxyAddress }),
      https: new HttpsProxyAgent({ proxy: input.proxyAddress }),
    }
  }

  if (input.method === 'POST' || input.method === 'PUT' || input.method === 'PATCH') {
    const parsedContentType = GenericHttpContentTypeSchema.safeParse(input.contenttype)
    if (!parsedContentType.success) {
      throw clientError('generic_http_invalid_target')
    }
    const contenttype = parsedContentType.data
    setHeader(headers, 'Content-Type', contenttype)
    const body = upstreamBody(input.body)
    if (contenttype === 'application/json') {
      try {
        const parsedBody = typeof body === 'string' ? (JSON.parse(body) as unknown) : body
        if (typeof parsedBody === 'string') {
          options.body = parsedBody.replace(/\\n/gu, '\n')
        } else if (parsedBody !== null && parsedBody !== undefined) {
          options.json = parsedBody
        }
      } catch {
        throw clientError('generic_http_invalid_target')
      }
    } else {
      options.body = stringifyUpstreamBody(body).replace(/\\n/gu, '\n')
    }
  } else if (input.method === 'DELETE') {
    options.body = stringifyUpstreamBody(upstreamBody(input.body)).replace(/\\n/gu, '\n')
  }

  return Object.freeze({ url: endpoint.url, origin: endpoint.origin, options })
}

export function validateCommonInput(input: HttpRequestsInput): void {
  if (
    !isHttpRequestsMethod(input.method) ||
    typeof input.rejectUnauthorized !== 'boolean' ||
    typeof input.insecureHTTPParser !== 'boolean' ||
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs < REQUEST_TIMEOUT_MS_MIN ||
    input.requestTimeoutMs > REQUEST_TIMEOUT_MS_MAX ||
    invalidSizedText(input.requestTarget, REQUEST_TARGET_MAX_BYTES) ||
    invalidSizedText(input.baseUrl, BASE_URL_MAX_BYTES) ||
    invalidSizedText(input.proxyAddress, PROXY_ADDRESS_MAX_BYTES) ||
    invalidSizedText(input.header, HTTP_REQUESTS_HEADER_MAX_BYTES)
  ) {
    throw clientError('generic_http_invalid_target')
  }
}

export function isHttpRequestsMethod(value: unknown): value is HttpRequestsMethod {
  return (
    value === 'GET' ||
    value === 'POST' ||
    value === 'PUT' ||
    value === 'PATCH' ||
    value === 'DELETE'
  )
}

export function resolveHttpRequestUrl(
  baseUrl: string,
  requestTarget: string,
): ResolvedRequestUrl {
  let absoluteTarget: URL | null = null
  try {
    absoluteTarget = new URL(requestTarget)
  } catch {
    // A relative action value is composed below.
  }
  const usesAbsoluteTarget =
    absoluteTarget !== null &&
    (absoluteTarget.protocol === 'http:' || absoluteTarget.protocol === 'https:')
  const source = usesAbsoluteTarget ? requestTarget : `${baseUrl}${requestTarget.trim()}`
  let endpoint: URL
  try {
    endpoint = new URL(source)
  } catch {
    throw clientError('generic_http_invalid_target')
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.hostname === '' ||
    (!usesAbsoluteTarget && baseUrl === '')
  ) {
    throw clientError('generic_http_invalid_target')
  }
  return { url: source, origin: endpoint.origin }
}

export function validateProxyAddress(proxyAddress: string): void {
  let proxy: URL
  try {
    proxy = new URL(proxyAddress)
  } catch {
    throw clientError('generic_http_invalid_target')
  }
  if ((proxy.protocol !== 'http:' && proxy.protocol !== 'https:') || proxy.hostname === '') {
    throw clientError('generic_http_invalid_target')
  }
}

export function parseHeaders(source: string): Headers {
  if (source.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw clientError('generic_http_invalid_target')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw clientError('generic_http_invalid_target')
  }
  return parsed as Headers
}

export function setHeader(headers: Headers, name: string, value: string): void {
  const lowerName = name.toLowerCase()
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === lowerName) Reflect.deleteProperty(headers, existingName)
  }
  headers[name] = value
}

export function validateBody(body: string): void {
  if (invalidSizedText(body, HTTP_REQUESTS_BODY_MAX_BYTES)) {
    throw clientError('generic_http_invalid_target')
  }
}

export function upstreamBody(body: string | undefined): string | Record<string, never> {
  if (body === undefined) return {}
  validateBody(body)
  return body.trim() === '' ? {} : body
}

export function stringifyUpstreamBody(body: string | Record<string, never>): string {
  return typeof body === 'string' ? body : '[object Object]'
}

export function invalidSizedText(value: unknown, maximumBytes: number): boolean {
  return typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
}
