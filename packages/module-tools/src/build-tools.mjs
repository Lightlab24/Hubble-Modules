import { build } from "esbuild";
import { packageNotices } from "./package-notices.mjs";
import { cp, mkdir, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, "packages/module-tools/dist");
await mkdir(output, { recursive: true });
const tool = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: [path.join(import.meta.dirname, "module-tool.mjs")],
  outfile: path.join(output, "module-tool.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["esbuild-wasm"],
  legalComments: "eof",
});
await build({
  entryPoints: Object.fromEntries(
    ["index", "authoring", "testing"].map((name) => [
      name,
      path.join(root, "packages/module-sdk/dist", name + ".js"),
    ]),
  ),
  outdir: path.join(output, "author-sdk"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "eof",
});
await cp(path.join(root, "templates"), path.join(output, "templates"), {
  recursive: true,
});
await chmod(path.join(output, "module-tool.mjs"), 0o755);

const client = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: [path.join(import.meta.dirname, "service-client.mjs")],
  outfile: path.join(output, "service-client.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: "import {createRequire as kitRequire} from 'node:module'; const require = kitRequire(import.meta.url);",
  },
});

await writeFile(
  path.join(output, "THIRD-PARTY-NOTICES.txt"),
  await packageNotices(root, [
    ...Object.keys(tool.metafile.inputs),
    ...Object.keys(client.metafile.inputs),
  ]),
);
