import { mergeOrder, mergeRecord, mergeSet, mergeValue, quietly, same, leftAlone, type Merge } from "./merge.js";

/**
 * The Ping page's saved data: one row per device, the ping time and size every
 * device shares, and the page's layout. It lives in the workspace's portable
 * "ping-plan" document. Cell values are stored as the strings the grid edits;
 * `enabled` is TRUE or FALSE. Ping results are never saved.
 */
export const DOCUMENT_ID = "ping-plan";
export const MAX_DEVICES = 128;

export const INTERVALS_MS = [200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000] as const;
export const SIZES_BYTES = [32, 56, 128, 512, 1024, 1400] as const;
export const SPANS = [
  { id: "1m", label: "1 min", heading: "Last 1 Min", ms: 60_000 },
  { id: "10m", label: "10 min", heading: "Last 10 Min", ms: 600_000 },
  { id: "1h", label: "1 hr", heading: "Last 1 Hr", ms: 3_600_000 },
  { id: "6h", label: "6 hr", heading: "Last 6 Hr", ms: 21_600_000 },
  { id: "24h", label: "24 hr", heading: "Last 24 Hr", ms: 86_400_000 },
] as const;
export type SpanId = (typeof SPANS)[number]["id"];
export const spanOf = (id: string) => SPANS.find((span) => span.id === id) ?? SPANS[1];

/** The choices for the two alerts every device shares unless its own cell says otherwise. */
export const ALERT_OVER_MS = [10, 20, 50, 80, 100, 150, 200, 300, 500, 1000] as const;
export const ALERT_LOST_MS = [1000, 2000, 3000, 5000, 10_000, 30_000, 60_000, 300_000] as const;
/** The range the top of the timeline can be set to, in ms. Without a value (Auto) it fits the tallest bar on show. */
export const SCALE_MIN_MS = 0.1;
export const SCALE_MAX_MS = 10_000;
/** A scale rounded to three significant figures and kept in range. */
export const roundScale = (ms: number) => Math.min(SCALE_MAX_MS, Math.max(SCALE_MIN_MS, Number(ms.toPrecision(3))));
/** The − and + step for a scale: about a tenth of it, on a 1, 2, 5 sequence. */
export function scaleStep(ms: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(ms, SCALE_MIN_MS)));
  const tenth = ms / 10;
  for (const step of [0.1, 0.2, 0.5, 1, 2, 5, 10]) if (tenth <= step * power) return Number((step * power).toPrecision(1));
  return power * 10;
}
/** The next round scale up or down from any scale: 2.37 goes to 2.5 or 2, 2.5 to 3 or 2. */
export function stepScale(ms: number, direction: 1 | -1) {
  const step = scaleStep(ms);
  const at = ms / step;
  const next = direction > 0 ? (Math.floor(at + 1e-9) + 1) * step : (Math.ceil(at - 1e-9) - 1) * step;
  return roundScale(Number(next.toPrecision(6)));
}

/** The bar colours: the status colours, plus yellow and orange for the steps between. */
export const PING_COLORS = { ok: "#63BC9C", warn: "#DFBC72", bad: "#E5766A", green: "#63BC9C", yellow: "#E6D35C", orange: "#F08A4B", red: "#E5766A" } as const;
/** The three steps, in order: each colour covers answers up to its time. Over the last one is red. */
export const BAND_STEPS = ["green", "yellow", "orange"] as const;
export type BandStep = (typeof BAND_STEPS)[number];
/** The user's times for the colours, in ms. An empty one is left out, so fewer colours are used. */
export type Bands = Record<BandStep, number | null>;
/** A colour for every answer up to `upToMs`. */
export interface ColorBand {
  upToMs: number;
  color: string;
}
/** Bar colours by answer time, as drawn: the bands in order, then the colour over the last band and for no answer. */
export interface Colors {
  bands: ColorBand[];
  over: string;
  lost: string;
}
/**
 * The colours bars are drawn in. With the user's times: green, yellow and orange up to each, red
 * over the last. Without them, they follow the alert limit as before: green under it, amber over it.
 * No answer is always red.
 */
export function colorsOf(bands: Bands | undefined, limit: number | null): Colors {
  if (bands) {
    const steps = BAND_STEPS.filter((step) => bands[step] !== null).map((step) => ({ upToMs: bands[step]!, color: PING_COLORS[step] }));
    if (steps.length) return { bands: steps, over: PING_COLORS.red, lost: PING_COLORS.red };
  }
  return limit === null ? { bands: [], over: PING_COLORS.ok, lost: PING_COLORS.bad } : { bands: [{ upToMs: limit, color: PING_COLORS.ok }], over: PING_COLORS.warn, lost: PING_COLORS.bad };
}
export function colorFor(colors: Colors, ms: number) {
  return colors.bands.find((band) => ms <= band.upToMs)?.color ?? colors.over;
}

