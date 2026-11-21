import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Firmware for RIOs goes through each device's own System Update page, which takes one SWU file per upload.
// Every target is checked against the package it is given before any byte is sent to it.

export const FIRMWARE_PORT = 8080;
export const FIRMWARE_MAX_BYTES = 300 * 1024 * 1024;
const PART_CHARS = 60000;
const HEADER_BYTES = 110;
const REBOOT_TIMEOUT_MS = 8 * 60 * 1000;
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

export type FirmwareKind = 'RIO' | 'RCP' | 'Gateway';

/** The family key a package is built for, as written in its sw-description, such as cy-rio-rev2. */
export const familyKind = (family: string | null): FirmwareKind | null =>
  !family ? null : /^cy-rio-/i.test(family) ? 'RIO' : /^cy-rcp-/i.test(family) ? 'RCP' : /^cy-(gateway|gwy)-/i.test(family) ? 'Gateway' : null;

/** The kind a file name claims. Only the start of the name is read, so a renamed file can't pass as another kind. */
export const fileNameKind = (fileName: string): FirmwareKind | null =>
  /^cy-rio-/i.test(fileName) ? 'RIO' : /^cy-rcp-/i.test(fileName) ? 'RCP' : /^cy-(gateway|gwy|gw)-/i.test(fileName) ? 'Gateway' : null;

/** The first cpio entry of an SWU archive, which is always sw-description. */
export function firstCpioEntry(buffer: Buffer): { name: string; body: Buffer } | null {
  if (buffer.length < HEADER_BYTES) return null;
  const magic = buffer.toString('latin1', 0, 6);
  if (magic !== '070701' && magic !== '070702') return null;
  const fileSize = Number.parseInt(buffer.toString('latin1', 54, 62), 16);
  const nameSize = Number.parseInt(buffer.toString('latin1', 94, 102), 16);
  if (!Number.isFinite(fileSize) || !Number.isFinite(nameSize) || nameSize < 2 || buffer.length < HEADER_BYTES + nameSize) return null;
  const name = buffer.toString('utf8', HEADER_BYTES, HEADER_BYTES + nameSize - 1);
  let start = HEADER_BYTES + nameSize;
  start += (4 - (start % 4)) % 4;
  if (fileSize > 1024 * 1024 || buffer.length < start + fileSize) return null;
  return { name, body: buffer.subarray(start, start + fileSize) };
}

