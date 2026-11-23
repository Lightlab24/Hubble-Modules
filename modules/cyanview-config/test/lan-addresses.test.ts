import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeController, FakeRemiFleet, fixture, planFor } from './helpers.js';
import { ConfigurationOperations } from '../src/operations.js';
import { normalizeSnapshot } from '../src/normalize.js';
import type { RecordValue } from '../src/model.js';

// Nov 23, 2026: a LAN IP change left RCPs with two LAN1 addresses, the old one and the new one, and Hubble listed
// only one of them. The change added the new address, looked for the controller at it, and only then deleted the
// old one; the look failed ("Controller identity changed", "Controller connection failed") and both stayed.
const lanAddresses = (fake: FakeController) => Object.values(fake.config.IP as RecordValue).filter(row => row.Type === 'LAN').map(row => row.IP).sort();
const lanRow = (fake: FakeController, key: string) => fake.snapshot(fake.config.IP.protected.IP).lans.find(row => row.elementKey === key)!;
// A blank address element as a real RCP reported one on Nov 23, 2026: a WAN by type, with nothing on it.
const blankElement = { DHCP: false, DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: '', Locked: false, NoDelete: false, ReadOnly: false, Type: 'WAN', mask: '' };
function rcp(serial = 'CY-RCP-1-10', base = '10.192.1.10', lan = '10.20.101.200') {
  const fake = new FakeController();
  fake.config.Product = { Serial: serial, Name: 'RCP', MaxCam: 'unlimited' };
  fake.config.IP = {
    wan: { DHCP: false, DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: 'LAN1', Locked: true, NoDelete: true, ReadOnly: false, Type: 'WAN', mask: '' },
    protected: { IP: base, Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: true, NoDelete: true, Locked: true },
    old: { IP: lan, Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
  };
  return fake;
}

test('a LAN IP change rewrites the address the controller has, and never leaves two', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), old = plan.lans.find(row => row.elementKey === 'old')!;
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    // What used to break it: something else answers at the new address once it is set.
    fake.wrongIdentity = true;
    const result = await operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.202/24' }, fields: ['planned'] }, f.signal);
    assert.equal(result.verified, true);
    assert.equal(result.elementKey, 'old', 'the same element, not a new one');
    assert.deepEqual(lanAddresses(fake), ['10.192.1.10', '10.20.101.202']);
    assert.equal(fake.config.IP.old.mask, '24');
    assert.deepEqual(fake.actions, [
      { update: { key: 'old', changes: { mask: '24' } } },
      { update: { key: 'old', changes: { ip: '10.20.101.202' } } },
      { update: { key: 'old', changes: { where: 'etc' } } },
    ], 'only what changed, then the save; nothing made and nothing deleted');
    const saved = (await f.repository.read(f.signal)).plan;
    assert.equal(saved.lans.find(row => row.id === old.id)!.elementKey, 'old');
    assert.equal(saved.devices[0]!.alias, '10.20.101.202');

    // Sending the address it already has writes nothing.
    fake.actions.length = 0;
    await operations.run({ kind: 'lan', item: { ...old, current: '10.20.101.202/24', operation: 'Replace', planned: '10.20.101.202/24' }, fields: ['planned'] }, f.signal);
    assert.deepEqual(fake.actions, []);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('an address another controller already has is refused before anything is written', async () => {
  const first = rcp('CY-RCP-1-10', '10.192.1.10', '10.20.101.200'), second = rcp('CY-RCP-1-20', '10.192.1.20', '10.20.101.201');
  await first.start(); await second.start();
  const fleet = new FakeRemiFleet([first, second]), f = fixture();
  try {
    const plan = planFor(first), old = plan.lans.find(row => row.elementKey === 'old')!;
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fleet.client);
    first.actions.length = 0; second.actions.length = 0;
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.201/16' }, fields: ['planned'] }, f.signal), /10\.20\.101\.201 is already CY-RCP-1-20’s address, so nothing was changed/);
    const added = { id: 'added', device: plan.devices[0]!.id, type: 'LAN', iface: 'LAN1', current: '', planned: '10.20.101.201/16', operation: 'Add', pending: true };
    await assert.rejects(() => operations.run({ kind: 'lan', item: added, fields: ['planned'] }, f.signal), /already CY-RCP-1-20’s address/);
    assert.deepEqual(first.actions, []);
    assert.deepEqual(second.actions, []);
    assert.deepEqual(lanAddresses(first), ['10.192.1.10', '10.20.101.200']);
    // An address already on this controller as another row is refused too.
    first.config.IP.extra = { IP: '10.20.101.240', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true };
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.240/16' }, fields: ['planned'] }, f.signal), /already on CY-RCP-1-10 as another address/);
    assert.deepEqual(first.actions, []);
  } finally { await f.instance.dispose(); await first.close(); await second.close(); }
});

