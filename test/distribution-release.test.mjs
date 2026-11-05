import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  distributionIdentity,
  distributionRelease,
  verifyDistribution,
} from "../scripts/distribution-release.mjs";
test("standalone distributions require exact versioned repository URL, size and digest", () => {
  const bytes = Buffer.from("reviewed distribution");
  const pin = {
    version: "1.0.0",
    file: "hubble-official-module-runtime-1.0.0.tgz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://github.com/Lightlab24/Hubble-Modules/releases/download/runtime-v1.0.0/hubble-official-module-runtime-1.0.0.tgz",
  };
  assert.equal(verifyDistribution(pin, bytes).tag, "runtime-v1.0.0");
  assert.throws(
    () => verifyDistribution(pin, Buffer.from("unreviewed")),
    /differ/,
  );
  assert.throws(
    () =>
      distributionIdentity({
        ...pin,
        url: pin.url.replace("runtime-v1.0.0", "latest"),
      }),
    /URL/,
  );
  assert.throws(
    () => distributionIdentity({ ...pin, file: "../escape.tgz" }),
    /pin/,
  );
});

test("reviewed pin paths still reject absolute paths and parent traversal", async () => {
  for (const file of [
    "/tmp/developer-kit.lock.json",
    "../developer-kit.lock.json",
    "release-review/../developer-kit.lock.json",
    "C:\\review\\developer-kit.lock.json",
  ]) {
    await assert.rejects(
      distributionRelease("verify", file),
      /repository-relative reviewed pin/,
    );
  }
});

test("reviewed developer kit previews keep their prerelease identity", () => {
  const bytes = Buffer.from("reviewed kit");
  const version = "1.8.1-dev.1";
  const file = `hubble-module-developer-kit-${version}.tar.gz`;
  const releaseUrl = "https://github.com/Lightlab24/Hubble-Modules/releases/download";
  const pin = {
    version,
    file,
    bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
    url: `${releaseUrl}/developer-kit-v${version}/${file}`,
  };
  assert.deepEqual(verifyDistribution(pin, bytes), {
    tag: `developer-kit-v${version}`,
    digest: pin.digest,
    isPrerelease: true,
  });

  const runtimeFile = `hubble-official-module-runtime-${version}.tgz`;
  assert.throws(
    () =>
      distributionIdentity({
        ...pin,
        file: runtimeFile,
        url: `${releaseUrl}/runtime-v${version}/${runtimeFile}`,
      }),
    /Only developer kits/,
  );
});
