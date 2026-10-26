import { z } from 'zod'
import {
  RossDirectRouteActionDefinitionSchema,
  RossRefreshNamesActionDefinitionSchema,
  RossSelectDestinationActionDefinitionSchema,
  RossSelectSourceActionDefinitionSchema,
  RossTakeActionDefinitionSchema,
  RossToggleGroupEnabledActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'ross-swp08.select-source': RossSelectSourceActionDefinitionSchema,
  'ross-swp08.select-destination': RossSelectDestinationActionDefinitionSchema,
  'ross-swp08.take': RossTakeActionDefinitionSchema,
  'ross-swp08.toggle-group-enabled': RossToggleGroupEnabledActionDefinitionSchema,
  'ross-swp08.direct-route': RossDirectRouteActionDefinitionSchema,
  'ross-swp08.refresh-names': RossRefreshNamesActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  RossSelectSourceActionDefinitionSchema,
  RossSelectDestinationActionDefinitionSchema,
  RossTakeActionDefinitionSchema,
  RossToggleGroupEnabledActionDefinitionSchema,
  RossDirectRouteActionDefinitionSchema,
  RossRefreshNamesActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
