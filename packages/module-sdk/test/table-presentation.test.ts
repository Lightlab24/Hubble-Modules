import { expect, it } from "vitest";
import { ModulePageTableSchema, type ModuleValues } from "../src/index.js";
import { moduleTableComputedRows } from "../src/table-workbook.js";

const table = ModulePageTableSchema.parse({
  type: "table",
  id: "cameras",
  label: "Cameras",
  source: "document",
  documentId: "cameras",
  maxRows: 512,
  columns: ["enabled", "rcpIp", "cameraNumber", "name"].map((id) => ({
    id,
    label: id,
    type: "text",
    required: false,
    default: "",
  })),
  computed: {
    source: "cameraRows",
    columns: ["name"],
    dependencies: { rowFields: ["rcpIp", "cameraNumber"], settingsFields: [] },
  },
});
const row = {
  id: "one",
  values: { enabled: false, rcpIp: "192.0.2.1", cameraNumber: "1" },
};
const settings: ModuleValues = {
  revision: 1,
  cameras: [row],
  camerasView: { version: 1 },
};
const computed = {
  settings,
  rows: [{ id: "one", values: { name: "Camera One" } }],
};
it("keeps observations while selection, revision, order and view change, and invalidates a changed camera target", () => {
  const rows = [{ ...row, values: { ...row.values, enabled: true } }];
  const next = {
    ...settings,
    revision: 2,
    cameras: rows,
    camerasView: { version: 1, textSize: 18 },
  };
  expect(
    moduleTableComputedRows({ table, rows, settings: next, computed }),
  ).toEqual(computed.rows);
  expect(
    moduleTableComputedRows({
      table,
      rows: [{ ...row, values: { ...row.values, cameraNumber: "2" } }],
      settings: next,
      computed,
    }),
  ).toEqual([]);
  expect(
    moduleTableComputedRows({
      table,
      rows: [{ ...row, id: "replacement" }],
      settings: next,
      computed,
    }),
  ).toEqual([]);
});
it("keeps strict invalidation for packages without dependency declarations", () => {
  const strict = {
    ...table,
    computed: { source: "cameraRows", columns: ["name"] },
  };
  expect(
    moduleTableComputedRows({
      table: strict,
      rows: [row],
      settings: { ...settings, revision: 2 },
      computed,
    }),
  ).toEqual([]);
});
