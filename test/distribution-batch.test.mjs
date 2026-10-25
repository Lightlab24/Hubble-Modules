import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("../scripts/distribution-batch.mjs", import.meta.url),
);
for (const corrupt of [false, true])
  test(`initial distribution batch preflights every pin before publication: corrupt=${corrupt}`, async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "hubble-distribution-batch-"),
    );
    try {
      await mkdir(path.join(root, "bin"));
      const fixtures = {};
      for (const name of ["sdk", "tools"]) {
        const bytes = Buffer.from(`${name} reviewed bytes`),
          file = `hubble-module-${name}-1.0.0.tgz`,
          tag = `${name}-v1.0.0`;
        fixtures[tag] = {
          file,
          bytes: (corrupt && name === "tools"
            ? Buffer.from("corrupt")
            : bytes
          ).toString("base64"),
        };
        await writeFile(
          path.join(root, `${name}.json`),
          JSON.stringify({
            version: "1.0.0",
            file,
            bytes: bytes.length,
            digest: createHash("sha256").update(bytes).digest("hex"),
            url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/${tag}/${file}`,
          }),
        );
      }
      await writeFile(
        path.join(root, "pins.json"),
        JSON.stringify({ formatVersion: 1, pins: ["sdk.json", "tools.json"] }),
      );
      await writeFile(
        path.join(root, "fixtures.json"),
        JSON.stringify(fixtures),
      );
      await writeFile(
        path.join(root, "bin/gh"),
        `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),data=JSON.parse(fs.readFileSync('fixtures.json'));
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[1]==='download')fs.writeFileSync(path.join(args[args.indexOf('--dir')+1],data[args[2]].file),Buffer.from(data[args[2]].bytes,'base64'));
else if(args[1]==='view')console.log(JSON.stringify({isDraft:!fs.existsSync(args[2]+'.published')}));
else if(args[1]==='edit')fs.writeFileSync(args[2]+'.published','yes');else throw Error('Unexpected request');
`,
        { mode: 0o755 },
      );
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "reviewed pins",
        ],
        { cwd: root },
      );
      const run = () =>
        spawnSync(process.execPath, [script, "pins.json"], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        });
      const result = run(),
        calls = (await readFile(path.join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
      if (corrupt) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /differ/);
        assert.equal(calls.filter((args) => args[1] === "edit").length, 0);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const firstEdit = calls.findIndex((args) => args[1] === "edit");
        assert.deepEqual(
          new Set(
            calls
              .slice(0, firstEdit)
              .filter((args) => args[1] === "download")
              .map((args) => args[2]),
          ),
          new Set(["sdk-v1.0.0", "tools-v1.0.0"]),
        );
        assert.equal(calls.filter((args) => args[1] === "edit").length, 2);
        assert.equal(run().status, 0);
        const retried = (await readFile(path.join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(retried.filter((args) => args[1] === "edit").length, 2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
