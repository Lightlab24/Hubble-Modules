import { z } from 'zod'

export const LEGACY_BUTTON_INTERACTIONS = ['press', 'rotate-left', 'rotate-right'] as const

export const LONG_PRESS_INTERACTIONS = [
  'long-press-1s',
  'long-press-2s',
  'long-press-3s',
] as const

export const BUTTON_INTERACTIONS = [
  ...LEGACY_BUTTON_INTERACTIONS,
  ...LONG_PRESS_INTERACTIONS,
] as const

export const ButtonInteractionSchema = z.enum(BUTTON_INTERACTIONS)
