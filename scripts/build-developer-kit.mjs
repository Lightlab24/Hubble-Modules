import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModuleVersionSchema } from "../packages/module-sdk/dist/index.js";
import { runKitCommand } from "./kit-self-test.mjs";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(
  path.join(root, "packages/module-tools/package.json"),
);
// Guidance-only kit revisions can advance without changing SDK/tool contracts.
// Usage: node scripts/build-developer-kit.mjs [output.tar.gz] [kit-version]
const version = ModuleVersionSchema.parse(
  process.argv[3] ??
    JSON.parse(
      await readFile(
        path.join(root, "packages/module-tools/package.json"),
        "utf8",
      ),
    ).version,
);
const file = `hubble-module-developer-kit-${version}.tar.gz`;
const output = path.resolve(
  process.argv[2] ?? path.join(root, "artifacts", file),
);
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "hubble-module-kit-")),
);
const examples = [
  "sidebar-page",
  "native-workbook",
  "matrix-feedback",
  "matrix-row-fields",
  "matrix-collections",
  "native-controls",
  "native-menu",
  "custom-canvas",
  "full-page",
  "custom-spreadsheet",
  "custom-slider",
  "prepared-document",
  "independent-api",
  "exchange-provider",
  "exchange-consumer",
];
try {
  const kit = path.join(temporary, "hubble-module-developer-kit");
  await mkdir(kit);
  await cp(path.join(root, "packages/module-tools/dist"), kit, {
    recursive: true,
  });
  await cp(path.join(root, "packages/module-sdk"), path.join(kit, "sdk"), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  await cp(path.join(root, "skills"), path.join(kit, "skills"), {
    recursive: true,
  });
  const readme = await readFile(
    path.join(root, "docs/developer-kit.md"),
    "utf8",
  );
  await writeFile(
    path.join(kit, "README.md"),
    readme.replaceAll("](../skills/", "](skills/"),
  );
  await cp(path.join(root, "docs"), path.join(kit, "docs"), {
    recursive: true,
  });
  await cp(
    path.join(root, "docs/sidebar-pages.md"),
    path.join(kit, "sidebar-pages.md"),
  );
  for (const example of examples) {
    await cp(
      path.join(root, "examples", example),
      path.join(kit, "examples", example),
      {
        recursive: true,
        filter: (source) =>
          !source
            .split(path.sep)
            .some((part) => part === "node_modules" || part === "dist"),
      },
    );
  }
  for (const required of [
    "examples/full-page/README.md",
    "examples/full-page/src/manifest.ts",
    "examples/full-page/src/index.ts",
    "examples/full-page/src/frontend.ts",
    "examples/full-page/src/frontend.css",
    "examples/full-page/test/module.test.ts",
    "examples/full-page/ui/index.html",
    "examples/native-menu/src/manifest.ts",
    "examples/native-menu/src/index.ts",
    "examples/native-menu/test/menu.test.ts",
    "skills/hubble-module-author/references/native-controls.md",
    "examples/native-controls/src/manifest.ts",
    "examples/native-controls/src/index.ts",
    "examples/native-controls/test/native.test.ts",
    "examples/prepared-document/src/manifest.ts",
    "examples/prepared-document/src/index.ts",
    "examples/prepared-document/test/document.test.ts",
    "sdk/src/spreadsheet-controls.ts",
    "sdk/dist/spreadsheet-controls.d.ts",
    "sdk/src/slider-controls.ts",
    "sdk/dist/slider-controls.d.ts",
    "examples/custom-slider/README.md",
    "examples/custom-slider/src/manifest.ts",
    "examples/custom-slider/src/index.ts",
    "examples/custom-slider/src/frontend.ts",
    "examples/custom-slider/src/frontend.css",
    "examples/custom-slider/src/latest-value-queue.ts",
    "examples/custom-slider/test/module.test.ts",
    "examples/custom-slider/ui/index.html",
    "examples/custom-spreadsheet/README.md",
    "examples/custom-spreadsheet/src/table.ts",
    "examples/custom-spreadsheet/src/workbook-state.ts",
    "examples/custom-spreadsheet/src/model.ts",
    "examples/custom-spreadsheet/src/manifest.ts",
    "examples/custom-spreadsheet/src/frontend.ts",
    "examples/custom-spreadsheet/src/index.ts",
    "examples/custom-spreadsheet/test/batches.test.ts",
    "examples/custom-spreadsheet/test/layout.test.ts",
    "skills/hubble-module-author/references/spreadsheet-controls.md",
    "skills/hubble-module-author/references/sliders.md",
    "skills/hubble-module-author/references/spreadsheet-styling.md",
    "examples/custom-canvas/src/manifest.ts",
    "examples/custom-canvas/src/index.ts",
    "examples/custom-canvas/src/frontend.ts",
    "examples/custom-canvas/src/helper.ts",
    "examples/custom-canvas/src/render-label.ts",
    "examples/custom-canvas/ui/index.html",
    "skills/hubble-module-author/references/custom-pages.md",
    "skills/hubble-module-author/references/documents.md",
    "skills/hubble-module-author/references/datasets.md",
    "skills/hubble-module-author/references/helpers.md",
    "skills/hubble-module-author/references/workspace-instances.md",
    "examples/matrix-feedback/src/manifest.ts",
    "skills/hubble-module-author/references/matrix.md",
    "skills/hubble-module-author/references/contexts-and-local-state.md",
    "examples/matrix-collections/src/manifest.ts",
    "examples/matrix-collections/src/index.ts",
    "examples/matrix-collections/test/matrix.test.ts",
    "skills/hubble-module-author/references/ownership.md",
    "skills/hubble-module-author/references/extension-model.md",
    "skills/hubble-module-author/references/contract.md",
    "skills/hubble-module-author/references/workflows.md",
    "skills/hubble-module-author/SKILL.md",
    "skills/hubble-module-author/references/native-workbooks.md",
    "examples/native-workbook/src/manifest.ts",
    "examples/matrix-row-fields/src/manifest.ts",
    "examples/matrix-row-fields/src/index.ts",
    "examples/matrix-row-fields/test/matrix.test.ts",
  ]) {
    const exported = await readFile(path.join(kit, required));
    const source = await readFile(
      path.join(
        root,
        required.startsWith("sdk/")
          ? required.replace(/^sdk\//, "packages/module-sdk/")
          : required,
      ),
    );
    if (!exported.equals(source))
      throw new Error(`Developer kit does not match its source: ${required}`);
  }
  for (const dependency of ["esbuild-wasm", "zod"]) {
    const packageRoot = path.dirname(
      require.resolve(dependency + "/package.json"),
    );
    await cp(
      await realpath(packageRoot),
      path.join(kit, "node_modules", dependency),
      {
        recursive: true,
        dereference: true,
      },
    );
  }
  await writeFile(
    path.join(kit, "kit.json"),
    JSON.stringify(
      {
        version,
        apiVersions: [1],
        sdkVersion: JSON.parse(
          await readFile(
            path.join(root, "packages/module-sdk/package.json"),
            "utf8",
          ),
        ).version,
        toolsVersion: JSON.parse(
          await readFile(
            path.join(root, "packages/module-tools/package.json"),
            "utf8",
          ),
        ).version,
        spreadsheetControls: {
          minimumHostVersion: "2.0.18",
          requiredFeatures: [
            "module-pages-v1",
            "module-custom-pages-v1",
            "module-spreadsheet-controls-v1",
          ],
        },
        sliders: {
          minimumHostVersion: "2.0.22",
          requiredFeatures: ["module-sliders-v1"],
        },
        minimumNodeMajor: 22,
        moduleVersionIndependent: true,
      },
      null,
      2,
    ) + "\n",
  );
  const project = path.join(temporary, "standalone-check");
  for (const args of [
    ["create", project, "kit-self-test"],
    ["build", project],
    ["test", project],
    ["validate", project],
    ["pack", project, path.join(temporary, "test.hubble-module")],
    ["inspect", path.join(temporary, "test.hubble-module")],
  ])
    runKitCommand(path.join(kit, "module-tool.mjs"), args, temporary);
  for (const example of examples)
    for (const command of ["build", "test", "validate"])
      runKitCommand(
        path.join(kit, "module-tool.mjs"),
        [command, path.join(kit, "examples", example)],
        temporary,
      );
  await mkdir(path.dirname(output), { recursive: true });
  execFileSync(
    "/usr/bin/tar",
    ["-czf", output, "-C", temporary, "hubble-module-developer-kit"],
    // macOS AppleDouble sidecars are not source files. Other extractors retain
    // them as ._*.ts, which makes the exported example test discovery fail.
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  const bytes = await readFile(output);
  const pin = {
    version,
    file,
    bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/developer-kit-v${version}/${file}`,
  };
  await writeFile(
    path.join(path.dirname(output), "developer-kit.lock.json"),
    JSON.stringify(pin, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ status: "built-and-tested", ...pin, path: output }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
