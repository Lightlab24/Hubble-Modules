export const MAX_RESPONSE_BYTES = 1_048_576

export const EVENT_TIMEOUT_MS = 10_000

export const LOCK_REFRESH_MS = 30_000

export type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AJA KUMO returned invalid JSON data')
  return value as JsonObject
}

export function address(value: unknown, maximum = 64): number {
  const number = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > maximum
  ) {
    throw new RangeError(`AJA KUMO address must be an integer from 1 to ${String(maximum)}`)
  }
  return number
}

export function locked(value: unknown): boolean {
  if (value !== 0 && value !== 1 && value !== '0' && value !== '1')
    throw new Error('AJA KUMO returned an invalid lock state')
  return value === 1 || value === '1'
}

export function label(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, ' ')
        .trim()
        .slice(0, 128)
    : ''
}

export function salvoName(value: unknown): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? label((value as JsonObject).name)
    : ''
}
