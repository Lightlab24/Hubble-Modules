// The Cyanview page can be open in two places at once: in two HubDash windows, or in HubDash on two computers.
// Each copy holds the plan as it last read or saved it, its base. A copy that saves after another copy has saved
// doesn't put its whole plan on top any more, which silently undid the other copy's edits (Nov 25, 2026). What it
// changed since its base goes onto the saved plan, field by field, and everything else stays as saved:
// - a field only one copy changed takes that change;
// - a field both changed keeps what this copy typed, and the row is reported;
// - a row either copy removed stays removed, and the row is reported if this copy had changed it;
// - what the worker wrote back after a send (element keys and the like) is taken from the saved plan;
// - a row's list of unsent fields is merged as a set, so both copies' unsent edits stay unsent.

export type PlanValue = Record<string, any>;
export type PlanRowKind = 'devices' | 'cameras' | 'lans' | 'unassigned';
export interface PlanConflict {
  kind: PlanRowKind | 'defaults' | 'logins';
  id: string;
  /** The fields both copies changed. Empty for a row the other copy removed. */
  fields: string[];
  /** The other copy removed a row this copy had changed, so the change is gone with it. */
  removed: boolean;
  row: PlanValue | null;
}

/** What each copy sees for itself: live reports and work in progress. Never compared, merged or reported. */
const LIVE = new Set(['online', 'lastSeen', 'jobs', 'deleting']);
/** What the worker wrote back after a send. Where both copies hold one, the saved one is the true one. */
const RECEIPTS = new Set(['elementKey', 'newElementKey', 'createState', 'needsInitialization']);
/** How far a row has got rather than what anyone typed. Where both copies moved it, this copy's own is kept quietly. */
const PROGRESS = new Set(['dirty', 'pending', 'result', 'revision', 'sentValues', 'isNew', ...RECEIPTS]);

const isObject = (value: unknown): value is PlanValue => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
/** Nothing there. The page fills some fields in as it draws them, so a missing field and an empty one are the same. */
const blank = (value: unknown) => value === undefined || value === null || value === '' ||
  (Array.isArray(value) && !value.length) || (isObject(value) && Object.values(value).every(blank));
function stable(value: unknown): string {
  if (blank(value)) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).filter(key => !blank(value[key])).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const rowLists = (plan: PlanValue | null | undefined) => ({
  devices: Array.isArray(plan?.devices) ? plan!.devices as PlanValue[] : [],
  cameras: Array.isArray(plan?.cameras) ? plan!.cameras as PlanValue[] : [],
  lans: Array.isArray(plan?.lans) ? plan!.lans as PlanValue[] : [],
  unassigned: unassignedRows(plan?.uiState) ?? [],
});
/** Cameras with no controller yet are kept with the page's own state, not in the plan's camera list. */
function unassignedRows(uiState: unknown): PlanValue[] | null {
  const rows = isObject(uiState) && isObject(uiState.privateContent) && isObject(uiState.privateContent.remiView) ? uiState.privateContent.remiView.unassigned : null;
  return Array.isArray(rows) ? rows : null;
}
const withoutLive = (row: PlanValue) => Object.fromEntries(Object.entries(row).filter(([field]) => !LIVE.has(field)));

/** The same plan as far as anyone's work goes: live reports and work in progress aside. */
export function samePlan(a: PlanValue | null | undefined, b: PlanValue | null | undefined) {
  return planText(a) === planText(b);
}
/** A plan as text that is the same for two plans exactly when samePlan says they are. */
export const planText = (plan: PlanValue | null | undefined) => stable(comparable(plan));
function comparable(plan: PlanValue | null | undefined) {
  if (!isObject(plan)) return plan;
  const copy: PlanValue = { ...plan, devices: rowLists(plan).devices.map(withoutLive), cameras: rowLists(plan).cameras.map(withoutLive), lans: rowLists(plan).lans.map(withoutLive) };
  const unassigned = unassignedRows(plan.uiState);
  if (unassigned) copy.uiState = { ...plan.uiState, privateContent: { ...plan.uiState.privateContent, remiView: { ...plan.uiState.privateContent.remiView, unassigned: unassigned.map(withoutLive) } } };
  return copy;
}

