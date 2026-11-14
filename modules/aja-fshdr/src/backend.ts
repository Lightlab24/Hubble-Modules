import { setTimeout as delay } from 'node:timers/promises';
import { createModuleDocumentClient, ModuleDocumentConflictError, ModuleDocumentValueSchema, ModuleTableRowsSchema, type ModuleContext, type ModuleFeedbackSubscription, type ModuleInstance, type ModuleJsonValue } from '@hubble/module-sdk';
import { Device, object, parameterId, type Choice, type Limits, type WriteResult } from './device.js';
import { ACTION, MATCHES, TARGET_CHOICES, createActions, readCommand, type Command } from './actions.js';
import { applyMutation, channelRowId, defaultDocument, fieldById, newUnit, parseRowId, unitName, validHost, validateDocument, valueOf, watchedFieldIds, type FsDocument, type Mutation, type Unit } from './model.js';

export const PLAN = 'fshdr-plan', LEGACY_SETUP = 'setup';
/** `unset` has no address yet, and `duplicate` shares one with an earlier row. `disabled` means the connection is switched off in Hubble. */
export interface UnitObservation { state: 'unset' | 'duplicate' | 'disabled' | 'connecting' | 'live' | 'offline'; host: string; error: string | null; mode: string; channels: number[]; remote: boolean; name: string }
/** One sheet row: a unit, or one of its channels. `choices` points into the shared `choiceSets` list. */
export interface RowObservation { values: Record<string, string>; locked: Record<string, string>; choices: Record<string, number>; limits: Record<string, Limits>; errors: Record<string, string>; sending: string[]; queued: string[]; signal?: string }
export interface Observed { units: Record<string, UnitObservation>; rows: Record<string, RowObservation>; choiceSets: Choice[][]; sequence?: number }
interface Running { device: Device; address: string; controller: AbortController; task?: Promise<void> }
interface Transient { errors: Record<string, string>; sending: string[]; queued: string[] }

export const unitAddress = (host: string): string | null => { try { return host && validHost(host) ? new URL('http://' + host).origin : null; } catch { return null; } };

