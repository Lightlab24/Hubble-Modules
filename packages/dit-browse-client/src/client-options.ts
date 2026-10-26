import { type RawData } from 'ws'
import { type DitBrowseClientClock } from './client-models.js'

export const DIT_BROWSE_DEFAULT_PORT = 52_780

export const DIT_BROWSE_DEFAULT_REQUEST_TIMEOUT_MS = 3_500

export const DIT_BROWSE_DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const

export const SYSTEM_CLOCK: DitBrowseClientClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('DIT Browse port must be an integer between 1 and 65535')
  }
  return port
}

export function validatePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

export function validateReconnectDelays(delays: readonly number[]): readonly number[] {
  if (delays.length === 0) throw new RangeError('reconnectDelaysMs must not be empty')
  return Object.freeze(
    delays.map((delay) => validatePositiveDuration(delay, 'Reconnect delay')),
  )
}

export function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return
  const candidate = (handle as { readonly unref?: unknown }).unref
  if (typeof candidate === 'function') candidate.call(handle)
}

export function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
