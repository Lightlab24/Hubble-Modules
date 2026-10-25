// This job inspects archives as data. It never imports or executes submitted module code.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  repository,
  releaseAsset,
  validateUpdate,
  validateArchive,
  signCatalog,
} from "./catalog-policy.mjs";
import { verifyModuleCatalog } from "./sdk-validation.mjs";

if (
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== "refs/heads/main"
)
  throw Error("Publish only from the distribution repository main branch");
if (!process.env.GH_TOKEN || !process.env.MODULE_SIGNING_PRIVATE_KEY)
  throw Error("Missing protected publication credentials");
const input = process.env.CATALOG_INPUT ?? "catalog-input.json";
if (!/^[a-zA-Z0-9_/-]+\.json$/.test(input) || input.split("/").includes(".."))
  throw Error("Invalid catalog input path");
execFileSync("git", ["ls-files", "--error-unmatch", "--", input], {
  stdio: "pipe",
});
execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "pipe" });
const gh = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const keys = JSON.parse(await readFile("keys/catalog.json", "utf8"));
const current = JSON.parse(
  gh(["api", `repos/${repository}/contents/catalog.json`]),
);
const envelope = JSON.parse(
  Buffer.from(current.content, "base64").toString("utf8"),
);
const oldIssuedAt = JSON.parse(
  Buffer.from(envelope.payload, "base64").toString("utf8"),
).issuedAt;
const previous = verifyModuleCatalog(envelope, keys, Date.parse(oldIssuedAt));
const catalog = validateUpdate(
  JSON.parse(await readFile(input, "utf8")),
  previous,
);
const signed = signCatalog(
  catalog,
  process.env.MODULE_SIGNING_KEY_ID,
  process.env.MODULE_SIGNING_PRIVATE_KEY,
  keys,
);
const temporary = await mkdtemp(path.join(tmpdir(), "hubble-module-publish-"));
try {
  const drafts = [];
  for (const entry of catalog.releases) {
    if (
      previous.releases.some(
        (old) =>
          old.identity.moduleId === entry.identity.moduleId &&
          old.identity.version === entry.identity.version,
      )
    )
      continue;
    const { tag, filename } = releaseAsset(entry);
    // GitHub's release-by-tag endpoint does not resolve unpublished drafts.
    // The CLI resolves both drafts and published releases to their numeric API URL.
    const metadata = JSON.parse(
      gh(["release", "view", tag, "--repo", repository, "--json", "apiUrl"]),
    );
    const prefix = `https://api.github.com/repos/${repository}/releases/`;
    if (
      typeof metadata.apiUrl !== "string" ||
      !metadata.apiUrl.startsWith(prefix) ||
      !/^\d+$/.test(metadata.apiUrl.slice(prefix.length))
    )
      throw Error("Unexpected release API URL");
    const release = JSON.parse(gh(["api", metadata.apiUrl]));
    const assets = release.assets.filter(
      (asset) => asset.name === filename && asset.state === "uploaded",
    );
    if (assets.length !== 1 || assets[0].size !== entry.bytes)
      throw Error("Expected exactly one matching uploaded package");
    const bytes = execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}/releases/assets/${assets[0].id}`,
        "-H",
        "Accept: application/octet-stream",
      ],
      { maxBuffer: 16 * 1024 * 1024 + 1, stdio: ["ignore", "pipe", "pipe"] },
    );
    validateArchive(entry, bytes);
    if (release.draft) drafts.push({ tag, beta: entry.channel === "beta" });
  }
  // Inspect all packages before publishing anything. A later catalog failure is
  // recoverable by re-running the same reviewed input; existing bytes never change.
  for (const { tag, beta } of drafts)
    gh([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      `--prerelease=${beta}`,
      "--latest=false",
    ]);
  const request = path.join(temporary, "catalog-update.json");
  await writeFile(
    request,
    JSON.stringify({
      message: `Publish module catalog ${catalog.sequence}`,
      sha: current.sha,
      content: Buffer.from(JSON.stringify(signed) + "\n").toString("base64"),
    }),
  );
  gh([
    "api",
    "--method",
    "PUT",
    `repos/${repository}/contents/catalog.json`,
    "--input",
    request,
  ]);
  console.log(
    JSON.stringify({
      status: "published",
      sequence: catalog.sequence,
      releases: catalog.releases.length,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
