import assert from "node:assert/strict";
import test from "node:test";
import { ModuleManifestSchema } from "../packages/module-sdk/dist/index.js";

const manifest = (exchange, requiredFeatures) => ({
  formatVersion: 1,
  id: "example-peers",
  name: "Peers",
  version: "1.0.0",
  apiVersion: 1,
  host: { minimumVersion: "2.0.22", requiredFeatures },
  configVersion: 1,
  entry: "module.mjs",
  files: ["module.mjs"],
  capabilities: [],
  settings: [],
  actions: [],
  feedback: [],
  exchange,
});
const features = ["module-exchange-v1", "module-exchange-peers-v1"];

test("a package can declare the peers it works with", () => {
  const parsed = ModuleManifestSchema.parse(
    manifest(
      {
        data: [],
        peers: [
          { data: "tally", version: 1 },
          { data: "router", version: 1, actions: ["route"] },
        ],
      },
      features,
    ),
  );
  assert.deepEqual(parsed.exchange.peers, [
    { data: "tally", version: 1, actions: [] },
    { data: "router", version: 1, actions: ["route"] },
  ]);
});

test("declared peers need the host feature, so an older host refuses the package", () => {
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({ data: [], peers: [{ data: "router", version: 1 }] }, [
          "module-exchange-v1",
        ]),
      ),
    /module-exchange-peers-v1/u,
  );
});

test("the same peer cannot be declared twice", () => {
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest(
          {
            data: [],
            peers: [
              { data: "router", version: 1 },
              { data: "router", version: 1, actions: ["route"] },
            ],
          },
          features,
        ),
      ),
    /Duplicate declared module peer/u,
  );
});
