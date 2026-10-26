import type { OgpValuePayload } from './messages.js'

export const READ_OIDS = Object.freeze([
  'params.basicsources',
  'params.basicdests',
  'params.levels',
  'params.statusByDestination',
  'params.controlready',
  'params.takeError',
] as const)

export const ROUTE_STATUS_OID = 'params.statusByDestination'
export const ROUTE_SUBSCRIPTION_OID = ROUTE_STATUS_OID
export const CONTROL_READY_OID = 'params.controlready'
export const TAKE_ERROR_OID = 'params.takeError'
export const DEFAULT_OGP_PANEL_ID = 1999
export const ROUTE_CONTROLLER_IDENTITY_OID = 'params.statusByDestination.0.lockowner'

export type OgpCatalogOid = 'params.basicsources' | 'params.basicdests'

export interface OgpRouterLabel {
  readonly address: number
  readonly label: string
  readonly description: string | null
}

export interface OgpLevel {
  readonly level: number
  readonly label: string
}

export interface OgpCrosspoint {
  readonly destination: number
  readonly level: number
  readonly source: number | null
}

export interface OgpRouteWrite extends OgpValuePayload {
  readonly oid: string
  readonly element: true
  readonly index: number
  readonly value: number
}

export interface OgpRouteControllerIdentityWrite extends OgpValuePayload {
  readonly oid: typeof ROUTE_CONTROLLER_IDENTITY_OID
  readonly element: true
  readonly index: 0
  readonly value: number
}

export interface OgpRouteLimits {
  readonly levels: number
  readonly sourceLimit: number
  readonly destinationLimit: number
}

