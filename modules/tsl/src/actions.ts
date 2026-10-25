import { z } from 'zod'
import {
  TslFeedbackActionSchema,
  TslFollowActionSchema,
  TslSetIndicationActionSchema,
  TslTallySwitchActionSchema,
} from './schema/tsl.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'tsl.tally-feedback': TslFeedbackActionSchema,
  'tsl.set-indication': TslSetIndicationActionSchema,
  'tsl.tally-switch': TslTallySwitchActionSchema,
  'tsl.follow': TslFollowActionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  TslFeedbackActionSchema,
  TslSetIndicationActionSchema,
  TslTallySwitchActionSchema,
  TslFollowActionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
