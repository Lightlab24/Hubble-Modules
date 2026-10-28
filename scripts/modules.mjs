import { readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runModuleTool } from "../packages/module-tools/dist/module-tool.mjs";
const root = path.resolve(import.meta.dirname, "..");
const operation = process.argv[2];
const selected = process.argv[3];
if (!["build", "test", "package"].includes(operation))
  throw new Error(
    "Usage: modules.mjs build|test|package [module-directory-name]",
  );
const names = (
  await readdir(path.join(root, "modules"), { withFileTypes: true })
)
  .filter(
    (item) =>
      item.isDirectory() && !item.name.startsWith(".") && item.name !== "mock",
  )
  .map((item) => item.name)
  .sort();
if (selected && !names.includes(selected))
  throw new Error("Unknown module directory");
await mkdir(path.join(root, "artifacts"), { recursive: true });
const inventory = [];
for (const name of selected ? [selected] : names) {
  const project = path.join(root, "modules", name);
  if (operation !== "test") await runModuleTool(["build", project]);
  if (operation === "test" || operation === "package")
    await runModuleTool(["test", project]);
  if (operation === "package") {
    const manifest = JSON.parse(
      await readFile(path.join(project, "dist/hubble-module.json"), "utf8"),
    );
    const file = `${manifest.id}-${manifest.version}.hubble-module`;
    const output = path.join(root, "artifacts", file);
    await rm(output, { force: true });
    const result = await runModuleTool(["pack", project, output]);
    inventory.push({
      moduleId: manifest.id,
      version: manifest.version,
      digest: result.digest,
      bytes: result.archiveBytes,
      file,
      url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/module-${manifest.id}-v${manifest.version}/${file}`,
    });
  }
  console.log(`${operation}: ${name}`);
}
if (operation === "package")
  await writeFile(
    path.join(
      root,
      "artifacts",
      selected ? `${selected}.lock.json` : "bundled-modules.lock.json",
    ),
    JSON.stringify({ formatVersion: 1, modules: inventory }, null, 2) + "\n",
  );
