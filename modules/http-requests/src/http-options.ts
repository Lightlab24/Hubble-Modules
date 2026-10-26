import { GENERIC_HTTP_BODY_MAX_BYTES, GENERIC_HTTP_HEADER_MAX_BYTES } from './config.js'

export const HTTP_REQUESTS_MAX_RESPONSE_HEADER_BYTES = 16 * 1_024

export const HTTP_REQUESTS_MAX_RESPONSE_HEADERS = 100

export const HTTP_REQUESTS_GLOBAL_CAPACITY = 32

export const HTTP_REQUESTS_PER_ORIGIN_CAPACITY = 4

export const HTTP_REQUESTS_BODY_MAX_BYTES = GENERIC_HTTP_BODY_MAX_BYTES

export const HTTP_REQUESTS_HEADER_MAX_BYTES = GENERIC_HTTP_HEADER_MAX_BYTES

export const BASE_URL_MAX_BYTES = 2_048

export const PROXY_ADDRESS_MAX_BYTES = 2_048

export const REQUEST_TARGET_MAX_BYTES = 4_096

export const REQUEST_TIMEOUT_MS_MIN = 100

export const REQUEST_TIMEOUT_MS_MAX = 10_000

export function positiveCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('HTTP request capacity must be a positive integer')
  }
  return value
}

export function unrefTimer(timer: unknown): void {
  if (!hasUnref(timer)) return
  timer.unref()
}

export function hasUnref(timer: unknown): timer is { unref(): void } {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof Reflect.get(timer, 'unref') === 'function'
  ) {
    return true
  }
  return false
}
