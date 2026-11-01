import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runModuleTool } from "../dist/module-tool.mjs";

test("package frontend and helper build with the public SDK outside either checkout", async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "hubble-frontend-author-"),
  );
  try {
    await cp(
      new URL("../../../examples/custom-canvas/", import.meta.url),
      temporary,
      {
        recursive: true,
        filter: (source) => !source.split(path.sep).includes("dist"),
      },
    );
    await runModuleTool(["build", temporary]);
    const manifest = JSON.parse(
      await readFile(path.join(temporary, "dist/hubble-module.json"), "utf8"),
    );
    assert.ok(manifest.files.includes("ui/index.html"));
    assert.ok(manifest.files.includes("ui/app.js"));
    assert.ok(manifest.files.includes("ui/app.css"));
    assert.ok(manifest.files.includes("helpers/renderer.mjs"));
    const helper = await readFile(
      path.join(temporary, "dist/helpers/renderer.mjs"),
      "utf8",
    );
    assert.match(helper, /serveModuleHelper/);
    // esbuild source-location comments are not runtime imports.
    assert.doesNotMatch(
      helper
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n"),
      /from ["']@hubble\/|Lightlab_Apps/,
    );
    const frontend = await readFile(
      path.join(temporary, "dist/ui/app.js"),
      "utf8",
    );
    assert.match(frontend, /hubble\.module\.frontend\.ready\.v1/);
    assert.doesNotMatch(
      frontend,
      /node:module|node:fs|hubbleDesktop|Hubble\/apps/,
    );
    const packed = await runModuleTool([
      "pack",
      temporary,
      path.join(temporary, "example.hubble-module"),
    ]);
    assert.equal(packed.moduleId, "example-custom-canvas");
    const pkg = JSON.parse(
      await readFile(path.join(temporary, "package.json"), "utf8"),
    );
    const helpers = pkg.hubble.helpers;
    pkg.hubble.helpers = { "../escape.mjs": "src/helper.ts" };
    await writeFile(path.join(temporary, "package.json"), JSON.stringify(pkg));
    await assert.rejects(runModuleTool(["build", temporary]));
    pkg.hubble.helpers = helpers;
    pkg.hubble.frontend = { "../escape.js": "src/frontend.ts" };
    await writeFile(path.join(temporary, "package.json"), JSON.stringify(pkg));
    await assert.rejects(runModuleTool(["build", temporary]));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the portable CLI executes through a symlinked entry path", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-cli-alias-"));
  try {
    const alias = path.join(temporary, "module-tool.mjs");
    const project = path.join(temporary, "project");
    await symlink(new URL("../dist/module-tool.mjs", import.meta.url), alias);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [alias, "create", project, "test-cli-alias"],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      ),
    );
    assert.equal(result.status, "created");
    assert.equal(
      JSON.parse(await readFile(path.join(project, "package.json"), "utf8"))
        .hubble.id,
      "test-cli-alias",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

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

test("Mock cannot be created or packed through the standalone authoring tool", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-retired-mock-"));
  try {
    await assert.rejects(
      runModuleTool(["create", path.join(temporary, "new"), "hubble-mock"]),
      /test fixture/,
    );
    await cp(
      new URL("../../../templates/legacy/simulator/", import.meta.url),
      temporary,
      { recursive: true },
    );
    const file = path.join(temporary, "hubble-module.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.id = "hubble-mock";
    await writeFile(file, JSON.stringify(manifest));
    for (const operation of ["validate", "pack"])
      await assert.rejects(
        runModuleTool([
          operation,
          temporary,
          ...(operation === "pack"
            ? [path.join(temporary, "forbidden.hubble-module")]
            : []),
        ]),
        /test fixture/,
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
