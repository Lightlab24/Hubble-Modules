import { ModuleManifestSchema } from "../packages/module-sdk/dist/index.js";
/** Old Hubble2 readers reject unfamiliar keys. Never rewrite an immutable manifest to fit. */
export function legacyCompatibleRelease(release) {
  const result = ModuleManifestSchema.safeParse(release.manifest);
  if (!result.success) return false;
  const manifest = release.manifest;
  if (
    !Number.isInteger(manifest.host?.minMajor) ||
    !Number.isInteger(manifest.host?.maxMajor) ||
    Object.keys(manifest.host).some(
      (key) => !["minMajor", "maxMajor"].includes(key),
    )
  )
    return false;
  if (
    [...manifest.actions, ...manifest.feedback].some((item) => "group" in item)
  )
    return false;
  return ![
    ...manifest.settings,
    ...manifest.actions.flatMap((item) => item.fields),
    ...manifest.feedback.flatMap((item) => item.fields),
  ].some(
    (field) =>
      field.type === "choice" &&
      field.choices.some((choice) => "group" in choice),
  );
}
export function legacyCatalogSubset(catalog) {
  return {
    ...catalog,
    formatVersion: 1,
    releases: catalog.releases.filter(legacyCompatibleRelease),
  };
}
