import { z } from 'zod'
import { LiveGradeSelectSlotActionDefinitionSchema } from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'livegrade.select-slot': LiveGradeSelectSlotActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = LiveGradeSelectSlotActionDefinitionSchema
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
