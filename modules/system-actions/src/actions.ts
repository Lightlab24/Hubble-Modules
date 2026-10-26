import { z } from 'zod'
import {
  KeyboardSendShortcutActionDefinitionSchema,
  SystemActivateApplicationActionSchema,
  SystemOpenApplicationActionSchema,
  SystemSelectMenuItemActionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'keyboard.send-shortcut': KeyboardSendShortcutActionDefinitionSchema,
  'system.activate-application': SystemActivateApplicationActionSchema,
  'system.open-application': SystemOpenApplicationActionSchema,
  'system.select-menu-item': SystemSelectMenuItemActionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  KeyboardSendShortcutActionDefinitionSchema,
  SystemActivateApplicationActionSchema,
  SystemOpenApplicationActionSchema,
  SystemSelectMenuItemActionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