export type ColumnId =
  | "name" | "enabled" | "host" | "over" | "lost"
  | "status" | "now" | "average" | "best" | "worst" | "jitter" | "lostPct" | "strip";
export interface Column {
  readonly id: ColumnId;
  readonly label: string;
  readonly width: number;
  readonly fill: "copy" | "series";
  /** Filled in from ping results, so it can't be edited. */
  readonly live?: boolean;
  readonly numeric?: boolean;
  readonly hiddenByDefault?: boolean;
}
export const columns: readonly Column[] = [
  { id: "name", label: "Device", width: 160, fill: "series" },
  { id: "enabled", label: "Enabled", width: 92, fill: "copy" },
  { id: "host", label: "IP Address", width: 126, fill: "series" },
  { id: "over", label: "Alert Over", width: 104, fill: "copy" },
  { id: "lost", label: "Alert Lost For", width: 124, fill: "copy" },
  { id: "status", label: "Status", width: 116, fill: "copy", live: true },
  { id: "now", label: "Now", width: 78, fill: "copy", live: true, numeric: true },
  { id: "average", label: "Average", width: 84, fill: "copy", live: true, numeric: true },
  { id: "best", label: "Best", width: 78, fill: "copy", live: true, numeric: true, hiddenByDefault: true },
  { id: "worst", label: "Worst", width: 78, fill: "copy", live: true, numeric: true },
  { id: "jitter", label: "Jitter", width: 78, fill: "copy", live: true, numeric: true, hiddenByDefault: true },
  { id: "lostPct", label: "Lost", width: 70, fill: "copy", live: true, numeric: true },
  { id: "strip", label: "Last 10 Min", width: 248, fill: "copy", live: true },
];
export const columnOf = (id: string) => columns.find((column) => column.id === id);
export const editableColumns = columns.filter((column) => !column.live).map((column) => column.id);

export interface DeviceRow {
  readonly id: string;
  readonly values: Record<string, string>;
  /** The sheet the device is on. Absent, or a sheet that is gone, is the first sheet. */
  readonly sheetId?: string;
}
/** A named tab of devices. Every device is on one; all of them are pinged whichever is open. */
export interface Sheet {
  id: string;
  name: string;
}
export const FIRST_SHEET: Sheet = { id: "devices", name: "Devices" };
export const MAX_SHEETS = 32;
export interface Settings {
  intervalMs: number;
  sizeBytes: number;
  /** Off pauses every ping without changing which devices are enabled. */
  pinging: boolean;
  /** Alert when an answer takes longer than this, for every device whose own cell is empty. Null is no alert. */
  alertOverMs: number | null;
  /** Alert when a device hasn't answered for this long, for every device whose own cell is empty. Null is no alert. */
  alertLostMs: number | null;
  /** Whether an alert also raises a macOS notification. The Status Log and keys show it either way. */
  notify: boolean;
}
export interface View {
  textSize?: number;
  widths: Record<string, number>;
  rowHeights: Record<string, number>;
  hidden: string[];
  order: string[];
  span: SpanId;
  /** The answer time at the top of the timeline, in ms. Absent is Auto: it fits the tallest bar on show. */
  scaleMs?: number;
  /** The times for green, yellow and orange bars on the timeline and the strips. Absent follows the alert limit. */
  bands?: Bands;
  /** The sheet on show. Absent, or a sheet that is gone, is the first sheet. */
  sheetId?: string;
}
export interface PingDocument {
  version: 1;
  devices: DeviceRow[];
  /** The sheets in order. Absent is one sheet, Devices, holding every device. */
  sheets?: Sheet[];
  settings: Settings;
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
  /**
   * Adding, removing, moving and counting devices, as one step. `count` is what the Devices box
   * was set to: if another window added devices to the sheet meanwhile, fewer new ones are added.
   */
  | { kind: "rows"; rows: DeviceRow[]; expected: DeviceRow[]; count?: { sheetId: string; count: number }; moved?: string[] }
  | { kind: "settings"; settings: Settings; expected: Settings }
  /** `moved`: the column a move in the Columns list moved, so another window's moves stay as they are. */
  | { kind: "view"; view: View; expected: View; moved?: string[] }
  /**
   * Adding, renaming, moving or removing sheets, as one step. Removing a sheet takes its devices
   * with it, and adding one opens it, so the device list and the open sheet can change too.
   */
  | { kind: "sheets"; sheets: Sheet[]; expected: Sheet[]; rows?: DeviceRow[]; expectedRows?: DeviceRow[]; open?: string; expectedOpen?: string; moved?: string[] }
) & { strict?: boolean };

