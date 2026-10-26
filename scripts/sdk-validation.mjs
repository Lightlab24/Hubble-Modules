// Maintained source; no generated validator blob or private repository dependency.
import { createPublicKey, verify } from "node:crypto";
import {
  ModuleCatalogDocumentSchema,
  SignedModuleCatalogSchema,
} from "../packages/module-sdk/dist/catalog-schema.js";
export { ModuleCatalogDocumentSchema as ModuleCatalogSchema } from "../packages/module-sdk/dist/catalog-schema.js";
export {
  createModulePackage,
  inspectModulePackage,
} from "../packages/module-sdk/dist/package.js";
export function verifyModuleCatalog(raw, keys, now = Date.now()) {
  const envelope = SignedModuleCatalogSchema.parse(raw);
  const pem = keys[envelope.keyId];
  if (!pem) throw new Error("Catalog signing key is not trusted");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Catalog requires an Ed25519 signing key");
  const bytes = Buffer.from(envelope.payload, "base64");
  if (!verify(null, bytes, key, Buffer.from(envelope.signature, "base64")))
    throw new Error("Module catalog signature is invalid");
  const catalog = ModuleCatalogDocumentSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    Date.parse(catalog.issuedAt) > now + 300_000 ||
    Date.parse(catalog.expiresAt) <= now
  )
    throw new Error("Module catalog is expired or not yet valid");
  return catalog;
}
