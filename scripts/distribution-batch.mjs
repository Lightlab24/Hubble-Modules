import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { distributionRelease } from "./distribution-release.mjs";
const file = process.argv[2];
if (
  !file ||
  path.isAbsolute(file) ||
  !/^[a-zA-Z0-9_/-]+\.json$/.test(file) ||
  file.split("/").includes("..")
)
  throw Error("Expected a committed reviewed pin-list path");
execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
  stdio: "pipe",
});
execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "pipe" });
const batch = JSON.parse(await readFile(file, "utf8"));
if (
  batch.formatVersion !== 1 ||
  !Array.isArray(batch.pins) ||
  batch.pins.length < 1 ||
  batch.pins.length > 32 ||
  batch.pins.some((pin) => typeof pin !== "string") ||
  new Set(batch.pins).size !== batch.pins.length
)
  throw Error("Invalid reviewed distribution pin list");
// Complete all byte verification before publishing any standalone distribution.
for (const pin of batch.pins) await distributionRelease("verify", pin);
for (const pin of batch.pins) await distributionRelease("publish", pin);
console.log(
  JSON.stringify({ status: "published", distributions: batch.pins.length }),
);