export const clone = <T>(value: T): T => structuredClone(value);
export { same };
export const valueOf = (row: DeviceRow, columnId: string) => row.values[columnId] ?? "";
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function defaultDocument(): PingDocument {
  return {
    version: 1,
    devices: [],
    settings: { intervalMs: 1000, sizeBytes: 56, pinging: true, alertOverMs: null, alertLostMs: 3000, notify: true },
    view: { textSize: 13, widths: {}, rowHeights: {}, hidden: columns.filter((column) => column.hiddenByDefault).map((column) => column.id), order: columns.map((column) => column.id), span: "10m" },
  };
}

export function validAddress(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * A device's own alert cell. Empty follows the global setting, "off" never alerts,
 * and a number is its own limit: ms for Alert Over, seconds for Alert When Lost For.
 */
export type Rule = number | "off" | null;
const RULE_LIMITS = { over: { unit: "ms", max: 60_000 }, lost: { unit: "s", max: 3600 } } as const;
/** "80", "80 ms" and "80ms" all mean 80; "off", "never" and "none" mean no alert; anything else is undefined. */
export function parseRule(columnId: "over" | "lost", value: string): Rule | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text === "off" || text === "never" || text === "none") return "off";
  const { unit, max } = RULE_LIMITS[columnId];
  const match = new RegExp(`^(\\d{1,5})\\s*(?:${unit === "s" ? "s|sec|secs|seconds?" : "ms"})?$`, "u").exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return amount >= 1 && amount <= max ? amount : undefined;
}

