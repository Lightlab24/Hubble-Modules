import { CyanviewClient } from './transport.js';
import { PlanRepository } from './repository.js';
import { addressParts, lensParameters, normalizedLabel, object, validIp, type RecordValue } from './model.js';
import { optionEntries } from './normalize.js';
import { isRemiModel, remiCamera } from './remi-model.js';
import type { RemiOperations } from './remi.js';

export type ClientFactory = (address: string) => CyanviewClient;
const enabled = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
const advanced = (field: string) => /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.test(field) || field === 'lensIp';
const protectedLan = (row: RecordValue) => enabled(row.ReadOnly) || enabled(row.NoDelete) || String(row.IP).startsWith('10.192.');
export class ConfigurationOperations {
  private queues = new Map<string, Promise<unknown>>();
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
  run(input: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    if (Array.isArray(input.items)) return this.batch(input.items, signal);
    const item = object(input.item), deviceId = String(item.device ?? '');
    if (!deviceId || !item.id || !['camera', 'lan'].includes(input.kind)) return Promise.reject(new Error('Choose a valid configuration row'));
    const rows = this.rowQueues.get(deviceId) ?? new Map<string, Promise<unknown>>(), rowKey = `${input.kind}:${item.id}`;
    const exclusive = input.kind === 'lan' && item.operation !== 'Add';
    // Independent rows start together. Replacing network settings waits for
    // writes that still use the controller's previous connection address.
    const previous = [this.queues.get(deviceId), ...(exclusive ? rows.values() : [rows.get(rowKey)])];
    const task = Promise.all(previous.map(task => task?.catch(() => undefined))).then(async () => {
      signal.throwIfAborted();
      if (input.kind === 'camera' && !input.deleting && this.repository.cameraWasDeleted(item.id)) throw new Error('This camera was deleted; add a new camera before sending more edits');
      const { plan } = await this.repository.read(signal), device = plan.devices.find(device => device.id === deviceId);
      if (!device) throw new Error('Controller is no longer in the managed list');
      const saved = (input.kind === 'camera' ? plan.cameras : plan.lans).find(row => row.id === item.id);
      const target = { ...item, ...(saved?.elementKey ? { elementKey: saved.elementKey } : {}), ...(saved?.newElementKey ? { newElementKey: saved.newElementKey } : {}), needsInitialization: saved?.needsInitialization ?? item.needsInitialization, createState: saved?.createState ?? item.createState };
      const numbers = this.cameraNumbers.get(deviceId) ?? new Set<number>();
      const number = input.kind === 'camera' && !input.deleting ? Number(item.number) : null;
      if (number !== null && numbers.has(number)) throw new Error('That camera number is already being sent on this controller');
      if (number !== null) { numbers.add(number); this.cameraNumbers.set(deviceId, numbers); }
      let client: CyanviewClient | undefined;
      try {
        client = await this.connect(device, signal);
        return input.kind === 'camera' ? await this.camera(client, device, target, input, signal) : await this.lan(client, device, target, input, signal);
      } finally {
        client?.close();
        if (number !== null) { numbers.delete(number); if (!numbers.size) this.cameraNumbers.delete(deviceId); }
      }
    });
    if (exclusive) this.queues.set(deviceId, task);
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
    const results = await Promise.all(items.map(async value => {
      const input = object(value), item = object(input.item);
      try { return { ...await this.run(input, signal), kind: input.kind, id: item.id }; }
      catch (error) { return { kind: input.kind, id: item.id, error: error instanceof Error ? error.message : 'Settings could not be confirmed' }; }
    }));
    const saved = await this.repository.read(signal);
    for (const result of results) {
      const row = (result.kind === 'camera' ? saved.plan.cameras : saved.plan.lans).find(row => row.id === result.id);
      if (row) for (const field of ['elementKey', 'newElementKey', 'createState', 'needsInitialization']) if (row[field] !== undefined) Object.assign(result, { [field]: row[field] });
    }
    return { results, revision: saved.revision };
  }
  private async camera(client: CyanviewClient, device: RecordValue, item: RecordValue, input: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    let key = String(item.elementKey ?? ''), created = item.needsInitialization === true;
    const fields: string[] = Array.isArray(input.fields) ? input.fields.filter((field: unknown) => typeof field === 'string') : [];
    const before = client.config.Camera?.[key] as RecordValue | undefined;
    if (isRemiModel(before?.Model)) throw new Error('Use REMI to remove an imported camera or edit it on its source');
    if (before) await this.remi?.assertCameraReady(device.id, key, signal);
    if (input.deleting) {
      if (key && client.config.Camera?.[key]) await client.action({ delete: [key] }, signal);
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
    const fresh = await this.connect(device, signal);
    let changed = false;
    let verifiedCamera: ReturnType<typeof remiCamera>;
    try {
      const observed = object(fresh.config.Camera?.[key]);
      const matches = (row: RecordValue, field: string, value: unknown) => {
        if (field === 'usb') return String(object(row.Interface).port) === value;
        if (field === 'lensDisconnected') return !object(row.LensInterface).port;
        if (field === 'lensConnection') return ['device', 'port'].every(part => String(object(row.LensInterface)[part]) === String(object(value)[part]));
        if (field === 'Model') return normalizedLabel(row.Model) === normalizedLabel(value);
        return String(row[field] ?? '') === String(value);
      };
      for (const [field, value] of Object.entries(expected)) {
        if (!matches(observed, field, value)) throw new Error('Camera configuration could not be verified through a fresh connection');
        if (before && !matches(before, field, value)) changed = true;
      }
      verifiedCamera = remiCamera(key, fresh.config);
    } finally { fresh.close(); }
    const saved = await this.receipt('camera', item, { elementKey: key, createState: null, needsInitialization: false, isNew: false }, signal);
    const result: RecordValue = { elementKey: key, revision: saved.revision, verified: true };
    if (before && changed && this.remi) {
      const previous = { key, name: String(before.Name ?? ''), number: String(before.Number ?? '') };
      try { Object.assign(result, await this.remi.cameraChanged(device, previous, verifiedCamera, signal)); }
      catch (error) {
        result.remiRefresh = true;
        result.remiError = error instanceof Error ? error.message : 'REMI refresh could not be completed';
      }
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
