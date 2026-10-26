import { z } from 'zod'

/** Set only after verification against a trusted signed catalog, never inferred from version text. */
export const VerifiedModuleReleaseSchema = z.strictObject({
  channel: z.enum(['stable', 'beta']),
  publishedAt: z.iso.datetime(),
  catalogSequence: z.int().nonnegative(),
  verifiedAt: z.iso.datetime(),
})
export type VerifiedModuleRelease = z.infer<typeof VerifiedModuleReleaseSchema>
