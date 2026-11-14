import { setTimeout as delay } from 'node:timers/promises';
import { createModuleDocumentClient, ModuleDocumentConflictError, ModuleDocumentValueSchema, ModuleTableRowsSchema, type ModuleContext, type ModuleFeedbackSubscription, type ModuleInstance, type ModuleJsonValue } from '@hubble/module-sdk';
import { Device, PREREQUISITE, object, parameterId, type Choice, type Limits, type WriteResult } from './device.js';
import { ACTION, MATCHES, TARGET_CHOICES, createActions, readCommand, type Command } from './actions.js';
import { catalog, plannedReading } from './catalog.js';
import { simulatedTransport } from './simulated.js';
import { applyMutation, channelRowId, clone, defaultDocument, fieldById, isSimulated, maxUnits, modeLabel, newUnit, parseRowId, plannedChannels, plannedMode, same, unitName, validHost, validateDocument, valueOf, watchedFieldIds, type FsDocument, type Mutation, type Unit } from './model.js';

export const PLAN = 'fshdr-plan', LEGACY_SETUP = 'setup', SIMULATED = 'fshdr-sim';
/**
 * `unset` has no address yet, and `duplicate` shares one with an earlier row. `disabled` means the connection is switched off in Hubble.
 * A unit that isn't live is `planned`: its rows come from the mode chosen in Setup and its choices from the bundled firmware list.
 * A `simulated` unit is a built-in stand-in; `changes` is every setting written to it, as sheet values by row, so they can become presets.
 */
