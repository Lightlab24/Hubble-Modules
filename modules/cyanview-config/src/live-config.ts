import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { controlDevice, validIp, type Plan, type RecordValue } from './model.js';
import type { CyanviewClient } from './transport.js';

export type LiveConfigOptions = {
  /** Waits between tries to reach a controller that isn't answering. The last one repeats. */
  retryMs?: number[];
  /** One send can change several things in a row, and changes this close together count once. */
  settleMs?: number;
  /** How long reaching one address may take before the next is tried. */
  connectMs?: number;
};
type Watch = { id: string; serial: string; hosts: string[]; stop: AbortController; client?: CyanviewClient; text: string; config?: RecordValue; timer?: ReturnType<typeof setTimeout> };
/** Each configuration a controller reports that differs from the last, with the one before it. None before the first. */
export type ConfigObserver = (id: string, before: RecordValue | undefined, after: RecordValue) => void;

// The base address first, as for MQTT, since no other controller can share it. The address it was added by is the way back.
const hostsOf = (device: RecordValue) => [...new Set([device.base, device.address].map(value => String(value ?? '')).filter(validIp))];

/**
 * Holds one settings socket open on every managed RCP, RIO and Gateway. A controller sends its whole
 * configuration to every open socket after every change, whoever made it, so each change counts up here
 * and an open page reads that controller again. Watching only listens: nothing goes to the controller but
 * the heartbeat its own web page sends.
 */
export class LiveConfig {
  private watches = new Map<string, Watch>();
  private counts: Record<string, number> = {};
  // A restarted worker counts from zero again, so an open page must be able to tell.
  private readonly epoch = randomUUID();
  private stopped = false;
  private observers = new Set<ConfigObserver>();
  constructor(private client: (address: string) => CyanviewClient, private changed: () => void, private options: LiveConfigOptions = {}) {}
  observe(observer: ConfigObserver) { this.observers.add(observer); return () => this.observers.delete(observer); }
  state() { return { epoch: this.epoch, counts: { ...this.counts } }; }
  setPlan(plan: Plan) {
    if (this.stopped) return;
    const wanted = new Map(plan.devices.filter(device => controlDevice(device) && device.serial && hostsOf(device).length).map(device => [String(device.id), device]));
    for (const [id, watch] of this.watches) {
      const device = wanted.get(id);
      if (!device || String(device.serial) !== watch.serial || hostsOf(device).join() !== watch.hosts.join()) this.forget(id);
    }
    for (const [id, device] of wanted) if (!this.watches.has(id)) this.watch(id, device);
  }
  /** The open socket to a controller that has answered as itself, for reading it without opening another. */
  connection(id: string) {
    const client = this.watches.get(id)?.client;
    return client?.connected ? client : undefined;
  }
  dispose() { this.stopped = true; for (const id of [...this.watches.keys()]) this.forget(id); }
  private forget(id: string) {
    const watch = this.watches.get(id);
    if (!watch) return;
    this.watches.delete(id); watch.stop.abort(); clearTimeout(watch.timer); watch.client?.close();
  }
  private watch(id: string, device: RecordValue) {
    const watch: Watch = { id, serial: String(device.serial), hosts: hostsOf(device), stop: new AbortController(), text: '' };
    this.watches.set(id, watch);
    void this.run(watch);
  }
  private async run(watch: Watch) {
    const retry = this.options.retryMs ?? [1000, 2000, 5000, 10000, 30000];
    let failures = 0;
    while (!watch.stop.signal.aborted) {
      let held = false;
      for (const host of watch.hosts) {
        if (watch.stop.signal.aborted) return;
        if (await this.listen(watch, host)) { held = true; break; }
      }
      // A socket that was open and dropped is tried again soon. A controller that isn't there is tried less and less often.
      failures = held ? 0 : failures + 1;
      try { await delay(retry[Math.min(failures, retry.length - 1)] ?? 1000, undefined, { signal: watch.stop.signal }); } catch { return; }
    }
  }
  /** Listens on one address until the socket closes. True once the controller there answered as itself. */
  private async listen(watch: Watch, host: string) {
    const signal = watch.stop.signal;
    let client: CyanviewClient | undefined;
    try {
      client = this.client(host);
      await client.connect(AbortSignal.any([signal, AbortSignal.timeout(this.options.connectMs ?? 5000)]));
      // Another controller can hold a LAN address set by mistake.
      if (client.serial !== watch.serial) return false;
      watch.client = client;
      this.seen(watch, client.config);
      const open = client;
      await new Promise<void>(resolve => {
        const done = () => { stopConfig(); stopDisconnect(); signal.removeEventListener('abort', done); resolve(); };
        const stopConfig = open.onConfig(config => this.seen(watch, config));
        const stopDisconnect = open.onDisconnect(done);
        signal.addEventListener('abort', done, { once: true });
        if (!open.connected || signal.aborted) done();
      });
      return true;
    } catch { return false; } finally {
      if (client && watch.client === client) watch.client = undefined;
      client?.close();
    }
  }
  private seen(watch: Watch, config: RecordValue) {
    const text = JSON.stringify(config);
    if (text === watch.text) return;
    const before = watch.config;
    watch.text = text; watch.config = config;
    for (const observer of this.observers) { try { observer(watch.id, before, config); } catch { /* One observer's failure doesn't stop the watch. */ } }
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      if (this.stopped || this.watches.get(watch.id) !== watch) return;
      this.counts[watch.id] = (this.counts[watch.id] ?? 0) + 1;
      this.changed();
    }, this.options.settleMs ?? 100);
    watch.timer.unref?.();
  }
}
