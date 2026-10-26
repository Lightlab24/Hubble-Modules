import { z } from 'zod'
import {
  LightEncodeRecordToggleAllActionDefinitionSchema,
  LightEncodeRecordToggleSlotActionDefinitionSchema,
  LightEncodeTimerSetMinutesActionDefinitionSchema,
  LightEncodeTimerToggleActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'lightencode.record-toggle-all': LightEncodeRecordToggleAllActionDefinitionSchema,
  'lightencode.record-toggle-slot': LightEncodeRecordToggleSlotActionDefinitionSchema,
  'lightencode.timer-toggle': LightEncodeTimerToggleActionDefinitionSchema,
  'lightencode.timer-set-minutes': LightEncodeTimerSetMinutesActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  LightEncodeRecordToggleAllActionDefinitionSchema,
  LightEncodeRecordToggleSlotActionDefinitionSchema,
  LightEncodeTimerToggleActionDefinitionSchema,
  LightEncodeTimerSetMinutesActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
