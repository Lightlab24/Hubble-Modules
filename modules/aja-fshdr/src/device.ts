import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type Values = Record<string, unknown>;
export type Choice = { value: string; label: string };
export type Descriptor = {
  param_id: string; param_name?: string; param_type?: string;
  enum_values?: { value: number | string; text: string }[];
  class_names?: string[];
  min_value?: number; max_value?: number; adjust_by?: number; scale_by?: number; display_precision?: number; units?: string;
  min_length?: number; max_length?: number;
  relations?: Record<string, { paramid: string; value: string | number | boolean | null }[]>;
};
/** What the page needs to check a typed value before it is staged. */
export type Limits = { precision?: number; min?: number; max?: number; step?: number; units?: string; minLength?: number; maxLength?: number };
export type Reading = { value: string; locked?: string; choices?: Choice[]; limits?: Limits };
export type WriteResult = { ok: boolean; message: string };
export type Connection = 'connecting' | 'live' | 'offline';
/** How a unit is reached: over HTTP, or a simulated unit inside the worker. It answers the same calls either way. */
export type Transport = (path: string, query: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
export const PREREQUISITE = 'Switch on this setting’s prerequisite first.';
/**
 * The unit's own page greys out Custom Size, Position and Crop while Custom Size/Pos is off, but the unit takes them
 * (checked on a real FS-HDR, firmware 4.3.2.5), so they can be set up before it is switched on.
 */
export const advisory = (condition: { paramid: string; value: unknown }) => /^eParamID_Vid[0-4#]CustomSizePos$/.test(condition.paramid) && String(condition.value) === '0';

/**
 * At most four units download their 7 MB settings list at a time. Forty units starting together would otherwise hold 280 MB of
 * them at once; four in turn add about a second for the last unit.
 */
const CATALOG_DOWNLOADS = 4;
let downloading = 0;
const waitingToDownload: (() => void)[] = [];
async function oneOfFew<T>(run: () => Promise<T>): Promise<T> {
  while (downloading >= CATALOG_DOWNLOADS) await new Promise<void>(resolve => waitingToDownload.push(resolve));
  downloading++;
  try { return await run(); } finally { downloading--; waitingToDownload.shift()?.(); }
}

export function httpTransport(address: string): Transport {
  return async (path, query, signal) => {
    const url = new URL(path, address);
    // A space goes as %20: the unit's own pages send it that way, and a `+` may be stored as typed.
    url.search = Object.entries(query).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
    const get = () => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), cache: 'no-store', redirect: 'error' });
    // The settings list comes back as bytes so that `readCatalog` can share one copy between units.
    if (path === '/desc.json' || path === '/map.json') return oneOfFew(async () => {
      const response = await get();
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return new Uint8Array(await response.arrayBuffer());
    });
    const response = await get();
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json() as unknown;
  };
}

const MODE = 'eParamID_FS4Mode', REMOTE = 'eParamID_RemoteControl', SYSTEM_NAME = 'eParamID_SystemName';
export const object = (value: unknown): value is Values => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value) : null;

/** A unit's settings list, and the settings stored in a different place for each frame-rate family or transform. Never changed once read. */
export interface UnitCatalog { readonly descriptors: ReadonlyMap<string, Descriptor>; readonly maps: Values }
/**
 * The fields of a setting that the module reads. A unit also puts its own serial number, MAC address and loaded LUT names in
 * `default_value`, so keeping only these lets every unit on the same firmware use one copy.
 */
const DESCRIPTOR_FIELDS = ['param_id', 'param_name', 'param_type', 'enum_values', 'class_names', 'min_value', 'max_value', 'adjust_by', 'scale_by', 'display_precision', 'units', 'min_length', 'max_length', 'relations'] as const;
/**
 * A real unit's list is about 7 MB of JSON and takes 15 to 25 MB once read. Hubble gives a module 128 MB, so nine units each
 * holding their own copy ran the worker out of memory. Catalogs are kept while a unit holds one, by the bytes the unit sent
 * (so a reconnect skips reading them again) and by their trimmed content (so units that differ only in `default_value` share).
 */
