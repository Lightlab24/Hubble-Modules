import assert from "node:assert/strict";
import test from "node:test";
import { ModuleManifestSchema } from "../packages/module-sdk/dist/index.js";

const zoom = {
  id: "zoom",
  label: "Zoom",
  type: "number",
  required: true,
  default: 100,
  min: 10,
  max: 200,
  slider: { step: 0.1, unit: "%" },
};
const manifest = (overrides) => ({
  formatVersion: 1,
  id: "example-slider",
  name: "Slider",
  version: "1.0.0",
  apiVersion: 1,
  host: { minimumVersion: "2.0.22", requiredFeatures: ["module-sliders-v1"] },
  configVersion: 1,
  entry: "module.mjs",
  files: ["module.mjs"],
  capabilities: [],
  actions: [],
  feedback: [],
  settings: [zoom],
  ...overrides,
});

test("a slider field requires the host feature", () => {
  assert.deepEqual(
    ModuleManifestSchema.parse(manifest({})).settings[0].slider,
    {
      step: 0.1,
      unit: "%",
    },
  );
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({ host: { minimumVersion: "2.0.22", requiredFeatures: [] } }),
      ),
    /module-sliders-v1/,
  );
});

test("a slider must be reachable on its own grid", () => {
  for (const settings of [
    [{ ...zoom, default: 100.05 }],
    [{ ...zoom, max: 200.05 }],
    [{ ...zoom, min: undefined }],
    [{ ...zoom, default: null, required: false }],
  ])
    assert.throws(() => ModuleManifestSchema.parse(manifest({ settings })));
});

test("sliders are rejected where they would only edit as Matrix cells", () => {
  const definition = {
    id: "zoom",
    label: "Zoom",
    description: "Zoom",
    fields: [zoom],
  };
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({
          actions: [{ ...definition, completion: "response", timeoutMs: 1000 }],
        }),
      ),
    /not available in action or feedback fields/,
  );
  assert.throws(
    () => ModuleManifestSchema.parse(manifest({ feedback: [definition] })),
    /not available in action or feedback fields/,
  );
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({
          settings: [],
          host: {
            minimumVersion: "2.0.22",
            requiredFeatures: ["module-sliders-v1", "module-pages-v1"],
          },
          pages: [
            {
              id: "rows",
              label: "Rows",
              sections: [
                {
                  type: "table",
                  id: "rows",
                  label: "Rows",
                  source: "settings",
                  maxRows: 2,
                  columns: [zoom],
                },
              ],
            },
          ],
        }),
      ),
    /not available in table columns/,
  );
});
