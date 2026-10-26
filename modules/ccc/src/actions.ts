import { z } from 'zod'
import { CccActionSchema } from './schema/ccc.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'ccc.command': CccActionSchema,
} as const
export const ActionDefinitionSchema = CccActionSchema
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
