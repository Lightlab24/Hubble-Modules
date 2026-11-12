import { object, stable, validIp, type Plan, type RecordValue } from './model.js';
import { normalizeSnapshot } from './normalize.js';
import type { ClientFactory } from './operations.js';
import type { PlanRepository } from './repository.js';
import {
  describeRemiOrigins, isRemiModel, remiAddresses, remiCamera, remiEntries, remiLabel, remiTagRelay, samePeer,
  type RemiCamera, type RemiEntry, type RemiLink, type RemiRefresh, type RemiSelector, type RemiStep,
} from './remi-model.js';
import type { CyanviewClient } from './transport.js';

type Receipt = Awaited<ReturnType<PlanRepository['readRemi']>>;
type Snapshot = ReturnType<typeof normalizeSnapshot>;
type Observed = { device: RecordValue; config: RecordValue; entries: RemiEntry[]; selectors: Map<string, RemiSelector> };
const message = (error: unknown) => error instanceof Error ? error.message : 'REMI operation failed';
const cameraKeys = (config: RecordValue) => Object.keys(object(config.Camera));
const linkKey = (link: RemiLink) => JSON.stringify([link.receiver, link.entry.localKey]);
const sameEntry = (a: RemiEntry, b: RemiEntry) => a.selector === b.selector && a.connection === b.connection &&
  a.importer === b.importer && a.peer === b.peer;
const isImported = (entry: RemiEntry, config: RecordValue) =>
  entry.enabled && !!entry.localKey && isRemiModel(config.Camera?.[entry.localKey]?.Model);

