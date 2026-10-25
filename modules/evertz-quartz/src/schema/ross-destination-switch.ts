import { z } from 'zod'
import { RgbHexSchema } from './primitives.js'

export const MAX_ROSS_SELECT_DESTINATIONS = 5

export const ROSS_SELECT_DESTINATION_ADDRESS_MAX = 65_536

export const RossSelectDestinationAddressSchema = z
  .int()
  .min(1)
  .max(ROSS_SELECT_DESTINATION_ADDRESS_MAX)

function uniqueDestinationList(
  destinations: readonly number[],
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<number>()
  for (const [index, destination] of destinations.entries()) {
    if (seen.has(destination)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: `duplicate destination ${String(destination)}`,
        input: destination,
      })
    }
    seen.add(destination)
  }
}

export const RossSelectDestinationCycleSchema = z
  .array(RossSelectDestinationAddressSchema)
  .min(2)
  .max(MAX_ROSS_SELECT_DESTINATIONS)
  .superRefine(uniqueDestinationList)
  .readonly()

export const RossSelectDestinationFeedbackColorsSchema = z
  .array(RgbHexSchema)
  .min(2)
  .max(MAX_ROSS_SELECT_DESTINATIONS)
  .readonly()
