import { catalog } from './catalog.js';
import type { Transport } from './device.js';

/**
 * A simulated FS-HDR inside the worker. It answers the same calls as a real unit, from the bundled firmware 4.3.2.5 list and
 * its bench values, and nothing goes on the network. `changes` holds every setting written to it, so the unit can be put back
 * as it was after a restart. The operating mode and starting name come from Setup.
 */
export interface SimulatedOptions { name: string; mode: '1' | '2'; changes: Record<string, string>; onWrite(): void }

let connections = 0;
const NAME = 'eParamID_SystemName';

export function simulatedTransport(options: SimulatedOptions): Transport {
  const { descriptors, byId, maps, values: bench } = catalog();
  const nameLimit = byId.get(NAME)?.max_length ?? 20;
  const state: Record<string, string> = { ...bench, eParamID_FS4Mode: options.mode, eParamID_RemoteControl: '0', [NAME]: options.name.slice(0, nameLimit) || 'FS-HDR', ...options.changes };
  const subscribers = new Map<string, { events: Record<string, string>[]; wake?: () => void }>();

  function accepts(id: string, value: string): boolean {
    const descriptor = byId.get(id);
    if (!descriptor || descriptor.class_names?.includes('readonly')) return false;
    const type = descriptor.param_type;
    if (type === 'enum') return (descriptor.enum_values ?? []).some(option => String(option.value) === value);
    if (type === 'integer' || type === 'decimal') {
      const number = Number(value);
      return value.trim() !== '' && Number.isFinite(number) && (descriptor.min_value == null || number >= descriptor.min_value) && (descriptor.max_value == null || number <= descriptor.max_value);
    }
    if (type === 'string') { const length = [...value].length; return length >= (descriptor.min_length ?? 0) && length <= (descriptor.max_length ?? 1024); }
    return false;
  }
  function wait(subscriber: { events: Record<string, string>[]; wake?: () => void }, signal: AbortSignal): Promise<void> {
    if (subscriber.events.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); subscriber.wake = undefined; resolve(); };
      const stop = () => { clearTimeout(timer); subscriber.wake = undefined; reject(signal.reason ?? new Error('Aborted')); };
      // Like the unit, an empty batch every few seconds keeps the connection alive.
      const timer = setTimeout(done, 3000);
      subscriber.wake = done;
      signal.addEventListener('abort', stop, { once: true });
    });
  }
  return async (path, query, signal) => {
    signal.throwIfAborted();
    if (path === '/desc.json') return descriptors;
    if (path === '/map.json') return { forward_maps: maps };
    if (path !== '/config') throw new Error('HTTP 404');
    const action = query.action, id = query.paramid ?? '';
    if (action === 'connect') {
      const connectionid = 'simulated-' + ++connections;
      subscribers.set(connectionid, { events: [] });
      return { connectionid, configevents: [{ ...state }] };
    }
    if (action === 'wait_for_config_events') {
      const subscriber = subscribers.get(query.connectionid ?? '');
      if (!subscriber) throw new Error('HTTP 410');
      try { await wait(subscriber, signal); } catch (error) { subscribers.delete(query.connectionid ?? ''); throw error; }
      return subscriber.events.splice(0);
    }
    if (action === 'get') return { name: id, value: state[id] ?? '' };
    if (action === 'set') {
      const value = query.value ?? '';
      if (!accepts(id, value)) return { name: id, value: state[id] ?? '' };
      state[id] = value; options.changes[id] = value; options.onWrite();
      const text = byId.get(id)?.param_type === 'string';
      for (const subscriber of subscribers.values()) { subscriber.events.push(text ? { param_id: id, param_type: '12', str_value: value } : { param_id: id, param_type: '4', int_value: value }); subscriber.wake?.(); }
      return { name: id, value };
    }
    throw new Error('HTTP 400');
  };
}
