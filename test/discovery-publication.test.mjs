import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { legacyCatalogSubset } from "../scripts/legacy-catalog.mjs";
import { signCatalog, validateUpdate } from "../scripts/catalog-policy.mjs";
import { verifyModuleCatalog } from "../scripts/sdk-validation.mjs";
const old = JSON.parse(
  await readFile(
    new URL(
      "../templates/legacy/simulator/hubble-module.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const release = (manifest) => ({
  identity: {
    moduleId: manifest.id,
    version: manifest.version,
    digest: "a".repeat(64),
  },
  manifest,
  url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/module-${manifest.id}-v${manifest.version}/${manifest.id}-${manifest.version}.hubble-module`,
  bytes: 10,
  notes: "Fixture",
  channel: "stable",
  status: "active",
  publishedAt: new Date().toISOString(),
});
test("signed v2 discovery retains unknown future manifests without adding them to legacy readers", () => {
  const catalog = {
    formatVersion: 2,
    sequence: 10,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    releases: [
      release(old),
      release({ ...old, version: "1.0.0", host: { minimumVersion: "2.0.0" } }),
      release({
        id: "future-module",
        name: "Future",
        version: "3.0.0",
        formatVersion: 3,
        apiVersion: 7,
        future: { flag: true },
      }),
    ],
  };
  const key = generateKeyPairSync("ed25519");
  const keys = {
    fixture: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const signed = signCatalog(
    catalog,
    "fixture",
    key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keys,
  );
  assert.equal(verifyModuleCatalog(signed, keys).releases.length, 3);
  const legacy = legacyCatalogSubset(catalog);
  assert.equal(legacy.formatVersion, 1);
  assert.deepEqual(legacy.releases, [catalog.releases[0]]);
  assert.throws(
    () =>
      validateUpdate(
        { ...catalog, sequence: 11, releases: catalog.releases.slice(1) },
        catalog,
      ),
    /Retain historical/,
  );
});