export interface UnitObservation { state: 'unset' | 'duplicate' | 'disabled' | 'connecting' | 'live' | 'offline'; host: string; error: string | null; mode: string; channels: number[]; remote: boolean; name: string; modeValue?: string; planned?: boolean; simulated?: boolean; changes?: Record<string, Record<string, string>> }
/** One sheet row: a unit, or one of its channels. `choices` points into the shared `choiceSets` list. A `planned` row has no values yet. */
export interface RowObservation { values: Record<string, string>; locked: Record<string, string>; choices: Record<string, number>; limits: Record<string, Limits>; errors: Record<string, string>; sending: string[]; queued: string[]; signal?: string; planned?: boolean }
/** What has been written to each simulated unit, by the unit's own setting IDs. Saved so a simulated unit keeps its settings over a restart. */
interface SimulatedDocument { version: 1; units: Record<string, Record<string, string>> }
const emptySimulated = (): SimulatedDocument => ({ version: 1, units: {} });
const validSimulated = (value: unknown): SimulatedDocument => object(value) && value.version === 1 && object(value.units) && Object.values(value.units).every(changes => object(changes) && Object.values(changes).every(item => typeof item === 'string')) ? clone(value) as unknown as SimulatedDocument : emptySimulated();
const simulatedKey = (unit: Unit) => 'simulated:' + unit.id + ':' + plannedMode(unit);
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
  let carried: Unit[] = [];
  let simulated = emptySimulated(), simulatedDirty = false;
  const withCarried = (doc: FsDocument): FsDocument => carried.length && !doc.adopted && !doc.units.length ? { ...doc, units: clone(carried), adopted: true } : doc;
  const transientFor = (rowId: string) => { let entry = transient.get(rowId); if (!entry) transient.set(rowId, entry = { errors: {}, sending: [], queued: [] }); return entry; };
  const hostOf = (unit: Unit) => unit.values['unit-host'] ?? '';

  /** Settings written to a simulated unit, as the sheet shows them, by row. Turning Simulated off stages them as presets for the real unit. */
  function simulatedChanges(unit: Unit, device: Device): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {}, { logical } = catalog();
    const put = (rowId: string, fieldId: string, value: string) => { if (value) (out[rowId] ??= {})[fieldId] = value; };
    for (const id of Object.keys(simulated.units[unit.id] ?? {})) {
      if (id === 'eParamID_SystemName') { put(unit.id, 'SystemName', device.read(id).value); continue; }
      const label = /^eParamID_Vid([0-4])_ChannelName$/.exec(id);
      if (label) { const n = Number(label[1]); if (device.channels.includes(n)) put(unit.id, 'ChannelName' + (n === 0 ? 1 : n), device.read(id).value); continue; }
      const setting = logical.get(id) ?? id, match = /^eParamID_Vid([0-4])(.+)$/.exec(setting);
      if (match) { const n = Number(match[1]), fieldId = 'Vid#' + match[2]; if (fieldById.has(fieldId) && device.channels.includes(n)) put(channelRowId(unit.id, n), fieldId, device.read(setting).value); continue; }
      const fieldId = setting.replace(/^eParamID_/, '');
      if (fieldById.get(fieldId)?.scope === 'unit') put(unit.id, fieldId, device.read(setting).value);
    }
    return out;
  }
  /** A staged value for the setting a mapped one depends on, so a preset's choices follow, say, a preset frame rate. */
  const stagedParameter = (unit: Unit) => (paramId: string): string | undefined => {
    const match = /^eParamID_Vid([0-4])(.+)$/.exec(paramId);
    if (match) { const fieldId = 'Vid#' + match[2]; return fieldById.has(fieldId) ? unit.channels?.[match[1]!]?.[fieldId] || undefined : undefined; }
    const fieldId = paramId.replace(/^eParamID_/, '');
    return fieldById.get(fieldId)?.scope === 'unit' ? unit.values[fieldId] || undefined : undefined;
  };
  function observe(): Observed {
    const watched = watchedFieldIds(plan), choiceSets: Choice[][] = [], setIndex = new Map<string, number>(), signatures = new WeakMap<Choice[], string>();
    const units: Observed['units'] = {}, rows: Observed['rows'] = {}, seenAddresses = new Set<string>();
    const choiceIndex = (choices: Choice[]) => {
      let signature = signatures.get(choices);
      if (signature === undefined) signatures.set(choices, signature = JSON.stringify(choices));
      let index = setIndex.get(signature);
      if (index === undefined) { index = choiceSets.push(choices) - 1; setIndex.set(signature, index); }
      return index;
    };
    // A unit that isn't live: no values yet, but every setting it will have, with the choices and ranges it will offer.
    const plannedRow = (unit: Unit, rowId: string, fieldIds: string[], channel: number | null): RowObservation => {
      const row: RowObservation = { values: {}, locked: {}, choices: {}, limits: {}, errors: { ...transient.get(rowId)?.errors }, sending: [], queued: [], planned: true };
      const mode = plannedMode(unit), staged = stagedParameter(unit);
      for (const fieldId of fieldIds) {
        const id = parameterId(fieldId, channel, mode), reading = id ? plannedReading(id, staged) : null;
        if (!id) { row.locked[fieldId] = 'Not available in this operating mode.'; continue; }
        if (!reading) { row.locked[fieldId] = 'This FS-HDR firmware list doesn’t have this setting.'; continue; }
        if (reading.readOnly) row.locked[fieldId] = 'The unit reports this value. It can’t be set.';
        if (reading.limits) row.limits[fieldId] = reading.limits;
        if (reading.choices) row.choices[fieldId] = choiceIndex(reading.choices);
      }
      return row;
    };
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
        if (reading.choices) row.choices[fieldId] = choiceIndex(reading.choices);
      }
      if (channel !== null) row.signal = device.label('eParamID_Vid' + channel + 'DetectedInputFormat');
      return row;
    };
    for (const unit of plan.units) {
      const host = hostOf(unit), simulatedUnit = isSimulated(unit), address = simulatedUnit ? null : unitAddress(host), running = devices.get(unit.id);
      const device = running && running.address === (simulatedUnit ? simulatedKey(unit) : address) ? running.device : undefined;
      const duplicate = !!address && seenAddresses.has(address);
      if (address) seenAddresses.add(address);
      const live = device?.connection === 'live';
      const state = simulatedUnit ? (!canConnect ? 'disabled' : device?.connection ?? 'connecting') : !address ? 'unset' : duplicate ? 'duplicate' : !canConnect ? 'disabled' : device?.connection ?? 'connecting';
      units[unit.id] = {
        state, host, error: device?.error ?? null, mode: live ? device!.modeLabel : modeLabel(plannedMode(unit)), channels: live ? device!.channels : plannedChannels(unit),
        remote: live ? device!.remoteAllowed : false, name: live ? device!.name : '', ...(live ? { modeValue: device!.mode } : { planned: true }),
        ...(simulatedUnit ? { simulated: true } : {}), ...(simulatedUnit && live ? { changes: simulatedChanges(unit, device!) } : {}),
      };
      rows[unit.id] = live ? rowFor(unit.id, device, watched.unit, null) : plannedRow(unit, unit.id, watched.unit, null);
      for (const channel of units[unit.id]!.channels) { const rowId = channelRowId(unit.id, channel); rows[rowId] = live ? rowFor(rowId, device, watched.channel, channel) : plannedRow(unit, rowId, watched.channel, channel); }
    }
    return { units, rows, choiceSets };
  }
  function publishFeedback() {
    if (lifetime.signal.aborted) return;
    // Buttons only count real units. A simulated one never makes a show look ready.
    const real = plan.units.filter(unit => !isSimulated(unit)), live = real.filter(unit => devices.get(unit.id)?.device.connection === 'live').length, online = real.length > 0 && live === real.length;
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
    const all = Object.values(observed.units), states = all.filter(unit => !unit.simulated).map(unit => unit.state), live = states.filter(state => state === 'live').length;
    const simulatedLive = all.some(unit => unit.simulated && unit.state === 'live');
    context.publishState({
      phase: live > 0 || simulatedLive ? 'ready' : states.includes('connecting') ? 'connecting' : 'unavailable',
      message: live > 0 ? null : simulatedLive ? 'Simulated FS-HDRs only' : plan.units.length ? 'Waiting for FS-HDRs' : 'Add FS-HDRs in Setup',
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

  /** Keeps one connection per addressed unit and one simulated unit per Simulated row, and drops the ones whose row, address or mode has gone. */
  function planChanged(next: FsDocument) {
    plan = next;
    const wanted = new Map<string, string>(), taken = new Set<string>();
    for (const unit of plan.units) {
      if (isSimulated(unit)) { wanted.set(unit.id, simulatedKey(unit)); continue; }
      const address = unitAddress(hostOf(unit)); if (address && !taken.has(address)) { taken.add(address); wanted.set(unit.id, address); }
    }
    for (const [unitId, running] of devices) if (wanted.get(unitId) !== running.address) { running.controller.abort(); devices.delete(unitId); }
    // A row that stops being simulated starts from the bench values if it is simulated again. The saved copy follows at the next command.
    for (const unitId of Object.keys(simulated.units)) if (!plan.units.some(unit => unit.id === unitId && isSimulated(unit))) { delete simulated.units[unitId]; simulatedDirty = true; }
    for (const [unitId, address] of wanted) {
      if (devices.has(unitId)) continue;
      const unit = plan.units.find(item => item.id === unitId)!;
      const transport = isSimulated(unit) ? simulatedTransport({ name: unit.values['unit-name'] ?? '', mode: plannedMode(unit), changes: simulated.units[unitId] ??= {}, onWrite: () => { simulatedDirty = true; } }) : undefined;
      const running: Running = { device: new Device(address, publishSoon, transport), address, controller: new AbortController() };
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
  /** Saves what has been written to simulated units. Hubble only lets a module save during a command, so commands call this. */
  async function saveSimulated(signal: AbortSignal): Promise<void> {
    if (!simulatedDirty) return;
    const next: SimulatedDocument = { version: 1, units: Object.fromEntries(Object.entries(simulated.units).filter(([, changes]) => Object.keys(changes).length)) };
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await documents.read(SIMULATED, signal);
      if (same(saved.value, next)) { simulatedDirty = false; return; }
      try { await documents.write(saved, ModuleDocumentValueSchema.parse(next), signal); simulatedDirty = false; return; }
      catch (error) { if (!(error instanceof ModuleDocumentConflictError) || attempt === 2) throw error; }
    }
  }
  const saveSimulatedQuietly = (signal: AbortSignal) => saveSimulated(signal).catch(error => context.log({ level: 'error', stage: 'fshdr-simulated', message: 'Simulated FS-HDR settings could not be saved: ' + (error instanceof Error ? error.message : String(error)) }));
  async function readPlan(signal: AbortSignal): Promise<FsDocument> {
    const saved = await documents.read(PLAN, signal);
    latestRevision = saved.revision;
    planChanged(withCarried(validateDocument(saved.value)));
    return plan;
  }
  async function savePlan(operation: Mutation, signal: AbortSignal): Promise<FsDocument> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await documents.read(PLAN, signal), next = applyMutation(withCarried(validateDocument(saved.value)), operation);
      try { const result = await documents.write(saved, ModuleDocumentValueSchema.parse(next), signal); latestRevision = result.revision; planChanged(next); publish(); return next; }
      catch (error) { if (!(error instanceof ModuleDocumentConflictError) || attempt === 2) throw error; }
    }
    throw Error('The FS-HDR plan changed before saving.');
  }
  /**
   * Units set up in version 1 come across once, while the new plan has never held any. Hubble lets a module save its
   * documents only during a command, so they are used from memory straight away and saved by the first command.
   */
  async function earlierUnits(signal: AbortSignal): Promise<Unit[]> {
    let rows = ModuleTableRowsSchema.safeParse(context.settings.devices ?? []).data ?? [];
    try { const earlier = await documents.read(LEGACY_SETUP, signal); if (object(earlier.value) && Array.isArray(earlier.value.devices)) rows = ModuleTableRowsSchema.parse(earlier.value.devices); } catch { /* No earlier setup to bring across. */ }
    const ids = new Set<string>();
    return rows.flatMap((row, index) => {
      const host = typeof row.values.address === 'string' ? row.values.address.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
      const id = /^[^#]+$/.test(row.id) && row.id !== 'master' ? row.id : 'unit-' + (index + 1);
      if (!validHost(host) || ids.has(id)) return [];
      ids.add(id);
      const unit = newUnit(id, typeof row.values.name === 'string' && row.values.name.trim() ? row.values.name.trim().slice(0, 96) : 'FS-HDR ' + (index + 1), host);
      unit.values['unit-allow'] = row.values.access === 'control' ? 'TRUE' : 'FALSE';
      return [unit];
    }).slice(0, maxUnits);
  }
  let saving: Promise<void> | undefined;
  /** Saves the carried-over units. Called at the start of every command until it has worked. */
  const saveCarried = (signal: AbortSignal): Promise<void> | undefined => carried.length ? saving ??= savePlan({ kind: 'units', add: [], remove: [] }, signal).then(() => { carried = []; }, error => context.log({ level: 'error', stage: 'fshdr-plan', message: 'Earlier FS-HDR setup could not be saved: ' + (error instanceof Error ? error.message : String(error)) })).finally(() => { saving = undefined; }) : undefined;
  // Buttons never control a simulated unit, so a press during a show can't look confirmed by one.
  const targets = (list: string[]): (Unit | undefined)[] => list.length === 1 && list[0] === 'all' ? plan.units.filter(unit => !isSimulated(unit) && devices.has(unit.id))
    : [...new Set(list.map(entry => unitAddress(entry.replace(/^https?:\/\//, '').replace(/\/$/, '')) ?? entry))].map(address => plan.units.find(unit => !isSimulated(unit) && devices.get(unit.id)?.address === address));
  const simulatedAt = (target: string): Unit | undefined => { const address = unitAddress(target.replace(/^https?:\/\//, '').replace(/\/$/, '')); return address ? plan.units.find(unit => isSimulated(unit) && unitAddress(hostOf(unit)) === address) : undefined; };
  const sendRefusal = (unit: Unit): string | null => !canConnect || !started ? 'Device connections are switched off in Hubble.' : unit.values['unit-allow'] !== 'TRUE' ? 'Allow sends is off for ' + unitName(unit) + ' in Setup.' : null;
  /** A button press: one transform on one channel of each chosen unit, each confirmed by readback. */
  async function apply(command: Command, signal: AbortSignal): Promise<(WriteResult & { address: string })[]> {
    const requested = targets(command.targets), limit = AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(23_000)]);
    if (!requested.length) return [{ address: 'All configured units', ok: false, message: plan.units.some(isSimulated) ? 'Every FS-HDR in Setup is simulated, and buttons don’t control simulated units' : 'No units configured' }];
    return await Promise.all(requested.map(async (unit, index) => {
      const running = unit && devices.get(unit.id), address = running?.address ?? command.targets[index] ?? 'FS-HDR';
      const standIn = unit ? undefined : simulatedAt(command.targets[index] ?? '');
      if (standIn) return { address, ok: false, message: unitName(standIn) + ' is simulated in Setup, and buttons don’t control simulated units' };
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
      // Read before the plan, so a simulated unit starts with what was written to it last time.
      try { simulated = validSimulated((await documents.read(SIMULATED, lifetime.signal)).value); } catch { simulated = emptySimulated(); }
      await readPlan(lifetime.signal);
      if (!plan.adopted && !plan.units.length) { carried = await earlierUnits(lifetime.signal); planChanged(withCarried(plan)); }
      if (canConnect) for (const running of devices.values()) running.task ??= running.device.run(AbortSignal.any([lifetime.signal, running.controller.signal]));
      publish();
      void (async () => {
        while (!lifetime.signal.aborted) {
          try { for await (const saved of documents.watch(PLAN, lifetime.signal)) { if (saved.revision === latestRevision) continue; latestRevision = saved.revision; planChanged(withCarried(validateDocument(saved.value))); publish(); } }
          catch { if (lifetime.signal.aborted) return; await delay(1000, undefined, { signal: lifetime.signal }).catch(() => {}); }
        }
      })();
    },
    async call(method: string, raw: ModuleJsonValue | undefined, execution: { signal: AbortSignal }): Promise<ModuleJsonValue> {
      if (method !== 'page.fshdr' || !object(raw) || raw.sectionId !== 'frontend') throw Error('Unknown FS-HDR page command.');
      const { signal } = execution, input = object(raw.value) ? raw.value : {};
      signal.throwIfAborted();
      await saveCarried(signal);
      if (raw.commandId === 'snapshot') { const document = await readPlan(signal); observed = observe(); return reply({ document, revision: latestRevision }); }
      if (raw.commandId === 'save') { const document = await savePlan(input.operation as Mutation, signal); await saveSimulatedQuietly(signal); return reply({ document, revision: latestRevision }); }
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
      // A setting whose prerequisite is off waits for the rest of the batch, which may switch it on, and is tried once more.
      const later: string[] = [], retried = new Set<string>();
      try {
        for (;;) {
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
            if (!result.ok && result.message === PREREQUISITE && !retried.has(fieldId)) { retried.add(fieldId); later.push(fieldId); continue; }
            context.log({ level: result.ok ? 'info' : 'error', stage: 'fshdr-send', message: (unitName(unit) + (channel === null ? '' : ' channel ' + channel) + ' ' + fieldId + ' = ' + value + ': ' + result.message).slice(0, 600) });
            if (result.ok) outcomes.push({ fieldId, status: 'verified' }); else { held.errors[fieldId] = result.message; outcomes.push({ fieldId, status: 'failed', message: result.message }); }
            publish();
          }
          if (!later.length) break;
          held.queued = later.splice(0);
        }
        return reply({ status: 'sent', outcomes });
      } finally { held.sending = []; held.queued = []; if (isSimulated(unit)) await saveSimulatedQuietly(signal); publish(); }
    },
    async execute(id, fields, execution) {
      await saveCarried(execution.signal);
      if (id === ACTION && object(fields.values)) return actions.execute(fields.values.enabled === false ? null : readCommand(fields.values, true), execution);
      return actions.generic.execute(id, fields, execution);
    },
    discoverChoices(query, { signal }) {
      signal.throwIfAborted();
      const search = query.search.trim().toLowerCase();
      const choices = query.provider === TARGET_CHOICES ? [{ id: 'all', label: 'All configured units' }, ...plan.units.flatMap(unit => { const address = isSimulated(unit) ? undefined : devices.get(unit.id)?.address; return address ? [{ id: address, label: (unitName(unit) + ' · ' + hostOf(unit)).slice(0, 160) }] : []; })].filter(choice => (choice.label + ' ' + choice.id).toLowerCase().includes(search)) : [];
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
