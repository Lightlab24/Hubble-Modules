import raw from './fields.json' with { type: 'json' };

export type Scope = 'unit' | 'channel';
/** `slider`: a setting the unit gives in %, shown as Hubble's slider with its number. */
export interface Field { id: string; label: string; group: string; kind: 'text' | 'number' | 'choice'; scope: Scope; width: number; slider?: boolean }
export interface Group { id: string; label: string; scope: Scope; fields: Field[]; collapsed: string[] }
/** The four input labels are the unit's own Channel Name settings, so they are sent like any other setting. */
export const labelFieldIds = ['ChannelName1', 'ChannelName2', 'ChannelName3', 'ChannelName4'] as const;
const labelGroup: Group = { id: 'labels', label: 'Input labels', scope: 'unit', collapsed: [...labelFieldIds], fields: labelFieldIds.map((id, index) => ({ id, label: 'Ch ' + (index + 1), group: 'labels', kind: 'text', scope: 'unit', width: 120 })) };
export const groups: Group[] = [labelGroup, ...(raw.groups as { id: string; label: string; scope: Scope; collapsed: string[]; fields: Omit<Field, 'group' | 'scope'>[] }[]).map(group => ({ ...group, fields: group.fields.map(field => ({ ...field, group: group.id, scope: group.scope }) as Field) }))];
/** The unit's own name. It shows in the FS-HDR name column, not in a column group. */
export const nameField: Field = { id: 'SystemName', label: 'FS-HDR name', group: 'identity', kind: 'text', scope: 'unit', width: 160 };
export const fields = [nameField, ...groups.flatMap(g => g.fields)];
export const fieldById = new Map(fields.map(f => [f.id, f]));
export const groupById = new Map(groups.map(g => [g.id, g]));
export const groupsOf = (scope: Scope) => groups.filter(g => g.scope === scope);
/** `unit-simulated`: a built-in simulated unit stands in for this row. `unit-mode`: the operating mode a unit that isn't live is planned in. */
export const planFields = ['unit-name', 'unit-host', 'unit-allow', 'unit-simulated', 'unit-mode'] as const;
export const modes = [{ value: '1', label: 'HD/SD 4 Ch' }, { value: '2', label: '4K/UHD 1 Ch' }] as const;
export const modeLabel = (mode: string): string => modes.find(item => item.value === mode)?.label ?? '';
export const maxUnits = 40;
export const masterRowId = 'master';

export interface Unit { id: string; values: Record<string, string>; channels?: Record<string, Record<string, string>> }
export interface View { expanded: Record<string, boolean>; collapsed: Record<string, string[]>; order: string[]; fields: Record<string, string[]>; hidden: string[]; hiddenGroups?: string[]; textSize?: number; widths: Record<string, number>; rowHeights: Record<string, number>; cameraWidths?: Record<string, number>; settingHeights?: Record<string, number>; settingLabelWidth?: number }
export type Orientation = 'rows' | 'columns';
export type SheetKind = 'setup' | 'master' | 'channels';
/** A tab is a saved way of looking at the units. The open tab's layout is `document.view`. */
export interface Sheet { id: string; name: string; kind: SheetKind; orientation: Orientation; view?: View }
export type FullSheet = Sheet & { view: View };
/** `autoSend`: a committed edit goes to its unit as soon as it saves. `master`: the channel rows the Master tab edits together. */
/** `adopted` is set once units from version 1 have been brought across, so removing them later doesn't bring them back. */
export interface FsDocument { version: 1; units: Unit[]; view: View; sheets: Sheet[]; activeSheetId: string; autoSend?: boolean; master?: string[]; adopted?: boolean }
export interface CellEdit { rowId: string; columnId: string; value: string; expected: string }
export type Mutation = { kind: 'edit'; edits: CellEdit[] } | { kind: 'view'; view: View; expected: View; sheetId?: string } | { kind: 'select-sheet'; sheetId: string } | { kind: 'sheets'; sheets: FullSheet[]; expected: FullSheet[]; activeSheetId?: string } | { kind: 'units'; add: Unit[]; remove: Unit[] } | { kind: 'auto-send'; autoSend: boolean; expected: boolean } | { kind: 'master'; selected: string[]; expected: string[] };

