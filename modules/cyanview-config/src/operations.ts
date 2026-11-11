import { CyanviewClient } from './transport.js';
import { PlanRepository } from './repository.js';
import { addressParts, lensParameters, normalizedLabel, object, validIp, type Plan, type RecordValue } from './model.js';
import { optionEntries } from './normalize.js';
import { isRemiModel, remiCamera, remiEntries } from './remi-model.js';
import type { RemiOperations } from './remi.js';

export type ClientFactory = (address: string) => CyanviewClient;
const enabled = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
const advanced = (field: string) => /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.test(field) || field === 'lensIp';
const protectedLan = (row: RecordValue) => enabled(row.ReadOnly) || enabled(row.NoDelete) || String(row.IP).startsWith('10.192.');
/**
 * One socket per controller for a whole send. A controller pushes its entire configuration to every
 * open socket after every change, so a socket per row multiplies that work by the number of rows.
 */
class ControllerSession {
  private clients = new Map<string, { address: string; client: Promise<CyanviewClient> }>();
  private saved: Promise<Plan> | undefined;
  readonly deleted = new Set<string>();
  /** What each sent camera leaves on its saved row. They are written together when the send ends. */
  readonly receipts: { item: RecordValue; patch: RecordValue }[] = [];
  /** How long each controller took to open, so a slow send can be told apart from a slow controller. */
  readonly opened: number[] = [];
  constructor(private open: (device: RecordValue, signal: AbortSignal) => Promise<CyanviewClient>, private read: (signal: AbortSignal) => Promise<Plan>) {}
  /** The saved plan, read once for the whole send. */
  plan(signal: AbortSignal) { return this.saved ??= this.read(signal); }
  async client(device: RecordValue, signal: AbortSignal): Promise<CyanviewClient> {
    const address = String(device.address || device.base), held = this.clients.get(device.id);
    if (held?.address === address) {
      // Cameras sent together share the one opening. A controller that couldn't be opened fails
      // each of them at once and isn't tried again for every row.
      const client = await held.client;
      if (client.connected) return client;
      if (this.clients.get(device.id) !== held) return this.client(device, signal);
      client.close();
    } else void held?.client.then(client => client.close(), () => undefined);
    const began = performance.now(), opening = this.open(device, signal);
    opening.then(() => this.opened.push(Math.round(performance.now() - began)), () => undefined);
    this.clients.set(device.id, { address, client: opening });
    return opening;
  }
  close() { for (const { client } of this.clients.values()) void client.then(open => open.close(), () => undefined); this.clients.clear(); }
}
const controllersAtOnce = 8;
// A controller's socket takes one request at a time whatever this is. It bounds how many cameras
// are waiting on the controller's confirmation together.
const camerasAtOnce = 6;
// What a REMI copy shows of the camera it was made from. Nothing else on the camera reaches a copy.
const copiedFields = ['Number', 'Name', 'Model'];
export class ConfigurationOperations {
  private queues = new Map<string, Promise<unknown>>();
  // Sends still working through a controller, which a network change has to wait for.
  private batches = new Map<string, Set<Promise<void>>>();
  private rowQueues = new Map<string, Map<string, Promise<unknown>>>();
  private cameraNumbers = new Map<string, Set<number>>();
  constructor(private repository: PlanRepository, private client: ClientFactory = address => new CyanviewClient(address), private remi?: RemiOperations) {}
  private async connect(device: RecordValue, signal: AbortSignal, address = device.address || device.base): Promise<CyanviewClient> {
    const client = this.client(address);
    try { await client.connect(signal); if (client.serial !== device.serial) throw new Error('Controller identity changed; refresh before sending'); return client; }
    catch (error) { client.close(); throw error; }
  }
  private receipt(kind: 'camera' | 'lan', item: RecordValue, patch: RecordValue, signal: AbortSignal) {
    return this.repository.update(plan => {
      const rows = kind === 'camera' ? plan.cameras : plan.lans;
      let row = rows.find(row => row.id === item.id);
      if (!row) { row = { ...item }; rows.push(row); }
      Object.assign(row, patch);
    }, signal);
  }
  run(input: RecordValue, signal: AbortSignal, session?: ControllerSession): Promise<RecordValue> {
    if (Array.isArray(input.items)) return this.batch(input.items, signal);
    const item = object(input.item), deviceId = String(item.device ?? '');
    if (!deviceId || !item.id || !['camera', 'lan'].includes(input.kind)) return Promise.reject(new Error('Choose a valid configuration row'));
    const rows = this.rowQueues.get(deviceId) ?? new Map<string, Promise<unknown>>(), rowKey = `${input.kind}:${item.id}`;
    const exclusive = input.kind === 'lan' && item.operation !== 'Add';
    // Independent rows start together. Replacing network settings waits for
    // writes that still use the controller's previous connection address.
    // A send already holds its place on the controller, and a network change queued behind it waits for it.
    const previous = session ? [rows.get(rowKey)] : [this.queues.get(deviceId), ...(exclusive ? [...rows.values(), ...(this.batches.get(deviceId) ?? [])] : [rows.get(rowKey)])];
    // A row an earlier send is still working on is read again once that send has left it.
    const settled = !rows.has(rowKey);
    const task = Promise.all(previous.map(task => task?.catch(() => undefined))).then(async () => {
      signal.throwIfAborted();
      if (input.kind === 'camera' && !input.deleting && this.repository.cameraWasDeleted(item.id)) throw new Error('This camera was deleted; add a new camera before sending more edits');
      const plan = session && settled ? await session.plan(signal) : (await this.repository.read(signal)).plan, device = plan.devices.find(device => device.id === deviceId);
      if (!device) throw new Error('Controller is no longer in the managed list');
      const saved = (input.kind === 'camera' ? plan.cameras : plan.lans).find(row => row.id === item.id);
      const target = { ...item, ...(saved?.elementKey ? { elementKey: saved.elementKey } : {}), ...(saved?.newElementKey ? { newElementKey: saved.newElementKey } : {}), needsInitialization: saved?.needsInitialization ?? item.needsInitialization, createState: saved?.createState ?? item.createState };
      const numbers = this.cameraNumbers.get(deviceId) ?? new Set<number>();
      const number = input.kind === 'camera' && !input.deleting ? Number(item.number) : null;
      if (number !== null && numbers.has(number)) throw new Error('That camera number is already being sent on this controller');
      if (number !== null) { numbers.add(number); this.cameraNumbers.set(deviceId, numbers); }
      let client: CyanviewClient | undefined;
      try {
        client = session ? await session.client(device, signal) : await this.connect(device, signal);
        return input.kind === 'camera' ? await this.camera(client, device, target, input, signal, session) : await this.lan(client, device, target, input, signal);
      } finally {
        if (!session) client?.close();
        if (number !== null) { numbers.delete(number); if (!numbers.size) this.cameraNumbers.delete(deviceId); }
      }
    });
    if (exclusive && !session) this.queues.set(deviceId, task);
    else { rows.set(rowKey, task); this.rowQueues.set(deviceId, rows); }
    const cleanup = () => {
      if (rows.get(rowKey) === task) rows.delete(rowKey);
      if (!rows.size && this.rowQueues.get(deviceId) === rows) this.rowQueues.delete(deviceId);
      if (this.queues.get(deviceId) === task) this.queues.delete(deviceId);
    };
    void task.then(cleanup, cleanup);
    return task;
  }
  private async batch(items: unknown[], signal: AbortSignal): Promise<RecordValue> {
    if (!items.length || items.length > 1536) throw new Error('Choose between 1 and 1536 configuration rows');
    const ids = new Set<string>();
    for (const value of items) {
      const input = object(value), id = `${input.kind}:${object(input.item).id}`;
      if (Array.isArray(input.items) || ids.has(id)) throw new Error('Each configuration row can only appear once in a send');
      ids.add(id);
    }
    // Controllers work side by side, and each takes its rows in turn over its one socket.
    const started = performance.now();
    const session = new ControllerSession((device, opening) => this.connect(device, opening), async reading => (await this.repository.read(reading)).plan);
    const groups = new Map<string, number[]>();
    items.forEach((value, index) => { const device = String(object(object(value).item).device ?? ''); groups.set(device, [...(groups.get(device) ?? []), index]); });
    const work = [...groups.values()], results: RecordValue[] = new Array(items.length);
    let next = 0, finished = () => {};
    const running = new Promise<void>(resolve => { finished = resolve; });
    for (const device of groups.keys()) this.batches.set(device, new Set([...(this.batches.get(device) ?? []), running]));
    try {
      await Promise.all([...groups.keys()].map(device => this.queues.get(device)?.catch(() => undefined)));
      await Promise.all(Array.from({ length: Math.min(controllersAtOnce, work.length) }, async () => {
        while (next < work.length) {
          const rows = work[next++]!;
          const send = async (index: number) => {
            const input = object(items[index]), item = object(input.item), began = performance.now();
            try { results[index] = { ...await this.run(input, signal, session), kind: input.kind, id: item.id }; }
            catch (error) { results[index] = { kind: input.kind, id: item.id, error: error instanceof Error ? error.message : 'Settings could not be confirmed' }; }
            results[index]!.ms = Math.round(performance.now() - began);
          };
          // A network change, a new camera and a changed camera number each take their turn, since the
          // next row can depend on what they leave. Other cameras on the controller go together.
          const inTurn = (index: number) => {
            const input = object(items[index]), item = object(input.item);
            return input.kind !== 'camera' || (!input.deleting && (!item.elementKey || item.needsInitialization === true || !Array.isArray(input.fields) || input.fields.includes('number')));
          };
          for (let at = 0; at < rows.length;) {
            if (inTurn(rows[at]!)) { await send(rows[at++]!); continue; }
            let end = at;
            while (end < rows.length && !inTurn(rows[end]!)) end++;
            const together = rows.slice(at, end);
            at = end;
            let turn = 0;
            await Promise.all(Array.from({ length: Math.min(camerasAtOnce, together.length) }, async () => { while (turn < together.length) await send(together[turn++]!); }));
          }
        }
      }));
    } finally {
      session.close();
      finished();
      for (const device of groups.keys()) {
        const open = this.batches.get(device);
        open?.delete(running);
        if (!open?.size) this.batches.delete(device);
      }
    }
    // One save for the whole send, however many cameras went, and none when nothing on a saved row changed.
    const current = await this.repository.read(signal);
    const unsettled = session.receipts.some(({ item, patch }) => {
      const row = current.plan.cameras.find(row => row.id === item.id);
      return !row || row.elementKey !== patch.elementKey || !!row.createState || row.needsInitialization === true || row.isNew === true;
    });
    const saved = !session.deleted.size && !unsettled ? current : await this.repository.update(plan => {
      plan.cameras = plan.cameras.filter(row => !session.deleted.has(String(row.id)));
      for (const { item, patch } of session.receipts) {
        let row = plan.cameras.find(row => row.id === item.id);
        if (!row) { row = { ...item }; plan.cameras.push(row); }
        Object.assign(row, patch);
      }
    }, signal);
    for (const result of results) {
      const row = (result.kind === 'camera' ? saved.plan.cameras : saved.plan.lans).find(row => row.id === result.id);
      if (row) for (const field of ['elementKey', 'newElementKey', 'createState', 'needsInitialization']) if (row[field] !== undefined) Object.assign(result, { [field]: row[field] });
    }
    return { results, revision: saved.revision, elapsedMs: Math.round(performance.now() - started), controllers: groups.size, openMs: Math.max(0, ...session.opened) };
  }
  private async camera(client: CyanviewClient, device: RecordValue, item: RecordValue, input: RecordValue, signal: AbortSignal, session?: ControllerSession): Promise<RecordValue> {
    let key = String(item.elementKey ?? ''), created = item.needsInitialization === true;
    const fields: string[] = Array.isArray(input.fields) ? input.fields.filter((field: unknown) => typeof field === 'string') : [];
    const before = client.config.Camera?.[key] as RecordValue | undefined;
    if (isRemiModel(before?.Model)) {
      // A copy with nothing importing it any more is only an element left behind, and clearing a controller may delete it.
      const imported = remiEntries(client.config).some(entry => entry.localKey === key && entry.enabled);
      if (!input.deleting || input.orphan !== true || imported) throw new Error('Use REMI to remove an imported camera or edit it on its source');
    }
    if (before) await this.remi?.assertCameraReady(device.id, key, signal);
    if (input.deleting) {
      if (key && client.config.Camera?.[key]) await client.action({ delete: [key] }, signal);
      if (session) {
        if (key) await client.waitFor(config => !config.Camera?.[key], signal);
        session.deleted.add(String(item.id));
        return { deleted: true };
      }
      const fresh = await this.connect(device, signal);
      try { if (key && fresh.config.Camera?.[key]) throw new Error('Camera deletion could not be verified'); }
      finally { fresh.close(); }
      const saved = await this.repository.update(plan => { plan.cameras = plan.cameras.filter(row => row.id !== item.id); }, signal);
      return { deleted: true, revision: saved.revision };
    }
    if (!/^\d+$/.test(String(item.number)) || Number(item.number) < 1 || !String(item.name ?? '').trim() || String(item.name).length > 160) throw new Error('Enter a camera number and name');
    const usb = item.model === 'Alpha-USB' || normalizedLabel(item.model) === 'sonyalphausb';
    if (!usb && !validIp(String(item.ip ?? ''))) throw new Error('Enter a valid camera IP address');
    if (!usb && (!/^\d+$/.test(String(item.port || '80')) || Number(item.port || 80) < 1 || Number(item.port || 80) > 65535)) throw new Error('Enter a camera port between 1 and 65535');
    if (item.lens === 'cmotion cGate' && fields.some(field => field === 'lens' || field === 'lensPort' || advanced(field))) throw new Error('cGate configuration is not available yet');
    const sameLens = normalizedLabel(before?.LensModel) === normalizedLabel(item.lens);
    const parameters = lensParameters(item, fields, sameLens ? String(before?.LensParams ?? '') : '');
    if (parameters !== undefined && before && !sameLens && !created && !fields.includes('lens')) throw new Error('Send the lens model change before editing its axes');
    for (const [otherKey, row] of Object.entries(object(client.config.Camera))) if (otherKey !== key && String(object(row).Number) === String(item.number)) throw new Error('That camera number is already used on this controller');
    if (!key) {
      if (item.createState) throw new Error('A previous create has an unknown outcome. Refresh the controller before retrying.');
      await this.receipt('camera', item, { createState: 'pending' }, signal);
      const result = await client.action({ new: ['CyElement.Camera', ''] }, signal);
      if (typeof result[1] !== 'string') throw new Error('Controller did not return a camera identity');
      key = result[1]; created = true;
      await this.receipt('camera', item, { elementKey: key, createState: null, needsInitialization: true }, signal);
    }
    if (!client.config.Camera?.[key]) await client.waitFor(config => !!config.Camera?.[key], signal);
    const expected: RecordValue = {};
    if (created || fields.includes('model')) {
      const entries = optionEntries(await client.option(key, 'Model', signal));
      const matches = entries.filter(entry => normalizedLabel(entry.label) === normalizedLabel(item.model) || normalizedLabel(entry.label.replace(/^Sony\s*-\s*/, '')) === normalizedLabel(item.model));
      if (matches.length !== 1) throw new Error('Choose a camera model offered by this controller');
      const choice = matches[0]!, update = object(choice.request).update;
      if (!update || update.key !== key || typeof object(update.changes).model !== 'string') throw new Error('Camera model mapping is unavailable');
      await client.update(key, { model: update.changes.model }, signal);
      expected.Model = choice.label;
      await client.waitFor(config => normalizedLabel(config.Camera?.[key]?.Model) === normalizedLabel(choice.label), signal);
    }
    for (const [field, property, label] of [['number', 'number', 'Number'], ['name', 'name', 'Name']] as const) if (created || fields.includes(field)) { await client.update(key, { [property]: String(item[field]) }, signal); expected[label] = String(item[field]); }
    if (!usb) for (const [field, label] of [['ip', 'IP'], ['port', 'Port'], ['login', 'Login'], ['password', 'Password']] as const) if (created || fields.includes('model') || fields.includes(field)) {
      const mapping = await client.mapping(key, label, signal), value = String(item[field] ?? (field === 'port' ? '80' : ''));
      await client.update(mapping.key, { [mapping.property]: value }, signal); expected[label] = value;
    }
    if (usb && (created || fields.includes('usb'))) {
      const interfaces = optionEntries(await client.option(key, 'Interface', signal));
      const wanted = !item.usb || item.usb === 'USB · Automatic' ? '*' : item.usb;
      const choice = interfaces.find(choice => choice.description?.port === wanted);
      if (choice && choice.description?.status !== 'current') await client.action(choice.request, signal);
      if (!choice && wanted !== '*') throw new Error('The selected USB camera is unavailable');
      if (choice) expected.usb = wanted;
    }
    if (fields.includes('lens') || created && item.lens && item.lens !== 'None') {
      const choices = optionEntries(await client.option(key, 'LensModel', signal));
      const choice = choices.find(choice => normalizedLabel(choice.label) === normalizedLabel(item.lens) || item.lens === 'None' && !choice.label);
      if (choice) { await client.action(choice.request, signal); expected.LensModel = item.lens === 'None' ? '' : choice.label; }
      else if (item.lens !== 'None' || client.config.Camera?.[key]?.LensModel) throw new Error('Selected lens model is unavailable');
    }
    if (fields.includes('lensPort') && item.lens !== 'None' && item.lensPort) {
      const choices = optionEntries(await client.option(key, 'LensInterface', signal));
      if (item.lensPort === 'None') {
        if (object(client.config.Camera?.[key]?.LensInterface).port) {
          const choice = choices.find(choice => !choice.label || normalizedLabel(choice.label) === 'none');
          if (!choice) throw new Error('This controller does not offer a verified lens disconnect command');
          await client.action(choice.request, signal); expected.lensDisconnected = true;
        }
      } else {
        const choice = choices.find(choice => normalizedLabel(choice.label) === normalizedLabel(item.lensPort));
        if (!choice) throw new Error('The selected lens connection is unavailable');
        if (choice.description?.status !== 'current') await client.action(choice.request, signal);
        expected.lensConnection = choice.description;
      }
    }
    if (parameters !== undefined) {
      if (expected.LensModel !== undefined) await client.waitFor(config => config.Camera?.[key]?.LensModel === expected.LensModel, signal);
      const mapping = await client.mapping(key, 'LensParams', signal);
      await client.update(mapping.key, { [mapping.property]: parameters }, signal); expected.LensParams = parameters;
    }
    const matches = (row: RecordValue, field: string, value: unknown) => {
      if (field === 'usb') return String(object(row.Interface).port) === value;
      if (field === 'lensDisconnected') return !object(row.LensInterface).port;
      if (field === 'lensConnection') return ['device', 'port'].every(part => String(object(row.LensInterface)[part]) === String(object(value)[part]));
      if (field === 'Model') return normalizedLabel(row.Model) === normalizedLabel(value);
      return String(row[field] ?? '') === String(value);
    };
    // The socket a send shares gets the controller's own push of what changed.
    const waited = performance.now();
    if (session) await client.waitFor(config => Object.entries(expected).every(([field, value]) => matches(object(config.Camera?.[key]), field, value)), signal).catch(() => signal.throwIfAborted());
    const fresh = session ? client : await this.connect(device, signal);
    let copiesStale = false;
    let verifiedCamera: ReturnType<typeof remiCamera>;
    try {
      const observed = object(fresh.config.Camera?.[key]);
      for (const [field, value] of Object.entries(expected)) {
        if (!matches(observed, field, value)) throw new Error('Camera configuration could not be verified through a fresh connection');
        if (before && copiedFields.includes(field) && !matches(before, field, value)) copiesStale = true;
      }
      verifiedCamera = remiCamera(key, fresh.config);
    } finally { if (!session) fresh.close(); }
    const patch = { elementKey: key, createState: null, needsInitialization: false, isNew: false };
    const result: RecordValue = { elementKey: key, verified: true };
    // How long the controller took to report the change back, which is its own time and not the send's.
    if (session) result.confirmMs = Math.round(performance.now() - waited);
    if (session) session.receipts.push({ item, patch });
    else result.revision = (await this.receipt('camera', item, patch, signal)).revision;
    // An address, login or lens change never reaches a copy, so the copies and their controllers are left alone.
    if (before && copiesStale && this.remi) {
      const previous = { key, name: String(before.Name ?? ''), number: String(before.Number ?? '') }, rebuilding = performance.now();
      try { Object.assign(result, await this.remi.cameraChanged(device, previous, verifiedCamera, signal)); }
      catch (error) {
        result.remiRefresh = true;
        result.remiError = error instanceof Error ? error.message : 'REMI refresh could not be completed';
      }
      // Each controller holding a copy takes it off and imports it again, which is those controllers' time.
      if (result.remiRefresh) result.copiesMs = Math.round(performance.now() - rebuilding);
    }
    return result;
  }
  private async lan(client: CyanviewClient, device: RecordValue, item: RecordValue, input: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    const rows = object(client.config.IP), fields: string[] = Array.isArray(input.fields) ? input.fields : [];
    const oldKey = String(item.elementKey ?? Object.keys(rows).find(key => rows[key].IP === String(item.current).split('/')[0] && rows[key].Interface === item.iface) ?? '');
    const old = object(rows[oldKey]);
    if (item.type === 'WAN') {
      if (!oldKey || enabled(old.ReadOnly)) throw new Error('This network interface is read-only');
      const updates: { key: string; changes: RecordValue }[] = [];
      const expected: RecordValue = {};
      for (const [field, label] of [['gateway', 'Gateway'], ['dns1', 'DNS1'], ['dns2', 'DNS2']] as const) if (fields.includes(field)) {
        if (item[field] && !validIp(String(item[field]))) throw new Error('Enter a valid gateway or DNS address');
        const mapping = await client.mapping(oldKey, label, signal);
        updates.push({ key: mapping.key, changes: { [mapping.property]: String(item[field] ?? '') } }); expected[label] = String(item[field] ?? '');
      }
      if (fields.some(field => ['dhcp', 'planned'].includes(field))) throw new Error('Address and DHCP writes on this WAN interface require a verified mapping');
      for (const update of updates) await client.update(update.key, update.changes, signal);
      const fresh = await this.connect(device, signal);
      try { for (const [field, value] of Object.entries(expected)) if (String(fresh.config.IP?.[oldKey]?.[field] ?? '') !== value) throw new Error('Network settings could not be verified'); } finally { fresh.close(); }
      return { elementKey: oldKey, verified: true };
    }
    if (!['Add', 'Replace', 'Keep'].includes(item.operation)) throw new Error('Choose Add or Replace');
    if (item.operation === 'Keep') {
      if (item.planned !== item.current) throw new Error('Choose Add or Replace for the changed address');
      return { verified: true, elementKey: oldKey };
    }
    const desired = addressParts(String(item.planned)), replacing = item.operation === 'Replace';
    if (!/^LAN\d+$/.test(String(item.iface))) throw new Error('Choose a valid LAN interface');
    if (replacing && (!oldKey || !old.IP || String(old.IP) !== String(item.current).split('/')[0]) && !item.newElementKey) throw new Error('The original address changed; refresh before replacing it');
    if (replacing && old.IP && protectedLan(old)) throw new Error('The management or protected address cannot be replaced');
    const separate = replacing || item.operation === 'Add' && !!item.current && !!oldKey;
    let key = String(separate ? item.newElementKey ?? '' : item.elementKey ?? '');
    if (key && !rows[key]) throw new Error('The saved network element is unavailable; refresh before retrying');
    if (!key) {
      if (item.createState) throw new Error('A previous address creation has an unknown outcome. Refresh before retrying.');
      await this.receipt('lan', item, { createState: 'pending' }, signal);
      const result = await client.action({ new: ['CyElement.LanIp'] }, signal);
      if (typeof result[1] !== 'string') throw new Error('Controller did not return a network identity');
      key = result[1]; await this.receipt('lan', item, { [separate ? 'newElementKey' : 'elementKey']: key, createState: null }, signal);
    }
    for (const changes of [{ interface: String(item.iface) }, { mask: desired.mask }, { ip: desired.ip }, { where: 'etc' }]) await client.update(key, changes, signal);
    const verify = async () => {
      const fresh = await this.connect(device, signal, desired.ip);
      const row = object(fresh.config.IP?.[key]);
      if (row.IP !== desired.ip || String(row.mask) !== desired.mask || row.Interface !== item.iface) { fresh.close(); throw new Error('New address could not be verified; the old address was retained'); }
      return fresh;
    };
    const fresh = await verify(); fresh.close();
    if (replacing && oldKey !== key && old.IP) {
      try { await client.action({ delete: [oldKey] }, signal); }
      catch (error) {
        signal.throwIfAborted();
        const check = await verify(); try { if (check.config.IP?.[oldKey]) throw error; } finally { check.close(); }
      }
    }
    const final = await verify();
    try { if (replacing && oldKey !== key && final.config.IP?.[oldKey]) throw new Error('Old address removal could not be verified'); } finally { final.close(); }
    const saved = await this.repository.update(plan => {
      const row = plan.lans.find(row => row.id === item.id); if (row) Object.assign(row, { elementKey: key, newElementKey: null, createState: null });
      const controller = plan.devices.find(row => row.id === device.id); if (controller) Object.assign(controller, { alias: desired.ip, ...(replacing ? { address: desired.ip } : {}) });
    }, signal);
    return { elementKey: key, revision: saved.revision, verified: true, devicePatch: { alias: desired.ip, ...(replacing ? { address: desired.ip } : {}) } };
  }
}
