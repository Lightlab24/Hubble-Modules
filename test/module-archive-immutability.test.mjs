import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("the module batch command preserves existing version bytes and pins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hubble-immutable-package-"));
  try {
    for (const directory of ["scripts", "packages/module-tools/dist", "modules/fixture/dist", "artifacts"])
      await mkdir(path.join(root, directory), { recursive: true });
    await copyFile(new URL("../scripts/modules.mjs", import.meta.url), path.join(root, "scripts/modules.mjs"));
    await writeFile(path.join(root, "modules/fixture/dist/hubble-module.json"), JSON.stringify({ id: "example-immutable", version: "1.0.0" }));
    // Test-only tool double: the real pack command likewise uses flag wx. The
    // regression was the batch wrapper deleting the archive before calling it.
    await writeFile(path.join(root, "packages/module-tools/dist/module-tool.mjs"), `
      import { writeFile } from 'node:fs/promises';
      export async function runModuleTool([operation, project, output]) {
        if (operation === 'pack') await writeFile(output, 'replacement', { flag: 'wx' });
        return { digest: 'test', archiveBytes: 11 };
      }
    `);
    const archive = path.join(root, "artifacts/example-immutable-1.0.0.hubble-module");
    const pin = path.join(root, "artifacts/fixture.lock.json");
    await writeFile(archive, "previously reviewed bytes");
    await writeFile(pin, "previously reviewed pin");
    const result = spawnSync(process.execPath, ["scripts/modules.mjs", "package", "fixture"], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await readFile(archive, "utf8"), "previously reviewed bytes");
    assert.equal(await readFile(pin, "utf8"), "previously reviewed pin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("batch distribution excludes Mock and explicit Mock packaging is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hubble-mock-distribution-"));
  try {
    for (const directory of ["scripts", "packages/module-tools/dist", "modules/mock", "artifacts"])
      await mkdir(path.join(root, directory), { recursive: true });
    await copyFile(new URL("../scripts/modules.mjs", import.meta.url), path.join(root, "scripts/modules.mjs"));
    await writeFile(path.join(root, "packages/module-tools/dist/module-tool.mjs"), `
      export async function runModuleTool() { throw new Error('Mock must never reach distribution tooling'); }
    `);
    const batch = spawnSync(process.execPath, ["scripts/modules.mjs", "package"], { cwd: root, encoding: "utf8" });
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "artifacts/bundled-modules.lock.json"), "utf8")).modules, []);
    const explicit = spawnSync(process.execPath, ["scripts/modules.mjs", "package", "mock"], { cwd: root, encoding: "utf8" });
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /Mock is a test fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