export const clone = <T>(value: T): T => structuredClone(value);
const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortedKeys(item)])) : value;
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));

/** A row is a unit (`unitId`) or one of its channels (`unitId#1`…`#4`, or `#0` for the single 4K/UHD channel). */
export const channelRowId = (unitId: string, channel: number) => unitId + '#' + channel;
export function parseRowId(rowId: string): { unitId: string; channel: number | null } {
  const at = rowId.lastIndexOf('#'), channel = at < 0 ? NaN : Number(rowId.slice(at + 1));
  return at >= 0 && Number.isInteger(channel) && channel >= 0 && channel <= 4 ? { unitId: rowId.slice(0, at), channel } : { unitId: rowId, channel: null };
}
export function rowValues(doc: FsDocument, rowId: string): Record<string, string> | undefined {
  const { unitId, channel } = parseRowId(rowId), unit = doc.units.find(u => u.id === unitId);
  if (!unit) return undefined;
  return channel === null ? unit.values : unit.channels?.[String(channel)] ?? {};
}
export const valueOf = (doc: FsDocument, rowId: string, columnId: string): string => rowValues(doc, rowId)?.[columnId] ?? '';
export const unitName = (unit: Unit): string => unit.values['SystemName'] || unit.values['unit-name'] || 'FS-HDR';
export const isSimulated = (unit: Unit): boolean => unit.values['unit-simulated'] === 'TRUE';
export const plannedMode = (unit: Unit): '1' | '2' => unit.values['unit-mode'] === '2' ? '2' : '1';
/** The channels a unit has in the mode it is planned in: four in HD/SD, one (channel 0) in 4K/UHD. */
export const plannedChannels = (unit: Unit): number[] => plannedMode(unit) === '2' ? [0] : [1, 2, 3, 4];

export function validHost(value: string): boolean {
  const match = /^([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return false;
  const host = match[1]!;
  if (host.length > 253 || host.includes('..') || host.startsWith('.') || host.endsWith('.')) return false;
  if (/^[0-9.]+$/.test(host)) return host.split('.').length === 4 && host.split('.').every(n => /^\d{1,3}$/.test(n) && +n <= 255);
  return host.split('.').every(n => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(n));
}
/** What the plan can check without the unit. The unit's own limits are checked against its descriptors when the value is typed and again when it is sent. */
export function validateValue(scope: Scope, columnId: string, value: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return 'Enter up to 512 characters.';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'A value cannot contain control characters.';
  if (scope === 'unit') {
    if (columnId === 'unit-name') return value.length <= 96 ? undefined : 'Enter a name of up to 96 characters.';
    if (columnId === 'unit-host') return !value || validHost(value) ? undefined : 'Enter a valid hostname or IPv4 address, with an optional port.';
    if (columnId === 'unit-allow' || columnId === 'unit-simulated') return ['TRUE', 'FALSE', ''].includes(value) ? undefined : 'Choose On or Off.';
    if (columnId === 'unit-mode') return ['1', '2', ''].includes(value) ? undefined : 'Choose HD/SD 4 Ch or 4K/UHD 1 Ch.';
  }
  const field = fieldById.get(columnId);
  if (!field || field.scope !== scope) return 'This field is not editable.';
  if (!value) return undefined;
  if (field.kind === 'number' && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)))) return 'Enter a number.';
  return undefined;
}

