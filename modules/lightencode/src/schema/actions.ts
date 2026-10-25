import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  ActionColumnIdSchema,
  ConnectionIdSchema,
  RgbHexSchema,
  SafeIdentifierSchema,
} from './primitives.js'

const DEFAULT_FEEDBACK_COLOR = RgbHexSchema.parse('#37A65B')

export const LightEncodeSlotNumberSchema = z.int().min(1).max(999)

export const LightEncodeTimerMinutesSchema = z.int().min(0).max(1_440)

const LightEncodeActionCommonShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  enabled: z.boolean(),
  drivesTally: z.boolean(),
  feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
} as const

export const LightEncodeRecordToggleAllActionDefinitionSchema = z
  .strictObject({
    ...LightEncodeActionCommonShape,
    type: z.literal('lightencode.record-toggle-all'),
  })
  .readonly()

export const LightEncodeRecordToggleSlotActionDefinitionSchema = z
  .strictObject({
    ...LightEncodeActionCommonShape,
    type: z.literal('lightencode.record-toggle-slot'),
    slotNumber: LightEncodeSlotNumberSchema,
  })
  .readonly()

export const LightEncodeTimerToggleActionDefinitionSchema = z
  .strictObject({
    ...LightEncodeActionCommonShape,
    type: z.literal('lightencode.timer-toggle'),
  })
  .readonly()

export const LightEncodeTimerSetMinutesActionDefinitionSchema = z
  .strictObject({
    ...LightEncodeActionCommonShape,
    type: z.literal('lightencode.timer-set-minutes'),
    minutes: LightEncodeTimerMinutesSchema,
  })
  .readonly()

export type LightEncodeRecordToggleAllActionDefinition = z.infer<
  typeof LightEncodeRecordToggleAllActionDefinitionSchema
>

export type LightEncodeRecordToggleSlotActionDefinition = z.infer<
  typeof LightEncodeRecordToggleSlotActionDefinitionSchema
>

export type LightEncodeTimerToggleActionDefinition = z.infer<
  typeof LightEncodeTimerToggleActionDefinitionSchema
>

export type LightEncodeTimerSetMinutesActionDefinition = z.infer<
  typeof LightEncodeTimerSetMinutesActionDefinitionSchema
>

export type LightEncodeActionDefinition =
  | LightEncodeRecordToggleAllActionDefinition
  | LightEncodeRecordToggleSlotActionDefinition
  | LightEncodeTimerToggleActionDefinition
  | LightEncodeTimerSetMinutesActionDefinition