const byBytes = new Map<string, WeakRef<UnitCatalog>>(), byContent = new Map<string, WeakRef<UnitCatalog>>();
function held(cache: Map<string, WeakRef<UnitCatalog>>, key: string): UnitCatalog | undefined {
  const catalog = cache.get(key)?.deref();
  if (!catalog) cache.delete(key);
  return catalog;
}
function hold(cache: Map<string, WeakRef<UnitCatalog>>, key: string, catalog: UnitCatalog) {
  for (const [other, ref] of cache) if (!ref.deref()) cache.delete(other);
  cache.set(key, new WeakRef(catalog));
}
function buildCatalog(desc: unknown, map: unknown): UnitCatalog {
  if (!Array.isArray(desc) || !object(map) || !object(map.forward_maps)) throw new Error('Invalid FS-HDR catalog');
  const descriptors = new Map<string, Descriptor>();
  for (const item of desc) {
    if (!object(item) || typeof item.param_id !== 'string') continue;
    const kept: Values = {};
    for (const field of DESCRIPTOR_FIELDS) if (item[field] !== undefined) kept[field] = item[field];
    descriptors.set(item.param_id, kept as Descriptor);
  }
  return { descriptors, maps: map.forward_maps };
}
/**
 * The catalog for a unit's `/desc.json` and `/map.json`. Bytes from a real unit are read here, all in one step, so only one
 * unit's full list is in memory at a time however many connect together. A simulated unit's lists are already shared objects.
 */
export function readCatalog(desc: unknown, map: unknown): UnitCatalog {
  if (!(desc instanceof Uint8Array) || !(map instanceof Uint8Array)) return buildCatalog(desc, map);
  const bytesKey = createHash('sha256').update(String(desc.length) + ':').update(desc).update(map).digest('hex');
  const known = held(byBytes, bytesKey);
  if (known) return known;
  const decoder = new TextDecoder();
  const read = buildCatalog(JSON.parse(decoder.decode(desc)), JSON.parse(decoder.decode(map)));
  const content = createHash('sha256');
  for (const descriptor of read.descriptors.values()) content.update(JSON.stringify(descriptor));
  const contentKey = content.update(JSON.stringify(read.maps)).digest('hex');
  let catalog = held(byContent, contentKey);
  if (!catalog) hold(byContent, contentKey, catalog = read);
  hold(byBytes, bytesKey, catalog);
  return catalog;
}