const everyGroup = (scope: Scope, value: (group: Group) => unknown) => Object.fromEntries(groupsOf(scope).map(g => [g.id, value(g)]));
export function defaultView(scope: Scope, shown: string[]): View {
  return { expanded: {}, collapsed: everyGroup(scope, g => [...g.collapsed]) as Record<string, string[]>, order: groupsOf(scope).map(g => g.id), fields: {}, hidden: [], hiddenGroups: groupsOf(scope).map(g => g.id).filter(id => !shown.includes(id)), textSize: 13, widths: {}, rowHeights: {} };
}
export const scopeOf = (kind: SheetKind): Scope => kind === 'setup' ? 'unit' : 'channel';
const channelDefault = () => defaultView('channel', ['hdr', 'input', 'format']);
export function defaultDocument(): FsDocument {
  return { version: 1, units: [], view: defaultView('unit', ['labels']), activeSheetId: 'setup', sheets: [
    { id: 'setup', name: 'Setup', kind: 'setup', orientation: 'rows' },
    { id: 'master', name: 'Master', kind: 'master', orientation: 'rows', view: channelDefault() },
    { id: 'hdr', name: 'HDR', kind: 'channels', orientation: 'rows', view: channelDefault() },
  ] };
}
/** Adds blank rows or takes them off the end, as one undo step. */
export function setUnitCount(doc: FsDocument, count: number, newId: () => string): Extract<Mutation, { kind: 'units' }> | null {
  if (!Number.isInteger(count) || count < 0 || count > maxUnits) throw Error('Use from 0 to ' + maxUnits + ' FS-HDRs.');
  const have = doc.units.length;
  if (count === have) return null;
  if (count < have) return { kind: 'units', add: [], remove: clone(doc.units.slice(count)) };
  return { kind: 'units', remove: [], add: Array.from({ length: count - have }, (_, index) => newUnit(newId(), 'FS-HDR ' + (have + index + 1), '')) };
}
export const newUnit = (id: string, name: string, host: string): Unit => ({ id, values: { 'unit-name': name, 'unit-host': host, 'unit-allow': 'TRUE' } });
/** A row someone has only counted, not filled in, can go without asking. */
export const unitHasData = (unit: Unit): boolean => Object.entries(unit.values).some(([id, value]) => !!value && id !== 'unit-allow' && id !== 'unit-mode' && (id !== 'unit-simulated' || value === 'TRUE') && (id !== 'unit-name' || !/^FS-HDR \d+$/.test(value))) || Object.values(unit.channels ?? {}).some(values => Object.values(values).some(Boolean));

