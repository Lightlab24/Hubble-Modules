import type { OgpValueReference } from './messages.js'
import type { OgpCrosspoint, OgpLevel, OgpRouterLabel } from './ultrix-parameters.js'
export function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${String(maximum)}`)
  }
  return value
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function referenceKey(reference: OgpValueReference): string {
  return `${reference.oid}\u0000${reference.element === true ? String(reference.index) : '*'}`
}

export function routeKey(destination: number, level: number): string {
  return `${String(destination)}:${String(level)}`
}

export function sortedLabels(
  labels: ReadonlyMap<number, OgpRouterLabel>,
): readonly OgpRouterLabel[] {
  return Object.freeze([...labels.values()].sort((left, right) => left.address - right.address))
}

export function sortedLevels(levels: readonly OgpLevel[]): readonly OgpLevel[] {
  return Object.freeze([...levels].sort((left, right) => left.level - right.level))
}

export function sortedRoutes(
  routes: ReadonlyMap<string, OgpCrosspoint>,
): readonly OgpCrosspoint[] {
  return Object.freeze(
    [...routes.values()].sort(
      (left, right) => left.destination - right.destination || left.level - right.level,
    ),
  )
}

export function immutableCrosspoint(crosspoint: OgpCrosspoint): OgpCrosspoint {
  return Object.freeze({ ...crosspoint })
}

export function controlReadyValue(value: unknown): boolean {
  if (typeof value !== 'boolean' && !Number.isSafeInteger(value)) {
    throw new Error('params.controlready must be an integer')
  }
  return typeof value === 'boolean' ? value : value !== 0
}

export function takeErrorValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('params.takeError must be a string')
  return value
}
