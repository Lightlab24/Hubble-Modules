import {
  ModuleTableRowsSchema,
  moduleWorkbookField,
  type ModuleTableRow,
} from "@hubble/module-sdk";
import type { SpreadsheetColumn } from "@hubble/module-sdk/spreadsheet-controls";
import { z } from "zod";
import { patchTable } from "./table.js";
import { routesForArea, routeAreas } from "./routes.js";

export const columns = patchTable.columns
  .filter(({ id }) => id !== "mode")
  .map(({ id, label }) => ({
    id,
    label,
    fill: patchTable.workbook?.columns?.[id]?.fill ?? "copy",
  })) satisfies SpreadsheetColumn[];

const defaults = z
  .record(z.string(), z.json())
  .parse(
    Object.fromEntries(
      patchTable.columns.map((column) => [column.id, column.default]),
    ),
  );
export function seed(
  id: string,
  values: ModuleTableRow["values"] = {},
): ModuleTableRow {
  return { id, values: { ...defaults, ...values } };
}

export const defaultPatch = {
  rows: [
    seed("r1", {
      route: "input-10",
      count: 10,
      enabled: true,
      name: "Camera 007",
      address: "10.0.0.250",
      note: 'Line\t"quoted"\nsecond line',
    }),
    seed("r2", {
      route: "input-30",
      count: 13,
      name: "Camera 009",
      address: "10.0.0.253",
      note: "Fixed note",
    }),
    seed("r3"),
    seed("r4", { mode: "locked" }),
    seed("r5", { mode: "unavailable" }),
    seed("r6"),
    seed("r7"),
    seed("r8"),
  ],
  rowsView: { version: 1, hiddenColumns: ["mode"] },
};

export function routeAvailable(row: PatchRow) {
  return routesForArea(row.values.area ?? "any").some(
    (route) => route.value === (row.values.route ?? "none"),
  );
}
export const patchSchema = z.looseObject({ rows: ModuleTableRowsSchema });
export type PatchRow = z.infer<typeof ModuleTableRowsSchema>[number];

export function readCell(row: PatchRow, columnId: string) {
  const column = patchTable.columns.find((field) => field.id === columnId);
  if (!column || column.id === "mode") return null;
  const { availability } = moduleWorkbookField(patchTable, row.values, column);
  if (availability === "unavailable") return null;
  const formula = row.formulas?.[columnId];
  return {
    value:
      column.type === "boolean"
        ? String(row.values[columnId] ?? column.default).toUpperCase()
        : String(row.values[columnId] ?? column.default ?? ""),
    ...(column.type === "boolean" && !formula
      ? { kind: "boolean" as const }
      : {}),
    ...(columnId === "color" ? { kind: "color" as const } : {}),
    acceptsFormula: !!patchTable.workbook?.columns?.[columnId]?.formula,
    readOnly: availability === "read-only",
    formula,
  };
}

const editSchema = z.strictObject({
  rowId: z.string().min(1).max(96),
  columnId: z.string().min(1).max(96),
  value: z.string().max(1000),
  expected: z.string().max(16384),
  expectedFormula: z.string().nullable().optional(),
  formula: z.string().startsWith("=").max(1000).optional(),
});
const batchSchema = z.strictObject({
  source: z.enum([
    "direct",
    "choice",
    "paste",
    "fill",
    "clear",
    "toggle",
    "cut",
    "color",
  ]),
  edits: z
    .array(editSchema)
    .min(1)
    .max(patchTable.maxRows * columns.length),
});
export type PatchBatch = z.infer<typeof batchSchema>;

const rowIds = z.array(z.string().min(1).max(96)).max(patchTable.maxRows);
const rowChangeSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("reorder"),
    ids: rowIds.min(1),
    beforeId: z.string().nullable(),
    expectedOrder: rowIds,
  }),
  z.strictObject({
    source: z.literal("insert"),
    id: z.string().min(1).max(96),
    beforeId: z.string().nullable(),
    expectedOrder: rowIds,
  }),
  z.strictObject({
    source: z.literal("remove"),
    ids: rowIds.min(1),
    expectedOrder: rowIds,
  }),
]);
export type PatchRowChange = z.infer<typeof rowChangeSchema>;
export type PatchChange = PatchBatch | PatchRowChange;

export function changeMatches(
  rows: readonly PatchRow[],
  change: PatchChange,
): boolean {
  if ("edits" in change)
    return change.edits.every((edit) => {
      const row = rows.find(({ id }) => id === edit.rowId);
      const field = row && readCell(row, edit.columnId);
      return (
        field &&
        !field.readOnly &&
        field.value === edit.expected &&
        (field.formula ?? null) === (edit.expectedFormula ?? null)
      );
    });
  return (
    rows.length === change.expectedOrder.length &&
    rows.every(({ id }, index) => id === change.expectedOrder[index])
  );
}

