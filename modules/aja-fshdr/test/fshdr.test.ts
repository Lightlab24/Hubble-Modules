import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleContext, ModuleInstance } from '@hubble/module-sdk';
import manifest from '../src/manifest.js';
import { createBackend, type Observed, type WireObserved } from '../src/backend.js';
import { parameterId } from '../src/device.js';
import { addSheet, applyMutation, channelRowId, defaultDocument, fieldById, fields, groups, inverse, moveSheet, newUnit, removeSheet, renameSheet, setUnitCount, sheetList, validateDocument, valueOf, visibleFields, watchedFieldIds, withColumnVisibility, withSectionVisibility, withShownWhenCollapsed, type FsDocument, type Mutation } from '../src/model.js';
import { fromWire, masterRows, normalize, pendingFields, rowsFor, shownLabel, shownName } from '../src/rows.js';
import { DraftStore } from '../src/draft-store.js';
import { fakeUnit, type FakeUnit } from './fake-unit.js';

const until = async (check: () => boolean, message = 'condition') => { for (let i = 0; i < 400 && !check(); i++) await delay(10); assert.ok(check(), message); };
const edit = (rowId: string, columnId: string, value: string, expected = ''): Mutation => ({ kind: 'edit', edits: [{ rowId, columnId, value, expected }] });

/**
 * The worker code with a stand-in for Hubble's document store, so a test sees exactly what the page would.
 * Like Hubble, the store refuses a write unless a page command or a button press is running.
 */
function host(plan: FsDocument, options: { settings?: Record<string, unknown>; earlier?: unknown; connectionEnabled?: boolean; simulated?: unknown } = {}) {
  const stored = new Map<string, { revision: number; value: unknown }>([['fshdr-plan', { revision: 1, value: plan }], ['setup', { revision: 1, value: options.earlier ?? {} }], ['fshdr-sim', { revision: 1, value: options.simulated ?? { version: 1, units: {} } }]]);
  const record = (id: string) => ({ id, version: 1, revision: String(stored.get(id)!.revision), value: stored.get(id)!.value });
  const states: { values: WireObserved & { revision: string } }[] = [], feedback: { id: string; state: string }[] = [], logs: { level: string; message: string }[] = [], lifetime = new AbortController();
  const services = { async request(_service: string, _version: number, input: { method: string; id: string; expectedRevision?: string; value?: unknown }, signal?: AbortSignal) {
    if (input.method === 'watch') return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    if (input.method === 'write') { if (!commands) throw Error('Document edits require an active command'); if (input.expectedRevision !== String(stored.get(input.id)!.revision)) return { status: 'conflict', document: record(input.id) }; stored.set(input.id, { revision: stored.get(input.id)!.revision + 1, value: input.value }); }
    return { status: 'document', document: record(input.id) };
  } };
  let commands = 0;
  const during = async <T>(run: () => Promise<T>): Promise<T> => { commands++; try { return await run(); } finally { commands--; } };
  const worker: ModuleInstance = createBackend({ services, connectionEnabled: options.connectionEnabled ?? true, settings: options.settings ?? {}, log: (entry: never) => logs.push(entry), publishState: (value: never) => states.push(value), publishFeedback: (value: never) => feedback.push(value) } as unknown as ModuleContext);
  const backend: ModuleInstance = { ...worker, call: (...input) => during(async () => worker.call!(...input)), execute: (...input) => during(async () => worker.execute!(...input)) } as ModuleInstance;
  const call = (commandId: string, value?: unknown) => backend.call!('page.fshdr', { sectionId: 'frontend', commandId, value } as never, { signal: lifetime.signal } as never) as unknown as Promise<WireObserved & { document: FsDocument; outcomes?: { fieldId: string; status: string; message?: string }[] }>;
  return { backend, call, states, feedback, logs, plan: () => stored.get('fshdr-plan')!.value as FsDocument, simulated: () => stored.get('fshdr-sim')!.value as { version: 1; units: Record<string, Record<string, string>> }, observed: () => fromWire(states.at(-1)!.values), save: (operation: Mutation) => call('save', { operation }), async stop() { lifetime.abort(); await backend.dispose?.(); } };
}
const planFor = (...units: FakeUnit[]) => { const plan = defaultDocument(); plan.units = units.map((unit, index) => newUnit('u' + (index + 1), 'FS-HDR ' + (index + 1), unit.host)); return plan; };

