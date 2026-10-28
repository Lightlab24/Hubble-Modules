import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runKitCommand } from "../scripts/kit-self-test.mjs";

test("kit qualification rejects a successful process that silently skipped its command", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-kit-noop-"));
  try {
    const tool = path.join(temporary, "tool.mjs");
    await writeFile(tool, "// A skipped direct-entry guard exits zero.\n");
    assert.throws(
      () => runKitCommand(tool, ["build", temporary], temporary),
      /build did not return a JSON result/,
    );
    await writeFile(tool, 'console.log(JSON.stringify({status:"created"}));\n');
    assert.throws(
      () => runKitCommand(tool, ["build", temporary], temporary),
      /build did not return status built/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("kit qualification executes a CLI through a symlinked path", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hubble-kit-alias-"));
  try {
    const tool = path.join(temporary, "tool.mjs");
    const alias = path.join(temporary, "alias.mjs");
    await writeFile(
      tool,
      'import {pathToFileURL} from "node:url";\n' +
        'if (pathToFileURL(process.argv[1]).href === import.meta.url) console.log(JSON.stringify({status:"built"}));\n',
    );
    await symlink(tool, alias);
    assert.deepEqual(runKitCommand(alias, ["build", temporary], temporary), {
      status: "built",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
