import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ModuleWindowPartsSchema, type ModuleContext, type ModuleInstance } from '@hubble/module-sdk';
import manifest from '../src/manifest.js';
import { createBackend, type WireObserved } from '../src/backend.js';
import { activeSheetId, addSheet, channelRowId, clone, defaultDocument, newUnit, removeSheet, renameSheet, setOrientation, sheetList, showSheet, valueOf, viewChange, windowParts, type FsDocument, type Mutation } from '../src/model.js';
import { fromWire, reportedEdits } from '../src/rows.js';
import { DraftStore, followSaved, takeReported, type SaveReceipt } from '../src/draft-store.js';
import type { Observed } from '../src/backend.js';
import { fakeUnit, type FakeUnit } from './fake-unit.js';

/*
 * HubDash can show the FS-HDR page in several windows at once, each its own copy of the page talking to one running module.
 * These run copies of the page's own parts (its draft store, its rule for following what is saved, and the names live units
 * report) against the worker code and a fake FS-HDR on this computer. Nothing reaches a real unit.
 */

const until = async (check: () => boolean, message = 'condition') => { for (let i = 0; i < 400 && !check(); i++) await delay(10); assert.ok(check(), message); };
type Snapshot = SaveReceipt & Partial<WireObserved>;
type Published = { values?: Partial<WireObserved> & { revision?: unknown } };

/**
 * The worker with a stand-in for Hubble's document store, which only takes a save while a page command is running.
 * Like HubDash, every open copy of the page is handed the module's state after it is published, and only when it changed.
 */
async function host(plan: FsDocument) {
  const stored = new Map<string, { revision: number; value: unknown }>([['fshdr-plan', { revision: 1, value: plan }], ['setup', { revision: 1, value: {} }], ['fshdr-sim', { revision: 1, value: { version: 1, units: {} } }]]);
  const record = (id: string) => ({ id, version: 1, revision: String(stored.get(id)!.revision), value: stored.get(id)!.value });
  let commands = 0;
  const services = { async request(_service: string, _version: number, input: { method: string; id: string; expectedRevision?: string; value?: unknown }, signal?: AbortSignal) {
    if (input.method === 'watch') return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    if (input.method === 'write') { if (!commands) throw Error('Document edits require an active command'); if (input.expectedRevision !== String(stored.get(input.id)!.revision)) return { status: 'conflict', document: record(input.id) }; stored.set(input.id, { revision: stored.get(input.id)!.revision + 1, value: input.value }); }
    return { status: 'document', document: record(input.id) };
  } };
  const pages = new Set<(state: Published) => void>(), lifetime = new AbortController();
  let latest: Published | undefined;
  const worker: ModuleInstance = createBackend({ services, connectionEnabled: true, settings: {}, log: () => {}, publishFeedback: () => {},
    publishState: (state: Published) => { latest = state; setTimeout(() => { for (const deliver of pages) deliver(state); }, 0); } } as unknown as ModuleContext);
  const call = async (commandId: string, value?: unknown, signal = lifetime.signal) => { commands++; try { return await worker.call!('page.fshdr', { sectionId: 'frontend', commandId, value } as never, { signal } as never) as unknown as Snapshot; } finally { commands--; } };
  await worker.start?.();
  return { call, pages, latest: () => latest, plan: () => stored.get('fshdr-plan')!.value as FsDocument, revision: () => stored.get('fshdr-plan')!.revision, async stop() { lifetime.abort(); await worker.dispose?.(); } };
}

/**
 * One copy of the FS-HDR page in one window, wired the way frontend.ts wires itself: edits show at once and save in order
 * through the worker, the copy follows the plan revision the worker publishes, and it saves the name and mode live units
 * report. `hold` stops HubDash handing this copy the module's state until `release`.
 */
