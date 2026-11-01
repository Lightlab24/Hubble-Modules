import { z } from 'zod'
import { matrixActionSchema } from '@hubble/module-runtime-helpers/matrix'
import {
  CyanViewStudioSelectFeedActionDefinitionSchema,
  CyanViewStudioSelectFeedIdActionDefinitionSchema,
  CyanViewStudioSelectFeedNumberActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const legacyActionSchemas = {
  'cyanview-studio.select-feed': CyanViewStudioSelectFeedActionDefinitionSchema,
  'cyanview-studio.select-feed-id': CyanViewStudioSelectFeedIdActionDefinitionSchema,
  'cyanview-studio.select-feed-number': CyanViewStudioSelectFeedNumberActionDefinitionSchema,
} as const
export const actionSchemas = { ...legacyActionSchemas, matrix: matrixActionSchema }
export const ActionDefinitionSchema = z.union([
  CyanViewStudioSelectFeedActionDefinitionSchema,
  CyanViewStudioSelectFeedIdActionDefinitionSchema,
  CyanViewStudioSelectFeedNumberActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
