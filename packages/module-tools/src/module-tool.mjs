#!/usr/bin/env node
import { readFile, writeFile, lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createModulePackage,
  inspectModulePackage,
  MAX_MODULE_ARCHIVE_BYTES,
} from "@hubble/module-sdk/package";
import { createProject, readModuleProject } from "./projects.mjs";
import { buildProject } from "./build-project.mjs";
import { testProject } from "./test-project.mjs";

export { readModuleProject };
const usage =
  "Usage: hubble-module create DIR MODULE-ID | build DIR | validate DIR | test DIR | pack DIR OUTPUT.hubble-module | inspect ARCHIVE";
export async function runModuleTool(args) {
  const [command, input, output] = args;
  if (!input) throw new Error(usage);
  if (command === "create" && args.length === 3)
    return createProject(input, output);
  if (command === "build" && args.length === 2) return buildProject(input);
  if (command === "test" && args.length === 2) return testProject(input);
  if (command === "inspect" && args.length === 2) {
    const stat = await lstat(input);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_MODULE_ARCHIVE_BYTES
    )
      throw new Error("Expected a bounded regular archive");
    return summary(inspectModulePackage(await readFile(input)));
  }
  if (
    (command === "validate" && args.length === 2) ||
    (command === "pack" && args.length === 3)
  ) {
    const { manifest, files } = await readModuleProject(input);
    const archive = createModulePackage(manifest, files);
    if (command === "pack") {
      if (!output.endsWith(".hubble-module"))
        throw new Error("Output must end in .hubble-module");
      await writeFile(output, archive, { flag: "wx" });
    }
    return {
      ...summary(inspectModulePackage(archive)),
      ...(output ? { output: path.resolve(output) } : {}),
    };
  }
  throw new Error(usage);
}
function summary(inspected) {
  return {
    status: "valid",
    moduleId: inspected.manifest.id,
    version: inspected.manifest.version,
    apiVersion: inspected.manifest.apiVersion,
    digest: inspected.digest,
    archiveBytes: inspected.archiveBytes,
    expandedBytes: inspected.expandedBytes,
    files: [...inspected.files.keys()],
    manifest: inspected.manifest,
    actions: inspected.manifest.actions.map((action) => action.id),
    feedback: inspected.manifest.feedback.map((item) => item.id),
    origin: "local",
    activation: "not-requested",
  };
}
if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  runModuleTool(process.argv.slice(2)).then(
    (value) => console.log(JSON.stringify(value, null, 2)),
    (error) => {
      console.error(
        JSON.stringify({ status: "failed", message: error.message }),
      );
      process.exitCode = 1;
    },
  );
}
