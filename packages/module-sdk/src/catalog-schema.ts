import { z } from 'zod'
import { ModulePackageIdentitySchema, ModuleVersionSchema } from './identity.js'
import { ModuleIdSchema, ModuleManifestSchema } from './index.js'

export const ModuleCatalogReleaseSchema = z
  .strictObject({
    identity: ModulePackageIdentitySchema,
    manifest: ModuleManifestSchema,
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      }, 'Expected an HTTPS download URL'),
    bytes: z
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    notes: z.string().max(16_384),
    channel: z.enum(['stable', 'beta']),
    publishedAt: z.iso.datetime(),
    status: z.enum(['active', 'deprecated', 'withdrawn']).default('active'),
    reason: z.string().max(1000).optional(),
  })
  .refine(
    (value) =>
      value.identity.moduleId === value.manifest.id &&
      value.identity.version === value.manifest.version,
    'Release identity does not match manifest',
  )
export const ModuleCatalogSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    sequence: z.int().nonnegative(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    releases: z.array(ModuleCatalogReleaseSchema).max(512),
  })
  .superRefine((catalog, ctx) => {
    if (new Date(catalog.expiresAt) <= new Date(catalog.issuedAt))
      ctx.addIssue({ code: 'custom', message: 'Invalid catalog lifetime' })
    const keys = catalog.releases.map(
      (item) => `${item.identity.moduleId}@${item.identity.version}`,
    )
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Official module versions must be immutable' })
  })
/** Discovery knows a stable envelope, without assuming it can execute every future manifest. */
export const ModuleDiscoveryManifestSchema = z
  .looseObject({
    formatVersion: z.int().positive(),
    id: ModuleIdSchema,
    name: z.string().trim().min(1).max(160),
    version: ModuleVersionSchema,
    apiVersion: z.int().positive(),
  })
  .catchall(z.json())
export const ModuleDiscoveryReleaseSchema = z
  .strictObject({
    ...ModuleCatalogReleaseSchema.shape,
    manifest: ModuleDiscoveryManifestSchema,
  })
  .refine(
    (value) =>
      value.identity.moduleId === value.manifest.id &&
      value.identity.version === value.manifest.version,
    'Release identity does not match manifest',
  )
export const ModuleDiscoveryCatalogSchema = z
  .strictObject({
    formatVersion: z.literal(2),
    sequence: z.int().nonnegative(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    releases: z.array(ModuleDiscoveryReleaseSchema).max(512),
  })
  .superRefine((catalog, ctx) => {
    if (new Date(catalog.expiresAt) <= new Date(catalog.issuedAt))
      ctx.addIssue({ code: 'custom', message: 'Invalid catalog lifetime' })
    const keys = catalog.releases.map(
      (item) => `${item.identity.moduleId}@${item.identity.version}`,
    )
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Official module versions must be immutable' })
  })
export const ModuleCatalogDocumentSchema = z.union([
  ModuleCatalogSchema,
  ModuleDiscoveryCatalogSchema,
])
export const UnsupportedModuleReleaseSchema = ModuleDiscoveryReleaseSchema.safeExtend({
  incompatibility: z.string().min(1).max(1000),
})
export const SignedModuleCatalogSchema = z.strictObject({
  formatVersion: z.literal(1),
  keyId: z.string().min(1).max(96),
  payload: z
    .string()
    .max(2_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  signature: z
    .string()
    .length(88)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
})
/** Durable admission proof for an automatic update already verified while the catalog was current. */
export const ModuleCatalogAdmissionSchema = z.strictObject({
  identity: ModulePackageIdentitySchema,
  admittedAt: z.iso.datetime(),
  envelope: SignedModuleCatalogSchema,
})
export type ModuleCatalogAdmission = z.infer<typeof ModuleCatalogAdmissionSchema>
export const ModuleCatalogStatusSchema = z.strictObject({
  configured: z.boolean(),
  checking: z.boolean(),
  lastSuccess: z.iso.datetime().nullable(),
  lastAttempt: z.iso.datetime().nullable(),
  nextCheck: z.iso.datetime().nullable(),
  error: z.string().max(1000).nullable(),
  releases: z.array(ModuleCatalogReleaseSchema).max(512),
  unsupportedReleases: z.array(UnsupportedModuleReleaseSchema).max(512).optional(),
})
export type ModuleCatalog = z.infer<typeof ModuleCatalogSchema>
export type ModuleCatalogDocument = z.infer<typeof ModuleCatalogDocumentSchema>
export type ModuleDiscoveryRelease = z.infer<typeof ModuleDiscoveryReleaseSchema>
export type UnsupportedModuleRelease = z.infer<typeof UnsupportedModuleReleaseSchema>
export type VerifiedModuleCatalog = Omit<ModuleCatalog, 'formatVersion'> & {
  readonly formatVersion: 1 | 2
  readonly unsupportedReleases: readonly UnsupportedModuleRelease[]
}
export type ModuleCatalogStatus = z.infer<typeof ModuleCatalogStatusSchema>

export const ModuleCatalogSourceSchema = z.strictObject({
  url: z.url().nullable(),
  keys: z.record(z.string().min(1).max(96), z.string().max(4096)),
})