async function openCopy(h: Awaited<ReturnType<typeof host>>, sheet: string | null = null) {
  const initial = await h.call('snapshot');
  let observed: Observed = { units: {}, rows: {}, choiceSets: [] }, newest = 0;
  const adopt = (next: Partial<WireObserved>) => {
    if (!next.units || !next.rows || !next.choiceSets || !next.columns || !next.strings || !next.cells || !next.shapes) return;
    if (typeof next.sequence === 'number') { if (next.sequence < newest) return; newest = next.sequence; }
    observed = fromWire(next as WireObserved);
  };
  adopt(initial);
  let saves = 0;
  const store = new DraftStore(initial, async (operation: Mutation) => { saves++; const reply = await h.call('save', { operation }); adopt(reply); return reply; });
  // A window HubDash opened for one tab, as frontend.ts sets it from `page.view`.
  store.sheet = sheet;
  const follow = followSaved(store, () => h.call('snapshot'));
  let refusals = 0;
  store.onRefused(() => { refusals++; });
  const errors: string[] = [];
  let shownError = '';
  const adoptNames = () => takeReported(store, () => reportedEdits(store.document, observed));
  // The page's update(): a new save error is shown once, and the names live units report are taken.
  const update = () => { if (store.error !== shownError) { shownError = store.error; if (shownError) errors.push(shownError); } adoptNames(); };
  store.subscribe(update);
  let held = false;
  const waiting: Published[] = [];
  const deliver = (state: Published) => {
    if (held) { waiting.push(state); return; }
    const values = state.values;
    if (!values || typeof values !== 'object') return;
    adopt(values); update(); follow.saw(values.revision);
  };
  let delivered = '';
  const fromHubDash = (state: Published) => { const text = JSON.stringify(state); if (text === delivered) return; delivered = text; deliver(state); };
  h.pages.add(fromHubDash);
  if (h.latest()) fromHubDash(h.latest()!);
  update();
  return {
    store, errors,
    get saves() { return saves; },
    get refusals() { return refusals; },
    /** Hands this copy only the newest state HubDash held back, as when it skips ahead after a slow moment. */
    releaseNewest() { held = false; const newest = waiting.splice(0).at(-1); if (newest) deliver(newest); },
    value: (rowId: string, columnId: string) => valueOf(store.document, rowId, columnId),
    /** Types a value into a cell, as the grid does: the edit carries what this copy shows there now. */
    edit: (rowId: string, columnId: string, value: string) => store.submit({ kind: 'edit', edits: [{ rowId, columnId, value, expected: valueOf(store.document, rowId, columnId) }] }),
    saved: () => store.whenSaved(),
    hold() { held = true; },
    release() { held = false; for (const state of waiting.splice(0)) deliver(state); },
    close() { follow.dispose(); h.pages.delete(fromHubDash); },
  };
}

const planWith = (unit: FakeUnit) => { const plan = defaultDocument(); plan.units = [newUnit('u1', 'FS-HDR 1', unit.host)]; plan.units[0]!.values['unit-allow'] = 'TRUE'; return plan; };

/** One running worker with a live fake FS-HDR, and a first copy of the page that has taken the unit's name. */
async function running(t: { after(fn: () => unknown): void }) {
  const unit = await fakeUnit({ name: 'Bench' });
  t.after(() => unit.close());
  const h = await host(planWith(unit));
  t.after(() => h.stop());
  const first = await openCopy(h);
  t.after(() => first.close());
  await until(() => valueOf(h.plan(), 'u1', 'unit-name') === 'Bench', 'the first copy takes the name the unit reports');
  return { unit, h, first };
}

test('the FS-HDR page is declared for several windows', () => {
  const section = manifest.pages![0]!.sections[0]!;
  assert.equal('windows' in section && section.windows, true);
  assert.ok('requiredFeatures' in manifest.host && manifest.host.requiredFeatures?.includes('module-page-windows-v1'));
});

