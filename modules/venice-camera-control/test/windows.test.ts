import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleContext, ModuleInstance } from '@hubble/module-sdk';
import manifest from '../src/manifest.js';
import { createBackend } from '../src/backend.js';
import { activeSheetId, addSheet, clone, defaultDocument, fields, valueOf, viewChange, type CameraDocument, type Mutation } from '../src/model.js';
import { applyPresetMutation, defaultPresetDocument, inversePreset, presetFields, type PresetDocument, type PresetMutation } from '../src/presets-model.js';
import { DraftStore, Drafts, followSaved, type Receipt } from '../src/draft-store.js';
import { fakeCamera } from './fake-camera.js';

/*
 * HubDash can show Camera Control in several windows at once, each its own copy of the page talking to one running
 * module. These run copies of the page's own parts (its draft stores for the camera plan and the presets, and its rule for
 * following what is saved) against the worker code and a fake VENICE on this computer. Nothing reaches a real camera.
 */

const until = async (check: () => boolean, message = 'condition') => { for (let i = 0; i < 400 && !check(); i++) await delay(10); assert.ok(check(), message); };
const cameraId = fields.find(f => f.property === 'P.System.Menu.ClipnamingCameraid')!;
const reel = fields.find(f => f.property === 'P.System.Menu.ClipnamingReelNum')!;
const row = 'cam-0';
type Published = { values?: { revision?: unknown; presetsRevision?: unknown; sequence?: number } };
type Reply = Receipt<CameraDocument> & { sequence?: number };

/**
 * The worker with a stand-in for Hubble's document store, which only takes a save while a page command is running.
 * Like HubDash, every open copy of the page is handed the module's state after it is published, and only when it changed.
 */
async function host(staged: Record<string, string> = {}) {
  const camera = await fakeCamera({ values: { [cameraId.property]: '65', [reel.property]: '1' } });
  const plan = defaultDocument();
  plan.cameras = [{ id: row, values: { 'camera-name': 'Camera 1', 'camera-host': camera.host, 'camera-username': 'operator', 'camera-password': 'fixture-password', ...staged } }];
  const stored = new Map<string, { revision: number; value: unknown }>([['camera-plan', { revision: 1, value: plan }], ['camera-presets', { revision: 1, value: defaultPresetDocument() }]]);
  const record = (id: string) => ({ id, version: 1, revision: String(stored.get(id)!.revision), value: stored.get(id)!.value });
  let commands = 0;
  const services = { async request(_service: string, _version: number, input: { method: string; id: string; expectedRevision?: string; value?: unknown }, signal?: AbortSignal) {
    if (input.method === 'watch') return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    if (input.method === 'write') { if (!commands) throw Error('Document edits require an active command'); if (input.expectedRevision !== String(stored.get(input.id)!.revision)) return { status: 'conflict', document: record(input.id) }; stored.set(input.id, { revision: stored.get(input.id)!.revision + 1, value: input.value }); }
    return { status: 'document', document: record(input.id) };
  } };
  const pages = new Set<(state: Published) => void>(), lifetime = new AbortController();
  let latest: Published | undefined;
  const worker: ModuleInstance = createBackend({ services, connectionEnabled: true, settings: {}, log: () => {}, publishFeedback: () => {}, publishEvent: () => {},
    publishState: (state: Published) => { latest = state; setTimeout(() => { for (const deliver of pages) deliver(state); }, 0); } } as unknown as ModuleContext, async () => 'answered');
  const call = async <T = Reply>(commandId: string, value?: unknown) => { commands++; try { return await worker.call!('page.cameras', { sectionId: 'frontend', commandId, value } as never, { signal: lifetime.signal } as never) as unknown as T; } finally { commands--; } };
  await worker.start?.();
  return { camera, call, pages, latest: () => latest, plan: () => stored.get('camera-plan')!.value as CameraDocument, presets: () => stored.get('camera-presets')!.value as PresetDocument,
    revision: (id = 'camera-plan') => stored.get(id)!.revision, async stop() { lifetime.abort(); await worker.dispose?.(); await camera.close(); } };
}

/**
 * One copy of Camera Control in one window, wired the way frontend.ts and presets-view.ts wire themselves: edits show at
 * once and save in order through the worker, and each document follows the revision the worker publishes.
 * `hold` stops HubDash handing this copy the module's state until `release`.
 */
