import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const entries = await readdir("submissions", { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    throw Error("Invalid submission directory");
  for (const operation of ["build", "validate", "test"]) {
    execFileSync(
      process.execPath,
      ["tools/module-tool.mjs", operation, `submissions/${entry.name}`],
      { stdio: "inherit", timeout: 45000 },
    );
  }
}
