import { leftAlone, mergeOrder, mergeRecord, mergeValue, quietly, same, type Merge } from "./merge.js";

/**
 * The Flanders page's saved data: one row per monitor, kept in the workspace's
 * portable "monitor-plan" document, plus the page's column widths and text size.
 * Values are stored as the strings the grid shows; `enabled` is TRUE or FALSE.
 */
export const DOCUMENT_ID = "monitor-plan";
export const DEFAULT_PORT = 18181;
export const MAX_MONITORS = 64;

export type ColumnId = "name" | "enabled" | "host" | "port" | "whenInUse" | "status";
export interface Column {
  readonly id: ColumnId;
  readonly label: string;
  readonly width: number;
  readonly fill: "copy" | "series";
}
export const columns: readonly Column[] = [
  { id: "name", label: "Monitor", width: 180, fill: "series" },
  { id: "enabled", label: "Enabled", width: 92, fill: "copy" },
  { id: "host", label: "IP address", width: 160, fill: "series" },
  { id: "port", label: "Port", width: 90, fill: "copy" },
  { id: "whenInUse", label: "When another app is connected", width: 250, fill: "copy" },
  { id: "status", label: "Status", width: 380, fill: "copy" },
];
export const editableColumns = columns.filter((column) => column.id !== "status").map((column) => column.id);
export const whenInUseChoices = [
  { value: "wait", label: "Don't send the key" },
  { value: "send", label: "Send anyway" },
] as const;

export interface MonitorRow {
  readonly id: string;
  readonly values: Record<string, string>;
}
export interface View {
  textSize?: number;
  widths: Record<string, number>;
  rowHeights: Record<string, number>;
}
export interface MonitorDocument {
  version: 1;
  monitors: MonitorRow[];
  view: View;
}
export interface CellEdit {
  rowId: string;
  columnId: string;
  value: string;
  /** The value the edit was made over: another window may have saved a different one since. */
  expected: string;
}
/**
 * A change, as the copy of the page that made it saw it: `expected` is what it read, the other
 * half what it wants. The worker puts only the difference onto what is saved now (see merge.ts),
 * so a copy that hasn't caught up with another window yet is never refused for that.
 * `strict` marks an Undo or Redo, which is refused rather than undo another window's work.
 */
export type Mutation = (
  | { kind: "edit"; edits: CellEdit[] }
  /** Adding, removing and moving monitors, as one step. `moved`: the monitors a move moved. */
  | { kind: "rows"; rows: MonitorRow[]; expected: MonitorRow[]; moved?: string[] }
  | { kind: "view"; view: View; expected: View }
) & { strict?: boolean };

export const clone = <T>(value: T): T => structuredClone(value);
export { same };
export const valueOf = (row: MonitorRow, columnId: string) => row.values[columnId] ?? "";
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function defaultDocument(): MonitorDocument {
  return { version: 1, monitors: [], view: { textSize: 13, widths: {}, rowHeights: {} } };
}

export function validHost(value: string): boolean {
  if (value.length > 253 || value.includes("..") || value.startsWith(".") || value.endsWith(".")) return false;
  if (/^[0-9.]+$/u.test(value)) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
  }
  return value.split(".").every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(part));
}

/** Why a value can't go in a cell, or undefined when it can. */
export function validateValue(columnId: string, value: string): string | undefined {
  if (typeof value !== "string" || value.length > 256) return "Enter up to 256 characters.";
  switch (columnId) {
    case "name":
      return value.trim() && value.trim().length <= 64 ? undefined : "Give the monitor a name of up to 64 characters.";
    case "enabled":
      return value === "TRUE" || value === "FALSE" ? undefined : "Tick or untick Enabled.";
    case "host":
      return !value || validHost(value) ? undefined : "Enter an IPv4 address such as 192.168.1.20, or a host name.";
    case "port":
      return /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? undefined : "Use a port from 1 to 65535.";
    case "whenInUse":
      return whenInUseChoices.some((choice) => choice.value === value) ? undefined : "Choose Don't send the key or Send anyway.";
    default:
      return "This column can't be edited.";
  }
}

/** A cleared cell takes its column's default, except a name, which a monitor must have. */
export function clearedValue(columnId: string): string {
  return { enabled: "FALSE", port: String(DEFAULT_PORT), whenInUse: "wait" }[columnId] ?? "";
}

