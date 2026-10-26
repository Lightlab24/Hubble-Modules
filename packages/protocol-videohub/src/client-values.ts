import type { VideohubDeviceSnapshot } from './client-types.js'
import {
  VideohubError,
  immutableCrosspoint,
  immutableLabel,
  immutableLock,
  type VideohubCrosspoint,
  type VideohubOutputLock,
  type VideohubRouterLabel,
} from './protocol.js'

export function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${String(maximum)}`)
  }
  return value
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sortedLabels(
  labels: ReadonlyMap<number, VideohubRouterLabel>,
  maximum: number | null,
): readonly VideohubRouterLabel[] {
  return Object.freeze(
    [...labels.values()]
      .filter((label) => maximum === null || label.address <= maximum)
      .sort((left, right) => left.address - right.address)
      .map(immutableLabel),
  )
}

export function sortedRoutes(
  routes: ReadonlyMap<number, VideohubCrosspoint>,
  maximumSource: number | null,
  maximumDestination: number | null,
): readonly VideohubCrosspoint[] {
  return Object.freeze(
    [...routes.values()]
      .filter(
        (route) =>
          (maximumSource === null || route.source <= maximumSource) &&
          (maximumDestination === null || route.destination <= maximumDestination),
      )
      .sort((left, right) => left.destination - right.destination)
      .map(immutableCrosspoint),
  )
}

export function sortedLocks(
  locks: ReadonlyMap<number, VideohubOutputLock>,
  maximumDestination: number | null,
): readonly VideohubOutputLock[] {
  return Object.freeze(
    [...locks.values()]
      .filter((lock) => maximumDestination === null || lock.destination <= maximumDestination)
      .sort((left, right) => left.destination - right.destination)
      .map(immutableLock),
  )
}

export function coversAddresses(entries: readonly number[], count: number): boolean {
  if (entries.length < count) return false
  const observed = new Set(entries)
  for (let address = 1; address <= count; address += 1) {
    if (!observed.has(address)) return false
  }
  return true
}

const MAX_HUBBLE_ROUTER_LABEL_LENGTH = 128
const UNREADABLE_ROUTER_LABEL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u

export function isUsableRouterLabel(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name.length <= MAX_HUBBLE_ROUTER_LABEL_LENGTH &&
    Array.from(name).length <= MAX_HUBBLE_ROUTER_LABEL_LENGTH &&
    !UNREADABLE_ROUTER_LABEL.test(name)
  )
}

export function safeRouterLabel(
  prefix: 'Input' | 'Output',
  label: VideohubRouterLabel,
): Readonly<{ label: VideohubRouterLabel; degraded: boolean }> {
  const degraded = !isUsableRouterLabel(label.name)
  return Object.freeze({
    label: immutableLabel({
      address: label.address,
      name: degraded ? `${prefix} ${String(label.address)}` : label.name,
    }),
    degraded,
  })
}

export function immutableDevice(snapshot: VideohubDeviceSnapshot): VideohubDeviceSnapshot {
  return Object.freeze({ ...snapshot })
}

export function disconnectedError(message = 'Videohub is not connected'): VideohubError {
  return new VideohubError('disconnected', message)
}
