import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { createFirmwareService, type FirmwareDevice } from '../src/firmware.js';

// A stand-in for a RIO's System Update page that speaks the same HTTP and WebSocket traffic the real capture showed:
// version.html for identity, a multipart POST to /upload that answers "Ok, …", and step messages on /ws.
// The network code under test (multipart framing, the page reader and the progress socket) runs for real.
const swDescription = await readFile(path.resolve('test/fixtures/firmware/sw-description.txt'));

function cpioEntry(name: string, body: Buffer): Buffer {
  const nameBytes = Buffer.from(name + '\0');
  const fields = [0, 0o100644, 0, 0, 1, 0, body.length, 0, 0, 0, 0, nameBytes.length, 0];
  const header = Buffer.from('070701' + fields.map(value => value.toString(16).padStart(8, '0')).join(''), 'latin1');
  const pad = (length: number) => Buffer.alloc((4 - (length % 4)) % 4);
  const withName = Buffer.concat([header, nameBytes]);
  return Buffer.concat([withName, pad(withName.length), body, pad(body.length)]);
}

const packageBytes = Buffer.concat([
  cpioEntry('sw-description', swDescription),
  cpioEntry('sw-description.sig', Buffer.alloc(384, 1)),
  cpioEntry('cyanos-cy-rio-rev2.rootfs.ext4.gz', Buffer.from(Array.from({ length: 900_000 }, (_, i) => (i * 31) & 0xff))),
  cpioEntry('TRAILER!!!', Buffer.alloc(0)),
]);
const packageSha = createHash('sha256').update(packageBytes).digest('hex');

interface FakeRio {
  url: string;
  port: number;
  uploads: { bytes: number; sha256: string; contentLength: number; fileName: string }[];
  requests: number;
  close(): Promise<void>;
}

async function fakeRio(options: { reject?: boolean } = {}): Promise<FakeRio> {
  let installed = false;
  const uploads: FakeRio['uploads'] = [];
  let requests = 0;
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const sendAll = (message: object) => { for (const socket of sockets) socket.send(JSON.stringify(message)); };
  const page = () => [
    '<!doctype html>', '<code>', 'HW: cy-rio-rev2</br>', 'Rootfs : ' + (installed ? 'rootfs1' : 'rootfs2') + '</br>',
    'Boot ID: ' + (installed ? 'd3d7ca39' : 'b38ca59f') + '</br>',
    'Operating System: CyanOS ' + (installed ? '26.11.1rc4' : '26.9.1') + ' (CyanOS)</br>', '</code>',
  ].join('\n');
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests += 1;
    if (request.method === 'GET' && request.url === '/version.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page());
      return;
    }
    if (request.method === 'POST' && request.url === '/upload') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk as Buffer));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const boundary = /boundary=(.+)$/.exec(String(request.headers['content-type']))?.[1] ?? '';
        const start = body.indexOf('\r\n\r\n') + 4;
        const end = body.lastIndexOf('\r\n--' + boundary);
        const file = body.subarray(start, end);
        const fileName = /filename="([^"]+)"/.exec(body.toString('latin1', 0, start))?.[1] ?? '';
        uploads.push({ bytes: file.length, sha256: createHash('sha256').update(file).digest('hex'), contentLength: Number(request.headers['content-length']), fileName });
        if (options.reject) { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end('Upload failed'); return; }
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('Ok, ' + fileName + ' - ' + file.length + ' bytes.\r\n');
        // Install steps as the device reports them, then a restart onto the other slot.
        setTimeout(() => {
          sendAll({ type: 'message', level: '6', text: 'Software Update started !' });
          for (const percent of ['10', '50', '100']) sendAll({ type: 'step', number: '5', step: '1', name: 'cyanos-cy-rio-rev2.rootfs.ext4.gz', percent });
          sendAll({ type: 'message', level: '6', text: 'SWUPDATE successful !' });
          installed = true;
        }, 20);
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: '127.0.0.1', port, uploads,
    get requests() { return requests; },
    async close() { for (const socket of sockets) socket.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); },
  } as FakeRio;
}

/** The file goes up in the same parts the page sends: at most 60,000 characters each. */
async function sendPackage(service: ReturnType<typeof createFirmwareService>, id: string) {
  const encoded = packageBytes.toString('base64');
  for (let index = 0; index * 60000 < encoded.length; index++) await service.part({ id, index, text: encoded.slice(index * 60000, (index + 1) * 60000) });
}