test('an edit saved in one window shows in the other without reopening it, and each window’s next edit lands', async t => {
  const { unit, h, first } = await running(t);
  const second = await openCopy(h);
  t.after(() => second.close());

  first.edit('u1', 'ChannelName1', 'CAM 1');
  await until(() => second.value('u1', 'ChannelName1') === 'CAM 1', 'the second window shows the first window’s edit');
  // The second window changes the same cell, and another, without having been reopened.
  second.edit('u1', 'ChannelName1', 'CAM 2');
  second.edit(channelRowId('u1', 2), 'Vid#ColorHDRTransform', '8');
  await second.saved();
  await until(() => first.value('u1', 'ChannelName1') === 'CAM 2' && first.value(channelRowId('u1', 2), 'Vid#ColorHDRTransform') === '8', 'the first window shows the second window’s edits');
  assert.equal(valueOf(h.plan(), 'u1', 'ChannelName1'), 'CAM 2');
  assert.equal(valueOf(h.plan(), channelRowId('u1', 2), 'Vid#ColorHDRTransform'), '8');

  // Staged in one window, sent from the other.
  const sent = await h.call('send', { rowId: 'u1', fieldIds: ['ChannelName1'] }) as unknown as { outcomes: { status: string }[] };
  assert.deepEqual(sent.outcomes.map(outcome => outcome.status), ['verified']);
  assert.equal(unit.values['eParamID_Vid1_ChannelName'], 'CAM 2');
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(first.store.invalid.size + second.store.invalid.size, 0);
});

test('both windows take a unit’s new name together, and neither shows a refusal', async t => {
  const { unit, h, first } = await running(t);
  const second = await openCopy(h);
  t.after(() => second.close());
  await delay(50);
  const revision = h.revision();
  // Renamed at the unit: both windows see it in the same state, and both save it.
  unit.change('eParamID_SystemName', 'Stage Left');
  await until(() => valueOf(h.plan(), 'u1', 'unit-name') === 'Stage Left', 'the plan has the new name');
  await delay(100);
  await first.saved(); await second.saved();
  await until(() => first.value('u1', 'unit-name') === 'Stage Left' && second.value('u1', 'unit-name') === 'Stage Left', 'both windows show it');
  assert.equal(first.saves + second.saves >= 2, true, 'both windows saved the name');
  assert.equal(first.refusals + second.refusals, 0, 'the second save of the same name is not refused');
  assert.equal(h.revision(), revision + 1, 'the plan is saved once: the second save has nothing to change');
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(first.store.invalid.size + second.store.invalid.size, 0, 'no cell is left marked as a refused draft');
});

test('a window that sees a unit’s newer name before the plan another window saved takes it once it has caught up', async t => {
  const { unit, h, first } = await running(t);
  const second = await openCopy(h);
  t.after(() => second.close());
  await delay(50);
  second.hold();
  unit.change('eParamID_SystemName', 'Stage Left');
  await until(() => valueOf(h.plan(), 'u1', 'unit-name') === 'Stage Left', 'the first window takes the new name');
  first.hold();
  unit.change('eParamID_SystemName', 'Stage Right');
  await delay(300);
  // The second window hears the unit's newest name while it still holds the plan from before either rename.
  const before = second.saves;
  second.releaseNewest();
  await until(() => valueOf(h.plan(), 'u1', 'unit-name') === 'Stage Right', 'the second window saves the newest name');
  await second.saved();
  assert.ok(second.saves - before <= 2, 'one refused save and one that lands, not a run of them: ' + (second.saves - before));
  assert.deepEqual(second.errors, [], 'nothing the operator did was refused, so nothing is shown');
  first.release();
  await until(() => first.value('u1', 'unit-name') === 'Stage Right', 'the first window follows');
  assert.deepEqual(first.errors, []);
});

test('a window whose edit is refused reads the plan again, so its next edit to that cell lands', async t => {
  const { h, first } = await running(t);
  const second = await openCopy(h);
  t.after(() => second.close());
  await delay(50);
  // The second window hears nothing from HubDash while the first window changes a cell.
  second.hold();
  first.edit('u1', 'ChannelName2', 'CAM A');
  await first.saved();
  // The second window still shows the cell empty, so its edit is refused: another window changed it.
  second.edit('u1', 'ChannelName2', 'CAM B');
  await second.saved();
  assert.match(second.errors.at(-1) ?? '', /changed in another editor/);
  assert.equal(second.store.invalid.get('u1/ChannelName2')?.edit.value, 'CAM B', 'the typed value stays in the cell');
  // Without any state from HubDash, the window now holds what was saved.
  await until(() => second.value('u1', 'ChannelName2') === 'CAM A', 'the refused window reads the plan again');
  // Entering the draft again saves it.
  second.edit('u1', 'ChannelName2', 'CAM B');
  await second.saved();
  assert.equal(valueOf(h.plan(), 'u1', 'ChannelName2'), 'CAM B');
  assert.equal(second.errors.length, 1);
  second.release();
  await until(() => first.value('u1', 'ChannelName2') === 'CAM B', 'the first window follows');
});

