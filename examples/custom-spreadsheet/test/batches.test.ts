import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBatch, defaultPatch, patchSchema } from "../src/model.js";
import { preparePatch } from "../src/index.js";

const rows = () => patchSchema.parse(defaultPatch).rows;
const edit = (
  rowId: string,
  columnId: string,
  value: string,
  expected = "",
) => ({
  rowId,
  columnId,
  value,
  expected,
});

test("a batch preserves choice IDs and quoted text and validates every target before saving", () => {
  const route = edit("r3", "route", "input-30", "none");
  const note = edit("r3", "note", 'a\t"b"\nc');
  const original = rows();
  const result = applyBatch(original, {
    source: "paste",
    edits: [route, note],
  });
  assert.equal(result[2]?.values.route, "input-30");
  assert.equal(result[2]?.values.note, note.value);
  for (const invalid of [
    { ...route, value: "Camera A" },
    edit("r4", "count", "2"),
    edit("r5", "name", "Camera 11"),
    { ...note, value: "!reject" },
    route,
  ])
    assert.throws(() =>
      applyBatch(original, { source: "paste", edits: [route, invalid] }),
    );
  assert.equal(original[2]?.values.route, "none");
});

test("direct edits preserve unrelated formulas and reject stale or protected targets", () => {
  const original = rows();
  original[0]!.formulas = { count: "=1+9" };
  assert.throws(
    () =>
      applyBatch(original, {
        source: "direct",
        edits: [edit("r1", "count", "12", "10")],
      }),
    /not editable/,
  );
  assert.throws(
    () =>
      applyBatch(original, {
        source: "direct",
        edits: [edit("r2", "name", "New camera", "old label")],
      }),
    /changed/,
  );
  const next = applyBatch(original, {
    source: "direct",
    edits: [edit("r2", "count", "0012", "13")],
  });
  assert.equal(next[1]?.values.count, 12);
  assert.deepEqual(next[0]?.formulas, { count: "=1+9" });
});

test("native workbook saves use the same validation and preserve layout and formulas", () => {
  const workbookRows = rows();
  workbookRows[0]!.formulas = { count: "=4+6" };
  const value = {
    rows: workbookRows,
    rowsView: { version: 1, columnWidths: { route: 222 } },
  };
  const prepare = () =>
    preparePatch({ id: "patch", version: 1, intent: "write", value });
  assert.deepEqual(prepare(), { status: "accepted", value });
  workbookRows[0]!.values.address = "10.0.0.256";
  assert.deepEqual(prepare(), {
    status: "invalid",
    message: "Enter a valid IPv4 address",
    issues: [
      {
        tableId: "rows",
        rowId: "r1",
        fieldId: "address",
        message: "Enter a valid IPv4 address",
      },
    ],
  });
});

test("Name accepts formula sources and preserves existing literal equals text", () => {
  const original = rows();
  original[1]!.values.name = "=";
  const next = applyBatch(original, {
    source: "direct",
    edits: [{ ...edit("r3", "name", "=D2"), formula: "=D2" }],
  });
  assert.deepEqual(next[2]?.formulas, { name: "=D2" });
  assert.equal(next[2]?.values.name, "");
  assert.equal(next[1]?.values.name, "=");
  assert.equal(next[1]?.formulas, undefined);
});

test("legacy rows show unchecked and checkbox edits retain native booleans", () => {
  const original = rows();
  delete original[1]!.values.enabled;
  const checked = applyBatch(original, {
    source: "toggle",
    edits: [edit("r2", "enabled", "TRUE", "FALSE")],
  });
  assert.equal(checked[1]?.values.enabled, true);
  const cleared = applyBatch(checked, {
    source: "clear",
    edits: [edit("r2", "enabled", "", "TRUE"), edit("r2", "count", "", "13")],
  });
  assert.equal(cleared[1]?.values.enabled, false);
  assert.equal(cleared[1]?.values.count, null);
  assert.throws(
    () =>
      applyBatch(original, {
        source: "toggle",
        edits: [edit("r4", "enabled", "TRUE", "FALSE")],
      }),
    /not editable/,
  );
});
