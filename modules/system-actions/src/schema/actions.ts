import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  KeyboardApplicationBundleIdSchema,
  KeyboardBundleIdSchema,
  KeyboardKeySchema,
  KeyboardModifiersSchema,
  KeyboardTargetSchema,
  SystemMenuPathSourceSchema,
} from './keyboard.js'
import { ActionColumnIdSchema, ConnectionIdSchema, SafeIdentifierSchema } from './primitives.js'

export const KeyboardSendShortcutActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    connectionId: ConnectionIdSchema.nullable(),
    type: z.literal('keyboard.send-shortcut'),
    enabled: z.boolean(),
    target: KeyboardTargetSchema,
    applicationBundleId: KeyboardApplicationBundleIdSchema,
    key: KeyboardKeySchema,
    modifiers: KeyboardModifiersSchema,
  })
  .superRefine((action, context) => {
    if (action.target === 'application' && action.applicationBundleId === '') {
      context.addIssue({
        code: 'custom',
        path: ['applicationBundleId'],
        message: 'Choose an application for this keyboard shortcut',
      })
    }
  })
  .readonly()

export type KeyboardSendShortcutActionDefinition = z.infer<
  typeof KeyboardSendShortcutActionDefinitionSchema
>

const SystemApplicationActionShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: z.null(),
  enabled: z.boolean(),
  applicationBundleId: KeyboardBundleIdSchema,
} as const

export const SystemActivateApplicationActionSchema = z
  .strictObject({
    ...SystemApplicationActionShape,
    type: z.literal('system.activate-application'),
  })
  .readonly()

export const SystemOpenApplicationActionSchema = z
  .strictObject({
    ...SystemApplicationActionShape,
    type: z.literal('system.open-application'),
  })
  .readonly()

export const SystemSelectMenuItemActionSchema = z
  .strictObject({
    ...SystemApplicationActionShape,
    type: z.literal('system.select-menu-item'),
    menuPath: SystemMenuPathSourceSchema,
  })
  .readonly()

export type SystemActionDefinition =
  | KeyboardSendShortcutActionDefinition
  | z.infer<typeof SystemActivateApplicationActionSchema>
  | z.infer<typeof SystemOpenApplicationActionSchema>
  | z.infer<typeof SystemSelectMenuItemActionSchema>
