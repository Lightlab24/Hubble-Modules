import { connectModuleFrontend, ModuleFrontendValueSchema } from '@hubble/module-sdk/frontend';
import { mountSpreadsheetSheets, mountSpreadsheetToolbar, type SpreadsheetAddress } from '@hubble/module-sdk/spreadsheet-controls';
import { activeKind, activeSheet, activeSheetId, addSheet, autoSendOn, clone, fieldById, groupsOf, isFlipped, isSimulated, masterSelection, moveSheet, nameField, newUnit, parseRowId, removeSheet, renameSheet, scopeOf, setOrientation, setUnitCount, sheetList, unitHasData, validHost, valueOf, viewChange, type CellEdit, type Field, type Mutation, type Orientation, type SheetKind, type Unit } from './model.js';
import { displayValue, fromWire, hostOf, isLive, isSimulatedLive, masterRows, pendingFields, rowObservation, rowReady, rowTitle, rowsFor, sendsAfter, shownName, stagedRowIds, unitObservation, waitingLabel } from './rows.js';
import { DraftStore, type SaveReceipt } from './draft-store.js';
import { createGrid, type LiveWrite } from './ui-grid.js';
import type { Observed, WireObserved } from './backend.js';
import './frontend.css';

type Reply = Partial<WireObserved> & { sequence?: number };
type Snapshot = SaveReceipt & Reply;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errorBox = el('error'), saveStatus = el<HTMLOutputElement>('save-status'), pendingStatus = el('pending-status');
const dialog = el<HTMLDialogElement>('unit-dialog'), form = el<HTMLFormElement>('unit-form');
const input = (id: string) => el<HTMLInputElement>(id);
const kinds: SheetKind[] = ['setup', 'master', 'channels'];
let active: SpreadsheetAddress | undefined, observed: Observed = { units: {}, rows: {}, choiceSets: [] }, busy = false;
// Per row: settings not yet handed to the worker, so Cancel can still take them back.
const unsent = new Map<string, { id: string; value: string }[]>();
let errorTimer: ReturnType<typeof setTimeout> | undefined, lastSaveError = '';
// Hubble delivers state on its own slow cycle, so an older copy can arrive after a newer reply.
let newestState = 0;
function adopt(next: Reply) {
  if (!next.units || !next.rows || !next.choiceSets || !next.shapes) return;
  if (typeof next.sequence === 'number') { if (next.sequence < newestState) return; newestState = next.sequence; }
  observed = fromWire({ units: next.units, rows: next.rows, choiceSets: next.choiceSets, shapes: next.shapes });
}
function report(message: string) { clearTimeout(errorTimer); errorBox.getAnimations().forEach(animation => animation.cancel()); errorBox.textContent = message; errorBox.hidden = !message; if (message) { errorBox.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 4250, fill: 'forwards' }); errorTimer = setTimeout(() => { errorBox.hidden = true; }, 4500); } }
try {
  const client = await connectModuleFrontend(window);
  const initial = await client.call('snapshot') as unknown as Snapshot;
  adopt(initial);
  const store = new DraftStore(initial, async (operation: Mutation) => {
    const reply = await client.call('save', ModuleFrontendValueSchema.parse({ operation })) as unknown as Snapshot;
    adopt(reply); return reply;
  });
  const doc = () => store.document;
  const textControls = await mountSpreadsheetToolbar({ root: el('text-size'), textSize: {
    get: () => doc().view.textSize ?? 13,
    onChange(textSize) { store.submit(viewChange(doc(), { ...clone(doc().view), textSize })); },
  } });
  const submitSheets = (operation: Mutation | null, refusal: string) => { if (operation) store.submit(operation); else report(refusal); };
  const sheetTabs = await mountSpreadsheetSheets({
    root: el('sheet-tabs'),
    getState() { const list = sheetList(doc()); return { sheets: list.map(({ id, name }) => ({ id, name })), activeSheetId: activeSheetId(doc()), counts: new Map(list.map(sheet => [sheet.id, rowsFor(doc(), observed, sheet.kind).filter(row => row.kind !== 'master').length])) }; },
    onSelect(sheetId) { if (sheetId !== activeSheetId(doc())) store.submit({ kind: 'select-sheet', sheetId }, false); },
    onCreate: name => store.submit(addSheet(doc(), crypto.randomUUID(), name)),
    onRename: (sheetId, name) => submitSheets(renameSheet(doc(), sheetId, name), 'Setup and Master keep their names.'),
    onRemove: sheetId => submitSheets(removeSheet(doc(), sheetId), 'Setup and Master can’t be removed.'),
    onReorder: (sheetId, beforeId) => { const operation = moveSheet(doc(), sheetId, beforeId); if (operation) store.submit(operation); else sheetTabs.refresh(); },
  });
  const orientationButtons = [['view-rows', 'rows'], ['view-columns', 'columns']] as [string, Orientation][];
  const unitOf = (rowId: string) => doc().units.find(unit => unit.id === parseRowId(rowId).unitId);
  // A row Send can reach now: its unit is live, real or simulated, and has that channel. Presets for other rows wait.
  const rowLive = (rowId: string) => rowReady(observed, doc(), rowId);
  const seenRow = (rowId: string) => rowObservation(observed, unitOf(rowId), rowId);
  const pending = (rowId: string) => pendingFields(doc(), observed, rowId);
  // What Send all would write now: staged settings on units that are live. Offline ones wait.
  const readyToSend = () => stagedRowIds(doc()).reduce((n, rowId) => n + (rowLive(rowId) ? pending(rowId).length : 0), 0);
  const sendBlocked = () => busy || store.pending.length > 0 || store.invalid.size > 0;
  const grids = new Map<SheetKind, Awaited<ReturnType<typeof createGrid>>>();
  const openGrid = () => grids.get(activeKind(doc()))!;
  const refreshGrid = () => grids.get(activeKind(doc()))?.refresh();
  let shownKind: SheetKind | undefined;
  function showKind() {
    const kind = activeKind(doc());
    if (kind === shownKind) return;
    shownKind = kind;
    for (const item of kinds) el('viewport-' + item).hidden = item !== kind;
    for (const node of document.querySelectorAll<HTMLElement>('.toolbar [data-for]')) node.hidden = !node.dataset.for!.split(' ').includes(kind);
  }
  function update() {
    showKind();
    textControls.refresh(); sheetTabs.refresh();
    const kind = activeKind(doc());
    for (const [id, orientation] of orientationButtons) el(id).setAttribute('aria-pressed', String((orientation === 'columns') === isFlipped(doc())));
    if (store.error !== lastSaveError) { lastSaveError = store.error; if (lastSaveError) report(lastSaveError); }
    const staged = stagedRowIds(doc()), all = staged.reduce((n, rowId) => n + pending(rowId).length, 0);
    const inFlight = staged.reduce((n, rowId) => { const seen = observed.rows[rowId]; return n + new Set([...(unsent.get(rowId) ?? []).map(entry => entry.id), ...(seen?.queued ?? []), ...(seen?.sending ?? [])]).size; }, 0);
    // Saved with the plan, so it stays as set when you leave the page. Opening the page never sends anything by itself:
    // Auto send only sends an edit as it is committed.
    const auto = autoSendOn(doc());
    el('send-manual').setAttribute('aria-pressed', String(!auto)); el('send-auto').setAttribute('aria-pressed', String(auto));
    const sendable = readyToSend(), sendBar = el<HTMLButtonElement>('send-all-bar');
    sendBar.disabled = sendBlocked() || sendable === 0; el('send-all-bar-count').textContent = String(sendable); el('send-all-bar-count').hidden = sendable === 0;
    sendBar.title = sendable ? 'Send ' + sendable + ' staged setting' + (sendable === 1 ? '' : 's') + ' to the FS-HDRs that are live' : 'Nothing is waiting to send to a live FS-HDR';
    const units = doc().units, simulatedCount = units.filter(unit => isSimulatedLive(observed, unit)).length, liveCount = units.filter(unit => isLive(observed, unit)).length - simulatedCount;
    const states = [liveCount ? liveCount + ' live' : '', simulatedCount ? simulatedCount + ' simulated' : ''].filter(Boolean).join(' · ');
    el('fleet-status').textContent = units.length + ' unit' + (units.length === 1 ? '' : 's') + ' / ' + (states || 'offline');
    el('fleet-status').parentElement!.dataset.ready = String(liveCount + simulatedCount > 0);
    const unitCount = input('unit-count'); if (document.activeElement !== unitCount) unitCount.value = String(units.length);
    el<HTMLButtonElement>('refresh-units').disabled = busy || !units.some(unit => hostOf(unit) || isSimulated(unit)); el('refresh-label').textContent = busy ? 'Working…' : 'Refresh all';
    el('pending-count').textContent = String(all); el('pending-count').hidden = all === 0; el('pending-toggle').dataset.pending = String(all > 0);
    if (kind === 'master') {
      const channels = rowsFor(doc(), observed, 'channels').filter(row => row.kind === 'channel'), editing = masterRows(doc(), observed).length;
      el('master-summary').textContent = 'Editing ' + editing + ' of ' + channels.length + ' channel' + (channels.length === 1 ? '' : 's');
      el<HTMLButtonElement>('master-all').disabled = editing === channels.length; el<HTMLButtonElement>('master-none').disabled = editing === 0;
    }
    saveStatus.textContent = store.error || (store.pending.length ? 'Saving…' : store.invalid.size ? 'Correct the highlighted draft' : 'Workspace saved');
    saveStatus.dataset.error = String(!!store.error || store.invalid.size > 0);
    const waiting = all - staged.reduce((n, rowId) => n + (rowLive(rowId) ? pending(rowId).length : 0), 0), plural = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
    pendingStatus.textContent = inFlight ? inFlight + ' sending · ' + Math.max(0, all - inFlight) + ' pending' : !all ? 'No changes pending' : !waiting ? plural(all, 'change') + ' pending'
      : (all > waiting ? plural(all - waiting, 'change') + ' ready · ' : '') + plural(waiting, 'preset') + ' waiting';
    pendingStatus.dataset.pending = String(all > 0);
    el('empty').hidden = units.length > 0;
    if (!el('setting-details').hidden) renderDetails();
    if (!el('pending-sends').hidden) renderPending();
    adoptNames();
  }
  // The plan keeps the last name and mode each unit reported, so the row still has them when the unit is offline,
  // and presets for it go on the channels it really has.
  function adoptNames() {
    if (store.pending.length) return;
    const edits: CellEdit[] = doc().units.flatMap(unit => {
      const seen = isLive(observed, unit) ? unitObservation(observed, unit)! : undefined, name = seen?.name ?? '', kept = unit.values['unit-name'] ?? '';
      const mode = seen && !seen.simulated ? seen.modeValue ?? '' : '', keptMode = unit.values['unit-mode'] ?? '';
      return [
        ...(name && name !== kept && !unit.values[nameField.id] ? [{ rowId: unit.id, columnId: 'unit-name', value: name, expected: kept }] : []),
        ...(/^[12]$/.test(mode) && mode !== (keptMode || '1') ? [{ rowId: unit.id, columnId: 'unit-mode', value: mode, expected: keptMode }] : []),
      ];
    });
    if (edits.length) store.submit({ kind: 'edit', edits }, false);
  }
  function renderDetails() {
    const panel = el('detail-content'); panel.replaceChildren();
    const field = active && (active.columnId === 'unit-name' ? nameField : fieldById.get(active.columnId)), unit = active && unitOf(active.rowId);
    if (!active || !field || !unit) { panel.textContent = 'Select a setting to see what the unit has and what is staged.'; return; }
    const seen = seenRow(active.rowId), limits = seen?.limits[field.id], staged = valueOf(doc(), active.rowId, field.id);
    if (!seen) { panel.textContent = 'This FS-HDR isn’t live.'; return; }
    const heading = document.createElement('h3'); heading.textContent = field.label; panel.append(heading);
    const dl = document.createElement('dl');
    const range = limits?.min !== undefined && limits.max !== undefined ? limits.min + ' to ' + limits.max + (limits.units ? ' ' + limits.units : '') + (limits.step ? ', steps of ' + limits.step : '') : limits?.maxLength !== undefined ? (limits.minLength ?? 0) + ' to ' + limits.maxLength + ' characters' : '';
    for (const [label, value] of [['Row', rowTitle(doc(), observed, active.rowId)], ['Unit has', seen.planned ? 'Not known until it connects' : displayValue(observed, seen, field, seen.values[field.id] ?? '') || 'Not reported'], ['Staged', staged ? displayValue(observed, seen, field, staged) : 'No change'], ...(range ? [['Allowed', range]] : [])]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label!; dd.textContent = value!; dl.append(dt, dd);
    }
    panel.append(dl);
    for (const note of [seen?.locked[field.id], seen?.errors[field.id]]) if (note) { const p = document.createElement('p'); p.textContent = note; panel.append(p); }
  }
  const groupNodes = new Map<string, { root: HTMLElement; name: HTMLElement; detail: HTMLElement; send: HTMLButtonElement; cancel: HTMLButtonElement }>();
  const itemNodes = new Map<string, { root: HTMLElement; setting: HTMLElement; change: HTMLElement; status: HTMLElement; cancel: HTMLButtonElement }>();
  const button = (label: string, run: () => void) => { const node = document.createElement('button'); node.textContent = label; node.addEventListener('click', run); return node; };
  const addresses = (rowId: string) => pending(rowId).map(field => ({ rowId, fieldId: field.id }));
  function pendingGroup(rowId: string) {
    let node = groupNodes.get(rowId); if (node) return node;
    const root = document.createElement('div'), text = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('small');
    root.className = 'pending-camera'; root.dataset.rowId = rowId; text.append(name, detail);
    const send = button('Send', () => void sendRows([rowId])), cancel = button('Cancel', () => cancelSends(addresses(rowId)));
    root.append(text, send, cancel); node = { root, name, detail, send, cancel }; groupNodes.set(rowId, node); return node;
  }
  function pendingItem(rowId: string, fieldId: string) {
    const key = rowId + '/' + fieldId; let node = itemNodes.get(key); if (node) return node;
    const root = document.createElement('div'), setting = document.createElement('div'), change = document.createElement('div'), status = document.createElement('div');
    root.className = 'pending-item'; root.dataset.rowId = rowId; root.dataset.settingId = fieldId; setting.className = 'setting'; change.className = 'change'; status.className = 'status';
    const cancel = button('Cancel', () => cancelSends([{ rowId, fieldId }]));
    root.append(setting, change, status, cancel); node = { root, setting, change, status, cancel }; itemNodes.set(key, node); return node;
  }
  function renderPending() {
    const list = el('pending-list'), nodes: HTMLElement[] = [], groupsSeen = new Set<string>(), items = new Set<string>();
    const blocked = sendBlocked();
    let total = 0, ready = 0;
    for (const rowId of stagedRowIds(doc())) {
      const waiting = pending(rowId); if (!waiting.length) continue;
      const unit = unitOf(rowId)!, online = rowLive(rowId), seen = seenRow(rowId), raw = observed.rows[rowId], name = rowTitle(doc(), observed, rowId);
      total += waiting.length; if (online) ready += waiting.length; groupsSeen.add(rowId);
      const group = pendingGroup(rowId); nodes.push(group.root);
      const where = isLive(observed, unit) ? (unitObservation(observed, unit)?.simulated ? 'Simulated' : 'Live') : waitingLabel(observed, unit);
      group.name.textContent = name; group.detail.textContent = (hostOf(unit) && !isSimulated(unit) ? hostOf(unit) + ' · ' : '') + where;
      group.send.disabled = blocked || !online; group.send.setAttribute('aria-label', 'Send all changes to ' + name); group.cancel.setAttribute('aria-label', 'Cancel all changes for ' + name);
      for (const field of waiting) {
        const key = rowId + '/' + field.id, item = pendingItem(rowId, field.id), sending = !!raw?.sending.includes(field.id);
        items.add(key); nodes.push(item.root);
        const queued = !!unsent.get(rowId)?.some(entry => entry.id === field.id) || !!raw?.queued.includes(field.id), failure = raw?.errors[field.id], current = seen?.values[field.id];
        item.setting.textContent = field.label; item.change.textContent = (current ? displayValue(observed, seen, field, current) : online ? '(empty)' : '—') + ' → ' + displayValue(observed, seen, field, valueOf(doc(), rowId, field.id));
        // A unit that is live but in the other mode doesn't have this channel. Anything else waits for its unit to connect.
        item.status.textContent = sending ? 'Sending…' : queued ? 'Queued' : failure ?? (online ? '' : isLive(observed, unit) ? 'Not on this FS-HDR in ' + (unitObservation(observed, unit)?.mode ?? 'its mode') : sendsAfter(observed, unit));
        item.status.dataset.kind = sending || queued ? 'active' : failure ? 'failed' : online ? '' : 'offline';
        item.cancel.disabled = sending; item.cancel.setAttribute('aria-label', 'Cancel ' + field.label + ' for ' + name);
      }
    }
    for (const [id, node] of groupNodes) if (!groupsSeen.has(id)) { node.root.remove(); groupNodes.delete(id); }
    for (const [key, node] of itemNodes) if (!items.has(key)) { node.root.remove(); itemNodes.delete(key); }
    nodes.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null); });
    const presets = total - ready, plural = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
    el('pending-summary').textContent = !total ? 'Nothing is waiting to send.' : (presets ? (ready ? plural(ready, 'setting') + ' ready to send. ' : '') + plural(presets, 'preset') + ' wait' + (presets === 1 ? 's' : '') + ' for an FS-HDR to connect, then go with Send. ' : plural(total, 'setting') + ' waiting. ')
      + (autoSendOn(doc()) ? 'New edits send as you commit them. These stay here until you press Send.' : ready && !presets ? 'Nothing goes to an FS-HDR until you press Send.' : '');
    const all = el<HTMLButtonElement>('send-all'); all.textContent = ready ? 'Send all (' + ready + ')' : 'Send all'; all.disabled = blocked || ready === 0;
    el<HTMLButtonElement>('cancel-all').disabled = total === 0;
  }
  function togglePending(open: boolean) { const pane = el('pending-sends'); pane.hidden = !open; el('pending-toggle').setAttribute('aria-expanded', String(open)); if (open) renderPending(); }
  // Cancel takes a change out of the queue and clears it from the plan, as one Undo step.
  // The setting being written at that moment has already gone, so its button is off.
  function cancelSends(items: { rowId: string; fieldId: string }[]) {
    const edits: CellEdit[] = [];
    for (const rowId of new Set(items.map(item => item.rowId))) {
      const ids = items.filter(item => item.rowId === rowId).map(item => item.fieldId), raw = observed.rows[rowId];
      if (unsent.has(rowId)) unsent.set(rowId, unsent.get(rowId)!.filter(entry => !ids.includes(entry.id)));
      if (rowWork.has(rowId)) void client.call('cancel-send', { rowId, fieldIds: ids }).catch(() => {});
      for (const fieldId of ids) { const value = valueOf(doc(), rowId, fieldId); if (value && !raw?.sending.includes(fieldId)) edits.push({ rowId, columnId: fieldId, value: '', expected: value }); }
    }
    if (edits.length) store.submit({ kind: 'edit', edits }); else update();
  }
  function showDialog() {
    input('unit-host').value = ''; el('dialog-error').hidden = true; el<HTMLButtonElement>('dialog-submit').disabled = false;
    dialog.showModal(); input('unit-host').focus();
  }
  // The open tab's sheet has to be on screen before its grid draws, because the grid measures its own headers.
  showKind(); store.subscribe(showKind);
  for (const kind of kinds) grids.set(kind, await createGrid({
    kind, table: el<HTMLTableElement>('grid-' + kind), viewport: el('viewport-' + kind), columnEditor: el('columns-' + kind), store,
    observed: () => observed, onSelect: address => { if (activeKind(doc()) === kind) { active = address; update(); } },
    onZoom: ratio => { el('zoom-status').textContent = Math.round(ratio * 100) + '%'; },
    onRefresh: unitId => void refreshUnits([unitId]),
    onEdited: autoSend,
    onLive: sendLive,
    onRemove: unitId => { const unit = doc().units.find(item => item.id === unitId); if (unit) store.submit({ kind: 'units', add: [], remove: [clone(unit)] }); },
    onError: report,
  }));
  store.subscribe(update);
  let disposed = false, snapshotRequest = 0;
  function sawRevision(revision: unknown) {
    if (revision === undefined || revision === store.revision || store.pending.length) return;
    const request = ++snapshotRequest, epoch = store.epoch;
    void client.call('snapshot').then(reply => { const next = reply as unknown as Snapshot; if (!disposed && request === snapshotRequest && epoch === store.epoch && next.revision === revision) store.observe(next, epoch); }).catch(() => {});
  }
  const stop = client.subscribe(state => {
    if (disposed || !state || typeof state !== 'object' || Array.isArray(state)) return;
    const values = (state as { values?: Reply & { revision?: unknown } }).values;
    if (!values || typeof values !== 'object') return;
    adopt(values);
    refreshGrid(); update();
    sawRevision(values.revision);
  });
  const failureOf = (rowId: string, error: unknown) => rowTitle(doc(), observed, rowId) + ': ' + (error instanceof Error ? error.message : 'The FS-HDR did not take the change.');
  function finish(messages: string[]) { busy = false; refreshGrid(); update(); if (messages.length) report([...new Set(messages)].join(' ')); }
  // Everything for one row runs in order. Different rows run side by side, and the worker writes to each unit one setting at a time.
  const rowWork = new Map<string, Promise<void>>();
  function onRow(rowId: string, job: () => Promise<void>): Promise<void> {
    const run = (rowWork.get(rowId) ?? Promise.resolve()).then(job);
    rowWork.set(rowId, run);
    void run.finally(() => { if (rowWork.get(rowId) === run) rowWork.delete(rowId); });
    return run;
  }
  // A value the unit has confirmed stops being staged, so the sheet goes back to showing what the unit reports.
  function dropConfirmed(rowId: string, verified: readonly { id: string; value: string }[] = []) {
    const seen = seenRow(rowId), open = openGrid().editing;
    if (!seen) return;
    store.confirm(pendingFieldsOrStaged(rowId).filter(field => {
      const value = valueOf(doc(), rowId, field.id);
      if (!value || (open?.rowId === rowId && open.columnId === field.id) || unsent.get(rowId)?.some(entry => entry.id === field.id)) return false;
      return value === seen.values[field.id] || verified.some(entry => entry.id === field.id && entry.value === value);
    }).map(field => ({ rowId, columnId: field.id, value: '', expected: valueOf(doc(), rowId, field.id) })));
  }
  const pendingFieldsOrStaged = (rowId: string): Field[] => Object.keys((parseRowId(rowId).channel === null ? unitOf(rowId)?.values : unitOf(rowId)?.channels?.[String(parseRowId(rowId).channel)]) ?? {}).flatMap(id => fieldById.has(id) ? [fieldById.get(id)!] : []);
  async function refreshUnits(unitIds?: string[]) {
    if (busy) return;
    busy = true; report(''); update();
    const messages: string[] = [];
    try { adopt(await client.call('refresh', unitIds ? { unitIds } : {}) as unknown as Reply); for (const rowId of stagedRowIds(doc())) dropConfirmed(rowId); }
    catch (error) { messages.push(error instanceof Error ? error.message : 'Refresh failed.'); }
    finish(messages);
  }
  // Hubble refuses a page's 33rd request in flight, so Send all to 40 channels at once lost the last few. Sends take turns
  // through a few lanes, which also leaves room for saves, the change watch and slider moves.
  const sendLanes = 12, laneQueue: (() => void)[] = [];
  let lanesBusy = 0;
  async function inLane<T>(job: () => Promise<T>): Promise<T> {
    if (lanesBusy >= sendLanes) await new Promise<void>(resolve => laneQueue.push(resolve)); else lanesBusy++;
    try { return await job(); } finally { const next = laneQueue.shift(); if (next) next(); else lanesBusy--; }
  }
  // Each unit takes one setting at a time, so rows go out a unit at a time in turn: one from each unit, then the next.
  function byUnitInTurn(rowIds: string[]): string[] {
    const byUnit = new Map<string, string[]>();
    for (const rowId of rowIds) { const unitId = parseRowId(rowId).unitId; byUnit.set(unitId, [...byUnit.get(unitId) ?? [], rowId]); }
    const lists = [...byUnit.values()], out: string[] = [];
    for (let index = 0; out.length < rowIds.length; index++) for (const list of lists) if (list[index] !== undefined) out.push(list[index]!);
    return out;
  }
  // A slider being dragged, or a held − / +, with Auto send on. One request at a time; whatever arrived meanwhile goes next,
  // newest value only, so a long drag never piles up behind the unit.
  let liveWaiting = new Map<string, LiveWrite>(), liveFinal = false, liveBusy = false, liveFailure = '';
  function sendLive(writes: LiveWrite[], final: boolean): boolean {
    if (!autoSendOn(doc())) return false;
    for (const write of writes) liveWaiting.set(write.rowId + '/' + write.fieldId, write);
    liveFinal ||= final;
    void pumpLive();
    return true;
  }
  async function pumpLive() {
    if (liveBusy || !liveWaiting.size) return;
    liveBusy = true;
    const writes = [...liveWaiting.values()], final = liveFinal;
    liveWaiting = new Map(); liveFinal = false;
    try {
      const reply = await client.call('live', ModuleFrontendValueSchema.parse({ writes, final })) as unknown as { outcomes?: { status: string; message?: string }[] };
      const failed = reply.outcomes?.find(outcome => outcome.status === 'failed')?.message ?? '';
      // One message per problem, not one per step of the drag.
      if (failed && failed !== liveFailure) report(failed);
      liveFailure = failed;
    } catch (error) { const message = error instanceof Error ? error.message : 'The FS-HDR did not take the change.'; if (message !== liveFailure) report(message); liveFailure = message; }
    finally { liveBusy = false; }
    if (final && !liveWaiting.size) liveFailure = '';
    void pumpLive();
  }
  async function drainSends(rowId: string, messages: string[]) {
    await store.whenSaved();
    try {
      for (let waiting = unsent.get(rowId) ?? []; waiting.length; waiting = unsent.get(rowId) ?? []) {
        // The worker sends what the workspace has saved, so a quick second edit waits for its own save before it goes.
        await store.whenSaved(); waiting = unsent.get(rowId) ?? [];
        if (!unitOf(rowId) || !waiting.length) break;
        unsent.set(rowId, waiting.slice(32));
        // A save that failed or a newer edit means this is no longer the value to send.
        const batch = waiting.slice(0, 32).filter(entry => valueOf(doc(), rowId, entry.id) === entry.value && !store.invalid.has(rowId + '/' + entry.id));
        if (!batch.length) continue;
        const reply = await inLane(() => client.call('send', { rowId, fieldIds: batch.map(entry => entry.id) })) as unknown as Reply & { outcomes?: { fieldId: string; status: string; message?: string }[]; confirmed?: Record<string, string> };
        adopt(reply);
        for (const outcome of reply.outcomes ?? []) if (outcome.status === 'failed') messages.push(rowTitle(doc(), observed, rowId) + ', ' + (fieldById.get(outcome.fieldId)?.label ?? 'Setting') + ': ' + outcome.message);
        // Only a value the unit confirmed stops being staged. If the worker sent an older saved value, this one is sent next time round.
        dropConfirmed(rowId, batch.filter(entry => reply.confirmed?.[entry.id] === entry.value));
        for (const entry of batch) if (reply.confirmed?.[entry.id] !== undefined && reply.confirmed[entry.id] !== entry.value && valueOf(doc(), rowId, entry.id) === entry.value) unsent.set(rowId, [...(unsent.get(rowId) ?? []).filter(item => item.id !== entry.id), entry]);
        refreshGrid(); update();
      }
    } catch (error) { if (unitOf(rowId)) messages.push(failureOf(rowId, error)); }
    finally { unsent.delete(rowId); }
    refreshGrid(); update();
  }
  function queueSend(rowId: string, entries: { id: string; value: string }[], messages: string[]): Promise<void> {
    unsent.set(rowId, [...(unsent.get(rowId) ?? []).filter(entry => !entries.some(next => next.id === entry.id)), ...entries]);
    return onRow(rowId, () => drainSends(rowId, messages));
  }
  async function sendRows(rowIds: string[]) {
    if (busy) return;
    busy = true; report('');
    const messages: string[] = [];
    const runs = byUnitInTurn(rowIds).map(rowId => queueSend(rowId, pending(rowId).map(field => ({ id: field.id, value: valueOf(doc(), rowId, field.id) })), messages));
    update();
    await Promise.all(runs);
    finish(messages);
  }
  // Only the edit just committed goes. Anything staged earlier stays in the list, and Undo never sends.
  // One Master edit is one commit, so every ticked channel it touched goes together.
  function autoSend(edits: CellEdit[]) {
    if (!autoSendOn(doc())) return;
    const messages: string[] = [], runs: Promise<void>[] = [];
    for (const rowId of byUnitInTurn([...new Set(edits.map(edit => edit.rowId))])) {
      const entries = edits.filter(edit => edit.rowId === rowId && edit.value && fieldById.has(edit.columnId)).map(edit => ({ id: edit.columnId, value: edit.value }));
      if (entries.length && rowLive(rowId)) runs.push(queueSend(rowId, entries, messages));
    }
    if (!runs.length) return;
    update();
    void Promise.all(runs).then(() => { if (messages.length) report([...new Set(messages)].join(' ')); });
  }
  // A standing choice, so Undo leaves it alone.
  function setAutoSend(on: boolean) { const expected = autoSendOn(doc()); if (on !== expected) store.submit({ kind: 'auto-send', autoSend: on, expected }, false); }
  // The worker holds a connection to every unit whether or not this page is open. While it is open the page waits on the worker,
  // so a change made at a unit shows straight away.
  async function followChanges() {
    while (!disposed) {
      try {
        const before = newestState, reply = await client.call('changes', { after: newestState }) as unknown as Reply & { revision?: unknown };
        adopt(reply);
        if (newestState !== before) { refreshGrid(); update(); }
      } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
  }
  for (const id of ['add-unit', 'empty-add']) el(id).addEventListener('click', () => showDialog());
  let unitRemoval: Extract<Mutation, { kind: 'units' }> | undefined;
  const countInput = input('unit-count'), removeDialog = el<HTMLDialogElement>('remove-dialog');
  countInput.addEventListener('change', () => {
    const have = doc().units.length;
    try {
      const operation = setUnitCount(doc(), countInput.value === '' ? NaN : Number(countInput.value), () => crypto.randomUUID());
      if (!operation) return;
      const filled = operation.remove.filter(unitHasData);
      if (!filled.length) { store.submit(operation); return; }
      unitRemoval = operation;
      el('remove-names').textContent = filled.map(unit => shownName(observed, unit) || hostOf(unit)).join(', ');
      el('remove-title').textContent = 'Remove ' + operation.remove.length + ' FS-HDR' + (operation.remove.length === 1 ? '' : 's') + '?';
      removeDialog.showModal();
    } catch (error) { report(error instanceof Error ? error.message : String(error)); countInput.value = String(have); }
  });
  countInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); countInput.blur(); } });
  el('remove-confirm').addEventListener('click', () => { const operation = unitRemoval; unitRemoval = undefined; removeDialog.close(); if (operation) store.submit(operation); });
  el('remove-cancel').addEventListener('click', () => removeDialog.close());
  removeDialog.addEventListener('close', () => { unitRemoval = undefined; countInput.value = String(doc().units.length); });
  el('refresh-units').addEventListener('click', () => void refreshUnits());
  el('pending-toggle').addEventListener('click', () => togglePending(el('pending-toggle').getAttribute('aria-expanded') !== 'true'));
  el('pending-close').addEventListener('click', () => togglePending(false));
  el('send-manual').addEventListener('click', () => setAutoSend(false));
  el('send-auto').addEventListener('click', () => setAutoSend(true));
  const sendAll = () => void sendRows(stagedRowIds(doc()).filter(rowId => rowLive(rowId) && pending(rowId).length > 0));
  el('send-all').addEventListener('click', sendAll); el('send-all-bar').addEventListener('click', sendAll);
  el('cancel-all').addEventListener('click', () => cancelSends(stagedRowIds(doc()).flatMap(addresses)));
  const selectMaster = (selected: string[]) => store.submit({ kind: 'master', selected, expected: masterSelection(doc()) }, false);
  el('master-all').addEventListener('click', () => selectMaster(rowsFor(doc(), observed, 'channels').filter(row => row.kind === 'channel').map(row => row.id)));
  el('master-none').addEventListener('click', () => selectMaster([]));
  for (const [id, expanded] of [['expand-all', true], ['collapse-all', false]] as const) el(id).addEventListener('click', () => { const view = clone(doc().view); view.expanded = Object.fromEntries(groupsOf(scopeOf(activeKind(doc()))).map(g => [g.id, expanded])); store.submit(viewChange(doc(), view)); });
  for (const [id, orientation] of orientationButtons) el(id).addEventListener('click', () => { if (activeSheet(doc()).kind === 'channels' && (orientation === 'columns') !== isFlipped(doc())) store.submit(setOrientation(doc(), activeSheetId(doc()), orientation)); });
  el('details-toggle').addEventListener('click', () => { const pane = el('setting-details'); pane.hidden = !pane.hidden; el('details-toggle').setAttribute('aria-expanded', String(!pane.hidden)); renderDetails(); });
  for (const id of ['close-dialog', 'cancel-dialog']) el(id).addEventListener('click', () => dialog.close());
  async function submitDialog() {
    if (el<HTMLButtonElement>('dialog-submit').disabled) return;
    el('dialog-error').hidden = true;
    try {
      const host = input('unit-host').value.trim();
      if (!validHost(host)) throw Error('Enter a valid hostname or IPv4 address, with an optional port.');
      if (doc().units.some(unit => hostOf(unit) === host)) throw Error('That address is already in Setup.');
      const unit: Unit = newUnit(crypto.randomUUID(), 'FS-HDR ' + (doc().units.length + 1), host);
      if (!store.submit({ kind: 'units', add: [unit], remove: [] })) throw Error(store.error);
      dialog.close(); if (activeKind(doc()) === 'setup') openGrid().select({ rowId: unit.id, columnId: 'unit-host' });
    } catch (error) { el('dialog-error').textContent = error instanceof Error ? error.message : String(error); el('dialog-error').hidden = false; }
    finally { el<HTMLButtonElement>('dialog-submit').disabled = false; }
  }
  // Custom pages intentionally omit allow-forms. Handle user intent directly:
  // browsers may block the native submission before dispatching a submit event.
  form.addEventListener('submit', event => { event.preventDefault(); void submitDialog(); });
  el('dialog-submit').addEventListener('click', event => { event.preventDefault(); void submitDialog(); });
  form.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) { event.preventDefault(); void submitDialog(); } });
  el('loading').hidden = true; update(); refreshGrid();
  void followChanges();
  const first = rowsFor(doc(), observed, activeKind(doc())).find(row => row.kind !== 'master');
  if (first) openGrid().select({ rowId: first.id, columnId: activeKind(doc()) === 'setup' ? 'unit-name' : 'row-unit' });
  window.addEventListener('pagehide', () => { disposed = true; stop(); for (const grid of grids.values()) grid.dispose(); textControls.dispose(); sheetTabs.dispose(); client.dispose(); }, { once: true });
} catch (error) { el('loading').hidden = true; report(error instanceof Error ? error.message : 'FS-HDR could not start.'); saveStatus.textContent = 'Workspace unavailable'; }
