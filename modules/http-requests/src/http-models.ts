import { type OptionsOfTextResponseBodyWrapped } from 'got'
import { type GenericHttpContentType } from './config.js'

export type HttpRequestsMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpRequestsClientErrorCode =
  | 'aborted'
  | 'generic_http_invalid_target'
  | 'generic_http_target_blocked'
  | 'generic_http_dns_failed'
  | 'generic_http_timeout'
  | 'generic_http_tls_failed'
  | 'generic_http_redirect_blocked'
  | 'generic_http_rejected'
  | 'generic_http_capacity_exceeded'
  | 'generic_http_unavailable'
  | 'generic_http_protocol_error'

export interface HttpRequestsInput {
  readonly method: HttpRequestsMethod
  readonly baseUrl: string
  readonly proxyAddress: string
  readonly rejectUnauthorized: boolean
  readonly insecureHTTPParser: boolean
  readonly requestTimeoutMs: number
  readonly requestTarget: string
  readonly body?: string
  readonly header: string
  readonly contenttype?: GenericHttpContentType
  readonly signal: AbortSignal
}

export interface HttpRequestsClientContract {
  request(input: HttpRequestsInput): Promise<void>
  stop(): void
}

export interface HttpRequestsTransportResponse {
  readonly ok: boolean
  readonly statusCode: number
}

export type HttpRequestsRequestRunner = (
  url: string,
  options: OptionsOfTextResponseBodyWrapped,
) => PromiseLike<HttpRequestsTransportResponse>

export interface HttpRequestsClientOptions {
  readonly requestRunner?: HttpRequestsRequestRunner
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  readonly globalCapacity?: number
  readonly perOriginCapacity?: number
}

export interface PreparedRequest {
  readonly url: string
  readonly origin: string
  readonly options: OptionsOfTextResponseBodyWrapped
}

export interface ResolvedRequestUrl {
  readonly url: string
  readonly origin: string
}

export interface CapacityLease {
  release(): void
}

export type ActiveAbortReason = 'none' | 'caller' | 'deadline' | 'stop'

export interface ActiveRequest {
  abort(reason: Exclude<ActiveAbortReason, 'none'>): void
}
