export { ActionDefinitionSchema, type ActionDefinition } from './actions.js'
export * from './schema/button-interactions.js'
export * from './schema/connections.js'
export * from './schema/primitives.js'
export * from './schema/tsl.js'
import { z } from 'zod'
import { TslConnectionDefinitionSchema } from './schema/connections.js'
export const ConnectionDefinitionSchema = TslConnectionDefinitionSchema
export const ConnectionDefinitionsSchema = z.array(ConnectionDefinitionSchema)
export type ConnectionDefinition = z.infer<typeof ConnectionDefinitionSchema>