export function createBackend(context: ModuleContext): ModuleInstance {
  if (!context.services) throw Error('FS-HDR requires Hubble portable documents.');
  const documents = createModuleDocumentClient(context.services), lifetime = new AbortController();
  const canConnect = context.connectionEnabled !== false;
  const devices = new Map<string, Running>(), transient = new Map<string, Transient>();
  let plan: FsDocument = defaultDocument(), latestRevision: string | null = null, sequence = 0, started = false;
  let observed: Observed = { units: {}, rows: {}, choiceSets: [] };
  let subscriptions: readonly ModuleFeedbackSubscription[] = [], subscriptionSignal: AbortSignal | undefined, lastOnline: boolean | undefined;
  const waiters = new Set<() => void>();
  const transientFor = (rowId: string) => { let entry = transient.get(rowId); if (!entry) transient.set(rowId, entry = { errors: {}, sending: [], queued: [] }); return entry; };
  const hostOf = (unit: Unit) => unit.values['unit-host'] ?? '';

  function observe(): Observed {
    const watched = watchedFieldIds(plan), choiceSets: Choice[][] = [], setIndex = new Map<string, number>(), signatures = new WeakMap<Choice[], string>();
    const units: Observed['units'] = {}, rows: Observed['rows'] = {}, seenAddresses = new Set<string>();
    const rowFor = (rowId: string, device: Device | undefined, fieldIds: string[], channel: number | null): RowObservation => {
      const held = transient.get(rowId), row: RowObservation = { values: {}, locked: {}, choices: {}, limits: {}, errors: { ...held?.errors }, sending: [...held?.sending ?? []], queued: [...held?.queued ?? []] };
      if (!device || device.connection !== 'live') return row;
      for (const fieldId of fieldIds) {
        const id = parameterId(fieldId, channel, device.mode);
        if (!id) { row.locked[fieldId] = 'Not available in this operating mode.'; continue; }
        const reading = device.read(id);
        row.values[fieldId] = reading.value;
        if (reading.locked) row.locked[fieldId] = reading.locked;
        if (reading.limits) row.limits[fieldId] = reading.limits;
        if (reading.choices) {
          let signature = signatures.get(reading.choices);
          if (signature === undefined) signatures.set(reading.choices, signature = JSON.stringify(reading.choices));
          let index = setIndex.get(signature);
          if (index === undefined) { index = choiceSets.push(reading.choices) - 1; setIndex.set(signature, index); }
          row.choices[fieldId] = index;
        }
      }
      if (channel !== null) row.signal = device.label('eParamID_Vid' + channel + 'DetectedInputFormat');
      return row;
    };
    for (const unit of plan.units) {
      const host = hostOf(unit), address = unitAddress(host), running = devices.get(unit.id), device = running?.address === address ? running?.device : undefined;
      const duplicate = !!address && seenAddresses.has(address);
      if (address) seenAddresses.add(address);
      const live = device?.connection === 'live';
      units[unit.id] = { state: !address ? 'unset' : duplicate ? 'duplicate' : !canConnect ? 'disabled' : device?.connection ?? 'connecting', host, error: device?.error ?? null, mode: live ? device!.modeLabel : '', channels: live ? device!.channels : [], remote: live ? device!.remoteAllowed : false, name: live ? device!.name : '' };
      rows[unit.id] = rowFor(unit.id, device, watched.unit, null);
      for (const channel of units[unit.id]!.channels) rows[channelRowId(unit.id, channel)] = rowFor(channelRowId(unit.id, channel), device, watched.channel, channel);
    }
    return { units, rows, choiceSets };
  }
  function publishFeedback() {
    if (lifetime.signal.aborted) return;
    const live = plan.units.filter(unit => devices.get(unit.id)?.device.connection === 'live').length, online = plan.units.length > 0 && live === plan.units.length;
    if (lastOnline !== online) { lastOnline = online; context.publishFeedback({ id: 'all-online', state: online ? 'active' : 'unavailable', observedAt: online ? new Date().toISOString() : null }); }
    if (subscriptionSignal?.aborted) return;
    const observedAt = new Date().toISOString();
    for (const request of subscriptions) {
      if (request.id !== MATCHES) continue;
      const values = request.fields.values, command = object(values) && values.enabled !== false ? readCommand(values, true) : null;
      const seen = command ? targets(command.targets).map(unit => unit ? devices.get(unit.id)?.device.transformValue(command.processor) ?? null : null) : [];
      const available = canConnect && seen.length > 0 && seen.every(value => value !== null);
      context.publishFeedback({ ...request, state: !available ? 'unavailable' : seen.every(value => value === command?.transform) ? 'active' : 'inactive', observedAt: available ? observedAt : null });
    }
  }
  function publish() {
    if (lifetime.signal.aborted) return;
    observed = observe();
    // Clock-based so it keeps rising across a worker restart. The page uses it to ignore state that arrives late.
    sequence = Math.max(sequence + 1, Date.now());
    const states = Object.values(observed.units).map(unit => unit.state), live = states.filter(state => state === 'live').length;
    context.publishState({
      phase: live > 0 ? 'ready' : states.includes('connecting') ? 'connecting' : 'unavailable',
      message: live > 0 ? null : plan.units.length ? 'Waiting for FS-HDRs' : 'Add FS-HDRs in Setup',
      observedAt: new Date().toISOString(),
      values: { revision: latestRevision, sequence, ...(ModuleDocumentValueSchema.parse(observed) as Record<string, ModuleJsonValue>) },
    });
    publishFeedback();
    for (const wake of [...waiters]) wake();
  }
  // A unit can report many values at once, so the page hears about them at most ten times a second.
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publishSoon = () => { publishTimer ??= setTimeout(() => { publishTimer = undefined; publish(); }, 100); };
  const reply = (extra: Record<string, unknown> = {}) => ({ ...extra, ...observed, sequence }) as unknown as ModuleJsonValue;

  /** Keeps one connection per addressed unit, and drops the ones whose row or address has gone. */
  function planChanged(next: FsDocument) {
    plan = next;
    const wanted = new Map<string, string>(), taken = new Set<string>();
    for (const unit of plan.units) { const address = unitAddress(hostOf(unit)); if (address && !taken.has(address)) { taken.add(address); wanted.set(unit.id, address); } }
    for (const [unitId, running] of devices) if (wanted.get(unitId) !== running.address) { running.controller.abort(); devices.delete(unitId); }
    for (const [unitId, address] of wanted) {
      if (devices.has(unitId)) continue;
      const running: Running = { device: new Device(address, publishSoon), address, controller: new AbortController() };
      devices.set(unitId, running);
      if (canConnect && started) running.task = running.device.run(AbortSignal.any([lifetime.signal, running.controller.signal]));
    }
    const rowIds = new Set(plan.units.flatMap(unit => [unit.id, ...[0, 1, 2, 3, 4].map(channel => channelRowId(unit.id, channel))]));
    for (const [rowId, held] of transient) {
      if (!rowIds.has(rowId)) { transient.delete(rowId); continue; }
      // A failure only means something while that change is still waiting to go.
      for (const fieldId of Object.keys(held.errors)) if (!valueOf(plan, rowId, fieldId)) delete held.errors[fieldId];
    }
  }
  async function readPlan(signal: AbortSignal): Promise<FsDocument> {
    const saved = await documents.read(PLAN, signal);
    latestRevision = saved.revision;
    planChanged(validateDocument(saved.value));
    return plan;
  }
  async function savePlan(operation: Mutation, signal: AbortSignal): Promise<FsDocument> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await documents.read(PLAN, signal), next = applyMutation(validateDocument(saved.value), operation);
      try { const result = await documents.write(saved, ModuleDocumentValueSchema.parse(next), signal); latestRevision = result.revision; planChanged(next); publish(); return next; }
      catch (error) { if (!(error instanceof ModuleDocumentConflictError) || attempt === 2) throw error; }
    }
    throw Error('The FS-HDR plan changed before saving.');
  }
  /** Units set up in the previous version of this module come across once, when the new plan is still empty. */
  async function adoptEarlierSetup(signal: AbortSignal) {
    if (plan.units.length) return;
    let rows = ModuleTableRowsSchema.safeParse(context.settings.devices ?? []).data ?? [];
    try { const earlier = await documents.read(LEGACY_SETUP, signal); if (object(earlier.value) && Array.isArray(earlier.value.devices)) rows = ModuleTableRowsSchema.parse(earlier.value.devices); } catch { /* No earlier setup to bring across. */ }
    const add = rows.flatMap((row, index) => {
      const host = typeof row.values.address === 'string' ? row.values.address.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
      if (!validHost(host)) return [];
      const unit = newUnit(/^[^#]+$/.test(row.id) && row.id !== 'master' ? row.id : 'unit-' + (index + 1), typeof row.values.name === 'string' && row.values.name.trim() ? row.values.name.trim().slice(0, 96) : 'FS-HDR ' + (index + 1), host);
      unit.values['unit-allow'] = row.values.access === 'control' ? 'TRUE' : 'FALSE';
      return [unit];
    });
    if (add.length) await savePlan({ kind: 'units', add, remove: [] }, signal).catch(error => context.log({ level: 'error', stage: 'fshdr-plan', message: 'Earlier FS-HDR setup was not brought across: ' + (error instanceof Error ? error.message : String(error)) }));
  }
  const targets = (list: string[]): (Unit | undefined)[] => list.length === 1 && list[0] === 'all' ? plan.units.filter(unit => devices.has(unit.id))
    : [...new Set(list.map(entry => unitAddress(entry.replace(/^https?:\/\//, '').replace(/\/$/, '')) ?? entry))].map(address => plan.units.find(unit => devices.get(unit.id)?.address === address));
  const sendRefusal = (unit: Unit): string | null => !canConnect || !started ? 'Device connections are switched off in Hubble.' : unit.values['unit-allow'] !== 'TRUE' ? 'Allow sends is off for ' + unitName(unit) + ' in Setup.' : null;
  /** A button press: one transform on one channel of each chosen unit, each confirmed by readback. */
  async function apply(command: Command, signal: AbortSignal): Promise<(WriteResult & { address: string })[]> {
    const requested = targets(command.targets), limit = AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(23_000)]);
    if (!requested.length) return [{ address: 'All configured units', ok: false, message: 'No units configured' }];
    return await Promise.all(requested.map(async (unit, index) => {
      const running = unit && devices.get(unit.id), address = running?.address ?? command.targets[index] ?? 'FS-HDR';
      if (!unit || !running) return { address, ok: false, message: 'Unit is not configured' };
      const refusal = sendRefusal(unit);
      if (refusal) return { address, ok: false, message: refusal };
      if (!running.device.channels.includes(command.processor)) return { address, ok: false, message: 'Processor is unavailable in this mode' };
      const result = await running.device.write('eParamID_Vid' + command.processor + 'ColorHDRTransform', command.transform, AbortSignal.any([limit, running.controller.signal]));
      context.log({ level: result.ok ? 'info' : 'error', stage: 'fshdr-send', message: unitName(unit) + ' Video ' + command.processor + ' transform ' + command.transform + ': ' + result.message });
      return { address, ...result };
    }));
  }
  const actions = createActions(apply);

  return {
    async start() {
      if (started || lifetime.signal.aborted) return;
      started = true;
      await readPlan(lifetime.signal);
      await adoptEarlierSetup(lifetime.signal);
      if (canConnect) for (const running of devices.values()) running.task ??= running.device.run(AbortSignal.any([lifetime.signal, running.controller.signal]));
      publish();
      void (async () => {
        while (!lifetime.signal.aborted) {
          try { for await (const saved of documents.watch(PLAN, lifetime.signal)) { if (saved.revision === latestRevision) continue; latestRevision = saved.revision; planChanged(validateDocument(saved.value)); publish(); } }
          catch { if (lifetime.signal.aborted) return; await delay(1000, undefined, { signal: lifetime.signal }).catch(() => {}); }
        }
      })();
    },
    async call(method: string, raw: ModuleJsonValue | undefined, execution: { signal: AbortSignal }): Promise<ModuleJsonValue> {
      if (method !== 'page.fshdr' || !object(raw) || raw.sectionId !== 'frontend') throw Error('Unknown FS-HDR page command.');
      const { signal } = execution, input = object(raw.value) ? raw.value : {};
      signal.throwIfAborted();
      if (raw.commandId === 'snapshot') { const document = await readPlan(signal); observed = observe(); return reply({ document, revision: latestRevision }); }
      if (raw.commandId === 'save') { const document = await savePlan(input.operation as Mutation, signal); return reply({ document, revision: latestRevision }); }
      if (raw.commandId === 'changes') {
        // Parks until something changes, so a change at the unit reaches the page straight away.
        const after = Number(input.after ?? 0);
        if (sequence <= after) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); waiters.delete(finish); resolve(); };
          const timer = setTimeout(finish, 20000);
          signal.addEventListener('abort', finish, { once: true }); waiters.add(finish);
        });
        return reply();
      }
      if (raw.commandId === 'refresh') {
        // Reads every unit again from scratch: its settings list, its mappings and every value.
        if (!canConnect) throw Error('Device connections are switched off in Hubble.');
        const chosen = Array.isArray(input.unitIds) ? [...devices].filter(([unitId]) => (input.unitIds as unknown[]).includes(unitId)) : [...devices];
        for (const [, running] of chosen) running.device.restart();
        const deadline = Date.now() + 6000;
        await delay(150, undefined, { signal }).catch(() => {});
        while (!signal.aborted && Date.now() < deadline && chosen.some(([, running]) => running.device.connection === 'connecting')) await delay(100, undefined, { signal }).catch(() => {});
        publish();
        return reply({ status: 'read' });
      }
      const rowId = String(input.rowId ?? ''), { unitId, channel } = parseRowId(rowId), held = transientFor(rowId);
      if (raw.commandId === 'cancel-send') {
        // Whatever is mid-write finishes. Everything behind it comes out of the queue.
        const drop = new Set(Array.isArray(input.fieldIds) ? input.fieldIds as string[] : held.queued);
        held.queued = held.queued.filter(id => !drop.has(id)); publish();
        return { status: 'cancelled' };
      }
      if (raw.commandId !== 'send') throw Error('Unknown FS-HDR operation.');
      const unit = (await readPlan(signal)).units.find(item => item.id === unitId), running = devices.get(unitId);
      if (!unit || !running) throw Error('Choose an FS-HDR in this workspace.');
      if (!Array.isArray(input.fieldIds) || input.fieldIds.length > 64 || input.fieldIds.some(id => typeof id !== 'string' || !fieldById.has(id))) throw Error('Invalid setting selection.');
      const refusal = sendRefusal(unit) ?? (running.device.connection !== 'live' ? unitName(unit) + ' is offline.' : !running.device.remoteAllowed ? 'Remote control is switched off on ' + unitName(unit) + '.' : null);
      if (refusal) throw Error(refusal);
      const outcomes: { fieldId: string; status: string; message?: string }[] = [];
      // Queued first, so a cancel while an earlier setting is being written still counts.
      held.queued = [...new Set(input.fieldIds as string[])]; publish();
      try {
        while (held.queued.length) {
          signal.throwIfAborted();
          const fieldId = held.queued.shift()!;
          // The saved plan decides at the moment of writing, so a change cancelled since Send never goes out.
          const latest = await readPlan(signal), value = valueOf(latest, rowId, fieldId), id = parameterId(fieldId, channel, running.device.mode);
          delete held.errors[fieldId];
          if (!value || hostOf(latest.units.find(item => item.id === unitId) ?? unit) !== hostOf(unit)) continue;
          if (!id) { held.errors[fieldId] = 'Not available in this operating mode.'; outcomes.push({ fieldId, status: 'failed', message: held.errors[fieldId] }); continue; }
          if (running.device.read(id).value === value) { outcomes.push({ fieldId, status: 'verified' }); continue; }
          held.sending = [fieldId]; publish();
          const result = await running.device.write(id, value, AbortSignal.any([signal, lifetime.signal, running.controller.signal]));
          held.sending = [];
          context.log({ level: result.ok ? 'info' : 'error', stage: 'fshdr-send', message: (unitName(unit) + (channel === null ? '' : ' channel ' + channel) + ' ' + fieldId + ' = ' + value + ': ' + result.message).slice(0, 600) });
          if (result.ok) outcomes.push({ fieldId, status: 'verified' }); else { held.errors[fieldId] = result.message; outcomes.push({ fieldId, status: 'failed', message: result.message }); }
          publish();
        }
        return reply({ status: 'sent', outcomes });
      } finally { held.sending = []; held.queued = []; publish(); }
    },
    async execute(id, fields, execution) {
      if (id === ACTION && object(fields.values)) return actions.execute(fields.values.enabled === false ? null : readCommand(fields.values, true), execution);
      return actions.generic.execute(id, fields, execution);
    },
    discoverChoices(query, { signal }) {
      signal.throwIfAborted();
      const search = query.search.trim().toLowerCase();
      const choices = query.provider === TARGET_CHOICES ? [{ id: 'all', label: 'All configured units' }, ...plan.units.flatMap(unit => { const address = devices.get(unit.id)?.address; return address ? [{ id: address, label: (unitName(unit) + ' · ' + hostOf(unit)).slice(0, 160) }] : []; })].filter(choice => (choice.label + ' ' + choice.id).toLowerCase().includes(search)) : [];
      const offset = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0, next = offset + query.limit;
      return { revision: 'fshdr-targets', choices: choices.slice(offset, next), nextCursor: next < choices.length ? String(next) : null };
    },
    subscribeFeedback(next, { signal }) { subscriptions = next; subscriptionSignal = signal; publishFeedback(); },
    async dispose() {
      if (lifetime.signal.aborted) return;
      clearTimeout(publishTimer);
      for (const wake of [...waiters]) wake();
      const tasks = [...devices.values()].flatMap(running => running.task ? [running.task] : []);
      lifetime.abort(); subscriptions = [];
      await Promise.allSettled(tasks);
      context.publishFeedback({ id: 'all-online', state: 'unavailable', observedAt: null });
    },
  };
}
