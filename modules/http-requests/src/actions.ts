import { z } from 'zod'
import {
  GenericHttpDeleteActionDefinitionSchema,
  GenericHttpGetActionDefinitionSchema,
  GenericHttpPatchActionDefinitionSchema,
  GenericHttpPostActionDefinitionSchema,
  GenericHttpPutActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  matrix: z.object({ type: z.literal('matrix'), values: z.record(z.string(), z.json()) }),
  'generic-http.get': GenericHttpGetActionDefinitionSchema,
  'generic-http.post': GenericHttpPostActionDefinitionSchema,
  'generic-http.put': GenericHttpPutActionDefinitionSchema,
  'generic-http.patch': GenericHttpPatchActionDefinitionSchema,
  'generic-http.delete': GenericHttpDeleteActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  GenericHttpGetActionDefinitionSchema,
  GenericHttpPostActionDefinitionSchema,
  GenericHttpPutActionDefinitionSchema,
  GenericHttpPatchActionDefinitionSchema,
  GenericHttpDeleteActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
