import { setTimeout as delay } from 'node:timers/promises';
import { object, type RecordValue } from './model.js';
import type { ClientFactory } from './operations.js';
import type { PlanRepository } from './repository.js';
import type { RemiOperations } from './remi.js';

export type CameraEnabledOptions = {
  /** How long a camera stays off before it is switched back on. */
  holdMs?: number;
  /** How long to wait for a camera to report itself online before its copies are switched back on. */
  onlineWaitMs?: number;
};
/** Whether a camera reports itself online over MQTT, or null while nothing has said. */
export type CameraOnline = (device: string, number: number, key: string) => boolean | null;
export type EnabledJob = { device: string; key: string; text: string };
type Mode = 'on' | 'off' | 'refresh' | 'copies-on' | 'copies-off';

const enabled = (value: unknown) => value === '1' || value === 1 || value === true || value === 'true';
const message = (error: unknown) => error instanceof Error ? error.message : 'Camera Enabled could not be changed';

/**
 * Cyanview's own Enabled setting on each camera. A REMI copy stops answering its RCP once the camera it
 * comes from is switched off and on, until the copy is switched off and on itself. So a camera switched off
 * takes its copies with it, a camera switched on brings each copy back by switching it off and on in turn,
 * nearest first, and a refresh does both.
 */