/** Project drafts immediately, including invalid text until its receipt arrives. */
export function projectChange(
  rows: PatchRow[],
  change: PatchChange,
): PatchRow[] {
  if ("edits" in change) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const edit of change.edits) {
      const row = byId.get(edit.rowId);
      if (row)
        byId.set(row.id, {
          ...row,
          values: {
            ...row.values,
            [edit.columnId]: draftValue(edit.columnId, edit.value),
          },
        });
    }
    return rows.map((row) => byId.get(row.id)!);
  }
  if (change.source === "remove")
    return rows.filter(({ id }) => !change.ids.includes(id));
  if (change.source === "insert") {
    if (rows.some(({ id }) => id === change.id)) return rows;
    const next = [...rows];
    const at =
      change.beforeId === null
        ? rows.length
        : rows.findIndex(({ id }) => id === change.beforeId);
    if (at >= 0) next.splice(at, 0, seed(change.id));
    return next;
  }
  const moving = rows.filter(({ id }) => change.ids.includes(id));
  const rest = rows.filter(({ id }) => !change.ids.includes(id));
  const at =
    change.beforeId === null
      ? rest.length
      : rest.findIndex(({ id }) => id === change.beforeId);
  if (at < 0) return rows;
  rest.splice(at, 0, ...moving);
  return rest;
}

export function applyChange(rows: PatchRow[], input: unknown): PatchRow[] {
  if (input && typeof input === "object" && "edits" in input)
    return applyBatch(rows, input);
  const change = rowChangeSchema.parse(input);
  if (!changeMatches(rows, change))
    throw new Error("The row order changed before this edit could save");
  const ids = new Set(rows.map(({ id }) => id));
  if (
    "beforeId" in change &&
    change.beforeId !== null &&
    !ids.has(change.beforeId)
  )
    throw new Error("The destination row is unavailable");
  if (change.source === "insert") {
    if (ids.has(change.id) || rows.length >= patchTable.maxRows)
      throw new Error("Cannot insert this row");
  } else if (
    new Set(change.ids).size !== change.ids.length ||
    change.ids.some((id) => !ids.has(id)) ||
    (change.source === "reorder" &&
      change.beforeId !== null &&
      change.ids.includes(change.beforeId))
  ) {
    throw new Error("Invalid row selection");
  }
  return projectChange(rows, change);
}

export function draftValue(
  columnId: string,
  value: string,
): string | number | boolean | null {
  if (columnId === "route" && value === "") return "none";
  if (columnId === "area" && value === "") return "any";
  if (columnId === "color" && value === "") return "#287FA8";
  if (columnId === "enabled") {
    if (value === "" || /^false$/iu.test(value)) return false;
    if (/^true$/iu.test(value)) return true;
  }
  if (columnId === "count") {
    if (value === "") return null;
    if (/^\d+$/u.test(value) && Number(value) <= 1000000) return Number(value);
  }
  return value;
}

export function applyBatch(rows: PatchRow[], input: unknown): PatchRow[] {
  const batch = batchSchema.parse(input);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const targets = new Set<string>();
  for (const edit of batch.edits) {
    const row = byId.get(edit.rowId);
    const cell = row && readCell(row, edit.columnId);
    const target = `${edit.rowId}/${edit.columnId}`;
    if (
      !row ||
      !cell ||
      cell.readOnly ||
      targets.has(target) ||
      (cell.formula && edit.expectedFormula === undefined)
    )
      throw new Error("Cell is not editable");
    if (
      cell.value !== edit.expected ||
      (cell.formula ?? null) !== (edit.expectedFormula ?? null)
    )
      throw new Error("The cell changed before this edit could save");
    const issue = patchValueIssue(edit.columnId, edit.value);
    if (issue && !edit.formula) throw new Error(issue);
    if (edit.formula && !cell.acceptsFormula)
      throw new Error("This field does not accept formulas");
    const value = edit.formula
      ? (row.values[edit.columnId] ?? null)
      : draftValue(edit.columnId, edit.value);
    if (
      edit.columnId === "route" &&
      !routesForArea("any").some((route) => route.value === value)
    )
      throw new Error("Unknown route ID");
    if (edit.columnId === "count" && typeof value === "string")
      throw new Error("Enter a whole number from 0 to 1,000,000");

    const formulas = { ...row.formulas };
    if (edit.formula) formulas[edit.columnId] = edit.formula;
    else delete formulas[edit.columnId];
    targets.add(target);
    byId.set(row.id, {
      ...row,
      ...(row.formulas || edit.formula ? { formulas } : {}),
      values: { ...row.values, [edit.columnId]: value },
    });
  }
  return rows.map((row) => byId.get(row.id) ?? row);
}

/** The custom editor and native workbook use the same domain validation. */
export function patchValueIssue(columnId: string, value: string) {
  if (columnId === "enabled" && value !== "" && !/^(true|false)$/iu.test(value))
    return "Enter TRUE or FALSE";
  if (columnId === "color" && value !== "" && !/^#[0-9a-f]{6}$/iu.test(value))
    return "Enter a six-digit hex color";
  if (
    columnId === "area" &&
    value !== "" &&
    !routeAreas.some(({ id }) => id === value)
  )
    return "Choose a valid area";
  if (value === "!reject") return "The example rejected this value";
  if (
    columnId === "address" &&
    value !== "" &&
    (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) ||
      value.split(".").some((part) => Number(part) > 255))
  )
    return "Enter a valid IPv4 address";
}