test('an address change goes over the base address, even when Hubble last reached the controller by an address that has gone', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), old = plan.lans.find(row => row.elementKey === 'old')!;
    // Someone removed this address on the controller's own page, and Hubble still has it as the way in.
    plan.devices[0]!.address = '10.20.101.77';
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    fake.origins.length = 0;
    await operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.202/16' }, fields: ['planned'] }, f.signal);
    assert.ok(fake.origins.every(origin => origin === 'http://10.192.1.10'), 'everything went over the base address: ' + fake.origins.join());
    assert.deepEqual(lanAddresses(fake), ['10.192.1.10', '10.20.101.202']);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a controller reached only by the address being changed is found again at the new one', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    // Its base address doesn't answer from here, so the socket is on the address that is about to change.
    fake.config.IP.protected.IP = '10.192.9.9';
    const plan = planFor(fake), old = plan.lans.find(row => row.elementKey === 'old')!;
    plan.devices[0]!.address = '10.20.101.200';
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    const result = await operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.202/16' }, fields: ['planned'] }, f.signal);
    assert.equal(result.verified, true);
    assert.equal(fake.config.IP.old.IP, '10.20.101.202');
    assert.equal(fake.actions.filter(action => action.new || action.delete).length, 0);
    assert.equal(fake.actions.at(-1)!.update.changes.where, 'etc', 'the save still reached it, over the new address');
    assert.equal((await f.repository.read(f.signal)).plan.devices[0]!.address, '10.20.101.202', 'and it is reached there from now on');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a LAN address is removed from the controller, and its own addresses can’t be', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    fake.config.IP.second = { IP: '10.20.101.240', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true };
    const plan = planFor(fake), device = plan.devices[0]!.id;
    plan.devices[0]!.address = '10.20.101.200';
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    const old = plan.lans.find(row => row.elementKey === 'old')!;
    const result = await operations.run({ kind: 'lan', item: { ...old, operation: 'Delete', planned: '' }, fields: ['planned'] }, f.signal);
    assert.equal(result.deleted, true);
    assert.deepEqual(fake.actions, [{ delete: ['old'] }]);
    assert.deepEqual(lanAddresses(fake), ['10.192.1.10', '10.20.101.240']);
    const saved = (await f.repository.read(f.signal)).plan;
    assert.deepEqual(saved.lans.map(row => row.elementKey).sort(), ['protected', 'second', 'wan']);
    assert.equal(saved.devices[0]!.address, '10.192.1.10', 'the address Hubble reached it by is gone, so it is reached by its base');
    assert.equal(saved.devices[0]!.alias, '10.20.101.240');

    fake.actions.length = 0;
    for (const key of ['protected', 'wan']) {
      const row = saved.lans.find(row => row.elementKey === key)!;
      await assert.rejects(() => operations.run({ kind: 'lan', item: { ...row, type: 'LAN', operation: 'Delete', planned: '' }, fields: ['planned'] }, f.signal), /own and can’t be removed/);
    }
    assert.deepEqual(fake.actions, []);
    // An address that was only planned, and one that has already gone from the controller, just leave the list.
    const planned = { id: 'planned-only', device, type: 'LAN', iface: 'LAN1', current: '', planned: '', operation: 'Delete', pending: true };
    assert.equal((await operations.run({ kind: 'lan', item: planned, fields: ['planned'] }, f.signal)).deleted, true);
    assert.deepEqual(fake.actions, []);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('the address Hubble reaches a controller by isn’t removed when its base address doesn’t answer', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    fake.config.IP.protected.IP = '10.192.9.9';
    const plan = planFor(fake), old = plan.lans.find(row => row.elementKey === 'old')!;
    plan.devices[0]!.address = '10.20.101.200';
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...old, operation: 'Delete', planned: '' }, fields: ['planned'] }, f.signal), /reaches CY-RCP-1-10 through 10\.20\.101\.200 and its base address doesn’t answer/);
    assert.equal(fake.actions.length, 0);
    assert.equal(fake.config.IP.old.IP, '10.20.101.200');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a new address that can’t be finished is taken off again, and sending it again makes it', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    const added = { id: 'added', device, type: 'LAN', iface: 'LAN1', current: '', planned: '10.20.101.250/16', operation: 'Add', pending: true };
    plan.lans.push(added); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    fake.failProperty = 'ip';
    await assert.rejects(() => operations.run({ kind: 'lan', item: added, fields: ['planned'] }, f.signal), /rejected/);
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['old', 'protected', 'wan'], 'nothing half-made is left');
    const kept = (await f.repository.read(f.signal)).plan.lans.find(row => row.id === 'added')!;
    assert.ok(!kept.elementKey && !kept.createState, 'and the row holds nothing of it');
    fake.failProperty = '';
    const result = await operations.run({ kind: 'lan', item: added, fields: ['planned'] }, f.signal);
    assert.equal(fake.config.IP[result.elementKey].IP, '10.20.101.250');
    assert.equal(fake.actions.filter(action => action.new).length, 2);
    assert.equal(Object.keys(fake.config.IP).length, 4);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('an address this row started that has gone from the controller is made again, not refused', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake), device = plan.devices[0]!.id;
    // The row remembers an element someone has since deleted on the controller's own page.
    const added = { id: 'added', device, type: 'LAN', iface: 'LAN1', current: '', planned: '10.20.101.250/16', operation: 'Add', pending: true, elementKey: 'gone' };
    plan.lans.push(added); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    const result = await operations.run({ kind: 'lan', item: added, fields: ['planned'] }, f.signal);
    assert.notEqual(result.elementKey, 'gone');
    assert.equal(fake.config.IP[result.elementKey].IP, '10.20.101.250');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a blank address element is listed apart from the WAN, never written to, and goes in a clear or by itself', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    // Listed before the real WAN, since a controller lists its rows in no fixed order.
    fake.config.IP = { leftover: { ...blankElement }, ...fake.config.IP };
    const snapshot = normalizeSnapshot(fake.config, '10.192.1.10');
    const leftover = snapshot.lans.find(row => row.elementKey === 'leftover')!;
    assert.equal(leftover.type, 'LAN'); assert.equal(leftover.blank, true); assert.equal(leftover.current, '');
    assert.deepEqual(snapshot.lans.filter(row => row.type === 'WAN').map(row => row.elementKey), ['wan']);
    assert.equal(snapshot.lans.find(row => row.elementKey === 'wan')!.blank, false);
    assert.equal(snapshot.device.alias, '10.20.101.200');

    const plan = planFor(fake); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    // An address written to it would make a second WAN, so it can only be removed.
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...leftover, operation: 'Add', planned: '10.20.101.230/16' }, fields: ['planned'] }, f.signal), /can only be removed/);
    assert.equal(fake.actions.length, 0);

    // A clear takes a blank one with the LAN addresses, and leaves the real WAN in place.
    const cleared = await operations.clearNetwork({ device: plan.devices[0]!.id }, f.signal);
    assert.equal(cleared.deleted, 2);
    assert.deepEqual(fake.actions.filter(action => action.delete).map(action => action.delete[0]).sort(), ['leftover', 'old']);
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);

    // And one can be removed by itself.
    fake.config.IP.again = { ...blankElement };
    const row = lanRow(fake, 'again');
    assert.equal((await operations.run({ kind: 'lan', item: { ...row, operation: 'Delete', planned: '' }, fields: ['planned'] }, f.signal)).deleted, true);
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a row left mid-change by an older version changes in place too, and the address it left behind is listed', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    // What 0.1.107 and earlier left after "Controller identity changed": the old address, a second one, and the row pointing at it.
    fake.config.IP.halfway = { IP: '10.20.101.201', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false };
    const plan = planFor(fake);
    plan.lans = plan.lans.filter(row => row.elementKey !== 'halfway');
    const old = plan.lans.find(row => row.elementKey === 'old')!;
    Object.assign(old, { newElementKey: 'halfway', operation: 'Replace', planned: '10.20.101.205/16', pending: true });
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    assert.deepEqual(fake.snapshot().lans.filter(row => row.type === 'LAN' && !row.readOnly).map(row => row.current).sort(), ['10.20.101.200/16', '10.20.101.201/16'], 'a read lists both');
    const result = await operations.run({ kind: 'lan', item: old, fields: ['planned'] }, f.signal);
    assert.equal(result.elementKey, 'old');
    assert.equal(fake.config.IP.old.IP, '10.20.101.205');
    assert.equal(fake.config.IP.halfway.IP, '10.20.101.201', 'the one left behind is untouched, to be removed by hand');
    assert.equal((await f.repository.read(f.signal)).plan.lans.find(row => row.id === old.id)!.newElementKey, null);
  } finally { await f.instance.dispose(); await fake.close(); }
});
