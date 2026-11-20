import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import dgram from 'node:dgram';
import { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleDocumentSnapshot } from '@hubble/module-sdk';
import { fixture } from './helpers.js';
import manifest from '../src/manifest.js';
import { object, type RecordValue } from '../src/model.js';

// Short timings for tests. Simulated takes them from the options given; it takes nothing else from them.
const timings = { liveConfig: { retryMs: [100, 500], settleMs: 20 }, cameraEnabled: { holdMs: 50, onlineWaitMs: 2000 }, discovery: { durationMs: 150 } };
const RIO = 'CY-RIO-1-10', RCP1 = 'CY-RCP-1-20', RCP2 = 'CY-RCP-1-30';

const eventually = async (predicate: () => boolean, what: string, ms = 4000) => {
  for (const until = Date.now() + ms; Date.now() < until;) { if (predicate()) return; await delay(10); }
  assert.ok(predicate(), what);
};
const values = (f: ReturnType<typeof fixture>) => object(object(f.states.at(-1)).values);
const control = (f: ReturnType<typeof fixture>) => object(values(f).cameraControl);

/**
 * Every way out of the process to the network or another program, made to fail and counted while a test runs, so
 * Simulated can be shown to reach nothing but its own controllers. The tests' default MQTT session, which points at a
 * real loopback port, would be counted too.
 */
function noNetwork() {
  const attempts: string[] = [];
  // Every child process starts through this, though Node's types leave it out.
  const child = ChildProcess.prototype as unknown as { spawn: unknown };
  const originals = { connect: net.Socket.prototype.connect, listen: net.Server.prototype.listen, bind: dgram.Socket.prototype.bind, spawn: child.spawn };
  const refuse = (what: string) => function (this: unknown, ...args: unknown[]): never { attempts.push(what + ' ' + JSON.stringify(args[0] ?? null)); throw new Error('Simulated must not use the network: ' + what); };
  net.Socket.prototype.connect = refuse('connect') as never;
  net.Server.prototype.listen = refuse('listen') as never;
  dgram.Socket.prototype.bind = refuse('bind') as never;
  child.spawn = refuse('spawn');
  return { attempts, restore() { Object.assign(net.Socket.prototype, { connect: originals.connect }); Object.assign(net.Server.prototype, { listen: originals.listen }); Object.assign(dgram.Socket.prototype, { bind: originals.bind }); child.spawn = originals.spawn; } };
}

async function start(records?: Map<string, ModuleDocumentSnapshot>) {
  const f = fixture({ sampleData: true }, timings, records);
  await f.instance.start();
  return f;
}
/** Finds the simulated rig with Discover, adds all three controllers and their cameras, and saves them, as the page does. */
async function addRig(f: ReturnType<typeof fixture>) {
  await f.call('scan', { range: '10.192.0.0/16', method: 'ping' });
  const found = object(values(f).discovery).results as RecordValue[];
  const devices: RecordValue[] = [], cameras: RecordValue[] = [], lans: RecordValue[] = [];
  for (const result of found) {
    const added = await f.call('import-device', { id: result.id, address: result.address });
    devices.push(added.device); lans.push(...added.lans);
    for (let offset = 0; offset < added.cameraCount; offset += 64) cameras.push(...(await f.call('import-part', { token: added.token, offset })).cameras);
  }
  const saved = await f.call('save-plan', { revision: null, plan: { formatVersion: 1, devices, cameras, lans, uiState: null } });
  const id = (serial: string) => devices.find(device => device.serial === serial)!.id as string;
  return { revision: saved.revision as string, devices, cameras, lans, rio: id(RIO), rcp1: id(RCP1), rcp2: id(RCP2) };
}

test('the setting is called Simulated, keeps its saved id and says what it does', () => {
  const setting = manifest.settings?.find(item => item.id === 'sampleData');
  assert.equal(setting?.label, 'Simulated');
  assert.equal(setting?.default, false);
  assert.match(String(setting?.description), /simulated Cyanview controllers inside Hubble: a RIO and two RCPs/);
  assert.match(String(setting?.description), /Nothing goes on the network/);
  for (const id of ['sample-plan', 'sample-camera-control', 'sample-rig', 'sample-choices']) assert.ok(manifest.documents?.some(document => document.id === id), id);
  assert.ok((manifest.documents?.length ?? 0) <= 64, 'Hubble takes at most 64 documents from a module');
});

