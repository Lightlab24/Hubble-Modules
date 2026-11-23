import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeController, fixture, planFor } from './helpers.js';
import { ConfigurationOperations } from '../src/operations.js';
import { baseRow, normalizeSnapshot } from '../src/normalize.js';
import type { RecordValue } from '../src/model.js';

// An RCP as Cyanview lists it: its base address ReadOnly and NoDelete, its WAN NoDelete only, and the LAN
// addresses set on it neither (RIO capture Nov 17 and the live workspace Nov 21, 2026). The rows come in no
// fixed order; here the WAN comes first and sits inside 10.192, as one RCP's did on Nov 21, 2026.
function rcp(wan: RecordValue = { DHCP: false, IP: '10.192.77.5', mask: '16', Gateway: '10.192.0.1', DNS1: '10.192.0.2' }) {
  const fake = new FakeController();
  fake.config.Product = { Serial: 'CY-RCP-1-10', Name: 'RCP', MaxCam: 'unlimited' };
  fake.config.IP = {
    wan: { DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: 'LAN1', Locked: true, NoDelete: true, ReadOnly: false, Type: 'WAN', mask: '', ...wan },
    protected: { IP: '10.192.1.10', Interface: 'LAN1', Type: 'Local', mask: '16', ReadOnly: true, NoDelete: true },
    old: { IP: '10.20.101.200', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
    second: { IP: '10.20.101.240', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
    third: { IP: '192.168.10.40', Interface: 'LAN1', Type: 'LAN', mask: '24', ReadOnly: false, NoDelete: false, Locked: true },
  };
  return fake;
}
const rows = (config: RecordValue) => Object.entries(config.IP as RecordValue).map(([key, row]) => ({ key, ...(row as RecordValue) }));

test('the base address is the serial’s own, never a WAN or a LAN address that happens to be in 10.192', () => {
  const fake = rcp();
  const snapshot = normalizeSnapshot(fake.config, '10.192.77.5');
  assert.equal(snapshot.device.base, '10.192.1.10', 'the WAN listed first, NoDelete and inside 10.192, is not the base');
  assert.equal(snapshot.device.alias, '10.20.101.200');
  assert.equal(snapshot.lans.find(row => row.elementKey === 'protected')!.readOnly, true);
  assert.equal(snapshot.lans.find(row => row.elementKey === 'wan')!.readOnly, false);

  // A LAN address put inside 10.192 is still only a LAN address.
  fake.config.IP = { odd: { IP: '10.192.200.5', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false }, ...fake.config.IP };
  assert.equal(normalizeSnapshot(fake.config, '10.192.200.5').device.base, '10.192.1.10');

  // With no serial address to go by, the row the controller marks ReadOnly is the base, and a WAN never is.
  assert.equal(baseRow([{ key: 'w', IP: '10.192.9.9', Type: 'WAN', NoDelete: true, ReadOnly: true }, { key: 'b', IP: '10.192.3.3', Type: 'Local', ReadOnly: true }], 'ODD-SERIAL')?.key, 'b');
  assert.equal(baseRow([{ key: 'w', IP: '10.192.9.9', Type: 'WAN', NoDelete: true }], 'ODD-SERIAL'), undefined);
  // A controller that doesn't mark its base still has it found by its serial.
  assert.equal(baseRow([{ key: 'w', IP: '10.192.1.10', Type: 'WAN', NoDelete: true }, { key: 'b', IP: '10.192.1.10', Type: 'Local' }], 'CY-RCP-1-10')?.key, 'b');
});

test('a LAN address inside 10.192 can be replaced like any other, while the base stays protected', async () => {
  const fake = rcp(); fake.config.IP.old.IP = '10.192.200.5'; await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    const old = plan.lans.find(row => row.elementKey === 'old')!;
    const result = await operations.run({ kind: 'lan', item: { ...old, operation: 'Replace', planned: '10.20.101.201/16' }, fields: ['planned'] }, f.signal);
    assert.equal(result.verified, true);
    assert.equal(fake.config.IP.old.IP, '10.20.101.201', 'the address the controller had is the one that changed');
    const base = plan.lans.find(row => row.elementKey === 'protected')!;
    await assert.rejects(() => operations.run({ kind: 'lan', item: { ...base, operation: 'Replace', planned: '10.20.101.202/16' }, fields: ['planned'] }, f.signal), /protected/);
    assert.equal(fake.config.IP.protected.IP, '10.192.1.10');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('Setup mode deletes every LAN address and leaves the WAN Static with nothing set, all over the base address', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake);
    // Hubble reached it by its LAN address, which is one of those going.
    plan.devices[0]!.address = '10.20.101.200';
    await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client), steps: string[] = [];
    fake.origins.length = 0;
    const result = await operations.clearNetwork({ device: plan.devices[0]!.id }, f.signal, (_id, done, total) => steps.push(done + '/' + total));
    assert.equal(result.deleted, 3);
    assert.equal(result.wan, true);
    assert.deepEqual(steps, ['0/4', '1/4', '2/4', '3/4', '4/4']);
    assert.ok(fake.origins.length && fake.origins.every(origin => origin === 'http://10.192.1.10'), 'everything went over the base address: ' + fake.origins.join());
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);
    assert.deepEqual(fake.config.IP.protected, { IP: '10.192.1.10', Interface: 'LAN1', Type: 'Local', mask: '16', ReadOnly: true, NoDelete: true });
    assert.equal(fake.config.IP.wan.DHCP, false);
    assert.equal(fake.config.IP.wan.IP, '');
    assert.equal(fake.config.IP.wan.mask, '0');
    assert.equal(fake.config.IP.wan.Gateway, '');
    assert.equal(fake.config.IP.wan.DNS1, '');
    assert.deepEqual(fake.actions.filter(action => action.delete).map(action => action.delete[0]).sort(), ['old', 'second', 'third']);

    const saved = (await f.repository.read(f.signal)).plan;
    assert.deepEqual(saved.lans.map(row => row.elementKey).sort(), ['protected', 'wan']);
    assert.equal(saved.lans.find(row => row.elementKey === 'wan')!.current, '');
    assert.equal(saved.devices[0]!.address, '10.192.1.10');
    assert.equal(saved.devices[0]!.alias, '');
    assert.equal(result.snapshot.device.base, '10.192.1.10');
    assert.deepEqual(result.snapshot.lans.map((row: RecordValue) => row.elementKey).sort(), ['protected', 'wan']);

    // A second clear finds nothing to do and sends nothing.
    fake.actions.length = 0;
    const again = await operations.clearNetwork({ device: plan.devices[0]!.id }, f.signal);
    assert.equal(again.deleted, 0);
    assert.equal(again.wan, false);
    assert.equal(fake.actions.length, 0);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a WAN on DHCP is only switched off, and each part of a clear can be left out', async () => {
  const fake = rcp({ DHCP: true, IP: '', mask: '' }); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client);
    await operations.clearNetwork({ device: plan.devices[0]!.id, lans: false }, f.signal);
    assert.deepEqual(fake.actions, [{ update: { changes: { dhcp: 'no' }, key: 'wan' } }]);
    assert.equal(Object.keys(fake.config.IP).length, 5, 'no LAN address was deleted');
    fake.actions.length = 0;
    await operations.clearNetwork({ device: plan.devices[0]!.id, wan: false }, f.signal);
    assert.ok((fake.actions as RecordValue[]).every(action => action.delete), 'only deletes');
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('Setup mode changes nothing on a RIO, or on an RCP whose base address doesn’t answer', async () => {
  const rio = new FakeController(); rio.addWan(); await rio.start();
  const quiet = rcp(); quiet.config.IP.protected.IP = '10.192.9.9'; await quiet.start();
  const f = fixture();
  try {
    const rioPlan = planFor(rio); await f.repository.write(null, rioPlan, f.signal);
    await assert.rejects(() => new ConfigurationOperations(f.repository, rio.client).clearNetwork({ device: rioPlan.devices[0]!.id }, f.signal), /RCPs only/);
    assert.equal(rio.actions.length, 0);

    // CY-RCP-1-10's own address is 10.192.1.10, which this one doesn't answer on.
    const quietPlan = planFor(quiet); quietPlan.devices[0]!.address = '10.20.101.200';
    await f.repository.write((await f.repository.read(f.signal)).revision, quietPlan, f.signal);
    await assert.rejects(() => new ConfigurationOperations(f.repository, quiet.client).clearNetwork({ device: quietPlan.devices[0]!.id }, f.signal), /didn’t answer on its base address 10\.192\.1\.10/);
    assert.equal(quiet.actions.length, 0);
    assert.equal(Object.keys(quiet.config.IP).length, 5);
  } finally { await f.instance.dispose(); await rio.close(); await quiet.close(); }
});

test('a clear waits for a send already working on the same RCP', async () => {
  const fake = rcp(); await fake.start(); const f = fixture();
  try {
    const plan = planFor(fake); await f.repository.write(null, plan, f.signal);
    const operations = new ConfigurationOperations(f.repository, fake.client), order: string[] = [];
    fake.onAction = request => order.push(request.delete ? 'delete' : request.new ? 'new' : 'update');
    const added = { id: 'added', device: plan.devices[0]!.id, type: 'LAN', iface: 'LAN1', current: '', planned: '10.20.101.250/16', operation: 'Add', pending: true };
    const sending = operations.run({ kind: 'lan', item: added, fields: ['planned'] }, f.signal);
    const clearing = operations.clearNetwork({ device: plan.devices[0]!.id }, f.signal);
    await sending; const result = await clearing;
    assert.equal(order[0], 'new', 'the send went first');
    assert.equal(result.deleted, 4, 'and the clear took the address it added too');
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('the page hears how far a clear has got, and the command saves what it cleared', async () => {
  const fake = rcp(); await fake.start();
  const f = fixture({}, { client: fake.client }); await f.instance.start();
  try {
    const plan = planFor(fake); await f.call('save-plan', { revision: null, plan });
    const id = plan.devices[0]!.id, result = await f.call('clear-network', { device: id, lans: true, wan: true });
    assert.equal(result.deleted, 3);
    const steps = f.states.map((state: any) => state.values?.networkClears?.[id]).filter(Boolean).map((step: RecordValue) => step.done + '/' + step.total);
    assert.deepEqual([...new Set(steps)], ['0/4', '1/4', '2/4', '3/4', '4/4']);
    assert.deepEqual((f.states.at(-1) as any).values.networkClears, {}, 'nothing is left showing once it is done');
    assert.deepEqual(Object.keys(fake.config.IP).sort(), ['protected', 'wan']);
  } finally { await f.instance.dispose(); await fake.close(); }
});
