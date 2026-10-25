import { z } from 'zod'
import {
  DitBrowseCycleWorkspacesActionDefinitionSchema,
  DitBrowseFocusCameraActionDefinitionSchema,
  DitBrowseSetGridLockActionDefinitionSchema,
  DitBrowseShowGridActionDefinitionSchema,
  DitBrowseSwitchWorkspaceActionDefinitionSchema,
  DitBrowseToggleGridLockActionDefinitionSchema,
} from './schema/actions.js'

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  'dit-browse.focus-camera': DitBrowseFocusCameraActionDefinitionSchema,
  'dit-browse.switch-workspace': DitBrowseSwitchWorkspaceActionDefinitionSchema,
  'dit-browse.show-grid': DitBrowseShowGridActionDefinitionSchema,
  'dit-browse.cycle-workspaces': DitBrowseCycleWorkspacesActionDefinitionSchema,
  'dit-browse.set-grid-lock': DitBrowseSetGridLockActionDefinitionSchema,
  'dit-browse.toggle-grid-lock': DitBrowseToggleGridLockActionDefinitionSchema,
} as const
export const ActionDefinitionSchema = z.union([
  DitBrowseFocusCameraActionDefinitionSchema,
  DitBrowseSwitchWorkspaceActionDefinitionSchema,
  DitBrowseShowGridActionDefinitionSchema,
  DitBrowseCycleWorkspacesActionDefinitionSchema,
  DitBrowseSetGridLockActionDefinitionSchema,
  DitBrowseToggleGridLockActionDefinitionSchema,
])
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>
