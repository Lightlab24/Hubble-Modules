import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runModuleTool } from "../dist/module-tool.mjs";

test("portable TypeScript source builds, passes conformance and packages without a private checkout", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-author-test-"));
  try {
    const project = path.join(temporary, "project");
    await runModuleTool(["create", project, "test-independent"]);
    await assert.rejects(
      runModuleTool(["validate", project]),
      /Build this TypeScript module/,
    );
    await runModuleTool(["build", project]);
    await runModuleTool(["test", project]);
    const first = await runModuleTool([
      "pack",
      project,
      path.join(temporary, "one.hubble-module"),
    ]);
    await runModuleTool(["build", project]);
    const second = await runModuleTool([
      "pack",
      project,
      path.join(temporary, "two.hubble-module"),
    ]);
    assert.equal(first.digest, second.digest);
    assert.equal(first.version, "1.0.0");
    assert.equal(first.moduleId, "test-independent");
    assert.deepEqual(first.files, ["THIRD-PARTY-NOTICES.txt", "module.mjs"]);
    assert.match(
      await readFile(
        path.join(project, "dist/THIRD-PARTY-NOTICES.txt"),
        "utf8",
      ),
      /zod@.*MIT License/s,
    );
    await assert.rejects(
      runModuleTool(["create", project, "test-independent"]),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("validate, pack and inspect never execute source or entry code; legacy projects remain supported", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-data-only-"));
  try {
    await cp(
      new URL("../../../templates/legacy/simulator/", import.meta.url),
      temporary,
      { recursive: true },
    );
    await writeFile(
      path.join(temporary, "module.mjs"),
      'throw Error("must not execute")',
    );
    await runModuleTool(["validate", temporary]);
    const archive = path.join(temporary, "test.hubble-module");
    await runModuleTool(["pack", temporary, archive]);
    await runModuleTool(["inspect", archive]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("source descriptor execution is confined to the explicit build step", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "hubble-build-boundary-"),
  );
  try {
    const project = path.join(temporary, "project");
    await runModuleTool(["create", project, "test-build-boundary"]);
    await runModuleTool(["build", project]);
    await writeFile(
      path.join(project, "src/manifest.ts"),
      'throw Error("unbuilt source")',
    );
    await runModuleTool(["validate", project]);
    await assert.rejects(runModuleTool(["build", project]), /unbuilt source/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
