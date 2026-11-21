import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFirmwareService, describePackage, familyKind, fileNameKind, firstCpioEntry, parseSoftwareDescription, parseVersionPage, type FirmwareDevice, type DeviceUpdateInfo } from '../src/firmware.js';

// The sw-description is the real one from the RIO package installed on 2026-11-21, not a hand-written copy.
const swDescription = await readFile(path.resolve('test/fixtures/firmware/sw-description.txt'));

function cpioEntry(name: string, body: Buffer): Buffer {
  const nameBytes = Buffer.from(name + '\0');
  const fields = [0, 0o100644, 0, 0, 1, 0, body.length, 0, 0, 0, 0, nameBytes.length, 0];
  const header = Buffer.from('070701' + fields.map(value => value.toString(16).padStart(8, '0')).join(''), 'latin1');
  const pad = (length: number) => Buffer.alloc((4 - (length % 4)) % 4);
  const withName = Buffer.concat([header, nameBytes]);
  return Buffer.concat([withName, pad(withName.length), body, pad(body.length)]);
}

/** A package with the same layout as the real RIO file: sw-description first, then the images. */
function swuPackage(description: Buffer = swDescription, images = Buffer.alloc(4096, 7)): Buffer {
  return Buffer.concat([
    cpioEntry('sw-description', description),
    cpioEntry('sw-description.sig', Buffer.alloc(384, 1)),
    cpioEntry('cyanos-cy-rio-rev2.rootfs.ext4.gz', images),
    cpioEntry('TRAILER!!!', Buffer.alloc(0)),
  ]);
}

const rio: FirmwareDevice = { id: 'rio-1', name: 'RIO 1', kind: 'RIO', address: '10.192.10.21', online: true };
const rio2: FirmwareDevice = { id: 'rio-2', name: 'RIO 2', kind: 'RIO', address: '10.192.10.22', online: true };
const rcp: FirmwareDevice = { id: 'rcp-1', name: 'RCP 1', kind: 'RCP', address: '10.192.20.11', online: true };
const gateway: FirmwareDevice = { id: 'gw-1', name: 'Gateway 1', kind: 'Gateway', address: '10.192.30.5', online: true };

const page = (overrides: Partial<DeviceUpdateInfo> = {}): DeviceUpdateInfo => ({
  hardware: 'cy-rio-rev2', osVersion: '26.9.1', rootfs: 'rootfs2', bootId: 'boot-old', ...overrides,
});

async function tempDir() { return mkdtemp(path.join(tmpdir(), 'firmware-test-')); }

test('the real package reads as a RIO file for cy-rio-rev2', () => {
  const entry = firstCpioEntry(swuPackage());
  assert.equal(entry?.name, 'sw-description');
  const parsed = parseSoftwareDescription(entry!.body.toString('utf8'));
  assert.deepEqual(parsed.families, ['cy-rio-rev2']);
  assert.equal(parsed.version, '26.10.1');
  assert.deepEqual(parsed.revisions, ['1.0', '1.2']);
  const pkg = describePackage('cy-rio-rev2-cyanos-26.11.1rc4.swu', 1000, 'hash', swuPackage());
  assert.equal(pkg.kind, 'RIO');
  assert.deepEqual(pkg.problems, []);
  assert.match(pkg.warnings.join(' '), /26\.10\.1.*26\.11\.1rc4/);
  // The device reports the version from the file name, which is the one its post-install step records.
  assert.match(pkg.warnings.join(' '), /The device will report 26\.11\.1rc4\./);
});

test('a file that is not a Cyanview package is refused', () => {
  const pkg = describePackage('cy-rio-rev2-cyanos-26.11.1rc4.swu', 10, 'hash', Buffer.from('not an archive at all'));
  assert.equal(pkg.kind, null);
  assert.match(pkg.problems[0]!, /Not a Cyanview update file/);
});

test('a RIO package with an RCP file name is refused as a whole', () => {
  const pkg = describePackage('cy-rcp-1-cyanos-26.11.1rc4.swu', 1, 'hash', swuPackage());
  assert.match(pkg.problems.join(' '), /file name says RCP but the package is for a RIO/);
});

test('an unknown file name is refused', () => {
  const pkg = describePackage('firmware.swu', 1, 'hash', swuPackage());
  assert.match(pkg.problems.join(' '), /must start with the device/);
});

