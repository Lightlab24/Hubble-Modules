import { z } from 'zod'
import {
  CyanViewStudioSelectFeedActionDefinitionSchema,
  CyanViewStudioSelectFeedIdActionDefinitionSchema,
  CyanViewStudioSelectFeedNumberActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'cyanview-studio.select-feed': CyanViewStudioSelectFeedActionDefinitionSchema,
  'cyanview-studio.select-feed-id': CyanViewStudioSelectFeedIdActionDefinitionSchema,
  'cyanview-studio.select-feed-number': CyanViewStudioSelectFeedNumberActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  CyanViewStudioSelectFeedActionDefinitionSchema,
  CyanViewStudioSelectFeedIdActionDefinitionSchema,
  CyanViewStudioSelectFeedNumberActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
