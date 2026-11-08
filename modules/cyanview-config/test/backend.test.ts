import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { FakeController, fixture, noEquipment, planFor } from './helpers.js';
import { ConfigurationOperations } from '../src/operations.js';
import { Discovery, networkRange } from '../src/discovery.js';
import { normalizeSnapshot } from '../src/normalize.js';
import { decodeLensParameters, emptyPlan, lensParameters, type RecordValue } from '../src/model.js';
import { ModuleFrontendValueSchema } from '@hubble/module-sdk/frontend';
import { parseAnnouncement } from '../src/announcements.js';
import { parseNeighbors } from '../src/neighbors.js';
import { CyanviewClient } from '../src/transport.js';
import { cameraChoiceKey } from '../src/choice-context.js';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(test: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (test()) return; await delay(5); }
  assert.ok(test(), 'The expected controller requests did not arrive');
}

test('controller choices survive a worker restart and stay scoped to the verified camera configuration', async () => {
  const fake = new FakeController();
  await fake.start();
  const f = fixture({}, { client: fake.client });
  try {
    await f.instance.start();
    fake.modelChoices.push(['Sony - Special model', 'SonySpecial']);
    fake.config.Camera.one = { Number: '1', Name: 'Camera 1', Model: 'Sony - Alpha-USB', LensModel: 'B4 Generic' };
    const snapshot = fake.snapshot(), plan = planFor(fake), camera = snapshot.cameras[0]!;
    plan.cameras.push({ ...camera, lens: 'ARRI - cforce', dirty: ['lens'], pending: true });
    const before = await f.repository.write(null, plan, f.signal);
    const input = { device: snapshot.device.id, rowId: camera.id };
    await Promise.all([
      f.call('options', { ...input, field: 'Model' }),
      f.call('options', { ...input, field: 'LensInterface' }),
    ]);
    assert.equal((await f.repository.read(f.signal)).revision, before.revision);
    assert.equal(fake.actions.length, 0);

    const modelKey = cameraChoiceKey(snapshot.device.serial, 'Model')!;
    const portKey = cameraChoiceKey(snapshot.device.serial, 'LensInterface', 'one', 'Alpha-USB', 'B4 Generic')!;
    const draftKey = cameraChoiceKey(snapshot.device.serial, 'LensInterface', 'one', 'Alpha-USB', 'ARRI - cforce')!;
    const offline = fixture({}, { client: () => { throw new Error('Controller offline'); } }, f.records);
    try {
      await offline.instance.start();
      const { catalogs } = await offline.call('choice-catalogs');
      assert.ok(catalogs[modelKey].some((choice: { label: string }) => choice.label === 'Sony - Special model'));
      assert.deepEqual(catalogs[portKey].map((choice: { label: string }) => choice.label), ['RIO-1-10 : 1', 'RIO-1-10 : 2']);
      assert.equal(catalogs[draftKey], undefined);
      await assert.rejects(() => offline.call('options', { ...input, field: 'LensInterface' }), /Controller offline/);
      assert.deepEqual((await offline.call('choice-catalogs')).catalogs, catalogs);
    } finally { await offline.instance.dispose(); }
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('the frontend keeps the approved stylesheet and module markup', async () => {
  const provenance = JSON.parse(await readFile(path.resolve('design-reference/ui-source-provenance.json'), 'utf8'));
  const css = await readFile(path.resolve('src/approved-ui.css'));
  assert.equal(createHash('sha256').update(css).digest('hex'), provenance.stylesheetSha256);
  assert.equal(createHash('sha256').update(await readFile(path.resolve('src/approved-ui.js'))).digest('hex'), provenance.scriptSha256);
  const html = await readFile(path.resolve('ui/index.html'), 'utf8');
  const main = html.slice(html.indexOf('<main class="hc-main">'), html.indexOf('</main>') + 7);
  assert.equal(createHash('sha256').update(main).digest('hex'), provenance.mainMarkupSha256);
  assert.match(html, /Camera Configuration/); assert.match(html, /Network Discovery/);
});

test('startup performs no device connections or writes; saved credentials stay out of public state', async () => {
  let connections = 0;
  const f = fixture({}, { client: () => { connections++; throw new Error('Unexpected network access'); } });
  try {
    await f.instance.start();
    const plan = emptyPlan(); plan.devices.push({ id: 'one', address: '10.192.1.10', base: '10.192.1.10', serial: 'SERIAL' });
    plan.cameras.push({ id: 'camera-one', device: 'one', password: 'CANARY_PRIVATE_PASSWORD', name: 'Camera' });
    await f.call('save-plan', { revision: null, plan });
    const read = await f.call('read-plan');
    assert.equal(read.plan.cameras[0].password, 'CANARY_PRIVATE_PASSWORD');
    assert.equal(connections, 0); assert.doesNotMatch(JSON.stringify(f.states), /CANARY_PRIVATE_PASSWORD/);
    await assert.rejects(async () => f.instance.call!('page.unknown', {}, f.execution()), /unavailable/);
  } finally { await f.instance.dispose(); }
});

test('512 rows and non-default layouts survive storage/restart; a failed bank write preserves the active configuration', async () => {
  const f = fixture(); await f.instance.start();
  const plan = emptyPlan();
  for (let i = 0; i < 128; i++) plan.devices.push({ id: 'device-' + i, base: `10.192.1.${i + 1}`, serial: 'SERIAL-' + i, name: 'Controller ' + i });
  for (let i = 0; i < 512; i++) plan.cameras.push({ id: 'camera-' + i, device: 'device-' + i % 128, name: 'Camera ' + i, password: 'private-' + i });
  plan.uiState = { privateContent: { revision: 6, deviceOrder: ['device-127', 'device-0'], hiddenCameraColumnsByDevice: { 'device-0': ['password'] }, axisGroupsByDevice: { 'device-0': { iris: true, zoom: false, focus: true } } } };
  const saved = await f.repository.write(null, plan, f.signal);
  f.failNextWrite('-c0-1');
  const changed = structuredClone(plan); changed.cameras[0]!.name = 'Rejected';
  await assert.rejects(() => f.repository.write(saved.revision, changed, f.signal), /storage failure/);
  assert.equal((await f.repository.read(f.signal)).plan.cameras[0]!.name, 'Camera 0');
  const restarted = fixture({}, {}, f.records);
  try { await restarted.instance.start(); const restored = await restarted.repository.read(restarted.signal); assert.equal(restored.plan.cameras.length, 512); assert.deepEqual(restored.plan.uiState, plan.uiState); await assert.rejects(() => restarted.repository.write(null, plan, restarted.signal), /another editor/); }
  finally { await restarted.instance.dispose(); await f.instance.dispose(); }
});

test('real WebSocket framing discovers identity and config without sending control actions', async () => {
  const fake = new FakeController(); await fake.start(); const client = fake.client('10.192.1.10');
  try { await client.connect(new AbortController().signal); const snapshot = normalizeSnapshot(client.config, '10.192.1.10'); assert.equal(snapshot.device.serial, 'CY-RIO-1-10'); assert.equal(snapshot.lans.find(row => row.elementKey === 'protected')!.readOnly, true); assert.equal(fake.actions.length, 0); assert.equal(fake.origins[0], 'http://10.192.1.10'); }
  finally { client.close(); await fake.close(); }
});

test('camera creation resolves generated endpoint IDs and verifies credentials with a fresh connection', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), camera: RecordValue = { id: 'planned-camera', device: plan.devices[0]!.id, number: '1', name: 'Camera 1', model: 'Venice-IP', ip: '10.20.100.101', port: '80', login: 'admin', password: 'CANARY_CAMERA_PASSWORD', lens: 'None', lensPort: 'None', isNew: true };
    plan.cameras.push(camera); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    const result = await operations.run({ kind: 'camera', item: camera, fields: ['number', 'name', 'model', 'ip'] }, f.signal);
    assert.equal(result.verified, true); assert.ok(result.elementKey);
    const row = fake.config.Camera[result.elementKey]; assert.equal(row.Password, camera.password); assert.equal(row.IP, camera.ip);
    assert.equal(fake.actions.filter(action => action.new?.[0] === 'CyElement.Camera').length, 1);
    assert.ok(fake.opened >= 2); assert.equal((await f.repository.read(f.signal)).plan.cameras[0]!.elementKey, result.elementKey);
    assert.equal((await f.repository.read(f.signal)).plan.cameras[0]!.needsInitialization, false);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('partial camera failure retains the create receipt and retries the same object', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), camera = { id: 'retry-camera', device: plan.devices[0]!.id, number: '1', name: 'Retry', model: 'Venice-IP', ip: '10.20.100.101', port: '80', login: 'operator', password: 'password', lens: 'None', isNew: true };
    plan.cameras.push(camera); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client); fake.failProperty = 'password';
    await assert.rejects(() => operations.run({ kind: 'camera', item: camera, fields: ['model', 'ip'] }, f.signal), /rejected/);
    const stored = (await f.repository.read(f.signal)).plan.cameras[0]!; assert.ok(stored.elementKey); assert.equal(stored.needsInitialization, true);
    fake.failProperty = ''; await operations.run({ kind: 'camera', item: camera, fields: ['password'] }, f.signal);
    assert.equal(fake.actions.filter(action => action.new).length, 1);
    assert.equal(fake.config.Camera[stored.elementKey].Login, 'operator');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('one send starts all camera additions before any create reply, and LAN replacement waits for them', async () => {
  const fake = new FakeController(); await fake.start();
  const f = fixture({}, { client: address => new CyanviewClient(address, { socket: fake.socket, timeout: 2000 }) });
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    plan.cameras = [1, 2, 3].map(number => ({ id: 'batch-camera-' + number, device, number: String(number), name: 'Camera ' + number, model: 'Venice-IP', ip: '10.20.100.' + number, port: '80', login: 'operator', password: 'password', lens: 'None', isNew: true }));
    await f.repository.write(null, plan, f.signal);
    fake.holdAction = 'new';
    const sending = f.call('send', { items: plan.cameras.map(item => ({ kind: 'camera', item, fields: ['number', 'name', 'model', 'ip'] })) });
    await waitFor(() => fake.heldActionReplies.length === 3);
    assert.equal(fake.actions.filter(action => action.new?.[0] === 'CyElement.Camera').length, 3);
    const old = plan.lans.find(row => row.elementKey === 'old')!;
    const networking = f.call('send', { kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.201/16' }, fields: ['planned'] });
    await delay(20);
    assert.equal(fake.actions.filter(action => action.new?.[0] === 'CyElement.LanIp').length, 0);
    fake.releaseActionReplies();
    const result = await sending;
    assert.equal(result.results.filter((row: RecordValue) => row.verified).length, 3);
    assert.equal((await networking).verified, true);
    const saved = await f.repository.read(f.signal);
    assert.equal(saved.plan.cameras.filter(row => row.elementKey && !row.needsInitialization).length, 3);
    assert.deepEqual(Object.values(fake.config.Camera).map((row: any) => row.Number).sort(), ['1', '2', '3']);
  } finally { fake.releaseActionReplies(); await f.instance.dispose(); await fake.close(); }
});

test('independent pending LAN additions start together', async () => {
  const fake = new FakeController(); await fake.start();
  const f = fixture({}, { client: address => new CyanviewClient(address, { socket: fake.socket, timeout: 2000 }) });
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    const added = [1, 2].map(number => ({ id: 'new-address-' + number, device, type: 'LAN', iface: 'LAN1', current: '', planned: `10.20.101.${number}/16`, operation: 'Add' }));
    plan.lans.push(...added); await f.repository.write(null, plan, f.signal);
    fake.holdAction = 'new';
    const sending = f.call('send', { items: added.map(item => ({ kind: 'lan', item, fields: ['planned'] })) });
    await waitFor(() => fake.heldActionReplies.length === 2);
    fake.releaseActionReplies();
    const result = await sending;
    assert.equal(result.results.filter((row: RecordValue) => row.verified).length, 2);
    assert.equal(result.revision, (await f.repository.read(f.signal)).revision);
  } finally { fake.releaseActionReplies(); await f.instance.dispose(); await fake.close(); }
});

test('a large send is transferred completely before its camera operations start', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture({}, { client: fake.client });
  try {
    fake.config.Camera = { first: { Number: '1', Name: 'First' }, second: { Number: '2', Name: 'Second' } };
    const plan = { ...planFor(fake), cameras: fake.snapshot().cameras.map(row => ({ ...row, password: 'x'.repeat(100000) })) };
    await f.repository.write(null, plan, f.signal);
    const input = { items: plan.cameras.map(item => ({ kind: 'camera', deleting: true, item })) }, text = JSON.stringify(input);
    assert.ok(text.length > 180000);
    const transfer = await f.call('send-begin');
    await assert.rejects(() => f.call('save-commit', { id: transfer.id }), /expired/);
    for (let offset = 0, index = 0; offset < text.length; offset += 60000, index++) {
      const part = ModuleFrontendValueSchema.parse({ id: transfer.id, index, text: text.slice(offset, offset + 60000) });
      await f.call('send-part', part);
      assert.equal(fake.actions.length, 0);
    }
    const result = await f.call('send-commit', { id: transfer.id });
    assert.equal(result.results.filter((row: RecordValue) => row.deleted).length, 2);
    assert.deepEqual((await f.repository.read(f.signal)).plan.cameras, []);
    await assert.rejects(() => f.call('send-commit', { id: transfer.id }), /expired/);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('one send starts all camera deletions before any delete reply', async () => {
  const fake = new FakeController(); await fake.start();
  const f = fixture({}, { client: address => new CyanviewClient(address, { socket: fake.socket, timeout: 2000 }) });
  try {
    fake.config.Camera = { first: { Number: '1', Name: 'First' }, second: { Number: '2', Name: 'Second' }, third: { Number: '3', Name: 'Retained' } };
    const snapshot = fake.snapshot(), plan = { ...planFor(fake), cameras: snapshot.cameras };
    await f.repository.write(null, plan, f.signal);
    fake.holdAction = 'delete';
    const sending = f.call('send', { items: plan.cameras.slice(0, 2).map(item => ({ kind: 'camera', deleting: true, item })) });
    await waitFor(() => fake.heldActionReplies.length === 2);
    assert.equal(fake.actions.filter(action => action.delete).length, 2);
    fake.releaseActionReplies();
    const result = await sending;
    assert.equal(result.results.filter((row: RecordValue) => row.deleted).length, 2);
    assert.equal(result.revision, (await f.repository.read(f.signal)).revision);
    assert.deepEqual((await f.repository.read(f.signal)).plan.cameras.map(row => row.elementKey), ['third']);
  } finally { fake.releaseActionReplies(); await f.instance.dispose(); await fake.close(); }
});

test('a failed row does not block other pending cameras and its create receipt survives retry', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture({}, { client: fake.client });
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    const failed = { id: 'ip-camera', device, number: '1', name: 'IP camera', model: 'Venice-IP', ip: '10.20.100.1', port: '80', password: 'password', lens: 'None', isNew: true };
    const successful = { id: 'usb-camera', device, number: '2', name: 'USB camera', model: 'Alpha-USB', lens: 'None', isNew: true };
    plan.cameras.push(failed, successful); await f.repository.write(null, plan, f.signal);
    fake.failProperty = 'password';
    const result = await f.call('send', { items: plan.cameras.map(item => ({ kind: 'camera', item, fields: ['number', 'name', 'model', 'ip'] })) });
    const error = result.results.find((row: RecordValue) => row.id === failed.id);
    assert.match(error.error, /rejected/); assert.ok(error.elementKey); assert.equal(error.needsInitialization, true);
    assert.equal(result.results.find((row: RecordValue) => row.id === successful.id).verified, true);
    assert.equal(result.revision, (await f.repository.read(f.signal)).revision);
    fake.failProperty = '';
    const retried = await f.call('send', { items: [{ kind: 'camera', item: failed, fields: ['password'] }] });
    assert.equal(retried.results[0].verified, true); assert.equal(retried.results[0].elementKey, error.elementKey);
    assert.equal(fake.actions.filter(action => action.new).length, 2);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('simultaneous new cameras cannot claim the same number', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture({}, { client: fake.client });
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    plan.cameras = ['first', 'second'].map(id => ({ id, device, number: '1', name: id, model: 'Alpha-USB', lens: 'None', isNew: true }));
    await f.repository.write(null, plan, f.signal);
    const result = await f.call('send', { items: plan.cameras.map(item => ({ kind: 'camera', item, fields: ['model'] })) });
    assert.equal(result.results.filter((row: RecordValue) => row.verified).length, 1);
    assert.match(result.results.find((row: RecordValue) => row.error).error, /camera number/);
    assert.equal(fake.actions.filter(action => action.new).length, 1);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('draft saves accept concurrent receipts and retain completed identities without hiding another editor', async () => {
  const f = fixture();
  try {
    const plan = emptyPlan(); plan.devices.push({ id: 'controller', base: '10.192.1.10' });
    plan.cameras.push({ id: 'camera', device: 'controller', name: 'Original', isNew: true, needsInitialization: true });
    const initial = await f.repository.write(null, plan, f.signal);
    await f.repository.update(plan => { Object.assign(plan.cameras[0]!, { elementKey: 'created', createState: null, needsInitialization: true }); }, f.signal);
    await f.repository.update(plan => { Object.assign(plan.cameras[0]!, { needsInitialization: false, isNew: false }); }, f.signal);
    const draft = structuredClone(plan); draft.cameras[0]!.name = 'Edited while sending';
    const saved = await f.repository.write(initial.revision, draft, f.signal);
    assert.equal(saved.plan.cameras[0]!.elementKey, 'created');
    assert.equal(saved.plan.cameras[0]!.needsInitialization, false); assert.equal(saved.plan.cameras[0]!.isNew, false);
    assert.equal(saved.plan.cameras[0]!.name, 'Edited while sending');
    await assert.rejects(() => f.repository.write(initial.revision, plan, f.signal), /another editor/);
    const other = fixture({}, {}, f.records);
    try {
      const receipt = await f.repository.update(plan => { plan.cameras[0]!.createState = null; }, f.signal);
      await other.repository.write(receipt.revision, saved.plan, other.signal);
      await assert.rejects(() => f.repository.write(saved.revision, saved.plan, f.signal), /another editor/);
      await f.repository.update(plan => { plan.cameras[0]!.createState = null; }, f.signal);
      await assert.rejects(() => f.repository.write(saved.revision, saved.plan, f.signal), /another editor/);
    } finally { await other.instance.dispose(); }
  } finally { await f.instance.dispose(); }
});

test('deletion waits for the same camera edit and later edits or stale saves cannot restore it', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  const client = (address: string) => new CyanviewClient(address, { socket: fake.socket, timeout: 2000 });
  try {
    fake.config.Camera.first = { Number: '1', Name: 'First', Model: 'Sony - Venice-IP', IP: '10.20.100.1', Port: '80' };
    const plan = { ...planFor(fake), cameras: fake.snapshot().cameras };
    const saved = await f.repository.write(null, plan, f.signal), camera = plan.cameras[0]!;
    const operations = new ConfigurationOperations(f.repository, client);
    fake.holdAction = 'update';
    const editing = operations.run({ kind: 'camera', item: { ...camera, name: 'Active edit' }, fields: ['name'] }, f.signal);
    await waitFor(() => fake.heldActionReplies.length === 1);
    const deleting = operations.run({ kind: 'camera', deleting: true, item: camera }, f.signal);
    const later = operations.run({ kind: 'camera', item: { ...camera, name: 'Too late' }, fields: ['name'] }, f.signal).then(() => null, error => error);
    await delay(20); assert.equal(fake.actions.filter(action => action.delete).length, 0);
    fake.releaseActionReplies();
    assert.equal((await editing).verified, true); assert.equal((await deleting).deleted, true);
    assert.match((await later).message, /camera was deleted/);
    await f.repository.write(saved.revision, plan, f.signal);
    assert.deepEqual((await f.repository.read(f.signal)).plan.cameras, []);
    assert.deepEqual(fake.config.Camera, {});
    assert.equal(fake.actions.filter(action => action.update).length, 1);
    assert.equal(fake.actions.filter(action => action.delete).length, 1);
  } finally { fake.releaseActionReplies(); await f.instance.dispose(); await fake.close(); }
});

test('an uncertain create is never automatically repeated', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), camera = { id: 'uncertain-camera', device: plan.devices[0]!.id, number: '1', name: 'Unknown', model: 'Venice-IP', ip: '10.20.100.101', port: '80', lens: 'None', isNew: true };
    plan.cameras.push(camera); await f.repository.write(null, plan, f.signal); fake.dropCreateReply = true;
    const operations = new ConfigurationOperations(f.repository, fake.client);
    await assert.rejects(() => operations.run({ kind: 'camera', item: camera, fields: ['model'] }, f.signal), /timed out/);
    await assert.rejects(() => operations.run({ kind: 'camera', item: camera, fields: ['model'] }, f.signal), /unknown outcome/);
    assert.equal(fake.actions.filter(action => action.new).length, 1);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('LAN Add preserves the existing address; Replace verifies new identity before deletion', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), old = plan.lans.find(row => row.elementKey === 'old')!;
    await f.repository.write(null, plan, f.signal); const operations = new ConfigurationOperations(f.repository, fake.client);
    const added = await operations.run({ kind: 'lan', item: { ...old, operation: 'Add', planned: '10.20.101.201/16' }, fields: ['planned'] }, f.signal);
    assert.equal(fake.config.IP.old.IP, '10.20.101.200'); assert.equal(fake.config.IP[added.elementKey].IP, '10.20.101.201');
    assert.equal(fake.actions.filter(action => action.delete).length, 0);
    const current = (await f.repository.read(f.signal)).plan;
    const staged = { ...old, id: 'replace-row', operation: 'Replace', planned: '10.20.101.202/16' }; current.lans.push(staged); await f.repository.write((await f.repository.read(f.signal)).revision, current, f.signal);
    fake.wrongIdentity = true;
    await assert.rejects(() => operations.run({ kind: 'lan', item: staged, fields: ['planned'] }, f.signal), /identity changed/);
    assert.equal(fake.config.IP.old.IP, '10.20.101.200'); assert.equal(fake.actions.filter(action => action.delete).length, 0);
    fake.wrongIdentity = false; fake.dropDeleteReply = true;
    const replaced = await operations.run({ kind: 'lan', item: staged, fields: ['planned'] }, f.signal);
    assert.equal(replaced.verified, true); assert.equal(fake.config.IP.old, undefined); assert.equal(fake.config.IP.protected.IP, '10.192.1.10');
    assert.equal(fake.actions.filter(action => action.delete).length, 1);
    assert.equal((await f.repository.read(f.signal)).plan.lans.find(row => row.id === staged.id)!.elementKey, replaced.elementKey);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('protected management addresses and deferred cGate writes cause no control request', async () => {
  const fake = new FakeController(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake); await f.repository.write(null, plan, f.signal); const operations = new ConfigurationOperations(f.repository, fake.client);
    const protectedRow = plan.lans.find(row => row.elementKey === 'protected')!;
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...protectedRow, operation: 'Replace', planned: '10.20.101.201/16' }, fields: ['planned'] }, f.signal), /protected/);
    await assert.rejects(() => operations.run({ kind: 'camera', item: { id: 'cgate', device: plan.devices[0]!.id, number: '1', name: 'cGate', model: 'Venice-IP', ip: '10.20.100.101', lens: 'cmotion cGate' }, fields: ['lens'] }, f.signal), /not available yet/);
    assert.equal(fake.actions.length, 0);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('discovery respects subnet boundaries and deduplicates aliases without control writes', async () => {
  assert.deepEqual([networkRange('10.20.1.2/30').count, networkRange('10.20.1.2/30').address(0), networkRange('10.20.1.2/30').address(1)], [2, '10.20.1.1', '10.20.1.2']);
  assert.throws(() => networkRange('10.20.0.0/8'), /16/);
  let final: any;
  await new Promise<void>(resolve => { const discovery = new Discovery(async address => ({ id: 'same', serial: 'same', address }), value => { if (value.state === 'complete') { final = value; resolve(); } }, async () => true); discovery.start('10.20.1.0/30','ip'); });
  assert.equal(final.results.length, 1); assert.equal(final.results[0].addresses.length, 2);
});

test('large saved fleets transfer in bounded bridge messages and restore all rows', async () => {
  const f = fixture(); await f.instance.start();
  try {
    const plan = emptyPlan(); plan.devices.push({ id: 'controller', base: '10.192.1.10', serial: 'CY-RIO-1-10' });
    for (let i = 0; i < 512; i++) plan.cameras.push({ id: 'camera-' + i, device: 'controller', name: 'Camera ' + i, password: 'x'.repeat(500), lens: 'None', dirty: ['name'] });
    const text = JSON.stringify(plan); assert.ok(text.length > 262144);
    const transfer = await f.call('save-begin', { revision: null });
    for (let offset = 0, index = 0; offset < text.length; offset += 60000, index++) {
      const part = { id: transfer.id, index, text: text.slice(offset, offset + 60000) };
      ModuleFrontendValueSchema.parse(part); await f.call('save-part', part);
    }
    await f.call('save-commit', { id: transfer.id });
    const header = await f.call('read-plan'); ModuleFrontendValueSchema.parse(header); assert.ok(header.token); assert.equal(header.plan, null);
    let restored = '';
    for (let offset = 0; offset < header.length; offset += 60000) { const part = await f.call('read-part', { token: header.token, offset }); ModuleFrontendValueSchema.parse(part); restored += part.text; }
    assert.equal(JSON.parse(restored).cameras.length, 512); assert.equal(JSON.parse(restored).cameras[511].password, 'x'.repeat(500));
    await assert.rejects(() => f.call('read-part', { token: header.token, offset: 0 }), /expired/);
  } finally { await f.instance.dispose(); }
});

test('existing lens parameter values are restored without inventing values for unrecognized formats', () => {
  assert.deepEqual(decodeLensParameters('Tilta - Nucleus-M', '7:I:2.8:22,8:Z,9:F'), { irisMotor: '7', irisMin: '2.8', irisMax: '22', zoomMotor: '8', focusMotor: '9', lensParamsEditable: true });
  assert.deepEqual(decodeLensParameters('ARRI - cforce', '2:22:iris:4:right,zoom:3:left,focus:1:right'), { irisMin: '2', irisMax: '22', irisTorque: '4', irisDirection: 'right', zoomTorque: '3', zoomDirection: 'left', focusTorque: '1', focusDirection: 'right', lensParamsEditable: true });
  assert.deepEqual(decodeLensParameters('ARRI - cforce', 'iris:_:_,zoom:4:right'), { lensParamsEditable: false });
  assert.deepEqual(decodeLensParameters('Tilta - Nucleus-M', '7:I'), { irisMotor: '7', irisMin: '1.6', irisMax: '32', lensParamsEditable: true });
  assert.deepEqual(decodeLensParameters('ARRI - cforce', 'zoom:4:right'), { zoomTorque: '4', zoomDirection: 'right', lensParamsEditable: true });
  assert.equal(lensParameters({ lens: 'ARRI - cforce', zoomTorque: '4', zoomDirection: 'left', irisMin: 'invalid' }, ['zoomTorque'], 'zoom:3:right,focus:1:left'), 'zoom:4:right,focus:1:left');
  assert.equal(lensParameters({ lens: 'Tilta - Nucleus-M', focusMotor: '2' }, ['focusMotor'], '7:I'), '7:I,2:F');
  assert.throws(() => lensParameters({ lens: 'Tilta - Nucleus-M', focusMotor: '7' }, ['focusMotor'], '7:I'), /distinct motor IDs/);
});

test('Cyanview announcements accept the observed gateway and RCP formats, including the auxiliary address', () => {
  assert.deepEqual(parseAnnouncement(Buffer.from('gateway cy-gateway-1-40 10.192.1.40. - 0 -'),'10.192.1.40'), {role:'gateway',serialHint:'CY-GATEWAY-1-40',addresses:['10.192.1.40']});
  assert.deepEqual(parseAnnouncement(Buffer.from('rcp RCP-1-50 10.192.2.50 cy-rcp-1-50 8 -'),'10.192.2.50'), {role:'rcp',serialHint:'CY-RCP-1-50',addresses:['10.192.1.50','10.192.2.50']});
  assert.equal(parseAnnouncement(Buffer.from('unrelated 10.192.1.10'),'10.192.1.10'),null);
  assert.equal(parseAnnouncement(Buffer.from('rcp cy-rcp-999-1 10.192.1.10'),'10.192.1.10'),null);
});

test('cached-neighbor discovery excludes unresolved entries left by a subnet sweep',()=>{
  assert.deepEqual(parseNeighbors('? (10.192.0.1) at (incomplete) on en10\n? (10.192.1.40) at 02:00:00:6:ab:be on en10\n10.192.1.50 dev eth0 lladdr 02:00:00:0a:76:ae REACHABLE\n10.192.1.5 dev eth0 FAILED'),['10.192.1.40','10.192.1.50']);
});

test('quick discovery probes announced addresses, finds both devices and never sweeps the subnet', async () => {
  const attempts: string[] = [], updates: any[] = [];
  let ended!: () => void;
  const complete=new Promise<void>(resolve=>{ended=resolve;});
  const discovery=new Discovery(async address=>{attempts.push(address);if(address==='10.192.2.50')throw new Error('Auxiliary address');return {id:address,serial:address,address};},state=>{updates.push(structuredClone(state));if(state.state==='complete')ended();},async()=>{throw new Error('A quick discovery must not scan TCP ports');},{durationMs:30,announcements:async(receive,signal)=>{
    receive(parseAnnouncement(Buffer.from('gateway cy-gateway-1-40 10.192.1.40. - 0 -'),'10.192.1.40')!);
    receive(parseAnnouncement(Buffer.from('rcp RCP-1-50 10.192.2.50 cy-rcp-1-50 8 -'),'10.192.2.50')!);
    receive(parseAnnouncement(Buffer.from('gateway cy-gateway-1-40 10.20.101.200. - 0 -'),'10.20.101.200')!);
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  }});
  discovery.start('10.192.0.0/16','broadcast');await complete;
  assert.deepEqual([...attempts].sort(),['10.192.1.40','10.192.1.50','10.192.2.50'].sort());
  assert.equal(discovery.progress!.results.length,2);assert.equal(discovery.progress!.total,0);
  assert.ok(updates.some(state=>state.state==='scanning'&&state.results.length===2));discovery.dispose();
});

test('manual IP lookups remain in public discovery state after an empty scan and exclude credentials', async () => {
  const fake=new FakeController();await fake.start();
  const f=fixture({}, {client:fake.client,reachable:async()=>false});await f.instance.start();
  try {
    await f.call('scan',{range:'10.20.101.250/32',method:'ip'});
    await f.call('probe',{address:'10.192.1.10'});
    const state:any=f.states.at(-1);assert.equal(state.values.lookupResults.length,1);assert.equal(state.values.lookupResults[0].serial,'CY-RIO-1-10');
    await f.call('refresh');assert.equal((f.states.at(-1) as any).values.lookupResults.length,1);
    assert.equal(fake.actions.length,0);assert.doesNotMatch(JSON.stringify(f.states),/"Password"|"password"|"Camera"/);
  }finally{await f.instance.dispose();await fake.close();}
});

test('a busy broadcast port still discovers known neighbors before reporting the warning',async()=>{
  let final:any;
  await new Promise<void>(resolve=>{
    const discovery=new Discovery(async address=>({id:address,serial:address,address}),state=>{if(state.state==='complete'){final=state;resolve();}},undefined,{
      announcements:async()=>{throw new Error('Broadcast port busy');},
      seeds:async receive=>{await new Promise(done=>setTimeout(done,5));receive(['10.192.1.40','10.192.1.50']);},
    });discovery.start('10.192.0.0/16','broadcast');
  });
  assert.equal(final.results.length,2);assert.equal(final.error,'Broadcast port busy');
});

test('removing a managed device forgets what was read and leaves hardware untouched',async()=>{
  const fake=new FakeController();await fake.start();
  let holdSnapshot=false,blocked!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>blocked=resolve),released=new Promise<void>(resolve=>release=resolve);
  const f=fixture({}, {client:address=>{const client=fake.client(address),connect=client.connect.bind(client);client.connect=async signal=>{await connect(signal);if(holdSnapshot){holdSnapshot=false;blocked();await released;}};return client;}});await f.instance.start();
  const waitFor=async(condition:()=>boolean)=>{
    const deadline=Date.now()+1000;
    while(!condition()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(condition(),'Timed out waiting for status connection cleanup');
  };
  try{
    const snapshot=await f.call('probe',{address:'10.192.1.10'});
    await f.call('import-device',{id:snapshot.device.id,address:'10.192.1.10'});
    const observation=()=>(f.states.at(-1) as any).values.observations[snapshot.device.id];
    assert.equal(observation().online,true);
    await waitFor(()=>fake.sockets.size===0);
    // An unrelated empty-plan save must not forget the provisional import.
    let saved=await f.call('save-plan',{revision:null,plan:emptyPlan()});
    assert.equal(observation().online,true);
    saved=await f.call('save-plan',{revision:saved.revision,plan:planFor(fake)});
    const hardware=structuredClone(fake.config);
    f.failNextWrite('plan');
    // A rejected save must preserve what was read as well as the managed plan.
    await assert.rejects(()=>f.call('save-plan',{revision:saved.revision,plan:emptyPlan()}),/storage failure/);
    assert.equal(observation().online,true);
    holdSnapshot=true;const refreshing=f.call('refresh');await waiting;
    await f.call('save-plan',{revision:saved.revision,plan:emptyPlan()});
    release();const refreshed=await refreshing;assert.deepEqual(refreshed.snapshots,[]);
    await waitFor(()=>fake.sockets.size===0);
    assert.equal((f.states.at(-1) as any).values.observations[snapshot.device.id],undefined);
    assert.deepEqual(fake.config,hardware);assert.equal(fake.actions.length,0);
    // Removing and re-adding a zero-camera device must not exhaust import tokens.
    for(let count=0;count<18;count++)await f.call('import-device',{id:snapshot.device.id,address:'10.192.1.10'});
  }finally{await f.instance.dispose();await fake.close();}
});

test('Refresh all reads each controller once for outside changes, and leaves status to MQTT',async()=>{
  const fake=new FakeController();await fake.start();const urls:string[]=[];
  const socket:typeof fake.socket=(url,options)=>{urls.push(new URL(url).pathname);return fake.socket(url,options);};
  fake.config.Camera.a={Number:'1',Name:'Before',Model:'Sony - Venice-IP'};
  const f=fixture({}, {client:address=>new CyanviewClient(address,{socket,timeout:250})});await f.instance.start();
  try{
    const snapshot=fake.snapshot(),plan={...planFor(fake),cameras:snapshot.cameras},id=plan.devices[0]!.id;
    await f.call('save-plan',{revision:null,plan});
    // Someone changes the camera without going through this module.
    fake.config.Camera.a.Name='Changed outside';
    const reply=await f.call('refresh');
    assert.equal(reply.snapshots[0].cameras[0].name,'Changed outside');
    assert.deepEqual(reply.failed,[]);
    assert.ok(urls.length>0&&!urls.includes('/ws/dynstatus'),'Status comes over MQTT');
    await delay(50);
    assert.equal(fake.sockets.size,0,'Nothing stays open');
    assert.deepEqual(Object.keys((f.states.at(-1) as any).values.cameraControl.controllers),[id]);
    await fake.close();
    assert.deepEqual((await f.call('refresh')).failed,[id],'A controller that can\u2019t be read is named');
    assert.equal(fake.actions.length,0);
  }finally{await f.instance.dispose();await fake.close();}
});

test('a Gateway gets an MQTT connection like an RCP, and Refresh all only reads its settings',async()=>{
  const fake=new FakeController();await fake.start();const urls:string[]=[],sessions:string[]=[];
  fake.config.Product={Serial:'CY-GATEWAY-1-40',Name:'GATEWAY',MaxCam:'unlimited'};
  fake.config.Camera.a={Number:'1',Name:'Wide',Model:'Sony - Venice-IP'};
  const socket:typeof fake.socket=(url,options)=>{urls.push(new URL(url).pathname);return fake.socket(url,options);};
  const f=fixture({}, {client:address=>new CyanviewClient(address,{socket,timeout:250}),control:{session:(definition,changed)=>{sessions.push(definition.serial!);return noEquipment.session!(definition,changed);}}});await f.instance.start();
  try{
    const snapshot=fake.snapshot(),plan={...planFor(fake),cameras:snapshot.cameras},id=plan.devices[0]!.id;
    assert.equal(plan.devices[0]!.kind,'Gateway');
    await f.call('save-plan',{revision:null,plan});
    assert.deepEqual(sessions,['CY-GATEWAY-1-40'],'Watched from the save, with nothing pressed');
    assert.deepEqual(Object.keys((f.states.at(-1) as any).values.cameraControl.controllers),[id]);
    const reply=await f.call('refresh');
    assert.deepEqual(reply.failed,[]);
    assert.equal((f.states.at(-1) as any).values.observations[id].online,true);
    assert.equal((f.states.at(-1) as any).values.observations[id].cameras,undefined,'Camera status comes over MQTT');
    assert.ok(urls.length>0&&!urls.includes('/ws/dynstatus'));
    await delay(50);
    assert.equal(fake.sockets.size,0,'Nothing stays open');
    assert.equal(fake.actions.length,0);
  }finally{await f.instance.dispose();await fake.close();}
});
