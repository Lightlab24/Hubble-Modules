import { z } from 'zod'
import { matrixActionSchema } from '@hubble/module-runtime-helpers/matrix'
import {
  CyanViewRcpRecordCameraActionDefinitionSchema,
  CyanViewRcpRecordGroupAllActionDefinitionSchema,
  CyanViewRcpSelectCameraActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const legacyActionSchemas = {
  'cyanview-rcp.select-camera': CyanViewRcpSelectCameraActionDefinitionSchema,
  'cyanview-rcp.record-camera': CyanViewRcpRecordCameraActionDefinitionSchema,
  'cyanview-rcp.record-group-all': CyanViewRcpRecordGroupAllActionDefinitionSchema,
  'cyanview-rcp.start-enabled-cameras': CyanViewRcpRecordGroupAllActionDefinitionSchema,
  'cyanview-rcp.stop-enabled-cameras': CyanViewRcpRecordGroupAllActionDefinitionSchema,
} as const
export const actionSchemas = { ...legacyActionSchemas, matrix: matrixActionSchema }
export const ActionDefinitionSchema = z.union([
  CyanViewRcpSelectCameraActionDefinitionSchema,
  CyanViewRcpRecordCameraActionDefinitionSchema,
  CyanViewRcpRecordGroupAllActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
