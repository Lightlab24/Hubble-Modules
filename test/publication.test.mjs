import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  createModulePackage,
  inspectModulePackage,
  verifyModuleCatalog,
} from "../scripts/sdk-validation.mjs";
import { signCatalog } from "../scripts/catalog-policy.mjs";

const script = fileURLToPath(
  new URL("../scripts/publish.mjs", import.meta.url),
);
const template = JSON.parse(
  await readFile(
    new URL("../tools/templates/simulator/hubble-module.json", import.meta.url),
    "utf8",
  ),
);
for (const scenario of ["draft", "already-published", "corrupt"]) {
  test(`publication ${scenario}: exact bytes, ordered publication, and recovery`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hubble-publication-test-"));
    try {
      await mkdir(path.join(root, "bin"));
      await mkdir(path.join(root, "keys"));
      const pair = generateKeyPairSync("ed25519");
      const pem = pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      const keys = {
        test: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
      const before = {
        formatVersion: 1,
        sequence: 0,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        releases: [],
      };
      const current = signCatalog(before, "test", pem, keys);
      const bytes = createModulePackage(
        template,
        new Map([
          [
            "module.mjs",
            Buffer.from('throw Error("publisher must not execute")'),
          ],
        ]),
      );
      const inspected = inspectModulePackage(bytes);
      const tag = `module-${template.id}-v${template.version}`;
      const filename = `${template.id}-${template.version}.hubble-module`;
      const next = {
        ...before,
        sequence: 1,
        releases: [
          {
            identity: {
              moduleId: template.id,
              version: template.version,
              digest: inspected.digest,
            },
            manifest: inspected.manifest,
            bytes: bytes.length,
            url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/${tag}/${filename}`,
            channel: "beta",
            notes: "Test",
            publishedAt: before.issuedAt,
            status: "active",
          },
        ],
      };
      await writeFile(
        path.join(root, "keys/catalog.json"),
        JSON.stringify(keys),
      );
      await writeFile(
        path.join(root, "catalog-input.json"),
        JSON.stringify(next),
      );
      await writeFile(
        path.join(root, "fixture.json"),
        JSON.stringify({
          scenario,
          tag,
          filename,
          length: bytes.length,
          current: {
            sha: "previous-content-sha",
            content: Buffer.from(JSON.stringify(current)).toString("base64"),
          },
        }),
      );
      await writeFile(
        path.join(root, "archive"),
        scenario === "corrupt" ? Buffer.alloc(bytes.length) : bytes,
      );
      const mock = `#!/usr/bin/env node
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),f=JSON.parse(readFileSync('fixture.json'));
appendFileSync('operations.jsonl',JSON.stringify(args)+'\\n');
if(args.includes('PUT')) { const input=JSON.parse(readFileSync(args[args.indexOf('--input')+1])); if(input.sha!=='previous-content-sha')throw Error('Missing compare-and-swap'); writeFileSync('published.json',Buffer.from(input.content,'base64')); console.log('{}'); }
else if(args[0]==='release'&&args[1]==='edit')console.log('{}');
else if(args[0]==='release'&&args[1]==='view')console.log(JSON.stringify({apiUrl:'https://api.github.com/repos/Lightlab24/Hubble-Modules/releases/123'}));
else if(args[1]?.endsWith('/contents/catalog.json'))console.log(JSON.stringify(f.current));
else if(args[1]?.endsWith('/releases/123'))console.log(JSON.stringify({draft:f.scenario!=='already-published',assets:[{name:f.filename,id:42,size:f.length,state:'uploaded'}]}));
else if(args[1]?.endsWith('/releases/assets/42'))process.stdout.write(readFileSync('archive'));
else throw Error('Unexpected request '+args);
`;
      await writeFile(path.join(root, "bin/gh"), mock, { mode: 0o755 });
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
          "fixture",
        ],
        { cwd: root },
      );
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          GITHUB_REPOSITORY: "Lightlab24/Hubble-Modules",
          GITHUB_REF: "refs/heads/main",
          GH_TOKEN: "test-token",
          MODULE_SIGNING_KEY_ID: "test",
          MODULE_SIGNING_PRIVATE_KEY: pem,
        },
      });
      const operations = (
        await readFile(path.join(root, "operations.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      const edits = operations.filter(
        (args) => args[0] === "release" && args[1] === "edit",
      );
      const puts = operations.filter((args) => args.includes("PUT"));
      if (scenario === "corrupt") {
        assert.notEqual(result.status, 0);
        assert.equal(edits.length, 0);
        assert.equal(puts.length, 0);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(edits.length, scenario === "draft" ? 1 : 0);
        assert.equal(puts.length, 1);
        assert(operations.at(-1).includes("PUT"));
        const published = JSON.parse(
          await readFile(path.join(root, "published.json"), "utf8"),
        );
        assert.equal(
          verifyModuleCatalog(published, keys).releases[0].identity.digest,
          inspected.digest,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
