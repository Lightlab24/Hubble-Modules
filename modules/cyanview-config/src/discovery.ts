import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { addressParts, validIp, type RecordValue } from './model.js';
import { listenAnnouncements, type AnnouncementListener } from './announcements.js';
import type { PingSweep } from './ping.js';

export function networkRange(cidr: string) {
  const { ip, mask } = addressParts(cidr), prefix = Number(mask);
  if (prefix < 16) throw new Error('Select a /16 or smaller network');
  const number = ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0), block = 2 ** (32 - prefix), network = Math.floor(number / block) * block;
  const start = network + (prefix < 31 ? 1 : 0), count = block - (prefix < 31 ? 2 : 0);
  const address = (at: number) => [24, 16, 8, 0].map(shift => Math.floor((start + at) / 2 ** shift) % 256).join('.');
  const contains = (value: string) => validIp(value) && Math.floor(value.split('.').reduce((sum, part) => sum * 256 + Number(part), 0) / block) * block === network;
  return { count, address, contains };
}
export type NeighborReader = (signal: AbortSignal, accept?: (address: string) => boolean) => Promise<string[]>;
/**
 * macOS holds at most 1024 packets waiting for ARP (net.link.ether.inet.maxhold_total) and silently drops the
 * rest, though it still sends the ARP request. A sweep fills that in well under a second, and packets for
 * addresses nobody answers can stay held for minutes (about four and a half on a Mac measured in Nov 2026), so
 * most first probes to hosts this Mac hasn't spoken to lately never leave it, during a sweep and for a while
 * after. Their ARP replies still land in the neighbor cache, so a sweep reads that cache as it goes and once
 * more when it ends.
 */
