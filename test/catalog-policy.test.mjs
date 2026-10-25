import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  validateUpdate,
  validateArchive,
  signCatalog,
} from "../scripts/catalog-policy.mjs";
import {
  createModulePackage,
  inspectModulePackage,
  verifyModuleCatalog,
} from "../scripts/sdk-validation.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL("../tools/templates/simulator/hubble-module.json", import.meta.url),
    "utf8",
  ),
);
const bytes = createModulePackage(
  manifest,
  new Map([["module.mjs", Buffer.from('throw Error("must never execute")')]]),
);
const inspected = inspectModulePackage(bytes);
const now = Date.now();
const entry = {
  identity: {
    moduleId: manifest.id,
    version: manifest.version,
    digest: inspected.digest,
  },
  manifest: inspected.manifest,
  url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/module-${manifest.id}-v${manifest.version}/${manifest.id}-${manifest.version}.hubble-module`,
  bytes: bytes.length,
  notes: "Test only",
  channel: "beta",
  publishedAt: new Date(now).toISOString(),
  status: "active",
};
const previous = {
  formatVersion: 1,
  sequence: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 86400000).toISOString(),
  releases: [entry],
};
const next = () => structuredClone({ ...previous, sequence: 2 });

test("accepts inspected bytes without executing module code", () => {
  validateArchive(entry, bytes);
  assert.equal(validateUpdate(next(), previous).sequence, 2);
});
test("rejects corruption, different archives, and mismatched manifests", () => {
  const corrupt = Buffer.from(bytes);
  corrupt[10] ^= 255;
  assert.throws(() => validateArchive(entry, corrupt));
  assert.throws(() =>
    validateArchive({ ...entry, bytes: bytes.length + 1 }, bytes),
  );
  assert.throws(() =>
    validateArchive(
      { ...entry, manifest: { ...entry.manifest, name: "Replaced" } },
      bytes,
    ),
  );
});
test("retains immutable history and rejects stale catalog revisions", () => {
  assert.throws(() => validateUpdate(previous, previous), /sequence/);
  const removed = next();
  removed.releases = [];
  assert.throws(() => validateUpdate(removed, previous), /Retain/);
  const changed = next();
  changed.releases[0].identity.digest = "a".repeat(64);
  assert.throws(() => validateUpdate(changed, previous), /immutable/);
  const changedManifest = next();
  changedManifest.releases[0].manifest.name = "Changed";
  assert.throws(() => validateUpdate(changedManifest, previous), /immutable/);
});
test("allows withdrawals and metadata-only renewal without replacing bytes", () => {
  const withdrawn = next();
  withdrawn.releases[0].status = "withdrawn";
  withdrawn.releases[0].reason = "Issue confirmed";
  assert.equal(
    validateUpdate(withdrawn, previous).releases[0].status,
    "withdrawn",
  );
});
test("rejects packages outside the exact repository/version release path", () => {
  const changed = next();
  changed.releases[0].url = "https://example.com/package.hubble-module";
  assert.throws(() => validateUpdate(changed, previous), /URL/);
});
test("signatures are verified against the committed trust key", () => {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const keys = {
    test: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const envelope = signCatalog(next(), "test", pem, keys);
  assert.equal(verifyModuleCatalog(envelope, keys).sequence, 2);
  assert.throws(
    () => signCatalog(next(), "test", pem, { test: "different" }),
    /committed/,
  );
  assert.throws(
    () =>
      verifyModuleCatalog(
        {
          ...envelope,
          payload: Buffer.from(JSON.stringify(previous)).toString("base64"),
        },
        keys,
      ),
    /signature/,
  );
});
test("bootstrapped public feed is valid and contains no unqualified releases", async () => {
  const keys = JSON.parse(
    await readFile(new URL("../keys/catalog.json", import.meta.url), "utf8"),
  );
  const envelope = JSON.parse(
    await readFile(new URL("../catalog.json", import.meta.url), "utf8"),
  );
  const value = verifyModuleCatalog(envelope, keys);
  assert(value.sequence >= 0);
  for (const release of value.releases)
    assert(["stable", "beta"].includes(release.channel));
});
