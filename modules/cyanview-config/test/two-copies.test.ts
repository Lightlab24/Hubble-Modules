import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergePlans, samePlan, type PlanValue } from '../src/plan-merge.js';
import { pageViewStore } from '../src/page-view-store.js';
import { fixture } from './helpers.js';

// The page can be open in two HubDash windows or on two computers at once (Nov 25, 2026). A copy that saves after the
// other one has saved puts its own changes onto the saved plan instead of its whole plan on top.
const rcp = { id: 'rcp1', name: 'RCP 01', kind: 'RCP', serial: 'CY-RCP-1-20', base: '10.192.1.20', online: true };
const camera = (fields: PlanValue = {}) => ({ id: 'cam1', device: 'rcp1', number: '1', name: 'Wide', ip: '10.20.20.1', dirty: [], pending: false, result: 'In sync', revision: 0, ...fields });
const plan = (cameras: PlanValue[], extra: PlanValue = {}) => ({ formatVersion: 1, devices: [rcp], cameras, lans: [], uiState: null, ...extra });
const row = (merged: PlanValue, id = 'cam1') => merged.cameras.find((item: PlanValue) => item.id === id);

test('each copy keeps the other copy’s edits to a row and its own', () => {
  const base = plan([camera()]);
  const { plan: merged, conflicts } = mergePlans(base, plan([camera({ name: 'Tight', dirty: ['name'], pending: true, result: 'Pending', revision: 1 })]),
    plan([camera({ ip: '10.20.20.9', dirty: ['ip'], pending: true, result: 'Pending', revision: 1 })]));
  assert.equal(row(merged).name, 'Tight');
  assert.equal(row(merged).ip, '10.20.20.9');
  assert.deepEqual(row(merged).dirty.sort(), ['ip', 'name'], 'both edits stay unsent');
  assert.equal(row(merged).pending, true);
  assert.deepEqual(conflicts, []);
});

test('a field both copies typed into keeps what this copy typed, and says so', () => {
  const base = plan([camera()]);
  const { plan: merged, conflicts } = mergePlans(base, plan([camera({ name: 'Mine', dirty: ['name'], pending: true })]), plan([camera({ name: 'Theirs', dirty: ['name'], pending: true })]));
  assert.equal(row(merged).name, 'Mine');
  assert.deepEqual(row(merged).dirty, ['name']);
  assert.deepEqual(conflicts.map(item => [item.kind, item.id, item.fields, item.removed]), [['cameras', 'cam1', ['name'], false]]);
});

test('a send in one copy stops the field being unsent only if the other copy hasn’t typed over it since', () => {
  const base = plan([camera({ name: 'Typed', dirty: ['name'], pending: true, result: 'Pending' })]);
  // The other copy sent it: what was typed is on the controller.
  const sent = mergePlans(base, plan([camera({ name: 'Typed', dirty: ['name', 'ip'], pending: true, result: 'Pending', ip: '10.20.20.5' })]),
    plan([camera({ name: 'Typed', dirty: [], pending: false, result: 'Verified' })])).plan;
  assert.equal(row(sent).name, 'Typed');
  assert.equal(row(sent).ip, '10.20.20.5');
  assert.deepEqual(row(sent).dirty, ['ip'], 'only the address this copy typed since is left to send');
  // This copy sent it while the other typed a new name: the new name is still to send.
  const retyped = mergePlans(base, plan([camera({ name: 'Typed', dirty: [], pending: false, result: 'Verified' })]),
    plan([camera({ name: 'Newer', dirty: ['name'], pending: true, result: 'Pending' })])).plan;
  assert.equal(row(retyped).name, 'Newer');
  assert.deepEqual(row(retyped).dirty, ['name']);
  assert.equal(row(retyped).pending, true);
});

test('what the worker wrote back after a send is taken from the saved plan', () => {
  const base = plan([camera({ elementKey: 'old' })]);
  const { plan: merged, conflicts } = mergePlans(base, plan([camera({ elementKey: 'stale', name: 'Mine' })]), plan([camera({ elementKey: 'fresh' })]));
  assert.equal(row(merged).elementKey, 'fresh');
  assert.equal(row(merged).name, 'Mine');
  assert.deepEqual(conflicts, []);
});

