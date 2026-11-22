import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers.js';
import { addressPatternProblem, fillAddress, fillName, firstNumberIn, initialDefaults, numberFromName, validateDefaults } from '../src/defaults-model.js';

// The user's own examples (Nov 21, 2026): the number and the digits beside %number% make three digits.
test('%number% in an address fills its part out to three digits with the digits beside it', () => {
  assert.equal(fillAddress('10.20.100.1%number%', 13).address, '10.20.100.113');
  assert.equal(fillAddress('10.20.101.1%number%', 5).address, '10.20.101.105');
  assert.equal(fillAddress('10.20.101.1%number%', 21).address, '10.20.101.121');
  assert.equal(fillAddress('10.20.101.2%number%', 1).address, '10.20.101.201');
  // A 0 in front gives 021, which is sent as 21: some devices read a leading zero as octal.
  assert.equal(fillAddress('10.20.101.0%number%', 21).address, '10.20.101.21');
  assert.equal(fillAddress('10.20.101.%number%', 1).address, '10.20.101.1');
  assert.equal(fillAddress('10.20.101.%number%', 21).address, '10.20.101.21');
  assert.equal(fillAddress('10.20.%number%.5', 7).address, '10.20.7.5');
  assert.equal(fillAddress('10.20.101.%NUMBER%', 3).address, '10.20.101.3');
  // With no wildcard it is one fixed address.
  assert.equal(fillAddress('10.20.101.200', 4).address, '10.20.101.200');
  assert.deepEqual(fillAddress('', 4), { address: '', problem: '' });
});

test('a number that doesn’t fit, or a pattern that can’t make an address, gives no address and says why', () => {
  assert.deepEqual(fillAddress('10.20.101.1%number%', 123), { address: '', problem: '123 doesn’t fit in 1%number%' });
  assert.deepEqual(fillAddress('10.20.101.2%number%', 60), { address: '', problem: '60 makes 260, past 255' });
  // Two digits beside it leave room for one.
  assert.equal(fillAddress('10.20.101.12%number%', 5).address, '10.20.101.125');
  assert.deepEqual(fillAddress('10.20.101.12%number%', 13), { address: '', problem: '13 doesn’t fit in 12%number%' });
  assert.equal(addressPatternProblem('10.20.101.1%number%'), '');
  assert.equal(addressPatternProblem(''), '');
  assert.equal(addressPatternProblem('10.20.%number%.1%number%'), 'Use %number% once in an address');
  assert.equal(addressPatternProblem('10.20.1%number%'), 'An address has four parts, such as 10.20.101.1%number%');
  assert.equal(addressPatternProblem('10.20.101.123%number%'), 'Put at most two digits beside %number% in an address');
  assert.equal(addressPatternProblem('10.20.300.1%number%'), 'Each part of an address is a number from 0 to 255');
  assert.equal(addressPatternProblem('10.20.101.x%number%'), 'Put at most two digits beside %number% in an address');
});

test('names fill %number% and %type%, and a name made from a pattern gives its number back', () => {
  assert.equal(fillName('Cam %number%', { number: 14 }), 'Cam 14');
  assert.equal(fillName('%type% %number%', { number: 14, type: 'BUR' }), 'BUR 14');
  assert.equal(fillName('CAM %number% %type%', { number: 3, type: 'V2' }), 'CAM 3 V2');
  // An empty type leaves no stray space.
  assert.equal(fillName('%type% %number%', { number: 2, type: '' }), '2');
  assert.equal(numberFromName('Cam %number%', 'Cam 20'), 20);
  assert.equal(numberFromName('Cam %number%', 'cam  7'), 7);
  assert.equal(numberFromName('Cam %number%', 'Cam 6 Tally'), null);
  assert.equal(numberFromName('%type% - %number%', 'BUR - 12'), 12);
  assert.equal(numberFromName('Gateway', 'Gateway'), null);
  assert.equal(numberFromName('Cam %number%', 'Cam 0'), null);
  assert.equal(firstNumberIn('Cam 6 Tally'), 6);
  assert.equal(firstNumberIn('Gateway'), null);
});

test('saved defaults are checked, and a workspace saved before them starts from the user’s own standard', () => {
  assert.equal(validateDefaults(undefined), undefined);
  assert.deepEqual(validateDefaults(initialDefaults()), initialDefaults());
  const changed = initialDefaults();
  changed.devices.RIO = { name: 'RIO %number%', lan: '10.20.102.1%number%', mask: '24' };
  changed.camera.rioNumber = false;
  assert.deepEqual(validateDefaults(JSON.parse(JSON.stringify(changed))), changed);
  assert.throws(() => validateDefaults({ ...initialDefaults(), devices: { RCP: initialDefaults().devices.RCP } }), /Invalid defaults/);
  assert.throws(() => validateDefaults({ ...initialDefaults(), camera: { ...initialDefaults().camera, rioNumber: 'yes' } }), /Invalid defaults/);
  const badMask = initialDefaults();
  badMask.devices.RCP.mask = '40';
  assert.throws(() => validateDefaults(badMask), /Invalid defaults/);
  assert.equal(initialDefaults().devices.RIO.lan, '10.20.101.1%number%');
});

test('defaults, each camera model’s type and address, and device numbers are kept with the workspace', async () => {
  const f = fixture({});
  try {
    await f.instance.start();
    const defaults = initialDefaults();
    defaults.devices.Gateway.lan = '10.20.101.20%number%';
    defaults.camera.name = 'CAM %number% %type%';
    const plan = {
      formatVersion: 1, uiState: null, cameras: [], lans: [], defaults,
      devices: [{ id: 'CY-RIO-1-10', serial: 'CY-RIO-1-10', name: 'Cam 14', kind: 'RIO', number: 14, base: '10.192.1.10', address: '10.192.1.10' }],
      cameraLogins: [{ model: 'Burano', login: 'admin', password: 'Burano2026', type: 'BUR', ip: '10.20.100.0%number%' }, { model: 'FX6', login: '', password: '', type: 'FX6' }],
    };
    const saved: any = await f.call('save-plan', { revision: null, plan });
    const read: any = await f.call('read-plan');
    assert.deepEqual(read.plan.defaults, defaults);
    assert.deepEqual(read.plan.cameraLogins, plan.cameraLogins);
    assert.equal(read.plan.devices[0].number, 14);
    // Defaults that don't check out are refused rather than saved in part.
    await assert.rejects(f.call('save-plan', { revision: saved.revision, plan: { ...plan, defaults: { ...defaults, camera: { ...defaults.camera, name: 'x'.repeat(161) } } } }), /Invalid defaults/);
    await assert.rejects(f.call('save-plan', { revision: saved.revision, plan: { ...plan, cameraLogins: [{ model: 'Burano', login: '', password: '', type: 'x'.repeat(161) }] } }), /Invalid camera logins/);
    // A plan saved before Defaults existed reads without them.
    const older: any = await f.call('save-plan', { revision: saved.revision, plan: { ...plan, defaults: undefined } });
    assert.ok(older.revision);
    assert.equal((await f.call('read-plan') as any).plan.defaults, undefined);
  } finally { await f.instance.dispose(); }
});