export class CameraEnabledOperations {
  private tail: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, EnabledJob>();
  /** Our own writes, so the change a controller reports back isn't taken for someone else's. */
  private expected = new Map<string, { value: boolean; until: number }>();
  constructor(private repository: PlanRepository, private factory: ClientFactory, private remi: RemiOperations,
    private online: CameraOnline, private changed: () => void, private log: (message: string) => void,
    private lifetime: AbortSignal, private options: CameraEnabledOptions = {}) {}
  state(): EnabledJob[] { return [...this.jobs.values()]; }
  /** Switches a camera on or off on its controller, then its REMI copies the same way. */
  set(device: string, key: string, on: boolean, signal: AbortSignal) { return this.enqueue(() => this.apply(device, key, on ? 'on' : 'off', signal)); }
  /** Switches a camera off and on again, then each of its REMI copies, so copies that stopped answering come back. */
  refresh(device: string, key: string, signal: AbortSignal) { return this.enqueue(() => this.apply(device, key, 'refresh', signal)); }
  /** A controller reported its configuration. A camera switched off or on anywhere takes its copies with it. */
  observe(device: string, before: RecordValue | undefined, after: RecordValue) {
    if (!before) return;
    for (const [key, raw] of Object.entries(object(after.Camera))) {
      const was = object(before.Camera)[key];
      if (!was) continue;
      const now = enabled(object(raw).Enabled);
      if (now === enabled(object(was).Enabled)) continue;
      const mine = this.expected.get(device + '\n' + key);
      if (mine && mine.value === now && mine.until > Date.now()) { this.expected.delete(device + '\n' + key); continue; }
      void this.enqueue(() => this.apply(device, key, now ? 'copies-on' : 'copies-off', this.lifetime)).then(result => {
        if (result.copies) this.log('Camera ' + String(object(raw).Number ?? key) + ' was switched ' + (now ? 'on' : 'off') + ' outside Hubble, so its ' + result.copies + (result.copies === 1 ? ' copy was' : ' copies were') + (now ? ' switched off and on again' : ' switched off'));
      }, error => { if (!this.lifetime.aborted) this.log('Camera ' + String(object(raw).Number ?? key) + ' was switched ' + (now ? 'on' : 'off') + ' outside Hubble, but its copies could not follow: ' + message(error)); });
    }
  }
  private enqueue<T>(run: () => Promise<T>) {
    const task = this.tail.catch(() => undefined).then(run);
    this.tail = task;
    return task;
  }
  private note(device: string, key: string, text: string) { this.jobs.set(device + '\n' + key, { device, key, text }); this.changed(); }
  private done(device: string, key: string) { if (this.jobs.delete(device + '\n' + key)) this.changed(); }
  private async apply(deviceId: string, key: string, mode: Mode, signal: AbortSignal) {
    const { plan } = await this.repository.read(signal);
    const device = (id: string) => {
      const row = plan.devices.find(item => item.id === id);
      if (!row) throw new Error('Choose a managed controller');
      return row;
    };
    const touched: [string, string][] = [[deviceId, key]];
    try {
      let number = 0;
      if (mode === 'off') { this.note(deviceId, key, 'Switching off…'); number = await this.write(device(deviceId), key, false, signal); }
      if (mode === 'on') { this.note(deviceId, key, 'Switching on…'); number = await this.write(device(deviceId), key, true, signal); }
      if (mode === 'refresh') number = await this.cycle(device(deviceId), key, signal);
      if (mode === 'copies-on' || mode === 'copies-off') this.note(deviceId, key, 'Finding copies…');
      const { steps, unread } = await this.remi.copiesOf(deviceId, key, signal);
      if (mode === 'off' || mode === 'copies-off') {
        // The furthest copies first, so none is left answering for one already switched off.
        for (const step of [...steps].reverse()) {
          touched.push([step.receiver, step.key]);
          this.note(step.receiver, step.key, 'Switching off…');
          await this.write(device(step.receiver), step.key, false, signal);
          this.done(step.receiver, step.key);
        }
      } else if (steps.length) {
        this.note(deviceId, key, 'Refreshing copies…');
        if (!number) number = await this.number(device(deviceId), key, signal);
        await this.waitOnline(deviceId, number, key, signal);
        for (const [index, step] of steps.entries()) {
          touched.push([step.receiver, step.key]);
          const copyNumber = await this.cycle(device(step.receiver), step.key, signal);
          // A copy that others were made from has to be back before they are switched on.
          if (steps.some(child => child.parent === index)) await this.waitOnline(step.receiver, copyNumber, step.key, signal);
          this.done(step.receiver, step.key);
        }
      }
      return { copies: steps.length, unread };
    } finally {
      for (const [id, camera] of touched) this.done(id, camera);
    }
  }
  /** Off, a moment, then on again. */
  private async cycle(device: RecordValue, key: string, signal: AbortSignal) {
    this.note(device.id, key, 'Off, turning on…');
    await this.write(device, key, false, signal);
    await delay(this.options.holdMs ?? 1000, undefined, { signal });
    return this.write(device, key, true, signal);
  }
  private async number(device: RecordValue, key: string, signal: AbortSignal) {
    const client = this.factory(device.address || device.base);
    try {
      await client.connect(signal);
      return Number(client.config.Camera?.[key]?.Number) || 0;
    } finally { client.close(); }
  }
  /** Sets Enabled and waits for the controller to report it. Returns the camera's number. */
  private async write(device: RecordValue, key: string, on: boolean, signal: AbortSignal) {
    const client = this.factory(device.address || device.base);
    let number = 0;
    try {
      await client.connect(signal);
      if (client.serial !== device.serial) throw new Error('Controller identity changed. Refresh before sending.');
      const camera = client.config.Camera?.[key];
      if (!camera) throw new Error('The camera is no longer there');
      number = Number(camera.Number) || 0;
      if (enabled(camera.Enabled) === on) return number;
      this.expected.set(device.id + '\n' + key, { value: on, until: Date.now() + 15000 });
      const mapping = await client.mapping(key, 'Enabled', signal);
      await client.update(mapping.key, { [mapping.property]: on ? '1' : '0' }, signal);
      await client.waitFor(config => enabled(config.Camera?.[key]?.Enabled) === on, signal);
      return number;
    } catch (error) {
      this.expected.delete(device.id + '\n' + key);
      throw new Error((number ? 'Camera ' + number : 'A camera') + ' on ' + device.name + ': ' + message(error));
    } finally { client.close(); }
  }
  /** Waits for a camera to report itself online, up to a limit, since one that never does shouldn't hold up the rest. */
  private async waitOnline(device: string, number: number, key: string, signal: AbortSignal) {
    const until = Date.now() + (this.options.onlineWaitMs ?? 6000);
    while (Date.now() < until && this.online(device, number, key) !== true) await delay(100, undefined, { signal });
  }
}
