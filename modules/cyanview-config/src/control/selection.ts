import { setTimeout as delay } from 'node:timers/promises';
import { createModuleDocumentClient, type ModuleHostServices, type ModuleDocumentSnapshot, type ModuleJsonValue } from '@hubble/module-sdk';
import { controlDevice, object, type Plan, type RecordValue } from '../model.js';

export type Selection = { enabled: Record<string, boolean>; singleSwitch: Record<string, boolean> };
export type SelectionMutation = { controllerId: string } & (
  { kind: 'camera'; cameraId: string; enabled: boolean | 'toggle' } |
  { kind: 'all'; enabled?: boolean } | { kind: 'single'; enabled: boolean | 'toggle' }
);
const empty = (): Selection => ({ enabled: {}, singleSwitch: {} });
export const selectionDocuments = () => ['camera-control', 'sample-camera-control'].map(id => ({
  id, label: 'Cyanview camera selection', version: 1, defaultValue: empty(),
}));

function parse(value: unknown): Selection {
  const raw = object(value);
  for (const key of ['enabled', 'singleSwitch']) {
    const entries = Object.entries(object(raw[key]));
    if (entries.length > 4096 || entries.some(([id, enabled]) => !/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || typeof enabled !== 'boolean'))
      throw new Error('Invalid Cyanview camera selection');
  }
  return { enabled: { ...object(raw.enabled) }, singleSwitch: { ...object(raw.singleSwitch) } };
}

export function applySelection(current: Selection, plan: Plan, mutations: readonly SelectionMutation[]): Selection {
  const next = structuredClone(current);
  for (const mutation of mutations) {
    const device = plan.devices.find(row => row.id === mutation.controllerId);
    if (!device || !controlDevice(device)) throw new Error('Choose a managed Cyanview controller');
    const rows = plan.cameras.filter(row => row.device === device.id);
    if (mutation.kind === 'camera') {
      if (!rows.some(row => row.id === mutation.cameraId)) throw new Error('Camera no longer exists on this controller');
      if (mutation.enabled !== 'toggle' && typeof mutation.enabled !== 'boolean') throw new Error('Invalid camera enable state');
      const enabled = mutation.enabled === 'toggle'
        ? next.singleSwitch[device.id] === true || !next.enabled[mutation.cameraId] : mutation.enabled;
      if (enabled && next.singleSwitch[device.id]) for (const row of rows) next.enabled[row.id] = false;
      next.enabled[mutation.cameraId] = enabled;
    } else if (mutation.kind === 'all') {
      if (mutation.enabled !== undefined && typeof mutation.enabled !== 'boolean') throw new Error('Invalid Enable All state');
      // The page says which way it goes, so a repeat can't undo it. A button toggles.
      const enabled = mutation.enabled ?? (rows.length > 0 && !rows.every(row => next.enabled[row.id]));
      if (enabled) next.singleSwitch[device.id] = false;
      for (const row of rows) next.enabled[row.id] = enabled;
    } else if (mutation.kind === 'single') {
      if (mutation.enabled !== 'toggle' && typeof mutation.enabled !== 'boolean') throw new Error('Invalid Single switch state');
      const enabled = mutation.enabled === 'toggle' ? !next.singleSwitch[device.id] : mutation.enabled;
      next.singleSwitch[device.id] = enabled;
      if (enabled) {
        const first = rows.find(row => next.enabled[row.id]);
        for (const row of rows) next.enabled[row.id] = row.id === first?.id;
      }
    } else throw new Error('Unknown Cyanview selection operation');
  }
  // Removed rows are inert; retaining bounded flags lets the existing session Undo restore selection.
  if (Object.keys(next.enabled).length > 512) {
    const ids = new Set(plan.cameras.map(row => row.id));
    next.enabled = Object.fromEntries(Object.entries(next.enabled).filter(([id]) => ids.has(id)));
  }
  if (Object.keys(next.singleSwitch).length > 128) {
    const ids = new Set(plan.devices.map(row => row.id));
    next.singleSwitch = Object.fromEntries(Object.entries(next.singleSwitch).filter(([id]) => ids.has(id)));
  }
  return next;
}

/** With no controller named, a selection action covers them all. Each press goes one way everywhere, so controllers can't drift apart. */
export function everyControllerMutations(current: Selection, plan: Plan, command: string, cameraNumber: unknown): SelectionMutation[] {
  const devices = plan.devices.filter(controlDevice);
  if (!devices.length) throw new Error('Add a controller on Cyanview’s Devices page first');
  const rows = plan.cameras.filter(row => devices.some(device => device.id === row.device));
  const ticked = (row: RecordValue) => current.enabled[row.id] === true;
  if (command === 'toggle-camera-enabled') {
    const matches = rows.filter(row => Number(row.number) === cameraNumber);
    if (!matches.length) throw new Error('No controller has this camera number');
    if (new Set(matches.map(row => row.device)).size !== matches.length) throw new Error('Choose a camera number that is unique on each controller');
    const enabled = !matches.every(ticked);
    // Under Single switch a press picks that camera, as it does with a controller named.
    return matches.map(row => ({ kind: 'camera', controllerId: row.device, cameraId: row.id, enabled: current.singleSwitch[row.device] === true || enabled }));
  }
  if (command === 'enable-all-cameras') {
    const enabled = rows.length > 0 && !rows.every(ticked);
    return devices.map(device => ({ kind: 'all', controllerId: device.id, enabled }));
  }
  if (devices.every(device => current.singleSwitch[device.id])) return devices.map(device => ({ kind: 'single', controllerId: device.id, enabled: false }));
  // The same camera number stays ticked on each controller, not whichever each one lists first.
  const kept = rows.find(ticked);
  return devices.flatMap((device): SelectionMutation[] => {
    const row = kept && rows.find(candidate => candidate.device === device.id && Number(candidate.number) === Number(kept.number));
    return [{ kind: 'all', controllerId: device.id, enabled: false }, { kind: 'single', controllerId: device.id, enabled: true },
      ...(row ? [{ kind: 'camera' as const, controllerId: device.id, cameraId: row.id as string, enabled: true }] : [])];
  });
}

