import got, { type OptionsOfTextResponseBodyWrapped, type RequestFunction } from 'got'
import { request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as requestHttps } from 'node:https'
import { type HttpRequestsTransportResponse } from './http-models.js'
import { HTTP_REQUESTS_MAX_RESPONSE_HEADERS } from './http-options.js'

export const insecureNativeRequest: RequestFunction = (url, options, callback) => {
  options.insecureHTTPParser = true
  const onResponse = callback as ((response: IncomingMessage) => void) | undefined
  return url.protocol === 'https:'
    ? requestHttps(url, options, onResponse)
    : requestHttp(url, options, onResponse)
}

export function defaultRequestRunner(
  url: string,
  options: OptionsOfTextResponseBodyWrapped,
): PromiseLike<HttpRequestsTransportResponse> {
  const pending = got(url, options)
  void pending.on('request', (request: ClientRequest) => {
    request.maxHeadersCount = HTTP_REQUESTS_MAX_RESPONSE_HEADERS
  })
  return pending
}