export function harvestNeighbors(read: NeighborReader, accept: (address: string) => boolean, receive: (addresses: string[]) => void, signal: AbortSignal, intervalMs = 5000) {
  let busy: Promise<void> | undefined, latest: string[] = [];
  const once = () => busy ??= (async () => {
    try { const addresses = (await read(signal, accept)).filter(accept); if (!signal.aborted) { latest = addresses; receive(addresses); } }
    catch { /* A neighbor cache that can't be read only loses this round's extra addresses. */ }
    finally { busy = undefined; }
  })();
  const timer = setInterval(() => void once(), intervalMs);
  return {
    /** fping has already waited out its timeout after the last address, so every ARP reply is in by now. */
    async finish() { clearInterval(timer); await busy; if (!signal.aborted) await once(); },
    /** What the latest read saw, for checks that failed after it. */
    latest: () => latest,
  };
}
/** Addresses a sweep will check for a Cyanview identity, and how many at once. */
export const verifyPolicy = { addresses: 4096, concurrent: 16 } as const;
export async function tcpReachable(address: string, signal: AbortSignal): Promise<boolean> {
  if (!validIp(address)) return false;
  signal.throwIfAborted();
  return new Promise(resolve => {
    const socket = net.createConnection({ host: address, port: 80 });
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; signal.removeEventListener('abort', abort); socket.destroy(); resolve(value); };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(800, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
export type DiscoveryMethod = 'ping' | 'broadcast';
export type SavedDevice = { serial: string; addresses: string[] };
/** Checking until a saved device answers as itself at one of its addresses (found) or none does (missing). */
export type SavedCheck = { serial: string; state: 'checking' | 'found' | 'missing' };
export type DiscoveryProgress = { id: string; method: DiscoveryMethod; range: string; state: 'scanning' | 'complete' | 'stopped'; checked: number; total: number; results: RecordValue[]; saved: SavedCheck[]; error?: string };
export type DiscoveryOptions = { ping?: PingSweep; announcements?: AnnouncementListener; durationMs?: number; seeds?: (receive: (addresses: string[]) => void, signal: AbortSignal) => Promise<void>; neighbors?: NeighborReader; neighborIntervalMs?: number; saved?: (signal: AbortSignal) => Promise<SavedDevice[]> };
/** How many saved devices, and addresses of each, a search checks first. */
export const savedPolicy = { devices: 256, addresses: 4, concurrent: 32 } as const;
/** Runs tasks with at most `limit` going at once. */
function limiter(limit: number) {
  let active = 0; const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await task(); } finally { active--; waiting.shift()?.(); }
  };
}
export class Discovery {
  private controller: AbortController | undefined;
  private completion: Promise<void> = Promise.resolve();
  progress: DiscoveryProgress | null = null;
  constructor(private probe: (address: string, signal: AbortSignal) => Promise<RecordValue>, private publish: (progress: DiscoveryProgress) => void, private reachable = tcpReachable, private options: DiscoveryOptions = {}) {}
  start(cidr: string, method: DiscoveryMethod = 'ping') {
    const range = networkRange(cidr);
    if (!['ping', 'broadcast'].includes(method)) throw new Error('Choose a discovery method');
    this.stop();
    const controller = new AbortController(); this.controller = controller;
    const state: DiscoveryProgress = { id: randomUUID(), method, range: cidr, state: 'scanning', checked: 0, total: method === 'broadcast' ? 0 : range.count, results: [], saved: [] }; this.progress = state;
    const found = new Map<string, RecordValue>(); let last = 0;
    const emit = (force = false) => { if (this.progress !== state) return; if (force || Date.now() - last > 250) { last = Date.now(); state.results = [...found.values()]; this.publish({ ...state, saved: state.saved.map(item => ({ ...item })) }); } };
    const remember = (device: RecordValue, address: string) => {
      const previous = found.get(device.serial);
      if (previous) found.set(device.serial, { ...previous, ...device, addresses: [...new Set([...(previous.addresses ?? [previous.address]), address])].slice(0,16) });
      else if (found.size < 256) found.set(device.serial, { ...device, addresses: [address] });
      emit(true);
    };
    emit(true);
    // Saved devices go first, at every address each was known by, whichever range was chosen. Their
    // connection attempts all settle (gate) before the sweep starts filling the Mac's ARP queue.
    const savedPhase = (async () => {
      const list = (await this.options.saved?.(controller.signal).catch(() => []) ?? []).slice(0, savedPolicy.devices)
        .map(item => ({ serial: item.serial, addresses: [...new Set(item.addresses.filter(validIp))].slice(0, savedPolicy.addresses) }))
        .filter(item => item.addresses.length);
      if (controller.signal.aborted || this.progress !== state) return { addresses: new Set<string>(), gate: Promise.resolve(), done: Promise.resolve() };
      state.saved = list.map(item => ({ serial: item.serial, state: 'checking' as const })); emit(true);
      const run = limiter(savedPolicy.concurrent);
      const reachability = list.map(item => Promise.all(item.addresses.map(address => run(() => this.reachable(address, controller.signal)).catch(() => false))));
      const done = Promise.allSettled(list.map(async (item, index) => {
        const entry = state.saved[index]!, answered = await reachability[index]!;
        for (const [at, address] of item.addresses.entries()) {
          if (!answered[at] || controller.signal.aborted) continue;
          try {
            const device = await run(() => this.probe(address, controller.signal));
            if (controller.signal.aborted) return;
            remember(device, address);
            if (String(device.serial).toUpperCase() === item.serial.toUpperCase()) { entry.state = 'found'; emit(true); return; }
          } catch { /* Another device, or none, at this address. */ }
        }
        if (!controller.signal.aborted) { entry.state = 'missing'; emit(true); }
      })).then(() => undefined);
      return { addresses: new Set(list.flatMap(item => item.addresses)), gate: Promise.allSettled(reachability).then(() => undefined), done };
    })();
    if (method === 'ping') {
      const seen = new Set<string>(), unreached = new Set<string>(), retried = new Set<string>(), queue: string[] = [], pending = new Set<Promise<void>>();
      const pump = () => {
        while (!controller.signal.aborted && queue.length && pending.size < verifyPolicy.concurrent) {
          const address = queue.shift()!;
          const task = (async () => {
            try {
              if (await this.reachable(address, controller.signal)) { const device = await this.probe(address, controller.signal); if (!controller.signal.aborted) remember(device, address); }
              else unreached.add(address);
            }
            catch { /* A ping reply alone does not establish a Cyanview identity. */ }
          })();
          pending.add(task); void task.finally(() => { pending.delete(task); pump(); });
        }
      };
      const receive = (addresses: string[]) => {
        if (controller.signal.aborted) return;
        for (const address of addresses) if (range.contains(address) && !seen.has(address) && seen.size < verifyPolicy.addresses) { seen.add(address); queue.push(address); }
        pump();
      };
      // A first check can lose its connection attempt the same way a ping is lost, so an address the neighbor cache shows answering gets one more.
      const resolved = (addresses: string[]) => {
        if (controller.signal.aborted) return;
        for (const address of addresses) if (unreached.delete(address) && !retried.has(address)) { retried.add(address); queue.push(address); }
        receive(addresses);
      };
      let seeds: Promise<void> = Promise.resolve(), neighbors: ReturnType<typeof harvestNeighbors> | undefined;
      this.completion = (async () => {
        const saved = await savedPhase;
        try {
          // A saved device's addresses are checked once, by the saved check.
          for (const address of saved.addresses) seen.add(address);
          // Previously verified/cached addresses are checked even when ICMP replies are blocked.
          seeds = this.options.seeds?.(receive, controller.signal).catch(() => {}) ?? Promise.resolve();
          neighbors = this.options.neighbors && harvestNeighbors(this.options.neighbors, range.contains, resolved, controller.signal, this.options.neighborIntervalMs);
          await saved.gate;
          if (!this.options.ping) throw new Error('Fast IP discovery is unavailable. Use Find by IP.');
          if (!controller.signal.aborted) await this.options.ping(range, receive, checked => { if (!controller.signal.aborted) { state.checked = checked; emit(); } }, controller.signal);
        } catch (error) { if (!controller.signal.aborted) state.error = error instanceof Error ? error.message : 'IP discovery failed'; }
        finally {
          await seeds;
          // Read once more straight away, alongside the checks still running.
          await neighbors?.finish();
          while (!controller.signal.aborted && pending.size) await Promise.allSettled([...pending]);
          // A check that failed after that read still gets its retry from what the read saw, without reading again.
          if (neighbors) resolved(neighbors.latest());
          while (!controller.signal.aborted && pending.size) await Promise.allSettled([...pending]);
          await Promise.allSettled([...pending]);
          await saved.done;
          state.state = controller.signal.aborted ? 'stopped' : 'complete'; emit(true);
        }
      })();
      return { id: state.id, method, total: range.count };
    }
    // Broadcast discovery.
    {
      const attempted = new Map<string,number>(), pending = new Set<Promise<void>>(), queue: string[] = [];
      let expired = false;
      const pump = () => {
        while (!controller.signal.aborted && pending.size < 8 && queue.length) {
          const address = queue.shift()!;
          const task = (async () => {
            try { const device = await this.probe(address, controller.signal); if (!controller.signal.aborted) remember(device, address); }
            catch { /* Announced addresses may be stale; identities are never trusted without readback. */ }
            finally { state.checked++; emit(); }
          })();
          pending.add(task); void task.finally(() => { pending.delete(task); pump(); });
        }
      };
      const receive = (addresses:string[]) => {
        for(const address of addresses)if(range.contains(address)&&Date.now()-(attempted.get(address)??0)>5000&&(attempted.has(address)||attempted.size<256)){attempted.set(address,Date.now());queue.push(address);}
        pump();
      };
      const timer = this.options.durationMs===undefined ? undefined : setTimeout(() => { expired = true; controller.abort(); }, this.options.durationMs);
      const seedTask=savedPhase.then(saved=>{for(const address of saved.addresses)attempted.set(address,Date.now());return this.options.seeds?.(receive,controller.signal);}).catch(()=>{})??Promise.resolve();
      void (async () => {
        try {
          await (this.options.announcements ?? listenAnnouncements)(hint => receive(hint.addresses), controller.signal);
        } catch (error) { state.error = error instanceof Error ? error.message : 'Local device discovery failed'; }
        finally {
          await seedTask;
          while(!controller.signal.aborted&&pending.size)await Promise.allSettled([...pending]);
          await (await savedPhase).done;
          clearTimeout(timer); controller.abort(); await Promise.allSettled([...pending]);
          state.state = expired || state.error ? 'complete' : 'stopped'; emit(true);
        }
      })();
      return { id: state.id, method, total: 0 };
    }
  }
  async waitForCompletion(signal: AbortSignal) {
    const controller = this.controller, completion = this.completion;
    const abort = () => controller?.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { await completion; } finally { signal.removeEventListener('abort', abort); }
    signal.throwIfAborted();
  }
  stop() { this.controller?.abort(); this.controller = undefined; }
  dispose() { this.stop(); }
}