/** The alerts that apply to a device: its own cells where they say something, the global settings where they don't. */
export interface Rules {
  /** Alert when an answer takes longer than this many ms, or null for no alert. */
  readonly overMs: number | null;
  /** Alert when nothing has answered for this many ms, or null for no alert. */
  readonly lostMs: number | null;
}
export function rulesOf(row: DeviceRow, settings: Settings): Rules {
  const over = parseRule("over", valueOf(row, "over")) ?? null;
  const lost = parseRule("lost", valueOf(row, "lost")) ?? null;
  return {
    overMs: over === "off" ? null : (over ?? settings.alertOverMs),
    lostMs: lost === "off" ? null : lost === null ? settings.alertLostMs : lost * 1000,
  };
}
export const formatDuration = (ms: number) => (ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`);
/** What an alert cell shows: its own value, or the global one it follows. */
export function ruleText(columnId: "over" | "lost", value: string, settings: Settings): { text: string; inherited: boolean } {
  const rule = parseRule(columnId, value);
  if (rule === "off") return { text: "Off", inherited: false };
  if (typeof rule === "number") return { text: columnId === "over" ? `${rule} ms` : formatDuration(rule * 1000), inherited: false };
  const global = columnId === "over" ? settings.alertOverMs : settings.alertLostMs;
  return { text: global === null ? "Off" : columnId === "over" ? `${global} ms` : formatDuration(global), inherited: true };
}

/** Why a value can't go in a cell, or undefined when it can. */
export function validateValue(columnId: string, value: string): string | undefined {
  if (typeof value !== "string" || value.length > 256) return "Enter up to 256 characters.";
  switch (columnId) {
    case "name":
      return value.trim() && value.trim().length <= 64 ? undefined : "Give the device a name of up to 64 characters.";
    case "enabled":
      return value === "TRUE" || value === "FALSE" ? undefined : "Tick or untick Enabled.";
    case "host":
      return !value || validAddress(value) ? undefined : "Enter an IPv4 address such as 192.168.1.20.";
    case "over":
      return value === "" || value === "off" || (/^\d{1,5}$/u.test(value) && parseRule("over", value) !== undefined)
        ? undefined
        : "Enter a time from 1 to 60000 ms, Off for no alert, or leave it empty to use the global setting.";
    case "lost":
      return value === "" || value === "off" || (/^\d{1,5}$/u.test(value) && parseRule("lost", value) !== undefined)
        ? undefined
        : "Enter a time from 1 to 3600 seconds, Off for no alert, or leave it empty to use the global setting.";
    default:
      return "This column can't be edited.";
  }
}

/** What the grid's typed text becomes before it is checked: "80 ms" is stored as "80". */
export function normalizeValue(columnId: string, value: string): string {
  if (columnId === "over" || columnId === "lost") {
    const rule = parseRule(columnId, value);
    return rule === undefined ? value : rule === null ? "" : String(rule);
  }
  if (columnId === "host" || columnId === "name") return value.trim();
  return value;
}

/** A cleared cell takes its column's default, except a name, which a device must have. */
export function clearedValue(columnId: string): string {
  return { enabled: "FALSE" }[columnId] ?? "";
}

function validateView(view: View) {
  if (!view || typeof view !== "object") throw Error("Invalid page layout.");
  if (view.textSize !== undefined && (!Number.isInteger(view.textSize) || view.textSize < 9 || view.textSize > 24))
    throw Error("Use a text size from 9 to 24.");
  for (const [id, width] of Object.entries(view.widths ?? {}))
    if (!columnOf(id) || !Number.isFinite(width) || width < 50 || width > 1200) throw Error("Invalid column width.");
  for (const height of Object.values(view.rowHeights ?? {}))
    if (!Number.isFinite(height) || height < 28 || height > 200) throw Error("Invalid row height.");
  if (!Array.isArray(view.hidden) || view.hidden.some((id) => !columnOf(id) || id === "name")) throw Error("Invalid hidden columns.");
  if (!Array.isArray(view.order) || view.order.length !== columns.length || new Set(view.order).size !== columns.length || view.order.some((id) => !columnOf(id)))
    throw Error("Invalid column order.");
  if (!SPANS.some((span) => span.id === view.span)) throw Error("Invalid time span.");
  if (view.scaleMs !== undefined && (!Number.isFinite(view.scaleMs) || view.scaleMs < SCALE_MIN_MS || view.scaleMs > SCALE_MAX_MS))
    throw Error(`Use a timeline scale from ${SCALE_MIN_MS} to ${SCALE_MAX_MS} ms.`);
  if (view.bands !== undefined) validateBands(view.bands);
}

function validateBands(bands: Bands) {
  if (!bands || typeof bands !== "object") throw Error("Invalid bar colours.");
  let last = 0;
  for (const step of BAND_STEPS) {
    const value = bands[step];
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0.1 || value > 60_000) throw Error("Use a time from 0.1 to 60000 ms.");
    if (value <= last) throw Error("Each colour's time has to be above the one before it.");
    last = value;
  }
  if (last === 0) throw Error("Give at least one colour a time.");
}

function validateSettings(settings: Settings) {
  if (!settings || typeof settings !== "object") throw Error("Invalid ping settings.");
  if (!INTERVALS_MS.includes(settings.intervalMs as (typeof INTERVALS_MS)[number])) throw Error("Choose a ping time from the list.");
  if (!SIZES_BYTES.includes(settings.sizeBytes as (typeof SIZES_BYTES)[number])) throw Error("Choose a ping size from the list.");
  if (typeof settings.pinging !== "boolean" || typeof settings.notify !== "boolean") throw Error("Invalid ping settings.");
  if (settings.alertOverMs !== null && !(Number.isInteger(settings.alertOverMs) && settings.alertOverMs >= 1 && settings.alertOverMs <= 60_000)) throw Error("Choose an alert time from the list.");
  if (settings.alertLostMs !== null && !(Number.isInteger(settings.alertLostMs) && settings.alertLostMs >= 1000 && settings.alertLostMs <= 3_600_000)) throw Error("Choose a lost time from the list.");
}

/** Checks a whole document, including that no two devices share a name. */
export function validateDocument(value: unknown): PingDocument {
  const doc = value as PingDocument;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.devices) || !doc.view || !doc.settings) throw Error("The device list can't be read.");
  if (doc.devices.length > MAX_DEVICES) throw Error(`Use up to ${MAX_DEVICES} devices.`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const row of doc.devices) {
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 96 || ids.has(row.id)) throw Error("Invalid device identity.");
    ids.add(row.id);
    if (!row.values || typeof row.values !== "object") throw Error("Invalid device row.");
    for (const columnId of editableColumns) {
      const problem = validateValue(columnId, valueOf(row, columnId));
      if (problem) throw Error(problem);
    }
    const name = valueOf(row, "name").trim().toLowerCase();
    if (names.has(name)) throw Error(`Another device is already called ${valueOf(row, "name").trim()}. Buttons pick devices by name.`);
    names.add(name);
  }
  if (doc.sheets !== undefined) {
    if (!Array.isArray(doc.sheets) || !doc.sheets.length || doc.sheets.length > MAX_SHEETS) throw Error(`Use from 1 to ${MAX_SHEETS} sheets.`);
    const sheetIds = new Set<string>();
    const sheetNames = new Set<string>();
    for (const sheet of doc.sheets) {
      if (!sheet || typeof sheet.id !== "string" || !sheet.id || sheet.id.length > 96 || sheetIds.has(sheet.id)) throw Error("Invalid sheet identity.");
      if (typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 64) throw Error("Give each sheet a name of up to 64 characters.");
      const name = sheet.name.trim().toLowerCase();
      if (sheetNames.has(name)) throw Error(`There is already a sheet called ${sheet.name.trim()}.`);
      sheetIds.add(sheet.id);
      sheetNames.add(name);
    }
  }
  for (const row of doc.devices) if (row.sheetId !== undefined && (typeof row.sheetId !== "string" || row.sheetId.length > 96)) throw Error("Invalid device sheet.");
  validateSettings(doc.settings);
  validateView(doc.view);
  if (doc.view.sheetId !== undefined && (typeof doc.view.sheetId !== "string" || doc.view.sheetId.length > 96)) throw Error("Invalid open sheet.");
  return doc;
}

/** The settings as the toolbars name them, for a note that another window changed one too. */
const SETTING_NAMES: Record<string, string> = {
  intervalMs: "Ping every",
  sizeBytes: "Size",
  pinging: "Pinging",
  alertOverMs: "Answer over",
  alertLostMs: "No answer for",
  notify: "Notifications",
};
const deviceName = (row: DeviceRow) => valueOf(row, "name").trim() || "A device";
const cellName = (row: DeviceRow, columnId: string) => `${deviceName(row)}'s ${columnOf(columnId)?.label ?? columnId}`;

/** Each device's sheet written down, so that a change to which sheet comes first never moves a device. */
function pinned(rows: readonly DeviceRow[], sheets: readonly Sheet[]): DeviceRow[] {
  const doc = { sheets } as PingDocument;
  return rows.map((row) => {
    const sheetId = sheetOf(doc, row);
    return row.sheetId === sheetId ? row : { ...row, sheetId };
  });
}

/** The device list with this copy's additions, removals, moves and values put onto the one saved now. */
function mergeRows(base: readonly DeviceRow[], mine: readonly DeviceRow[], theirs: readonly DeviceRow[], merge: Merge, moved?: readonly string[]): DeviceRow[] {
  const was = new Map(base.map((row) => [row.id, row]));
  const wanted = new Map(mine.map((row) => [row.id, row]));
  const now = new Map(theirs.map((row) => [row.id, row]));
  // An Undo takes out only a device as this copy left it, never one another window has changed since.
  if (merge.strict)
    for (const [id, row] of was) {
      const current = now.get(id);
      if (!wanted.has(id) && current && !same(current, row)) throw leftAlone(deviceName(current));
    }
  return mergeOrder([...was.keys()], [...wanted.keys()], [...now.keys()], moved).map((id) => {
    const current = now.get(id);
    const before = was.get(id);
    const after = wanted.get(id);
    if (!current) return clone(after!);
    if (!before || !after) return current;
    const values = mergeRecord((columnId) => cellName(current, columnId), before.values, after.values, current.values, merge);
    const sheetId = mergeValue(`${deviceName(current)}'s sheet`, before.sheetId, after.sheetId, current.sheetId, merge);
    const { sheetId: _was, ...rest } = current;
    return { ...rest, values, ...(sheetId === undefined ? {} : { sheetId }) };
  });
}

/**
 * A device the page named "Device N" by itself takes the next free number if another window's
 * device has that name by now. A name someone gave it is never changed.
 */
function freeNames(next: PingDocument, added: ReadonlySet<string>) {
  next.devices.forEach((row, index) => {
    const name = valueOf(row, "name").trim();
    if (!added.has(row.id) || !/^Device \d+$/u.test(name)) return;
    const taken = (candidate: string) => next.devices.some((other) => other.id !== row.id && sameName(valueOf(other, "name"), candidate));
    if (!taken(name)) return;
    let number = next.devices.length;
    while (taken(`Device ${number}`)) number++;
    next.devices[index] = { ...row, values: { ...row.values, name: `Device ${number}` } };
  });
}

/** The page's layout: the newest change to each part wins, so a layout change is never refused. */
function mergeView(base: View, mine: View, theirs: View, moved?: readonly string[]): View {
  const merge = quietly();
  const out: View = {
    ...theirs,
    widths: mergeRecord(() => "", base.widths ?? {}, mine.widths ?? {}, theirs.widths ?? {}, merge),
    rowHeights: mergeRecord(() => "", base.rowHeights ?? {}, mine.rowHeights ?? {}, theirs.rowHeights ?? {}, merge),
    hidden: mergeSet(base.hidden, mine.hidden, theirs.hidden),
    order: mergeOrder(base.order, mine.order, theirs.order, moved),
    span: mergeValue("", base.span, mine.span, theirs.span, merge),
  };
  for (const key of ["textSize", "scaleMs", "sheetId"] as const) {
    const value = mergeValue<number | string | undefined>("", base[key], mine[key], theirs[key], merge);
    if (value === undefined) delete out[key];
    else (out as unknown as Record<string, unknown>)[key] = value;
  }
  // Two windows setting different colours' times keep both, unless together they would overlap.
  let bands = mergeValue("", base.bands, mine.bands, theirs.bands, merge);
  if (base.bands && mine.bands && theirs.bands) {
    const each = mergeRecord(() => "", base.bands, mine.bands, theirs.bands, merge) as unknown as Bands;
    try {
      validateBands(each);
      bands = each;
    } catch {
      bands = mine.bands;
    }
  }
  if (bands === undefined) delete out.bands;
  else out.bands = bands;
  return out;
}

/**
 * Puts a change onto the document as it is saved now. A change made from an older copy changes
 * only what that copy changed (see merge.ts). `clashes` collects what another window had also
 * changed, which this change's value now replaces.
 */
export function applyMutation(document: PingDocument, operation: Mutation, clashes: string[] = []): PingDocument {
  const next = clone(document);
  const merge: Merge = { strict: operation.strict === true, clashes };
  if (operation.kind === "edit") {
    for (const edit of operation.edits) {
      const row = next.devices.find((item) => item.id === edit.rowId);
      if (!row) throw Error("That device was removed before the change saved.");
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
    const had = new Set(next.devices.map((row) => row.id));
    next.devices = mergeRows(operation.expected, operation.rows, next.devices, merge, operation.moved);
    const added = new Set(next.devices.filter((row) => !had.has(row.id)).map((row) => row.id));
    freeNames(next, added);
    if (operation.count) {
      // The Devices box asked for this many on the sheet: devices another window added meanwhile
      // count, so fewer new ones go in. Nothing already there is taken off for it.
      const { sheetId, count } = operation.count;
      while (sheetRows(next, sheetId).length > count) {
        const extra = sheetRows(next, sheetId).filter((row) => added.has(row.id)).at(-1);
        if (!extra) break;
        next.devices = next.devices.filter((row) => row.id !== extra.id);
      }
    }
  } else if (operation.kind === "settings") {
    const merged = mergeRecord((key) => SETTING_NAMES[key] ?? key, { ...operation.expected }, { ...operation.settings }, { ...next.settings }, merge);
    next.settings = merged as unknown as Settings;
  } else if (operation.kind === "sheets") {
    // A device with no sheet of its own is on the first sheet. Write its sheet down before the
    // sheets change, so that moving another sheet to the front never moves devices with it.
    next.devices = pinned(next.devices, sheetsOf(next));
    if (operation.rows) {
      const had = new Set(next.devices.map((row) => row.id));
      next.devices = mergeRows(pinned(operation.expectedRows ?? [], operation.expected), pinned(operation.rows, operation.sheets), next.devices, merge);
      freeNames(next, new Set(next.devices.filter((row) => !had.has(row.id)).map((row) => row.id)));
    }
    const was = new Map(operation.expected.map((sheet) => [sheet.id, sheet]));
    const wanted = new Map(operation.sheets.map((sheet) => [sheet.id, sheet]));
    const now = new Map(sheetsOf(next).map((sheet) => [sheet.id, sheet]));
    const sheets = mergeOrder([...was.keys()], [...wanted.keys()], [...now.keys()], operation.moved).map((id) => {
      const current = now.get(id);
      const before = was.get(id);
      const after = wanted.get(id);
      if (!current) return clone(after!);
      if (!before || !after) return current;
      return { ...current, name: mergeValue(`The ${current.name} sheet's name`, before.name, after.name, current.name, merge) };
    });
    // A sheet named "Sheet N" for this copy takes the next free number if another window has one by now.
    sheets.forEach((sheet, index) => {
      const taken = (name: string) => sheets.some((other) => other.id !== sheet.id && sameName(other.name, name));
      if (now.has(sheet.id) || !/^Sheet \d+$/u.test(sheet.name.trim()) || !taken(sheet.name)) return;
      let number = 1;
      while (taken(`Sheet ${number}`)) number++;
      sheets[index] = { ...sheet, name: `Sheet ${number}` };
    });
    next.sheets = sheets;
    if (operation.open !== undefined && operation.open !== operation.expectedOpen) {
      // Opening the sheet next to one this copy removed matters only where that one was open.
      const leaving = operation.expectedOpen !== undefined && !wanted.has(operation.expectedOpen);
      if (!leaving || !sheets.some((sheet) => sheet.id === next.view.sheetId)) next.view = { ...next.view, sheetId: operation.open };
    }
  } else {
    next.view = mergeView(operation.expected, operation.view, next.view, operation.moved);
  }
  return validateDocument(next);
}

export function inverse(before: PingDocument, operation: Mutation): Mutation {
  if (operation.kind === "edit")
    return {
      kind: "edit",
      edits: operation.edits.map((edit) => {
        const row = before.devices.find((item) => item.id === edit.rowId)!;
        return { rowId: edit.rowId, columnId: edit.columnId, value: valueOf(row, edit.columnId), expected: edit.value };
      }),
    };
  const moved = operation.kind !== "settings" && operation.moved ? { moved: [...operation.moved] } : {};
  if (operation.kind === "rows") return { kind: "rows", rows: clone(operation.expected), expected: clone(operation.rows), ...moved };
  if (operation.kind === "settings") return { kind: "settings", settings: clone(operation.expected), expected: clone(operation.settings) };
  if (operation.kind === "sheets")
    return {
      kind: "sheets",
      sheets: clone(operation.expected),
      expected: clone(operation.sheets),
      ...(operation.rows ? { rows: clone(operation.expectedRows!), expectedRows: clone(operation.rows) } : {}),
      ...(operation.open !== undefined ? { open: before.view.sheetId ?? sheetsOf(before)[0]!.id, expectedOpen: operation.open } : {}),
      ...moved,
    };
  return { kind: "view", view: clone(operation.expected), expected: clone(operation.view), ...moved };
}

/** A new device, named after the first free "Device N". */
export function newDevice(document: PingDocument, id: string, sheetId = openSheetId(document)): DeviceRow {
  let number = document.devices.length + 1;
  while (document.devices.some((row) => sameName(valueOf(row, "name"), `Device ${number}`))) number++;
  return { id, values: { name: `Device ${number}`, enabled: "TRUE", host: "", over: "", lost: "" }, sheetId };
}

/** The sheets in order; a document from before sheets has one, Devices, holding everything. */
export const sheetsOf = (document: PingDocument): Sheet[] => (document.sheets?.length ? document.sheets : [FIRST_SHEET]);
/** The sheet a device is on. */
export function sheetOf(document: PingDocument, row: DeviceRow): string {
  const sheets = sheetsOf(document);
  return row.sheetId !== undefined && sheets.some((sheet) => sheet.id === row.sheetId) ? row.sheetId : sheets[0]!.id;
}
/** The sheet on show. */
export function openSheetId(document: PingDocument): string {
  const sheets = sheetsOf(document);
  return sheets.some((sheet) => sheet.id === document.view.sheetId) ? document.view.sheetId! : sheets[0]!.id;
}
/** The devices on a sheet, in list order. */
export const sheetRows = (document: PingDocument, sheetId = openSheetId(document)) => document.devices.filter((row) => sheetOf(document, row) === sheetId);

type SheetsChange = Extract<Mutation, { kind: "sheets" }>;
const sheetsChange = (document: PingDocument, sheets: Sheet[], extra: Partial<SheetsChange> = {}): SheetsChange => ({
  kind: "sheets",
  sheets,
  expected: clone(sheetsOf(document)),
  ...extra,
});
function checkName(document: PingDocument, name: string, exceptId?: string) {
  const trimmed = name.trim();
  if (!trimmed) throw Error("Give the sheet a name.");
  if (trimmed.length > 64) throw Error("Use a sheet name of up to 64 characters.");
  if (sheetsOf(document).some((sheet) => sheet.id !== exceptId && sameName(sheet.name, trimmed))) throw Error(`There is already a sheet called ${trimmed}.`);
  return trimmed;
}
/** A new, empty sheet after the others, opened. */
export function addSheet(document: PingDocument, id: string, name: string): SheetsChange {
  const sheets = sheetsOf(document);
  if (sheets.length >= MAX_SHEETS) throw Error(`Use up to ${MAX_SHEETS} sheets.`);
  return sheetsChange(document, [...clone(sheets), { id, name: checkName(document, name) }], { open: id, expectedOpen: openSheetId(document) });
}
export function renameSheet(document: PingDocument, id: string, name: string): SheetsChange | null {
  const trimmed = checkName(document, name, id);
  const sheets = clone(sheetsOf(document));
  const sheet = sheets.find((item) => item.id === id);
  if (!sheet || sheet.name === trimmed) return null;
  sheet.name = trimmed;
  return sheetsChange(document, sheets);
}
export function moveSheet(document: PingDocument, id: string, beforeId: string | null): SheetsChange | null {
  const sheets = clone(sheetsOf(document));
  const sheet = sheets.find((item) => item.id === id);
  if (!sheet || id === beforeId) return null;
  const rest = sheets.filter((item) => item !== sheet);
  const index = beforeId ? rest.findIndex((item) => item.id === beforeId) : -1;
  rest.splice(index < 0 ? rest.length : index, 0, sheet);
  return same(rest.map((item) => item.id), sheets.map((item) => item.id)) ? null : sheetsChange(document, rest, { moved: [id] });
}
/** Removes a sheet and its devices as one step; the last sheet stays. */
export function removeSheet(document: PingDocument, id: string): (SheetsChange & { removed: DeviceRow[] }) | null {
  const sheets = sheetsOf(document);
  const index = sheets.findIndex((sheet) => sheet.id === id);
  if (index < 0 || sheets.length < 2) return null;
  const rest = clone(sheets.filter((sheet) => sheet.id !== id));
  const removed = sheetRows(document, id);
  // Devices left on the first sheet by default keep it if the first sheet is the one going.
  const rows = document.devices.filter((row) => !removed.includes(row)).map((row) => ({ ...clone(row), sheetId: sheetOf(document, row) }));
  const open = openSheetId(document);
  return {
    ...sheetsChange(document, rest, {
      rows,
      expectedRows: clone(document.devices),
      ...(open === id ? { open: (sheets[index + 1] ?? sheets[index - 1])!.id, expectedOpen: open } : {}),
    }),
    removed: clone(removed),
  };
}
/** Moves devices to another sheet, keeping their place in the list. */
export function moveRowsToSheet(document: PingDocument, ids: readonly string[], sheetId: string): Mutation | null {
  if (!sheetsOf(document).some((sheet) => sheet.id === sheetId)) return null;
  const moving = document.devices.filter((row) => ids.includes(row.id) && sheetOf(document, row) !== sheetId);
  if (!moving.length) return null;
  return { kind: "rows", rows: document.devices.map((row) => (moving.includes(row) ? { ...clone(row), sheetId } : clone(row))), expected: clone(document.devices) };
}

/** A row someone has only counted, not filled in, can go without asking. */
export const deviceHasData = (row: DeviceRow): boolean =>
  Object.entries(row.values).some(([id, value]) =>
    id === "name" ? !/^Device \d+$/u.test(value.trim()) : id === "enabled" ? value !== "TRUE" : value !== "",
  );

/** Sets how many devices the open sheet has: adds blank rows at its end, or takes its last rows off, as one undo step. */
export function setDeviceCount(document: PingDocument, count: number, newId: () => string): (Extract<Mutation, { kind: "rows" }> & { removed: DeviceRow[] }) | null {
  const mine = sheetRows(document);
  const others = document.devices.length - mine.length;
  const most = MAX_DEVICES - others;
  if (!Number.isInteger(count) || count < 0 || count > most)
    throw Error(others ? `Use from 0 to ${most} devices on this sheet (${MAX_DEVICES} in all).` : `Use from 0 to ${MAX_DEVICES} devices.`);
  const have = mine.length;
  if (count === have) return null;
  const asked = { sheetId: openSheetId(document), count };
  if (count < have) {
    const removed = mine.slice(count);
    return { kind: "rows", rows: clone(document.devices.filter((row) => !removed.includes(row))), expected: clone(document.devices), count: asked, removed: clone(removed) };
  }
  const next = clone(document);
  for (let index = have; index < count; index++) next.devices.push(newDevice(next, newId()));
  return { kind: "rows", rows: next.devices, expected: clone(document.devices), count: asked, removed: [] };
}

export function insertRows(document: PingDocument, rows: DeviceRow[], beforeId: string | null): Mutation {
  const next = clone(document.devices);
  const index = beforeId ? next.findIndex((row) => row.id === beforeId) : -1;
  next.splice(index < 0 ? next.length : index, 0, ...rows);
  return { kind: "rows", rows: next, expected: clone(document.devices) };
}

export function removeRows(document: PingDocument, ids: readonly string[]): Mutation {
  return { kind: "rows", rows: document.devices.filter((row) => !ids.includes(row.id)), expected: clone(document.devices) };
}

export function moveRows(document: PingDocument, ids: readonly string[], beforeId: string | null): Mutation | null {
  const moving = document.devices.filter((row) => ids.includes(row.id));
  const rest = document.devices.filter((row) => !ids.includes(row.id));
  const index = beforeId ? rest.findIndex((row) => row.id === beforeId) : -1;
  rest.splice(index < 0 ? rest.length : index, 0, ...moving);
  return same(rest.map((row) => row.id), document.devices.map((row) => row.id))
    ? null
    : { kind: "rows", rows: clone(rest), expected: clone(document.devices), moved: moving.map((row) => row.id) };
}

/** Bytes a second Ping puts on the network: each ping is its data plus 28 bytes of ICMP and IP headers. */
export function bytesPerSecond(devices: number, settings: Settings): number {
  return settings.pinging ? (devices * (settings.sizeBytes + 28) * 1000) / settings.intervalMs : 0;
}
export function formatRate(bytes: number): string {
  const bits = bytes * 8;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mb/s`;
  if (bits >= 1000) return `${bits >= 10_000 ? Math.round(bits / 1000) : (bits / 1000).toFixed(1)} kb/s`;
  return `${Math.round(bits)} b/s`;
}
export const formatInterval = (ms: number) => (ms < 1000 ? `${ms / 1000} s` : `${ms / 1000} s`);
export const formatMs = (value: number) => (value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`);
