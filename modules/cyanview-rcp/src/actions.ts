import { z } from 'zod'
import {
  CyanViewRcpRecordCameraActionDefinitionSchema,
  CyanViewRcpRecordGroupAllActionDefinitionSchema,
  CyanViewRcpSelectCameraActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'cyanview-rcp.select-camera': CyanViewRcpSelectCameraActionDefinitionSchema,
  'cyanview-rcp.record-camera': CyanViewRcpRecordCameraActionDefinitionSchema,
  'cyanview-rcp.record-group-all': CyanViewRcpRecordGroupAllActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  CyanViewRcpSelectCameraActionDefinitionSchema,
  CyanViewRcpRecordCameraActionDefinitionSchema,
  CyanViewRcpRecordGroupAllActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
