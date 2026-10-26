import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  ActionColumnIdSchema,
  ConnectionIdSchema,
  RgbHexSchema,
  RossActionGroupIdSchema,
  SafeIdentifierSchema,
  WorkspaceModuleConnectionIdSchema,
} from './primitives.js'
import {
  RossSelectDestinationCycleSchema,
  RossSelectDestinationFeedbackColorsSchema,
} from './ross-destination-switch.js'

const DEFAULT_FEEDBACK_COLOR = RgbHexSchema.parse('#37A65B')

const RossAddressSchema = z.int().min(1).max(65_536)

const BlackmagicVideohubActionCommonShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  moduleConnectionId: WorkspaceModuleConnectionIdSchema,
  enabled: z.boolean(),
} as const

export const BlackmagicVideohubSelectSourceActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.select-source'),
    groupId: RossActionGroupIdSchema.nullable(),
    source: RossAddressSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const BlackmagicVideohubSelectDestinationActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.select-destination'),
    groupId: RossActionGroupIdSchema.nullable(),
    destination: RossAddressSchema,
    destinations: RossSelectDestinationCycleSchema.optional(),
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
    feedbackColors: RossSelectDestinationFeedbackColorsSchema.optional(),
  })
  .superRefine((action, context) => {
    const hasDestinations = action.destinations !== undefined
    const hasFeedbackColors = action.feedbackColors !== undefined
    if (hasDestinations !== hasFeedbackColors) {
      context.addIssue({
        code: 'custom',
        path: hasDestinations ? ['feedbackColors'] : ['destinations'],
        message:
          'Select DST cycle destinations and feedback colors must be configured together',
      })
      return
    }
    if (action.destinations === undefined || action.feedbackColors === undefined) return
    if (action.destination !== action.destinations[0]) {
      context.addIssue({
        code: 'custom',
        path: ['destination'],
        message: 'Select DST legacy destination must match the first cycle destination',
        input: action.destination,
      })
    }
    if (action.feedbackColor !== action.feedbackColors[0]) {
      context.addIssue({
        code: 'custom',
        path: ['feedbackColor'],
        message: 'Select DST legacy feedback color must match the first cycle feedback color',
        input: action.feedbackColor,
      })
    }
    if (action.destinations.length !== action.feedbackColors.length) {
      context.addIssue({
        code: 'custom',
        path: ['feedbackColors'],
        message: 'Select DST cycle destinations and feedback colors must have equal lengths',
        input: action.feedbackColors,
      })
    }
  })
  .readonly()

export const BlackmagicVideohubTakeActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.take'),
    groupId: RossActionGroupIdSchema.nullable(),
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const BlackmagicVideohubToggleGroupEnabledActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.toggle-group-enabled'),
    groupId: RossActionGroupIdSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema,
    feedbackInactiveColor: RgbHexSchema.nullable().default(null),
  })
  .readonly()

export const BlackmagicVideohubDirectRouteActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.direct-route'),
    source: RossAddressSchema,
    destination: RossAddressSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const BlackmagicVideohubRefreshNamesActionDefinitionSchema = z
  .strictObject({
    ...BlackmagicVideohubActionCommonShape,
    type: z.literal('blackmagic-videohub.refresh-names'),
  })
  .readonly()
