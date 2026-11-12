import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeController, FakeRemiFleet, fixture } from './helpers.js';
import type { RecordValue } from '../src/model.js';

// A RIO camera copied to a Master RCP, and the Master's copy copied on to a downstream RCP.
async function chain(live = false) {
  const rio = new FakeController(), master = new FakeController(), leaf = new FakeController();
  const devices = [rio, master, leaf], addresses = ['10.192.1.10', '10.192.1.20', '10.192.1.30'], names = ['RIO', 'Master', 'Leaf'];
  for (const [index, device] of devices.entries()) {
    device.config.IP.protected.IP = addresses[index];
    device.config.IP.old.IP = '10.20.101.' + (200 + index);
    if (index) device.config.Product = { Serial: 'CY-RCP-1-' + (10 + index * 10), Name: 'RCP', MaxCam: 'unlimited' };
  }
  rio.config.Camera.original = { Number: '1', Name: 'Wide', Model: 'Sony - Venice-IP', IP: '10.20.20.1', Port: '80', Enabled: '1' };
  rio.config.Camera.other = { Number: '2', Name: 'Close', Model: 'Sony - Venice-IP', IP: '10.20.20.2', Port: '80', Enabled: '1' };
  const fleet = new FakeRemiFleet(devices);
  await Promise.all(devices.map(device => device.start()));
  // Every Enabled write, in the order the controllers received them.
  const writes: string[] = [];
  for (const [index, device] of devices.entries()) device.onAction = (request: RecordValue) => {
    const value = request.update?.changes?.enabled;
    if (value !== undefined) writes.push(names[index] + ' ' + (value === '1' ? 'on' : 'off'));
  };
  const session = fixture({}, { client: fleet.client, cameraEnabled: { holdMs: 20, onlineWaitMs: 30 }, ...(live ? { liveConfig: { retryMs: [20, 40], settleMs: 10, connectMs: 500 } } : {}) });
  await session.instance.start();
  const snapshots = devices.map((device, index) => device.snapshot(addresses[index]));
  const [source, receiver, downstream] = snapshots.map(snapshot => String(snapshot.device.id)) as [string, string, string];
  await session.call('save-plan', { revision: null, plan: { formatVersion: 1, devices: snapshots.map(snapshot => snapshot.device), cameras: snapshots.flatMap(snapshot => snapshot.cameras), lans: [], uiState: null } });
  const added = await session.call('remi-send', { receiver, items: [{ id: 'original', kind: 'camera', source, key: 'original', enable: true, address: '10.20.101.200' }] });
  assert.equal(added.results[0].verified, true);
  const masterCopy = Object.keys(master.config.Camera)[0]!;
  const attached = await session.call('remi-send', { receiver: downstream, items: [{ id: masterCopy, kind: 'camera', source: receiver, key: masterCopy, enable: true }] });
  assert.equal(attached.results[0].verified, true);
  const leafCopy = Object.keys(leaf.config.Camera)[0]!;
  writes.length = 0;
  const enabled = () => [rio.config.Camera.original.Enabled, master.config.Camera[masterCopy].Enabled, leaf.config.Camera[leafCopy].Enabled].join('');
  const close = async () => { await session.instance.dispose(); await Promise.all(devices.map(device => device.close())); };
  return { rio, master, leaf, session, source, receiver, downstream, masterCopy, leafCopy, writes, enabled, close };
}
async function waitFor(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await delay(5);
  assert.ok(condition(), what);
}