async function openCopy(h: Awaited<ReturnType<typeof host>>) {
  const store = new DraftStore(await h.call('snapshot'), operation => h.call('save', { operation }));
  const follow = followSaved(store, () => h.call('snapshot'));
  const presets = new Drafts<PresetDocument, PresetMutation>(await h.call<Receipt<PresetDocument>>('presets-snapshot'), async operation => await h.call<Receipt<PresetDocument>>('presets-save', { operation }), applyPresetMutation, inversePreset);
  const followPresets = followSaved(presets, () => h.call<Receipt<PresetDocument>>('presets-snapshot'));
  const errors: string[] = [];
  let refusals = 0;
  for (const drafts of [store, presets] as const) {
    let shown = '';
    // The page's update(): a new save error is shown once.
    drafts.subscribe(() => { if (drafts.error !== shown) { shown = drafts.error; if (shown) errors.push(shown); } });
    drafts.onRefused(() => { refusals++; });
  }
  let held = false, delivered = '';
  const waiting: Published[] = [];
  const deliver = (state: Published) => {
    if (held) { waiting.push(state); return; }
    const values = state.values;
    if (!values || typeof values !== 'object') return;
    follow.saw(values.revision);
    if (values.presetsRevision) followPresets.saw(values.presetsRevision);
  };
  const fromHubDash = (state: Published) => { const text = JSON.stringify(state); if (text === delivered) return; delivered = text; deliver(state); };
  h.pages.add(fromHubDash);
  if (h.latest()) fromHubDash(h.latest()!);
  return {
    store, presets, errors,
    get refusals() { return refusals; },
    value: (columnId: string) => valueOf(store.document.cameras.find(item => item.id === row)!, columnId),
    /** Types a value into a camera cell, as the grid does: the edit carries what this copy shows there now. */
    edit(columnId: string, value: string) { const expected = valueOf(store.document.cameras.find(item => item.id === row)!, columnId); return store.submit({ kind: 'edit', edits: [{ rowId: row, columnId, value, expected }] } as Mutation); },
    saved: async () => { await store.whenSaved(); await presets.whenSaved(); },
    hold() { held = true; },
    release() { held = false; for (const state of waiting.splice(0)) deliver(state); },
    close() { follow.dispose(); followPresets.dispose(); h.pages.delete(fromHubDash); },
  };
}

async function twoWindows(t: { after(fn: () => unknown): void }, staged: Record<string, string> = {}) {
  const h = await host(staged);
  t.after(() => h.stop());
  const first = await openCopy(h), second = await openCopy(h);
  t.after(() => { first.close(); second.close(); });
  await delay(50);
  return { h, first, second };
}

test('Camera Control is declared for several windows', () => {
  const section = manifest.pages![0]!.sections[0]!;
  assert.equal('windows' in section && section.windows, true);
  assert.ok('requiredFeatures' in manifest.host && manifest.host.requiredFeatures?.includes('module-page-windows-v1'));
});

test('a setting staged in one window shows in the other without reopening it, each window’s next edit lands, and the other window can send it', async t => {
  const { h, first, second } = await twoWindows(t);
  first.edit(cameraId.id, 'C');
  await until(() => second.value(cameraId.id) === 'C', 'the second window shows the first window’s edit');
  second.edit(cameraId.id, 'D');
  second.edit(reel.id, '101');
  await second.saved();
  await until(() => first.value(cameraId.id) === 'D' && first.value(reel.id) === '101', 'the first window shows the second window’s edits');
  assert.equal(valueOf(h.plan().cameras[0]!, cameraId.id), 'D');
  const sent = await h.call<{ outcomes: { status: string }[] }>('send', { rowId: row, host: h.camera.host, fieldIds: [cameraId.id] });
  assert.deepEqual(sent.outcomes.map(outcome => outcome.status), ['verified']);
  assert.ok(h.camera.writes.some(write => cameraId.property in write), 'the camera was written');
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(first.store.invalid.size + second.store.invalid.size, 0);
});

test('both windows clear a value the camera confirmed, and neither is refused', async t => {
  const { h, first, second } = await twoWindows(t, { [cameraId.id]: 'C' });
  const revision = h.revision();
  // After a read or a send each window drops staged values the camera now has. With two windows, both do.
  const confirmed = [{ rowId: row, columnId: cameraId.id, value: '', expected: 'C' }];
  first.store.confirm(confirmed);
  second.store.confirm(confirmed);
  await first.saved(); await second.saved();
  await until(() => first.value(cameraId.id) === '' && second.value(cameraId.id) === '', 'both windows show it cleared');
  assert.equal(first.refusals + second.refusals, 0, 'the second clear is not refused');
  assert.equal(h.revision(), revision + 1, 'the plan is saved once: the second clear has nothing to change');
  assert.deepEqual([...first.errors, ...second.errors], []);
});