test('the open tab and column layout are shared, as chosen: a tab opened in one window opens in the other, and nothing is refused', async t => {
  const { h, first } = await running(t);
  const second = await openCopy(h);
  t.after(() => second.close());
  await delay(50);
  const master = sheetList(first.store.document).find(sheet => sheet.kind === 'master')!.id;
  first.store.submit({ kind: 'select-sheet', sheetId: master }, false);
  await until(() => activeSheetId(second.store.document) === master, 'the second window opens the same tab');
  second.store.submit(viewChange(second.store.document, { ...clone(second.store.document.view), textSize: 15 }));
  await until(() => first.store.document.view.textSize === 15, 'the first window takes the second window’s layout');
  assert.deepEqual([...first.errors, ...second.errors], []);
});

test('eight windows each wait for the next change, and a change at the unit answers all of them', async t => {
  const { unit, h } = await running(t);
  await delay(150);
  const after = Number((h.latest()?.values as { sequence?: number } | undefined)?.sequence ?? 0);
  const waits = Array.from({ length: 8 }, () => h.call('changes', { after }));
  await delay(50);
  unit.change('eParamID_Vid3_ChannelName', 'ISO 3');
  const answers = await Promise.all(waits);
  for (const answer of answers) {
    assert.ok((answer.sequence ?? 0) > after);
    assert.equal(fromWire(answer as WireObserved).rows['u1']?.values['ChannelName3'], 'ISO 3');
  }
});

const sheetOf = (doc: FsDocument, id: string) => sheetList(doc).find(sheet => sheet.id === id);

test('each tab is a part HubDash’s sidebar opens, and the list follows tabs added, renamed and removed', async t => {
  const { h, first } = await running(t);
  const section = manifest.pages![0]!.sections[0]!;
  assert.deepEqual('parts' in section && section.parts, { value: 'windowParts' });
  const parts = () => (h.latest()?.values as { windowParts?: { view: string; title: string }[] } | undefined)?.windowParts;
  const titles = () => parts()?.map(part => part.title).join(', ');
  await until(() => titles() === 'Setup, Master, HDR', 'the worker lists the three tabs');
  assert.deepEqual(parts()!.map(part => part.view), ['setup', 'master', 'hdr']);
  // Hubble checks the list against its own schema, and offers none if it fails.
  ModuleWindowPartsSchema.parse(parts());

  first.store.submit(addSheet(first.store.document, 'sizing-tab', 'Sizing'));
  await first.saved();
  await until(() => titles() === 'Setup, Master, HDR, Sizing', 'a tab the operator adds is listed');
  first.store.submit(renameSheet(first.store.document, 'sizing-tab', 'Sizes')!);
  await first.saved();
  await until(() => titles() === 'Setup, Master, HDR, Sizes', 'a renamed tab is listed by its new name');
  assert.equal(parts()!.at(-1)!.view, 'sizing-tab', 'its window keeps its view: the tab’s ID');
  first.store.submit(removeSheet(first.store.document, 'sizing-tab')!);
  await first.saved();
  await until(() => titles() === 'Setup, Master, HDR', 'a removed tab is no longer listed');
  assert.deepEqual(first.errors, []);
});

test('the sidebar lists at most 24 tabs, each by its ID and its name on one line', () => {
  const plan = defaultDocument();
  for (let index = 0; index < 29; index++) plan.sheets.push({ id: 'tab-' + index, name: 'Tab ' + index, kind: 'channels', orientation: 'rows', view: clone(plan.sheets[2]!.view!) });
  plan.sheets[3]!.name = 'Two\nlines';
  const parts = windowParts(plan);
  assert.equal(parts.length, 24);
  assert.deepEqual(parts[3], { view: 'tab-0', title: 'Two lines' });
  ModuleWindowPartsSchema.parse(parts);
});

