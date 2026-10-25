export { ActionDefinitionSchema, type ActionDefinition } from './actions.js'
export * from './schema/actions.js'
export * from './schema/button-interactions.js'
export * from './schema/connections.js'
export * from './schema/primitives.js'
export * from './schema/ross-destination-switch.js'
import { z } from 'zod'
import { EvertzQuartzConnectionDefinitionSchema } from './schema/connections.js'
export const ConnectionDefinitionSchema = EvertzQuartzConnectionDefinitionSchema
export const ConnectionDefinitionsSchema = z.array(ConnectionDefinitionSchema)
export type ConnectionDefinition = z.infer<typeof ConnectionDefinitionSchema>
