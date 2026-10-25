export const sourceBranch = "codex/independent-modules";
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