test('the settings list has stable, unique IDs split between units and channels', () => {
  assert.equal(new Set(fields.map(f => f.id)).size, fields.length);
  assert.ok(groups.filter(g => g.scope === 'channel').every(g => g.fields.every(f => f.id.includes('Vid#'))));
  assert.ok(groups.filter(g => g.scope === 'unit').every(g => g.fields.every(f => !f.id.includes('Vid#'))));
  assert.equal(fieldById.get('Vid#ColorHDRTransform')!.kind, 'choice');
  assert.equal(parameterId('Vid#ColorHDRTransform', 3, '1'), 'eParamID_Vid3ColorHDRTransform');
  assert.equal(parameterId('ChannelName2', null, '1'), 'eParamID_Vid2_ChannelName');
  assert.equal(parameterId('ChannelName1', null, '2'), 'eParamID_Vid0_ChannelName');
  assert.equal(parameterId('ChannelName2', null, '2'), null);
  assert.equal(parameterId('GenlockSource', null, '1'), 'eParamID_GenlockSource');
  assert.equal(parameterId('GenlockSource', 1, '1'), null);
  assert.ok(!fieldById.has('Authentication') && !fieldById.has('SoftwareReset'));
});
test('the manifest keeps the button action and feedback IDs earlier workspaces saved', () => {
  assert.deepEqual(manifest.actions.map(a => a.id), ['set-hdr-transform']);
  assert.deepEqual(manifest.feedback.map(f => f.id), ['all-online', 'hdr-transform-matches']);
  assert.equal(manifest.configVersion, 2);
  validateDocument(manifest.documents!.find(d => d.id === 'fshdr-plan')!.defaultValue);
});
test('the plan stages unit and channel settings, and clears them without leaving empty records', () => {
  let doc = defaultDocument();
  doc = applyMutation(doc, { kind: 'units', add: [newUnit('a', 'FS-HDR 1', '10.0.0.1')], remove: [] });
  doc = applyMutation(doc, edit('a', 'ChannelName1', 'CAM 13'));
  doc = applyMutation(doc, edit(channelRowId('a', 2), 'Vid#ColorHDRTransform', '8'));
  assert.equal(valueOf(doc, 'a', 'ChannelName1'), 'CAM 13'); assert.equal(valueOf(doc, 'a#2', 'Vid#ColorHDRTransform'), '8');
  assert.deepEqual(doc.units[0]!.channels, { '2': { 'Vid#ColorHDRTransform': '8' } });
  assert.throws(() => applyMutation(doc, edit('a#2', 'Vid#ColorHDRTransform', '1', 'wrong')), /changed in another editor/);
  assert.throws(() => applyMutation(doc, edit('a', 'Vid#ColorHDRTransform', '1')), /not editable/);
  assert.throws(() => applyMutation(doc, edit('a#1', 'GenlockSource', '1')), /not editable/);
  assert.throws(() => applyMutation(doc, edit('a', 'unit-host', 'not a host!', '10.0.0.1')), /valid hostname/);
  const undo = inverse(doc, edit('a#2', 'Vid#ColorHDRTransform', '', '8'));
  const cleared = applyMutation(doc, edit('a#2', 'Vid#ColorHDRTransform', '', '8'));
  assert.equal(cleared.units[0]!.channels, undefined);
  assert.equal(valueOf(applyMutation(cleared, undo), 'a#2', 'Vid#ColorHDRTransform'), '8');
  assert.deepEqual(watchedFieldIds(doc).unit.slice(0, 5), ['SystemName', 'ChannelName1', 'ChannelName2', 'ChannelName3', 'ChannelName4']);
  assert.ok(watchedFieldIds(doc).channel.includes('Vid#ColorHDRTransform'));
  const more = setUnitCount(doc, 3, (() => { let n = 0; return () => 'new-' + ++n; })())!;
  assert.deepEqual(applyMutation(doc, more).units.map(unit => unit.values['unit-name']), ['FS-HDR 1', 'FS-HDR 2', 'FS-HDR 3']);
  assert.throws(() => setUnitCount(doc, 17, () => 'x'), /0 to 16/);
});
test('Setup and Master are fixed tabs, and settings sheets can be added, renamed, moved and removed', () => {
  let doc = defaultDocument();
  assert.deepEqual(sheetList(doc).map(sheet => sheet.kind), ['setup', 'master', 'channels']);
  assert.equal(renameSheet(doc, 'setup', 'Other'), null); assert.equal(removeSheet(doc, 'master'), null); assert.equal(moveSheet(doc, 'setup', null), null);
  doc = applyMutation(doc, addSheet(doc, 'framing', 'Framing'));
  assert.equal(doc.activeSheetId, 'framing'); assert.equal(sheetList(doc).at(-1)!.kind, 'channels');
  assert.deepEqual(visibleFields(doc.view, 'channel').map(f => f.id), visibleFields(sheetList(doc).find(sheet => sheet.id === 'hdr')!.view, 'channel').map(f => f.id));
  doc = applyMutation(doc, moveSheet(doc, 'framing', 'setup')!);
  assert.deepEqual(doc.sheets.map(sheet => sheet.id), ['setup', 'master', 'framing', 'hdr']);
  doc = applyMutation(doc, renameSheet(doc, 'framing', 'Crop')!);
  doc = applyMutation(doc, removeSheet(doc, 'framing')!);
  assert.deepEqual(doc.sheets.map(sheet => sheet.id), ['setup', 'master', 'hdr']);
});
test('ticking a setting in a section that is off brings the section back with only that setting', () => {
  const doc = defaultDocument(), view = sheetList(doc).find(sheet => sheet.id === 'hdr')!.view;
  assert.ok(view.hiddenGroups!.includes('framing'));
  const next = withColumnVisibility(view, [{ id: 'Vid#CustomSize', visible: true }]);
  assert.ok(!next.hiddenGroups!.includes('framing'));
  assert.deepEqual(visibleFields(next, 'channel').filter(f => f.group === 'framing').map(f => f.id), ['Vid#CustomSize']);
});
test('column sections: Show is each setting’s own tick, and When collapsed picks what a collapsed section keeps', () => {
  const view = sheetList(defaultDocument()).find(sheet => sheet.id === 'hdr')!.view!;
  const onScreen = (next: typeof view) => visibleFields(next, 'channel').map(f => f.id);
  // HDR collapsed keeps its three; hiding one of them takes it off, and expanding never brings it back.
  const hidden = withSectionVisibility(view, [{ id: 'Vid#DynamicRangeAndGamut', visible: false }]);
  assert.ok(!onScreen(hidden).includes('Vid#DynamicRangeAndGamut'));
  assert.ok(!onScreen({ ...hidden, expanded: { ...hidden.expanded, hdr: true } }).includes('Vid#DynamicRangeAndGamut'));
  assert.ok(onScreen({ ...hidden, expanded: { ...hidden.expanded, hdr: true } }).includes('Vid#SdrPreview'));
  // When collapsed adds a setting to what the collapsed section keeps, without touching Show.
  const kept = withShownWhenCollapsed(view, [{ id: 'Vid#SdrPreview', shownWhenCollapsed: true }]);
  assert.ok(onScreen(kept).includes('Vid#SdrPreview'));
  assert.deepEqual(kept.hidden, view.hidden);
  // Every setting off switches the section off; ticking one brings it back with just that one.
  const hdr = groups.find(g => g.id === 'hdr')!;
  const off = withSectionVisibility(view, hdr.fields.map(f => ({ id: f.id, visible: false })));
  assert.ok(off.hiddenGroups?.includes('hdr'));
  assert.ok(!off.hidden.some(id => fieldById.get(id)?.group === 'hdr'));
  const one = withSectionVisibility(off, [{ id: 'Vid#ColorHDRTransform', visible: true }]);
  assert.ok(!one.hiddenGroups?.includes('hdr'));
  assert.deepEqual(onScreen(one).filter(id => fieldById.get(id)?.group === 'hdr'), ['Vid#ColorHDRTransform']);
  const all = withSectionVisibility(off, hdr.fields.map(f => ({ id: f.id, visible: true })));
  assert.equal(onScreen({ ...all, expanded: { ...all.expanded, hdr: true } }).filter(id => fieldById.get(id)?.group === 'hdr').length, hdr.fields.length);
});

