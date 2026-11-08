import { createModuleHelperClient, type ModuleHostServices } from '@hubble/module-sdk';
import { object, validIp } from './model.js';
import { pingPolicy } from './ping-batch.js';

export type PingRange = { count: number; address: (index: number) => string; contains: (ip: string) => boolean };
export type PingBatch = (value: { first: string; last: string }, signal: AbortSignal) => Promise<{ alive: string[]; checked: number }>;
export type PingSweep = (range: PingRange, receive: (addresses: string[]) => void, progress: (checked: number) => void, signal: AbortSignal) => Promise<void>;
export function createPingSweep(batch: PingBatch): PingSweep {
  return async (range, receive, progress, signal) => {
    let next = 0, checked = 0;
    const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal]);
    const workers = Array.from({ length: Math.min(pingPolicy.workers, Math.ceil(range.count / pingPolicy.batchSize)) }, async () => {
      while (next < range.count) {
        combined.throwIfAborted(); const first = next, last = Math.min(range.count - 1, first + pingPolicy.batchSize - 1); next = last + 1;
        const result = await batch({ first: range.address(first), last: range.address(last) }, combined);
        combined.throwIfAborted(); receive(result.alive.filter(ip => validIp(ip) && range.contains(ip))); checked += last - first + 1; progress(checked);
      }
    });
    try { await Promise.all(workers); } finally { lifetime.abort(); await Promise.allSettled(workers); }
  };
}
export function createHostPing(services: ModuleHostServices) {
  const helper = createModuleHelperClient(services, 'icmp-probe');
  return {
    async prepare(signal: AbortSignal) {
      const status = await helper.start(signal);
      if (status.status !== 'helper' || status.state !== 'ready') throw new Error((status.status === 'helper' ? status.message : null) || 'Fast IP discovery is unavailable; use Full IP scan or Find by IP.');
    },
    sweep: createPingSweep(async (value, signal) => {
      const result = object(await helper.call('batch', value, signal));
      if (!Array.isArray(result.alive) || !result.alive.every(validIp)) throw new Error('Invalid ping helper response');
      return { alive: result.alive, checked: Number(result.checked) };
    }),
  };
}