test('a row either copy removed stays removed, and a change this copy made to it is reported', () => {
  const base = plan([camera(), camera({ id: 'cam2', number: '2' }), camera({ id: 'cam3', number: '3' })]);
  const mine = plan([camera({ name: 'Changed here' }), camera({ id: 'cam3', number: '3' })]);
  const theirs = plan([camera({ id: 'cam2', number: '2', name: 'Changed there' }), camera({ id: 'cam3', number: '3' }), camera({ id: 'cam4', number: '4' })]);
  const { plan: merged, conflicts } = mergePlans(base, mine, theirs);
  assert.deepEqual(merged.cameras.map((item: PlanValue) => item.id), ['cam3', 'cam4'], 'the other copy’s new camera is kept, both removals stand');
  assert.deepEqual(conflicts.map(item => [item.id, item.removed]), [['cam1', true]]);
});

test('rows added in both copies are both kept', () => {
  const { plan: merged } = mergePlans(plan([]), plan([camera({ id: 'mine' })]), plan([camera({ id: 'theirs' })]));
  assert.deepEqual(merged.cameras.map((item: PlanValue) => item.id).sort(), ['mine', 'theirs']);
});

test('a camera on a controller the other copy took out goes with it', () => {
  const base = plan([camera()]);
  const { plan: merged, conflicts } = mergePlans(base, plan([camera({ name: 'Mine' })]), { ...plan([camera()]), devices: [] });
  assert.deepEqual(merged.devices, []);
  assert.deepEqual(merged.cameras, []);
  assert.deepEqual(conflicts.map(item => [item.kind, item.id, item.removed]), [['cameras', 'cam1', true]]);
});

test('a field the page fills in as it draws is no change, so the other copy’s value comes through', () => {
  const base = plan([camera()]);
  const { plan: merged, conflicts } = mergePlans(base, plan([camera({ irisMotor: '', enabledLensAxes: [] })]), plan([camera({ irisMotor: '3', enabledLensAxes: ['iris'] })]));
  assert.equal(row(merged).irisMotor, '3');
  assert.deepEqual(row(merged).enabledLensAxes, ['iris']);
  assert.deepEqual(conflicts, []);
});

test('live reports are each copy’s own and never count as a change', () => {
  const saved = plan([camera({ online: null })], { devices: [{ ...rcp, online: null }] });
  assert.ok(samePlan(saved, plan([camera({ online: true, jobs: 0 })], { devices: [{ ...rcp, online: false, lastSeen: 'now' }] })));
  assert.ok(!samePlan(saved, plan([camera({ name: 'Tight' })])));
  const merged = mergePlans(saved, plan([camera({ online: true })]), plan([camera({ online: null, name: 'There' })])).plan;
  assert.equal(row(merged).online, true);
  assert.equal(row(merged).name, 'There');
});

test('layouts merge setting by setting, and cameras with no controller yet merge as rows', () => {
  const ui = (content: PlanValue) => ({ modelContent: {}, privateContent: { revision: 6, ...content } });
  const base = plan([], { uiState: ui({ cameraLayouts: { rcp1: { columns: { name: 160 } } }, remiView: { unassigned: [camera({ id: 'u1', device: '' })] } }) });
  const mine = plan([], { uiState: ui({ cameraLayouts: { rcp1: { columns: { name: 200 } } }, remiView: { unassigned: [camera({ id: 'u1', device: '', name: 'Mine' })] } }) });
  const theirs = plan([], { uiState: ui({ cameraLayouts: { rcp1: { columns: { name: 160, ip: 140 } } }, remiView: { unassigned: [camera({ id: 'u1', device: '', ip: '10.0.0.9' }), camera({ id: 'u2', device: '' })] } }) });
  const { plan: merged } = mergePlans(base, mine, theirs);
  assert.deepEqual(merged.uiState.privateContent.cameraLayouts.rcp1.columns, { name: 200, ip: 140 });
  const unassigned = merged.uiState.privateContent.remiView.unassigned;
  assert.deepEqual(unassigned.map((item: PlanValue) => [item.id, item.name, item.ip]), [['u1', 'Mine', '10.0.0.9'], ['u2', 'Wide', '10.20.20.1']]);
});

