import { z } from 'zod'
import {
  KeyboardBundleIdSchema,
  KeyboardKeySchema,
  KeyboardModifierSchema,
  SystemMenuPathSchema,
} from './keyboard.js'

const SystemMenuCursorSchema = z
  .string()
  .max(41)
  .regex(
    /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}:(?:[1-9]\d{0,2}|[1-7]\d{3}|8000)$/,
  )

export const KeyboardBridgeRequestSchema = z
  .discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('list-applications') }),
    z.strictObject({
      operation: z.literal('list-menu-commands'),
      bundleId: KeyboardBundleIdSchema,
      cursor: SystemMenuCursorSchema.optional(),
    }),
    z.strictObject({
      operation: z.literal('select-menu-item'),
      bundleId: KeyboardBundleIdSchema,
      menuPath: SystemMenuPathSchema,
    }),
    z.strictObject({
      operation: z.literal('activate-application'),
      bundleId: KeyboardBundleIdSchema,
    }),
    z.strictObject({
      operation: z.literal('open-application'),
      bundleId: KeyboardBundleIdSchema,
    }),
    z.strictObject({
      operation: z.literal('send-shortcut'),
      key: KeyboardKeySchema,
      modifiers: z
        .array(KeyboardModifierSchema)
        .max(4)
        .refine((values) => new Set(values).size === values.length),
      target: z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('global') }),
        z.strictObject({ mode: z.literal('application'), bundleId: KeyboardBundleIdSchema }),
      ]),
    }),
  ])
  .readonly()

export const KeyboardBridgeResponseSchema = z
  .strictObject({
    available: z.boolean(),
    permissionGranted: z.boolean(),
    applications: z
      .array(
        z
          .strictObject({
            name: z.string().min(1).max(256),
            bundleId: KeyboardBundleIdSchema,
            pid: z.int().positive().nullable(),
          })
          .readonly(),
      )
      .max(256)
      .readonly(),
    installedApplications: z
      .array(
        z
          .strictObject({
            name: z.string().min(1).max(256),
            bundleId: KeyboardBundleIdSchema,
            pid: z.null(),
          })
          .readonly(),
      )
      .max(256)
      .readonly()
      .optional(),
    menuCommands: z
      .array(z.strictObject({ path: SystemMenuPathSchema, enabled: z.boolean() }).readonly())
      .max(1000)
      .readonly()
      .optional(),
    menuCommandsTruncated: z.boolean().optional(),
    menuCommandsNextCursor: SystemMenuCursorSchema.optional(),
    sent: z.boolean(),
    completed: z.boolean().optional(),
    errorCode: z
      .enum([
        'keyboard_permission_required',
        'keyboard_application_not_running',
        'keyboard_event_failed',
        'keyboard_unavailable',
        'system_application_not_found',
        'system_application_failed',
        'system_menu_unavailable',
        'system_menu_not_found',
        'system_menu_ambiguous',
        'system_menu_disabled',
        'system_menu_failed',
      ])
      .nullable(),
    message: z.string().max(512).nullable(),
  })
  .refine(
    (response) =>
      !response.sent ||
      (response.available && response.permissionGranted && response.errorCode === null),
    'Sent shortcuts require an available, authorized provider without an error',
  )
  .refine(
    (response) =>
      response.completed !== true || (response.available && response.errorCode === null),
    'Completed system actions require an available provider without an error',
  )
  .readonly()

export type KeyboardBridgeRequest = z.infer<typeof KeyboardBridgeRequestSchema>

export type KeyboardBridgeResponse = z.infer<typeof KeyboardBridgeResponseSchema>

export type KeyboardBridgeProvider = (
  request: KeyboardBridgeRequest,
) => Promise<KeyboardBridgeResponse>

export function unavailableKeyboardBridgeResponse(): KeyboardBridgeResponse {
  return {
    available: false,
    permissionGranted: false,
    applications: [],
    sent: false,
    errorCode: 'keyboard_unavailable',
    message: 'System actions require Hubble running on the service Mac.',
  }
}
