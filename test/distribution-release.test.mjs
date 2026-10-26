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
