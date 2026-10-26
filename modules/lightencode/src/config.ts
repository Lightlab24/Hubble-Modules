export { ActionDefinitionSchema, type ActionDefinition } from './actions.js'
export * from './schema/actions.js'
export * from './schema/button-interactions.js'
export * from './schema/connections.js'
export * from './schema/primitives.js'
import { z } from 'zod'
import { LightEncodeConnectionDefinitionSchema } from './schema/connections.js'
export const ConnectionDefinitionSchema = LightEncodeConnectionDefinitionSchema
export const ConnectionDefinitionsSchema = z.array(ConnectionDefinitionSchema)
export type ConnectionDefinition = z.infer<typeof ConnectionDefinitionSchema>
