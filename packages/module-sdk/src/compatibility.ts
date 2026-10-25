import { z } from 'zod'
import { ModuleVersionSchema } from './identity.js'

const FeatureSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
const FeaturesSchema = z
  .array(FeatureSchema)
  .max(128)
  .refine((features) => new Set(features).size === features.length, 'Duplicate host feature')

/** Requirements are independent of permissions and of the author's SDK/tool version. */
export const ModuleHostRequirementsSchema = z.union([
  z.strictObject({
    minimumVersion: ModuleVersionSchema,
    requiredFeatures: FeaturesSchema.optional(),
  }),
  // Existing immutable archives retain their explicitly declared range.
  z
    .strictObject({ minMajor: z.int().min(2), maxMajor: z.int().min(2) })
    .refine(({ minMajor, maxMajor }) => minMajor <= maxMajor, 'Invalid host range'),
])
export const ModuleHostDescriptorSchema = z.strictObject({
  version: ModuleVersionSchema,
  apiVersions: z
    .array(z.int().positive())
    .min(1)
    .max(16)
    .refine((versions) => new Set(versions).size === versions.length, 'Duplicate module API'),
  features: FeaturesSchema,
})
export type ModuleHostRequirements = z.infer<typeof ModuleHostRequirementsSchema>
export type ModuleHostDescriptor = z.infer<typeof ModuleHostDescriptorSchema>
export interface ModuleCompatibilityRequirements {
  readonly apiVersion: number
  readonly host: ModuleHostRequirements
}

/** Compatibility default for API-1 tools/tests; the application supplies its own descriptor. */
export const BASELINE_MODULE_HOST: ModuleHostDescriptor = {
  version: '2.0.0',
  apiVersions: [1],
  features: [],
}

/** SemVer ordering, including numeric prerelease identifiers (never lexical version ordering). */
export function compareModuleVersions(left: string, right: string): number {
  const a = ModuleVersionSchema.parse(left).split('-'),
    b = ModuleVersionSchema.parse(right).split('-')
  const coreA = (a[0] ?? '').split('.'),
    coreB = (b[0] ?? '').split('.')
  for (let i = 0; i < 3; i++) {
    const x = BigInt(coreA[i] ?? '0'),
      y = BigInt(coreB[i] ?? '0')
    if (x !== y) return x < y ? -1 : 1
  }
  const preA = left.slice((a[0] ?? '').length + 1),
    preB = right.slice((b[0] ?? '').length + 1)
  if (!preA || !preB) return preA === preB ? 0 : preA ? -1 : 1
  const partsA = preA.split('.'),
    partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i],
      y = partsB[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/u.test(x),
      ny = /^\d+$/u.test(y)
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function moduleCompatibility(
  manifest: ModuleCompatibilityRequirements,
  host: ModuleHostDescriptor,
): string | null
/** @deprecated Supply the full host descriptor so minor versions/features are checked. */
export function moduleCompatibility(
  manifest: ModuleCompatibilityRequirements,
  hostMajor: number,
  apiVersion: number,
): string | null
export function moduleCompatibility(
  manifest: ModuleCompatibilityRequirements,
  descriptor: ModuleHostDescriptor | number,
  apiVersion?: number,
): string | null {
  const host =
    typeof descriptor === 'number'
      ? { version: `${String(descriptor)}.0.0`, apiVersions: [apiVersion ?? 1], features: [] }
      : ModuleHostDescriptorSchema.parse(descriptor)
  if (!host.apiVersions.includes(manifest.apiVersion))
    return `Requires module API ${String(manifest.apiVersion)}`
  if ('minimumVersion' in manifest.host) {
    if (compareModuleVersions(host.version, manifest.host.minimumVersion) < 0)
      return `Requires Hubble ${manifest.host.minimumVersion} or later`
    const missing =
      manifest.host.requiredFeatures?.filter((feature) => !host.features.includes(feature)) ?? []
    return missing.length ? `Requires host features: ${missing.join(', ')}` : null
  }
  const major = Number(host.version.split('.')[0])
  if (major < manifest.host.minMajor || major > manifest.host.maxMajor)
    return `Requires Hubble major ${String(manifest.host.minMajor)}–${String(manifest.host.maxMajor)}`
  return null
}