test('a tab’s own window keeps to its tab while the page changes tabs, and never changes the page’s open tab', async t => {
  const { h, first } = await running(t);
  const hdr = await openCopy(h, 'hdr');
  t.after(() => hdr.close());
  assert.equal(activeSheetId(hdr.store.shown), 'hdr');
  assert.equal(activeSheetId(h.plan()), 'setup');

  // The whole page opens Master. The HDR window hears it and stays on HDR.
  first.store.submit({ kind: 'select-sheet', sheetId: 'master' }, false);
  await first.saved();
  await until(() => activeSheetId(hdr.store.document) === 'master', 'the HDR window follows the saved plan');
  assert.equal(activeSheetId(hdr.store.shown), 'hdr');

  // A layout change in the HDR window changes HDR where it is: the page keeps Master open, and shows the change on HDR.
  const before = clone(hdr.store.shown.view);
  hdr.store.submit(viewChange(hdr.store.shown, { ...clone(before), textSize: 16 }, true));
  await hdr.saved();
  assert.equal(activeSheetId(h.plan()), 'master');
  assert.equal(sheetOf(h.plan(), 'hdr')!.view.textSize, 16);
  await until(() => sheetOf(first.store.document, 'hdr')?.view.textSize === 16, 'the page has HDR’s new layout');
  assert.equal(activeSheetId(first.store.document), 'master');
  // Undo in the HDR window puts it back, still without opening HDR anywhere else.
  hdr.store.history(false);
  await hdr.saved();
  assert.equal(activeSheetId(h.plan()), 'master');
  assert.equal(sheetOf(h.plan(), 'hdr')!.view.textSize, before.textSize);

  // Channels on their side, from the HDR window: HDR turns, Master stays open.
  const turn = setOrientation(hdr.store.shown, 'hdr', 'columns');
  delete turn.activeSheetId;
  hdr.store.submit(turn);
  await hdr.saved();
  assert.equal(activeSheetId(h.plan()), 'master');
  assert.equal(h.plan().sheets.find(sheet => sheet.id === 'hdr')!.orientation, 'columns');
  hdr.store.history(false);
  await hdr.saved();
  assert.equal(activeSheetId(h.plan()), 'master');
  assert.equal(h.plan().sheets.find(sheet => sheet.id === 'hdr')!.orientation, 'rows');

  // With HDR open on the page too, a change from either window is the same layout.
  first.store.submit({ kind: 'select-sheet', sheetId: 'hdr' }, false);
  await first.saved();
  await until(() => activeSheetId(hdr.store.document) === 'hdr', 'the HDR window hears HDR is open');
  hdr.store.submit(viewChange(hdr.store.shown, { ...clone(hdr.store.shown.view), textSize: 14 }, true));
  await hdr.saved();
  await until(() => first.store.document.view.textSize === 14, 'the page shows the layout the HDR window set');
  first.store.submit(viewChange(first.store.document, { ...clone(first.store.document.view), textSize: 15 }));
  await first.saved();
  await until(() => hdr.store.shown.view.textSize === 15, 'the HDR window shows the layout the page set');
  assert.deepEqual([...first.errors, ...hdr.errors], []);
  assert.equal(first.refusals + hdr.refusals, 0);
});

test('a tab removed elsewhere leaves its own window with nothing of another tab to show', async t => {
  const { h, first } = await running(t);
  first.store.submit(addSheet(first.store.document, 'gone-tab', 'Going'));
  await first.saved();
  const own = await openCopy(h, 'gone-tab');
  t.after(() => own.close());
  assert.equal(activeSheetId(own.store.shown), 'gone-tab');
  first.store.submit(removeSheet(first.store.document, 'gone-tab')!);
  await first.saved();
  await until(() => !own.store.document.sheets.some(sheet => sheet.id === 'gone-tab'), 'the window hears the tab is gone');
  // frontend.ts then shows "This tab is no longer in FS-HDR"; the plan it holds is the page’s, unchanged.
  assert.equal(own.store.shown, own.store.document);
  assert.equal(showSheet(own.store.document, 'gone-tab'), own.store.document);
});
