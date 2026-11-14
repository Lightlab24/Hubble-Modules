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

const MODE = 'eParamID_FS4Mode', REMOTE = 'eParamID_RemoteControl', SYSTEM_NAME = 'eParamID_SystemName';
export const object = (value: unknown): value is Values => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value) : null;

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
/** The unit's own ID for a sheet setting. `Vid#` stands for the channel; the four input labels are the channels' names. */
export function parameterId(fieldId: string, channel: number | null, mode: string): string | null {
  const label = /^ChannelName([1-4])$/.exec(fieldId);
  if (label) return mode === '2' ? (label[1] === '1' ? 'eParamID_Vid0_ChannelName' : null) : 'eParamID_Vid' + label[1] + '_ChannelName';
  if (fieldId.includes('Vid#')) return channel === null ? null : 'eParamID_' + fieldId.replace('Vid#', 'Vid' + channel);
  return channel === null ? 'eParamID_' + fieldId : null;
}

export class Device {
  private state: Values = Object.create(null);
  private descriptors = new Map<string, Descriptor>();
  private maps: Values = {};
  private status: Connection = 'connecting';
  private revision = 0;
  private work: Promise<unknown> = Promise.resolve();
  private failure: string | null = null;
  private cycle = new AbortController();
  private restarting = false;

  constructor(readonly address: string, private readonly onChange: () => void) {}

  get connection(): Connection { return this.status; }
  get error(): string | null { return this.failure; }
  /** `1` is four HD/SD channels and `2` is one 4K/UHD channel. Empty until the unit has been read. */
  get mode(): string { return scalar(this.state[MODE]) ?? ''; }
  get channels(): number[] { return this.mode === '1' ? [1, 2, 3, 4] : this.mode === '2' ? [0] : []; }
  get modeLabel(): string { return this.label(MODE); }
  get remoteAllowed(): boolean { return ['0', '2'].includes(String(this.state[REMOTE])); }
  get name(): string { return scalar(this.state[SYSTEM_NAME]) ?? ''; }

