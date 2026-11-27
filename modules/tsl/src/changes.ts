/**
 * What one copy of the page changed, for the backend to put onto what is saved now.
 *
 * HubDash can show the page in several windows at once, each its own copy over the one running
 * module. A copy never saves its whole setup or camera list: it sends only what it changed, and
 * the backend applies that to a fresh read. So a copy that is behind never undoes what another
 * copy saved, and a save is never refused for being behind. Plain functions with no Node imports:
 * the page and the backend share them.
 */
import type { RoutingRow } from "./routing.js";
import type { SwitcherDocument } from "./setup.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ----- The switcher setup: one set of fields -----

/** Fields of the switcher setup and the values one copy gave them. `null` takes a field away. */
export type SetupChange = Partial<Record<keyof SwitcherDocument, unknown>>;

/**
 * The setup with a copy's change on top. A field in `expected` is one the page changed by itself,
 * such as the device's settings after Read switcher: it lands only where the setup still holds
 * the value the page started from, so it never undoes another window's change. The operator's
 * own changes always land; the newest one wins.
 */
export function applySetupChange(
  value: SwitcherDocument,
  change: SetupChange,
  expected: SetupChange = {},
): { value: SwitcherDocument; kept: (keyof SwitcherDocument)[] } {
  const next: Record<string, unknown> = { ...value };
  const kept: (keyof SwitcherDocument)[] = [];
  for (const [key, wanted] of Object.entries(change) as [keyof SwitcherDocument, unknown][]) {
    if (key in expected && !same(value[key], expected[key])) {
      // Changed elsewhere since the page read it: what is saved stays.
      kept.push(key);
      continue;
    }
    if (wanted === null || wanted === undefined) delete next[key];
    else next[key] = wanted;
  }
  return { value: next as SwitcherDocument, kept };
}

// ----- The camera list: rows by ID -----

type RowFields = Partial<Omit<RoutingRow, "id">>;
export interface RoutingChange {
  /** Cameras deleted. */
  readonly removed: readonly string[];
  /** Cameras added, each after the camera it follows here (null: first). In order. */
  readonly added: readonly { readonly row: RoutingRow; readonly after: string | null }[];
  /** For each camera changed, only the fields changed. */
  readonly changed: readonly { readonly id: string; readonly fields: RowFields }[];
}
export const noRoutingChange = (change: RoutingChange) =>
  !change.removed.length && !change.added.length && !change.changed.length;

/** What turns one camera list into another, as deletions, additions and changed fields. */
export function routingChange(from: readonly RoutingRow[], to: readonly RoutingRow[]): RoutingChange {
  const before = new Map(from.map((row) => [row.id, row]));
  const after = new Set(to.map((row) => row.id));
  const removed = from.filter((row) => !after.has(row.id)).map((row) => row.id);
  const added: { row: RoutingRow; after: string | null }[] = [];
  const changed: { id: string; fields: RowFields }[] = [];
  to.forEach((row, index) => {
    const was = before.get(row.id);
    if (!was) {
      added.push({ row, after: index ? to[index - 1]!.id : null });
      return;
    }
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(row) as (keyof RoutingRow)[])
      if (key !== "id" && !same(row[key], was[key])) fields[key] = row[key];
    if (Object.keys(fields).length) changed.push({ id: row.id, fields: fields as RowFields });
  });
  return { removed, added, changed };
}

/**
 * A camera list with a change on top. A camera deleted elsewhere stays deleted: a change to it is
 * left out and named in `missing`. A camera added after one that is gone goes at the end.
 */
export function applyRoutingChange(
  rows: readonly RoutingRow[],
  change: RoutingChange,
): { rows: RoutingRow[]; missing: string[] } {
  const removed = new Set(change.removed);
  let next = rows.filter((row) => !removed.has(row.id));
  const missing: string[] = [];
  for (const { id, fields } of change.changed) {
    const index = next.findIndex((row) => row.id === id);
    if (index < 0) {
      if (!removed.has(id)) missing.push(id);
      continue;
    }
    if (Object.entries(fields).every(([key, value]) => same(next[index]![key as keyof RoutingRow], value))) continue;
    next = [...next];
    next[index] = { ...next[index]!, ...fields, id };
  }
  for (const { row, after } of change.added) {
    // Added already, as when a save is sent again after a restart cut its answer short.
    if (next.some((item) => item.id === row.id)) continue;
    const index = after === null ? -1 : next.findIndex((item) => item.id === after);
    next = [...next];
    if (after === null) next.unshift(row);
    else if (index < 0) next.push(row);
    else next.splice(index + 1, 0, row);
  }
  return { rows: next, missing };
}
