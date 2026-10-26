import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  readdir,
  cp,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
const root = path.resolve(import.meta.dirname, ".."),
  output = path.join(root, "artifacts");
await mkdir(output, { recursive: true });
const projects = [];
for (const directory of await readdir(path.join(root, "packages"))) {
  if (directory === "official-module-runtime") continue; // separately qualified host compatibility aggregate
  const project = path.join(root, "packages", directory);
  const pkg = JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  );
  const file = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
  const tag = `${{ "module-sdk": "sdk", "module-tools": "tools", "module-contracts": "contracts" }[directory] ?? directory}-v${pkg.version}`;
  projects.push({
    directory,
    project,
    pkg,
    file,
    url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/${tag}/${file}`,
  });
}
const byName = new Map(projects.map((project) => [project.pkg.name, project]));
const ordered = [],
  visiting = new Set(),
  visited = new Set();
function visit(project) {
  if (visited.has(project)) return;
  if (visiting.has(project)) throw Error("Public package dependency cycle");
  visiting.add(project);
  for (const name of Object.keys(project.pkg.dependencies ?? {}))
    if (byName.has(name)) visit(byName.get(name));
  visiting.delete(project);
  visited.add(project);
  ordered.push(project);
}
projects.forEach(visit);
const temporary = await mkdtemp(path.join(tmpdir(), "hubble-public-packages-"));
try {
  await symlink(
    path.join(root, "node_modules"),
    path.join(temporary, "node_modules"),
    "dir",
  );
  const paths = {};
  for (const { directory, project, pkg, file, url } of ordered) {
    const ready = path.join(temporary, directory);
    await mkdir(ready);
    let distribution;
    if (["module-sdk", "module-tools"].includes(directory)) {
      await cp(path.join(project, "dist"), path.join(ready, "dist"), {
        recursive: true,
      });
      if (directory === "module-tools")
        await cp(path.join(project, "bin"), path.join(ready, "bin"), {
          recursive: true,
        });
      distribution = { ...pkg, scripts: undefined, devDependencies: undefined };
    } else {
      const config = path.join(ready, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            types: ["node"],
            typeRoots: [path.join(root, "node_modules/@types")],
            declaration: true,
            rootDir: path.join(project, "src"),
            outDir: path.join(ready, "dist"),
            paths,
          },
          include: [path.join(project, "src/**/*.ts")],
        }),
      );
      try {
        execFileSync("pnpm", ["exec", "tsc", "-p", config], {
          cwd: root,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        throw Error(
          `Could not compile ${pkg.name}: ${error.stdout ?? error.message}`,
        );
      }
      distribution = {
        name: pkg.name,
        version: pkg.version,
        type: "module",
        engines: { node: ">=22" },
        files: ["dist", "README.md", "LICENSE*", "NOTICE*"],
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
        },
        dependencies: {
          ...pkg.dependencies,
          ...Object.fromEntries(
            Object.entries(pkg.devDependencies ?? {}).filter(([name]) =>
              name.startsWith("@types/"),
            ),
          ),
        },
      };
    }
    distribution.dependencies = Object.fromEntries(
      Object.entries(distribution.dependencies ?? {}).map(([name, version]) => [
        name,
        byName.get(name)?.url ?? version,
      ]),
    );
    for (const name of await readdir(project))
      if (/^(?:README|LICENSE|LICENCE|NOTICE)(?:[.-].*)?$/i.test(name))
        await cp(path.join(project, name), path.join(ready, name));
    await writeFile(
      path.join(ready, "package.json"),
      JSON.stringify(distribution, null, 2) + "\n",
    );
    execFileSync(
      "pnpm",
      ["--dir", ready, "pack", "--pack-destination", output],
      { stdio: "pipe" },
    );
    const bytes = await readFile(path.join(output, file));
    const pin = {
      package: pkg.name,
      version: pkg.version,
      file,
      bytes: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
      url,
    };
    await writeFile(
      path.join(output, `${directory}.lock.json`),
      JSON.stringify(pin, null, 2) + "\n",
    );
    console.log(JSON.stringify(pin));
    paths[pkg.name] = [path.join(ready, "dist/index.d.ts")];
    paths[`${pkg.name}/*`] = [path.join(ready, "dist/*.d.ts")];
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
