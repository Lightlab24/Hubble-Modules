import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { DitBrowseCameraNumberSchema, DitBrowseWorkspaceNumberSchema } from './connections.js'
import {
  ActionColumnIdSchema,
  ConnectionIdSchema,
  RgbHexSchema,
  SafeIdentifierSchema,
} from './primitives.js'

const DEFAULT_FEEDBACK_COLOR = RgbHexSchema.parse('#37A65B')

export const DitBrowseFocusCameraActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.focus-camera'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
    cameraNumber: DitBrowseCameraNumberSchema,
    drivesTally: z.boolean().default(false),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const DitBrowseShowGridActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.show-grid'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
  })
  .readonly()

export const DitBrowseCycleWorkspacesActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.cycle-workspaces'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
  })
  .readonly()

export const DitBrowseSwitchWorkspaceActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.switch-workspace'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
    workspaceNumber: DitBrowseWorkspaceNumberSchema,
    drivesTally: z.boolean().default(false),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const DitBrowseSetGridLockActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.set-grid-lock'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
    locked: z.boolean(),
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const DitBrowseToggleGridLockActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('dit-browse.toggle-grid-lock'),
    connectionId: ConnectionIdSchema,
    enabled: z.boolean(),
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
    feedbackInactiveColor: RgbHexSchema.nullable().default(null),
  })
  .readonly()

export type DitBrowseShowGridActionDefinition = z.infer<
  typeof DitBrowseShowGridActionDefinitionSchema
>

export type DitBrowseCycleWorkspacesActionDefinition = z.infer<
  typeof DitBrowseCycleWorkspacesActionDefinitionSchema
>

export type DitBrowseSwitchWorkspaceActionDefinition = z.infer<
  typeof DitBrowseSwitchWorkspaceActionDefinitionSchema
>

export type DitBrowseFocusCameraActionDefinition = z.infer<
  typeof DitBrowseFocusCameraActionDefinitionSchema
>

export type DitBrowseSetGridLockActionDefinition = z.infer<
  typeof DitBrowseSetGridLockActionDefinitionSchema
>

export type DitBrowseToggleGridLockActionDefinition = z.infer<
  typeof DitBrowseToggleGridLockActionDefinitionSchema
>
