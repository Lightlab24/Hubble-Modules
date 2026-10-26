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

const RossActionCommonShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  moduleConnectionId: WorkspaceModuleConnectionIdSchema,
  enabled: z.boolean(),
} as const

const RossLevelsSchema = z.array(z.int().min(1).max(256)).max(256).readonly()

const RossAddressSchema = z.int().min(1).max(65_536)

export const RossSelectSourceActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.select-source'),
    groupId: RossActionGroupIdSchema.nullable(),
    source: RossAddressSchema,
    levels: RossLevelsSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const RossSelectDestinationActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.select-destination'),
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

export const RossTakeActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.take'),
    groupId: RossActionGroupIdSchema.nullable(),
    levels: RossLevelsSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const RossToggleGroupEnabledActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.toggle-group-enabled'),
    groupId: RossActionGroupIdSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema,
    feedbackInactiveColor: RgbHexSchema.nullable().default(null),
  })
  .readonly()

export const RossDirectRouteActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.direct-route'),
    source: RossAddressSchema,
    destination: RossAddressSchema,
    levels: RossLevelsSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const RossRefreshNamesActionDefinitionSchema = z
  .strictObject({
    ...RossActionCommonShape,
    type: z.literal('ross-swp08.refresh-names'),
  })
  .readonly()