export function validateView(view: View, scope: Scope): void {
  if (!view || !Array.isArray(view.order) || !Array.isArray(view.hidden)) throw Error('Invalid column layout.');
  if (view.textSize !== undefined && (!Number.isInteger(view.textSize) || view.textSize < 9 || view.textSize > 24)) throw Error('Use a text size from 9 to 24.');
  const groupIds = new Set(groupsOf(scope).map(g => g.id));
  if (view.hiddenGroups !== undefined && (!Array.isArray(view.hiddenGroups) || new Set(view.hiddenGroups).size !== view.hiddenGroups.length || view.hiddenGroups.some(id => !groupIds.has(id)))) throw Error('Unknown hidden column group.');
  if (new Set(view.order).size !== view.order.length || view.order.some(id => !groupIds.has(id))) throw Error('Unknown column group.');
  for (const id of view.hidden) if (fieldById.get(id)?.scope !== scope) throw Error('Unknown hidden column.');
  const size = (value: unknown, least: number, most: number) => typeof value === 'number' && Number.isFinite(value) && value >= least && value <= most;
  for (const width of Object.values(view.widths)) if (!size(width, 44, 800)) throw Error('Invalid column width.');
  for (const height of Object.values(view.rowHeights)) if (!size(height, 28, 200)) throw Error('Invalid row height.');
  for (const width of Object.values(view.cameraWidths ?? {})) if (!size(width, 72, 800)) throw Error('Invalid channel width.');
  for (const height of Object.values(view.settingHeights ?? {})) if (!size(height, 28, 200)) throw Error('Invalid setting height.');
  if (view.settingLabelWidth !== undefined && !size(view.settingLabelWidth, 120, 800)) throw Error('Invalid setting name width.');
  for (const group of groupsOf(scope)) {
    const ids = group.fields.map(f => f.id), compact = view.collapsed[group.id] ?? group.collapsed, order = view.fields[group.id] ?? ids;
    if (new Set(compact).size !== compact.length || compact.some(id => !ids.includes(id))) throw Error('Invalid collapsed fields.');
    if (new Set(order).size !== order.length || order.some(id => !ids.includes(id))) throw Error('Invalid field order.');
  }
}
const maxSheets = 32;
export const activeSheet = (doc: FsDocument): Sheet => doc.sheets.find(sheet => sheet.id === doc.activeSheetId) ?? doc.sheets[0]!;
export const activeSheetId = (doc: FsDocument): string => activeSheet(doc).id;
export const activeKind = (doc: FsDocument): SheetKind => activeSheet(doc).kind;
/** Every tab with its layout, whichever one happens to be open. */
export function sheetList(doc: FsDocument): FullSheet[] {
  const open = activeSheetId(doc);
  return doc.sheets.map(sheet => sheet.id === open ? { ...sheet, view: doc.view } : sheet as FullSheet);
}
/** Only a settings tab can be turned on its side. Setup and Master always keep one row per unit or channel. */
export const isFlipped = (doc: FsDocument): boolean => activeSheet(doc).kind === 'channels' && activeSheet(doc).orientation === 'columns';
export const isFixed = (sheet: { kind: SheetKind }): boolean => sheet.kind !== 'channels';
function putSheets(doc: FsDocument, sheets: FullSheet[], open: string): void {
  const active = sheets.find(sheet => sheet.id === open) ?? sheets.find(sheet => sheet.id === activeSheetId(doc)) ?? sheets[0]!;
  doc.view = clone(active.view); doc.activeSheetId = active.id;
  doc.sheets = sheets.map(({ view, ...sheet }) => sheet.id === active.id ? sheet : { ...sheet, view });
}
function openSheet(doc: FsDocument, sheetId: string): void {
  if (!doc.sheets.some(sheet => sheet.id === sheetId)) throw Error('This tab was removed before the change saved.');
  if (sheetId !== activeSheetId(doc)) putSheets(doc, sheetList(doc), sheetId);
}
export const viewChange = (doc: FsDocument, view: View): Mutation => ({ kind: 'view', sheetId: activeSheetId(doc), view, expected: clone(doc.view) });
type SheetsChange = Extract<Mutation, { kind: 'sheets' }>;
const sheetsChange = (doc: FsDocument, sheets: FullSheet[], open = activeSheetId(doc)): SheetsChange => ({ kind: 'sheets', sheets, expected: clone(sheetList(doc)), activeSheetId: open });
/** A new tab is a settings sheet. It starts as a copy of the settings sheet you're on, or of the first one. */
export function addSheet(doc: FsDocument, id: string, name: string): SheetsChange {
  const list = clone(sheetList(doc)), open = list.find(sheet => sheet.id === activeSheetId(doc))!;
  const source = open.kind !== 'setup' ? open : list.find(sheet => sheet.kind === 'channels') ?? list.find(sheet => sheet.kind === 'master');
  return sheetsChange(doc, [...list, { id, name: name.trim(), kind: 'channels', orientation: source?.kind === 'channels' ? source.orientation : 'rows', view: source ? clone(source.view) : channelDefault() }], id);
}
export function renameSheet(doc: FsDocument, sheetId: string, name: string): SheetsChange | null {
  const list = clone(sheetList(doc)), sheet = list.find(item => item.id === sheetId);
  if (!sheet || isFixed(sheet)) return null;
  sheet.name = name.trim();
  return sheetsChange(doc, list);
}
export const setOrientation = (doc: FsDocument, sheetId: string, orientation: Orientation): SheetsChange => sheetsChange(doc, clone(sheetList(doc)).map(sheet => sheet.id === sheetId ? { ...sheet, orientation } : sheet));
export function removeSheet(doc: FsDocument, sheetId: string): SheetsChange | null {
  const list = clone(sheetList(doc)), index = list.findIndex(sheet => sheet.id === sheetId);
  if (index < 0 || isFixed(list[index]!)) return null;
  const open = activeSheetId(doc);
  return sheetsChange(doc, list.filter(sheet => sheet.id !== sheetId), open === sheetId ? (list[index + 1] ?? list[index - 1])!.id : open);
}
/** Setup and Master stay first, in that order. Settings sheets can be put in any order after them. */
export function moveSheet(doc: FsDocument, sheetId: string, beforeId: string | null): SheetsChange | null {
  const list = clone(sheetList(doc)), sheet = list.find(item => item.id === sheetId);
  if (!sheet || isFixed(sheet) || sheetId === beforeId) return null;
  const rest = list.filter(item => item !== sheet), fixed = rest.filter(isFixed).length;
  const index = beforeId ? rest.findIndex(item => item.id === beforeId) : -1;
  rest.splice(index < 0 ? rest.length : Math.max(index, fixed), 0, sheet);
  return same(rest.map(item => item.id), list.map(item => item.id)) ? null : sheetsChange(doc, rest);
}
function validateSheets(doc: FsDocument): void {
  if (!Array.isArray(doc.sheets) || doc.sheets.length < 2 || doc.sheets.length > maxSheets) throw Error('Use up to ' + maxSheets + ' tabs.');
  const ids = new Set<string>(), names = new Set<string>();
  for (const sheet of doc.sheets) {
    if (!sheet || typeof sheet.id !== 'string' || !sheet.id || ids.has(sheet.id)) throw Error('Invalid tab identity.');
    const name = typeof sheet.name === 'string' ? sheet.name.trim() : '';
    if (!name || name.length > 64 || names.has(name.toLowerCase())) throw Error('Each tab needs its own name of up to 64 characters.');
    if (!['rows', 'columns'].includes(sheet.orientation) || !['setup', 'master', 'channels'].includes(sheet.kind)) throw Error('Invalid tab layout.');
    ids.add(sheet.id); names.add(name.toLowerCase());
  }
  if (doc.sheets[0]!.kind !== 'setup' || doc.sheets[1]!.kind !== 'master' || doc.sheets.slice(2).some(isFixed)) throw Error('Setup and Master are the first two tabs.');
  if (!ids.has(doc.activeSheetId)) throw Error('The open tab is missing.');
  for (const sheet of doc.sheets) validateView(sheet.id === doc.activeSheetId ? doc.view : sheet.view!, scopeOf(sheet.kind));
}
export const autoSendOn = (doc?: { autoSend?: boolean }): boolean => doc?.autoSend === true;
export const masterSelection = (doc?: { master?: string[] }): string[] => doc?.master ?? [];