function validateView(view: View) {
  if (!view || typeof view !== "object") throw Error("Invalid page layout.");
  if (view.textSize !== undefined && (!Number.isInteger(view.textSize) || view.textSize < 9 || view.textSize > 24))
    throw Error("Use a text size from 9 to 24.");
  for (const [id, width] of Object.entries(view.widths ?? {}))
    if (!columns.some((column) => column.id === id) || !Number.isFinite(width) || width < 60 || width > 800)
      throw Error("Invalid column width.");
  for (const height of Object.values(view.rowHeights ?? {}))
    if (!Number.isFinite(height) || height < 28 || height > 200) throw Error("Invalid row height.");
}

/** Checks a whole document, including that no two monitors share a name. */
export function validateDocument(value: unknown): MonitorDocument {
  const doc = value as MonitorDocument;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.monitors) || !doc.view) throw Error("The monitor list can't be read.");
  if (doc.monitors.length > MAX_MONITORS) throw Error(`Use up to ${MAX_MONITORS} monitors.`);
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const row of doc.monitors) {
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 96 || ids.has(row.id)) throw Error("Invalid monitor identity.");
    ids.add(row.id);
    if (!row.values || typeof row.values !== "object") throw Error("Invalid monitor row.");
    for (const columnId of editableColumns) {
      const problem = validateValue(columnId, valueOf(row, columnId));
      if (problem) throw Error(problem);
    }
    const name = valueOf(row, "name").trim().toLowerCase();
    if (names.has(name)) throw Error(`Another monitor is already called ${valueOf(row, "name").trim()}. Buttons pick monitors by name.`);
    names.set(name, row.id);
  }
  validateView(doc.view);
  return doc;
}

const monitorName = (row: MonitorRow) => valueOf(row, "name").trim() || "A monitor";
const cellName = (row: MonitorRow, columnId: string) => `${monitorName(row)}'s ${columns.find((column) => column.id === columnId)?.label ?? columnId}`;

/** The monitor list with this copy's additions, removals, moves and values put onto the one saved now. */
function mergeRows(base: readonly MonitorRow[], mine: readonly MonitorRow[], theirs: readonly MonitorRow[], merge: Merge, moved?: readonly string[]): MonitorRow[] {
  const was = new Map(base.map((row) => [row.id, row]));
  const wanted = new Map(mine.map((row) => [row.id, row]));
  const now = new Map(theirs.map((row) => [row.id, row]));
  // An Undo takes out only a monitor as this copy left it, never one another window has changed since.
  if (merge.strict)
    for (const [id, row] of was) {
      const current = now.get(id);
      if (!wanted.has(id) && current && !same(current, row)) throw leftAlone(monitorName(current));
    }
  return mergeOrder([...was.keys()], [...wanted.keys()], [...now.keys()], moved).map((id) => {
    const current = now.get(id);
    const before = was.get(id);
    const after = wanted.get(id);
    if (!current) return clone(after!);
    if (!before || !after) return current;
    return { ...current, values: mergeRecord((columnId) => cellName(current, columnId), before.values, after.values, current.values, merge) };
  });
}

/**
 * A monitor the page named "Monitor N" by itself takes the next free number if another window's
 * monitor has that name by now. A name someone gave it is never changed.
 */
function freeNames(next: MonitorDocument, added: ReadonlySet<string>) {
  next.monitors.forEach((row, index) => {
    const name = valueOf(row, "name").trim();
    if (!added.has(row.id) || !/^Monitor \d+$/u.test(name)) return;
    const taken = (candidate: string) => next.monitors.some((other) => other.id !== row.id && sameName(valueOf(other, "name"), candidate));
    if (!taken(name)) return;
    let number = next.monitors.length;
    while (taken(`Monitor ${number}`)) number++;
    next.monitors[index] = { ...row, values: { ...row.values, name: `Monitor ${number}` } };
  });
}

/**
 * Puts a change onto the document as it is saved now. A change made from an older copy changes
 * only what that copy changed (see merge.ts). `clashes` collects what another window had also
 * changed, which this change's value now replaces.
 */
