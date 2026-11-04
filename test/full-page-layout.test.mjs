import test from "node:test";
import assert from "node:assert/strict";
import {
  ModuleManifestSchema,
  moduleCompatibility,
} from "../packages/module-sdk/dist/index.js";
import {
  createModulePackage,
  inspectModulePackage,
} from "../packages/module-sdk/dist/package.js";

function manifest() {
  return {
    formatVersion: 1,
    apiVersion: 1,
    id: "example-full-page",
    name: "Example",
    version: "1.0.0",
    host: {
      minimumVersion: "2.0.18",
      requiredFeatures: [
        "module-pages-v1",
        "module-custom-pages-v1",
        "module-custom-pages-full-page-v1",
      ],
    },
    configVersion: 1,
    entry: "module.mjs",
    files: ["module.mjs", "ui/index.html"],
    capabilities: ["service.page.app"],
    settings: [],
    actions: [],
    feedback: [],
    pages: [
      {
        id: "app",
        label: "App",
        layout: "full-page",
        sections: [
          {
            type: "custom",
            id: "app",
            label: "Application",
            entry: "ui/index.html",
            commands: [],
          },
        ],
      },
    ],
  };
}
test("the public SDK preserves full-page manifests in portable archives and negotiates host support", () => {
  const input = manifest();
  const parsed = ModuleManifestSchema.parse(input);
  const archive = createModulePackage(
    parsed,
    new Map([
      ["module.mjs", Buffer.from("export default {}")],
      ["ui/index.html", Buffer.from("<!doctype html><title>App</title>")],
    ]),
  );
  assert.equal(
    inspectModulePackage(archive).manifest.pages[0].layout,
    "full-page",
  );
  assert.equal(
    moduleCompatibility(parsed, {
      version: "2.0.18",
      apiVersions: [1],
      features: input.host.requiredFeatures,
    }),
    null,
  );
  assert.match(
    moduleCompatibility(parsed, {
      version: "2.0.17",
      apiVersions: [1],
      features: input.host.requiredFeatures,
    }),
    /2.0.18/,
  );
  for (const minimumVersion of ["2.0.17", "2.0.18-rc.1"])
    assert.throws(
      () =>
        ModuleManifestSchema.parse({
          ...input,
          host: { ...input.host, minimumVersion },
        }),
      /requires Hubble 2.0.18/,
    );
  input.host.requiredFeatures.pop();
  assert.throws(
    () => ModuleManifestSchema.parse(input),
    /module-custom-pages-full-page-v1/,
  );
});
test("full-page requires one custom section; default and explicit section layouts retain mixed pages", () => {
  const input = manifest();
  const status = {
    type: "status",
    id: "status",
    label: "Status",
    fields: [],
  };
  input.pages[0].sections.push(status);
  assert.throws(
    () => ModuleManifestSchema.parse(input),
    /exactly one custom/,
  );
  for (const layout of [undefined, "sections"]) {
    input.pages[0].layout = layout;
    input.pages[0].sections[0].height = 430;
    const parsed = ModuleManifestSchema.parse(input);
    assert.equal(parsed.pages[0].sections[0].height, 430);
    assert.equal(parsed.pages[0].sections.length, 2);
  }
  input.pages[0].layout = "full-page";
  input.pages[0].sections = [status];
  assert.throws(
    () => ModuleManifestSchema.parse(input),
    /exactly one custom/,
  );
});

test("explicit section layout also requires its advertised host contract", () => {
  const input = manifest();
  input.pages[0].layout = "sections";
  input.host.requiredFeatures.pop();
  assert.throws(() => ModuleManifestSchema.parse(input), /module-custom-pages-full-page-v1/);
});
