import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { FakeController, FakeRemiFleet, fixture } from './helpers.js';
import { broker, closeBrokers } from './control-broker.js';
import { CyanviewClient } from '../src/transport.js';
import { RcpSession } from '../src/control/rcp-session.js';
import type { RecordValue } from '../src/model.js';
import type { ServiceOptions } from '../src/service.js';

const live = { retryMs: [20, 40], settleMs: 10, connectMs: 500 };
async function waitFor(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await delay(5);
  assert.ok(condition(), what);
}
const settings = (fake: FakeController) => fake.paths.filter(path => path === '/ws/ui').length;
const count = (f: ReturnType<typeof fixture>, id: string) => (f.states.at(-1) as any)?.values?.configChanges?.counts?.[id];

// One controller with two cameras, saved, with its settings socket held open as in Hubble.
async function managed(liveConfig: ServiceOptions['liveConfig'] = live) {
  const fake = new FakeController();
  await fake.start();
  fake.config.Camera.c1 = { Number: '1', Name: 'Cam 1', Model: 'Sony - Venice-IP', IP: '10.20.20.1', Port: '80', Enabled: '1' };
  fake.config.Camera.c2 = { Number: '2', Name: 'Cam 2', Model: 'Sony - Venice-IP', IP: '10.20.20.2', Port: '80', Enabled: '1' };
  const f = fixture({}, { client: fake.client, liveConfig });
  await f.instance.start();
  const snapshot = fake.snapshot(), id = String(snapshot.device.id);
  await f.call('save-plan', { revision: null, plan: { formatVersion: 1, devices: [snapshot.device], cameras: snapshot.cameras, lans: snapshot.lans, uiState: null } });
  await waitFor(() => fake.sockets.size === 1 && count(f, id) === 1, 'The controller has its settings socket held and its first configuration counted');
  const row = (key: string) => snapshot.cameras.find(camera => camera.elementKey === key)!;
  return { fake, f, id, row, close: async () => { await f.instance.dispose(); await fake.close(); } };
}

test('a lent socket is the same socket: its borrower can use it and can’t close it', async () => {
  const fake = new FakeController();
  await fake.start();
  fake.config.Camera.c1 = { Number: '1', Name: 'Cam 1', Model: 'Sony - Venice-IP' };
  const client = fake.client('10.192.1.10');
  try {
    await client.connect(AbortSignal.timeout(2000));
    assert.equal(client.lent, false);
    assert.ok(client.quietMs < 1000, 'A socket that just answered has been heard from');
    const loan = client.lend();
    assert.equal(loan.lent, true);
    assert.equal(loan.serial, client.serial);
    assert.equal(loan.connected, true);
    // A request on the loan goes down the one socket, and what the controller reports reaches both.
    assert.ok(Array.isArray(await loan.option('c1', 'Model', AbortSignal.timeout(2000))));
    await loan.update('c1', { name: 'Renamed' }, AbortSignal.timeout(2000));
    await loan.waitFor(config => config.Camera?.c1?.Name === 'Renamed', AbortSignal.timeout(2000));
    assert.equal(client.config.Camera.c1.Name, 'Renamed');
    assert.equal(fake.opened, 1);
    loan.close(); loan.close();
    assert.equal(client.connected, true, 'Giving a loan back leaves the socket open');
    assert.equal(fake.sockets.size, 1);
    client.close();
    assert.equal(loan.connected, false, 'The holder closing it closes it for everyone');
  } finally { client.close(); await fake.close(); }
});

