import type { Swp08Crosspoint, Swp08RouterLabel } from './models.js'
import {
  type RossSwp08DestinationPageRequest,
  type RossSwp08RoutePageRequest,
} from './routing-models.js'

export const MAXIMUM_PAGE_SIZE = 2_048

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function validatePageRequest(request: RossSwp08RoutePageRequest): void {
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAXIMUM_PAGE_SIZE
  ) {
    throw new RangeError(
      `Ross route page limit must be an integer from 1 to ${String(MAXIMUM_PAGE_SIZE)}`,
    )
  }
  if (request.afterAddress !== null) validateAddress(request.afterAddress, 'afterAddress')
  if (request.search !== null && typeof request.search !== 'string') {
    throw new TypeError('Ross route page search must be a string or null')
  }
}

export function validateDestinationPageRequest(request: RossSwp08DestinationPageRequest): void {
  validatePageRequest(request)
  if (request.source === null && request.levels.length > 0) {
    throw new Error('Ross destination page levels require a source filter')
  }
  if (request.source !== null) validateAddress(request.source, 'source')
  for (const level of request.levels) validateAddress(level, 'level')
}

export function validateCrosspoint(crosspoint: Swp08Crosspoint): void {
  validateAddress(crosspoint.matrix, 'matrix')
  validateAddress(crosspoint.level, 'level')
  validateAddress(crosspoint.destination, 'destination')
  validateAddress(crosspoint.source, 'source')
}

export function validateAddress(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Ross ${label} must be a positive integer`)
  }
}

export function validateRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Ross ${label} must be a non-negative safe integer`)
  }
}

export function labelMap(
  labels: readonly Swp08RouterLabel[],
  kind: string,
): Map<number, string | null> {
  const result = new Map<number, string | null>()
  for (const entry of labels) {
    validateAddress(entry.address, `${kind} address`)
    if (result.has(entry.address)) {
      throw new Error(
        `Ross ${kind} catalog contains duplicate address ${String(entry.address)}`,
      )
    }
    result.set(entry.address, entry.label.trim() === '' ? null : entry.label)
  }
  return result
}

export function mapsEqual(
  left: ReadonlyMap<number, string | null>,
  right: ReadonlyMap<number, string | null>,
): boolean {
  if (left.size !== right.size) return false
  for (const [address, label] of left) {
    if (right.get(address) !== label) return false
  }
  return true
}

export function nestedMapsEqual(
  left: ReadonlyMap<number, ReadonlyMap<number, number>>,
  right: ReadonlyMap<number, ReadonlyMap<number, number>>,
): boolean {
  if (left.size !== right.size) return false
  for (const [address, leftLevels] of left) {
    const rightLevels = right.get(address)
    if (rightLevels === undefined || leftLevels.size !== rightLevels.size) return false
    for (const [level, source] of leftLevels) {
      if (rightLevels.get(level) !== source) return false
    }
  }
  return true
}

export function countUnion(
  primary: ReadonlyMap<number, unknown>,
  secondary: ReadonlyMap<number, unknown>,
): number {
  let count = primary.size
  for (const address of secondary.keys()) {
    if (!primary.has(address)) count += 1
  }
  return count
}

export function normalizedSearch(search: string | null): string | null {
  if (search === null) return null
  const normalized = search.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  return normalized === '' ? null : normalized
}

export function resourceMatches(
  address: number,
  label: string | null,
  search: string | null,
): boolean {
  if (search === null) return true
  return (
    String(address).includes(search) ||
    (label !== null && label.normalize('NFKC').toLocaleLowerCase('en-US').includes(search))
  )
}

export function keysetPage(
  sortedAddresses: readonly number[],
  afterAddress: number | null,
  limit: number,
): Readonly<{ addresses: readonly number[]; nextAfterAddress: number | null }> {
  const available =
    afterAddress === null
      ? sortedAddresses
      : sortedAddresses.filter((address) => address > afterAddress)
  const addresses = Object.freeze(available.slice(0, limit))
  const lastAddress = addresses.at(-1) ?? null
  return Object.freeze({
    addresses,
    nextAfterAddress: available.length > addresses.length ? lastAddress : null,
  })
}

export function compareNumbers(left: number, right: number): number {
  return left - right
}
