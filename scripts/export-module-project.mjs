// Make a standalone editable official module project using reviewed public dependency pins.
import { cp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  [name, destination] = process.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !destination)
  throw Error(
    "Usage: export-module-project.mjs MODULE_DIRECTORY NEW_PROJECT_DIRECTORY",
  );
const source = path.join(root, "modules", name),
  target = path.resolve(destination);
const pkg = JSON.parse(
  await readFile(path.join(source, "package.json"), "utf8"),
);
const pins = new Map();
for (const file of await readdir(path.join(root, "artifacts")))
  if (file.endsWith(".lock.json")) {
    const pin = JSON.parse(
      await readFile(path.join(root, "artifacts", file), "utf8"),
    );
    if (pin.package && pin.url) pins.set(pin.package, pin);
  }
for (const group of ["dependencies", "devDependencies"])
  for (const [id, version] of Object.entries(pkg[group] ?? {}))
    if (version.startsWith("workspace:")) {
      const pin = pins.get(id);
      if (!pin || version !== `workspace:${pin.version}`)
        throw Error(
          `Build and qualify the exact public dependency ${id} before exporting`,
        );
      pkg[group][id] = pin.url;
    }
pkg.devDependencies = {
  ...pkg.devDependencies,
  typescript: "6.0.3",
  "@types/node": "22.19.17",
  vitest: "4.1.10",
};
pkg.scripts.typecheck = "tsc --noEmit";
pkg.scripts.package = `hubble-module build . && hubble-module test . && hubble-module pack . ${pkg.hubble.id}-${pkg.version}.hubble-module`;
await mkdir(target, { recursive: false });
await cp(source, target, {
  recursive: true,
  force: false,
  filter: (file) => !["node_modules", "dist"].includes(path.basename(file)),
});
await writeFile(
  path.join(target, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
await writeFile(
  path.join(target, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["node"],
        noEmit: true,
      },
      include: ["src/**/*.ts", "test/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(target, "vitest.config.ts"),
  "import {defineConfig} from 'vitest/config'\nexport default defineConfig({test:{include:['test/**/*.test.ts'],testTimeout:15000}})\n",
);
console.log(
  JSON.stringify({
    status: "exported",
    path: target,
    next: "pnpm install, then pnpm build && pnpm test && pnpm typecheck; use your own ID/version for a separately published fork",
  }),
);
