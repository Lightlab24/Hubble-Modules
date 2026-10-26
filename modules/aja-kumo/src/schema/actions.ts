import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { AjaKumoAddressSchema } from './connections.js'
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

const AjaKumoActionCommonShape = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  moduleConnectionId: WorkspaceModuleConnectionIdSchema,
  enabled: z.boolean(),
} as const

export const AjaKumoSelectSourceActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.select-source'),
    groupId: RossActionGroupIdSchema.nullable(),
    source: AjaKumoAddressSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const AjaKumoSelectDestinationActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.select-destination'),
    groupId: RossActionGroupIdSchema.nullable(),
    destination: AjaKumoAddressSchema,
    destinations: RossSelectDestinationCycleSchema.refine(
      (destinations) => destinations.every((destination) => destination <= 64),
      'KUMO destinations must be between 1 and 64',
    ).optional(),
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

export const AjaKumoTakeActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.take'),
    groupId: RossActionGroupIdSchema.nullable(),
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const AjaKumoToggleGroupEnabledActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.toggle-group-enabled'),
    groupId: RossActionGroupIdSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema,
    feedbackInactiveColor: RgbHexSchema.nullable().default(null),
  })
  .readonly()

export const AjaKumoDirectRouteActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.direct-route'),
    source: AjaKumoAddressSchema,
    destination: AjaKumoAddressSchema,
    drivesTally: z.boolean(),
    feedbackColor: RgbHexSchema.default(DEFAULT_FEEDBACK_COLOR),
  })
  .readonly()

export const AjaKumoRefreshNamesActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.refresh-names'),
  })
  .readonly()

export const AjaKumoSalvoNumberSchema = z.int().min(1).max(8)

export const AjaKumoRecallSalvoActionDefinitionSchema = z
  .strictObject({
    ...AjaKumoActionCommonShape,
    type: z.literal('aja-kumo.recall-salvo'),
    salvo: AjaKumoSalvoNumberSchema,
  })
  .readonly()

export type AjaKumoRecallSalvoActionDefinition = z.infer<
  typeof AjaKumoRecallSalvoActionDefinitionSchema
>

export type AjaKumoSelectSourceActionDefinition = z.infer<
  typeof AjaKumoSelectSourceActionDefinitionSchema
>

export type AjaKumoSelectDestinationActionDefinition = z.infer<
  typeof AjaKumoSelectDestinationActionDefinitionSchema
>

export type AjaKumoTakeActionDefinition = z.infer<typeof AjaKumoTakeActionDefinitionSchema>

export type AjaKumoToggleGroupEnabledActionDefinition = z.infer<
  typeof AjaKumoToggleGroupEnabledActionDefinitionSchema
>

export type AjaKumoDirectRouteActionDefinition = z.infer<
  typeof AjaKumoDirectRouteActionDefinitionSchema
>

export type AjaKumoRefreshNamesActionDefinition = z.infer<
  typeof AjaKumoRefreshNamesActionDefinitionSchema
>

export type AjaKumoActionDefinition =
  | AjaKumoSelectSourceActionDefinition
  | AjaKumoSelectDestinationActionDefinition
  | AjaKumoTakeActionDefinition
  | AjaKumoToggleGroupEnabledActionDefinition
  | AjaKumoDirectRouteActionDefinition
  | AjaKumoRefreshNamesActionDefinition
  | AjaKumoRecallSalvoActionDefinition
