import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModuleManifestSchema,
  validateModuleSettings,
} from "@hubble/module-sdk";
import descriptor from "../src/manifest.js";

test("native workbook example declares the public contract and preserves portable data", () => {
  const manifest = ModuleManifestSchema.parse({
    ...descriptor,
    formatVersion: 1,
    id: "example-native-workbook",
    name: "Native workbook",
    version: "0.1.0",
    entry: "module.mjs",
    files: ["module.mjs"],
  });
  const settings = {
    rows: [
      {
        id: "stable-row",
        values: { name: "Camera 02", value: 7 },
        formulas: { value: "=SUM(3,4)" },
      },
    ],
    planView: {
      version: 1,
      sheets: [{ id: "studio", name: "Studio" }],
      sheetByRowId: { "stable-row": "studio" },
      textSize: 15,
      frozenColumns: 1,
    },
  };
  validateModuleSettings(manifest, settings);
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
  validateModuleSettings(manifest, {});
});