  private async request(path: string, query: Record<string, string>, signal: AbortSignal) {
    const url = new URL(path, this.address);
    // A space goes as %20: the unit's own pages send it that way, and a `+` may be stored as typed.
    url.search = Object.entries(query).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json() as unknown;
  }
  /** Some settings are stored in a different place for each frame-rate family or transform. This finds the one in use now. */
  private resolve(id: string): string | null {
    const mapping = this.maps[id];
    if (!object(mapping) || Number(mapping.map_scheme) === 0) return id;
    const scheme = Number(mapping.map_scheme);
    if (![1, 2, 3, 4, 5].includes(scheme) || !Array.isArray(mapping.depends_on) || !Array.isArray(mapping.param_maps)) return null;
    const selector = scalar(this.state[String(mapping.depends_on[0])]);
    if (selector === null || !/^-?\d+$/.test(selector)) return null;
    const target = mapping.param_maps[Number(selector) - (scheme === 5 ? 7 : 0)];
    return typeof target === 'string' && target.startsWith('eParamID_') ? target : null;
  }
  private options(descriptor: Descriptor | undefined): Choice[] {
    return (descriptor?.enum_values ?? []).flatMap(choice => { const value = scalar(choice?.value); return value !== null && typeof choice?.text === 'string' ? [{ value, label: choice.text }] : []; });
  }
  label(id: string): string {
    const backing = this.resolve(id), descriptor = backing ? this.descriptors.get(backing) : undefined;
    if (!backing) return '';
    return descriptor ? displayValue(descriptor, this.state[backing]) : scalar(this.state[backing]) ?? '';
  }
  private lookup(id: string) {
    const original = this.descriptors.get(id), target = original ? this.resolve(id) : null;
    const descriptor = (target && this.descriptors.get(target)) || original;
    return { original, target, descriptor };
  }
  private matches = (condition: { paramid: string; value: unknown }) => {
    const backing = this.resolve(condition.paramid);
    return !!backing && Object.hasOwn(this.state, backing) && String(this.state[backing]) === String(condition.value);
  };
  /** A setting as the sheet shows it: enum values by their raw number, numbers scaled the way the unit displays them. */
  read(id: string): Reading {
    const { original, target, descriptor } = this.lookup(id);
    if (!original || !descriptor) return { value: '', locked: 'This unit does not have this setting.' };
    const present = !!target && Object.hasOwn(this.state, target), raw = target ? this.state[target] : undefined, type = descriptor.param_type ?? '';
    const enabled = descriptor.relations?.enabled_by ?? [], disabled = descriptor.relations?.disabled_by ?? [];
    const active = (!enabled.length || enabled.some(this.matches)) && !disabled.some(this.matches);
    const reading: Reading = { value: '' };
    if (type === 'enum') { reading.value = scalar(raw) ?? ''; reading.choices = this.options(descriptor); }
    else if (type === 'integer' || type === 'decimal') {
      const scale = descriptor.scale_by || 1, precision = descriptor.display_precision || 0;
      reading.value = present && Number.isFinite(Number(raw)) ? (Number(raw) / scale).toFixed(precision) : '';
      reading.limits = { precision, ...(descriptor.min_value != null ? { min: descriptor.min_value / scale } : {}), ...(descriptor.max_value != null ? { max: descriptor.max_value / scale } : {}), step: (descriptor.adjust_by || 1) / scale, ...(descriptor.units ? { units: descriptor.units } : {}) };
    } else if (type === 'string') { reading.value = scalar(raw) ?? ''; reading.limits = { minLength: descriptor.min_length ?? 0, maxLength: descriptor.max_length ?? 1024 }; }
    else return { value: displayValue(descriptor, raw), locked: 'This setting needs the unit’s own page.' };
    const locked = descriptor.class_names?.includes('readonly') || original.class_names?.includes('readonly') ? 'The unit reports this value. It can’t be set.'
      : !present ? 'The unit has not reported this value.' : !active ? 'Switch on this setting’s prerequisite first.' : undefined;
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
        this.onChange();
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
        const [desc, map] = await Promise.all([this.request('/desc.json', {}, cycle), this.request('/map.json', {}, cycle)]);
        if (!Array.isArray(desc) || !object(map) || !object(map.forward_maps)) throw new Error('Invalid FS-HDR catalog');
        const snapshot = await this.request('/config', { action: 'connect' }, cycle);
        if (!object(snapshot) || !Array.isArray(snapshot.configevents) || !object(snapshot.configevents[0]) || scalar(snapshot.connectionid) === null) throw new Error('Invalid FS-HDR snapshot');
        cycle.throwIfAborted();
        this.descriptors = new Map(desc.filter((item): item is Descriptor => object(item) && typeof item.param_id === 'string').map(item => [item.param_id, item]));
        this.maps = map.forward_maps;
        this.state = Object.assign(Object.create(null), snapshot.configevents[0]);
        this.status = 'live'; this.failure = null; this.revision++;
        this.onChange();
        retry = 500;
        while (!cycle.aborted) {
          const events = await this.request('/config', { action: 'wait_for_config_events', connectionid: String(snapshot.connectionid) }, cycle);
          cycle.throwIfAborted();
          if (applyEvents(this.state, events)) this.onChange();
          await delay(50, undefined, { signal: cycle });
        }
      } catch (error) {
        if (signal.aborted) return;
        if (this.restarting) { this.restarting = false; this.status = 'connecting'; this.revision++; this.onChange(); continue; }
        this.status = 'offline';
        this.failure = error instanceof Error ? error.message : 'Device connection failed';
        if (object(error) && object(error.cause)) { const cause = scalar(error.cause.code) || scalar(error.cause.message); if (cause) this.failure += ' (' + cause + ')'; }
        this.revision++;
        this.onChange();
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
