/**
 * The changes the Flanders page makes from its toolbar and its grid, built from the document the
 * page holds. They live here rather than in the page's scripts so that tests run exactly what the
 * page sends, from several copies at once.
 */
import { clearedValue, clone, columns, valueOf, type CellEdit, type MonitorDocument, type Mutation } from "./model.js";

type Change<K extends Mutation["kind"]> = Extract<Mutation, { kind: K }>;

/** The text size from the toolbar. */
export const textSizeChange = (document: MonitorDocument, size: number): Change<"view"> => ({
  kind: "view",
  view: { ...clone(document.view), textSize: size },
  expected: clone(document.view),
});

/** A column's width or a row's height, dragged on the grid. */
export function resizeChange(document: MonitorDocument, axis: "column" | "row", id: string, size: number): Change<"view"> {
  const next = clone(document.view);
  if (axis === "column") next.widths[id] = Math.round(size);
  else next.rowHeights[id] = Math.round(size);
  return { kind: "view", view: next, expected: clone(document.view) };
}

/**
 * Cells typed, pasted, filled or cleared on the grid, as edits to save. A cleared cell takes its
 * column's default. Each edit says what the cell held when it was made (`expected`, or the value
 * now), so the worker can tell another window's change from this one's. Status can't be edited,
 * and a monitor that is gone has nothing to edit.
 */
export function cellEdits(document: MonitorDocument, edits: readonly { rowId: string; columnId: string; value: string }[], expected?: string): CellEdit[] {
  return edits.flatMap((edit) => {
    const row = document.monitors.find((item) => item.id === edit.rowId);
    if (!row || edit.columnId === "status" || !columns.some((column) => column.id === edit.columnId)) return [];
    const value = edit.value === "" ? clearedValue(edit.columnId) : edit.value;
    return [{ rowId: edit.rowId, columnId: edit.columnId, value, expected: expected ?? valueOf(row, edit.columnId) }];
  });
}
