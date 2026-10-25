import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ModuleCatalogSchema,
  verifyModuleCatalog,
  inspectModulePackage,
} from "./sdk-validation.mjs";

export const repository = "Lightlab24/Hubble-Modules";

export function releaseAsset(entry) {
  const { moduleId, version } = entry.identity;
  const tag = `module-${moduleId}-v${version}`;
  const filename = `${moduleId}-${version}.hubble-module`;
  const url = `https://github.com/${repository}/releases/download/${tag}/${filename}`;
  if (entry.url !== url)
    throw Error("Catalog package URL must name its immutable module release");
  return { tag, filename };
}

export function validateUpdate(raw, previous) {
  const next = ModuleCatalogSchema.parse(raw);
  if (previous && next.sequence <= previous.sequence)
    throw Error("Catalog sequence must increase");
  for (const entry of next.releases) releaseAsset(entry);
  for (const old of previous?.releases ?? []) {
    const entry = next.releases.find(
      (item) =>
        item.identity.moduleId === old.identity.moduleId &&
        item.identity.version === old.identity.version,
    );
    if (!entry)
      throw Error("Retain historical entries; withdraw instead of deleting");
    for (const key of ["identity", "manifest", "url", "bytes", "publishedAt"]) {
      if (!isDeepStrictEqual(entry[key], old[key]))
        throw Error(`Published ${key} is immutable`);
    }
  }
  return next;
}

export function validateArchive(entry, bytes) {
  const actual = inspectModulePackage(bytes);
  if (
    bytes.length !== entry.bytes ||
    actual.digest !== entry.identity.digest ||
    !isDeepStrictEqual(actual.manifest, entry.manifest)
  ) {
    throw Error("Downloaded archive differs from the reviewed catalog");
  }
}

export function signCatalog(catalog, keyId, pem, publicKeys) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("Use an Ed25519 signing key");
  const derived = createPublicKey(key)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (publicKeys[keyId] !== derived)
    throw Error("Signing key does not match the committed public key");
  const payload = Buffer.from(JSON.stringify(catalog));
  const envelope = {
    formatVersion: 1,
    keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key).toString("base64"),
  };
  verifyModuleCatalog(envelope, publicKeys);
  return envelope;
}