test('typed values are checked against the unit’s limits before they are staged', () => {
  const size = fieldById.get('Vid#CustomSize')!, seen = { values: {}, locked: {}, choices: {}, errors: {}, sending: [], queued: [], limits: { 'Vid#CustomSize': { precision: 1, min: 10, max: 200, step: 0.1, units: '%' }, ChannelName1: { minLength: 1, maxLength: 9 } } };
  assert.deepEqual(normalize(seen, size, '120'), { value: '120.0' });
  assert.deepEqual(normalize(seen, size, '99.5 %'), { value: '99.5' });
  assert.match((normalize(seen, size, '250') as { error: string }).error, /10 to 200/);
  assert.match((normalize(seen, size, '50.05') as { error: string }).error, /steps of 0.1/);
  assert.match((normalize(seen, fieldById.get('ChannelName1')!, 'Far too long a label') as { error: string }).error, /1 to 9 characters/);
});
test('the draft store shows an edit at once, keeps a second edit while the first save is held, and rolls back only the refused one', async () => {
  const doc = applyMutation(defaultDocument(), { kind: 'units', add: [newUnit('a', 'FS-HDR 1', '10.0.0.1')], remove: [] });
  const saves: { resolve(): void; reject(error: Error): void; operation: Mutation }[] = [];
  let saved = doc;
  const store = new DraftStore({ document: doc, revision: '1' }, operation => new Promise((resolve, reject) => saves.push({ operation, resolve: () => { saved = applyMutation(saved, operation); resolve({ document: saved, revision: String(saves.length + 1) }); }, reject })));
  store.submit(edit('a', 'ChannelName1', 'CAM 13')); store.submit(edit('a#1', 'Vid#ColorHDRTransform', '8'));
  assert.equal(valueOf(store.document, 'a', 'ChannelName1'), 'CAM 13'); assert.equal(valueOf(store.document, 'a#1', 'Vid#ColorHDRTransform'), '8');
  assert.equal(saves.length, 1);
  saves[0]!.reject(Error('Workspace refused it.'));
  await until(() => saves.length === 2);
  assert.equal(valueOf(store.document, 'a', 'ChannelName1'), ''); assert.equal(valueOf(store.document, 'a#1', 'Vid#ColorHDRTransform'), '8');
  assert.equal(store.invalid.get('a/ChannelName1')?.message, 'Workspace refused it.');
  saves[1]!.resolve(); await store.whenSaved();
  assert.equal(valueOf(saved, 'a#1', 'Vid#ColorHDRTransform'), '8'); assert.equal(store.pending.length, 0);
});
test('the worker reads each unit, follows changes made at it, and reports its channels by mode', async () => {
  const four = await fakeUnit({ name: 'Truck A' }), single = await fakeUnit({ name: 'Truck B', mode: '2' }), plan = planFor(four, single);
  plan.units.push(newUnit('u3', 'Spare', '')); plan.units.push(newUnit('u4', 'Copy', four.host));
  const h = host(plan);
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live' && h.observed().units.u2?.state === 'live', 'both units live');
    const seen = h.observed();
    assert.deepEqual([seen.units.u1!.channels, seen.units.u2!.channels], [[1, 2, 3, 4], [0]]);
    assert.deepEqual([seen.units.u1!.name, seen.units.u1!.mode, seen.units.u2!.mode, seen.units.u3!.state, seen.units.u4!.state], ['Truck A', 'HD/SD 4 Ch', '4K/UHD 1 Ch', 'unset', 'duplicate']);
    assert.equal(seen.rows['u1#2']!.values['Vid#ColorHDRTransform'], '3'); assert.equal(seen.rows['u1#2']!.signal, '1080p 23.98');
    assert.deepEqual(seen.choiceSets[seen.rows['u1#2']!.choices['Vid#ColorHDRTransform']!]!.find(choice => choice.value === '8'), { value: '8', label: 'Colorfront Engine-TV' });
    assert.equal(seen.rows.u2!.values.ChannelName1, 'UHD'); assert.match(seen.rows.u2!.locked.ChannelName2!, /operating mode/);
    assert.equal(seen.rows['u1#1']!.values['Vid#OutputFormat'], '1');
    // A unit that isn't live has the rows of the mode it is planned in, ready for presets.
    assert.deepEqual(rowsFor(h.plan(), seen, 'channels').map(row => row.id), ['u1#1', 'u1#2', 'u1#3', 'u1#4', 'u2#0', 'u3#1', 'u3#2', 'u3#3', 'u3#4', 'u4#1', 'u4#2', 'u4#3', 'u4#4']);
    assert.equal(seen.units.u3!.planned, true); assert.deepEqual(seen.units.u3!.channels, [1, 2, 3, 4]); assert.equal(seen.units.u3!.mode, 'HD/SD 4 Ch');
    assert.equal(shownName(seen, h.plan().units[0]!), 'Truck A'); assert.equal(shownLabel(seen, h.plan().units[1]!, 0), 'UHD');
    assert.ok(h.feedback.every(item => item.id !== 'all-online' || item.state === 'unavailable'), 'a unit with no address keeps All online off');
    four.change('eParamID_Vid2ColorHDRTransform', '1'); four.change('eParamID_FrameRateMode', '1');
    await until(() => h.observed().rows['u1#2']!.values['Vid#ColorHDRTransform'] === '1' && h.observed().rows['u1#1']!.values['Vid#OutputFormat'] === '0', 'the change and the remapped setting show');
  } finally { await h.stop(); await four.close(); await single.close(); }
});
test('Send writes only what is staged, confirms by readback, and leaves a refused or unconfirmed setting staged with its reason', async () => {
  const unit = await fakeUnit(), h = host(planFor(unit));
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live');
    await h.save({ kind: 'view', sheetId: 'hdr', view: withColumnVisibility(sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view, [{ id: 'Vid#CustomSizePos', visible: true }, { id: 'Vid#CustomSize', visible: true }, { id: 'Vid#RegionOfInterest', visible: true }, { id: 'Vid#ROILeft', visible: true }]), expected: sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view });
    // Custom Size/Pos is off, and the unit still takes Custom Size. ROI Left really does wait for Region Of Interest.
    assert.equal(h.observed().rows['u1#1']!.locked['Vid#CustomSize'], undefined);
    assert.match(h.observed().rows['u1#1']!.locked['Vid#ROILeft']!, /prerequisite/);
    assert.deepEqual(h.observed().rows['u1#1']!.limits['Vid#CustomSize'], { precision: 1, min: 10, max: 200, step: 0.1, units: '%' });
    await h.save({ kind: 'edit', edits: [{ rowId: 'u1', columnId: 'ChannelName1', value: 'CAM 13', expected: '' }, { rowId: 'u1', columnId: 'SystemName', value: 'Truck A', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#ColorHDRTransform', value: '8', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#ROILeft', value: '50.0', expected: '' }] });
    assert.deepEqual(pendingFields(h.plan(), h.observed(), 'u1').map(f => f.id).sort(), ['ChannelName1', 'SystemName']);
    assert.equal(unit.writes.length, 0, 'staging sends nothing');
    assert.deepEqual((await h.call('send', { rowId: 'u1', fieldIds: ['ChannelName1', 'SystemName'] })).outcomes, [{ fieldId: 'ChannelName1', status: 'verified' }, { fieldId: 'SystemName', status: 'verified' }]);
    assert.deepEqual(unit.writes, [{ id: 'eParamID_Vid1_ChannelName', value: 'CAM 13' }, { id: 'eParamID_SystemName', value: 'Truck A' }]);
    const sent = await h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#ColorHDRTransform', 'Vid#ROILeft'] });
    assert.equal(sent.outcomes![0]!.status, 'verified'); assert.equal(sent.outcomes![1]!.status, 'failed'); assert.match(sent.outcomes![1]!.message!, /prerequisite/);
    assert.equal(unit.values.eParamID_Vid1ColorHDRTransform, '8'); assert.equal(unit.values.eParamID_Vid1ROILeft, '100');
    assert.match(h.observed().rows['u1#1']!.errors['Vid#ROILeft']!, /prerequisite/);
    // The setting that switches it on is listed later in the same Send, and Send puts it first.
    await h.save({ kind: 'edit', edits: [{ rowId: 'u1#1', columnId: 'Vid#RegionOfInterest', value: '3', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#CustomSize', value: '120.0', expected: '' }] });
    assert.deepEqual((await h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#ROILeft', 'Vid#RegionOfInterest', 'Vid#CustomSize'] })).outcomes!.map(outcome => outcome.fieldId + ' ' + outcome.status), ['Vid#RegionOfInterest verified', 'Vid#ROILeft verified', 'Vid#CustomSize verified']);
    assert.equal(unit.values.eParamID_Vid1ROILeft, '500'); assert.equal(unit.values.eParamID_Vid1CustomSize, '1200'); assert.equal(unit.values.eParamID_Vid1CustomSizePos, '0');
    assert.equal(h.observed().rows['u1#1']!.errors['Vid#ROILeft'], undefined);
    // AFD still holds Custom Size, as on the unit.
    unit.change('eParamID_Vid1AFDActive', '1');
    await until(() => !!h.observed().rows['u1#1']!.locked['Vid#CustomSize'], 'AFD locks Custom Size');
    unit.ignoreWrites = true;
    await h.save(edit('u1#2', 'Vid#ColorHDRTransform', '1'));
    const unconfirmed = await h.call('send', { rowId: 'u1#2', fieldIds: ['Vid#ColorHDRTransform'] });
    assert.match(unconfirmed.outcomes![0]!.message!, /did not confirm/);
    assert.equal(valueOf(h.plan(), 'u1#2', 'Vid#ColorHDRTransform'), '1', 'the unconfirmed setting stays staged');
    unit.ignoreWrites = false;
    await h.save(edit('u1', 'unit-allow', 'FALSE', 'TRUE'));
    await assert.rejects(h.call('send', { rowId: 'u1#2', fieldIds: ['Vid#ColorHDRTransform'] }), /Allow sends is off/);
    assert.ok(h.logs.some(entry => entry.level === 'info' && /Vid#ColorHDRTransform = 8: Confirmed/.test(entry.message)));
  } finally { await h.stop(); await unit.close(); }
});
test('the Master selection covers ticked channels, including those of a unit that is not connected, which take presets', async () => {
  const unit = await fakeUnit(), plan = planFor(unit); plan.units.push(newUnit('u2', 'Away', '127.0.0.1:9')); plan.master = ['u1#1', 'u1#3', 'u2#1'];
  const h = host(plan);
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live');
    assert.deepEqual(masterRows(h.plan(), h.observed()).map(row => row.id), ['u1#1', 'u1#3', 'u2#1']);
    await h.save({ kind: 'units', add: [], remove: [h.plan().units[1]!] });
    assert.deepEqual(h.plan().master, ['u1#1', 'u1#3']);
  } finally { await h.stop(); await unit.close(); }
});
test('units from version 1 are used at once, saved by the first command, and not brought back after being removed', async () => {
  const unit = await fakeUnit(), earlier = { devices: [{ id: 'unit-1', values: { name: 'Bench', address: 'http://' + unit.host, access: 'control' } }, { id: 'unit-2', values: { name: '', address: 'http://10.9.9.9', access: 'monitor' } }] };
  const h = host(defaultDocument(), { earlier });
  let saved: FsDocument;
  try {
    await h.backend.start!();
    // Nothing can be saved while the worker starts, but the unit is already being read and a button could reach it.
    assert.deepEqual(h.plan().units, []);
    assert.deepEqual(h.logs.filter(entry => entry.level === 'error'), []);
    await until(() => h.observed().units['unit-1']?.state === 'live');
    const opened = await h.call('snapshot');
    assert.deepEqual(opened.document.units.map(item => [item.id, item.values['unit-name'], item.values['unit-host'], item.values['unit-allow']]), [['unit-1', 'Bench', unit.host, 'TRUE'], ['unit-2', 'FS-HDR 2', '10.9.9.9', 'FALSE']]);
    assert.deepEqual(h.plan().units, opened.document.units);
    assert.equal(h.plan().adopted, true);
    await h.save({ kind: 'units', add: [], remove: h.plan().units });
    saved = h.plan();
    assert.deepEqual(saved.units, []);
  } finally { await h.stop(); }
  const again = host(saved!, { earlier });
  try {
    await again.backend.start!();
    assert.deepEqual((await again.call('snapshot')).document.units, []);
  } finally { await again.stop(); await unit.close(); }
});
test('units saved in 1.3.1’s connection settings come across view-only, and a button press saves them too', async () => {
  const unit = await fakeUnit(), id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const h = host(defaultDocument(), { settings: { devicesLayout: { version: 1 }, devices: [{ id, values: { name: '1', address: unit.host, access: 'monitor' } }] } });
  try {
    await h.backend.start!();
    await until(() => h.observed().units[id]?.state === 'live');
    const result = await h.backend.execute!('set-hdr-transform', { values: { 'module.targets': 'all', 'module.processor': '2', 'module.transform': '8' } } as never, { signal: new AbortController().signal } as never) as { status: string };
    assert.notEqual(result.status, 'success');
    assert.deepEqual(unit.writes, []);
    assert.deepEqual(h.plan().units.map(item => [item.id, item.values['unit-name'], item.values['unit-host'], item.values['unit-allow']]), [[id, '1', unit.host, 'FALSE']]);
  } finally { await h.stop(); await unit.close(); }
});
test('a button press sets one transform on the chosen units, and its feedback follows the unit', async () => {
  const a = await fakeUnit(), b = await fakeUnit(), h = host(planFor(a, b));
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live' && h.observed().units.u2?.state === 'live');
    await until(() => h.feedback.some(item => item.id === 'all-online' && item.state === 'active'), 'All online turns on');
    const values = { 'module.targets': 'all', 'module.processor': '2', 'module.transform': '8' };
    h.backend.subscribeFeedback!([{ id: 'hdr-transform-matches', fields: { values } }] as never, { signal: new AbortController().signal } as never);
    assert.equal(h.feedback.at(-1)!.state, 'inactive');
    const result = await h.backend.execute!('set-hdr-transform', { values } as never, { signal: new AbortController().signal } as never) as { status: string };
    assert.equal(result.status, 'success');
    assert.deepEqual([a.values.eParamID_Vid2ColorHDRTransform, b.values.eParamID_Vid2ColorHDRTransform], ['8', '8']);
    await until(() => h.feedback.at(-1)!.id === 'hdr-transform-matches' && h.feedback.at(-1)!.state === 'active', 'feedback turns on');
    b.change('eParamID_Vid2ColorHDRTransform', '3');
    await until(() => h.feedback.at(-1)!.id === 'hdr-transform-matches' && h.feedback.at(-1)!.state === 'inactive', 'feedback follows a change at the unit');
    const one = await h.backend.execute!('set-hdr-transform', { values: { ...values, 'module.targets': 'http://' + b.host, 'module.transform': '1' } } as never, { signal: new AbortController().signal } as never) as { status: string };
    assert.equal(one.status, 'success'); assert.deepEqual([a.values.eParamID_Vid2ColorHDRTransform, b.values.eParamID_Vid2ColorHDRTransform], ['8', '1']);
    const choices = await h.backend.discoverChoices!({ provider: 'fshdr-targets', search: '', limit: 10 } as never, { signal: new AbortController().signal } as never) as { choices: { id: string }[] };
    assert.deepEqual(choices.choices.map(choice => choice.id), ['all', 'http://' + a.host, 'http://' + b.host]);
  } finally { await h.stop(); await a.close(); await b.close(); }
});
test('with the connection switched off in Hubble nothing is contacted or sent', async () => {
  const unit = await fakeUnit(), h = host(planFor(unit), { connectionEnabled: false });
  try {
    await h.backend.start!();
    await delay(150);
    assert.equal(h.observed().units.u1!.state, 'disabled');
    await h.save(edit('u1', 'ChannelName1', 'CAM 13'));
    await assert.rejects(h.call('send', { rowId: 'u1', fieldIds: ['ChannelName1'] }), /switched off/);
    assert.equal(unit.writes.length, 0);
  } finally { await h.stop(); await unit.close(); }
});

test('a unit that is not connected takes presets with the firmware list’s choices and ranges, and they send once it is live', async () => {
  const unit = await fakeUnit(), plan = planFor(unit); plan.units[0]!.values['unit-host'] = '127.0.0.1:9';
  const h = host(plan);
  try {
    await h.backend.start!();
    await h.save({ kind: 'view', sheetId: 'hdr', view: withColumnVisibility(sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view, [{ id: 'Vid#CustomSizePos', visible: true }, { id: 'Vid#CustomSize', visible: true }]), expected: sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view });
    await until(() => h.observed().rows['u1#1']?.planned === true && h.observed().rows['u1#1']!.limits['Vid#CustomSize'] !== undefined, 'planned rows');
    const seen = h.observed(), row = seen.rows['u1#1']!;
    assert.deepEqual(Object.keys(row.values), [], 'nothing is known about the unit yet');
    assert.deepEqual(row.limits['Vid#CustomSize'], { precision: 1, min: 10, max: 200, step: 0.1, units: '%' });
    assert.equal(row.locked['Vid#CustomSize'], undefined, 'a preset is not held back by a prerequisite the unit might already have on');
    assert.ok(seen.choiceSets[row.choices['Vid#ColorHDRTransform']!]!.some(choice => choice.label === 'BBC HLG LUT'));
    assert.match(String((normalize(row, fields.find(field => field.id === 'Vid#CustomSize')!, '250') as { error?: string }).error), /from 10 to 200/);
    // Custom Size is staged before the setting it depends on. Send puts Custom Size/Pos first.
    await h.save({ kind: 'edit', edits: [{ rowId: 'u1#1', columnId: 'Vid#CustomSize', value: '120.0', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#CustomSizePos', value: '1', expected: '' }] });
    assert.deepEqual(pendingFields(h.plan(), h.observed(), 'u1#1').map(field => field.id), ['Vid#CustomSize', 'Vid#CustomSizePos']);
    await assert.rejects(h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#CustomSize'] }), /offline/);
    await h.save(edit('u1', 'unit-host', unit.host, '127.0.0.1:9'));
    await until(() => h.observed().units.u1?.state === 'live', 'the unit connects');
    assert.equal(valueOf(h.plan(), 'u1#1', 'Vid#CustomSize'), '120.0', 'presets stay staged when the unit connects');
    assert.equal(unit.writes.length, 0, 'connecting sends nothing by itself');
    const sent = await h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#CustomSize', 'Vid#CustomSizePos'] });
    assert.deepEqual(sent.outcomes!.map(outcome => outcome.fieldId + ' ' + outcome.status), ['Vid#CustomSizePos verified', 'Vid#CustomSize verified']);
    assert.deepEqual([unit.values.eParamID_Vid1CustomSizePos, unit.values.eParamID_Vid1CustomSize], ['1', '1200']);
  } finally { await h.stop(); await unit.close(); }
});
test('a simulated unit runs inside the worker with no address, takes sends, and keeps them over a restart', async () => {
  const plan = defaultDocument(); plan.units = [{ ...newUnit('s1', 'Sim 1', ''), values: { ...newUnit('s1', 'Sim 1', '').values, 'unit-simulated': 'TRUE' } }];
  const h = host(plan);
  let again: ReturnType<typeof host> | undefined;
  try {
    await h.backend.start!();
    await until(() => h.observed().units.s1?.state === 'live', 'the simulated unit is live');
    const seen = h.observed().units.s1!;
    assert.deepEqual([seen.simulated, seen.channels, seen.mode, seen.name, seen.remote], [true, [1, 2, 3, 4], 'HD/SD 4 Ch', 'Sim 1', true]);
    assert.equal(h.observed().rows['s1#1']!.signal, 'No Input');
    await h.save({ kind: 'edit', edits: [{ rowId: 's1#2', columnId: 'Vid#ColorHDRTransform', value: '8', expected: '' }, { rowId: 's1', columnId: 'ChannelName1', value: 'CAM 1', expected: '' }] });
    assert.deepEqual((await h.call('send', { rowId: 's1#2', fieldIds: ['Vid#ColorHDRTransform'] })).outcomes, [{ fieldId: 'Vid#ColorHDRTransform', status: 'verified' }]);
    assert.deepEqual((await h.call('send', { rowId: 's1', fieldIds: ['ChannelName1'] })).outcomes, [{ fieldId: 'ChannelName1', status: 'verified' }]);
    await until(() => h.observed().rows['s1#2']!.values['Vid#ColorHDRTransform'] === '8', 'the simulated unit reports the new value');
    assert.deepEqual(h.observed().units.s1!.changes, { 's1#2': { 'Vid#ColorHDRTransform': '8' }, s1: { ChannelName1: 'CAM 1' } });
    assert.deepEqual(h.simulated().units.s1, { eParamID_Vid2ColorHDRTransform: '8', eParamID_Vid1_ChannelName: 'CAM 1' }, 'saved by the send command');
    await h.stop();
    again = host(h.plan(), { simulated: h.simulated() });
    await again.backend.start!();
    await until(() => again!.observed().rows['s1#2']?.values['Vid#ColorHDRTransform'] === '8', 'the restarted worker brings the simulated unit back with its settings');
    // A new mode is a restart of the simulated unit, with one channel.
    await again.save(edit('s1', 'unit-mode', '2'));
    await until(() => again!.observed().units.s1?.state === 'live' && again!.observed().units.s1!.channels.join() === '0', 'the simulated unit restarts in 4K/UHD');
    // Turned off, the row is a plain unit again and the simulated settings go.
    await again.save(edit('s1', 'unit-simulated', 'FALSE', 'TRUE'));
    await until(() => again!.observed().units.s1?.state === 'unset', 'no longer simulated');
    assert.deepEqual(again.simulated().units, {});
  } finally { await h.stop(); await again?.stop(); }
});
test('buttons never control a simulated unit, and it does not count towards All online', async () => {
  const real = await fakeUnit(), plan = planFor(real);
  plan.units.push({ ...newUnit('s2', 'Sim 2', '10.0.0.42'), values: { ...newUnit('s2', 'Sim 2', '10.0.0.42').values, 'unit-simulated': 'TRUE' } });
  const h = host(plan);
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live' && h.observed().units.s2?.state === 'live');
    await until(() => h.feedback.some(item => item.id === 'all-online' && item.state === 'active'), 'All online counts the real unit only');
    const values = { 'module.targets': 'all', 'module.processor': '2', 'module.transform': '8' };
    const all = await h.backend.execute!('set-hdr-transform', { values } as never, { signal: new AbortController().signal } as never) as { status: string };
    assert.equal(all.status, 'success'); assert.equal(real.values.eParamID_Vid2ColorHDRTransform, '8');
    assert.notEqual(h.observed().rows['s2#2']!.values['Vid#ColorHDRTransform'], '8', 'All configured units leaves the simulated unit alone');
    const named = await h.backend.execute!('set-hdr-transform', { values: { ...values, 'module.targets': '10.0.0.42' } } as never, { signal: new AbortController().signal } as never) as { status: string };
    assert.equal(named.status, 'failure');
    assert.ok(h.logs.length >= 0);
    const choices = await h.backend.discoverChoices!({ provider: 'fshdr-targets', search: '', limit: 10 } as never, { signal: new AbortController().signal } as never) as { choices: { id: string }[] };
    assert.deepEqual(choices.choices.map(choice => choice.id), ['all', 'http://' + real.host]);
  } finally { await h.stop(); await real.close(); }
});
test('sixteen units that are not connected, with every column shown, stay well inside Hubble’s 256K state limit', async () => {
  const plan = defaultDocument();
  plan.units = Array.from({ length: 16 }, (_, index) => newUnit('u' + (index + 1), 'FS-HDR ' + (index + 1), '127.0.0.1:' + (9 + index)));
  // The worker reads every setting a sheet can show, so with nothing hidden it observes them all.
  const showAll = (view: FsDocument['view']) => ({ ...view, hidden: [], hiddenGroups: [] });
  plan.sheets = plan.sheets.map(sheet => sheet.view ? { ...sheet, view: showAll(sheet.view) } : sheet);
  plan.view = showAll(plan.view);
  const h = host(plan);
  try {
    await h.backend.start!();
    await until(() => Object.values(h.observed().rows).filter(row => row.planned).length === 16 * 5, 'every unit and channel row is planned');
    const sent = JSON.stringify(h.states.at(-1)!.values);
    assert.ok(sent.length < 128 * 1024, 'published state is ' + sent.length + ' characters');
    const row = h.observed().rows['u16#4']!;
    assert.deepEqual(row.limits['Vid#CustomSize'], { precision: 1, min: 10, max: 200, step: 0.1, units: '%' }, 'every row gets its limits back from the shared shape');
    assert.ok(h.observed().choiceSets[row.choices['Vid#ColorHDRTransform']!]!.some(choice => choice.label === 'BBC HLG LUT'));
  } finally { await h.stop(); }
});

test('a slider being dragged sends straight to the unit, without staging or logging, and only where sends are allowed', async () => {
  const unit = await fakeUnit(), h = host(planFor(unit));
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live');
    const live = (writes: unknown[], final = false) => h.call('live', { writes, final }) as unknown as Promise<{ outcomes: { rowId: string; status: string; message?: string }[] }>;
    const before = h.logs.length;
    assert.deepEqual((await live([{ rowId: 'u1#1', fieldId: 'Vid#CustomSize', value: '101.5' }, { rowId: 'u1#2', fieldId: 'Vid#CustomSize', value: '101.5' }])).outcomes.map(o => o.status), ['verified', 'verified']);
    assert.equal(unit.values.eParamID_Vid1CustomSize, '1015'); assert.equal(unit.values.eParamID_Vid2CustomSize, '1015');
    assert.equal(valueOf(h.plan(), 'u1#1', 'Vid#CustomSize'), '', 'nothing is staged');
    assert.equal(h.logs.length, before, 'drag steps are not logged');
    // The same value again is not written twice.
    const writes = unit.writes.length;
    await live([{ rowId: 'u1#1', fieldId: 'Vid#CustomSize', value: '101.5' }], true);
    assert.equal(unit.writes.length, writes);
    assert.deepEqual(h.logs.slice(before).map(entry => entry.message), ['FS-HDR 1 channel 1 Vid#CustomSize = 101.5 (slider): Confirmed'], 'the release is logged');
    // Out of range comes back as a failure; a setting that isn't a slider is refused outright.
    assert.equal((await live([{ rowId: 'u1#1', fieldId: 'Vid#CustomSize', value: '250.0' }])).outcomes[0]!.status, 'failed');
    await assert.rejects(live([{ rowId: 'u1#1', fieldId: 'Vid#ColorHDRTransform', value: '1' }]), /Invalid live setting/);
    await h.save(edit('u1', 'unit-allow', 'FALSE', 'TRUE'));
    const refused = await live([{ rowId: 'u1#1', fieldId: 'Vid#CustomSize', value: '102.0' }]);
    assert.match(refused.outcomes[0]!.message!, /Allow sends is off/); assert.equal(unit.values.eParamID_Vid1CustomSize, '1015');
  } finally { await h.stop(); await unit.close(); }
});