test('Discover finds the simulated RIO and two RCPs on every range, and Find by IP reaches each address', async () => {
  const f = await start();
  try {
    assert.equal(values(f).simulated, true);
    assert.equal(object(f.states.at(-1)).message, 'Simulated');
    for (const range of ['10.192.0.0/16', '10.20.0.0/16']) {
      await f.call('scan', { range, method: 'ping' });
      const discovery = object(values(f).discovery);
      assert.equal(discovery.state, 'complete', range);
      assert.deepEqual((discovery.results as RecordValue[]).map(result => result.serial).sort(), [RCP1, RCP2, RIO], range);
    }
    await f.call('scan', { range: '10.192.0.0/16', method: 'broadcast' });
    await eventually(() => object(values(f).discovery).state === 'complete', 'Broadcast discovery finished');
    assert.deepEqual((object(values(f).discovery).results as RecordValue[]).map(result => result.serial).sort(), [RCP1, RCP2, RIO]);
    // A range with no simulated controller in it finds nothing.
    await f.call('scan', { range: '192.168.1.0/24', method: 'ping' });
    assert.deepEqual(object(values(f).discovery).results, []);
    const probes = { '10.192.1.10': RIO, '10.20.101.200': RIO, '10.192.1.20': RCP1, '10.20.101.201': RCP1, '10.192.1.30': RCP2, '10.20.101.202': RCP2 };
    for (const [address, serial] of Object.entries(probes)) {
      const probe = await f.call('probe', { address });
      assert.equal(probe.device.serial, serial, address);
      assert.equal(probe.cameraCount, 2, 'The RIO has two cameras and each RCP takes both');
    }
    await assert.rejects(f.call('probe', { address: '10.192.1.99' }), /Controller connection failed/);
    // Find rig follows the other controllers each one lists.
    const listed = await f.call('find-rig', { ignore: [RIO] });
    assert.deepEqual(listed.found.map((device: RecordValue) => device.serial).sort(), [RCP1, RCP2]);
    const rig = await addRig(f);
    assert.deepEqual(rig.devices.map(device => device.serial).sort(), [RCP1, RCP2, RIO]);
    // Each RCP's two cameras are REMI copies of the RIO's.
    for (const rcp of [rig.rcp1, rig.rcp2]) assert.deepEqual(rig.cameras.filter(row => row.device === rcp).map(row => [row.number, row.name, !!row.remi]), [['1', 'Wide', true], ['2', 'Tight', true]]);
    const read = await f.call('read-plan');
    assert.equal(read.sample, false, 'The page works live against the simulated controllers');
    assert.equal(read.simulated, true);
    for (const row of [...read.plan.devices, ...read.plan.cameras]) assert.equal(row.online, null, 'Only live state says Online');
    // Adding a controller saved its model list, in Simulated's own choices.
    const { catalogs } = await f.call('choice-catalogs');
    assert.deepEqual(catalogs[JSON.stringify([RIO, 'Model'])].map((choice: RecordValue) => choice.label), ['Sony - Venice-IP', 'Sony - Alpha-USB', 'Sony - Alpha-IP']);
    for (const id of ['plan', 'plan-remi', 'camera-control', 'plan-choices-Model']) assert.equal(f.records.get(id), undefined, `The real ${id} is never touched`);
  } finally { await f.instance.dispose(); }
});

