import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleContext, ModuleInstance } from '@hubble/module-sdk';
import manifest from '../src/manifest.js';
import { createBackend, type Observed } from '../src/backend.js';
import { parameterId } from '../src/device.js';
import { addSheet, applyMutation, channelRowId, defaultDocument, fieldById, fields, groups, inverse, moveSheet, newUnit, removeSheet, renameSheet, setUnitCount, sheetList, validateDocument, valueOf, visibleFields, watchedFieldIds, withColumnVisibility, type FsDocument, type Mutation } from '../src/model.js';
import { masterRows, normalize, pendingFields, rowsFor, shownLabel, shownName } from '../src/rows.js';
import { DraftStore } from '../src/draft-store.js';
import { fakeUnit, type FakeUnit } from './fake-unit.js';

const until = async (check: () => boolean, message = 'condition') => { for (let i = 0; i < 400 && !check(); i++) await delay(10); assert.ok(check(), message); };
const edit = (rowId: string, columnId: string, value: string, expected = ''): Mutation => ({ kind: 'edit', edits: [{ rowId, columnId, value, expected }] });

/** The worker code with a stand-in for Hubble's document store, so a test sees exactly what the page would. */
function host(plan: FsDocument, options: { settings?: Record<string, unknown>; earlier?: unknown; connectionEnabled?: boolean } = {}) {
  const stored = new Map<string, { revision: number; value: unknown }>([['fshdr-plan', { revision: 1, value: plan }], ['setup', { revision: 1, value: options.earlier ?? {} }]]);
  const record = (id: string) => ({ id, version: 1, revision: String(stored.get(id)!.revision), value: stored.get(id)!.value });
  const states: { values: Observed & { revision: string } }[] = [], feedback: { id: string; state: string }[] = [], logs: { level: string; message: string }[] = [], lifetime = new AbortController();
  const services = { async request(_service: string, _version: number, input: { method: string; id: string; expectedRevision?: string; value?: unknown }, signal?: AbortSignal) {
    if (input.method === 'watch') return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    if (input.method === 'write') { if (input.expectedRevision !== String(stored.get(input.id)!.revision)) return { status: 'conflict', document: record(input.id) }; stored.set(input.id, { revision: stored.get(input.id)!.revision + 1, value: input.value }); }
    return { status: 'document', document: record(input.id) };
  } };
  const backend: ModuleInstance = createBackend({ services, connectionEnabled: options.connectionEnabled ?? true, settings: options.settings ?? {}, log: (entry: never) => logs.push(entry), publishState: (value: never) => states.push(value), publishFeedback: (value: never) => feedback.push(value) } as unknown as ModuleContext);
  const call = (commandId: string, value?: unknown) => backend.call!('page.fshdr', { sectionId: 'frontend', commandId, value } as never, { signal: lifetime.signal } as never) as unknown as Promise<Observed & { document: FsDocument; outcomes?: { fieldId: string; status: string; message?: string }[] }>;
  return { backend, call, states, feedback, logs, plan: () => stored.get('fshdr-plan')!.value as FsDocument, observed: () => states.at(-1)!.values, save: (operation: Mutation) => call('save', { operation }), async stop() { lifetime.abort(); await backend.dispose?.(); } };
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
    assert.deepEqual(rowsFor(h.plan(), seen, 'channels').map(row => row.id), ['u1#1', 'u1#2', 'u1#3', 'u1#4', 'u2#0', 'u3#-', 'u4#-']);
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
    await h.save({ kind: 'view', sheetId: 'hdr', view: withColumnVisibility(sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view, [{ id: 'Vid#CustomSizePos', visible: true }, { id: 'Vid#CustomSize', visible: true }]), expected: sheetList(h.plan()).find(sheet => sheet.id === 'hdr')!.view });
    assert.match(h.observed().rows['u1#1']!.locked['Vid#CustomSize']!, /prerequisite/);
    assert.deepEqual(h.observed().rows['u1#1']!.limits['Vid#CustomSize'], { precision: 1, min: 10, max: 200, step: 0.1, units: '%' });
    await h.save({ kind: 'edit', edits: [{ rowId: 'u1', columnId: 'ChannelName1', value: 'CAM 13', expected: '' }, { rowId: 'u1', columnId: 'SystemName', value: 'Truck A', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#ColorHDRTransform', value: '8', expected: '' }, { rowId: 'u1#1', columnId: 'Vid#CustomSize', value: '120.0', expected: '' }] });
    assert.deepEqual(pendingFields(h.plan(), h.observed(), 'u1').map(f => f.id).sort(), ['ChannelName1', 'SystemName']);
    assert.equal(unit.writes.length, 0, 'staging sends nothing');
    assert.deepEqual((await h.call('send', { rowId: 'u1', fieldIds: ['ChannelName1', 'SystemName'] })).outcomes, [{ fieldId: 'ChannelName1', status: 'verified' }, { fieldId: 'SystemName', status: 'verified' }]);
    assert.deepEqual(unit.writes, [{ id: 'eParamID_Vid1_ChannelName', value: 'CAM 13' }, { id: 'eParamID_SystemName', value: 'Truck A' }]);
    const sent = await h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#ColorHDRTransform', 'Vid#CustomSize'] });
    assert.equal(sent.outcomes![0]!.status, 'verified'); assert.equal(sent.outcomes![1]!.status, 'failed'); assert.match(sent.outcomes![1]!.message!, /prerequisite/);
    assert.equal(unit.values.eParamID_Vid1ColorHDRTransform, '8'); assert.equal(unit.values.eParamID_Vid1CustomSize, '1000');
    assert.match(h.observed().rows['u1#1']!.errors['Vid#CustomSize']!, /prerequisite/);
    await h.save(edit('u1#1', 'Vid#CustomSizePos', '1'));
    assert.deepEqual((await h.call('send', { rowId: 'u1#1', fieldIds: ['Vid#CustomSizePos', 'Vid#CustomSize'] })).outcomes!.map(outcome => outcome.status), ['verified', 'verified']);
    assert.equal(unit.values.eParamID_Vid1CustomSize, '1200');
    assert.equal(h.observed().rows['u1#1']!.errors['Vid#CustomSize'], undefined);
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
test('the Master selection covers ticked channels of live units only', async () => {
  const unit = await fakeUnit(), plan = planFor(unit); plan.units.push(newUnit('u2', 'Away', '127.0.0.1:9')); plan.master = ['u1#1', 'u1#3', 'u2#1'];
  const h = host(plan);
  try {
    await h.backend.start!();
    await until(() => h.observed().units.u1?.state === 'live');
    assert.deepEqual(masterRows(h.plan(), h.observed()).map(row => row.id), ['u1#1', 'u1#3']);
    await h.save({ kind: 'units', add: [], remove: [h.plan().units[1]!] });
    assert.deepEqual(h.plan().master, ['u1#1', 'u1#3']);
  } finally { await h.stop(); await unit.close(); }
});
test('units from the earlier version come across once, keeping whether they could be controlled', async () => {
  const unit = await fakeUnit(), h = host(defaultDocument(), { earlier: { devices: [{ id: 'unit-1', values: { name: 'Bench', address: 'http://' + unit.host, access: 'control' } }, { id: 'unit-2', values: { name: '', address: 'http://10.9.9.9', access: 'monitor' } }] } });
  try {
    await h.backend.start!();
    assert.deepEqual(h.plan().units.map(item => [item.id, item.values['unit-name'], item.values['unit-host'], item.values['unit-allow']]), [['unit-1', 'Bench', unit.host, 'TRUE'], ['unit-2', 'FS-HDR 2', '10.9.9.9', 'FALSE']]);
    await until(() => h.observed().units['unit-1']?.state === 'live');
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
