import { z } from 'zod'

import type { CyanViewStudioConnectionDefinition } from './config.js'

export const CYANVIEW_STUDIO_RESPONSE_MAX_BYTES = 1_048_576

const SelectFeedResponseSchema = z.strictObject({ status: z.literal('ok') }).readonly()
const API_VERSION_MAX_CODE_POINTS = 128

export type CyanViewStudioHttpClientErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'camera_not_found'
  | 'feed_not_found'
  | 'invalid_request'
  | 'protocol_error'

export class CyanViewStudioHttpClientError extends Error {
  override readonly name = 'CyanViewStudioHttpClientError'

  constructor(
    readonly code: CyanViewStudioHttpClientErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface CyanViewStudioProbeResult {
  readonly apiVersion: string
  readonly supportsFeedId: boolean
  readonly supportsFeedNumber: boolean
}

export interface CyanViewStudioHttpClientContract {
  probe(): Promise<CyanViewStudioProbeResult>
  selectFeed(cameraId: string): Promise<void>
  selectFeedByFeedId(feedId: number): Promise<void>
  selectFeedByNumber(feedNumber: number): Promise<void>
}

type CyanViewStudioFeedSelector =
  | Readonly<{ kind: 'camera'; cameraId: string }>
  | Readonly<{ kind: 'feed'; feedId: number }>
  | Readonly<{ kind: 'number'; feedNumber: number }>

export interface CyanViewStudioResponseReaderLike {
  read(): Promise<Readonly<{ done: boolean; value?: Uint8Array | undefined }>>
  cancel(): Promise<void>
  releaseLock(): void
}

export interface CyanViewStudioResponseLike {
  readonly status: number
  readonly headers: Readonly<{ get(name: string): string | null }>
  readonly body: Readonly<{ getReader(): CyanViewStudioResponseReaderLike }> | null
}

export interface CyanViewStudioFetch {
  (
    input: string,
    init: Readonly<{
      cache: 'no-store'
      credentials: 'omit'
      headers: Readonly<Record<string, string>>
      method: 'GET' | 'POST'
      redirect: 'error'
      signal: AbortSignal
    }>,
  ): Promise<CyanViewStudioResponseLike>
}

export interface CyanViewStudioHttpClientOptions {
  readonly host: string
  readonly port: number
  readonly requestTimeoutMs: number
  readonly fetch?: CyanViewStudioFetch
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout?: (timer: unknown) => void
}

export class CyanViewStudioHttpClient implements CyanViewStudioHttpClientContract {
  readonly #origin: URL
  readonly #requestTimeoutMs: number
  readonly #fetch: CyanViewStudioFetch
  readonly #scheduleTimeout: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimeout: (timer: unknown) => void

  constructor(options: CyanViewStudioHttpClientOptions) {
    this.#origin = cyanViewOrigin(options.host, options.port)
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs)
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#scheduleTimeout =
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimeout =
      options.clearTimeout ??
      ((timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>)
      })
  }

  async probe(): Promise<CyanViewStudioProbeResult> {
    return this.request('/api/openapi', 'GET', async (response) => {
      if (response.status !== 200) {
        await discardBody(response)
        throw response.status >= 300 && response.status < 400
          ? clientError('protocol_error')
          : clientError('unavailable')
      }
      const document = await parseBoundedJson(response)
      return parseOpenApiContract(document)
    })
  }

  async selectFeed(cameraId: string): Promise<void> {
    return this.selectFeedBySelector({ kind: 'camera', cameraId })
  }

  async selectFeedByFeedId(feedId: number): Promise<void> {
    if (!Number.isSafeInteger(feedId)) throw clientError('invalid_request')
    return this.selectFeedBySelector({ kind: 'feed', feedId })
  }

  async selectFeedByNumber(feedNumber: number): Promise<void> {
    if (!Number.isSafeInteger(feedNumber) || feedNumber < 1)
      throw clientError('invalid_request')
    return this.selectFeedBySelector({ kind: 'number', feedNumber })
  }

  private async selectFeedBySelector(selector: CyanViewStudioFeedSelector): Promise<void> {
    const endpoint = new URL('/api/control/feed', this.#origin)
    if (selector.kind === 'camera') {
      endpoint.searchParams.set('camera_id', selector.cameraId)
    } else if (selector.kind === 'number') {
      endpoint.searchParams.set('feed_number', String(selector.feedNumber))
    } else {
      endpoint.searchParams.set('feed_id', String(selector.feedId))
    }
    await this.request(endpoint, 'POST', async (response) => {
      if (response.status === 404) {
        await discardBody(response)
        throw clientError(selector.kind === 'camera' ? 'camera_not_found' : 'feed_not_found')
      }
      if (response.status === 422) {
        await discardBody(response)
        throw clientError('invalid_request')
      }
      if (response.status !== 200) {
        await discardBody(response)
        throw response.status >= 300 && response.status < 400
          ? clientError('protocol_error')
          : clientError('unavailable')
      }
      const document = await parseBoundedJson(response)
      if (!SelectFeedResponseSchema.safeParse(document).success) {
        throw clientError('protocol_error')
      }
    })
  }

  private async request<TResult>(
    path: string | URL,
    method: 'GET' | 'POST',
    consume: (response: CyanViewStudioResponseLike) => Promise<TResult>,
  ): Promise<TResult> {
    const endpoint = path instanceof URL ? path : new URL(path, this.#origin)
    const controller = new AbortController()
    const deadline = this.#scheduleTimeout(() => {
      controller.abort()
    }, this.#requestTimeoutMs)
    unrefTimer(deadline)
    try {
      const response = await this.#fetch(endpoint.href, {
        cache: 'no-store',
        credentials: 'omit',
        headers: Object.freeze({
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
        }),
        method,
        redirect: 'error',
        signal: controller.signal,
      })
      return await consume(response)
    } catch (error: unknown) {
      if (controller.signal.aborted) throw clientError('timeout')
      if (error instanceof CyanViewStudioHttpClientError) throw error
      throw clientError('unavailable')
    } finally {
      this.#clearTimeout(deadline)
    }
  }
}

