import raw from './catalog.json' with { type: 'json' };
import { mappedTarget, shapeOf, type Choice, type Descriptor, type Limits } from './device.js';

/**
 * The FS-HDR settings the module uses, from a firmware 4.3.2.5 capture: their descriptors, the settings they map onto and
 * the bench values. It gives a unit's choices and ranges before the unit is reached, and it is what a simulated unit runs on.
 * Only the worker loads it. `scripts/build-fields.mjs` writes it, storing a channel setting once with `Vid#` for the channel.
 */
export interface Catalog { firmware: string; descriptors: Descriptor[]; byId: Map<string, Descriptor>; maps: Record<string, unknown>; values: Record<string, string>; logical: Map<string, string> }
type Entry = Descriptor & { channels?: number[] };
interface Raw { firmware: string; descriptors: Entry[]; maps: Record<string, unknown>; values: Record<string, string | Record<string, string>> }

let loaded: Catalog | undefined;
const forChannel = <T>(value: T, channel: number): T => JSON.parse(JSON.stringify(value).replaceAll('eParamID_Vid#', 'eParamID_Vid' + channel)) as T;

export function catalog(): Catalog {
  if (loaded) return loaded;
  const source = raw as unknown as Raw, descriptors: Descriptor[] = [], channelsOf = new Map<string, number[]>();
  for (const { channels, ...descriptor } of source.descriptors) {
    if (!channels) { descriptors.push(descriptor); continue; }
    channelsOf.set(descriptor.param_id, channels);
    for (const channel of channels) descriptors.push(forChannel(descriptor, channel));
  }
  const byId = new Map(descriptors.map(descriptor => [descriptor.param_id, descriptor]));
  // A templated map or value applies to every channel that has the setting, whether or not its descriptors could share one entry.
  const channels = (id: string) => [0, 1, 2, 3, 4].filter(channel => byId.has(id.replace('Vid#', 'Vid' + channel)));
  const maps: Record<string, unknown> = {}, values: Record<string, string> = {};
  for (const [id, map] of Object.entries(source.maps)) {
    if (!id.includes('Vid#')) { maps[id] = map; continue; }
    for (const channel of channelsOf.get(id) ?? channels(id)) maps[id.replace('Vid#', 'Vid' + channel)] = forChannel(map, channel);
  }
  for (const [id, value] of Object.entries(source.values)) {
    if (!id.includes('Vid#')) { values[id] = value as string; continue; }
    for (const channel of channels(id)) values[id.replace('Vid#', 'Vid' + channel)] = typeof value === 'string' ? value : value[channel] ?? '';
  }
  // A mapped setting is stored in one of several places. This finds the setting a stored place belongs to.
  const logical = new Map<string, string>();
  for (const [id, map] of Object.entries(maps)) for (const target of (map as { param_maps?: unknown[] }).param_maps ?? []) if (typeof target === 'string') logical.set(target, id);
  return loaded = { firmware: source.firmware, descriptors, byId, maps, values, logical };
}

/** What a setting offers before its unit is reached. A mapped setting follows a staged value for what it depends on, else the bench value. */
export interface PlannedReading { choices?: Choice[]; limits?: Limits; readOnly: boolean }
const cache = new Map<string, PlannedReading | null>();
export function plannedReading(id: string, staged: (paramId: string) => string | undefined): PlannedReading | null {
  const { byId, maps, values } = catalog(), original = byId.get(id);
  if (!original) return null;
  const target = mappedTarget(maps[id], selector => staged(selector) ?? values[selector] ?? null);
  const descriptor = (target && byId.get(target)) || original, key = descriptor.param_id;
  if (cache.has(key)) return cache.get(key)!;
  const shape = shapeOf(descriptor);
  const reading = shape ? { ...shape, readOnly: !!(descriptor.class_names?.includes('readonly') || original.class_names?.includes('readonly')) } : null;
  cache.set(key, reading);
  return reading;
}
