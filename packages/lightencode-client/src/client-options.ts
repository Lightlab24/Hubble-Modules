import { createConnection } from 'node:net'
import { type LightEncodeClientClock, type LightEncodeSocket } from './client-models.js'
import { LIGHTENCODE_COMPANION_PORT } from './protocol.js'

export const LIGHTENCODE_DEFAULT_REQUEST_TIMEOUT_MS = 4_000

export const LIGHTENCODE_DEFAULT_RECONNECT_DELAY_MS = 2_000

export const LIGHTENCODE_PING_INTERVAL_MS = 5_000

export const LIGHTENCODE_STALE_INTERVAL_MS = 15_000

export const LIGHTENCODE_SERVER_REQUEST_CACHE_SIZE = 256

export const SYSTEM_CLOCK: LightEncodeClientClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export const EMPTY_CAPABILITIES: readonly string[] = Object.freeze([])

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

export function validateHost(host: string): string {
  const parsed = host
  if (parsed !== parsed.trim()) {
    throw new TypeError('Light Encode host must not contain whitespace')
  }
  if (parsed.length < 1 || parsed.length > 253) {
    throw new TypeError('Light Encode host must be a non-empty one-line host or IP')
  }
  if (/[\s\u0000-\u001f\u007f/\\@?#\[\]]/u.test(parsed)) {
    throw new TypeError(
      'Light Encode host must be a hostname, IPv4 address, or bare IPv6 address',
    )
  }
  const hostname =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
      parsed,
    )
  const bareIpv6 = parsed.includes(':') && /^[0-9A-Fa-f:.]+$/u.test(parsed)
  if (!hostname && !bareIpv6) {
    throw new TypeError(
      'Light Encode host must be a hostname, IPv4 address, or bare IPv6 address',
    )
  }
  try {
    const endpoint = new URL(
      `tcp://${bareIpv6 ? `[${parsed}]` : parsed}:${String(LIGHTENCODE_COMPANION_PORT)}/`,
    )
    if (
      endpoint.protocol !== 'tcp:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.pathname !== '/' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      endpoint.port !== String(LIGHTENCODE_COMPANION_PORT) ||
      (!bareIpv6 &&
        endpoint.hostname.toLocaleLowerCase('en-US') !== parsed.toLocaleLowerCase('en-US'))
    ) {
      throw new TypeError(
        'Light Encode host must be a hostname, IPv4 address, or bare IPv6 address',
      )
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Light Encode host')) throw error
    throw new TypeError(
      'Light Encode host must be a hostname, IPv4 address, or bare IPv6 address',
    )
  }
  return parsed
}

export function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return
  const unref = (handle as { readonly unref?: unknown }).unref
  if (typeof unref === 'function') unref.call(handle)
}

export function defaultSocketFactory(
  host: string,
  port: typeof LIGHTENCODE_COMPANION_PORT,
): LightEncodeSocket {
  return createConnection({ host, port })
}