test('a camera added with a Source is sent and confirmed, and presses select, record and switch cameras on the simulated rig', async () => {
  const f = await start();
  try {
    const rig = await addRig(f);
    // Each controller's MQTT comes up and reports every camera online.
    await eventually(() => rig.cameras.every(row => object(object(control(f).cameras)[row.id]).online === true), 'Every camera reports itself online');
    const plan = (await f.repository.read(f.signal)).plan;
    const camera: RecordValue = { id: 'new-jib', device: rig.rio, number: '3', name: 'Jib', model: 'Venice-IP', ip: '10.20.20.3', port: '80', login: '', password: '', lens: 'None', lensPort: 'None', isNew: true };
    plan.cameras.push(camera);
    await f.call('save-plan', { revision: (await f.repository.read(f.signal)).revision, plan });
    const changes = () => Number(object(object(values(f).configChanges).counts)[rig.rio] ?? 0), before = changes();
    const sent = await f.call('send', { kind: 'camera', item: camera, fields: ['number', 'name', 'model', 'ip'] });
    assert.equal(sent.verified, true, JSON.stringify(sent));
    // The RIO pushed the change to its held settings socket, as a real one does, so an open page reads it again.
    await eventually(() => changes() > before, 'The live settings socket reported the change');
    const saved = (await f.repository.read(f.signal)).plan.cameras.find(row => row.id === 'new-jib')!;
    assert.equal(saved.elementKey, sent.elementKey);
    const refreshed = await f.call('refresh');
    assert.deepEqual(refreshed.failed, []);
    const rio = refreshed.snapshots.find((snapshot: RecordValue) => snapshot.device.serial === RIO);
    assert.deepEqual(rio.cameras.find((row: RecordValue) => row.elementKey === sent.elementKey)?.name, 'Jib');
    // The RIO reports the new camera online over MQTT, once its model is set.
    await f.call('save-plan', { revision: (await f.repository.read(f.signal)).revision, plan: { ...plan, cameras: plan.cameras.map(row => row.id === 'new-jib' ? { ...row, ...saved, isNew: false } : row) } });
    await eventually(() => object(object(control(f).cameras)['new-jib']).online === true, 'The new camera reports itself online');

    // REMI: the new camera goes to the first RCP as a copy.
    const routed = await f.call('remi-send', { receiver: rig.rcp1, items: [{ id: sent.elementKey, kind: 'camera', source: rig.rio, key: sent.elementKey, enable: true }] });
    assert.equal(routed.results[0].verified, true, JSON.stringify(routed));

    const fields = (actionId: string, actionType: string, controllerId: string, cameraNumber: number) => ({ actionId, actionColumnId: 'column', values: { enabled: true, actionType,
      'module.controllerId': controllerId, 'module.cameraNumber': cameraNumber, 'module.feedbackEnabled': true, 'module.feedbackColor': '#333333 | #00FF00' } });
    await f.instance.subscribeFeedback!([
      { id: 'camera-control', fields: fields('select-1', 'select-camera', rig.rcp1, 1) },
      { id: 'camera-control', fields: fields('select-2', 'select-camera', rig.rcp1, 2) },
      { id: 'camera-control', fields: fields('record-1', 'record-camera', rig.rcp1, 1) },
      { id: 'camera-control', fields: fields('record-1-other', 'record-camera', rig.rcp2, 1) },
    ], { signal: f.signal });
    const triggers = (id: string) => object(object(f.feedback.filter(item => object(object(item).fields).actionId === id).at(-1)).appearance).triggers as string[] ?? [];
    await eventually(() => triggers('select-1').includes('online') && triggers('record-1').includes('online'), 'Camera keys show Online');
    const press = (actionType: string, controllerId: string, cameraNumber?: number, gesture: 'press' | 'long-press-2s' = 'press') =>
      f.instance.execute!(actionType, { controllerId, ...(cameraNumber === undefined ? {} : { cameraNumber }) }, { ...f.execution(), gesture });

    // Select camera goes to the RCP's panel, which reports the camera it now has.
    assert.equal((await press('select-camera', rig.rcp1, 2)).status, 'success');
    await eventually(() => triggers('select-2').includes('selected') && !triggers('select-1').includes('selected'), 'Camera 2 is selected');
    assert.equal((await press('select-camera', rig.rcp1, 1)).status, 'success');
    await eventually(() => triggers('select-1').includes('selected') && !triggers('select-2').includes('selected'), 'Camera 1 is selected');
    assert.equal((await press('select-camera', rig.rio, 1)).status, 'failure', 'A RIO has no panel to select on');

    // Record camera: a tap starts it, confirmed by the camera, and every copy of the same camera shows it rolling.
    const started = await press('record-camera', rig.rcp1, 1);
    assert.equal(started.status, 'success', JSON.stringify(started));
    await eventually(() => triggers('record-1').includes('rolling') && triggers('record-1-other').includes('rolling'), 'Camera 1 shows Recording on both RCPs');
    const wideOnRio = rig.cameras.find(row => row.device === rig.rio && row.number === '1')!;
    await eventually(() => object(object(control(f).cameras)[wideOnRio.id]).recording === 'recording', 'The RIO reports its camera recording');
    // The 2-second hold stops it.
    assert.equal((await press('record-camera', rig.rcp1, 1, 'long-press-2s')).status, 'success');
    await eventually(() => !triggers('record-1').includes('rolling') && !triggers('record-1-other').includes('rolling'), 'Camera 1 stopped');

    // Start and Stop Recording go to the cameras ticked for Cyanview controls.
    assert.equal((await press('toggle-camera-enabled', rig.rcp2, 2)).status, 'success');
    assert.equal((await press('roll-enabled-cameras', rig.rcp2)).status, 'success');
    const tightOnRio = rig.cameras.find(row => row.device === rig.rio && row.number === '2')!;
    await eventually(() => object(object(control(f).cameras)[tightOnRio.id]).recording === 'recording', 'Start Recording rolled camera 2');
    assert.equal((await press('stop-enabled-cameras', rig.rcp2)).status, 'success');
    await eventually(() => object(object(control(f).cameras)[tightOnRio.id]).recording === 'stopped', 'Stop Recording stopped camera 2');

    // Camera Enabled off takes the camera and its copies offline, and on brings them back.
    const off = await f.call('camera-enabled', { device: rig.rio, key: wideOnRio.elementKey, enabled: false });
    assert.equal(off.copies, 2);
    await eventually(() => triggers('select-1').includes('offline') && triggers('record-1-other').includes('offline'), 'Camera 1 reads Camera offline on its RCPs');
    const on = await f.call('camera-enabled', { device: rig.rio, key: wideOnRio.elementKey, enabled: true });
    assert.equal(on.copies, 2);
    await eventually(() => triggers('select-1').includes('online') && triggers('record-1-other').includes('online'), 'Camera 1 is back online');
    const refreshedCamera = await f.call('camera-refresh', { device: rig.rio, key: wideOnRio.elementKey });
    assert.equal(refreshedCamera.copies, 2);
    await eventually(() => triggers('select-1').includes('online'), 'Camera 1 is online after its refresh');

    // A simulated controller has no web page, and nothing is opened.
    await assert.rejects(f.call('open-device-page', { address: '10.192.1.10' }), /simulated controller has no web page/);
    assert.equal(f.records.get('camera-control'), undefined, 'The real selection is never touched');
    assert.ok(f.records.get('sample-camera-control'));
  } finally { await f.instance.dispose(); }
});