export function applyEvents(state: Values, events: unknown): boolean {
  if (!Array.isArray(events)) throw new Error('Invalid event batch');
  const updates: Values = Object.create(null);
  for (const event of events) {
    if (!object(event) || typeof event.param_id !== 'string') throw new Error('Invalid device event');
    if ('services' in event) {
      if (!Array.isArray(event.services)) throw new Error('Invalid services event');
      updates[event.param_id] = event.services;
      continue;
    }
    const value = String(event.param_type) === '12' ? scalar(event.str_value) : scalar(event.int_value ?? event.str_value ?? event.value);
    if (value === null) throw new Error('Device event has no value');
    updates[event.param_id] = value;
  }
  const changed = Object.entries(updates).some(([key, value]) => JSON.stringify(state[key]) !== JSON.stringify(value));
  Object.assign(state, updates);
  return changed;
}
export function displayValue(descriptor: Descriptor, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (descriptor.param_id === 'eParamID_SoftwareVersion') return [24, 16, 8, 0].map(shift => (Number(value) >>> shift) & 255).join('.');
  if (descriptor.param_type === 'enum') return descriptor.enum_values?.find(option => String(option.value) === String(value))?.text ?? String(value);
  if (['decimal', 'integer'].includes(descriptor.param_type ?? '') && value !== '' && Number.isFinite(Number(value))) return (Number(value) / (descriptor.scale_by || 1)).toFixed(descriptor.display_precision || 0) + (descriptor.units ? ' ' + descriptor.units : '');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
const optionsOf = (descriptor: Descriptor | undefined): Choice[] => (descriptor?.enum_values ?? []).flatMap(choice => { const value = scalar(choice?.value); return value !== null && typeof choice?.text === 'string' ? [{ value, label: choice.text }] : []; });
/** The choices or range a setting offers, from its descriptor alone. `null` for kinds the sheet can't edit. */
export function shapeOf(descriptor: Descriptor): Pick<Reading, 'choices' | 'limits'> | null {
  const type = descriptor.param_type ?? '';
  if (type === 'enum') return { choices: optionsOf(descriptor) };
  if (type === 'integer' || type === 'decimal') {
    const scale = descriptor.scale_by || 1, precision = descriptor.display_precision || 0;
    return { limits: { precision, ...(descriptor.min_value != null ? { min: descriptor.min_value / scale } : {}), ...(descriptor.max_value != null ? { max: descriptor.max_value / scale } : {}), step: (descriptor.adjust_by || 1) / scale, ...(descriptor.units ? { units: descriptor.units } : {}) } };
  }
  if (type === 'string') return { limits: { minLength: descriptor.min_length ?? 0, maxLength: descriptor.max_length ?? 1024 } };
  return null;
}
/** Which stored setting a mapped one stands for now, given the value of the setting it depends on. */
export function mappedTarget(mapping: unknown, selectorOf: (id: string) => string | null): string | null {
  if (!object(mapping) || Number(mapping.map_scheme) === 0) return '';
  const scheme = Number(mapping.map_scheme);
  if (![1, 2, 3, 4, 5].includes(scheme) || !Array.isArray(mapping.depends_on) || !Array.isArray(mapping.param_maps)) return null;
  const selector = selectorOf(String(mapping.depends_on[0]));
  if (selector === null || !/^-?\d+$/.test(selector)) return null;
  const target = mapping.param_maps[Number(selector) - (scheme === 5 ? 7 : 0)];
  return typeof target === 'string' && target.startsWith('eParamID_') ? target : null;
}
/** The unit's own ID for a sheet setting. `Vid#` stands for the channel; the four input labels are the channels' names. */
export function parameterId(fieldId: string, channel: number | null, mode: string): string | null {
  const label = /^ChannelName([1-4])$/.exec(fieldId);
  if (label) return mode === '2' ? (label[1] === '1' ? 'eParamID_Vid0_ChannelName' : null) : 'eParamID_Vid' + label[1] + '_ChannelName';
  if (fieldId.includes('Vid#')) return channel === null ? null : 'eParamID_' + fieldId.replace('Vid#', 'Vid' + channel);
  return channel === null ? 'eParamID_' + fieldId : null;
}

export class Device {
  private state: Values = Object.create(null);
  /** Shared with other units on the same firmware. Holding it here is what keeps it in `readCatalog`'s caches. */
  private catalog: UnitCatalog = { descriptors: new Map(), maps: {} };
  private status: Connection = 'connecting';
  private revision = 0;
  private work: Promise<unknown> = Promise.resolve();
  private failure: string | null = null;
  private cycle = new AbortController();
  private restarting = false;

  constructor(readonly address: string, private readonly onChange: () => void, private readonly transport: Transport = httpTransport(address)) {}
  /** Goes up whenever anything the unit reports changes, so a caller can tell its rows are out of date. */
  private changes = 0;
  get version(): number { return this.changes; }
  private changed() { this.changes++; this.onChange(); }

  get connection(): Connection { return this.status; }
  get error(): string | null { return this.failure; }
  /** `1` is four HD/SD channels and `2` is one 4K/UHD channel. Empty until the unit has been read. */
  get mode(): string { return scalar(this.state[MODE]) ?? ''; }
  get channels(): number[] { return this.mode === '1' ? [1, 2, 3, 4] : this.mode === '2' ? [0] : []; }
  get modeLabel(): string { return this.label(MODE); }
  get remoteAllowed(): boolean { return ['0', '2'].includes(String(this.state[REMOTE])); }
  get name(): string { return scalar(this.state[SYSTEM_NAME]) ?? ''; }

  private request(path: string, query: Record<string, string>, signal: AbortSignal) { return this.transport(path, query, signal); }
  /** Some settings are stored in a different place for each frame-rate family or transform. This finds the one in use now. */
  private resolve(id: string): string | null {
    const target = mappedTarget(this.catalog.maps[id], selector => scalar(this.state[selector]));
    return target === '' ? id : target;
  }
  label(id: string): string {
    const backing = this.resolve(id), descriptor = backing ? this.catalog.descriptors.get(backing) : undefined;
    if (!backing) return '';
    return descriptor ? displayValue(descriptor, this.state[backing]) : scalar(this.state[backing]) ?? '';
  }
  private lookup(id: string) {
    const original = this.catalog.descriptors.get(id), target = original ? this.resolve(id) : null;
    const descriptor = (target && this.catalog.descriptors.get(target)) || original;
    return { original, target, descriptor };
  }
  private matches = (condition: { paramid: string; value: unknown }) => {
    const backing = this.resolve(condition.paramid);
    return !!backing && Object.hasOwn(this.state, backing) && String(this.state[backing]) === String(condition.value);
  };
  /** The stored setting a sheet setting stands for now. */
  lookupId(id: string): string | null { return this.resolve(id); }
  /** The settings this one's availability depends on, as the unit names them now, including ones its page only greys it out for. */
  prerequisites(id: string): string[] {
    const { descriptor } = this.lookup(id), relations = descriptor?.relations ?? {};
    return [...relations.enabled_by ?? [], ...relations.disabled_by ?? []].flatMap(condition => { const backing = this.resolve(condition.paramid); return backing ? [backing] : []; });
  }
  /** A setting as the sheet shows it: enum values by their raw number, numbers scaled the way the unit displays them. */
  read(id: string): Reading {
    const { original, target, descriptor } = this.lookup(id);
    if (!original || !descriptor) return { value: '', locked: 'This unit does not have this setting.' };
    const present = !!target && Object.hasOwn(this.state, target), raw = target ? this.state[target] : undefined, type = descriptor.param_type ?? '';
    const enabled = descriptor.relations?.enabled_by ?? [], disabled = (descriptor.relations?.disabled_by ?? []).filter(condition => !advisory(condition));
    const active = (!enabled.length || enabled.some(this.matches)) && !disabled.some(this.matches);
    const shape = shapeOf(descriptor);
    if (!shape) return { value: displayValue(descriptor, raw), locked: 'This setting needs the unit’s own page.' };
    const reading: Reading = { value: '', ...shape };
    if (type === 'integer' || type === 'decimal') reading.value = present && Number.isFinite(Number(raw)) ? (Number(raw) / (descriptor.scale_by || 1)).toFixed(descriptor.display_precision || 0) : '';
    else reading.value = scalar(raw) ?? '';
    const locked = descriptor.class_names?.includes('readonly') || original.class_names?.includes('readonly') ? 'The unit reports this value. It can’t be set.'
      : !present ? 'The unit has not reported this value.' : !active ? PREREQUISITE : undefined;
    if (locked) reading.locked = locked;
    return reading;
  }
  /** Checks a sheet value against the unit's own limits and turns it into what goes on the wire. */
  private prepare(id: string, value: string): { target: string; wire: string } {
    if (this.status !== 'live') throw new Error('The unit is offline.');
    if (!this.remoteAllowed) throw new Error('Remote control is switched off on the unit.');
    const { target, descriptor } = this.lookup(id), reading = this.read(id);
    if (!target || !descriptor) throw new Error('This unit does not have this setting.');
    if (reading.locked) throw new Error(reading.locked);
    const type = descriptor.param_type;
    if (type === 'enum') { if (!reading.choices?.some(option => option.value === value)) throw new Error('Choose a value this unit offers.'); return { target, wire: value }; }
    if (type === 'integer' || type === 'decimal') {
      if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('Enter a number.');
      const scale = descriptor.scale_by || 1, raw = Number((Number(value) * scale).toFixed(10)), limits = reading.limits!;
      if (descriptor.min_value != null && raw < descriptor.min_value || descriptor.max_value != null && raw > descriptor.max_value) throw new Error('Use a value from ' + limits.min + ' to ' + limits.max + '.');
      const count = (raw - (descriptor.min_value || 0)) / (descriptor.adjust_by || 1);
      if (Math.abs(count - Math.round(count)) > 1e-7) throw new Error('Use steps of ' + limits.step + '.');
      return { target, wire: String(raw) };
    }
    const length = [...value].length;
    if (length < (descriptor.min_length ?? 0) || length > (descriptor.max_length ?? 1024)) throw new Error('Use ' + (descriptor.min_length ?? 0) + ' to ' + (descriptor.max_length ?? 1024) + ' characters.');
    return { target, wire: value };
  }
  /** One write at a time per unit. Each is confirmed by reading the value back. */
  write(id: string, value: string, signal: AbortSignal): Promise<WriteResult> {
    const run = this.work.then(async (): Promise<WriteResult> => {
      if (signal.aborted) return { ok: false, message: 'Cancelled before it was sent.' };
      let prepared: { target: string; wire: string };
      try { prepared = this.prepare(id, value); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'This setting is unavailable.' }; }
      const revision = this.revision;
      try {
        await this.request('/config', { action: 'set', paramid: prepared.target, value: prepared.wire, configid: '0' }, signal);
        const readback = await this.request('/config', { action: 'get', paramid: prepared.target, configid: '0', alt: 'json' }, signal);
        if (this.revision !== revision || !object(readback) || readback.name !== prepared.target || scalar(readback.value) !== prepared.wire) return { ok: false, message: 'The unit did not confirm the new value.' };
        this.state[prepared.target] = prepared.wire;
        this.changed();
        return { ok: true, message: 'Confirmed' };
      } catch { return { ok: false, message: 'The unit did not answer, so the result is unknown.' }; }
    });
    this.work = run.catch(() => {});
    return run;
  }
  /** Drops the event connection and reads the whole unit again. */
  restart() { this.restarting = true; this.cycle.abort(); }

  async run(signal: AbortSignal): Promise<void> {
    let retry = 500;
    while (!signal.aborted) {
      this.cycle = new AbortController();
      const cycle = AbortSignal.any([signal, this.cycle.signal]);
      try {
        // Read in one step, so the downloaded bytes are let go before waiting for the unit's values.
        const catalog = readCatalog(...await Promise.all([this.request('/desc.json', {}, cycle), this.request('/map.json', {}, cycle)]));
        const snapshot = await this.request('/config', { action: 'connect' }, cycle);
        if (!object(snapshot) || !Array.isArray(snapshot.configevents) || !object(snapshot.configevents[0]) || scalar(snapshot.connectionid) === null) throw new Error('Invalid FS-HDR snapshot');
        cycle.throwIfAborted();
        this.catalog = catalog;
        this.state = Object.assign(Object.create(null), snapshot.configevents[0]);
        this.status = 'live'; this.failure = null; this.revision++;
        this.changed();
        retry = 500;
        while (!cycle.aborted) {
          const events = await this.request('/config', { action: 'wait_for_config_events', connectionid: String(snapshot.connectionid) }, cycle);
          cycle.throwIfAborted();
          if (applyEvents(this.state, events)) this.changed();
          await delay(50, undefined, { signal: cycle });
        }
      } catch (error) {
        if (signal.aborted) return;
        if (this.restarting) { this.restarting = false; this.status = 'connecting'; this.revision++; this.changed(); continue; }
        this.status = 'offline';
        this.failure = error instanceof Error ? error.message : 'Device connection failed';
        if (object(error) && object(error.cause)) { const cause = scalar(error.cause.code) || scalar(error.cause.message); if (cause) this.failure += ' (' + cause + ')'; }
        this.revision++;
        this.changed();
        try { await delay(retry, undefined, { signal: cycle }); } catch { if (signal.aborted) return; this.restarting = false; }
        retry = Math.min(30_000, retry * 2);
      }
    }
  }
  /** The transform a channel is on now, as the unit's raw value. Button feedback compares against it. */
  transformValue(processor: number): string | null {
    if (this.status !== 'live' || !this.channels.includes(processor)) return null;
    const backing = this.resolve('eParamID_Vid' + processor + 'ColorHDRTransform');
    return backing ? scalar(this.state[backing]) : null;
  }
}
