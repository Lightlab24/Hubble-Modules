import { z } from 'zod'
import {
  AjaKumoDirectRouteActionDefinitionSchema,
  AjaKumoRecallSalvoActionDefinitionSchema,
  AjaKumoRefreshNamesActionDefinitionSchema,
  AjaKumoSelectDestinationActionDefinitionSchema,
  AjaKumoSelectSourceActionDefinitionSchema,
  AjaKumoTakeActionDefinitionSchema,
  AjaKumoToggleGroupEnabledActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'aja-kumo.select-source': AjaKumoSelectSourceActionDefinitionSchema,
  'aja-kumo.select-destination': AjaKumoSelectDestinationActionDefinitionSchema,
  'aja-kumo.take': AjaKumoTakeActionDefinitionSchema,
  'aja-kumo.toggle-group-enabled': AjaKumoToggleGroupEnabledActionDefinitionSchema,
  'aja-kumo.direct-route': AjaKumoDirectRouteActionDefinitionSchema,
  'aja-kumo.refresh-names': AjaKumoRefreshNamesActionDefinitionSchema,
  'aja-kumo.recall-salvo': AjaKumoRecallSalvoActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  AjaKumoSelectSourceActionDefinitionSchema,
  AjaKumoSelectDestinationActionDefinitionSchema,
  AjaKumoTakeActionDefinitionSchema,
  AjaKumoToggleGroupEnabledActionDefinitionSchema,
  AjaKumoDirectRouteActionDefinitionSchema,
  AjaKumoRefreshNamesActionDefinitionSchema,
  AjaKumoRecallSalvoActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
