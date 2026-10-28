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
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(
  path.join(root, "packages/module-tools/package.json"),
);
const version = JSON.parse(
  await readFile(path.join(root, "packages/module-tools/package.json"), "utf8"),
).version;
const file = `hubble-module-developer-kit-${version}.tar.gz`;
const output = path.resolve(
  process.argv[2] ?? path.join(root, "artifacts", file),
);
const temporary = await mkdtemp(path.join(tmpdir(), "hubble-module-kit-"));
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
  await cp(
    path.join(root, "docs/developer-kit.md"),
    path.join(kit, "README.md"),
  );
  await cp(path.join(root, "docs"), path.join(kit, "docs"), {
    recursive: true,
  });
  await cp(
    path.join(root, "docs/sidebar-pages.md"),
    path.join(kit, "sidebar-pages.md"),
  );
  for (const example of [
    "sidebar-page",
    "independent-api",
    "exchange-provider",
    "exchange-consumer",
  ]) {
    await cp(
      path.join(root, `examples/${example}`),
      path.join(kit, `examples/${example}`),
      {
        recursive: true,
        filter: (source) =>
          !source
            .split(path.sep)
            .some((part) => part === "node_modules" || part === "dist"),
      },
    );
  }
  for (const dependency of ["esbuild-wasm", "zod"]) {
    const packageRoot = path.dirname(
      require.resolve(dependency + "/package.json"),
    );
    await cp(
      await realpath(packageRoot),
      path.join(kit, "node_modules", dependency),
      { recursive: true, dereference: true },
    );
  }
  await writeFile(
    path.join(kit, "kit.json"),
    JSON.stringify(
      {
        version,
        apiVersions: [1],
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
    execFileSync(
      process.execPath,
      [path.join(kit, "module-tool.mjs"), ...args],
      { cwd: temporary, timeout: 60_000, stdio: "pipe" },
    );
  for (const example of [
    "sidebar-page",
    "independent-api",
    "exchange-provider",
    "exchange-consumer",
  ])
    for (const command of ["build", "test", "validate"]) {
      execFileSync(
        process.execPath,
        [
          path.join(kit, "module-tool.mjs"),
          command,
          path.join(kit, `examples/${example}`),
        ],
        { cwd: temporary, timeout: 60_000, stdio: "pipe" },
      );
    }
  await mkdir(path.dirname(output), { recursive: true });
  execFileSync("/usr/bin/tar", [
    "-czf",
    output,
    "-C",
    temporary,
    "hubble-module-developer-kit",
  ]);
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
