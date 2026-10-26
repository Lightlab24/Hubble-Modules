// Stage or publish already-reviewed developer-kit / host-bridge bytes. Never builds source.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repository = "Lightlab24/Hubble-Modules";
const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
export function distributionIdentity(pin) {
  if (!/^\d+\.\d+\.\d+$/.test(pin.version))
    throw Error("Invalid distribution version");
  const prefixes = {
    "hubble-module-developer-kit": "developer-kit",
    "hubble-official-module-runtime": "runtime",
    "hubble-module-sdk": "sdk",
    "hubble-module-tools": "tools",
    "hubble-module-contracts": "contracts",
    ...Object.fromEntries(
      [
        "module-runtime-helpers",
        "router-runtime",
        "protocol-cyanview-rcp",
        "protocol-ultrix-ogp",
        "protocol-videohub",
        "dit-browse-client",
        "lightencode-client",
      ].map((name) => [`hubble-${name}`, name]),
    ),
  };
  const kind = Object.entries(prefixes).find(
    ([prefix]) =>
      pin.file ===
      `${prefix}-${pin.version}.${prefix === "hubble-module-developer-kit" ? "tar.gz" : "tgz"}`,
  )?.[1];
  const digest = pin.digest ?? pin.sha256;
  if (
    !kind ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isInteger(pin.bytes) ||
    pin.bytes <= 0 ||
    pin.bytes > 64 * 1024 * 1024
  )
    throw Error("Invalid distribution pin");
  const tag = `${kind}-v${pin.version}`;
  if (
    pin.url !==
    `https://github.com/${repository}/releases/download/${tag}/${pin.file}`
  )
    throw Error("Distribution URL does not match immutable asset");
  return { tag, digest };
}
export function verifyDistribution(pin, bytes) {
  const identity = distributionIdentity(pin);
  if (
    bytes.length !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== identity.digest
  )
    throw Error("Distribution bytes differ from reviewed pin");
  return identity;
}
async function verifyRemote(pin, tag) {
  const directory = await mkdtemp(path.join(tmpdir(), "hubble-distribution-"));
  try {
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      pin.file,
      "--dir",
      directory,
    ]);
    verifyDistribution(pin, await readFile(path.join(directory, pin.file)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function distributionRelease(mode, pinPath, reviewPath) {
  if (!["stage", "verify", "publish"].includes(mode))
    throw Error(
      "Usage: distribution-release.mjs stage|verify|publish PIN_JSON [REVIEWED_OUTPUT_JSON]",
    );
  if (
    mode !== "stage" &&
    (!/^[a-zA-Z0-9_./-]+\.json$/.test(pinPath) ||
      path.isAbsolute(pinPath) ||
      pinPath.split("/").includes(".."))
  )
    throw Error("Publish requires a repository-relative reviewed pin");
  const pin = JSON.parse(await readFile(pinPath, "utf8"));
  const { tag } = distributionIdentity(pin);
  if (mode === "stage") {
    if (!reviewPath)
      throw Error("Stage requires an explicit reviewed pin output path");
    const file = path.resolve(path.dirname(pinPath), pin.file);
    verifyDistribution(pin, await readFile(file));
    let release;
    try {
      release = JSON.parse(
        gh([
          "release",
          "view",
          tag,
          "--repo",
          repository,
          "--json",
          "isDraft,assets",
        ]),
      );
    } catch (error) {
      if (!String(error.stderr).includes("release not found")) throw error;
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      gh([
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--target",
        commit,
        "--draft",
        "--title",
        tag,
        "--notes",
        "Reviewed standalone distribution; see repository authoring and publication guides.",
      ]);
      release = { isDraft: true, assets: [] };
    }
    if (!release.assets.some((asset) => asset.name === pin.file)) {
      if (!release.isDraft)
        throw Error(
          "Published distribution has no matching immutable asset; use a new version",
        );
      gh(["release", "upload", tag, file, "--repo", repository]);
    }
    await verifyRemote(pin, tag);
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(reviewPath, JSON.stringify(pin, null, 2) + "\n");
    return { status: "staged-for-review", tag, reviewPath };
  }
  execFileSync("git", ["ls-files", "--error-unmatch", "--", pinPath], {
    stdio: "pipe",
  });
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "pipe" });
  await verifyRemote(pin, tag);
  const release = JSON.parse(
    gh(["release", "view", tag, "--repo", repository, "--json", "isDraft"]),
  );
  if (mode === "verify")
    return {
      status: "verified",
      tag,
      digest: distributionIdentity(pin).digest,
    };
  if (release.isDraft)
    gh(["release", "edit", tag, "--repo", repository, "--draft=false"]);
  return { status: "published", tag, digest: distributionIdentity(pin).digest };
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  console.log(
    JSON.stringify(await distributionRelease(...process.argv.slice(2))),
  );
