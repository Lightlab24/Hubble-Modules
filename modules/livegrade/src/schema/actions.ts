import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  LiveGradeApplicationSchema,
  LiveGradeSlotInputSchema,
  LiveGradeSlotPositionSchema,
} from './livegrade-slots.js'
import { ActionColumnIdSchema, ConnectionIdSchema, SafeIdentifierSchema } from './primitives.js'

export const LiveGradeSelectSlotActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('livegrade.select-slot'),
    application: LiveGradeApplicationSchema.optional(),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
    assignmentMode: z.enum(['auto-alphanumeric', 'manual']),
    sequence: LiveGradeSlotPositionSchema.nullable(),
    slotId: LiveGradeSlotInputSchema,
  })
  .superRefine((action, context) => {
    if (action.sequence === null && action.slotId.trim().length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['slotId'],
        message: 'a LiveGrade slot position or query is required',
      })
    }
  })
  .readonly()

export type LiveGradeSelectSlotActionDefinition = z.infer<
  typeof LiveGradeSelectSlotActionDefinitionSchema
>
