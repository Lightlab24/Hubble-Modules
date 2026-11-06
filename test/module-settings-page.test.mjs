import assert from "node:assert/strict";
import test from "node:test";
import { ModuleManifestSchema } from "../packages/module-sdk/dist/index.js";

const page = (overrides = {}) => ({
  id: "app",
  label: "App",
  placement: "module-settings",
  sections: [
    {
      type: "custom",
      id: "app",
      label: "App",
      entry: "ui/index.html",
      height: 48,
      commands: [],
    },
  ],
  ...overrides,
});
const descriptor = (features, pageValue) => ({
  formatVersion: 1,
  apiVersion: 1,
  id: "example-settings-page",
  name: "Example",
  version: "1.0.0",
  host: { minimumVersion: "2.0.11", requiredFeatures: features },
  configVersion: 1,
  entry: "module.mjs",
  files: ["module.mjs", "ui/index.html"],
  capabilities: ["service.page.app"],
  settings: [],
  actions: [],
  feedback: [],
  pages: [pageValue],
});
const base = ["module-pages-v1", "module-custom-pages-v1"];

test("a short custom frontend can be placed in module settings", () => {
  const manifest = ModuleManifestSchema.parse(
    descriptor([...base, "module-settings-pages-v1"], page()),
  );
  assert.equal(manifest.pages[0].placement, "module-settings");
});

test("placement requires its host feature", () => {
  const result = ModuleManifestSchema.safeParse(descriptor(base, page()));
  assert.equal(result.success, false);
  assert.match(
    JSON.stringify(result.error.issues),
    /module-settings-pages-v1/u,
  );
});

test("a module-settings page holds only custom frontends", () => {
  const result = ModuleManifestSchema.safeParse(
    descriptor(
      [...base, "module-settings-pages-v1"],
      page({
        sections: [{ type: "status", id: "state", label: "State", fields: [] }],
      }),
    ),
  );
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error.issues), /module-settings page/u);
});
