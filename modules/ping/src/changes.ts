/**
 * The changes the Ping page makes from its toolbars, its column list and its grid, built from the
 * document the page holds. What a window is looking at (its sheet, Show last and scale) is no
 * change to the list: each window keeps its own (place.ts). They live here rather than in frontend.ts so that tests run exactly
 * what the page sends, from several copies at once.
 */
import {
  clearedValue,
  clone,
  columnOf,
  normalizeValue,
  valueOf,
  type Bands,
  type CellEdit,
  type Mutation,
  type PingDocument,
  type Settings,
  type View,
} from "./model.js";

type Change<K extends Mutation["kind"]> = Extract<Mutation, { kind: K }>;

export const settingsChange = (document: PingDocument, change: Partial<Settings>): Change<"settings"> => ({
  kind: "settings",
  settings: { ...clone(document.settings), ...change },
  expected: clone(document.settings),
});

export const viewChange = (document: PingDocument, change: Partial<View>): Change<"view"> => ({
  kind: "view",
  view: { ...clone(document.view), ...change },
  expected: clone(document.view),
});

/** The times for the bar colours; null goes back to the colours that follow the alert limit. */
export function bandsChange(document: PingDocument, bands: Bands | null): Change<"view"> {
  const next = clone(document.view);
  if (bands === null) delete next.bands;
  else next.bands = bands;
  return { kind: "view", view: next, expected: clone(document.view) };
}

/** Shows or hides a column from the Columns list. Device always shows. */
export function columnVisibilityChange(document: PingDocument, id: string, visible: boolean): Change<"view"> {
  const hidden = document.view.hidden.filter((item) => item !== id);
  if (!visible) hidden.push(id);
  return viewChange(document, { hidden });
}

/** Moves a column in the Columns list to before another, or to the end. */
export function columnMoveChange(document: PingDocument, id: string, beforeId: string | null): Change<"view"> {
  const order = document.view.order.filter((item) => item !== id);
  const index = beforeId ? order.indexOf(beforeId) : -1;
  order.splice(index < 0 ? order.length : index, 0, id);
  return { ...viewChange(document, { order }), moved: [id] };
}

/** Hide column, from a column header's menu. */
export const hideColumnChange = (document: PingDocument, id: string): Change<"view"> =>
  viewChange(document, { hidden: [...new Set([...document.view.hidden, id])] });

/** A column's width or a row's height, dragged on the grid. */
export function resizeChange(document: PingDocument, axis: "column" | "row", id: string, size: number): Change<"view"> {
  const next = clone(document.view);
  if (axis === "column") next.widths[id] = Math.round(size);
  else next.rowHeights[id] = Math.round(size);
  return { kind: "view", view: next, expected: clone(document.view) };
}

/**
 * Cells typed, pasted, filled or cleared on the grid, as edits to save. A cleared cell takes its
 * column's default; "80 ms" is kept as 80. Each edit says what the cell held when it was made
 * (`expected`, or the value now), so the worker can tell another window's change from this one's.
 * Results columns can't be edited, and a device that is gone has nothing to edit.
 */
export function cellEdits(document: PingDocument, edits: readonly { rowId: string; columnId: string; value: string }[], expected?: string): CellEdit[] {
  return edits.flatMap((edit) => {
    const row = document.devices.find((item) => item.id === edit.rowId);
    const column = columnOf(edit.columnId);
    if (!row || !column || column.live) return [];
    const value = edit.value === "" ? clearedValue(edit.columnId) : normalizeValue(edit.columnId, edit.value);
    return [{ rowId: edit.rowId, columnId: edit.columnId, value, expected: expected ?? valueOf(row, edit.columnId) }];
  });
}