test('a restarted worker finds the simulated controllers as they were left', async () => {
  const f = await start();
  let restarted: ReturnType<typeof fixture> | undefined;
  try {
    const rig = await addRig(f);
    await eventually(() => rig.cameras.every(row => object(object(control(f).cameras)[row.id]).online === true), 'Every camera reports itself online');
    const wide = rig.cameras.find(row => row.device === rig.rio && row.number === '1')!;
    const renamed = await f.call('send', { kind: 'camera', item: { ...wide, name: 'Wide renamed' }, fields: ['name'] });
    assert.equal(renamed.verified, true);
    assert.equal((await f.instance.execute!('select-camera', { controllerId: rig.rcp2, cameraNumber: 2 }, f.execution())).status, 'success');
    assert.equal((await f.instance.execute!('record-camera', { controllerId: rig.rcp1, cameraNumber: 1 }, f.execution())).status, 'success');
    const saved = f.records.get('sample-rig');
    assert.ok(saved && Object.keys(object(saved.value)).length, 'The rig was saved during the commands');
    await f.instance.dispose();

    // The documents go through JSON, as a workspace export and import takes them.
    restarted = await start(new Map(JSON.parse(JSON.stringify([...f.records]))));
    const refreshed = await restarted.call('refresh');
    assert.deepEqual(refreshed.failed, []);
    const names = (serial: string) => refreshed.snapshots.find((snapshot: RecordValue) => snapshot.device.serial === serial).cameras.map((row: RecordValue) => row.name).sort();
    assert.deepEqual(names(RIO), ['Tight', 'Wide renamed']);
    // Renaming a camera rebuilt its REMI copies, and the rebuilt copies are still there.
    assert.deepEqual(names(RCP1), ['Tight', 'Wide renamed']);
    assert.deepEqual(names(RCP2), ['Tight', 'Wide renamed']);
    const fields = (actionId: string, actionType: string, controllerId: string, cameraNumber: number) => ({ actionId, actionColumnId: 'column', values: { enabled: true, actionType,
      'module.controllerId': controllerId, 'module.cameraNumber': cameraNumber, 'module.feedbackEnabled': true, 'module.feedbackColor': '#333333 | #00FF00' } });
    await restarted.instance.subscribeFeedback!([
      { id: 'camera-control', fields: fields('selected', 'select-camera', rig.rcp2, 2) },
      { id: 'camera-control', fields: fields('rolling', 'record-camera', rig.rcp1, 1) },
    ], { signal: restarted.signal });
    const triggers = (id: string) => object(object(restarted!.feedback.filter(item => object(object(item).fields).actionId === id).at(-1)).appearance).triggers as string[] ?? [];
    await eventually(() => triggers('selected').includes('selected'), 'RCP 2 still has camera 2 selected');
    await eventually(() => triggers('rolling').includes('rolling'), 'Camera 1 is still recording');
  } finally { await restarted?.instance.dispose(); await f.instance.dispose(); }
});

