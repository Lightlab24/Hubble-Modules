import { z } from "zod";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);

/** Saved connection IDs are unique only within their owning workspace. */
export const ModuleInstanceScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connection"),
    workspaceId: z.uuid(),
    connectionId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("host"),
    workspaceId: z.uuid(),
    capabilityId: IdentifierSchema,
  }),
]);
export type ModuleInstanceScope = z.infer<typeof ModuleInstanceScopeSchema>;

/** A storage/lock key, never a device address or a process-generation identifier. */
export function moduleInstanceKey(value: ModuleInstanceScope): string {
  const scope = ModuleInstanceScopeSchema.parse(value);
  return JSON.stringify([
    scope.kind,
    scope.workspaceId,
    scope.kind === "connection" ? scope.connectionId : scope.capabilityId,
  ]);
}

export const ModuleVersionSchema = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[a-zA-Z][a-zA-Z0-9-]*|0|[1-9]\d*)(?:\.(?:[a-zA-Z][a-zA-Z0-9-]*|0|[1-9]\d*))*)?$/u,
  );

export const ModulePackageIdentitySchema = z.strictObject({
  moduleId: z
    .string()
    .min(3)
    .max(96)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u),
  version: ModuleVersionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ModulePackageIdentity = z.infer<typeof ModulePackageIdentitySchema>;

export const ModuleSavedSettingsSchema = z
  .record(z.string().min(1).max(96), z.json())
  .refine(
    (value) => JSON.stringify(value).length <= 262_144,
    "Module settings exceed size limit",
  );

/** Portable selection and module-owned settings; local source paths and generations stay local. */
export const ModuleBindingSchema = z.strictObject({
  package: ModulePackageIdentitySchema,
  configVersion: z.int().min(1).max(65_535),
  savedActionVersion: z.int().min(1).max(65_535).optional(),
  pinned: z.boolean(),
  autoUpdate: z.enum(["inherit", "on", "off"]).optional(),
  settings: ModuleSavedSettingsSchema.optional(),
});
export type ModuleBinding = z.infer<typeof ModuleBindingSchema>;

export function modulePackageKey(value: ModulePackageIdentity): string {
  const identity = ModulePackageIdentitySchema.parse(value);
  return JSON.stringify([identity.moduleId, identity.version, identity.digest]);
}