export function validateDocument(value: unknown): FsDocument {
  const doc = value as FsDocument;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.units) || doc.units.length > maxUnits) throw Error('Use up to ' + maxUnits + ' FS-HDRs.');
  const ids = new Set<string>();
  for (const unit of doc.units) {
    if (!unit || typeof unit.id !== 'string' || !unit.id || unit.id.includes('#') || unit.id === masterRowId || ids.has(unit.id) || !unit.values || typeof unit.values !== 'object') throw Error('Invalid FS-HDR identity.');
    ids.add(unit.id);
    for (const [id, text] of Object.entries(unit.values)) { const issue = validateValue('unit', id, text); if (issue) throw Error(issue); }
    for (const [channel, values] of Object.entries(unit.channels ?? {})) {
      if (!/^[0-4]$/.test(channel) || !values || typeof values !== 'object') throw Error('Invalid channel.');
      for (const [id, text] of Object.entries(values)) { const issue = validateValue('channel', id, text); if (issue) throw Error(issue); }
    }
  }
  validateSheets(doc);
  if (doc.autoSend !== undefined && typeof doc.autoSend !== 'boolean') throw Error('Invalid send mode.');
  if (doc.adopted !== undefined && typeof doc.adopted !== 'boolean') throw Error('Invalid plan.');
  if (doc.master !== undefined && (!Array.isArray(doc.master) || doc.master.length > maxUnits * 4 || doc.master.some(id => typeof id !== 'string'))) throw Error('Invalid Master selection.');
  if (JSON.stringify(doc).length > 220000) throw Error('This FS-HDR plan exceeds the workspace document limit.');
  return doc;
}
export function applyMutation(before: FsDocument, operation: Mutation): FsDocument {
  const next = clone(before);
  if (operation.kind === 'edit') {
    if (!Array.isArray(operation.edits) || !operation.edits.length || operation.edits.length > 10000) throw Error('Invalid edit batch.');
    const addresses = new Set<string>();
    for (const edit of operation.edits) {
      const { unitId, channel } = parseRowId(edit.rowId), unit = next.units.find(u => u.id === unitId);
      if (!unit) throw Error('The FS-HDR was removed before this edit saved.');
      const key = edit.rowId + '/' + edit.columnId;
      if (addresses.has(key)) throw Error('A batch contains the same cell twice.');
      addresses.add(key);
      // Another window may have saved this very value already, which is no conflict.
      const current = valueOf(next, edit.rowId, edit.columnId);
      if (current !== edit.expected && current !== edit.value) throw Error('This cell changed in another editor. Your draft is retained.');
      const issue = validateValue(channel === null ? 'unit' : 'channel', edit.columnId, edit.value); if (issue) throw Error(issue);
      const values = channel === null ? unit.values : ((unit.channels ??= {})[String(channel)] ??= {});
      if (edit.value || (channel === null && (planFields as readonly string[]).includes(edit.columnId))) values[edit.columnId] = edit.value; else delete values[edit.columnId];
      if (channel !== null && !Object.keys(values).length) { delete unit.channels![String(channel)]; if (!Object.keys(unit.channels!).length) delete unit.channels; }
    }
  } else if (operation.kind === 'view') {
    openSheet(next, operation.sheetId ?? activeSheetId(next));
    if (!same(next.view, operation.expected)) throw Error('The column layout changed in another editor.');
    next.view = clone(operation.view);
  } else if (operation.kind === 'select-sheet') {
    openSheet(next, operation.sheetId);
  } else if (operation.kind === 'sheets') {
    if (!same(sheetList(next), operation.expected)) throw Error('The tabs changed in another editor.');
    putSheets(next, clone(operation.sheets), operation.activeSheetId ?? activeSheetId(next));
  } else if (operation.kind === 'units') {
    for (const unit of operation.remove) { const row = next.units.find(u => u.id === unit.id); if (!row || !same(row, unit)) throw Error('An FS-HDR changed before it could be removed.'); }
    const gone = new Set(operation.remove.map(unit => unit.id));
    next.units = next.units.filter(unit => !gone.has(unit.id));
    for (const unit of operation.add) { if (next.units.some(row => row.id === unit.id)) throw Error('This FS-HDR is already in the plan.'); next.units.push(clone(unit)); }
    if (next.master) next.master = next.master.filter(id => !gone.has(parseRowId(id).unitId));
  } else if (operation.kind === 'auto-send') {
    if (typeof operation.autoSend !== 'boolean' || typeof operation.expected !== 'boolean') throw Error('Invalid send mode.');
    if (autoSendOn(next) !== operation.expected) throw Error('The send mode was changed in another editor.');
    next.autoSend = operation.autoSend;
  } else if (operation.kind === 'master') {
    if (!same(masterSelection(next), operation.expected)) throw Error('The Master selection changed in another editor.');
    next.master = [...new Set(operation.selected)];
  } else throw Error('Unknown edit operation.');
  return validateDocument(next);
}
export function visibleFields(view: View, scope: Scope): Field[] {
  const all = groupsOf(scope);
  return [...view.order, ...all.map(g => g.id).filter(id => !view.order.includes(id))].filter(id => !view.hiddenGroups?.includes(id)).flatMap(id => {
    const group = groupById.get(id)!;
    const order = [...(view.fields[id] ?? []), ...group.fields.map(f => f.id).filter(f => !view.fields[id]?.includes(f))];
    return order.filter(f => !view.hidden.includes(f) && (view.expanded[id] || (view.collapsed[id] ?? group.collapsed).includes(f))).map(f => fieldById.get(f)!);
  });
}
/** The settings any tab can show without another read: every section on a tab, whole, so expanding one needs nothing more. */
export function watchedFieldIds(doc: FsDocument): { unit: string[]; channel: string[] } {
  const found = { unit: new Set<string>([nameField.id, ...labelFieldIds]), channel: new Set<string>() };
  for (const sheet of sheetList(doc)) {
    const scope = scopeOf(sheet.kind);
    for (const field of visibleFields({ ...sheet.view, expanded: Object.fromEntries(groupsOf(scope).map(g => [g.id, true])) }, scope)) found[scope].add(field.id);
  }
  for (const unit of doc.units) {
    for (const id of Object.keys(unit.values)) if (fieldById.has(id)) found.unit.add(id);
    for (const values of Object.values(unit.channels ?? {})) for (const id of Object.keys(values)) found.channel.add(id);
  }
  return { unit: [...found.unit], channel: [...found.channel] };
}
/** One pointer gesture changes only its field/section preferences, in one layout transaction. */
export function withColumnVisibility(view: View, changes: readonly { id: string; visible: boolean }[]): View {
  const next = clone(view);
  for (const { id, visible } of changes) {
    if (groupById.has(id)) {
      next.hiddenGroups = (next.hiddenGroups ?? []).filter(group => group !== id);
      if (!visible) next.hiddenGroups.push(id);
      continue;
    }
    const field = fieldById.get(id); if (!field) throw Error('Unknown column.');
    const group = groupById.get(field.group)!;
    next.hidden = next.hidden.filter(item => item !== id);
    // A section that is off shows none of its settings, so ticking one brings the section back with just that setting.
    if (next.hiddenGroups?.includes(group.id)) {
      if (!visible) continue;
      next.collapsed[group.id] = [id]; next.expanded[group.id] = false;
      next.hiddenGroups = next.hiddenGroups.filter(item => item !== group.id);
      continue;
    }
    if (!next.expanded[group.id]) {
      const compact = next.collapsed[group.id] ?? group.collapsed;
      next.collapsed[group.id] = visible ? [...new Set([...compact, id])] : compact.filter(item => item !== id);
    } else if (!visible) next.hidden.push(id);
    if (visible) next.hiddenGroups = next.hiddenGroups?.filter(item => item !== group.id);
  }
  return next;
}
/**
 * Column sections: each change is a column's own Show tick, whatever its section's collapse.
 * A section with every column off is switched off, so its values aren't read from the units;
 * ticking one of its columns brings it back with just the ticked ones.
 */
