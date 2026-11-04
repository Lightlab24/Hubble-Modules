import {
  ModuleTableViewStateSchema,
  ModuleTableRowsSchema,
} from "@hubble/module-sdk";
import { z } from "zod";
import { patchGroup, patchTable } from "./table.js";

// Set this explicitly for a module that wants multiple custom worksheets.
export const multipleSheets = false;

const ids = new Set(patchTable.columns.map(({ id }) => id));
export const PatchLayoutSchema = ModuleTableViewStateSchema.safeExtend({
  collapsedFields: z
    .array(z.string())
    .min(1)
    .max(patchGroup.fields.length)
    .refine(
      (fields) =>
        new Set(fields).size === fields.length &&
        fields.every((id) => patchGroup.fields.includes(id)),
    )
    .default(["name"]),
  colorFavorites: z
    .array(z.string().regex(/^#[0-9a-f]{6}$/iu))
    .max(8)
    .default([]),
}).refine(
  (view) =>
    (multipleSheets || view.sheets.length === 1) &&
    [
      ...view.columnOrder,
      ...view.hiddenColumns,
      ...Object.keys(view.columnWidths),
    ].every((id) => ids.has(id)) &&
    Object.keys(view.groupExpansion).every((id) => id === patchGroup.id) &&
    view.frozenColumns <= ids.size,
);
export type PatchLayout = z.infer<typeof PatchLayoutSchema>;
export const defaultLayout = PatchLayoutSchema.parse({
  version: 1,
  hiddenColumns: ["mode"],
  columnWidths: {
    route: 260,
    count: 250,
    enabled: 94,
    name: 328,
    address: 220,
    note: 280,
    area: 140,
    color: 120,
  },
  textSize: 13,
});

export const WorkbookStateSchema = z.strictObject({
  rows: ModuleTableRowsSchema.max(patchTable.maxRows),
  view: PatchLayoutSchema,
  nativeView: ModuleTableViewStateSchema,
});
export type WorkbookState = z.infer<typeof WorkbookStateSchema>;
export type WorkbookSnapshot = WorkbookState & {
  sequence: number;
  batches: number;
};
export const workbookFromDocument = (value: unknown): WorkbookState => {
  const input = z
    .looseObject({
      rows: ModuleTableRowsSchema,
      customView: z.unknown().optional(),
      rowsView: z.unknown().optional(),
    })
    .parse(value);
  const workbook = WorkbookStateSchema.parse({
    rows: input.rows,
    view: input.customView ?? defaultLayout,
    nativeView: input.rowsView ?? { version: 1, hiddenColumns: ["mode"] },
  });
  // In the opt-in mode, both editors use the native sheet membership.
  if (multipleSheets && input.rowsView)
    workbook.view = withWorksheets(workbook.view, workbook.nativeView);
  return workbook;
};

export const withWorksheets = <T extends WorkbookState["nativeView"]>(
  layout: T,
  worksheets: Pick<T, "sheets" | "sheetByRowId">,
): T => ({
  ...layout,
  sheets: worksheets.sheets,
  sheetByRowId: worksheets.sheetByRowId,
});

export const cleanLayout = <T extends WorkbookState["nativeView"]>(
  view: T,
  rows: WorkbookState["rows"],
): T => {
  const ids = new Set(rows.map(({ id }) => id));
  return {
    ...view,
    rowHeights: Object.fromEntries(
      Object.entries(view.rowHeights).filter(([id]) => ids.has(id)),
    ),
    sheetByRowId: Object.fromEntries(
      Object.entries(view.sheetByRowId).filter(([id]) => ids.has(id)),
    ),
  };
};
