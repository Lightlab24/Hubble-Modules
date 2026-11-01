import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] && path.resolve(process.argv[2]);
if (!target) throw new Error("Usage: export-hubble-lock.mjs HUBBLE_CHECKOUT");
const lock = JSON.parse(
  await readFile(
    path.join(root, "artifacts/bundled-modules.lock.json"),
    "utf8",
  ),
);
const previous = JSON.parse(
  await readFile(
    path.join(target, "modules/legacy-bundled-modules.lock.json"),
    "utf8",
  ),
);
if (lock.modules.some((item) => item.moduleId === "hubble-mock"))
  throw new Error("Mock modules are forbidden in app release locks");
if (lock.modules.length !== 13)
  throw new Error(
    "Qualify all 13 production modules before exporting the app lock",
  );
const identity = ({ moduleId, version, digest }) => ({
  moduleId,
  version,
  digest,
});
// This tool performs the initial private-to-public 1.0.0 transition only.
// Retired test archives must not acquire a production transition.
const transitions = previous.modules
  .filter((item) => item.moduleId !== "hubble-mock")
  .map((old) => {
    const next = lock.modules.find((item) => item.moduleId === old.moduleId);
    if (!next || next.version !== "1.0.0")
      throw new Error(
        "Initial official transition must select its matching 1.0.0 archive",
      );
    return { previous: identity(old), next: identity(next) };
  });
const cache = path.join(target, "artifacts/module-cache");
await mkdir(cache, { recursive: true });
for (const item of lock.modules)
  await cp(
    path.join(root, "artifacts", item.file),
    path.join(cache, item.file),
  );
const kit = JSON.parse(
  await readFile(path.join(root, "artifacts/developer-kit.lock.json"), "utf8"),
);
await cp(path.join(root, "artifacts", kit.file), path.join(cache, kit.file));
await writeFile(
  path.join(target, "modules/bundled-modules.lock.json"),
  JSON.stringify(lock, null, 2) + "\n",
);
await writeFile(
  path.join(target, "modules/developer-kit.lock.json"),
  JSON.stringify(kit, null, 2) + "\n",
);
await writeFile(
  path.join(target, "modules/version-transitions.json"),
  JSON.stringify({ formatVersion: 1, transitions }, null, 2) + "\n",
);

const bridge = JSON.parse(
  await readFile(
    path.join(root, "artifacts/official-module-runtime.lock.json"),
    "utf8",
  ),
);
const bridgeCache = path.join(target, "artifacts/module-runtime");
await mkdir(bridgeCache, { recursive: true });
await cp(
  path.join(root, "artifacts", bridge.file),
  path.join(bridgeCache, `${bridge.sha256}.tgz`),
);
await writeFile(
  path.join(target, "official-module-runtime.lock.json"),
  JSON.stringify(bridge, null, 2) + "\n",
);

console.log(
  JSON.stringify({
    status: "exported-reviewed-local-artifacts",
    count: lock.modules.length,
    publication: "not-performed",
    cache,
  }),
);
