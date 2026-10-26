import { z } from 'zod'
import {
  BlackmagicVideohubDirectRouteActionDefinitionSchema,
  BlackmagicVideohubRefreshNamesActionDefinitionSchema,
  BlackmagicVideohubSelectDestinationActionDefinitionSchema,
  BlackmagicVideohubSelectSourceActionDefinitionSchema,
  BlackmagicVideohubTakeActionDefinitionSchema,
  BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'blackmagic-videohub.select-source': BlackmagicVideohubSelectSourceActionDefinitionSchema,
  'blackmagic-videohub.select-destination':
    BlackmagicVideohubSelectDestinationActionDefinitionSchema,
  'blackmagic-videohub.take': BlackmagicVideohubTakeActionDefinitionSchema,
  'blackmagic-videohub.toggle-group-enabled':
    BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema,
  'blackmagic-videohub.direct-route': BlackmagicVideohubDirectRouteActionDefinitionSchema,
  'blackmagic-videohub.refresh-names': BlackmagicVideohubRefreshNamesActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  BlackmagicVideohubSelectSourceActionDefinitionSchema,
  BlackmagicVideohubSelectDestinationActionDefinitionSchema,
  BlackmagicVideohubTakeActionDefinitionSchema,
  BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema,
  BlackmagicVideohubDirectRouteActionDefinitionSchema,
  BlackmagicVideohubRefreshNamesActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