test('a send goes down the socket already held on the controller, which stays held', async () => {
  const s = await managed();
  try {
    const held = [...s.fake.sockets][0], opened = s.fake.opened;
    const reply = await s.f.call('send', { items: [
      { kind: 'camera', item: { ...s.row('c1'), name: 'Wide' }, fields: ['name'] },
      { kind: 'camera', item: { ...s.row('c2'), name: 'Close' }, fields: ['name'] },
    ] });
    assert.deepEqual(reply.results.map((result: RecordValue) => [result.verified, result.error]), [[true, undefined], [true, undefined]]);
    assert.equal(s.fake.config.Camera.c1.Name, 'Wide');
    assert.equal(s.fake.config.Camera.c2.Name, 'Close');
    assert.equal(s.fake.opened - opened, 0, 'The send opened no socket of its own');
    assert.deepEqual([...s.fake.sockets], [held], 'The held socket is the same one, still open');
    // It still listens: a change made elsewhere is counted as before.
    const before = count(s.f, s.id);
    s.fake.config.Camera.c1.Name = 'Renamed elsewhere'; s.fake.broadcast();
    await waitFor(() => count(s.f, s.id) > before, 'A later change from outside is still reported');
    // A new camera and its delete go the same way.
    const added = await s.f.call('send', { items: [{ kind: 'camera', item: { id: 'new-1', device: s.id, number: '3', name: 'Jib', model: 'Venice-IP', ip: '10.20.20.3', lens: 'None' }, fields: ['number', 'name', 'model', 'ip'] }] });
    assert.equal(added.results[0].verified, true, JSON.stringify(added.results[0]));
    const key = String(added.results[0].elementKey);
    const removed = await s.f.call('send', { items: [{ kind: 'camera', deleting: true, item: { id: 'new-1', device: s.id, elementKey: key, number: '3', name: 'Jib' }, fields: [] }] });
    assert.equal(removed.results[0].deleted, true, JSON.stringify(removed.results[0]));
    assert.equal(settings(s.fake), 1, 'Every send used the one settings socket');
    assert.deepEqual([...s.fake.sockets], [held]);
  } finally { await s.close(); }
});

test('a held socket that has gone quiet is not lent, and the send opens its own as it always did', async () => {
  // Nothing counts as heard from lately, as when a controller has stopped answering its heartbeat.
  const s = await managed({ ...live, lendQuietMs: -1 });
  try {
    const held = [...s.fake.sockets][0], opened = settings(s.fake);
    const reply = await s.f.call('send', { items: [{ kind: 'camera', item: { ...s.row('c1'), name: 'Wide' }, fields: ['name'] }] });
    assert.equal(reply.results[0].verified, true);
    assert.equal(settings(s.fake) - opened, 1, 'The send opened one socket of its own');
    await waitFor(() => s.fake.sockets.size === 1, 'and closed it afterwards');
    assert.deepEqual([...s.fake.sockets], [held], 'The held socket was left alone');
  } finally { await s.close(); }
});

test('a read that waited its turn on the socket gives back what the controller has when it answers', async () => {
  const s = await managed();
  try {
    // The controller is slow with its answer, as when a send is ahead of the read on the same socket.
    s.fake.optionDelayMs = 150;
    const reading = s.f.call('refresh', { devices: [s.id], live: true });
    await delay(40);
    s.fake.config.Camera.c1.Name = 'Changed while it waited'; s.fake.broadcast();
    const reply = await reading;
    assert.equal(reply.snapshots[0].cameras.find((row: RecordValue) => row.elementKey === 'c1').name, 'Changed while it waited');
    assert.equal(settings(s.fake), 1, 'It read the held socket throughout');
  } finally { s.fake.optionDelayMs = 0; await s.close(); }
});

test('a dropdown’s list is asked for over the held socket', async () => {
  const s = await managed();
  try {
    const opened = s.fake.opened;
    const reply = await s.f.call('options', { device: s.id, rowId: s.row('c1').id, field: 'Model' });
    assert.ok(reply.entries.length > 0);
    assert.equal(s.fake.opened - opened, 0);
    assert.equal(s.fake.sockets.size, 1);
  } finally { await s.close(); }
});