export function parseSoftwareDescription(text: string) {
  const families = [...new Set([...text.matchAll(/^\s*(cy-[a-z0-9-]+)\s*=\s*\{/gm)].map(match => match[1]!))];
  const version = /\bversion\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const list = /hardware-compatibility\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
  const revisions = [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  return { families, version, revisions };
}

export type FirmwarePackage = {
  id: string;
  fileName: string;
  size: number;
  sha256: string;
  family: string | null;
  kind: FirmwareKind | null;
  version: string | null;
  revisions: string[];
  /** Anything that stops this file from being sent to any device. */
  problems: string[];
  /** Things the operator should see, which don't stop the update. */
  warnings: string[];
};

export function describePackage(fileName: string, size: number, sha256: string, head: Buffer): FirmwarePackage {
  const problems: string[] = [], warnings: string[] = [];
  const entry = firstCpioEntry(head);
  let family: string | null = null, version: string | null = null, revisions: string[] = [];
  if (!entry || entry.name !== 'sw-description') {
    problems.push('Not a Cyanview update file (SWU). Choose the file that came from Cyanview.');
  } else {
    const parsed = parseSoftwareDescription(entry.body.toString('utf8'));
    version = parsed.version;
    revisions = parsed.revisions;
    if (parsed.families.length === 1) family = parsed.families[0]!;
    else problems.push('The file names no single hardware family, so its target is unclear.');
  }
  const kind = familyKind(family);
  const nameKind = fileNameKind(fileName);
  if (family && !kind) problems.push('This file is for hardware (' + family + ') that Hubble doesn’t update yet.');
  if (nameKind && kind && nameKind !== kind) problems.push('The file name says ' + nameKind + ' but the package is for a ' + kind + '. It is not sent to any device.');
  if (!nameKind) problems.push('The file name must start with the device it is for, such as cy-rio-. Use the file Cyanview published.');
  const nameVersion = /(\d+\.\d+\.\d+(?:rc\d+)?)/.exec(fileName)?.[1] ?? null;
  if (version && nameVersion && version !== nameVersion) warnings.push('The package says version ' + version + ' inside, but the file name says ' + nameVersion + '. The device will report ' + nameVersion + '.');
  // The post-install step records the version from the file name, which is what the device reports afterwards.
  return { id: '', fileName, size, sha256, family, kind, version: nameVersion ?? version, revisions, problems, warnings };
}

/** What a device's own System Update page reports about it. */
export type DeviceUpdateInfo = {
  hardware: string | null;
  osVersion: string | null;
  rootfs: string | null;
  bootId: string | null;
};

export function parseVersionPage(html: string): DeviceUpdateInfo {
  const line = (label: string) => new RegExp(label + '\\s*:\\s*([^<\\n]+)').exec(html)?.[1]?.trim() ?? null;
  const os = line('Operating System');
  return {
    hardware: line('HW'),
    osVersion: os ? os.replace(/\s*\(CyanOS\)\s*$/, '').replace(/^CyanOS\s*/, '') : null,
    rootfs: line('Rootfs'),
    bootId: line('Boot ID'),
  };
}

export type FirmwareDevice = {
  id: string;
  name: string;
  kind: string;
  address: string;
  online: boolean;
};

export type FirmwareTarget = {
  deviceId: string;
  name: string;
  kind: string;
  address: string;
  selectable: boolean;
  checked: boolean;
  reason: string | null;
  current: DeviceUpdateInfo | null;
};

export type FirmwareProgress = {
  deviceId: string;
  name: string;
  phase: 'checking' | 'uploading' | 'installing' | 'rebooting' | 'done' | 'failed';
  percent: number | null;
  step: string;
  result: string | null;
  error: string | null;
  messages: string[];
};

export type FirmwareJob = {
  id: string;
  packageId: string;
  fileName: string;
  version: string | null;
  state: 'running' | 'done';
  startedAt: string;
  targets: FirmwareProgress[];
};

export type FirmwareLog = (entry: { level: 'info' | 'error'; message: string }) => void;

export interface FirmwareServiceOptions {
  devices: () => Promise<FirmwareDevice[]>;
  log: FirmwareLog;
  port?: number;
  tempDir?: string;
  /** Reads a device's update page. Tests replace it. */
  readPage?: (address: string, port: number, signal: AbortSignal) => Promise<DeviceUpdateInfo | null>;
  /** Sends one file to a device's update page and resolves with its reply. */
  upload?: (address: string, port: number, filePath: string, fileName: string, size: number, signal: AbortSignal) => Promise<{ status: number; body: string }>;
  watch?: (address: string, port: number, onMessage: (message: Record<string, unknown>) => void) => () => void;
  pollMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
});

export async function defaultReadPage(address: string, port: number, signal: AbortSignal): Promise<DeviceUpdateInfo | null> {
  try {
    const response = await fetch('http://' + address + ':' + port + '/version.html', { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    if (!response.ok) return null;
    return parseVersionPage(await response.text());
  } catch {
    return null;
  }
}

export function defaultUpload(address: string, port: number, filePath: string, fileName: string, size: number, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = '----HubbleFirmware' + randomUUID().replace(/-/g, '');
    const safeName = fileName.replace(/["\r\n]/g, '_');
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + safeName + '"\r\nContent-Type: application/octet-stream\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const request = httpRequest({
      host: address, port, path: '/upload', method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(head.length + size + tail.length),
        Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    const onAbort = () => request.destroy(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => signal.removeEventListener('abort', onAbort));
    request.write(head);
    const file = createReadStream(filePath);
    file.on('error', error => request.destroy(error));
    file.on('end', () => request.end(tail));
    file.pipe(request, { end: false });
  });
}

export function defaultWatch(address: string, port: number, onMessage: (message: Record<string, unknown>) => void): () => void {
  const socket = new WebSocket('ws://' + address + ':' + port + '/ws');
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as unknown;
      if (message && typeof message === 'object') onMessage(message as Record<string, unknown>);
    } catch { /* not JSON, so not a progress message */ }
  };
  socket.onerror = () => undefined;
  return () => socket.close();
}

type Transfer = { id: string; path: string; index: number; size: number; expires: number };

export function createFirmwareService(options: FirmwareServiceOptions) {
  const port = options.port ?? FIRMWARE_PORT;
  const readPage = options.readPage ?? defaultReadPage;
  const upload = options.upload ?? defaultUpload;
  const watch = options.watch ?? defaultWatch;
  const pollMs = options.pollMs ?? 3000;
  const dir = options.tempDir ?? path.join(tmpdir(), 'cyanview-firmware');
  const transfers = new Map<string, Transfer>();
  const packages = new Map<string, FirmwarePackage & { path: string }>();
  let active: FirmwareJob | null = null;
  let latest: FirmwareJob | null = null;
  const controllers = new Map<string, AbortController>();

  const removeFile = (filePath: string) => rm(filePath, { force: true }).catch(() => undefined);
  const expire = () => {
    for (const [id, transfer] of transfers) if (transfer.expires < Date.now()) { transfers.delete(id); void removeFile(transfer.path); }
  };

  return {
    async begin(): Promise<{ id: string }> {
      expire();
      if (transfers.size >= 1) throw new Error('Finish the file that is already being sent first');
      const id = randomUUID();
      const filePath = path.join(dir, id + '.swu');
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, Buffer.alloc(0));
      transfers.set(id, { id, path: filePath, index: 0, size: 0, expires: Date.now() + TRANSFER_TIMEOUT_MS });
      return { id };
    },

    async part(input: { id: string; index: number; text: string }): Promise<{ accepted: number }> {
      const transfer = transfers.get(input.id);
      if (!transfer) throw new Error('File transfer expired. Choose the file again.');
      if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > PART_CHARS || !/^[A-Za-z0-9+/=]+$/.test(input.text)) throw new Error('Invalid file part');
      if (input.index !== transfer.index) throw new Error('File parts arrived out of order. Choose the file again.');
      const bytes = Buffer.from(input.text, 'base64');
      if (transfer.size + bytes.length > FIRMWARE_MAX_BYTES) throw new Error('This file is too large for a Cyanview update');
      await appendFile(transfer.path, bytes);
      transfer.index += 1; transfer.size += bytes.length; transfer.expires = Date.now() + TRANSFER_TIMEOUT_MS;
      return { accepted: input.index };
    },

    async commit(input: { id: string; fileName: string }, signal: AbortSignal) {
      const transfer = transfers.get(input.id);
      if (!transfer) throw new Error('File transfer expired. Choose the file again.');
      transfers.delete(input.id);
      const fileName = String(input.fileName ?? '').split(/[\\/]/).pop() ?? '';
      if (!fileName.toLowerCase().endsWith('.swu')) { await removeFile(transfer.path); throw new Error('Choose a .swu file'); }
      const info = await stat(transfer.path);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(transfer.path, { signal })) hash.update(chunk as Buffer);
      const head = Buffer.alloc(Math.min(info.size, 256 * 1024));
      const handle = await open(transfer.path, 'r');
      try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
      const pkg = describePackage(fileName, info.size, hash.digest('hex'), head);
      pkg.id = randomUUID();
      packages.set(pkg.id, { ...pkg, path: transfer.path });
      options.log({ level: 'info', message: 'Firmware file ready: ' + fileName + ' (' + info.size + ' bytes, ' + (pkg.kind ?? 'unknown kind') + ')' });
      return { package: publicPackage(pkg), targets: await targetsFor(pkg.id, signal) };
    },

    async targets(packageId: string, signal: AbortSignal) {
      return targetsFor(packageId, signal);
    },

    async install(input: { packageId: string; deviceIds: string[] }) {
      const pkg = packages.get(input.packageId);
      if (!pkg) throw new Error('Choose the firmware file again');
      if (active) throw new Error('A firmware update is already running. Wait for it to finish.');
      const devices = await options.devices();
      const chosen = input.deviceIds.map(id => devices.find(device => device.id === id)).filter((device): device is FirmwareDevice => Boolean(device));
      if (chosen.length !== input.deviceIds.length) throw new Error('A selected device is no longer in this module. Refresh and choose again.');
      // Checked again here, before anything is sent: a file never goes to a device of another kind.
      if (pkg.problems.length) throw new Error('Nothing was sent. ' + pkg.problems[0]!);
      const refused = chosen.filter(device => device.kind !== pkg.kind || device.kind !== 'RIO' || !device.address);
      if (refused.length) throw new Error('Nothing was sent. ' + refused.map(device => device.name).join(', ') + ' can’t take a ' + (pkg.kind ?? 'this kind of') + ' file.');
      const job: FirmwareJob = {
        id: randomUUID(), packageId: pkg.id, fileName: pkg.fileName, version: pkg.version, state: 'running', startedAt: new Date().toISOString(),
        targets: chosen.map(device => ({ deviceId: device.id, name: device.name, phase: 'checking', percent: null, step: 'Checking', result: null, error: null, messages: [] })),
      };
      active = job; latest = job;
      options.log({ level: 'info', message: 'Firmware ' + pkg.version + ' sent to ' + chosen.length + (chosen.length === 1 ? ' device' : ' devices') + ' at the same time' });
      // Every device starts at once. Each one's failure stays with that device.
      void Promise.allSettled(chosen.map((device, index) => runOne(job, job.targets[index]!, device, pkg)))
        .then(() => { job.state = 'done'; active = null; packages.delete(pkg.id); return removeFile(pkg.path); });
      return { jobId: job.id, targets: job.targets.length };
    },

    status(jobId?: string | null) {
      const job = jobId ? [active, latest].find(item => item?.id === jobId) : latest;
      return job ? structuredClone(job) : null;
    },

    cancel() {
      for (const controller of controllers.values()) controller.abort();
    },

    dispose() {
      for (const controller of controllers.values()) controller.abort();
      for (const transfer of transfers.values()) void removeFile(transfer.path);
      transfers.clear();
    },
  };

  function publicPackage(pkg: FirmwarePackage) {
    const { id, fileName, size, sha256, family, kind, version, revisions, problems, warnings } = pkg;
    return { id, fileName, size, sha256, family, kind, version, revisions, problems, warnings };
  }

  async function targetsFor(packageId: string, signal: AbortSignal): Promise<FirmwareTarget[]> {
    const pkg = packages.get(packageId);
    if (!pkg) throw new Error('Choose the firmware file again');
    const devices = await options.devices();
    return Promise.all(devices.map(async device => {
      const base = { deviceId: device.id, name: device.name, kind: device.kind, address: device.address };
      const eligibility = await judge(pkg, device, signal);
      return { ...base, ...eligibility };
    }));
  }

  async function judge(pkg: FirmwarePackage, device: FirmwareDevice, signal: AbortSignal): Promise<Omit<FirmwareTarget, 'deviceId' | 'name' | 'kind' | 'address'>> {
    const none = (reason: string, current: DeviceUpdateInfo | null = null) => ({ selectable: false, checked: false, reason, current });
    if (pkg.problems.length) return none(pkg.problems[0]!);
    if (device.kind !== pkg.kind) return none(pkg.kind + ' file. ' + device.name + ' is ' + (device.kind === 'RIO' ? 'a RIO' : device.kind === 'RCP' ? 'an RCP' : 'a Gateway') + '.');
    if (device.kind !== 'RIO') return none('Updates for ' + device.kind + 's aren’t available yet');
    if (!device.online || !device.address) return none('Offline');
    const current = await readPage(device.address, port, signal);
    if (!current) return none('Can’t reach its update page');
    if (current.hardware !== pkg.family) return none('This device is ' + (current.hardware ?? 'unknown hardware') + '. The file is for ' + pkg.family + '.', current);
    const onVersion = Boolean(pkg.version && current.osVersion === pkg.version);
    return { selectable: true, checked: !onVersion, reason: onVersion ? 'Already on this version' : null, current };
  }

  async function runOne(job: FirmwareJob, progress: FirmwareProgress, device: FirmwareDevice, pkg: FirmwarePackage & { path: string }) {
    const controller = new AbortController();
    controllers.set(device.id, controller);
    const signal = controller.signal;
    const say = (message: string) => { progress.messages = [...progress.messages.slice(-49), message]; };
    const fail = (message: string) => {
      progress.phase = 'failed'; progress.error = message; progress.result = message; progress.step = 'Failed';
      options.log({ level: 'error', message: device.name + ' update failed: ' + message });
    };
    let stopWatching: (() => void) | null = null;
    try {
      const before = await readPage(device.address, port, signal);
      if (!before) return fail('Can’t reach its update page');
      if (before.hardware !== pkg.family) return fail('This device is ' + (before.hardware ?? 'unknown hardware') + '. The file is for ' + pkg.family + '. Nothing was sent.');
      if (!device.online) return fail('Offline');
      progress.phase = 'uploading'; progress.step = 'Sending file';
      stopWatching = watch(device.address, port, message => {
        const type = message.type;
        if (type === 'step' && typeof message.percent === 'string') { progress.percent = Number(message.percent); progress.step = 'Installing'; }
        else if (type === 'message' && typeof message.text === 'string') {
          const text = message.text.replace(/\s+/g, ' ').trim();
          if (text) say(text);
          if (/SWUPDATE successful/i.test(text)) { progress.phase = 'rebooting'; progress.step = 'Restarting'; progress.percent = 100; }
          if (/SWUPDATE failed|update failed/i.test(text)) { progress.phase = 'failed'; progress.error = text; }
        } else if (type === 'status' && message.status === 'FAILURE') { progress.phase = 'failed'; progress.error = 'The device reported a failed install'; }
      });
      const reply = await upload(device.address, port, pkg.path, pkg.fileName, pkg.size, signal);
      if (reply.status !== 200 || !/^\s*Ok,/.test(reply.body)) return fail('Device refused the file: ' + reply.body.replace(/\s+/g, ' ').slice(0, 120));
      progress.phase = 'installing'; progress.step = 'Installing';
      const deadline = Date.now() + REBOOT_TIMEOUT_MS;
      let after: DeviceUpdateInfo | null = null;
      while (Date.now() < deadline) {
        if ((progress.phase as string) === 'failed') return fail(progress.error ?? 'Install failed');
        await sleep(pollMs, signal);
        const now = await readPage(device.address, port, signal);
        if (now && now.bootId && now.bootId !== before.bootId) { after = now; break; }
      }
      if (!after) return fail('Didn’t come back within 8 minutes');
      if (after.osVersion !== pkg.version) return fail('Came back on ' + (after.osVersion ?? 'unknown') + ', expected ' + pkg.version);
      progress.phase = 'done'; progress.step = 'Installed'; progress.percent = 100;
      progress.result = 'Installed ' + pkg.version + ', back online';
      options.log({ level: 'info', message: device.name + ' installed ' + pkg.version + ' and came back on ' + after.rootfs });
    } catch (error) {
      if (!signal.aborted) fail(error instanceof Error ? error.message : String(error));
      else fail('Cancelled');
    } finally {
      stopWatching?.();
      controllers.delete(device.id);
      if (job.targets.every(target => target.phase === 'done' || target.phase === 'failed')) job.state = 'done';
    }
  }
}
