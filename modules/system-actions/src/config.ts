export { ActionDefinitionSchema, type ActionDefinition } from './actions.js'
export * from './schema/actions.js'
export * from './schema/button-interactions.js'
export * from './schema/connections.js'
export * from './schema/keyboard.js'
export * from './schema/primitives.js'
import { z } from 'zod'
import { KeyboardConnectionDefinitionSchema } from './schema/connections.js'
export const ConnectionDefinitionSchema = KeyboardConnectionDefinitionSchema
export const ConnectionDefinitionsSchema = z.array(ConnectionDefinitionSchema)
export type ConnectionDefinition = z.infer<typeof ConnectionDefinitionSchema>
