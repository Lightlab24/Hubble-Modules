import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { ActionColumnIdSchema, ConnectionIdSchema, SafeIdentifierSchema } from './primitives.js'

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const CyanViewStudioCameraIdSchema = z
  .string()
  .trim()
  .refine(
    (value) => utf8ByteLength(value) >= 1 && utf8ByteLength(value) <= 64,
    'CyanView Studio Camera ID must contain 1..64 UTF-8 bytes after trimming',
  )

export const CyanViewStudioFeedNumberSchema = z.int().min(1)

export const CyanViewStudioFeedIdSchema = z.int()

export const CyanViewStudioSelectFeedActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('cyanview-studio.select-feed'),
    connectionId: ConnectionIdSchema,
    enabled: z.literal(true),
    cameraId: CyanViewStudioCameraIdSchema,
  })
  .readonly()

export const CyanViewStudioSelectFeedNumberActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('cyanview-studio.select-feed-number'),
    connectionId: ConnectionIdSchema,
    enabled: z.literal(true),
    feedNumber: CyanViewStudioFeedNumberSchema,
  })
  .readonly()

export const CyanViewStudioSelectFeedIdActionDefinitionSchema = z
  .strictObject({
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    type: z.literal('cyanview-studio.select-feed-id'),
    connectionId: ConnectionIdSchema,
    enabled: z.literal(true),
    feedId: CyanViewStudioFeedIdSchema,
  })
  .readonly()

export type CyanViewStudioSelectFeedActionDefinition = z.infer<
  typeof CyanViewStudioSelectFeedActionDefinitionSchema
>

export type CyanViewStudioSelectFeedNumberActionDefinition = z.infer<
  typeof CyanViewStudioSelectFeedNumberActionDefinitionSchema
>

export type CyanViewStudioSelectFeedIdActionDefinition = z.infer<
  typeof CyanViewStudioSelectFeedIdActionDefinitionSchema
>
