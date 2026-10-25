import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ModuleIdSchema } from "@hubble/module-sdk";
import { readModuleProject } from "@hubble/module-sdk/project";

export { readModuleProject };
export async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function projectMetadata(directory) {
  const root = await realpath(directory);
  const pkg = (await exists(path.join(root, "package.json")))
    ? JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
    : null;
  return { root, pkg };
}
export async function createProject(
  directory,
  id,
  templates = path.join(import.meta.dirname, "templates"),
) {
  ModuleIdSchema.parse(id);
  const root = path.resolve(directory);
  await mkdir(root, { recursive: false });
  for (const name of await readdir(path.join(templates, "typescript"))) {
    await cp(path.join(templates, "typescript", name), path.join(root, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const file = path.join(root, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  pkg.name = `@hubble-module/${id}`;
  pkg.hubble.id = id;
  await writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
  return { status: "created", directory: root, moduleId: id, next: "build" };
}
