import {
  abortReasonError,
  clientError,
  HttpRequestsClientError,
  mapTransportError,
} from './http-errors.js'
import {
  type ActiveAbortReason,
  type ActiveRequest,
  type CapacityLease,
  type HttpRequestsClientContract,
  type HttpRequestsClientOptions,
  type HttpRequestsInput,
  type HttpRequestsRequestRunner,
  type PreparedRequest,
} from './http-models.js'
import {
  HTTP_REQUESTS_GLOBAL_CAPACITY,
  HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
  positiveCapacity,
  unrefTimer,
} from './http-options.js'
import { prepareRequest } from './http-request.js'
import { defaultRequestRunner } from './http-transport.js'

export class HttpRequestsClient implements HttpRequestsClientContract {
  readonly #requestRunner: HttpRequestsRequestRunner
  readonly #scheduleTimeout: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimeout: (handle: unknown) => void
  readonly #globalCapacity: number
  readonly #perOriginCapacity: number
  readonly #activeByOrigin = new Map<string, number>()
  readonly #activeRequests = new Set<ActiveRequest>()
  #active = 0
  #stopped = false

  constructor(options: HttpRequestsClientOptions = {}) {
    this.#requestRunner = options.requestRunner ?? defaultRequestRunner
    this.#scheduleTimeout =
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimeout =
      options.clearTimeout ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
    this.#globalCapacity = positiveCapacity(
      options.globalCapacity ?? HTTP_REQUESTS_GLOBAL_CAPACITY,
    )
    this.#perOriginCapacity = positiveCapacity(
      options.perOriginCapacity ?? HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
    )
  }

  async request(input: HttpRequestsInput): Promise<void> {
    if (this.#stopped) throw clientError('generic_http_unavailable')
    if (input.signal.aborted) throw clientError('aborted')

    let prepared: PreparedRequest
    try {
      prepared = prepareRequest(input)
    } catch (error: unknown) {
      throw error instanceof HttpRequestsClientError
        ? error
        : clientError('generic_http_invalid_target')
    }

    const lease = this.#tryAcquire(prepared.origin)
    if (lease === null) throw clientError('generic_http_capacity_exceeded')

    const requestController = new AbortController()
    const abortState: { reason: ActiveAbortReason } = { reason: 'none' }
    const activeRequest: ActiveRequest = {
      abort(reason) {
        if (abortState.reason !== 'none') return
        abortState.reason = reason
        requestController.abort()
      },
    }
    const abortFromCaller = (): void => {
      activeRequest.abort('caller')
    }
    this.#activeRequests.add(activeRequest)
    input.signal.addEventListener('abort', abortFromCaller, { once: true })
    const deadline = this.#scheduleTimeout(() => {
      activeRequest.abort('deadline')
    }, input.requestTimeoutMs)
    unrefTimer(deadline)

    try {
      const response = await this.#requestRunner(prepared.url, {
        ...prepared.options,
        signal: requestController.signal,
      })
      const aborted = abortReasonError(abortState.reason)
      if (aborted !== null) throw aborted
      if (input.method !== 'DELETE' && !response.ok) {
        throw clientError('generic_http_rejected')
      }
    } catch (error: unknown) {
      if (error instanceof HttpRequestsClientError) throw error
      const aborted = abortReasonError(abortState.reason)
      if (aborted !== null) throw aborted
      throw mapTransportError(error)
    } finally {
      this.#clearTimeout(deadline)
      input.signal.removeEventListener('abort', abortFromCaller)
      this.#activeRequests.delete(activeRequest)
      lease.release()
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const request of [...this.#activeRequests]) request.abort('stop')
  }

  #tryAcquire(origin: string): CapacityLease | null {
    const activeForOrigin = this.#activeByOrigin.get(origin) ?? 0
    if (this.#active >= this.#globalCapacity || activeForOrigin >= this.#perOriginCapacity) {
      return null
    }
    this.#active += 1
    this.#activeByOrigin.set(origin, activeForOrigin + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.#active -= 1
        const remaining = (this.#activeByOrigin.get(origin) ?? 1) - 1
        if (remaining === 0) this.#activeByOrigin.delete(origin)
        else this.#activeByOrigin.set(origin, remaining)
      },
    }
  }
}
export { HttpRequestsClientError } from './http-errors.js'
export {
  type HttpRequestsClientContract,
  type HttpRequestsClientErrorCode,
  type HttpRequestsClientOptions,
  type HttpRequestsInput,
  type HttpRequestsMethod,
  type HttpRequestsRequestRunner,
  type HttpRequestsTransportResponse,
} from './http-models.js'
export {
  HTTP_REQUESTS_BODY_MAX_BYTES,
  HTTP_REQUESTS_GLOBAL_CAPACITY,
  HTTP_REQUESTS_HEADER_MAX_BYTES,
  HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES,
  HTTP_REQUESTS_MAX_RESPONSE_HEADERS,
  HTTP_REQUESTS_PER_ORIGIN_CAPACITY,
} from './http-options.js'
export { resolveHttpRequestUrl } from './http-request.js'
