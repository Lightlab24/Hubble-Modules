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
/** The answer times the top of the timeline can be set to. Without one (Auto) it fits the tallest bar on show. */
export const SCALES_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;

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
}
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
}
export interface PingDocument {
  version: 1;
  devices: DeviceRow[];
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
  | { kind: "view"; view: View; expected: View };

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
  if (view.scaleMs !== undefined && !SCALES_MS.includes(view.scaleMs as (typeof SCALES_MS)[number])) throw Error("Choose a timeline scale from the list.");
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
  validateSettings(doc.settings);
  validateView(doc.view);
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
  return { kind: "view", view: clone(operation.expected), expected: clone(operation.view) };
}

/** A new device, named after the first free "Device N". */
export function newDevice(document: PingDocument, id: string): DeviceRow {
  let number = document.devices.length + 1;
  while (document.devices.some((row) => sameName(valueOf(row, "name"), `Device ${number}`))) number++;
  return { id, values: { name: `Device ${number}`, enabled: "TRUE", host: "", over: "", lost: "" } };
}

/** A row someone has only counted, not filled in, can go without asking. */
export const deviceHasData = (row: DeviceRow): boolean =>
  Object.entries(row.values).some(([id, value]) =>
    id === "name" ? !/^Device \d+$/u.test(value.trim()) : id === "enabled" ? value !== "TRUE" : value !== "",
  );

/** Sets how many devices there are: adds blank rows at the end, or takes rows off the end, as one undo step. */
export function setDeviceCount(document: PingDocument, count: number, newId: () => string): (Extract<Mutation, { kind: "rows" }> & { removed: DeviceRow[] }) | null {
  if (!Number.isInteger(count) || count < 0 || count > MAX_DEVICES) throw Error(`Use from 0 to ${MAX_DEVICES} devices.`);
  const have = document.devices.length;
  if (count === have) return null;
  if (count < have) return { kind: "rows", rows: clone(document.devices.slice(0, count)), expected: clone(document.devices), removed: clone(document.devices.slice(count)) };
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