test('a window clearing a confirmed value that another window has since changed says nothing, and shows the newer value', async t => {
  const { h, first, second } = await twoWindows(t, { [cameraId.id]: 'C' });
  second.hold();
  first.edit(cameraId.id, 'D');
  await first.saved();
  // The second window still holds the old staged value when the camera confirms it.
  second.store.confirm([{ rowId: row, columnId: cameraId.id, value: '', expected: 'C' }]);
  await second.saved();
  await until(() => second.value(cameraId.id) === 'D', 'the second window reads the plan again and shows the newer value');
  assert.equal(valueOf(h.plan().cameras[0]!, cameraId.id), 'D', 'the newer value is kept');
  assert.deepEqual(second.errors, [], 'the operator did nothing that was refused, so nothing is shown');
  assert.equal(second.store.invalid.size, 0);
  second.release();
});

test('a window whose edit is refused reads the plan again, so its next edit to that cell lands', async t => {
  const { h, first, second } = await twoWindows(t);
  second.hold();
  first.edit(reel.id, '101');
  await first.saved();
  // The second window still shows the cell empty, so its edit is refused: another window changed it.
  second.edit(reel.id, '202');
  await second.saved();
  assert.match(second.errors.at(-1) ?? '', /changed in another editor/);
  assert.equal(second.store.invalid.get(row + '/' + reel.id)?.edit.value, '202', 'the typed value stays in the cell');
  await until(() => second.value(reel.id) === '101', 'the refused window reads the plan again without hearing from HubDash');
  second.edit(reel.id, '202');
  await second.saved();
  assert.equal(valueOf(h.plan().cameras[0]!, reel.id), '202');
  assert.equal(second.errors.length, 1);
  second.release();
  await until(() => first.value(reel.id) === '202', 'the first window follows');
});

test('a preset made in one window shows in the other, and the other window’s next edit to it lands', async t => {
  const { h, first, second } = await twoWindows(t);
  const id = 'role-a', field = presetFields.find(f => f.id === cameraId.id)!;
  first.presets.submit({ kind: 'add', preset: { id, name: 'Role A', values: {} }, index: 1 });
  await until(() => second.presets.document.presets.some(preset => preset.id === id), 'the second window shows the new preset');
  second.presets.submit({ kind: 'edit', edits: [{ rowId: field.id, columnId: id, value: 'C', expected: '' }] } as PresetMutation);
  await second.saved();
  await until(() => first.presets.document.presets.find(preset => preset.id === id)?.values[field.id] === 'C', 'the first window shows the second window’s edit');
  assert.equal(h.presets().presets.find(preset => preset.id === id)?.values[field.id], 'C');
  // Both windows make the same change at the same moment: it is saved once and neither is refused.
  const revision = h.revision('camera-presets');
  for (const copy of [first, second]) copy.presets.submit({ kind: 'edit', edits: [{ rowId: field.id, columnId: id, value: 'D', expected: 'C' }] } as PresetMutation);
  await first.saved(); await second.saved();
  assert.equal(h.presets().presets.find(preset => preset.id === id)?.values[field.id], 'D');
  assert.equal(h.revision('camera-presets'), revision + 1);
  assert.equal(first.refusals + second.refusals, 0);
  assert.deepEqual([...first.errors, ...second.errors], []);
});

test('the open tab and column layout are shared, as chosen: a tab opened in one window opens in the other, and nothing is refused', async t => {
  const { first, second } = await twoWindows(t);
  first.store.submit(addSheet(first.store.document, 'sheet-lens', 'Lens'));
  first.store.submit({ kind: 'select-sheet', sheetId: 'sheet-lens' }, false);
  await until(() => activeSheetId(second.store.document) === 'sheet-lens', 'the second window opens the same tab');
  second.store.submit(viewChange(second.store.document, { ...clone(second.store.document.view), textSize: 15 }));
  await until(() => first.store.document.view.textSize === 15, 'the first window takes the second window’s layout');
  assert.deepEqual([...first.errors, ...second.errors], []);
});

test('eight windows each wait for the next change, and one save answers all of them', async t => {
  const { h, first } = await twoWindows(t);
  const after = Number(h.latest()?.values?.sequence ?? 0);
  const waits = Array.from({ length: 8 }, () => h.call<{ sequence: number }>('changes', { after }));
  await delay(50);
  first.edit(reel.id, '303');
  const answers = await Promise.all(waits);
  for (const answer of answers) assert.ok(answer.sequence > after);
});
