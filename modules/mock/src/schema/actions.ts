import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { SafeIdentifierSchema, SafeOperatorMessageSchema } from './primitives.js'

export const MockActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('mock'),
    enabled: z.boolean(),
    delayMs: z.int().min(0).max(4_000),
    outcome: z.enum(['success', 'failure']),
    failureMessage: SafeOperatorMessageSchema.optional(),
  })
  .superRefine((action, context) => {
    if (action.outcome === 'failure' && action.failureMessage === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['failureMessage'],
        message: 'failureMessage is required when outcome is failure',
      })
    }
    if (action.outcome === 'success' && action.failureMessage !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['failureMessage'],
        message: 'failureMessage is not allowed when outcome is success',
      })
    }
  })
  .readonly()

export type MockActionDefinition = z.infer<typeof MockActionDefinitionSchema>