export function applyMutation(document: MonitorDocument, operation: Mutation, clashes: string[] = []): MonitorDocument {
  const next = clone(document);
  const merge: Merge = { strict: operation.strict === true, clashes };
  if (operation.kind === "edit") {
    for (const edit of operation.edits) {
      const row = next.monitors.find((item) => item.id === edit.rowId);
      if (!row) throw Error("That monitor was removed before the change saved.");
      const now = valueOf(row, edit.columnId);
      if (now !== edit.expected && now !== edit.value) {
        if (merge.strict) throw leftAlone(cellName(row, edit.columnId));
        clashes.push(cellName(row, edit.columnId));
      }
      const problem = validateValue(edit.columnId, edit.value);
      if (problem) throw Error(problem);
      row.values[edit.columnId] = edit.value;
    }
  } else if (operation.kind === "rows") {
    const had = new Set(next.monitors.map((row) => row.id));
    next.monitors = mergeRows(operation.expected, operation.rows, next.monitors, merge, operation.moved);
    freeNames(next, new Set(next.monitors.filter((row) => !had.has(row.id)).map((row) => row.id)));
  } else {
    // The layout: the newest change to each part wins, so a layout change is never refused.
    const layout = quietly();
    const { expected: base, view: mine } = operation;
    const out: View = {
      ...next.view,
      widths: mergeRecord(() => "", base.widths ?? {}, mine.widths ?? {}, next.view.widths ?? {}, layout),
      rowHeights: mergeRecord(() => "", base.rowHeights ?? {}, mine.rowHeights ?? {}, next.view.rowHeights ?? {}, layout),
    };
    const textSize = mergeValue("", base.textSize, mine.textSize, next.view.textSize, layout);
    if (textSize === undefined) delete out.textSize;
    else out.textSize = textSize;
    next.view = out;
  }
  return validateDocument(next);
}

export function inverse(before: MonitorDocument, operation: Mutation): Mutation {
  if (operation.kind === "edit")
    return {
      kind: "edit",
      edits: operation.edits.map((edit) => {
        const row = before.monitors.find((item) => item.id === edit.rowId)!;
        return { rowId: edit.rowId, columnId: edit.columnId, value: valueOf(row, edit.columnId), expected: edit.value };
      }),
    };
  if (operation.kind === "rows")
    return { kind: "rows", rows: clone(operation.expected), expected: clone(operation.rows), ...(operation.moved ? { moved: [...operation.moved] } : {}) };
  return { kind: "view", view: clone(operation.expected), expected: clone(operation.view) };
}

/** A new monitor, named after the first free "Monitor N". */
export function newMonitor(document: MonitorDocument, id: string): MonitorRow {
  let number = document.monitors.length + 1;
  while (document.monitors.some((row) => sameName(valueOf(row, "name"), `Monitor ${number}`))) number++;
  return { id, values: { name: `Monitor ${number}`, enabled: "TRUE", host: "", port: String(DEFAULT_PORT), whenInUse: "wait" } };
}

export function insertRows(document: MonitorDocument, rows: MonitorRow[], beforeId: string | null): Mutation {
  const next = clone(document.monitors);
  const index = beforeId ? next.findIndex((row) => row.id === beforeId) : -1;
  next.splice(index < 0 ? next.length : index, 0, ...rows);
  return { kind: "rows", rows: next, expected: clone(document.monitors) };
}

export function removeRows(document: MonitorDocument, ids: readonly string[]): Mutation {
  return { kind: "rows", rows: document.monitors.filter((row) => !ids.includes(row.id)), expected: clone(document.monitors) };
}

export function moveRows(document: MonitorDocument, ids: readonly string[], beforeId: string | null): Mutation | null {
  const moving = document.monitors.filter((row) => ids.includes(row.id));
  const rest = document.monitors.filter((row) => !ids.includes(row.id));
  const index = beforeId ? rest.findIndex((row) => row.id === beforeId) : -1;
  rest.splice(index < 0 ? rest.length : index, 0, ...moving);
  return same(rest.map((row) => row.id), document.monitors.map((row) => row.id))
    ? null
    : { kind: "rows", rows: clone(rest), expected: clone(document.monitors), moved: moving.map((row) => row.id) };
}

/** What a monitor shows in Status before anything has happened to it. */
export function idleStatus(row: MonitorRow): string {
  if (valueOf(row, "enabled") !== "TRUE") return "Off";
  if (!valueOf(row, "host")) return "Needs an IP address";
  return "Ready";
}
