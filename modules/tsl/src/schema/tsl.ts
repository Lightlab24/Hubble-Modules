import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import {
  ActionColumnIdSchema,
  ConnectionIdSchema,
  RgbHexSchema,
  SafeIdentifierSchema,
} from './primitives.js'

export const TslProtocolSchema = z.enum(['3.1', '5.0'])

export const TslFollowModeSchema = z.enum(['follow', 'unfollow', 'toggle'])

export const TallySwitchFollowModeSchema = TslFollowModeSchema

export const TslAddressSchema = z.int().min(0).max(65534)

export const TslCycleMsSchema = z.int().min(500).max(10_000)

export const TslCycleOverrideSchema = z.union([z.literal(0), TslCycleMsSchema])

export const TslListenerSettingsSchema = z
  .strictObject({
    protocol: TslProtocolSchema.default('3.1'),
    transport: z.enum(['udp', 'tcp']).default('udp'),
    bindAddress: z.ipv4().default('0.0.0.0'),
    port: z.int().min(1).max(65535).default(9821),
    sourceAddress: z.union([z.literal(''), z.ipv4()]).default(''),
    staleAfterMs: z.union([z.literal(0), z.int().min(1000).max(3_600_000)]).default(0),
  })
  .readonly()

const commonAction = {
  actionId: SafeIdentifierSchema,
  actionColumnId: ActionColumnIdSchema,
  interaction: ButtonInteractionSchema,
  wrap: z.boolean().optional(),
  connectionId: ConnectionIdSchema,
  enabled: z.boolean(),
}

export const TslControlFeedbackSchema = z
  .strictObject({
    enabled: z.boolean(),
    activeColor: RgbHexSchema,
    inactiveColor: RgbHexSchema,
  })
  .readonly()

export const TslFeedbackActionSchema = z
  .strictObject({
    ...commonAction,
    type: z.literal('tsl.tally-feedback'),
    screen: TslAddressSchema,
    address: TslAddressSchema,
    cycleMs: TslCycleOverrideSchema,
  })
  .readonly()

export const TslSetIndicationActionSchema = z
  .strictObject({
    ...commonAction,
    type: z.literal('tsl.set-indication'),
    targetColumnId: ActionColumnIdSchema,
    indication: z.boolean(),
  })
  .readonly()

export const TslTallySwitchActionSchema = z
  .strictObject({
    ...commonAction,
    type: z.literal('tsl.tally-switch'),
    followMode: TallySwitchFollowModeSchema,
    glow: z.literal(true).optional(),
    feedback: TslControlFeedbackSchema.optional(),
  })
  .readonly()

export const TslFollowActionSchema = z
  .strictObject({
    ...commonAction,
    type: z.literal('tsl.follow'),
    followMode: TslFollowModeSchema,
    glow: z.literal(true).optional(),
    feedback: TslControlFeedbackSchema.optional(),
  })
  .readonly()
