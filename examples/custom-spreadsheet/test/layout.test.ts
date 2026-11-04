import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModuleManifestSchema,
  validateModuleDocument,
} from "@hubble/module-sdk";
import { applyChange, defaultPatch, patchSchema } from "../src/model.js";
import {
  defaultLayout,
  multipleSheets,
  withWorksheets,
  workbookFromDocument,
} from "../src/workbook-state.js";
import { preparePatch } from "../src/index.js";
import manifest from "../src/manifest.js";

const initial = () => patchSchema.parse(defaultPatch).rows;
const order = (rows: { id: string }[]) => rows.map(({ id }) => id);

test("row moves preserve values, formulas and portable layout through transfer", () => {
  const document = structuredClone(defaultPatch) as typeof defaultPatch & {
    rows: ReturnType<typeof initial>;
  };
  document.rows[0]!.formulas = { count: "=4+6" };
  const before = order(document.rows);
  document.rows = applyChange(document.rows, {
    source: "reorder",
    ids: ["r2", "r1"],
    beforeId: null,
    expectedOrder: before,
  });
  assert.deepEqual(order(document.rows), [
    "r3",
    "r4",
    "r5",
    "r6",
    "r7",
    "r8",
    "r1",
    "r2",
  ]);
  assert.deepEqual(document.rows.at(-2)!.formulas, { count: "=4+6" });
  const imported = JSON.parse(JSON.stringify(document));
  assert.deepEqual(
    preparePatch({
      id: "patch",
      version: 1,
      intent: "import",
      value: imported,
    }),
    { status: "accepted", value: document },
  );
  assert.throws(
    () =>
      applyChange(document.rows, {
        source: "remove",
        ids: ["r1"],
        expectedOrder: before,
      }),
    /order changed/,
  );
});

test("custom workbook preferences are portable and older documents use one custom sheet", () => {
  const legacy = workbookFromDocument(defaultPatch);
  assert.equal(legacy.view.sheets.length, 1);
  assert.equal(legacy.view.groupExpansion["patch-details"], undefined);
  const customView = {
    ...defaultLayout,
    columnOrder: [
      "enabled",
      "route",
      "count",
      "name",
      "address",
      "note",
      "area",
      "color",
    ],
    columnWidths: { count: 319 },
    rowHeights: { r1: 61 },
    hiddenColumns: ["mode", "enabled"],
    groupExpansion: { "patch-details": true },
    collapsedFields: ["address"],
    colorFavorites: ["#287FA8", "#DC5A0F"],
    frozenColumns: 2,
    textSize: 18,
  };
  const value = { ...defaultPatch, customView };
  const restored = JSON.parse(JSON.stringify(value));
  assert.deepEqual(workbookFromDocument(restored).view, customView);
  assert.deepEqual(preparePatch({ id: "patch", version: 1, value: restored }), {
    status: "accepted",
    value,
  });
  if (!multipleSheets)
    assert.throws(() =>
      workbookFromDocument({
        ...value,
        customView: {
          ...customView,
          sheets: [...customView.sheets, { id: "two", name: "Two" }],
        },
      }),
    );
});

test("opt-in worksheets share membership while keeping both layouts valid", () => {
  const { nativeView } = workbookFromDocument(defaultPatch);
  const customView = {
    ...defaultLayout,
    columnWidths: { count: 319 },
    groupExpansion: { "patch-details": true },
    sheets: [...defaultLayout.sheets, { id: "two", name: "Two" }],
    sheetByRowId: { r1: "two" },
  };
  const rowsView = withWorksheets(nativeView, customView);
  assert.deepEqual(rowsView, {
    ...nativeView,
    sheets: customView.sheets,
    sheetByRowId: customView.sheetByRowId,
  });
  const packagedManifest = ModuleManifestSchema.parse({
    ...manifest,
    id: "example-custom-spreadsheet",
    name: "Custom spreadsheet example",
    version: "0.6.7",
    entry: "index.mjs",
    files: ["index.mjs", "ui/index.html", "ui/app.js"],
  });
  validateModuleDocument(packagedManifest, "patch", {
    ...defaultPatch,
    customView,
    rowsView,
  });
  if (multipleSheets) {
    const updated = { ...rowsView, sheetByRowId: { r2: "two" } };
    const reopened = workbookFromDocument({
      ...defaultPatch,
      customView,
      rowsView: updated,
    });
    assert.deepEqual(reopened.view, {
      ...customView,
      sheetByRowId: { r2: "two" },
    });
  }
});
