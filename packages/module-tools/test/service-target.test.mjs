import assert from "node:assert/strict";
import test from "node:test";
import { moduleRequest, runServiceTool } from "../src/service-client.mjs";

test("requires an explicit target instead of silently choosing Hubble2 or production", async () => {
  await assert.rejects(
    moduleRequest({ operation: "describe" }),
    /explicit Hubble service origin/,
  );
  await assert.rejects(
    runServiceTool(["describe"]),
    /explicit Hubble service origin/,
  );
});

test("rejects a credential-bearing or non-origin target before opening a session", async () => {
  for (const url of [
    "http://user:secret@127.0.0.1:42838",
    "http://127.0.0.1:42838/path",
    "file:///tmp/service",
  ])
    await assert.rejects(
      moduleRequest({ operation: "describe" }, { url }),
      /without credentials or a path/,
    );
});