test('while work has a socket of its own on a controller, and for a moment after, the held one isn’t lent', async () => {
  const fake = new FakeController();
  await fake.start();
  fake.config.Camera.c1 = { Number: '1', Name: 'Cam 1', Model: 'Sony - Venice-IP', IP: '10.20.20.1', Port: '80', Enabled: '1' };
  const f = fixture({}, { client: fake.client, liveConfig: live, ownSettleMs: 150 });
  try {
    await f.instance.start();
    const snapshot = fake.snapshot(), id = String(snapshot.device.id), row = snapshot.cameras[0]!;
    await f.call('save-plan', { revision: null, plan: { formatVersion: 1, devices: [snapshot.device], cameras: snapshot.cameras, lans: snapshot.lans, uiState: null } });
    await waitFor(() => fake.sockets.size === 1, 'The settings socket is held');
    // A send of one row by itself opens its own socket, as it always has, and checks the result on another.
    const single = await f.call('send', { kind: 'camera', item: { ...row, name: 'Wide' }, fields: ['name'] });
    assert.equal(single.verified, true);
    const afterOwn = settings(fake);
    assert.ok(afterOwn >= 2, 'That send used sockets of its own');
    // Straight after, the held socket could be a moment behind that send, so the next piece of work opens its own too.
    await f.call('options', { device: id, rowId: row.id, field: 'Model' });
    assert.equal(settings(fake) - afterOwn, 1, 'The list was asked for over a new socket');
    // Once the controller has had time to report everywhere, work goes back to the held socket.
    await delay(200);
    const settled = settings(fake);
    await f.call('options', { device: id, rowId: row.id, field: 'Model' });
    const reply = await f.call('send', { items: [{ kind: 'camera', item: { ...row, name: 'Wider' }, fields: ['name'] }] });
    assert.equal(reply.results[0].verified, true);
    assert.equal(settings(fake) - settled, 0, 'The list and the send used the held socket again');
    assert.equal(fake.config.Camera[String(row.elementKey)].Name, 'Wider');
  } finally { await f.instance.dispose(); await fake.close(); }
});

// A RIO camera copied to a Master RCP, and the Master's copy copied on to a downstream RCP, every socket held.
async function chain(options: ServiceOptions = {}, hang?: { leaf: boolean }) {
  const rio = new FakeController(), master = new FakeController(), leaf = new FakeController();
  const devices = [rio, master, leaf], addresses = ['10.192.1.10', '10.192.1.20', '10.192.1.30'], names = ['RIO', 'Master', 'Leaf'];
  for (const [index, device] of devices.entries()) {
    device.config.IP.protected.IP = addresses[index];
    device.config.IP.old.IP = '10.20.101.' + (200 + index);
    if (index) device.config.Product = { Serial: 'CY-RCP-1-' + (10 + index * 10), Name: 'RCP', MaxCam: 'unlimited' };
  }
  rio.config.Camera.original = { Number: '1', Name: 'Wide', Model: 'Sony - Venice-IP', IP: '10.20.20.1', Port: '80', Enabled: '1' };
  const fleet = new FakeRemiFleet(devices);
  await Promise.all(devices.map(device => device.start()));
  const writes: string[] = [];
  for (const [index, device] of devices.entries()) device.onAction = (request: RecordValue) => {
    const value = request.update?.changes?.enabled;
    if (value !== undefined) writes.push(names[index] + ' ' + (value === '1' ? 'on' : 'off'));
  };
  // A controller that is switched off: its address takes the connection and never answers.
  const silent: Socket[] = [];
  const hole: Server = createServer(socket => { silent.push(socket); socket.on('error', () => undefined); });
  await new Promise<void>(resolve => hole.listen(0, '127.0.0.1', resolve));
  const holePort = (hole.address() as { port: number }).port;
  let attempts = 0;
  const client = (address: string) => {
    if (hang?.leaf && address === addresses[2]) { attempts++; return new CyanviewClient(address, { socket: () => new WebSocket('ws://127.0.0.1:' + holePort + '/ws/ui'), timeout: 3000 }); }
    return fleet.client(address);
  };
  const session = fixture({}, { client, cameraEnabled: { holdMs: 20, onlineWaitMs: 30 }, liveConfig: live, ...options });
  await session.instance.start();
  const snapshots = devices.map((device, index) => device.snapshot(addresses[index]));
  const [source, receiver, downstream] = snapshots.map(snapshot => String(snapshot.device.id)) as [string, string, string];
  await session.call('save-plan', { revision: null, plan: { formatVersion: 1, devices: snapshots.map(snapshot => snapshot.device), cameras: snapshots.flatMap(snapshot => snapshot.cameras), lans: [], uiState: null } });
  await waitFor(() => devices.every(device => device.sockets.size === 1), 'Every controller has its settings socket held');
  const added = await session.call('remi-send', { receiver, items: [{ id: 'original', kind: 'camera', source, key: 'original', enable: true, address: '10.20.101.200' }] });
  assert.equal(added.results[0].verified, true, JSON.stringify(added.results[0]));
  const masterCopy = Object.keys(master.config.Camera)[0]!;
  const attached = await session.call('remi-send', { receiver: downstream, items: [{ id: masterCopy, kind: 'camera', source: receiver, key: masterCopy, enable: true }] });
  assert.equal(attached.results[0].verified, true, JSON.stringify(attached.results[0]));
  const leafCopy = Object.keys(leaf.config.Camera)[0]!;
  writes.length = 0;
  const enabled = () => [rio.config.Camera.original.Enabled, master.config.Camera[masterCopy].Enabled, leaf.config.Camera[leafCopy].Enabled].join('');
  const close = async () => {
    await session.instance.dispose(); await Promise.all(devices.map(device => device.close()));
    for (const socket of silent) socket.destroy();
    await new Promise<void>(resolve => hole.close(() => resolve()));
  };
  /** Takes the downstream RCP off the network: its held socket drops, and its address stops answering. */
  const unplugLeaf = async () => {
    if (!hang) throw new Error('This rig has no silent address');
    hang.leaf = true;
    for (const socket of leaf.sockets) socket.terminate();
    await waitFor(() => leaf.sockets.size === 0 && attempts > 0, 'The downstream RCP is off the network and is being tried again');
  };
  return { rio, master, leaf, devices, session, source, receiver, downstream, masterCopy, leafCopy, writes, enabled, close, unplugLeaf };
}