export class RemiOperations {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private repository: PlanRepository, private factory: ClientFactory) {}

  private enqueue<T>(run: () => Promise<T>) {
    const task = this.tail.catch(() => undefined).then(run);
    this.tail = task;
    return task;
  }

  private device(plan: Plan, id: unknown) {
    const device = plan.devices.find(row => row.id === id);
    if (!device) throw new Error('Choose a managed controller');
    return device;
  }

  private async connect(device: RecordValue, signal: AbortSignal) {
    const client = this.factory(device.address || device.base);
    try {
      await client.connect(signal);
      if (client.serial !== device.serial) throw new Error('Controller identity changed. Refresh before sending.');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async selectors(client: CyanviewClient, signal: AbortSignal) {
    try { return await client.readRemiSelectors(signal); }
    catch { signal.throwIfAborted(); return new Map<string, RemiSelector>(); }
  }

  async readCameraReferences(snapshot: Snapshot, client: CyanviewClient, signal: AbortSignal, links: RemiLink[] = []) {
    const imports = snapshot.cameras.filter(row => row.remi && !links.some(link =>
      link.receiver === row.device && link.entry.localKey === row.elementKey &&
      link.entry.selector === row.remi!.selector && link.entry.connection === row.remi!.connection));
    if (!imports.length) return;
    const selectors = await this.selectors(client, signal);
    for (const row of imports) {
      const info = row.remi!, selector = selectors.get(info.selector), prefix = info.peer + '.';
      if (selector?.connection === info.connection && selector.deviceId.startsWith(prefix)) {
        const sourceKey = selector.deviceId.slice(prefix.length);
        if (sourceKey) info.sourceKey = sourceKey;
      }
    }
  }

  async describeCameras(plan: Plan, snapshots: Snapshot[], signal: AbortSignal, links?: RemiLink[]) {
    const updated = new Set(snapshots.map(snapshot => snapshot.device.id));
    const rows = snapshots.length ? snapshots.flatMap(snapshot => snapshot.cameras) : plan.cameras;
    if (!rows.some(row => row.remi)) return;
    const available = [...plan.cameras.filter(row => !updated.has(row.device)), ...snapshots.flatMap(snapshot => snapshot.cameras)];
    const devices = [...plan.devices.filter(device => !updated.has(device.id)), ...snapshots.map(snapshot => snapshot.device)];
    describeRemiOrigins(rows, available, plan.cameras, devices, links ?? (await this.repository.readRemi(signal)).data.links);
  }

  private async observe(device: RecordValue, signal: AbortSignal): Promise<Observed> {
    const client = await this.connect(device, signal);
    try {
      const entries = remiEntries(client.config);
      const selectors = entries.some(entry => entry.enabled) ? await this.selectors(client, signal) : new Map();
      return { device, config: client.config, entries, selectors };
    } finally { client.close(); }
  }

  private match(entries: RemiEntry[], selectors: Map<string, RemiSelector>, source: RecordValue,
    config: RecordValue, camera: RemiCamera, previous?: RemiCamera) {
    const peers = entries.filter(entry => samePeer(entry.peer, source));
    if (!peers.length) return [];
    const identity = (entry: RemiEntry) => {
      const info = selectors.get(entry.selector);
      return info?.connection === entry.connection ? info.deviceId : '';
    };
    const exact = peers.filter(entry => identity(entry) === entry.peer + '.' + camera.key);
    if (exact.length) return exact;

    // Some firmware reports only the remote number/name in the UI catalog.
    // Use it only when it identifies one camera on the source and on each peer.
    const labels = new Set([remiLabel(camera), ...(previous ? [remiLabel(previous)] : [])]);
    for (const key of cameraKeys(config)) {
      if (key !== camera.key && labels.has(remiLabel(remiCamera(key, config)))) {
        throw new Error('Camera identity is ambiguous on ' + source.name);
      }
    }
    const matches = peers.filter(entry => {
      if (!labels.has(entry.label)) return false;
      const remote = identity(entry), other = remote.startsWith(entry.peer + '.') ? remote.slice(entry.peer.length + 1) : '';
      return !other || !config.Camera?.[other] || other === camera.key;
    });
    if (new Set(matches.map(entry => entry.connection)).size !== matches.length) {
      throw new Error('Several REMI cameras match on ' + source.name);
    }
    return matches;
  }

  async state(input: RecordValue, signal: AbortSignal) {
    const { plan } = await this.repository.read(signal);
    const receiver = this.device(plan, input.receiver);
    const store = await this.repository.readRemi(signal);
    const target = await this.observe(receiver, signal);
    const tagRelay = remiTagRelay(target.config);
    const refreshes = store.data.refreshes.filter(job => job.source === receiver.id ||
      job.steps?.some(step => step.receiver === receiver.id)).map(job => ({
        source: job.source, key: job.camera.key, name: job.camera.name,
      }));
    if (!input.source) return { tags: tagRelay?.tags ?? null, cameras: [], addresses: [], refreshes };
    const source = this.device(plan, input.source);
    if (source.id === receiver.id) throw new Error('Choose a different source controller');
    const from = await this.connect(source, signal);
    try {
      const active = target.entries.filter(entry => isImported(entry, target.config) && samePeer(entry.peer, source));
      const cameras = cameraKeys(from.config).map(key => {
        const camera = remiCamera(key, from.config);
        try {
          const assigned = active.find(entry => store.data.links.some(link => link.source === source.id &&
            link.sourceKey === key && link.receiver === receiver.id && sameEntry(link.entry, entry) && link.entry.localKey === entry.localKey)) ??
            this.match(active, target.selectors, source, from.config, camera)[0];
          return { ...camera, assigned: !!assigned, localKey: assigned?.localKey ?? null };
        } catch { return { ...camera, assigned: false, ambiguous: true }; }
      });
      return { tags: tagRelay?.tags ?? null, cameras, addresses: remiAddresses(source, from.config), refreshes };
    } finally { from.close(); }
  }

  // An unfinished refresh is about one camera and its copies, so only that camera waits for it.
  private refreshHolds(job: RemiRefresh, controller: string, key: string) {
    return (job.source === controller && job.camera.key === key) ||
      !!job.steps?.some(step => step.receiver === controller && (step.entry.localKey === key || step.next?.localKey === key));
  }

  send(input: RecordValue, signal: AbortSignal) {
    return this.enqueue(async () => {
      const { plan } = await this.repository.read(signal);
      const store = await this.repository.readRemi(signal);
      if (input.operation === 'jobs') {
        return { jobs: store.data.refreshes.map(job => ({ source: job.source, key: job.camera.key, number: job.camera.number, name: job.camera.name,
          receivers: [...new Set((job.steps ?? []).map(step => step.receiver))] })) };
      }
      // A refresh that can't finish, because a controller is gone or its copies were rebuilt by hand, is let go here.
      if (input.operation === 'dismiss') {
        const before = store.data.refreshes.length;
        store.data.refreshes = store.data.refreshes.filter(job => !(job.source === input.source && job.camera.key === input.key));
        if (store.data.refreshes.length !== before) await this.repository.writeRemi(store, signal);
        return { dismissed: before - store.data.refreshes.length };
      }
      const receiver = this.device(plan, input.receiver);
      if (input.operation === 'retry') {
        const jobs = store.data.refreshes.filter(job => job.source === receiver.id ||
          job.steps?.some(step => step.receiver === receiver.id));
        const results = [];
        for (const job of jobs) {
          try { await this.refresh(plan, job, store, signal); results.push({ id: job.camera.key, verified: true }); }
          catch (error) { results.push({ id: job.camera.key, error: message(error) }); }
        }
        return { results, refresh: jobs.length > 0 };
      }
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 512) throw new Error('Choose between 1 and 512 REMI changes');
      const items = input.items.map(object);
      if (items.some((item: RecordValue) => typeof item.id !== 'string' || !item.id || !['camera', 'tag', 'remove'].includes(item.kind)) ||
        new Set(items.map((item: RecordValue) => item.id)).size !== items.length) throw new Error('Invalid REMI changes');
      if (items.some((item: RecordValue) => item.kind !== 'tag' && store.data.refreshes.some(job =>
        this.refreshHolds(job, item.kind === 'remove' ? receiver.id : String(item.source), String(item.key))))) {
        throw new Error('Finish or dismiss the pending REMI refresh for this camera before changing where it goes');
      }
      const target = await this.connect(receiver, signal);
      const sources = new Map<string, CyanviewClient>();
      try {
        const results = [];
        const additions = items.filter((item: RecordValue) => item.kind === 'camera' && item.enable === true);
        if (additions.length) {
          const selectors = remiEntries(target.config).some(entry => entry.enabled) ? await this.selectors(target, signal) : new Map();
          let newCount = 0;
          for (const item of additions) {
            try {
              const source = this.device(plan, item.source);
              const from = await this.sourceClient(sources, source, signal);
              const camera = remiCamera(String(item.key), from.config);
              if (!this.assigned(target, receiver, source, from.config, camera, store, selectors)) newCount++;
            } catch { /* Invalid rows report their own errors below. */ }
          }
          if (newCount) this.assertCapacity(plan, receiver, target, newCount);
        }
        for (const item of items) {
          signal.throwIfAborted();
          try {
            if (item.kind === 'tag') await this.tag(target, item, signal);
            else if (item.kind === 'remove') await this.removeRow(target, receiver, item, store, signal);
            else {
              const source = this.device(plan, item.source);
              const from = await this.sourceClient(sources, source, signal);
              await this.assign(target, receiver, source, from, item, store, signal);
            }
            results.push({ id: item.id, verified: true });
          } catch (error) { results.push({ id: item.id, error: message(error) }); }
        }
        const snapshot = normalizeSnapshot(target.config, target.address);
        if (target.connected && snapshot.cameras.some(row => row.remi)) {
          const observed = [snapshot];
          await this.readCameraReferences(snapshot, target, signal, store.data.links);
          for (const client of sources.values()) {
            const source = normalizeSnapshot(client.config, client.address);
            await this.readCameraReferences(source, client, signal, store.data.links);
            observed.push(source);
          }
          await this.describeCameras(plan, observed, signal, store.data.links);
        }
        // A closed socket may have missed a write readback. The frontend refreshes it separately.
        return { results, ...(target.connected ? { snapshot } : {}), refresh: !target.connected };
      } finally {
        target.close();
        for (const client of sources.values()) client.close();
      }
    });
  }

  /**
   * Makes one camera's copies match `tree`, which maps each controller holding a copy to the
   * controller it gets it from. Only what differs is touched, downstream copies go first, and
   * `expected` is what the person was looking at, so a stale view can't remove a copy it never showed.
   */
  route(input: RecordValue, signal: AbortSignal) {
    return this.enqueue(async () => {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 512) throw new Error('Choose between 1 and 512 camera assignments');
      const items = input.items.map(object);
      const tree = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 128 &&
        Object.entries(value).every(([receiver, parent]) => receiver && typeof parent === 'string' && parent);
      if (items.some((item: RecordValue) => typeof item.id !== 'string' || !item.id || typeof item.camera !== 'string' || typeof item.key !== 'string' || !item.key || !tree(item.tree) || !tree(item.expected) ||
        (item.copies !== undefined && !tree(item.copies))) ||
        new Set(items.map((item: RecordValue) => item.id)).size !== items.length) throw new Error('Invalid camera assignments');
      const { plan } = await this.repository.read(signal);
      const store = await this.repository.readRemi(signal);
      // Only the controllers a change involves are opened, each once for the whole request. One that
      // nothing here touches is never asked, so it can be off without stopping the others.
      const clients = new Map<string, CyanviewClient>(), opening = new Map<string, Promise<CyanviewClient>>();
      const reach = async (id: string) => {
        const device = this.device(plan, id);
        let pending = opening.get(id);
        if (!pending) {
          pending = this.connect(device, signal).then(client => { clients.set(id, client); return client; });
          pending.catch(() => undefined);
          opening.set(id, pending);
        }
        let client: CyanviewClient;
        try { client = await pending; }
        catch { signal.throwIfAborted(); throw new Error('Cannot reach ' + device.name); }
        if (!client.connected) throw new Error('Cannot reach ' + device.name);
        return client;
      };
      try {
        const touched = new Set<string>(), results = [];
        for (const item of items) {
          signal.throwIfAborted();
          try {
            await this.applyRoute(plan, item, reach, store, touched, signal);
            results.push({ id: item.id, verified: true });
          } catch (error) { results.push({ id: item.id, error: message(error) }); }
        }
        const live = [...clients.values()].filter(client => client.connected);
        const observed = live.map(client => normalizeSnapshot(client.config, client.address));
        if (observed.some(snapshot => snapshot.cameras.some(row => row.remi))) {
          for (const [index, snapshot] of observed.entries()) await this.readCameraReferences(snapshot, live[index]!, signal, store.data.links);
          await this.describeCameras(plan, observed, signal, store.data.links);
        }
        // A closed socket may have missed a readback. The page reads that controller again.
        return { results, snapshots: observed.filter(snapshot => touched.has(snapshot.device.id)), refresh: [...touched].some(id => !clients.get(id)?.connected), controllers: opening.size };
      } finally {
        for (const client of clients.values()) client.close();
      }
    });
  }

  private assertRouteTree(plan: Plan, origin: RecordValue, wanted: Record<string, string>) {
    if (Object.hasOwn(wanted, origin.id)) throw new Error('A camera can\'t be REMI\'d to the controller it is set up on');
    for (const receiver of Object.keys(wanted)) {
      this.device(plan, receiver);
      let hops = 1;
      for (let parent = wanted[receiver]!; parent !== origin.id; parent = wanted[parent]!, hops++) {
        if (!Object.hasOwn(wanted, parent) || hops > 3) throw new Error('A REMI copy has to trace back to the camera within three hops');
      }
      if (hops > 3) throw new Error('A REMI copy has to trace back to the camera within three hops');
    }
  }

  private async applyRoute(plan: Plan, item: RecordValue, reach: (id: string) => Promise<CyanviewClient>,
    store: Receipt, touched: Set<string>, signal: AbortSignal) {
    const origin = this.device(plan, item.camera), wanted: Record<string, string> = item.tree, expected: Record<string, string> = item.expected;
    const stale = () => new Error('This camera\'s REMI copies have changed. Refresh before sending.');
    this.assertRouteTree(plan, origin, wanted);
    if (store.data.refreshes.some(job => this.refreshHolds(job, origin.id, String(item.key)))) {
      throw new Error('Finish or dismiss the pending REMI refresh for this camera before changing where it goes');
    }
    const saved = plan.cameras.find(row => row.device === origin.id && row.elementKey === item.key);
    if (saved?.remi || isRemiModel(saved?.model) || isRemiModel(saved?.modelLabel)) throw new Error('Change this assignment on the camera it came from');
    // How far each copy the page showed is from the camera. One that doesn't trace back is a view to refresh.
    const depth = (receiver: string) => {
      let hops = 1;
      for (let parent = expected[receiver]!; parent !== origin.id; parent = expected[parent]!, hops++) {
        if (!Object.hasOwn(expected, parent) || hops > 8) throw stale();
      }
      return hops;
    };
    const shown = Object.keys(expected).sort((a, b) => depth(a) - depth(b));
    // Where each copy sits on its controller: what the page showed, or what was recorded when it was made or last read.
    const given: Record<string, string> = object(item.copies), local = new Map<string, string>([[origin.id, String(item.key)]]);
    for (const receiver of shown) {
      const parent = expected[receiver]!, parentKey = local.get(parent);
      const key = given[receiver] ?? (parentKey ? store.data.links.find(link => link.receiver === receiver && link.source === parent && link.sourceKey === parentKey)?.entry.localKey ??
        plan.cameras.find(row => row.device === receiver && row.elementKey && row.remi && samePeer(String(row.remi.peer ?? ''), this.device(plan, parent)) && row.remi.sourceKey === parentKey)?.elementKey : undefined);
      if (key) local.set(receiver, String(key));
    }
    // A copy stays only if it comes from the same place and that place stays too. Parents come first in `shown`.
    const keys = new Map<string, string>([[origin.id, String(item.key)]]), kept = new Set<string>([origin.id]);
    for (const receiver of shown) if (wanted[receiver] === expected[receiver] && kept.has(expected[receiver]!)) {
      kept.add(receiver);
      if (local.has(receiver)) keys.set(receiver, local.get(receiver)!);
    }
    // Only a controller losing or gaining a copy is opened, and for a new copy the one it comes from.
    for (const receiver of [...shown].reverse()) {
      if (kept.has(receiver)) continue;
      const key = local.get(receiver), parent = this.device(plan, expected[receiver]);
      if (!key) throw stale();
      const target = await reach(receiver);
      touched.add(receiver);
      const entry = remiEntries(target.config).find(candidate => candidate.localKey === key && isImported(candidate, target.config));
      if (!entry) {
        // Already taken off by hand. Anything else under that key is not this copy.
        if (target.config.Camera?.[key]) throw stale();
        if (store.data.links.some(link => link.receiver === receiver && link.entry.localKey === key)) {
          store.data.links = store.data.links.filter(link => link.receiver !== receiver || link.entry.localKey !== key);
          await this.repository.writeRemi(store, signal);
        }
        continue;
      }
      if (!samePeer(entry.peer, parent)) throw stale();
      await this.remove(target, receiver, entry, store, signal);
    }
    const waiting = Object.keys(wanted).filter(id => !kept.has(id));
    while (waiting.length) {
      const next = waiting.findIndex(candidate => keys.has(wanted[candidate]!));
      // The copy this one would come from was never found on its controller.
      if (next < 0) throw stale();
      const id = waiting.splice(next, 1)[0]!;
      const receiver = this.device(plan, id), source = this.device(plan, wanted[id]), key = keys.get(source.id)!;
      const target = await reach(id), from = await reach(source.id);
      if (!from.config.Camera?.[key]) throw stale();
      if (source.id === origin.id && isRemiModel(from.config.Camera[key].Model)) throw new Error('Change this assignment on the camera it came from');
      this.assertCapacity(plan, receiver, target, 1);
      touched.add(id);
      await this.assign(target, receiver, source, from, { key, enable: true }, store, signal);
      const link = store.data.links.find(row => row.source === source.id && row.sourceKey === key && row.receiver === id);
      if (!link?.entry.localKey) throw new Error('The REMI copy on ' + receiver.name + ' could not be confirmed');
      keys.set(id, link.entry.localKey);
    }
  }

  private assertCapacity(plan: Plan, receiver: RecordValue, target: CyanviewClient, adding: number) {
    const current = cameraKeys(target.config).length;
    const limit = String(target.config.Product?.MaxCam ?? '');
    const capacity = /^\d+$/.test(limit) ? Number(limit) : Infinity;
    // Existing assignments and copied camera rows count once.
    const managed = plan.cameras.filter(row => row.device !== receiver.id).length;
    if (current + adding > capacity || managed + current + adding > 512) throw new Error('This import would exceed camera capacity');
  }

  private async sourceClient(sources: Map<string, CyanviewClient>, source: RecordValue, signal: AbortSignal) {
    let from = sources.get(source.id);
    if (!from) {
      from = await this.connect(source, signal);
      sources.set(source.id, from);
    }
    return from;
  }

  private async tag(target: CyanviewClient, item: RecordValue, signal: AbortSignal) {
    const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
    if (!tag || tag.length > 160 || /[,\r\n]/.test(tag) || typeof item.enable !== 'boolean') throw new Error('Enter a tag without commas');
    const relay = remiTagRelay(target.config);
    if (!relay) throw new Error('This controller does not expose writable REMI tags');
    const next = item.enable ? [...new Set([...relay.tags, tag])] : relay.tags.filter(value => value !== tag);
    if (stable(next) === stable(relay.tags)) return;
    const mapping = await target.mapping(relay.key, 'Tags', signal);
    if (mapping.key !== relay.key || mapping.property !== 'tags') throw new Error('REMI tag mapping could not be verified');
    await target.update(mapping.key, { tags: next.join(',') }, signal);
    await target.waitFor(config => stable(remiTagRelay(config)?.tags) === stable(next), signal);
  }

  private assigned(target: CyanviewClient, receiver: RecordValue, source: RecordValue, config: RecordValue,
    camera: RemiCamera, store: Receipt, selectors: Map<string, RemiSelector>) {
    const active = remiEntries(target.config).filter(entry => isImported(entry, target.config) && samePeer(entry.peer, source));
    const known = store.data.links.filter(link => link.source === source.id && link.sourceKey === camera.key && link.receiver === receiver.id);
    return active.find(entry => known.some(link => sameEntry(link.entry, entry) && link.entry.localKey === entry.localKey)) ??
      this.match(active, selectors, source, config, camera)[0];
  }

  private assertNoLoop(receiver: RecordValue, source: RecordValue, key: string, store: Receipt) {
    const visited = new Set([receiver.id]);
    let next = source.id;
    while (next) {
      if (visited.has(next)) throw new Error('This import would create a REMI camera loop');
      visited.add(next);
      const parent = store.data.links.find(link => link.receiver === next && link.entry.localKey === key);
      next = parent?.source ?? '';
      key = parent?.sourceKey ?? '';
    }
  }

  private async assign(target: CyanviewClient, receiver: RecordValue, source: RecordValue, from: CyanviewClient,
    item: RecordValue, store: Receipt, signal: AbortSignal) {
    if (receiver.id === source.id || typeof item.enable !== 'boolean') throw new Error('Choose a camera on a different controller');
    const camera = remiCamera(String(item.key), from.config);
    const selectors = remiEntries(target.config).some(entry => entry.enabled) ? await this.selectors(target, signal) : new Map();
    const existing = this.assigned(target, receiver, source, from.config, camera, store, selectors);
    if (!item.enable) {
      if (existing) await this.remove(target, receiver.id, existing, store, signal);
      return;
    }
    if (existing) {
      this.rememberLink(store, { source: source.id, sourceKey: camera.key, receiver: receiver.id, entry: existing });
      await this.repository.writeRemi(store, signal);
      return;
    }
    this.assertNoLoop(receiver, source, camera.key, store);
    const addresses = remiAddresses(source, from.config);
    const linked = remiEntries(target.config).find(entry => entry.manual && entry.connected && samePeer(entry.peer, source) && addresses.includes(entry.address));
    const address = item.address || linked?.address || addresses[0];
    if (!addresses.includes(address) || remiAddresses(receiver, target.config).includes(address)) throw new Error('Choose a verified source IP address');
    const importer = await this.ensureImporter(target, receiver, address, store, signal);
    const selected = await this.resolve(target, source, from.config, camera, importer, signal);
    const entry = await this.enable(target, selected, camera, signal);
    this.rememberLink(store, { source: source.id, sourceKey: camera.key, receiver: receiver.id, entry });
    await this.repository.writeRemi(store, signal);
  }

  private async ensureImporter(target: CyanviewClient, receiver: RecordValue, address: string, store: Receipt, signal: AbortSignal) {
    if (!validIp(address) || !Object.hasOwn(target.config, 'Remi')) throw new Error('This controller does not expose REMI configuration');
    const existing = Object.entries(object(target.config.Remi)).filter(([, value]) => {
      const row = object(value);
      return row.Type === 'LAN_manual' && row.IP === address;
    });
    if (existing.length > 1) throw new Error('Several manual REMI sources use ' + address);
    const previous = store.data.creates.find(create => create.receiver === receiver.id && create.address === address);
    if (existing[0]) {
      if (previous) {
        store.data.creates = store.data.creates.filter(create => create !== previous);
        await this.repository.writeRemi(store, signal);
      }
      return existing[0][0];
    }
    if (previous) throw new Error('The manual connection to ' + address + ' could not be confirmed. Check the receiver before retrying.');
    const receipt = { receiver: receiver.id as string, address, key: '' };
    store.data.creates.push(receipt);
    await this.repository.writeRemi(store, signal);
    try {
      const reply = await target.action({ new: ['CyElement.SessionImporter', address] }, signal);
      if (typeof reply[1] !== 'string' || !reply[1]) throw new Error('Controller did not return a REMI connection identity');
      receipt.key = reply[1];
      await this.repository.writeRemi(store, signal);
      await target.waitFor(config => config.Remi?.[receipt.key]?.IP === address &&
        config.Remi?.[receipt.key]?.Type === 'LAN_manual', signal);
    } catch (error) {
      if (message(error) === 'Controller rejected the requested configuration') {
        store.data.creates = store.data.creates.filter(create => create !== receipt);
        await this.repository.writeRemi(store, signal);
      }
      throw new Error('Could not confirm the REMI connection to ' + address + ': ' + message(error));
    }
    store.data.creates = store.data.creates.filter(create => create !== receipt);
    await this.repository.writeRemi(store, signal);
    return receipt.key;
  }

  private async resolve(target: CyanviewClient, source: RecordValue, config: RecordValue, camera: RemiCamera,
    importer: string, signal: AbortSignal, old?: RemiStep) {
    const eligible = (snapshot: RecordValue) => remiEntries(snapshot).filter(entry =>
      entry.importer === importer && entry.connected && samePeer(entry.peer, source));
    const changedKey = old && camera.key !== old.sourceKey;
    try {
      await target.waitFor(snapshot => eligible(snapshot).some(entry =>
        entry.label === remiLabel(camera) && (!changedKey || entry.selector !== old.entry.selector)), signal);
    } catch {
      signal.throwIfAborted();
      // An identity can be available even when firmware formats its label differently.
    }
    const selectors = await this.selectors(target, signal);
    const candidates = eligible(target.config).filter(entry => {
      if (!changedKey || entry.selector !== old.entry.selector) return true;
      return selectors.get(entry.selector)?.deviceId === entry.peer + '.' + camera.key;
    });
    const matches = this.match(candidates, selectors, source, config, camera);
    if (matches.length !== 1) {
      const address = target.config.Remi?.[importer]?.IP;
      throw new Error((matches.length ? 'Several advertised cameras match ' : 'Camera is not advertised by ') +
        source.name + (address ? ' via ' + address + '. Check or change the source IP.' : '. Refresh the REMI source.'));
    }
    return matches[0]!;
  }

  private async enable(target: CyanviewClient, entry: RemiEntry, camera: RemiCamera, signal: AbortSignal) {
    const current = () => remiEntries(target.config).find(candidate => sameEntry(candidate, entry));
    const live = current();
    if (!live?.connected) throw new Error('The REMI source changed before the import could be sent');
    if (!live.enabled) await target.update(entry.selector, { auto_camera: '1' }, signal);
    await target.waitFor(config => {
      const next = remiEntries(config).find(candidate => sameEntry(candidate, entry));
      return !!next && isImported(next, config) && String(config.Camera[next.localKey!].Name ?? '') === camera.name;
    }, signal);
    return current()!;
  }

  /**
   * Takes a copy off a controller: its import is switched off and the camera it made is deleted. A controller
   * can keep that camera after the import is off, and can make the copy again under a new key, so whatever the
   * import feeds now goes too, along with the key on record. `rebuilding` is a refresh, which takes off what
   * is there however it has moved, and goes on when it is already gone.
   */
  private async disable(target: CyanviewClient, entry: RemiEntry, signal: AbortSignal, rebuilding = false) {
    const current = remiEntries(target.config).find(candidate => sameEntry(candidate, entry));
    const keys = [...new Set([entry.localKey, current?.localKey].filter((key): key is string => !!key))];
    // A copy no other import feeds. A camera of the controller's own is never one.
    const leftover = (config: RecordValue) => keys.filter(key => isRemiModel(config.Camera?.[key]?.Model) &&
      !remiEntries(config).some(candidate => candidate.enabled && candidate.localKey === key && !sameEntry(candidate, entry)));
    if (!rebuilding && !(current?.enabled && current.localKey === entry.localKey && isImported(current, target.config))) {
      throw new Error('The REMI assignment changed. Refresh before removing it.');
    }
    if (current?.enabled) await target.update(current.selector, { auto_camera: '0' }, signal);
    await target.waitFor(config => !remiEntries(config).some(candidate => sameEntry(candidate, entry) && candidate.enabled), signal);
    let refused: unknown;
    for (const key of leftover(target.config)) {
      try { await target.action({ delete: [key] }, signal); }
      // The controller may have deleted it itself in the meantime, which the readback below shows.
      catch (error) { signal.throwIfAborted(); refused = error; }
    }
    try {
      await target.waitFor(config => !leftover(config).length &&
        !remiEntries(config).some(candidate => sameEntry(candidate, entry) && candidate.enabled), signal);
    } catch (error) { throw refused ?? error; }
    return keys;
  }

  private async removeRow(target: CyanviewClient, receiver: RecordValue, item: RecordValue, store: Receipt, signal: AbortSignal) {
    const entry = remiEntries(target.config).find(row => row.localKey === item.key && row.selector === item.selector &&
      row.connection === item.connection && isImported(row, target.config));
    if (!entry) throw new Error('The REMI assignment changed. Refresh before removing it.');
    await this.remove(target, receiver.id, entry, store, signal);
  }

  private async remove(target: CyanviewClient, receiver: string, entry: RemiEntry, store: Receipt, signal: AbortSignal) {
    await this.disable(target, entry, signal);
    store.data.links = store.data.links.filter(link => link.receiver !== receiver || link.entry.localKey !== entry.localKey);
    await this.repository.writeRemi(store, signal);
  }

  private rememberLink(store: Receipt, link: RemiLink) {
    store.data.links = store.data.links.filter(item => linkKey(item) !== linkKey(link));
    store.data.links.push(link);
  }

  async assertCameraReady(device: string, key: string, signal: AbortSignal) {
    const { data } = await this.repository.readRemi(signal);
    if (data.refreshes.some(job => job.source === device && job.camera.key === key)) {
      throw new Error('Retry this camera’s pending REMI refresh before sending another edit');
    }
  }

  cameraChanged(source: RecordValue, before: RemiCamera, camera: RemiCamera, signal: AbortSignal) {
    return this.enqueue(async () => {
      const { plan } = await this.repository.read(signal);
      if (plan.devices.length < 2) return {};
      const store = await this.repository.readRemi(signal);
      // With no copy on record there is nothing to rebuild and no controller to ask.
      if (!this.holders(plan, store.data.links, source.id, before.key).size) return {};
      const job: RemiRefresh = { source: source.id, camera, before, steps: null };
      // Persist the verified source change before looking up downstream devices.
      store.data.refreshes.push(job);
      await this.repository.writeRemi(store, signal);
      try {
        await this.refresh(plan, job, store, signal);
        return job.steps?.length ? { remiRefresh: true } : {};
      } catch (error) {
        return { remiRefresh: true, remiError: message(error) };
      }
    });
  }

  /**
   * Every REMI copy of a camera, however many hops away, each listed after the copy it was made from.
   * Every managed controller is read afresh, so a copy made by hand is found too. A controller that
   * can't be read is named in `unread`, since a copy on it can't be reached either.
   */
  async copiesOf(sourceId: string, key: string, signal: AbortSignal) {
    const { plan } = await this.repository.read(signal);
    this.device(plan, sourceId);
    const inventory = new Map<string, Observed>();
    for (let start = 0; start < plan.devices.length; start += 8) {
      await Promise.all(plan.devices.slice(start, start + 8).map(async device => {
        try { inventory.set(device.id, await this.observe(device, signal)); }
        catch { signal.throwIfAborted(); }
      }));
    }
    const origin = inventory.get(sourceId);
    if (!origin) throw new Error('Cannot read ' + this.device(plan, sourceId).name);
    const steps: { receiver: string; key: string; parent: number }[] = [];
    const walk = (fromId: string, camera: RemiCamera, parent: number, ancestors: Set<string>) => {
      const from = inventory.get(fromId)!;
      for (const target of inventory.values()) {
        if (ancestors.has(target.device.id)) continue;
        const active = target.entries.filter(entry => isImported(entry, target.config));
        for (const entry of this.match(active, target.selectors, from.device, from.config, camera)) {
          if (steps.length >= 512) throw new Error('The REMI chain exceeds camera capacity');
          const index = steps.push({ receiver: target.device.id, key: entry.localKey!, parent }) - 1;
          walk(target.device.id, remiCamera(entry.localKey!, target.config), index, new Set([...ancestors, target.device.id]));
        }
      }
    };
    walk(sourceId, remiCamera(key, origin.config), -1, new Set([sourceId]));
    return { steps, unread: plan.devices.filter(device => !inventory.has(device.id)).map(device => String(device.id)) };
  }

  /**
   * The controllers recorded as holding a copy of a camera, however many hops away. A copy made by
   * hand on a controller since it was last read isn't on record, and waits for a Refresh all.
   */
  private holders(plan: Plan, links: RemiLink[], source: string, key: string) {
    const found = new Set<string>(), seen = new Set<string>(), queue: [string, string][] = [[source, key]];
    while (queue.length) {
      const [device, camera] = queue.shift()!, id = device + '\n' + camera;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const link of links) if (link.source === device && link.sourceKey === camera) {
        found.add(link.receiver);
        if (link.entry.localKey) queue.push([link.receiver, link.entry.localKey]);
      }
      const from = plan.devices.find(row => row.id === device);
      if (from) for (const row of plan.cameras) {
        const info = row.remi;
        if (!info || row.device === device || !samePeer(String(info.peer ?? ''), from)) continue;
        // A copy whose source camera was never worked out could be this one, so its controller is read too.
        if (info.sourceKey && info.sourceKey !== camera) continue;
        found.add(String(row.device));
        if (info.sourceKey && row.elementKey) queue.push([String(row.device), String(row.elementKey)]);
      }
    }
    found.delete(source);
    return found;
  }

  private async captureChain(plan: Plan, job: RemiRefresh, store: Receipt, signal: AbortSignal) {
    const inventory = new Map<string, Observed>();
    const involved = new Set([job.source, ...this.holders(plan, store.data.links, job.source, job.before.key)]);
    const devices = plan.devices.filter(device => involved.has(device.id));
    // Bound simultaneous sockets when a workspace contains a large fleet.
    for (let start = 0; start < devices.length; start += 8) {
      await Promise.all(devices.slice(start, start + 8).map(async device => {
        try { inventory.set(device.id, await this.observe(device, signal)); }
        catch { signal.throwIfAborted(); }
      }));
    }
    const steps: RemiStep[] = [], found = new Set<string>();
    const walk = (sourceId: string, camera: RemiCamera, parent: number, ancestors: Set<string>, previous?: RemiCamera) => {
      const from = inventory.get(sourceId);
      if (!from) throw new Error('Cannot read REMI source ' + this.device(plan, sourceId).name);
      for (const link of store.data.links.filter(link => link.source === sourceId && link.sourceKey === camera.key)) {
        if (plan.devices.some(row => row.id === link.receiver) && !inventory.has(link.receiver)) {
          throw new Error('REMI receiver is offline: ' + this.device(plan, link.receiver).name);
        }
      }
      for (const target of inventory.values()) {
        if (target.device.id === sourceId) continue;
        const active = target.entries.filter(entry => isImported(entry, target.config));
        const tracked = store.data.links.filter(link => link.source === sourceId && link.sourceKey === camera.key && link.receiver === target.device.id);
        const entries = this.match(active, target.selectors, from.device, from.config, camera, previous);
        for (const entry of active) if (tracked.some(link => sameEntry(link.entry, entry) && link.entry.localKey === entry.localKey) &&
          samePeer(entry.peer, from.device) && !entries.some(candidate => sameEntry(candidate, entry))) entries.push(entry);
        for (const entry of entries) {
          if (!entry.connected) throw new Error('REMI source is disconnected on ' + target.device.name);
          if (ancestors.has(target.device.id)) throw new Error('A REMI camera loop needs to be resolved before refreshing copies');
          const step: RemiStep = { source: sourceId, sourceKey: camera.key, receiver: target.device.id, entry, parent, phase: 'attached' };
          if (found.has(linkKey(step))) throw new Error('The REMI camera has more than one upstream assignment');
          if (steps.length >= 512) throw new Error('The REMI chain exceeds camera capacity');
          found.add(linkKey(step));
          const index = steps.push(step) - 1;
          walk(target.device.id, remiCamera(entry.localKey!, target.config), index, new Set([...ancestors, target.device.id]));
        }
      }
    };
    walk(job.source, job.camera, -1, new Set([job.source]), job.before);
    return steps;
  }

  private async refresh(plan: Plan, job: RemiRefresh, store: Receipt, signal: AbortSignal) {
    if (!job.steps) {
      job.steps = await this.captureChain(plan, job, store, signal);
      await this.repository.writeRemi(store, signal);
    }
    const steps = job.steps;
    if (!steps.length) {
      store.data.refreshes = store.data.refreshes.filter(current => current !== job);
      await this.repository.writeRemi(store, signal);
      return;
    }
    const clients = new Map<string, CyanviewClient>();
    try {
      // Verify every endpoint before interrupting any copy. Remove downstream
      // first, while the old parent camera and its selector still exist.
      for (const id of new Set([job.source, ...steps.map(step => step.receiver)])) {
        await this.sourceClient(clients, this.device(plan, id), signal);
      }
      // A copy that moved to a new key or was taken off by hand is still rebuilt, as long as the controller
      // can still get the camera, so nothing is taken off that can't be put back.
      for (const step of steps) {
        if (step.phase !== 'attached' && step.phase !== 'removing') continue;
        const config = clients.get(step.receiver)!.config;
        const current = remiEntries(config).find(entry => sameEntry(entry, step.entry));
        const reachable = current ? current.connected :
          remiEntries(config).some(entry => entry.importer === step.entry.importer && entry.peer === step.entry.peer && entry.connected);
        if (!reachable) {
          throw new Error('REMI source is disconnected on ' + this.device(plan, step.receiver).name + '. Check the connection before retrying.');
        }
      }
      for (const step of [...steps].reverse()) {
        if (step.phase !== 'attached' && step.phase !== 'removing') continue;
        const target = clients.get(step.receiver)!;
        step.phase = 'removing';
        await this.repository.writeRemi(store, signal);
        const removed = await this.disable(target, step.entry, signal, true);
        store.data.links = store.data.links.filter(link => link.receiver !== step.receiver || !removed.includes(link.entry.localKey!));
        step.phase = 'removed';
        await this.repository.writeRemi(store, signal);
      }
      // Rebuild from the origin outward. Each child uses its parent's new key.
      for (const step of steps) {
        if (step.phase === 'done') continue;
        const parent = step.parent === -1 ? undefined : steps[step.parent];
        const key = parent ? parent.next?.localKey : job.camera.key;
        if (!key) throw new Error('The upstream REMI camera is not restored yet');
        const from = clients.get(step.source)!, target = clients.get(step.receiver)!;
        const camera = remiCamera(key, from.config);
        const receiver = this.device(plan, step.receiver);
        const importer = step.entry.manual ?
          await this.ensureImporter(target, receiver, step.entry.address, store, signal) : step.entry.importer;
        const entry = await this.resolve(target, this.device(plan, step.source), from.config, camera, importer, signal, step);
        step.phase = 'adding';
        await this.repository.writeRemi(store, signal);
        step.next = await this.enable(target, entry, camera, signal);
        step.phase = 'done';
        store.data.links = store.data.links.filter(link => linkKey(link) !== linkKey(step));
        this.rememberLink(store, { source: step.source, sourceKey: key, receiver: step.receiver, entry: step.next });
        await this.repository.writeRemi(store, signal);
      }
      store.data.refreshes = store.data.refreshes.filter(current => current !== job);
      await this.repository.writeRemi(store, signal);
    } finally {
      for (const client of clients.values()) client.close();
    }
  }
}