test('Simulated reaches nothing on the network, whatever it is given, and opens no other program', async () => {
  const guard = noNetwork();
  let f: ReturnType<typeof fixture> | undefined;
  try {
    // The guard catches a real connection, such as the one the tests' default MQTT session makes outside Simulated.
    assert.throws(() => net.createConnection({ host: '127.0.0.1', port: 9 }), /must not use the network/);
    assert.equal(guard.attempts.length, 1);
    guard.attempts.length = 0;
    // A real client and opener are passed in, as a mistaken caller might. Simulated must use neither.
    const opened: string[] = [];
    f = fixture({ sampleData: true }, { ...timings, client: () => { throw new Error('A real controller client was used'); }, openPage: async address => { opened.push(address); },
      reachable: async () => { throw new Error('A real reachability check was used'); } });
    await f.instance.start();
    const rig = await addRig(f);
    await f.call('scan', { range: '10.20.0.0/16', method: 'ping' });
    await f.call('scan', { range: '10.192.0.0/16', method: 'broadcast' });
    await eventually(() => object(values(f!).discovery).state === 'complete', 'Broadcast discovery finished');
    await f.call('find-rig', { ignore: [] });
    await eventually(() => rig.cameras.every(row => object(object(control(f!).cameras)[row.id]).online === true), 'Every camera reports itself online');
    assert.equal((await f.instance.execute!('select-camera', { controllerId: rig.rcp1, cameraNumber: 1 }, f.execution())).status, 'success');
    assert.equal((await f.instance.execute!('record-camera', { controllerId: rig.rcp1, cameraNumber: 1 }, f.execution())).status, 'success');
    const wide = rig.cameras.find(row => row.device === rig.rio && row.number === '1')!;
    await f.call('camera-enabled', { device: rig.rio, key: wide.elementKey, enabled: false });
    await f.call('camera-enabled', { device: rig.rio, key: wide.elementKey, enabled: true });
    await f.call('refresh', { live: true });
    await f.call('options', { device: rig.rio, rowId: wide.id, field: 'Model' });
    await f.call('remi-state', { receiver: rig.rcp1, source: rig.rio });
    await assert.rejects(f.call('open-device-page', { address: '10.192.1.20' }), /simulated controller has no web page/);
    await delay(300);
    assert.deepEqual(opened, []);
    assert.deepEqual(guard.attempts, []);
  } finally { await f?.instance.dispose(); guard.restore(); }
});