export function createCyanViewStudioHttpClient(
  definition: CyanViewStudioConnectionDefinition,
): CyanViewStudioHttpClientContract {
  return new CyanViewStudioHttpClient({
    host: definition.host,
    port: definition.port,
    requestTimeoutMs: definition.requestTimeoutMs,
  })
}

async function parseBoundedJson(response: CyanViewStudioResponseLike): Promise<unknown> {
  let bytes: Uint8Array
  try {
    bytes = await readBoundedBody(response)
  } catch (error: unknown) {
    if (error instanceof CyanViewStudioHttpClientError) throw error
    throw clientError('protocol_error')
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw clientError('protocol_error')
  }
}

async function readBoundedBody(response: CyanViewStudioResponseLike): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      await discardBody(response)
      throw clientError('protocol_error')
    }
    const length = Number(declaredLength)
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > CYANVIEW_STUDIO_RESPONSE_MAX_BYTES
    ) {
      await discardBody(response)
      throw clientError('protocol_error')
    }
  }
  if (response.body === null) throw clientError('protocol_error')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let completed = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        completed = true
        break
      }
      const value = chunk.value
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw clientError('protocol_error')
      }
      byteLength += value.byteLength
      if (byteLength > CYANVIEW_STUDIO_RESPONSE_MAX_BYTES) {
        throw clientError('protocol_error')
      }
      chunks.push(value)
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (byteLength < 1) throw clientError('protocol_error')

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function discardBody(response: CyanViewStudioResponseLike): Promise<void> {
  if (response.body === null) return
  const reader = response.body.getReader()
  try {
    await reader.cancel().catch(() => undefined)
  } finally {
    reader.releaseLock()
  }
}

function parseOpenApiContract(document: unknown): CyanViewStudioProbeResult {
  const root = record(document)
  const info = root === null ? null : record(root.info)
  const paths = root === null ? null : record(root.paths)
  const feedPath = paths === null ? null : record(paths['/api/control/feed'])
  const post = feedPath === null ? null : record(feedPath.post)
  const rawVersion = info?.version
  if (
    post === null ||
    typeof rawVersion !== 'string' ||
    !hasDirectOptionalQueryParameter(post, 'camera_id', 'string')
  ) {
    throw clientError('protocol_error')
  }
  const version = rawVersion.trim()
  if (
    version.length === 0 ||
    Array.from(version).length > API_VERSION_MAX_CODE_POINTS ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(version)
  ) {
    throw clientError('protocol_error')
  }
  return Object.freeze({
    apiVersion: version,
    supportsFeedId: hasDirectOptionalQueryParameter(post, 'feed_id', 'integer'),
    supportsFeedNumber: hasDirectOptionalQueryParameter(post, 'feed_number', 'integer'),
  })
}

function hasDirectOptionalQueryParameter(
  operation: Record<string, unknown>,
  name: string,
  type: 'integer' | 'string',
): boolean {
  const parameters = operation.parameters
  if (!Array.isArray(parameters)) return false
  return parameters.some((value) => {
    const parameter = record(value)
    const schema = parameter === null ? null : record(parameter.schema)
    return (
      parameter?.in === 'query' &&
      parameter.name === name &&
      (parameter.required === undefined || parameter.required === false) &&
      schema?.type === type
    )
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cyanViewOrigin(host: string, port: number): URL {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw clientError('protocol_error')
  }
  const sourceHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  let endpoint: URL
  try {
    endpoint = new URL(`http://${sourceHost}:${String(port)}/`)
  } catch {
    throw clientError('protocol_error')
  }
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    !matchesConfiguredPort(endpoint, port)
  ) {
    throw clientError('protocol_error')
  }
  return endpoint
}

function matchesConfiguredPort(endpoint: URL, port: number): boolean {
  return endpoint.port === String(port) || (port === 80 && endpoint.port === '')
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw clientError('protocol_error')
  return value
}

function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return
  const candidate = (handle as { readonly unref?: unknown }).unref
  if (typeof candidate === 'function') candidate.call(handle)
}

function clientError(code: CyanViewStudioHttpClientErrorCode): CyanViewStudioHttpClientError {
  const messages = {
    unavailable: 'CyanView Studio is unavailable',
    timeout: 'CyanView Studio did not respond before the request timeout',
    camera_not_found: 'CyanView Studio could not find the requested camera',
    feed_not_found: 'CyanView Studio could not find the requested feed',
    invalid_request: 'CyanView Studio rejected the feed selection request',
    protocol_error: 'CyanView Studio returned an invalid response',
  } as const
  return new CyanViewStudioHttpClientError(code, messages[code])
}