test('Camera Enabled switches a camera and its copies over the held sockets, opening no settings socket', async () => {
  const s = await chain();
  try {
    const opened = s.devices.map(settings);
    const off = await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: false });
    assert.deepEqual([off.copies, off.unread], [2, []]);
    assert.deepEqual(s.writes, ['RIO off', 'Leaf off', 'Master off']);
    assert.equal(s.enabled(), '000');
    s.writes.length = 0;
    const on = await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: true });
    assert.deepEqual([on.copies, on.unread], [2, []]);
    // The copies are already off, so each only needs switching on, nearest first.
    assert.deepEqual(s.writes, ['RIO on', 'Master on', 'Leaf on']);
    assert.equal(s.enabled(), '111');
    assert.deepEqual(s.devices.map(settings), opened, 'Two switches and both looks for copies opened no settings socket');
    assert.deepEqual(s.devices.map(device => device.sockets.size), [1, 1, 1], 'Each controller still has its one held socket');
  } finally { await s.close(); }
});

test('a controller that answers on neither its settings socket nor MQTT is left out at once, and the rest go on', async () => {
  // The fixture's MQTT reaches nothing, so every controller's MQTT link has been tried and is down.
  const s = await chain({}, { leaf: false });
  try {
    await s.unplugLeaf();
    const began = performance.now();
    const off = await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: false });
    const elapsed = performance.now() - began;
    assert.deepEqual([off.copies, off.unread], [1, [s.downstream]], 'The copy that can be reached is switched, and the controller that can’t be is named');
    assert.deepEqual(s.writes, ['RIO off', 'Master off']);
    // Its address would have held the switch up for the 3 seconds this rig waits on a silent controller.
    assert.ok(elapsed < 1000, 'The switch didn’t wait on the silent controller: ' + Math.round(elapsed) + ' ms');
  } finally { await s.close(); }
});

test('a controller whose MQTT is up but whose settings socket is not held gets a short time to answer', async () => {
  const mqtt = await broker();
  const s = await chain({ lookReachMs: 150, control: { session: (definition, changed) => new RcpSession(definition, changed, true, () => createConnection({ host: '127.0.0.1', port: mqtt.port })) } }, { leaf: false });
  try {
    await s.unplugLeaf();
    const began = performance.now();
    const off = await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: false });
    const elapsed = performance.now() - began;
    assert.deepEqual([off.copies, off.unread], [1, [s.downstream]]);
    assert.deepEqual(s.writes, ['RIO off', 'Master off']);
    assert.ok(elapsed >= 140 && elapsed < 1500, 'It was tried for the short time and no longer: ' + Math.round(elapsed) + ' ms');
  } finally { await s.close(); await closeBrokers(); }
});
