import { CyanviewClient } from './transport.js';
import { PlanRepository } from './repository.js';
import { addressParts, baseFromSerial, lensParameters, normalizedLabel, object, validIp, type Plan, type RecordValue } from './model.js';
import { baseRow, normalizeSnapshot, optionEntries, wanRow } from './normalize.js';
import { isRemiModel, remiCamera, remiEntries } from './remi-model.js';
import type { RemiOperations } from './remi.js';

export type ClientFactory = (address: string) => CyanviewClient;
/** What is already known of each controller's connections, so settings work can use them instead of opening its own. */
export type HeldControllers = {
  /** The settings socket held open on a controller, lent for a piece of work. Nothing when none is usable. */
  lend(device: RecordValue): CyanviewClient | undefined;
  /**
   * Some work opened a socket of its own on a controller. Until the returned function is called, and for a moment
   * after, the held socket isn't lent: a controller reports a change to each socket separately, so the held one can
   * be a moment behind what that work changed. Work on the one held socket is always in order.
   */
  opened(device: RecordValue): () => void;
  /** True for a controller a settings socket is held on, or kept being tried on. */
  watched(device: RecordValue): boolean;
  /** True when a watched controller answers on neither its settings socket nor MQTT, so it isn't worth waiting on. */
  down(device: RecordValue): boolean;
};
/** A controller's held socket when it is that controller's and usable, so a caller can fall back to its own. */
export const lentSocket = (held: HeldControllers | undefined, device: RecordValue) => {
  const client = held?.lend(device);
  return client && client.connected && client.serial === device.serial ? client : undefined;
};
/** A socket of its own on a controller, for work the held one can't be lent to. Closing it says the work is done. */
export async function ownSocket(held: HeldControllers | undefined, factory: ClientFactory, device: RecordValue, signal: AbortSignal, address: string = device.address || device.base): Promise<CyanviewClient> {
  const client = factory(address), done = held?.opened(device) ?? (() => {});
  const close = client.close.bind(client);
  client.close = () => { done(); close(); };
  try { await client.connect(signal); return client; }
  catch (error) { client.close(); throw error; }
}
const enabled = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
const advanced = (field: string) => /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.test(field) || field === 'lensIp';
// The controller's own base address, and what it marks ReadOnly or NoDelete. A LAN address someone put in 10.192 is
// an ordinary address that can be replaced.
const protectedLan = (row: RecordValue, device: RecordValue) => enabled(row.ReadOnly) || enabled(row.NoDelete) || (!!row.IP && [baseFromSerial(String(device.serial ?? '')), String(device.base ?? '')].includes(String(row.IP)));
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
export class ConfigurationOperations {
  private queues = new Map<string, Promise<unknown>>();
  // Sends still working through a controller, which a network change has to wait for.
  private batches = new Map<string, Set<Promise<void>>>();
  private rowQueues = new Map<string, Map<string, Promise<unknown>>>();
  private cameraNumbers = new Map<string, Set<number>>();
  constructor(private repository: PlanRepository, private client: ClientFactory = address => new CyanviewClient(address), private remi?: RemiOperations, private held?: HeldControllers) {}
  private async connect(device: RecordValue, signal: AbortSignal, address = device.address || device.base): Promise<CyanviewClient> {
    const client = await ownSocket(this.held, this.client, device, signal, address);
    if (client.serial !== device.serial) { client.close(); throw new Error('Controller identity changed; refresh before sending'); }
    return client;
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
      // An address change goes over a socket of its own, on the controller's base address when that answers.
      const network = input.kind === 'lan' && item.type !== 'WAN' && item.operation !== 'Keep';
      let client: CyanviewClient | undefined;
      try {
        client = network ? await this.connectForNetwork(device, signal) : session ? await session.client(device, signal) : await this.connect(device, signal);
        return input.kind === 'camera' ? await this.camera(client, device, target, input, signal, session) : await this.lan(client, device, target, input, signal);
      } finally {
        if (!session || network) client?.close();
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
    // A send goes down the socket already held on each controller. It is opened afresh only where none is held.
    const session = new ControllerSession(async (device, opening) => lentSocket(this.held, device) ?? this.connect(device, opening), async reading => (await this.repository.read(reading)).plan);
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
            // Each result names its controller, so the log can say where a send failed.
            try { results[index] = { ...await this.run(input, signal, session), kind: input.kind, id: item.id, device: item.device }; }
            catch (error) { results[index] = { kind: input.kind, id: item.id, device: item.device, error: error instanceof Error ? error.message : 'Settings could not be confirmed' }; }
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
    const port = String(item.port ?? '').trim();
    if (!usb && fields.includes('port') && port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Enter a camera port between 1 and 65535');
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
    // The controller gives each model its own port (a Burano's endpoint needs 22, which a RIO sets with the
    // model and doesn't list on the camera). Sending Hubble's blank Port emptied that endpoint and the RIO
    // never built the camera's control (Nov 17, 2026). The user's rule: the port the RIO loads stands, and
    // goes only when someone types one, never with a new camera or a model change.
    if (!usb) for (const [field, label] of [['ip', 'IP'], ['port', 'Port'], ['login', 'Login'], ['password', 'Password']] as const) if (created || fields.includes('model') || fields.includes(field)) {
      const value = String(item[field] ?? '').trim();
      if (field === 'port' && (!value || !fields.includes('port'))) continue;
      const mapping = await client.mapping(key, label, signal);
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
    // Lens None means nothing about the lens is sent, so a camera with no lens never waits on one. The
    // only exception is a camera that already had a lens before this send: None then takes it off,
    // if the controller offers a way to.
    const noLens = !item.lens || item.lens === 'None';
    const removeLens = noLens && !created && fields.includes('lens') && !!before?.LensModel;
    if (noLens ? removeLens : fields.includes('lens') || created) {
      const choices = optionEntries(await client.option(key, 'LensModel', signal));
      const choice = noLens
        ? choices.find(choice => !choice.label || normalizedLabel(choice.label) === 'none')
        : choices.find(choice => normalizedLabel(choice.label) === normalizedLabel(item.lens));
      if (choice) { await client.action(choice.request, signal); expected.LensModel = noLens ? '' : choice.label; }
      else if (!noLens) throw new Error('Selected lens model is unavailable');
    }
    if (fields.includes('lensPort') && item.lens !== 'None' && item.lensPort) {
      // The connections a controller lists are for the lens it has, so a lens set in this send has to land
      // first. A RIO then sets that lens up for a moment and can drop a connection made meanwhile, so it
      // is left to go quiet first, and a connection that still didn't hold is made again.
      const lensChanged = expected.LensModel !== undefined;
      if (lensChanged) {
        await client.waitFor(config => config.Camera?.[key]?.LensModel === expected.LensModel, signal);
        await client.settle(300, 1500, signal);
      }
      const connected = (description: unknown) => ['device', 'port'].every(part => String(object(client.config.Camera?.[key]?.LensInterface)[part]) === String(object(description)[part]));
      for (let attempt = 0; ; attempt++) {
        const choices = optionEntries(await client.option(key, 'LensInterface', signal));
        if (item.lensPort === 'None') {
          if (object(client.config.Camera?.[key]?.LensInterface).port) {
            const choice = choices.find(choice => !choice.label || normalizedLabel(choice.label) === 'none');
            if (!choice) throw new Error('This controller does not offer a verified lens disconnect command');
            await client.action(choice.request, signal); expected.lensDisconnected = true;
          }
          break;
        }
        const choice = choices.find(choice => normalizedLabel(choice.label) === normalizedLabel(item.lensPort));
        if (!choice) throw new Error('The selected lens connection is unavailable');
        if (choice.description?.status !== 'current') await client.action(choice.request, signal);
        expected.lensConnection = choice.description;
        if (!lensChanged || attempt === 2) break;
        await client.settle(300, 1500, signal);
        if (connected(choice.description)) break;
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
      // A model can take a setting the controller never lists on the camera: a real RIO took a Burano's
      // Port and didn't show it (Nov 17, 2026), so it can't be checked and isn't held against the send.
      if (['IP', 'Port', 'Login', 'Password'].includes(field) && Object.keys(row).length && !(field in row)) return true;
      return String(row[field] ?? '') === String(value);
    };
    // The socket a send shares gets the controller's own push of what changed.
    const waited = performance.now();
    if (session) await client.waitFor(config => Object.entries(expected).every(([field, value]) => matches(object(config.Camera?.[key]), field, value)), signal).catch(() => signal.throwIfAborted());
    const fresh = session ? client : await this.connect(device, signal);
    let changed = false;
    let verifiedCamera: ReturnType<typeof remiCamera>;
    try {
      const observed = object(fresh.config.Camera?.[key]);
      for (const [field, value] of Object.entries(expected)) {
        if (!matches(observed, field, value)) throw new Error('Camera configuration could not be verified through a fresh connection');
        if (before && !matches(before, field, value)) changed = true;
      }
      verifiedCamera = remiCamera(key, fresh.config);
    } finally { if (!session) fresh.close(); }
    const patch = { elementKey: key, createState: null, needsInitialization: false, isNew: false };
    const result: RecordValue = { elementKey: key, verified: true };
    // A new camera or a new model takes the controller's port for that model. When the controller doesn't
    // list it on the camera (a Burano's 22), its endpoint says it, so the row shows what the RIO loaded.
    if (!usb && (created || fields.includes('model')) && !('Port' in object(client.config.Camera?.[key]))) {
      const ports = await client.readEndpointPorts(signal);
      if (ports.has(key)) result.port = ports.get(key);
    }
    // How long the controller took to report the change back, which is its own time and not the send's.
    if (session) result.confirmMs = Math.round(performance.now() - waited);
    if (session) session.receipts.push({ item, patch });
    else result.revision = (await this.receipt('camera', item, patch, signal)).revision;
    // Any change to a camera that is REMI'd elsewhere takes its copies off and imports them again, because a
    // controller doesn't update a copy it already holds (camera 11 renumbered 6 stayed 11 on the RCP, Nov 12).
    // Sending a value the controller already had changes nothing and leaves the copies alone.
    if (before && changed && this.remi) {
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
  /**
   * Setup mode: an RCP back to its base address alone, so it can be set up again. Every LAN address it has is
   * deleted, however many, and its WAN goes to Static with no address, gateway or DNS. All of it goes over the base
   * address, because the address Hubble reached the RCP by may be one of those being deleted. An RCP that doesn't
   * answer there is left exactly as it is. Its cameras are cleared by the page, the way Clear all clears them.
   */
  clearNetwork(input: RecordValue, signal: AbortSignal, progress: (deviceId: string, done: number, total: number) => void = () => {}): Promise<RecordValue> {
    const deviceId = String(input.device ?? ''), lans = input.lans !== false, wan = input.wan !== false;
    if (!deviceId) return Promise.reject(new Error('Choose an RCP to clear'));
    // Like any other network change, it waits for every send already working on this controller.
    const rows = this.rowQueues.get(deviceId);
    const previous = [this.queues.get(deviceId), ...(rows ? rows.values() : []), ...(this.batches.get(deviceId) ?? [])];
    const task = Promise.all(previous.map(task => task?.catch(() => undefined))).then(async () => {
      signal.throwIfAborted();
      const device = (await this.repository.read(signal)).plan.devices.find(row => row.id === deviceId);
      if (!device) throw new Error('Controller is no longer in the managed list');
      const name = String(device.name || device.serial), serial = String(device.serial ?? '');
      if (!/^CY-RCP-/i.test(serial)) throw new Error('Setup mode clears RCPs only; ' + name + ' is left as it is');
      const base = baseFromSerial(serial) || String(device.base ?? '');
      if (!validIp(base)) throw new Error(name + ' has no base address, so nothing on it was changed');
      let client: CyanviewClient;
      try { client = await ownSocket(this.held, this.client, device, signal, base); }
      catch { signal.throwIfAborted(); throw new Error(name + ' didn’t answer on its base address ' + base + ', so nothing on it was changed'); }
      try {
        if (client.serial !== device.serial) throw new Error('Another controller answered at ' + base + ', so nothing was changed');
        const entries = Object.entries(object(client.config.IP)).map(([key, raw]) => [key, object(raw)] as const);
        const own = baseRow(entries.map(([key, row]) => ({ key, ...row })), serial);
        if (!own || own.IP !== base) throw new Error(name + ' doesn’t list ' + base + ' as its base address, so nothing on it was changed');
        const isWan = wanRow;
        // What the controller lets go of: its own addresses are ReadOnly, and the WAN and its base are NoDelete.
        // A blank address element, which reads as a WAN and isn't one, goes with the LAN addresses.
        const deleting = lans ? entries.filter(([key, row]) => key !== own.key && !isWan(row) && !enabled(row.ReadOnly) && !enabled(row.NoDelete)).map(([key]) => key) : [];
        // The WAN the controller itself keeps is NoDelete. Anything else that reads as one comes second.
        const wans = entries.filter(([, row]) => isWan(row) && !enabled(row.ReadOnly));
        const wanEntry = wan ? wans.find(([, row]) => enabled(row.NoDelete)) ?? wans[0] : undefined;
        const wanBlank = (row: RecordValue) => !enabled(row.DHCP) && ['IP', 'Gateway', 'DNS1', 'DNS2'].every(field => !String(row[field] ?? '').trim());
        const wanChange = !!wanEntry && !wanBlank(wanEntry[1]);
        const total = deleting.length + (wanChange ? 1 : 0);
        let done = 0;
        progress(deviceId, done, total);
        for (const key of deleting) {
          const gone = (config: RecordValue) => !object(config.IP)[key];
          try { await client.action({ delete: [key] }, signal); }
          catch (error) {
            // A reply can be lost after the controller has done it, so what it reports decides.
            signal.throwIfAborted();
            if (!client.connected) throw error;
          }
          try { await client.waitFor(gone, signal); }
          catch { signal.throwIfAborted(); throw new Error('LAN address ' + String(object(object(client.config.IP)[key]).IP || key) + ' on ' + name + ' could not be deleted'); }
          progress(deviceId, ++done, total);
        }
        if (wanEntry && wanChange) {
          const [key, row] = wanEntry;
          await this.wan(client, { dhcp: false, planned: '', gateway: '', dns1: '', dns2: '' }, key, row, ['dhcp', 'planned', 'gateway', 'dns1', 'dns2'], signal);
          progress(deviceId, ++done, total);
        }
        const snapshot = normalizeSnapshot(client.config, base);
        const saved = await this.repository.update(plan => {
          const cleared = new Set(deleting);
          plan.lans = plan.lans.filter(row => row.device !== deviceId || !row.elementKey || !cleared.has(String(row.elementKey)));
          const wanRow = wanEntry && plan.lans.find(row => row.device === deviceId && row.elementKey === wanEntry[0]);
          if (wanRow) Object.assign(wanRow, { current: '', planned: '', dhcp: false, gateway: '', dns1: '', dns2: '', operation: 'Keep', result: 'In sync', pending: false, dirty: [] });
          const controller = plan.devices.find(row => row.id === deviceId);
          if (controller) Object.assign(controller, { base, address: base, ...(lans ? { alias: '' } : {}) });
        }, signal);
        return { device: deviceId, deleted: deleting.length, wan: wanChange, revision: saved.revision, snapshot };
      } finally { client.close(); }
    });
    this.queues.set(deviceId, task);
    const cleanup = () => { if (this.queues.get(deviceId) === task) this.queues.delete(deviceId); };
    void task.then(cleanup, cleanup);
    return task;
  }
  /**
   * A WAN's mode, address, gateway and DNS, written the way Cyanview's own page wrote them on a RIO WAN
   * (captured Nov 17, 2026): DHCP through the on or off command the controller itself offers, then the
   * address and the mask as separate writes. Turning DHCP on blanks the address, mask, gateway and DNS in
   * that one command, so nothing else is sent with it.
   */
  private async wan(client: CyanviewClient, item: RecordValue, key: string, old: RecordValue, fields: string[], signal: AbortSignal): Promise<RecordValue> {
    if (!key || enabled(old.ReadOnly)) throw new Error('This network interface is read-only');
    const addressing = fields.some(field => ['dhcp', 'planned'].includes(field)), wasDhcp = enabled(old.DHCP);
    const expected: RecordValue = {};
    if (addressing && item.dhcp === true) {
      if (!wasDhcp) await client.action(await this.dhcpCommand(client, key, true, signal), signal);
      // What a DHCP server hands out hasn't been seen yet, so only the mode is checked.
      expected.DHCP = true;
    } else {
      if (addressing) {
        // Static can have no address. The RIO's own page clears the address with an empty ip and the
        // mask with "0", and DHCP on already leaves both blank, so a blank address writes only what's set.
        const blank = !String(item.planned ?? '').trim();
        const desired = blank ? { ip: '', mask: '0' } : addressParts(String(item.planned));
        if (wasDhcp) await client.action(await this.dhcpCommand(client, key, false, signal), signal);
        if (blank ? String(old.IP ?? '') !== '' : wasDhcp || String(old.IP ?? '') !== desired.ip) await client.update(key, { ip: desired.ip }, signal);
        if (blank ? !['', '0'].includes(String(old.mask ?? '')) : wasDhcp || String(old.mask ?? '') !== desired.mask) {
          const mapping = await client.mapping(key, 'mask', signal);
          await client.update(mapping.key, { [mapping.property]: desired.mask }, signal);
        }
        Object.assign(expected, { DHCP: false, IP: desired.ip });
        if (!blank) expected.mask = desired.mask;
      }
      for (const [field, label] of [['gateway', 'Gateway'], ['dns1', 'DNS1'], ['dns2', 'DNS2']] as const) if (fields.includes(field)) {
        const value = String(item[field] ?? '').trim();
        if (value && !validIp(value)) throw new Error('Enter a valid gateway or DNS address');
        expected[label] = value;
        if (String(old[label] ?? '') === value) continue;
        const mapping = await client.mapping(key, label, signal);
        await client.update(mapping.key, { [mapping.property]: value }, signal);
      }
    }
    // The controller pushes its whole configuration after each write, so the check reads the same socket.
    const written = (config: RecordValue) => {
      const row = object(object(config.IP)[key]);
      return Object.entries(expected).every(([field, value]) => field === 'DHCP' ? enabled(row.DHCP) === value : String(row[field] ?? '') === value);
    };
    try { await client.waitFor(written, signal); }
    catch { signal.throwIfAborted(); throw new Error('Network settings could not be verified'); }
    return { elementKey: key, verified: true };
  }
  /** The controller's own command for turning its WAN's DHCP on or off, the one its page sends. */
  private async dhcpCommand(client: CyanviewClient, key: string, on: boolean, signal: AbortSignal): Promise<RecordValue> {
    const reply = await client.option(key, 'DHCP', signal);
    const command = object((Array.isArray(reply) ? reply : []).find(entry => Array.isArray(entry) && entry[0] === on)?.[1]);
    const update = object(command.update);
    if (update.key !== key || typeof object(update.changes).dhcp !== 'string') throw new Error('This controller doesn’t offer DHCP for its WAN');
    return command;
  }
  private async lan(client: CyanviewClient, device: RecordValue, item: RecordValue, input: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    const rows = object(client.config.IP), fields: string[] = Array.isArray(input.fields) ? input.fields : [];
    if (item.type === 'WAN') {
      const key = String(item.elementKey ?? Object.keys(rows).find(key => rows[key].IP === String(item.current).split('/')[0] && rows[key].Interface === item.iface) ?? '');
      return this.wan(client, item, key, object(rows[key]), fields, signal);
    }
    if (!['Add', 'Replace', 'Keep', 'Delete'].includes(item.operation)) throw new Error('Choose Add, Replace or Delete');
    if (item.operation === 'Keep') {
      if (item.planned !== item.current) throw new Error('Choose Add or Replace for the changed address');
      return { verified: true, elementKey: String(item.elementKey ?? '') };
    }
    return item.operation === 'Delete' ? this.removeAddress(client, device, item, signal) : this.setAddress(client, device, item, signal);
  }
  /**
   * The socket an address change goes over: the controller's own base address when it answers there as itself,
   * because that address is never the one being changed or removed, and an address Hubble last reached it by may
   * already be gone. Otherwise the address it is usually reached by.
   */
  private async connectForNetwork(device: RecordValue, signal: AbortSignal): Promise<CyanviewClient> {
    const base = baseFromSerial(String(device.serial ?? '')) || String(device.base ?? '');
    if (validIp(base) && base !== String(device.address || device.base)) {
      const opened = await this.reach(device, [base], signal);
      if (opened) return opened;
    }
    return this.connect(device, signal);
  }
  /** Another Cyanview controller that already answers at an address, by its serial. Only a look: nothing is written. */
  private async holderOf(address: string, device: RecordValue, signal: AbortSignal): Promise<string> {
    let probe: CyanviewClient | undefined;
    try {
      probe = this.client(address);
      await probe.connect(AbortSignal.any([signal, AbortSignal.timeout(1500)]));
      return probe.serial && probe.serial !== device.serial ? probe.serial : '';
    } catch { signal.throwIfAborted(); return ''; }
    finally { probe?.close(); }
  }
  /** The controller again, at the first of these addresses where it answers as itself. */
  private async reach(device: RecordValue, addresses: string[], signal: AbortSignal): Promise<CyanviewClient | undefined> {
    for (const address of new Set(addresses.filter(validIp))) {
      try {
        const opened = await ownSocket(this.held, this.client, device, AbortSignal.any([signal, AbortSignal.timeout(3000)]), address);
        if (opened.serial === device.serial) return opened;
        opened.close();
      } catch { signal.throwIfAborted(); }
    }
    return undefined;
  }
  /**
   * A LAN address set on the controller. Changing an address rewrites the one the controller already has, in place,
   * so it never ends up with the old address and the new one (Nov 23, 2026: the change used to add the new address,
   * look for the controller at it, and only then delete the old one; when that look found another controller, or
   * nothing, both addresses stayed). A new address is the only thing that makes a new element, and one that can't be
   * finished is taken off again. What the controller reports back on the same socket confirms it.
   */
  private async setAddress(client: CyanviewClient, device: RecordValue, item: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    const rows = object(client.config.IP), name = String(device.name || device.serial), desired = addressParts(String(item.planned)), replacing = item.operation === 'Replace';
    const base = baseFromSerial(String(device.serial ?? '')) || String(device.base ?? '');
    const ownKey = String(item.elementKey ?? (replacing ? Object.keys(rows).find(key => rows[key].IP === String(item.current).split('/')[0] && rows[key].Interface === item.iface) ?? '' : ''));
    // Add on a row that already has an address keeps that address and makes another beside it.
    const beside = !replacing && !!item.current && !!ownKey;
    let key = beside ? String(item.newElementKey ?? '') : ownKey;
    if (replacing && (!key || !rows[key])) throw new Error('This address is no longer on ' + name + '. Refresh, then set it again.');
    // An address this row started and that has since gone from the controller is simply made again.
    if (key && !rows[key]) key = '';
    const old = key ? object(rows[key]) : {};
    if (key && protectedLan(old, device)) throw new Error('The management or protected address cannot be replaced');
    // A blank element that reads as a WAN would become a second WAN if an address were written to it.
    if (key && String(old.Type ?? '').toUpperCase().includes('WAN')) throw new Error('This blank entry on ' + name + ' can only be removed');
    // A blank address element has no interface yet, and takes the one the controller's own address is on.
    const entries: RecordValue[] = Object.entries(rows).map(([other, row]) => ({ key: other, ...object(row) }));
    const iface = String(old.Interface || item.iface || baseRow(entries, String(device.serial ?? ''))?.Interface || 'LAN1');
    if (!/^LAN\d+$/.test(iface)) throw new Error('Choose a valid LAN interface');
    if (entries.some(row => row.key !== key && row.IP === desired.ip)) throw new Error(desired.ip + ' is already on ' + name + ' as another address');
    if (String(old.IP ?? '') !== desired.ip) {
      const holder = await this.holderOf(desired.ip, device, signal);
      if (holder) throw new Error(desired.ip + ' is already ' + holder + '’s address, so nothing was changed. Change or remove it there first.');
    }
    let created = false;
    if (!key) {
      if (item.createState) throw new Error('A previous address creation has an unknown outcome. Refresh before retrying.');
      await this.receipt('lan', item, { createState: 'pending' }, signal);
      let result: unknown;
      try { result = await client.action({ new: ['CyElement.LanIp'] }, signal); }
      catch (error) {
        // A controller that said no made nothing, so there is nothing unknown about it.
        if (error instanceof Error && /rejected/.test(error.message)) await this.receipt('lan', item, { createState: null }, signal).catch(() => undefined);
        throw error;
      }
      if (!Array.isArray(result) || typeof result[1] !== 'string') throw new Error('Controller did not return a network identity');
      key = result[1]; created = true;
      await this.receipt('lan', item, { [beside ? 'newElementKey' : 'elementKey']: key, createState: null }, signal);
    }
    // Only what differs is written, in the order Cyanview's own page saved an address, ending with the save itself.
    const write = async (target: CyanviewClient) => {
      const now = object(object(target.config.IP)[key]);
      if (created || !String(now.Interface ?? '').trim()) await target.update(key, { interface: iface }, signal);
      if (created || String(now.mask ?? '') !== desired.mask) await target.update(key, { mask: desired.mask }, signal);
      if (created || String(now.IP ?? '') !== desired.ip) await target.update(key, { ip: desired.ip }, signal);
      await target.update(key, { where: 'etc' }, signal);
    };
    const written = (config: RecordValue) => { const row = object(object(config.IP)[key]); return row.IP === desired.ip && String(row.mask) === desired.mask && row.Interface === iface; };
    let work = client, reopened: CyanviewClient | undefined;
    try {
      if (!written(work.config)) {
        try { await write(work); }
        catch (error) {
          signal.throwIfAborted();
          if (work.connected) throw error;
          // The socket went with the address it was on. The controller is found again and the rest is written there.
          reopened = await this.reach(device, [base, desired.ip, String(device.address ?? '')], signal);
          if (!reopened) throw new Error(name + ' stopped answering while its address was changed. Look for it at ' + desired.ip + ', then Refresh.');
          work = reopened;
          if (!object(work.config.IP)[key]) throw new Error('The address could not be confirmed on ' + name);
          // Whatever is still missing, and the save, which the lost socket may never have carried.
          await write(work);
        }
      }
      try { await work.waitFor(written, signal); }
      catch { signal.throwIfAborted(); throw new Error('The new address could not be confirmed on ' + name); }
    } catch (error) {
      // An address made for this send and never finished is taken off again, so nothing half-made is left.
      if (created && work.connected && !signal.aborted) {
        const removed = await work.action({ delete: [key] }, signal).then(() => true, () => false);
        if (removed) await this.receipt('lan', item, { [beside ? 'newElementKey' : 'elementKey']: null, createState: null }, signal).catch(() => undefined);
      }
      reopened?.close();
      throw error;
    }
    const alias = normalizeSnapshot(work.config, work.address).device.alias || desired.ip;
    // A controller that was reached by the address just replaced is reached from now on where it answered.
    const moved = replacing && !!old.IP && old.IP !== desired.ip && String(device.address ?? '') === String(old.IP);
    const devicePatch = { alias, ...(moved ? { address: work.address } : {}) };
    reopened?.close();
    const saved = await this.repository.update(plan => {
      const row = plan.lans.find(row => row.id === item.id); if (row) Object.assign(row, { elementKey: key, newElementKey: null, createState: null });
      const controller = plan.devices.find(row => row.id === device.id); if (controller) Object.assign(controller, devicePatch);
    }, signal);
    return { elementKey: key, revision: saved.revision, verified: true, devicePatch };
  }
  /**
   * A LAN address taken off the controller. Its base address and its WAN stay, and so does the address Hubble is
   * reaching it by when its base address doesn't answer, since removing that one would lose the controller.
   */
  private async removeAddress(client: CyanviewClient, device: RecordValue, item: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    const name = String(device.name || device.serial), key = String(item.elementKey ?? ''), old = object(object(client.config.IP)[key]);
    const present = !!key && !!object(client.config.IP)[key];
    if (present) {
      if (protectedLan(old, device) || wanRow(old)) throw new Error('This address is ' + name + '’s own and can’t be removed');
      if (old.IP && client.address === String(old.IP)) throw new Error('Hubble reaches ' + name + ' through ' + old.IP + ' and its base address doesn’t answer, so it was left in place');
      try { await client.action({ delete: [key] }, signal); }
      catch (error) {
        // A reply can be lost after the controller has done it, so what it reports decides.
        signal.throwIfAborted();
        if (!client.connected) throw error;
      }
      try { await client.waitFor(config => !object(config.IP)[key], signal); }
      catch { signal.throwIfAborted(); throw new Error((old.IP || 'The blank address') + ' could not be removed from ' + name); }
    }
    // An address that was only ever planned, or that has already gone from the controller, just leaves the list.
    const alias = normalizeSnapshot(client.config, client.address).device.alias;
    const moved = !!old.IP && String(device.address ?? '') === String(old.IP);
    const devicePatch = { alias, ...(moved ? { address: client.address } : {}) };
    const saved = await this.repository.update(plan => {
      plan.lans = plan.lans.filter(row => row.id !== item.id && !(present && row.device === device.id && row.elementKey === key));
      const controller = plan.devices.find(row => row.id === device.id); if (controller) Object.assign(controller, devicePatch);
    }, signal);
    return { deleted: true, elementKey: key, revision: saved.revision, verified: true, devicePatch };
  }
}