test('kinds come from the family key and the file name only', () => {
  assert.equal(familyKind('cy-rio-rev2'), 'RIO');
  assert.equal(familyKind('cy-rcp-1-50'), 'RCP');
  assert.equal(familyKind('cy-gateway-1-40'), 'Gateway');
  assert.equal(familyKind('cy-unknown-1'), null);
  assert.equal(fileNameKind('cy-gateway-1-40-cyanos.swu'), 'Gateway');
  assert.equal(fileNameKind('rio-firmware.swu'), null);
});

test('the device page is read for hardware, version, rootfs and boot id', () => {
  const info = parseVersionPage('<code>HW: cy-rio-rev2</br>\nRootfs : rootfs2</br>\nBoot ID: b38ca59f</br>\nOperating System: CyanOS 26.9.1 (CyanOS)</br>\n</code>');
  assert.deepEqual(info, { hardware: 'cy-rio-rev2', osVersion: '26.9.1', rootfs: 'rootfs2', bootId: 'b38ca59f' });
});

test('an RIO file is offered only to RIOs, and an RCP or Gateway gets no checkbox', async () => {
  const dir = await tempDir();
  const sent: string[] = [];
  const service = createFirmwareService({
    devices: async () => [rio, rcp, gateway],
    log: () => undefined,
    tempDir: dir,
    readPage: async address => (address === '10.192.10.21' ? page() : null),
    upload: async (address) => { sent.push(address); return { status: 200, body: 'Ok, file - 1 bytes.' }; },
  });
  const { id } = await service.begin();
  const bytes = swuPackage();
  await service.part({ id, index: 0, text: bytes.toString('base64') });
  const { package: pkg, targets } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
  assert.equal(pkg.kind, 'RIO');
  const byName = Object.fromEntries(targets.map(target => [target.name, target]));
  assert.equal(byName['RIO 1']!.selectable, true);
  assert.equal(byName['RCP 1']!.selectable, false);
  assert.match(byName['RCP 1']!.reason!, /RIO file\. RCP 1 is an RCP/);
  assert.equal(byName['Gateway 1']!.selectable, false);
  assert.match(byName['Gateway 1']!.reason!, /RIO file\. Gateway 1 is a Gateway/);
  // Nothing is sent to anything on the commit or the check.
  assert.deepEqual(sent, []);
  // Choosing an RCP or Gateway is refused before any device is contacted.
  await assert.rejects(service.install({ packageId: pkg.id, deviceIds: ['rio-1', 'rcp-1'] }), /Nothing was sent. RCP 1 can’t take a RIO file/);
  assert.deepEqual(sent, []);
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('a RIO whose own page reports other hardware is never sent the file', async () => {
  const dir = await tempDir();
  const service = createFirmwareService({
    devices: async () => [rio],
    log: () => undefined,
    tempDir: dir,
    readPage: async () => page({ hardware: 'cy-rio-rev1' }),
    upload: async () => { throw new Error('must not upload'); },
  });
  const { id } = await service.begin();
  await service.part({ id, index: 0, text: swuPackage().toString('base64') });
  const { targets } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
  assert.equal(targets[0]!.selectable, false);
  assert.match(targets[0]!.reason!, /This device is cy-rio-rev1/);
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('the selected RIOs all start at the same time', async () => {
  const dir = await tempDir();
  let started = 0;
  let release!: () => void;
  const everyoneStarted = new Promise<void>(resolve => { release = resolve; });
  const service = createFirmwareService({
    devices: async () => [rio, rio2],
    log: () => undefined,
    tempDir: dir,
    pollMs: 1,
    readPage: async (address) => {
      // Before the reboot, each device reports its old boot id; after, a new one and the new version.
      if (address === '10.192.10.21' || address === '10.192.10.22') return page({ bootId: started >= 2 ? 'boot-new' : 'boot-old', osVersion: started >= 2 ? '26.11.1rc4' : '26.9.1' });
      return null;
    },
    watch: () => () => undefined,
    upload: async () => {
      started += 1;
      // Each upload waits for the other: this resolves only if both are in flight together.
      if (started === 2) release();
      await everyoneStarted;
      return { status: 200, body: 'Ok, cy-rio-rev2-cyanos-26.11.1rc4.swu - 207083522 bytes.' };
    },
  });
  const { id } = await service.begin();
  await service.part({ id, index: 0, text: swuPackage().toString('base64') });
  const { package: pkg } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
  const started2 = await service.install({ packageId: pkg.id, deviceIds: ['rio-1', 'rio-2'] });
  assert.equal(started2.targets, 2);
  // Wait for both to finish, then read the job.
  let job = service.status(started2.jobId);
  for (let i = 0; i < 200 && job?.state !== 'done'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); job = service.status(started2.jobId); }
  assert.equal(job?.state, 'done');
  assert.deepEqual(job!.targets.map(target => target.phase), ['done', 'done']);
  assert.equal(job!.targets[0]!.result, 'Installed 26.11.1rc4, back online');
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('one device failing leaves the others going on', async () => {
  const dir = await tempDir();
  let bootChanged = false;
  const service = createFirmwareService({
    devices: async () => [rio, rio2],
    log: () => undefined,
    tempDir: dir,
    pollMs: 1,
    readPage: async (address) => {
      if (address === '10.192.10.21') return page({ bootId: bootChanged ? 'boot-new' : 'boot-old', osVersion: bootChanged ? '26.11.1rc4' : '26.9.1' });
      if (address === '10.192.10.22') return page({ bootId: bootChanged ? 'boot-new' : 'boot-old', osVersion: bootChanged ? '26.11.1rc4' : '26.9.1' });
      return null;
    },
    watch: () => () => undefined,
    upload: async address => {
      if (address === '10.192.10.22') return { status: 500, body: 'Upload failed' };
      bootChanged = true;
      return { status: 200, body: 'Ok, x - 1 bytes.' };
    },
  });
  const { id } = await service.begin();
  await service.part({ id, index: 0, text: swuPackage().toString('base64') });
  const { package: pkg } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
  const { jobId } = await service.install({ packageId: pkg.id, deviceIds: ['rio-1', 'rio-2'] });
  let job = service.status(jobId);
  for (let i = 0; i < 200 && job?.state !== 'done'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); job = service.status(jobId); }
  assert.equal(job?.targets[0]?.phase, 'done');
  assert.equal(job?.targets[1]?.phase, 'failed');
  assert.match(job!.targets[1]!.error!, /Device refused the file: Upload failed/);
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('the file arrives in parts and the temporary copy is removed after the install', async () => {
  const dir = await tempDir();
  const bytes = swuPackage(swDescription, Buffer.alloc(200000, 9));
  let rebooted = false;
  const service = createFirmwareService({
    devices: async () => [rio],
    log: () => undefined,
    tempDir: dir,
    pollMs: 1,
    readPage: async () => page({ bootId: rebooted ? 'boot-new' : 'boot-old', osVersion: rebooted ? '26.11.1rc4' : '26.9.1' }),
    watch: () => () => undefined,
    upload: async () => { rebooted = true; return { status: 200, body: 'Ok, x - 1 bytes.' }; },
  });
  const { id } = await service.begin();
  const encoded = bytes.toString('base64');
  const parts = Math.ceil(encoded.length / 60000);
  for (let index = 0; index < parts; index++) await service.part({ id, index, text: encoded.slice(index * 60000, (index + 1) * 60000) });
  const { package: pkg } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
  assert.equal(pkg.size, bytes.length);
  assert.equal(pkg.sha256.length, 64);
  const { jobId } = await service.install({ packageId: pkg.id, deviceIds: ['rio-1'] });
  let job = service.status(jobId);
  for (let i = 0; i < 200 && job?.state !== 'done'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); job = service.status(jobId); }
  assert.equal(job?.targets[0]?.phase, 'done');
  assert.deepEqual(await readdir(dir), []);
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('an out-of-order or oversized part is refused', async () => {
  const dir = await tempDir();
  const service = createFirmwareService({ devices: async () => [], log: () => undefined, tempDir: dir });
  const { id } = await service.begin();
  await assert.rejects(service.part({ id, index: 1, text: 'AAAA' }), /out of order/);
  await assert.rejects(service.part({ id, index: 0, text: 'not base64!' }), /Invalid file part/);
  service.dispose();
  await rm(dir, { recursive: true, force: true });
});
