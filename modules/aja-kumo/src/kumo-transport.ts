import http from 'node:http'
import type { AjaKumoConnectionDefinition } from './config.js'

export class KumoHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'AJA KUMO authentication required or password rejected'
        : status === 403
          ? 'AJA KUMO rejected the command (destination locked or authentication required)'
          : `AJA KUMO rejected the request (HTTP ${String(status)})`,
    )
  }
}

export async function boundedRequests(
  requests: readonly (() => Promise<void>)[],
): Promise<void> {
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(4, requests.length) }, async () => {
      while (index < requests.length) {
        const request = requests[index++]
        await request?.()
      }
    }),
  )
}

import { MAX_RESPONSE_BYTES } from './kumo-values.js'

export class KumoHttpTransport {
  readonly #cookies = new Map<string, string>()
  constructor(
    private readonly definition: Pick<
      AjaKumoConnectionDefinition,
      'host' | 'port' | 'requestTimeoutMs'
    >,
  ) {}
  clear(): void {
    this.#cookies.clear()
  }
  request(
    path: string,
    signal: AbortSignal,
    body?: string,
    timeoutMs = this.definition.requestTimeoutMs,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const host =
      this.definition.host.includes(':') && !this.definition.host.startsWith('[')
        ? `[${this.definition.host}]`
        : this.definition.host
    return new Promise((resolve, reject) => {
      const request = http.request(
        new URL(path, `http://${host}:${String(this.definition.port)}`),
        {
          method: body === undefined ? 'GET' : 'POST',
          signal,
          headers: {
            Accept: 'application/json',
            ...(this.#cookies.size === 0
              ? {}
              : {
                  Cookie: [...this.#cookies]
                    .map(([key, value]) => `${key}=${value}`)
                    .join('; '),
                }),
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(body),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > MAX_RESPONSE_BYTES)
              request.destroy(new Error('AJA KUMO response exceeded the size limit'))
            else chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => {
            if (signal.aborted) {
              reject(new Error('AJA KUMO connection closed'))
              return
            }
            const status = response.statusCode ?? 0
            if (status < 200 || status >= 300) {
              reject(new KumoHttpError(status))
              return
            }
            for (const cookie of response.headers['set-cookie'] ?? []) {
              const pair = /^([^=;\s]+)=([^;]*)/u.exec(cookie)
              if (pair?.[1] !== undefined && pair[2] !== undefined) {
                if (/max-age=0(?:;|$)/iu.test(cookie)) this.#cookies.delete(pair[1])
                else this.#cookies.set(pair[1], pair[2])
              }
            }
            try {
              const text = Buffer.concat(chunks).toString('utf8')
              resolve(text.trim() === '' ? {} : (JSON.parse(text) as unknown))
            } catch {
              reject(new Error('AJA KUMO returned invalid JSON'))
            }
          })
        },
      )
      // Bound the whole request, including DNS, connection setup, and streamed responses.
      const timer = setTimeout(
        () => request.destroy(new Error('AJA KUMO request timed out')),
        timeoutMs,
      )
      request.on('close', () => {
        clearTimeout(timer)
      })
      request.on('error', reject)
      request.end(body)
    })
  }
}
