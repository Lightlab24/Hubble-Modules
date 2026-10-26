import { spawnSync } from "node:child_process";
import { readdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild-wasm";
import { bundleOptions } from "./build-project.mjs";
import { exists, readModuleProject } from "./projects.mjs";

async function testFiles(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...(await testFiles(file)));
    else if (/\.(?:test|spec)\.(?:ts|mjs|js)$/.test(item.name))
      files.push(file);
  }
  return files.sort();
}
async function vitestRoot(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (
      (
        await Promise.all(
          ["ts", "mts", "mjs", "js", "cts", "cjs"].map((extension) =>
            exists(path.join(current, "vitest.config." + extension)),
          ),
        )
      ).some(Boolean)
    )
      return current;
    if (path.dirname(current) === current) return directory;
  }
}
export async function testProject(directory) {
  const root = path.resolve(directory);
  await readModuleProject(root);
  const legacy = path.join(root, "module.test.mjs");
  let files = (await exists(legacy))
    ? [legacy]
    : await testFiles(path.join(root, "test"));
  if (!files.length)
    throw new Error(
      "No module tests found; qualification requires module.test.mjs or test/**/*.test.ts",
    );
  if (
    (await Promise.all(files.map((file) => readFile(file, "utf8")))).some(
      (source) => /from\s+['"]vitest['"]/.test(source),
    )
  ) {
    const result = spawnSync("pnpm", ["exec", "vitest", "run", ...files], {
      cwd: await vitestRoot(root),
      timeout: 120_000,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stdout + result.stderr);
    return { status: "passed", output: result.stdout };
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-module-tests-"));
  try {
    const entries = Object.fromEntries(
      files.map((file, index) => [`test-${index}`, file]),
    );
    await build({
      ...(await bundleOptions(root)),
      entryPoints: entries,
      outdir: temporary,
      outExtension: { ".js": ".mjs" },
    });
    files = Object.keys(entries).map((name) =>
      path.join(temporary, name + ".mjs"),
    );
    const result = spawnSync(process.execPath, ["--test", ...files], {
      cwd: root,
      timeout: 60_000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stdout + result.stderr);
    return { status: "passed", output: result.stdout };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