/** Ordered document writes with an immediate optimistic projection shared by all views. */
export class ControlSelection {
  private documents: ReturnType<typeof createModuleDocumentClient>;
  private saved = empty();
  private pending: { id: string; mutations: readonly SelectionMutation[]; cancelled: boolean; task?: Promise<unknown> }[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private plan: Plan;
  private stopped = false;
  private watching?: Promise<void>;
  constructor(services: ModuleHostServices, private sample: boolean, plan: Plan, private changed: () => void, private onError: (error: unknown) => void = () => {}) {
    this.documents = createModuleDocumentClient(services); this.plan = plan;
  }
  private get id() { return this.sample ? 'sample-camera-control' : 'camera-control'; }
  async start(signal: AbortSignal) {
    this.saved = parse((await this.documents.read(this.id, signal)).value); this.emit();
    this.watching = this.follow(signal);
  }
  /** The host can refuse a watch for a moment just after it selects a module, and without one this copy would quietly go stale. */
  private async follow(signal: AbortSignal) {
    for (let failures = 0; !signal.aborted && !this.stopped;) {
      try {
        // Each new watch starts by reading the document, so it catches up on anything missed. Only a later change shows the watch works.
        let changes = 0;
        for await (const _document of this.documents.watch(this.id, signal)) {
          if (this.stopped) return;
          if (++changes > 1) failures = 0;
          await this.refresh(signal);
        }
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        failures += 1;
        if (failures === 3) this.onError(error);
        await delay(Math.min(250 * failures, 5000), undefined, { signal }).catch(() => undefined);
      }
    }
  }
  async refresh(signal: AbortSignal) {
    // Watch receipts must not apply a saved toggle twice while its optimistic operation is pending.
    for (;;) {
      const tail = this.tail; await tail.catch(() => undefined);
      signal.throwIfAborted();
      const document = await this.documents.read(this.id, signal);
      if (tail !== this.tail) continue;
      if (!this.stopped) { this.saved = parse(document.value); this.emit(); }
      return;
    }
  }
  /** What a press acts on: the saved document when nothing is waiting to save, or the saved edits plus those waiting. */
  async current(signal: AbortSignal) {
    if (!this.pending.length) await this.refresh(signal);
    return this.value();
  }
  setPlan(plan: Plan) { this.plan = plan; this.emit(); }
  value(): Selection {
    return this.pending.reduce((value, item) => {
      if (item.cancelled) return value;
      try { return applySelection(value, this.plan, item.mutations); } catch { return value; }
    }, this.saved);
  }
  snapshot() { return { ...this.value(), sequence: this.sequence }; }
  flush(controllerId?: string) {
    return controllerId ? Promise.all(this.pending.filter(item => item.mutations.some(mutation => mutation.controllerId === controllerId)).map(item => item.task)) : this.tail.catch(() => undefined);
  }
  mutate(id: string, mutations: readonly SelectionMutation[], signal: AbortSignal) {
    if (this.stopped || !mutations.length || mutations.length > 512 || id.length > 160) throw new Error('Invalid Cyanview selection edit');
    applySelection(this.value(), this.plan, mutations);
    const item: typeof this.pending[number] = { id, mutations, cancelled: false };
    this.pending.push(item); this.emit();
    const task = this.tail.catch(() => undefined).then(async () => {
      try {
        signal.throwIfAborted();
        if (item.cancelled || this.stopped) throw new Error('Selection cancelled because an earlier edit could not be saved');
        for (let attempt = 0; attempt < 4; attempt++) {
          const document: ModuleDocumentSnapshot = await this.documents.read(this.id, signal);
          const value = applySelection(parse(document.value), this.plan, mutations);
          try {
            await this.documents.write(document, value as unknown as ModuleJsonValue, signal);
            this.saved = value; return;
          } catch (error) {
            if (!(error instanceof Error) || !/conflict|changed/i.test(error.message) || attempt === 3) throw error;
          }
        }
      } catch (error) {
        const affected = new Set(mutations.map(mutation => mutation.controllerId));
        for (const later of this.pending.slice(this.pending.indexOf(item) + 1)) {
          if (later.mutations.some(mutation => affected.has(mutation.controllerId))) {
            later.cancelled = true;
            for (const mutation of later.mutations) affected.add(mutation.controllerId);
          }
        }
        throw error;
      } finally {
        this.pending = this.pending.filter(pending => pending !== item); this.emit();
      }
    });
    this.tail = task;
    item.task = task;
    // A caller owns the rejection; retaining an observed tail must not create an unhandled rejection.
    void task.catch(() => undefined);
    return task.then(() => this.snapshot());
  }
  dispose() { this.stopped = true; }
  private emit() { this.sequence++; if (!this.stopped) this.changed(); }
}