async function waitForJob(service: ReturnType<typeof createFirmwareService>, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const job = service.status(jobId);
    if (job?.state === 'done') return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The install did not finish');
}

test('a real RIO page takes the file, reports progress and comes back on the new version', async () => {
  const rio = await fakeRio();
  const dir = await mkdtemp(path.join(tmpdir(), 'firmware-device-'));
  const progress: string[] = [];
  const service = createFirmwareService({
    devices: async (): Promise<FirmwareDevice[]> => [{ id: 'rio-1', name: 'RIO 1', kind: 'RIO', address: rio.url, online: true }],
    log: () => undefined,
    port: rio.port,
    tempDir: dir,
    pollMs: 50,
  });
  try {
    const { id } = await service.begin();
    const encoded = packageBytes.toString('base64');
    for (let index = 0; index * 60000 < encoded.length; index++) await service.part({ id, index, text: encoded.slice(index * 60000, (index + 1) * 60000) });
    const { package: pkg, targets } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
    assert.equal(pkg.sha256, packageSha);
    assert.equal(targets[0]!.selectable, true);
    assert.equal(targets[0]!.checked, true);
    assert.equal(targets[0]!.current?.osVersion, '26.9.1');
    const started = await service.install({ packageId: pkg.id, deviceIds: ['rio-1'] });
    const job = await waitForJob(service, started.jobId);
    progress.push(...job.targets[0]!.messages);
    assert.equal(job.targets[0]!.phase, 'done', job.targets[0]!.error ?? '');
    assert.equal(job.targets[0]!.result, 'Installed 26.11.1rc4, back online');
    // The device received the whole file, byte for byte, in one multipart upload.
    assert.equal(rio.uploads.length, 1);
    assert.equal(rio.uploads[0]!.bytes, packageBytes.length);
    assert.equal(rio.uploads[0]!.sha256, packageSha);
    assert.equal(rio.uploads[0]!.fileName, 'cy-rio-rev2-cyanos-26.11.1rc4.swu');
    assert.ok(rio.uploads[0]!.contentLength > packageBytes.length);
    assert.ok(progress.some(text => /SWUPDATE successful/.test(text)), 'the progress messages were read');
    // The temporary copy is removed once the install is over.
    assert.deepEqual(await readdir(dir), []);
  } finally {
    service.dispose();
    await rio.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a device that refuses the file reports why, and nothing else is sent to it', async () => {
  const rio = await fakeRio({ reject: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'firmware-device-'));
  const service = createFirmwareService({
    devices: async (): Promise<FirmwareDevice[]> => [{ id: 'rio-1', name: 'RIO 1', kind: 'RIO', address: rio.url, online: true }],
    log: () => undefined,
    port: rio.port,
    tempDir: dir,
    pollMs: 50,
  });
  try {
    const { id } = await service.begin();
    await sendPackage(service, id);
    const { package: pkg } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
    const started = await service.install({ packageId: pkg.id, deviceIds: ['rio-1'] });
    const job = await waitForJob(service, started.jobId);
    assert.equal(job.targets[0]!.phase, 'failed');
    assert.match(job.targets[0]!.error!, /Device refused the file: Upload failed/);
    // The one attempt reached the device, which refused it. Nothing was retried on another path.
    assert.equal(rio.uploads.length, 1);
  } finally {
    service.dispose();
    await rio.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an RCP is never contacted with a RIO file', async () => {
  const rcp = await fakeRio();
  const dir = await mkdtemp(path.join(tmpdir(), 'firmware-device-'));
  const service = createFirmwareService({
    devices: async (): Promise<FirmwareDevice[]> => [{ id: 'rcp-1', name: 'RCP 1', kind: 'RCP', address: rcp.url, online: true }],
    log: () => undefined,
    port: rcp.port,
    tempDir: dir,
    pollMs: 50,
  });
  try {
    const { id } = await service.begin();
    await sendPackage(service, id);
    const { package: pkg, targets } = await service.commit({ id, fileName: 'cy-rio-rev2-cyanos-26.11.1rc4.swu' }, new AbortController().signal);
    assert.equal(targets[0]!.selectable, false);
    await assert.rejects(service.install({ packageId: pkg.id, deviceIds: ['rcp-1'] }), /Nothing was sent/);
    assert.equal(rcp.requests, 0, 'the RCP received no request at all');
  } finally {
    service.dispose();
    await rcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});

