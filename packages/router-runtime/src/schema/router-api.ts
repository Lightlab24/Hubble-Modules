import { z } from 'zod'
import { ConnectionIdSchema } from './primitives.js'

export const MAX_ROUTER_TAKE_MAPPINGS = 256

export const MAX_ROUTER_TAKE_CROSSPOINTS = 4_096

export const MAX_ROUTER_COMMAND_TARGETS = MAX_ROUTER_TAKE_CROSSPOINTS

export const MAX_ROUTER_INTERROGATE_DESTINATIONS = 256

const MAX_ROUTER_ADDRESS = 65_536

const MAX_ROUTER_LEVEL = 256

export const RouterGenerationSchema = z.uuid().brand<'RouterGeneration'>()

export const RouterOperationIdSchema = z.uuid().brand<'RouterOperationId'>()

export const RouterMappingIdSchema = z.uuid().brand<'RouterMappingId'>()

export const RouterInterrogationRequestIdSchema = z
  .uuid()
  .brand<'RouterInterrogationRequestId'>()

export const RouterAddressSchema = z.int().min(1).max(MAX_ROUTER_ADDRESS)

export const RouterLevelSchema = z.int().min(1).max(MAX_ROUTER_LEVEL)

export const RouterRevisionSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const RouterRouteVersionSchema = z
  .strictObject({
    generation: RouterGenerationSchema,
    revision: RouterRevisionSchema,
  })
  .readonly()

const RouterRequiredLevelsSchema = z
  .array(RouterLevelSchema)
  .min(1)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((levels, context) => {
    rejectNonAscendingNumbers(levels, context, [], 'router levels')
  })
  .readonly()

export const RouterExpectedSourceSchema = z
  .strictObject({
    level: RouterLevelSchema,
    source: RouterAddressSchema,
  })
  .readonly()

const RouterExpectedSourcesSchema = z
  .array(RouterExpectedSourceSchema)
  .min(1)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((expected, context) => {
    rejectNonAscendingNumbers(
      expected.map(({ level }) => level),
      context,
      [],
      'expected-source levels',
    )
  })
  .readonly()

export const RouteCrosspointsMappingSchema = z
  .strictObject({
    mappingId: RouterMappingIdSchema,
    source: RouterAddressSchema,
    destination: RouterAddressSchema,
    levels: RouterRequiredLevelsSchema,
    expected: RouterExpectedSourcesSchema,
  })
  .superRefine((mapping, context) => {
    if (
      mapping.expected.length !== mapping.levels.length ||
      mapping.expected.some(({ level }, index) => level !== mapping.levels[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'expected sources must exactly match the ordered mapping levels',
        input: mapping.expected,
      })
    }
  })
  .readonly()

const RouteCrosspointsMappingsSchema = z
  .array(RouteCrosspointsMappingSchema)
  .min(1)
  .max(MAX_ROUTER_TAKE_MAPPINGS)
  .superRefine((mappings, context) => {
    const mappingIds = new Set<string>()
    const targets = new Set<string>()
    let expandedTargetCount = 0
    for (const [mappingIndex, mapping] of mappings.entries()) {
      if (mappingIds.has(mapping.mappingId)) {
        context.addIssue({
          code: 'custom',
          path: [mappingIndex, 'mappingId'],
          message: `duplicate router mapping ${mapping.mappingId}`,
          input: mapping.mappingId,
        })
      }
      mappingIds.add(mapping.mappingId)
      expandedTargetCount += mapping.levels.length
      mapping.levels.forEach((level, levelIndex) => {
        const key = crosspointKey(mapping.destination, level)
        if (targets.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [mappingIndex, 'levels', levelIndex],
            message: `duplicate router target ${key}`,
            input: level,
          })
        }
        targets.add(key)
      })
    }
    if (expandedTargetCount > MAX_ROUTER_COMMAND_TARGETS) {
      context.addIssue({
        code: 'custom',
        message: `router Take exceeds ${String(MAX_ROUTER_COMMAND_TARGETS)} crosspoints`,
        input: mappings,
      })
    }
  })
  .readonly()

export const RouteCrosspointsRequestSchema = z
  .strictObject({
    operationId: RouterOperationIdSchema,
    connectionId: ConnectionIdSchema,
    version: RouterRouteVersionSchema,
    mappings: RouteCrosspointsMappingsSchema,
  })
  .readonly()

export const InterrogateRouterTargetSchema = z
  .strictObject({
    destination: RouterAddressSchema,
    levels: RouterRequiredLevelsSchema,
  })
  .readonly()

const InterrogateRouterTargetsSchema = z
  .array(InterrogateRouterTargetSchema)
  .min(1)
  .max(MAX_ROUTER_INTERROGATE_DESTINATIONS)
  .superRefine((targets, context) => {
    const destinations = new Set<number>()
    let expandedTargetCount = 0
    for (const [index, target] of targets.entries()) {
      if (destinations.has(target.destination)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'destination'],
          message: `duplicate interrogation destination ${String(target.destination)}`,
          input: target.destination,
        })
      }
      destinations.add(target.destination)
      expandedTargetCount += target.levels.length
    }
    if (expandedTargetCount > MAX_ROUTER_COMMAND_TARGETS) {
      context.addIssue({
        code: 'custom',
        message: `router interrogation exceeds ${String(MAX_ROUTER_COMMAND_TARGETS)} crosspoints`,
        input: targets,
      })
    }
  })
  .readonly()

export const InterrogateRouterTargetsRequestSchema = z
  .strictObject({
    requestId: RouterInterrogationRequestIdSchema,
    connectionId: ConnectionIdSchema,
    generation: RouterGenerationSchema,
    targets: InterrogateRouterTargetsSchema,
  })
  .readonly()

function rejectNonAscendingNumbers(
  values: readonly number[],
  context: z.core.$RefinementCtx,
  pathPrefix: readonly (string | number)[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous !== undefined && current !== undefined && current <= previous) {
      context.addIssue({
        code: 'custom',
        path: [...pathPrefix, index],
        message: `${label} must be strictly ascending and unique`,
        input: current,
      })
    }
  }
}

function crosspointKey(destination: number, level: number): string {
  return `${String(destination)}:${String(level)}`
}