export interface ValidatedDeviceParameters {
  readonly controlReady: boolean
  readonly takeError: string
  readonly statusRows: readonly unknown[]
  readonly multiSetEnabled?: boolean
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${String(maximum)}`)
  }
  return value
}

function descriptor(
  params: Record<string, unknown>,
  key: string,
  oid: string,
): Record<string, unknown> {
  const result = objectValue(params[key], `OGP descriptor ${oid}`)
  if (result.oid !== undefined && result.oid !== oid) {
    throw new Error(`OGP descriptor ${oid} has a mismatched OID`)
  }
  return result
}

function normalizedDescription(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function routeOid(destination: number): string {
  return `params.statusByDestination.${String(
    positiveInteger(destination, 'destination', 65_536) - 1,
  )}.inputstatus`
}

export function routeElement(level: number): number {
  return positiveInteger(level, 'level', 256) - 1
}

export function routeValue(source: number): number {
  return positiveInteger(source, 'source', 65_536) - 1
}

export function createRouteWrite(input: {
  readonly source: number
  readonly destination: number
  readonly level: number
}): OgpRouteWrite {
  return Object.freeze({
    oid: routeOid(input.destination),
    element: true,
    index: routeElement(input.level),
    value: routeValue(input.source),
  })
}

export function createRouteControllerIdentityWrite(input: {
  readonly panelId: number
}): OgpRouteControllerIdentityWrite {
  return Object.freeze({
    oid: ROUTE_CONTROLLER_IDENTITY_OID,
    element: true,
    index: 0,
    value: positiveInteger(input.panelId, 'panelId', 65_535),
  })
}

export function assertSafeRouteControllerIdentityWrite(
  write: OgpValuePayload,
): asserts write is OgpRouteControllerIdentityWrite {
  if (
    write.oid !== ROUTE_CONTROLLER_IDENTITY_OID ||
    write.element !== true ||
    write.index !== 0 ||
    !Number.isSafeInteger(write.value) ||
    (write.value as number) < 1 ||
    (write.value as number) > 65_535
  ) {
    throw new Error(`Unsafe OGP route-controller identity write rejected for OID ${write.oid}`)
  }
}

export function assertSafeRouteWrite(write: OgpValuePayload): asserts write is OgpRouteWrite {
  if (
    !/^params\.statusByDestination\.(?:0|[1-9]\d*)\.inputstatus$/u.test(write.oid) ||
    write.element !== true ||
    !Number.isSafeInteger(write.index) ||
    (write.index ?? -1) < 0 ||
    (write.index ?? 256) > 255 ||
    !Number.isSafeInteger(write.value) ||
    (write.value as number) < 0 ||
    (write.value as number) > 65_535
  ) {
    throw new Error(`Unsafe OGP route write rejected for OID ${write.oid}`)
  }
  const destinationIndex = Number(write.oid.split('.')[2])
  if (
    !Number.isSafeInteger(destinationIndex) ||
    destinationIndex < 0 ||
    destinationIndex > 65_535
  ) {
    throw new Error(`Unsafe OGP route write rejected for OID ${write.oid}`)
  }
}

export function parseCatalogElement(
  oid: string,
  index: number,
  value: unknown,
): OgpRouterLabel {
  if (oid !== 'params.basicsources' && oid !== 'params.basicdests') {
    throw new Error(`Unsupported catalog OID ${String(oid)}`)
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > 65_535) {
    throw new RangeError('Catalog index must be from 0 to 65535')
  }
  const row = objectValue(value, `${oid}[${String(index)}]`)
  if (row.id !== index) {
    throw new Error(`${oid}[${String(index)}] id does not match its requested index`)
  }
  if (typeof row.name !== 'string') {
    throw new Error(`${oid}[${String(index)}] name must be a string`)
  }
  return Object.freeze({
    address: index + 1,
    label: row.name,
    description: normalizedDescription(row.description),
  })
}

export function parseLevels(value: unknown, limit: number): readonly OgpLevel[] {
  positiveInteger(limit, 'level limit', 256)
  if (!Array.isArray(value)) throw new Error('OGP levels value must be an array')
  return Object.freeze(
    value.slice(0, limit).map((entry, index) => {
      const row = objectValue(entry, `params.levels[${String(index)}]`)
      if (row.id !== index)
        throw new Error(`OGP level id does not match index ${String(index)}`)
      if (typeof row.name !== 'string') {
        throw new Error(`OGP level ${String(index)} name must be a string`)
      }
      return Object.freeze({ level: index + 1, label: row.name })
    }),
  )
}

function normalizeRawSource(raw: unknown, sourceLimit: number): number | null {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > 65_536) {
    throw new Error(`Invalid OGP inputstatus value ${String(raw)}`)
  }
  if (raw === 65_536 || (raw as number) >= sourceLimit) return null
  return (raw as number) + 1
}

export function parseDestinationStatus(
  destinationIndex: number,
  value: unknown,
  limits: OgpRouteLimits,
): readonly OgpCrosspoint[] {
  positiveInteger(limits.levels, 'levels', 256)
  positiveInteger(limits.sourceLimit, 'sourceLimit', 65_536)
  positiveInteger(limits.destinationLimit, 'destinationLimit', 65_536)
  if (
    !Number.isSafeInteger(destinationIndex) ||
    destinationIndex < 0 ||
    destinationIndex >= limits.destinationLimit
  ) {
    return Object.freeze([])
  }
  const row = objectValue(value, `params.statusByDestination[${String(destinationIndex)}]`)
  if (!Array.isArray(row.inputstatus)) {
    throw new Error('OGP destination status inputstatus must be an array')
  }
  if (row.inputstatus.length < limits.levels) {
    throw new Error(
      `OGP destination status inputstatus must contain at least ${String(limits.levels)} levels`,
    )
  }
  const crosspoints = row.inputstatus.slice(0, limits.levels).map((source, levelIndex) =>
    Object.freeze({
      destination: destinationIndex + 1,
      level: levelIndex + 1,
      source: normalizeRawSource(source, limits.sourceLimit),
    }),
  )
  return Object.freeze(crosspoints)
}

export function parseRouteOid(oid: string): number | null {
  const match = /^params\.statusByDestination\.(0|[1-9]\d*)\.inputstatus$/u.exec(oid)
  if (match === null) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index <= 65_535 ? index : null
}

export function parseRouteValue(
  payload: OgpValuePayload,
  limits: OgpRouteLimits,
): readonly OgpCrosspoint[] | null {
  const nestedDestination = parseRouteOid(payload.oid)
  if (nestedDestination !== null) {
    if (payload.element === true) {
      if (
        !Number.isSafeInteger(payload.index) ||
        (payload.index ?? -1) < 0 ||
        (payload.index ?? limits.levels) >= limits.levels ||
        nestedDestination >= limits.destinationLimit
      ) {
        return Object.freeze([])
      }
      return Object.freeze([
        Object.freeze({
          destination: nestedDestination + 1,
          level: (payload.index as number) + 1,
          source: normalizeRawSource(payload.value, limits.sourceLimit),
        }),
      ])
    }
    if (!Array.isArray(payload.value)) {
      throw new Error('OGP nested inputstatus value must be an array')
    }
    return parseDestinationStatus(nestedDestination, { inputstatus: payload.value }, limits)
  }
  if (payload.oid !== ROUTE_STATUS_OID) return null
  if (payload.element === true) {
    if (!Number.isSafeInteger(payload.index) || (payload.index ?? -1) < 0) {
      throw new Error('OGP status row update requires a non-negative destination index')
    }
    return parseDestinationStatus(payload.index as number, payload.value, limits)
  }
  if (!Array.isArray(payload.value)) {
    throw new Error('OGP parent status update must be an array')
  }
  return Object.freeze(
    payload.value
      .slice(0, limits.destinationLimit)
      .flatMap((row, index) => parseDestinationStatus(index, row, limits)),
  )
}

export function validateDeviceParameterDescriptors(
  paramsValue: unknown,
): ValidatedDeviceParameters {
  const params = objectValue(paramsValue, 'OGP device params')
  const status = descriptor(
    params,
    '_d_params.statusByDestination',
    'params.statusByDestination',
  )
  if (status.type !== 'STRUCT_ARRAY') {
    throw new Error('params.statusByDestination must be STRUCT_ARRAY')
  }
  const constraint = objectValue(status.constraint, 'params.statusByDestination constraint')
  if (constraint.type !== 'STRUCT' || typeof constraint.templateoid !== 'string') {
    throw new Error('params.statusByDestination must reference a STRUCT template')
  }
  const template = descriptor(params, `_d_${constraint.templateoid}`, constraint.templateoid)
  if (template.type !== 'STRUCT') throw new Error('Status template must be STRUCT')
  const templateValue = objectValue(template.value, 'status template value')
  const inputStatus = objectValue(templateValue._d_inputstatus, 'status template inputstatus')
  if (inputStatus.type !== 'INT16_ARRAY') {
    throw new Error('Status template inputstatus must be INT16_ARRAY')
  }

  const controlReady = descriptor(params, CONTROL_READY_OID, CONTROL_READY_OID)
  if (controlReady.type !== 'INT16' || !Number.isSafeInteger(controlReady.value)) {
    throw new Error('params.controlready must be INT16')
  }
  const takeError = descriptor(params, TAKE_ERROR_OID, TAKE_ERROR_OID)
  if (takeError.type !== 'STRING' || typeof takeError.value !== 'string') {
    throw new Error('params.takeError must be STRING')
  }
  if (!Array.isArray(status.value)) {
    throw new Error('params.statusByDestination value must be an array')
  }
  const multiSetValue = params['multi-set-enabled'] ?? params.multiSetEnabled
  const result: {
    controlReady: boolean
    takeError: string
    statusRows: readonly unknown[]
    multiSetEnabled?: boolean
  } = {
    controlReady: controlReady.value !== 0,
    takeError: takeError.value,
    statusRows: Object.freeze([...status.value]),
  }
  if (typeof multiSetValue === 'boolean') result.multiSetEnabled = multiSetValue
  return Object.freeze(result)
}
