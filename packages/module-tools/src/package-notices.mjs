import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { exists } from "./projects.mjs";
const require = createRequire(import.meta.url);
/** Carry notices for code selected by the bundler, including the SDK's embedded validator. */
export async function packageNotices(root, inputs) {
  const roots = new Set();
  for (const input of inputs) {
    for (
      let directory = path.dirname(path.resolve(root, input));
      ;
      directory = path.dirname(directory)
    ) {
      if (await exists(path.join(directory, "package.json"))) {
        roots.add(directory);
        break;
      }
      if (path.dirname(directory) === directory) break;
    }
  }
  roots.add(path.dirname(require.resolve("zod/package.json")));
  const notices = [];
  for (const directory of roots) {
    const pkg = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    for (const file of (await readdir(directory))
      .filter((name) =>
        /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/i.test(name),
      )
      .sort()) {
      const content = await readFile(path.join(directory, file), "utf8");
      notices.push({ key: `${pkg.name}@${pkg.version}/${file}`, content });
    }
  }
  return notices
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, content }) => `--- ${key} ---\n${content.trim()}\n`)
    .join("\n");
}
