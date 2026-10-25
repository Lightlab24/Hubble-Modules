import { build } from "esbuild-wasm";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rm, cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleManifestSchema } from "@hubble/module-sdk";
import { packageNotices } from "./package-notices.mjs";
import { exists, projectMetadata } from "./projects.mjs";

const require = createRequire(import.meta.url);
export async function sdkAliases() {
  const base = path.join(import.meta.dirname, "author-sdk");
  if (!(await exists(base))) return {};
  return Object.fromEntries(
    ["index", "authoring", "testing"].map((name) => [
      name === "index" ? "@hubble/module-sdk" : `@hubble/module-sdk/${name}`,
      path.join(base, name + ".mjs"),
    ]),
  );
}
export async function bundleOptions(root) {
  return {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    legalComments: "eof",
    logLevel: "warning",
    alias: await sdkAliases(),
    external: ["bufferutil", "utf-8-validate"],
    banner: {
      js: "import { createRequire as hubbleCreateRequire } from 'node:module'; const require = hubbleCreateRequire(import.meta.url);",
    },
  };
}
/** Explicitly executes a bundled author descriptor. Never called by validate/pack/inspect. */
export async function buildProject(directory) {
  const { root, pkg } = await projectMetadata(directory);
  if (!pkg || !(await exists(path.join(root, "src/index.ts")))) {
    if (await exists(path.join(root, "hubble-module.json")))
      return { status: "built", directory: root, legacy: true };
    throw new Error(
      "Expected a TypeScript project with src/index.ts or a legacy runtime manifest",
    );
  }
  let source;
  const descriptor = path.join(root, "src/manifest.ts");
  if (await exists(descriptor)) {
    const temporary = await mkdtemp(path.join(tmpdir(), "hubble-manifest-"));
    try {
      const output = path.join(temporary, "manifest.mjs");
      await build({
        ...(await bundleOptions(root)),
        entryPoints: [descriptor],
        outfile: output,
      });
      source = (await import(pathToFileURL(output).href)).default;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else
    source = JSON.parse(
      await readFile(path.join(root, "hubble-module.json"), "utf8"),
    );
  let manifest = ModuleManifestSchema.parse({
    ...source,
    id: pkg.hubble?.id ?? source.id,
    name: pkg.hubble?.name ?? source.name,
    version: pkg.version,
    entry: "module.mjs",
    files: ["module.mjs", ...(pkg.hubble?.assets ?? [])],
  });
  const output = path.join(root, "dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const built = await build({
    ...(await bundleOptions(root)),
    entryPoints: [path.join(root, "src/index.ts")],
    outfile: path.join(output, "module.mjs"),
    metafile: true,
  });
  for (const input of Object.keys(built.metafile.inputs)) {
    if (
      /[/\\](?:Lightlab_Apps[/\\]Hubble|apps[/\\]hubble-service)[/\\]/.test(
        path.resolve(root, input),
      )
    )
      throw new Error(
        "Module distribution imports private Hubble application source",
      );
  }
  for (const asset of manifest.files.slice(1)) {
    await mkdir(path.dirname(path.join(output, asset)), { recursive: true });
    await cp(path.join(root, asset), path.join(output, asset), {
      dereference: false,
    });
  }
  const notices = await packageNotices(
    root,
    Object.keys(built.metafile.inputs),
  );
  if (notices) {
    const file = "THIRD-PARTY-NOTICES.txt";
    if (manifest.files.includes(file))
      throw new Error(
        "THIRD-PARTY-NOTICES.txt is generated; use a different asset name",
      );
    await writeFile(path.join(output, file), notices);
    manifest = ModuleManifestSchema.parse({
      ...manifest,
      files: [...manifest.files, file],
    });
  }
  await writeFile(
    path.join(output, "hubble-module.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return {
    status: "built",
    directory: output,
    moduleId: manifest.id,
    version: manifest.version,
  };
}
