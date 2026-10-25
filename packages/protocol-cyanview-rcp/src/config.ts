export * from './schema/connections.js'
export * from './schema/primitives.js'
import { z } from 'zod'
import { CyanViewRcpConnectionDefinitionSchema } from './schema/connections.js'
export const ConnectionDefinitionsSchema = z.array(CyanViewRcpConnectionDefinitionSchema)
export type ConnectionDefinition = z.infer<typeof CyanViewRcpConnectionDefinitionSchema>
