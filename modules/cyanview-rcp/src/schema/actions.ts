import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  ActionColumnIdSchema,
  ConnectionIdSchema,
  RgbHexSchema,
  SafeIdentifierSchema,
} from './primitives.js'

const DEFAULT_FEEDBACK_COLOR = RgbHexSchema.parse('#37A65B')

export const CyanViewRcpSelectCameraActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('cyanview-rcp.select-camera'),
    connectionId: ConnectionIdSchema,
    enabled: z.literal(true),
    cameraNumber: z.int().min(1).max(999_999),
    drivesTally: z.boolean().default(false),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const CyanViewRcpRecordCameraActionDefinitionSchema =
  CyanViewRcpSelectCameraActionDefinitionSchema.unwrap()
    .omit({ drivesTally: true, feedbackColor: true })
    .extend({ type: z.literal('cyanview-rcp.record-camera') })
    .readonly()

export const CyanViewRcpRecordGroupAllActionDefinitionSchema =
  CyanViewRcpSelectCameraActionDefinitionSchema.unwrap()
    .omit({ cameraNumber: true, drivesTally: true, feedbackColor: true })
    .extend({ type: z.literal('cyanview-rcp.record-group-all') })
    .readonly()

export type CyanViewRcpActionDefinition =
  | z.infer<typeof CyanViewRcpSelectCameraActionDefinitionSchema>
  | z.infer<typeof CyanViewRcpRecordCameraActionDefinitionSchema>
  | z.infer<typeof CyanViewRcpRecordGroupAllActionDefinitionSchema>