/** Any value: objects field by field, lists of rows row by row, anything else whole. */
function mergeValue(base: unknown, mine: unknown, theirs: unknown, conflict: () => void): unknown {
  if (same(mine, base)) return clone(theirs);
  if (same(theirs, base) || same(mine, theirs)) return clone(mine);
  if (isObject(mine) && isObject(theirs)) {
    const was = isObject(base) ? base : {}, out: PlanValue = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(was)])) {
      const value = mergeValue(was[key], mine[key], theirs[key], conflict);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  const keyed = (value: unknown) => Array.isArray(value) && value.every(row => isObject(row) && typeof row.id === 'string');
  if (keyed(mine) && keyed(theirs) && (base === undefined || keyed(base))) {
    return mergeList((base ?? []) as PlanValue[], mine as PlanValue[], theirs as PlanValue[], row => row.id, (was, m, t) => mergeValue(was, m, t, conflict) as PlanValue);
  }
  conflict();
  return clone(mine);
}

/**
 * Rows matched by key, kept in the saved plan's order with this copy's new rows after them. A row either copy
 * removed stays removed. `removedChanged` hears of a row this copy changed that the other copy removed.
 */
function mergeList(base: PlanValue[], mine: PlanValue[], theirs: PlanValue[], key: (row: PlanValue) => string,
  item: (base: PlanValue | undefined, mine: PlanValue, theirs: PlanValue) => PlanValue, removedChanged?: (row: PlanValue) => void) {
  const index = (rows: PlanValue[]) => new Map(rows.map(row => [key(row), row]));
  const was = index(base), held = index(mine), saved = index(theirs), out: PlanValue[] = [];
  for (const row of theirs) {
    const id = key(row), own = held.get(id);
    if (own) out.push(item(was.get(id), own, row));
    else if (!was.has(id)) out.push(clone(row));
  }
  for (const row of mine) {
    const id = key(row);
    if (saved.has(id)) continue;
    const before = was.get(id);
    if (!before) out.push(clone(row));
    else if (!same(withoutLive(row), withoutLive(before))) removedChanged?.(row);
  }
  return out;
}

function mergeRow(base: PlanValue | undefined, mine: PlanValue, theirs: PlanValue, kind: PlanRowKind, conflicts: PlanConflict[]) {
  const was = base ?? {}, out: PlanValue = {}, both: string[] = [];
  for (const field of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(was)])) {
    if (field === 'dirty') continue;
    const m = mine[field], t = theirs[field], b = was[field];
    let value: unknown;
    if (LIVE.has(field)) value = field in mine ? m : t;
    else if (same(m, b)) value = t;
    else if (same(t, b) || same(m, t)) value = m;
    else if (RECEIPTS.has(field)) value = t;
    else if (field === 'revision') value = Math.max(Number(m) || 0, Number(t) || 0);
    else if (isObject(m) && isObject(t)) value = mergeValue(b, m, t, () => { if (!PROGRESS.has(field)) both.push(field); });
    else { value = m; if (!PROGRESS.has(field)) both.push(field); }
    if (value !== undefined) out[field] = clone(value);
  }
  const fields = (row: PlanValue) => new Set<string>(Array.isArray(row.dirty) ? row.dirty : []);
  if ('dirty' in was || 'dirty' in mine || 'dirty' in theirs) {
    const before = fields(was), own = fields(mine), saved = fields(theirs);
    // A field this copy sent stops being unsent, unless the other copy has typed something else into it since.
    const dirty = [...saved].filter(field => !(before.has(field) && !own.has(field) && (same(theirs[field], was[field]) || same(theirs[field], mine[field]))));
    // A field this copy has left unsent stays unsent where it was new or what this copy holds was kept.
    for (const field of own) if (!dirty.includes(field) && (!before.has(field) || !same(mine[field], was[field]))) dirty.push(field);
    out.dirty = dirty;
    if (dirty.length && out.pending === false) { out.pending = true; out.result = 'Pending'; }
  }
  if (both.length) conflicts.push({ kind, id: String(mine.id), fields: [...new Set(both)], removed: false, row: out });
  return out;
}

function mergeRows(kind: PlanRowKind, base: PlanValue[], mine: PlanValue[], theirs: PlanValue[], conflicts: PlanConflict[]) {
  return mergeList(base, mine, theirs, row => String(row.id), (was, m, t) => mergeRow(was, m, t, kind, conflicts),
    row => conflicts.push({ kind, id: String(row.id), fields: [], removed: true, row }));
}