test('a refresh switches the camera off and on, then each copy down the chain, nearest first', async () => {
  const s = await chain();
  try {
    const result = await s.session.call('camera-refresh', { device: s.source, key: 'original' });
    assert.equal(result.copies, 2);
    assert.deepEqual(result.unread, []);
    assert.deepEqual(s.writes, ['RIO off', 'RIO on', 'Master off', 'Master on', 'Leaf off', 'Leaf on']);
    assert.equal(s.enabled(), '111');
    assert.equal(s.rio.config.Camera.other.Enabled, '1', 'Other cameras are left alone');
    // Each row reads the controller's own Enabled.
    const read = await s.session.call('refresh');
    const rows = read.snapshots.flatMap((snapshot: RecordValue) => snapshot.cameras);
    assert.ok(rows.length >= 4 && rows.every((row: RecordValue) => row.cameraEnabled === true));
  } finally { await s.close(); }
});

test('switching a camera off takes its copies off, furthest first, and on brings each back', async () => {
  const s = await chain();
  try {
    await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: false });
    assert.deepEqual(s.writes, ['RIO off', 'Leaf off', 'Master off']);
    assert.equal(s.enabled(), '000');
    s.writes.length = 0;
    await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: true });
    // The copies were already off, so each only needs switching on, in chain order.
    assert.deepEqual(s.writes, ['RIO on', 'Master on', 'Leaf on']);
    assert.equal(s.enabled(), '111');
    // Switching on a camera that is already on still brings its copies back, which is what unsticks them.
    s.writes.length = 0;
    await s.session.call('camera-enabled', { device: s.source, key: 'original', enabled: true });
    assert.deepEqual(s.writes, ['Master off', 'Master on', 'Leaf off', 'Leaf on']);
  } finally { await s.close(); }
});

test('refreshing a copy refreshes it and the copies made from it, never its source', async () => {
  const s = await chain();
  try {
    const result = await s.session.call('camera-refresh', { device: s.receiver, key: s.masterCopy });
    assert.equal(result.copies, 1);
    assert.deepEqual(s.writes, ['Master off', 'Master on', 'Leaf off', 'Leaf on']);
    assert.equal(s.enabled(), '111');
  } finally { await s.close(); }
});

test('a camera switched off and on outside Hubble takes its copies with it, without echoing Hubble\'s own writes', async () => {
  const s = await chain(true);
  try {
    // Every controller's settings socket is open before Cyanview's own page changes anything.
    await waitFor(() => s.rio.sockets.size >= 1 && s.master.sockets.size >= 1 && s.leaf.sockets.size >= 1, 'Settings sockets are open');
    await delay(60);
    s.rio.config.Camera.original.Enabled = '0'; s.rio.broadcast();
    await waitFor(() => s.enabled() === '000', 'The copies followed the source off');
    assert.deepEqual(s.writes, ['Leaf off', 'Master off']);
    s.writes.length = 0;
    s.rio.config.Camera.original.Enabled = '1'; s.rio.broadcast();
    await waitFor(() => s.enabled() === '111', 'The copies followed the source on');
    assert.deepEqual(s.writes, ['Master on', 'Leaf on']);
    // Hubble's own writes come back from the controllers too. They mustn't start more work.
    await delay(150);
    assert.deepEqual(s.writes, ['Master on', 'Leaf on']);
    const log = JSON.stringify(s.session.traces);
    assert.match(log, /switched off outside Hubble, so its 2 copies were switched off/);
    assert.match(log, /switched on outside Hubble, so its 2 copies were switched off and on again/);
    assert.doesNotMatch(log, /could not follow/);
  } finally { await s.close(); }
});

test('a controller that refuses the change is named, and sample data sends nothing', async () => {
  const s = await chain();
  try {
    s.master.failProperty = 'enabled';
    await assert.rejects(s.session.call('camera-refresh', { device: s.source, key: 'original' }), /Camera 1 on .*rejected/);
    // The source was already back on before the copy refused.
    assert.equal(s.rio.config.Camera.original.Enabled, '1');
  } finally { await s.close(); }
  const sample = fixture({ sampleData: true });
  try {
    await sample.instance.start();
    await assert.rejects(sample.call('camera-refresh', { device: 'any', key: 'any' }), /Sample data does not send/);
  } finally { await sample.instance.dispose(); }
});