test('Defaults rows merge by camera model, and every saved controller is kept', () => {
  const login = (model: string, fields: PlanValue = {}) => ({ model, login: 'admin', password: '', ...fields });
  const saved = (serial: string) => ({ serial, kind: 'RCP', base: '10.192.1.20', address: '' });
  const { plan: merged, conflicts } = mergePlans(plan([], { cameraLogins: [login('Venice-IP')], savedDevices: [saved('CY-RCP-1-20')] }),
    plan([], { cameraLogins: [login('Venice-IP', { password: 'mine' })], savedDevices: [saved('CY-RCP-1-20'), saved('CY-RCP-1-30')] }),
    plan([], { cameraLogins: [login('Venice-IP'), login('FX6')], savedDevices: [saved('CY-RCP-1-20'), saved('CY-RCP-1-40')] }));
  assert.deepEqual(merged.cameraLogins.map((item: PlanValue) => [item.model, item.password]), [['Venice-IP', 'mine'], ['FX6', '']]);
  assert.deepEqual(merged.savedDevices.map((item: PlanValue) => item.serial).sort(), ['CY-RCP-1-20', 'CY-RCP-1-30', 'CY-RCP-1-40']);
  assert.deepEqual(conflicts, []);
});

test('the worker publishes the saved plan’s revision, whoever saved it', async () => {
  const session = fixture();
  await session.instance.start();
  const published = () => (session.states.at(-1) as { values: { planRevision?: unknown } }).values.planRevision;
  try {
    const first = await session.call('read-plan');
    assert.equal(published(), first.revision);
    // A page's save.
    const saved = await session.call('save-plan', { revision: first.revision, plan: { ...first.plan, devices: [], cameras: [], lans: [] } });
    assert.equal(published(), saved.revision);
    // A save the page didn't make, as a send's receipt or Hubble's Undo, reaches it through the plan's watch.
    const written = await session.repository.update(current => { current.uiState = { privateContent: { revision: 6 } }; }, session.signal);
    for (let wait = 0; wait < 100 && published() !== written.revision; wait++) await delay(10);
    assert.equal(published(), written.revision);
  } finally { await session.instance.dispose(); }
});

test('where the page was left is kept on this computer, out of the plan, with Simulated apart', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'cyanview-view-'));
  try {
    const store = pageViewStore(() => folder);
    assert.equal(store.read('real'), null);
    store.write('real', { tab: 'devices', openControllers: ['rcp1'] });
    store.write('simulated', { tab: 'cameras' });
    assert.deepEqual(pageViewStore(() => folder).read('real'), { tab: 'devices', openControllers: ['rcp1'] });
    assert.deepEqual(pageViewStore(() => folder).read('simulated'), { tab: 'cameras' });
    assert.ok((await readFile(path.join(folder, 'page-view.json'), 'utf8')).includes('openControllers'));
    assert.throws(() => store.write('real', ['not', 'a', 'view']), /Invalid page view/);
    assert.throws(() => store.write('real', { text: 'x'.repeat(70 * 1024) }), /Invalid page view/);
    // Until Hubble grants the folder it lasts for this run.
    const memory = pageViewStore(() => undefined);
    memory.write('real', { tab: 'setup' });
    assert.deepEqual(memory.read('real'), { tab: 'setup' });
  } finally { await rm(folder, { recursive: true, force: true }); }
  // A view change never touches the shared plan.
  const session = fixture();
  await session.instance.start();
  try {
    const before = await session.call('read-plan');
    assert.deepEqual(await session.call('page-view', { tab: 'assignment' }), { saved: true });
    assert.deepEqual(await session.call('page-view', null), { view: { tab: 'assignment' } });
    assert.equal((await session.call('read-plan')).revision, before.revision);
  } finally { await session.instance.dispose(); }
});
