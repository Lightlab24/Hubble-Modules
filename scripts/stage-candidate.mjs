// Run after qualification and review. Creates a draft and local catalog input only.
import { readFile, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectModulePackage,
  verifyModuleCatalog,
} from "./sdk-validation.mjs";
import { repository, releaseAsset, validateUpdate } from "./catalog-policy.mjs";

const [
  archivePath,
  notesPath,
  channel = "beta",
  output = "catalog-candidate.json",
] = process.argv.slice(2);
if (!archivePath || !notesPath || !["beta", "stable"].includes(channel))
  throw Error(
    "Usage: stage-candidate.mjs ARCHIVE NOTES_FILE [beta|stable] [OUTPUT_JSON]",
  );
const bytes = await readFile(archivePath);
const inspected = inspectModulePackage(bytes);
const manifest = inspected.manifest;
const tag = `module-${manifest.id}-v${manifest.version}`;
const filename = `${manifest.id}-${manifest.version}.hubble-module`;
const entry = {
  identity: {
    moduleId: manifest.id,
    version: manifest.version,
    digest: inspected.digest,
  },
  manifest,
  url: `https://github.com/${repository}/releases/download/${tag}/${filename}`,
  bytes: bytes.length,
  notes: await readFile(notesPath, "utf8"),
  channel,
  publishedAt: new Date().toISOString(),
  status: "active",
};
releaseAsset(entry);
const gh = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
const keys = JSON.parse(
  await readFile(new URL("../keys/catalog.json", import.meta.url), "utf8"),
);
const current = JSON.parse(
  gh(["api", `repos/${repository}/contents/catalog.json`]),
);
const envelope = JSON.parse(
  Buffer.from(current.content, "base64").toString("utf8"),
);
const issued = JSON.parse(
  Buffer.from(envelope.payload, "base64").toString("utf8"),
).issuedAt;
const previous = verifyModuleCatalog(envelope, keys, Date.parse(issued));
if (
  previous.releases.some(
    (old) =>
      old.identity.moduleId === manifest.id &&
      old.identity.version === manifest.version,
  )
)
  throw Error("Module version is already published");
const catalog = validateUpdate(
  {
    ...previous,
    sequence: previous.sequence + 1,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
    releases: [...previous.releases, entry],
  },
  previous,
);
await writeFile(output, JSON.stringify(catalog, null, 2) + "\n", {
  flag: "wx",
});
const temporary = await mkdtemp(path.join(tmpdir(), "hubble-module-stage-"));
try {
  const assetPath = path.join(temporary, filename);
  await cp(archivePath, assetPath);
  gh([
    "release",
    "create",
    tag,
    assetPath,
    "--repo",
    repository,
    "--draft",
    "--title",
    `${manifest.name} ${manifest.version}`,
    "--notes-file",
    path.resolve(notesPath),
  ]);
  console.log(
    JSON.stringify({
      status: "draft",
      tag,
      digest: inspected.digest,
      catalog: path.resolve(output),
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
