import { z } from 'zod'
import { matrixActionSchema } from '@hubble/module-runtime-helpers/matrix'
import {
  LightEncodeRecordToggleAllActionDefinitionSchema,
  LightEncodeRecordToggleSlotActionDefinitionSchema,
  LightEncodeTimerSetMinutesActionDefinitionSchema,
  LightEncodeTimerToggleActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const legacyActionSchemas = {
  'lightencode.record-toggle-all': LightEncodeRecordToggleAllActionDefinitionSchema,
  'lightencode.record-toggle-slot': LightEncodeRecordToggleSlotActionDefinitionSchema,
  'lightencode.timer-toggle': LightEncodeTimerToggleActionDefinitionSchema,
  'lightencode.timer-set-minutes': LightEncodeTimerSetMinutesActionDefinitionSchema,
} as const
export const actionSchemas = { ...legacyActionSchemas, matrix: matrixActionSchema }
export const ActionDefinitionSchema = z.union([
  LightEncodeRecordToggleAllActionDefinitionSchema,
  LightEncodeRecordToggleSlotActionDefinitionSchema,
  LightEncodeTimerToggleActionDefinitionSchema,
  LightEncodeTimerSetMinutesActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
