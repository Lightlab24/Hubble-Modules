export const sourceBranch = "main";
export const catalogBranch =
  process.env.MODULE_CATALOG_BRANCH ?? "module-catalog";
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(catalogBranch) ||
  ["main", "master"].includes(catalogBranch) ||
  catalogBranch.includes("..")
)
  throw Error("Catalog publication requires a dedicated non-main branch");
export const catalogReadArgs = (repository, file) => [
  "api",
  `repos/${repository}/contents/${file}`,
  "--method",
  "GET",
  "-f",
  `ref=${catalogBranch}`,
];
// The contents API leaves `content` out of a file over 1 MB (`encoding: "none"`), and the
// signed catalog passed 1 MB at sequence 39 (Nov 20, 2026). Its bytes are then read raw,
// and the reply keeps the `sha` that the compare-and-swap write needs.
export function readCatalogFile(gh, repository, file) {
  const current = JSON.parse(gh(catalogReadArgs(repository, file)));
  if (!current.content && current.encoding === "none")
    current.content = Buffer.from(
      gh([
        ...catalogReadArgs(repository, file),
        "-H",
        "Accept: application/vnd.github.raw+json",
      ]),
      "utf8",
    ).toString("base64");
  return current;
}
