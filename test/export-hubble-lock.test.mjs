import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const includeMock of [false, true]) {
  test(`initial app-lock export ${includeMock ? "rejects Mock" : "omits retired Mock transitions"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hubble-export-policy-"));
    try {
      const artifacts = path.join(root, "artifacts");
      const target = path.join(root, "target");
      await mkdir(artifacts);
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(target, "modules"), { recursive: true });
      const script = path.join(root, "scripts/export-hubble-lock.mjs");
      await cp(
        new URL("../scripts/export-hubble-lock.mjs", import.meta.url),
        script,
      );
      const modules = Array.from({ length: 13 }, (_, index) => ({
        moduleId: `hubble-fixture-${index}`,
        version: "1.0.0",
        digest: "1".repeat(64),
        file: `fixture-${index}.hubble-module`,
      }));
      const previous = [
        ...modules,
        { moduleId: "hubble-mock", version: "2.0.0", digest: "0".repeat(64) },
      ];
      if (includeMock) modules[0].moduleId = "hubble-mock";
      await writeFile(
        path.join(artifacts, "bundled-modules.lock.json"),
        JSON.stringify({ modules }),
      );
      await writeFile(
        path.join(target, "modules/legacy-bundled-modules.lock.json"),
        JSON.stringify({ modules: previous }),
      );
      if (includeMock) {
        assert.throws(
          () =>
            execFileSync(process.execPath, [script, target], { stdio: "pipe" }),
          /Mock modules are forbidden/,
        );
        await assert.rejects(
          readFile(path.join(target, "modules/bundled-modules.lock.json")),
          { code: "ENOENT" },
        );
      } else {
        for (const entry of modules)
          await writeFile(
            path.join(artifacts, entry.file),
            "inert fixture bytes",
          );
        for (const [name, file] of [
          ["developer-kit", "kit.tgz"],
          ["official-module-runtime", "runtime.tgz"],
        ]) {
          await writeFile(
            path.join(artifacts, `${name}.lock.json`),
            JSON.stringify({ file, sha256: "f".repeat(64) }),
          );
          await writeFile(path.join(artifacts, file), "inert fixture bytes");
        }
        execFileSync(process.execPath, [script, target], { stdio: "pipe" });
        const lock = JSON.parse(
          await readFile(
            path.join(target, "modules/bundled-modules.lock.json"),
            "utf8",
          ),
        );
        const transitions = JSON.parse(
          await readFile(
            path.join(target, "modules/version-transitions.json"),
            "utf8",
          ),
        );
        assert.equal(lock.modules.length, 13);
        assert.equal(transitions.transitions.length, 13);
        assert.equal(
          transitions.transitions.some(({ previous, next }) =>
            [previous.moduleId, next.moduleId].includes("hubble-mock"),
          ),
          false,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
