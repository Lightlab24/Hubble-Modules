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
  /** The value the edit was made over, so a late save can't overwrite a newer one. */
  expected: string;
}
export type Mutation =
  | { kind: "edit"; edits: CellEdit[] }
  /** Adding, removing and reordering devices replace the list as one step. */
  | { kind: "rows"; rows: DeviceRow[]; expected: DeviceRow[] }
  | { kind: "settings"; settings: Settings; expected: Settings }
  | { kind: "view"; view: View; expected: View }
  /**
   * Adding, renaming, moving or removing sheets, as one step. Removing a sheet takes its devices
   * with it, and adding one opens it, so the device list and the open sheet can change too.
   */
  | { kind: "sheets"; sheets: Sheet[]; expected: Sheet[]; rows?: DeviceRow[]; expectedRows?: DeviceRow[]; open?: string; expectedOpen?: string };

export const clone = <T>(value: T): T => structuredClone(value);
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]))
      : value;
export const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
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

export function applyMutation(document: PingDocument, operation: Mutation): PingDocument {
  const next = clone(document);
  if (operation.kind === "edit") {
    for (const edit of operation.edits) {
      const row = next.devices.find((item) => item.id === edit.rowId);
      if (!row) throw Error("That device was removed before the change saved.");
      if (valueOf(row, edit.columnId) !== edit.expected) throw Error("That cell changed before the edit saved.");
      const problem = validateValue(edit.columnId, edit.value);
      if (problem) throw Error(problem);
      row.values[edit.columnId] = edit.value;
    }
  } else if (operation.kind === "rows") {
    if (!same(next.devices, operation.expected)) throw Error("The device list changed before this change saved.");
    next.devices = clone(operation.rows);
  } else if (operation.kind === "settings") {
    if (!same(next.settings, operation.expected)) throw Error("The ping settings changed before this change saved.");
    next.settings = clone(operation.settings);
  } else if (operation.kind === "sheets") {
    if (!same(sheetsOf(next), operation.expected)) throw Error("The sheets changed before this change saved.");
    if (operation.rows) {
      if (!same(next.devices, operation.expectedRows)) throw Error("The device list changed before this change saved.");
      next.devices = clone(operation.rows);
    } else {
      // A device with no sheet of its own is on the first sheet. Write its sheet down before the
      // sheets change, so that moving another sheet to the front never moves devices with it.
      const before = next;
      next.devices = next.devices.map((row) => (row.sheetId === sheetOf(before, row) ? row : { ...row, sheetId: sheetOf(before, row) }));
    }
    next.sheets = clone(operation.sheets);
    if (operation.open !== undefined) next.view = { ...next.view, sheetId: operation.open };
  } else {
    if (!same(next.view, operation.expected)) throw Error("The layout changed before this change saved.");
    next.view = clone(operation.view);
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
  if (operation.kind === "rows") return { kind: "rows", rows: clone(operation.expected), expected: clone(operation.rows) };
  if (operation.kind === "settings") return { kind: "settings", settings: clone(operation.expected), expected: clone(operation.settings) };
  if (operation.kind === "sheets")
    return {
      kind: "sheets",
      sheets: clone(operation.expected),
      expected: clone(operation.sheets),
      ...(operation.rows ? { rows: clone(operation.expectedRows!), expectedRows: clone(operation.rows) } : {}),
      ...(operation.open !== undefined ? { open: before.view.sheetId ?? sheetsOf(before)[0]!.id, expectedOpen: operation.open } : {}),
    };
  return { kind: "view", view: clone(operation.expected), expected: clone(operation.view) };
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
  return same(rest.map((item) => item.id), sheets.map((item) => item.id)) ? null : sheetsChange(document, rest);
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
  if (count < have) {
    const removed = mine.slice(count);
    return { kind: "rows", rows: clone(document.devices.filter((row) => !removed.includes(row))), expected: clone(document.devices), removed: clone(removed) };
  }
  const next = clone(document);
  for (let index = have; index < count; index++) next.devices.push(newDevice(next, newId()));
  return { kind: "rows", rows: next.devices, expected: clone(document.devices), removed: [] };
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
    : { kind: "rows", rows: clone(rest), expected: clone(document.devices) };
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
