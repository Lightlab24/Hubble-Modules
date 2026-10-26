import { z } from 'zod'
import { MockActionDefinitionSchema } from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  mock: MockActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = MockActionDefinitionSchema
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