export function withSectionVisibility(view: View, changes: readonly { id: string; visible: boolean }[]): View {
  const next = clone(view);
  let off = [...(next.hiddenGroups ?? [])];
  const touched = new Set<string>();
  for (const { id, visible } of changes) {
    const field = fieldById.get(id); if (!field) throw Error('Unknown column.');
    const group = groupById.get(field.group)!; touched.add(group.id);
    if (off.includes(group.id)) {
      if (!visible) continue;
      off = off.filter(item => item !== group.id);
      next.hidden = [...new Set([...next.hidden, ...group.fields.map(f => f.id).filter(f => f !== id)])];
      continue;
    }
    next.hidden = next.hidden.filter(item => item !== id);
    if (!visible) next.hidden.push(id);
  }
  for (const id of touched) {
    const group = groupById.get(id)!;
    if (off.includes(id) || !group.fields.every(f => next.hidden.includes(f.id))) continue;
    off.push(id);
    next.hidden = next.hidden.filter(item => fieldById.get(item)?.group !== id);
  }
  next.hiddenGroups = off;
  return next;
}
/** Column sections: When collapsed ticks, which columns a collapsed section keeps on screen. */
export function withShownWhenCollapsed(view: View, changes: readonly { id: string; shownWhenCollapsed: boolean }[]): View {
  const next = clone(view);
  for (const { id, shownWhenCollapsed } of changes) {
    const field = fieldById.get(id); if (!field) throw Error('Unknown column.');
    const kept = next.collapsed[field.group] ?? [...groupById.get(field.group)!.collapsed];
    next.collapsed[field.group] = shownWhenCollapsed ? [...new Set([...kept, id])] : kept.filter(item => item !== id);
  }
  return next;
}
/** Takes every optional column off a tab. Anything ticked afterwards shows on its own. */
export function withNoColumns(view: View, scope: Scope): View {
  const next = clone(view);
  next.hiddenGroups = groupsOf(scope).map(group => group.id);
  next.collapsed = everyGroup(scope, () => []) as Record<string, string[]>;
  next.expanded = everyGroup(scope, () => false) as Record<string, boolean>;
  return next;
}
export function inverse(before: FsDocument, operation: Mutation): Mutation {
  if (operation.kind === 'edit') return { kind: 'edit', edits: operation.edits.map(e => ({ ...e, expected: e.value, value: valueOf(before, e.rowId, e.columnId) })) };
  if (operation.kind === 'view') return { kind: 'view', sheetId: operation.sheetId ?? activeSheetId(before), view: clone(operation.expected), expected: clone(operation.view) };
  if (operation.kind === 'select-sheet') return { kind: 'select-sheet', sheetId: activeSheetId(before) };
  if (operation.kind === 'sheets') return { kind: 'sheets', sheets: clone(operation.expected), expected: clone(operation.sheets), activeSheetId: activeSheetId(before) };
  if (operation.kind === 'units') return { kind: 'units', add: clone(operation.remove), remove: clone(operation.add) };
  if (operation.kind === 'auto-send') return { kind: 'auto-send', autoSend: operation.expected, expected: operation.autoSend };
  return { kind: 'master', selected: [...operation.expected], expected: [...operation.selected] };
}