function mergeUiState(base: unknown, mine: unknown, theirs: unknown, conflicts: PlanConflict[]) {
  const without = (uiState: unknown) => {
    if (!unassignedRows(uiState)) return uiState;
    const copy = clone(uiState) as PlanValue; delete copy.privateContent.remiView.unassigned; return copy;
  };
  // What the page shows and how is the page's own; where both copies changed the same thing, this copy's is kept quietly.
  const merged = mergeValue(without(base), without(mine), without(theirs), () => {}) as PlanValue | null | undefined;
  const lists = [unassignedRows(base), unassignedRows(mine), unassignedRows(theirs)];
  if (!lists.some(Boolean)) return merged ?? null;
  const out = isObject(merged) ? merged : {};
  const content = out.privateContent = isObject(out.privateContent) ? out.privateContent : {};
  content.remiView = isObject(content.remiView) ? content.remiView : {};
  content.remiView.unassigned = mergeRows('unassigned', lists[0] ?? [], lists[1] ?? [], lists[2] ?? [], conflicts);
  return out;
}

export const emptyPlan = (): PlanValue => ({ formatVersion: 1, devices: [], cameras: [], lans: [], uiState: null });

/**
 * This copy's plan put onto the saved one. `base` is the saved plan this copy last read or wrote, `mine` what it
 * holds now and `theirs` the plan saved since.
 */
export function mergePlans(base: PlanValue | null | undefined, mine: PlanValue, theirs: PlanValue | null | undefined): { plan: PlanValue; conflicts: PlanConflict[] } {
  const was = base ?? emptyPlan(), saved = theirs ?? emptyPlan(), conflicts: PlanConflict[] = [];
  const plan: PlanValue = {};
  for (const key of new Set([...Object.keys(saved), ...Object.keys(mine), ...Object.keys(was)])) {
    let value: unknown;
    if (key === 'devices' || key === 'cameras' || key === 'lans') value = mergeRows(key, rowLists(was)[key], rowLists(mine)[key], rowLists(saved)[key], conflicts);
    else if (key === 'uiState') value = mergeUiState(was.uiState, mine.uiState, saved.uiState, conflicts);
    // One row per camera model on the Defaults tab, and every controller ever added, which only grows.
    else if (key === 'cameraLogins' || key === 'savedDevices') {
      const list = (plan: PlanValue) => Array.isArray(plan[key]) ? plan[key] as PlanValue[] : [];
      if (![was, mine, saved].some(plan => Array.isArray(plan[key]))) continue;
      const id = key === 'cameraLogins' ? (row: PlanValue) => String(row.model) : (row: PlanValue) => String(row.serial).toUpperCase();
      value = mergeList(list(was), list(mine), list(saved), id, (before, m, t) => mergeValue(before, m, t, () => {
        if (key === 'cameraLogins') conflicts.push({ kind: 'logins', id: String(m.model), fields: [], removed: false, row: m });
      }) as PlanValue);
    }
    else value = mergeValue(was[key], mine[key], saved[key], () => { if (key === 'defaults') conflicts.push({ kind: 'defaults', id: 'defaults', fields: [], removed: false, row: null }); });
    if (value !== undefined) plan[key] = value;
  }
  plan.formatVersion = 1;
  plan.uiState ??= null;
  // A camera or address on a controller the other copy took out of the list goes with it.
  const ids = new Set(rowLists(plan).devices.map(row => row.id)), before = rowLists(was), held = rowLists(mine);
  for (const key of ['cameras', 'lans'] as const) {
    plan[key] = rowLists(plan)[key].filter(row => {
      if (ids.has(row.device)) return true;
      const old = before[key].find(item => item.id === row.id), own = held[key].find(item => item.id === row.id);
      if (own && (!old || !same(withoutLive(own), withoutLive(old)))) conflicts.push({ kind: key, id: String(row.id), fields: [], removed: true, row: own });
      return false;
    });
  }
  const seen = new Set<string>();
  return { plan, conflicts: conflicts.filter(item => { const id = item.kind + ':' + item.id; if (seen.has(id)) return false; seen.add(id); return true; }) };
}
