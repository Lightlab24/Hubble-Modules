import { randomUUID } from 'node:crypto';
import type { HubbleModule, ModuleContext, ModuleInstance } from '@hubble/module-sdk';
import { PlanRepository } from './repository.js';
import { CyanviewService, type ServiceOptions } from './service.js';
import { object, validatePlan, type Plan, type RecordValue } from './model.js';
import { createHostPing } from './ping.js';
import { networkRange } from './discovery.js';
import { ChoiceCatalogs } from './choice-catalogs.js';
import { CameraControl } from './control/service.js';

export function createInstance(context: ModuleContext, options: ServiceOptions = {}): ModuleInstance {
  if (!context.services) throw new Error('Module storage is unavailable');
  const sample = context.settings.sampleData === true, repository = new PlanRepository(context.services, sample), lifetime = new AbortController();
  let stopped = false;
  let control: CameraControl | undefined;
  // A restarted worker has observed nothing, and says so from its first state.
  let serviceState: RecordValue = { observations: {} };
  const publish = (values: RecordValue = {}) => { serviceState = { ...serviceState, ...values }; if (!stopped) context.publishState({ phase: 'ready', observedAt: new Date().toISOString(), message: sample ? 'Sample data' : null, values: { sample, ...serviceState, cameraControl: control?.state() ?? null } }); };
  const hostPing = options.discovery?.ping ? null : createHostPing(context.services);
  const choices = new ChoiceCatalogs(context.services);
  const service = new CyanviewService(repository, choices, publish, lifetime.signal, { ...options, discovery: { ...options.discovery, ping: options.discovery?.ping ?? hostPing!.sweep } });
  control = new CameraControl(repository, context, sample, () => publish(), options.control);
  const transfers = new Map<string, { kind: 'save' | 'send'; revision: string | null; parts: string[]; size: number; expires: number }>();
  const imports = new Map<string, { cameras: RecordValue[]; expires: number }>();
  const reads = new Map<string, { text: string; expires: number }>();
  const bounded = (result: RecordValue) => {
    const text = JSON.stringify(result);
    if (text.length < 180000) return result;
    if (reads.size >= 4) reads.delete(reads.keys().next().value!);
    const token = randomUUID(); reads.set(token, { text, expires: Date.now() + 60000 }); return { token, length: text.length };
  };
  // How long each send took and how many controllers it opened, so a slow one can be read back from Hubble's log.
  const timing = (stage: string, rows: RecordValue[], controllers: unknown, elapsed: number, opening?: unknown) => {
    const failed = rows.filter(row => row.error), count = Number(controllers) || 0;
    const longest = (field: string) => Math.max(0, ...rows.map(row => Number(row[field]) || 0));
    // Opening a controller, waiting for it to report a change back and rebuilding copies on other controllers are the controllers' time.
    const parts = [...(Number(opening) > 0 ? ['opening took ' + Number(opening) + ' ms'] : []),
      ...(longest('confirmMs') > 0 ? ['the controller confirmed after ' + longest('confirmMs') + ' ms'] : []),
      ...(longest('copiesMs') > 0 ? ['its copies on other controllers took ' + longest('copiesMs') + ' ms'] : [])];
    const copies = rows.find(row => row.remiError);
    context.log({ level: 'info', stage, message: rows.length + (rows.length === 1 ? ' camera' : ' cameras') + ' on ' + count + (count === 1 ? ' controller' : ' controllers') +
      ' in ' + Math.round(elapsed) + ' ms' + (parts.length ? ' (' + parts.join(', ') + ')' : '') +
      (failed.length ? ', ' + failed.length + ' not confirmed: ' + reason(failed[0]!.error) : '') + (copies ? ', copies not rebuilt: ' + reason(copies.remiError) : '') });
  };
  const reason = (error: unknown) => String(error instanceof Error ? error.message : error || 'no reason given').slice(0, 200);
  // A request that gives up has no result to time, and a timeout is the longest wait a page has. So it's logged here, as is one that was slow.
  const watched = async <T>(stage: string, what: string, signal: AbortSignal, work: () => Promise<T>, slowMs = Infinity): Promise<T> => {
    const began = performance.now();
    try {
      const result = await work(), elapsed = Math.round(performance.now() - began);
      if (elapsed >= slowMs) context.log({ level: 'info', stage, message: what + ' took ' + elapsed + ' ms' });
      return result;
    } catch (error) {
      if (!signal.aborted) context.log({ level: 'info', stage, message: what + ' gave up after ' + Math.round(performance.now() - began) + ' ms: ' + reason(error) });
      throw error;
    }
  };
  const send = async (input: RecordValue, signal: AbortSignal) => {
    if (sample) throw new Error('Sample data does not send commands to equipment');
    const began = performance.now(), result = await watched('send-timing', 'A send', signal, () => service.send(input, signal));
    if (Array.isArray(result.results)) timing('send-timing', result.results, result.controllers, performance.now() - began, result.openMs);
    await control!.refreshPlan(signal);
    return bounded(result);
  };
  const save = async (revision: unknown, value: unknown, signal: AbortSignal) => {
    if (revision !== null && typeof revision !== 'string') throw new Error('Invalid configuration revision');
    const saved = await repository.write(revision, validatePlan(value), signal);
    service.forgetManagedDevices(saved.removedDeviceIds);
    control!.setPlan(saved.plan);
    publish(service.state()); return { revision: saved.revision };
  };
  return {
    async start() { await control!.start(lifetime.signal); publish(); },
    async call(method, raw, execution) {
      execution.signal.throwIfAborted();
      if (stopped || method !== 'page.studio') throw new Error('Cyanview module is unavailable');
      const signal = AbortSignal.any([execution.signal, lifetime.signal]);
      const request = object(raw), input = object(request.value);
      if (request.sectionId !== 'frontend') throw new Error('Unknown module frontend');
      for (const [id, transfer] of transfers) if (transfer.expires < Date.now()) transfers.delete(id);
      for (const [id, transfer] of imports) if (transfer.expires < Date.now()) imports.delete(id);
      for (const [id, transfer] of reads) if (transfer.expires < Date.now()) reads.delete(id);
      switch (request.commandId) {
        case 'camera-control-state': await control!.refreshPlan(signal); return control!.state();
        case 'camera-control-mutate': return control!.mutate(input, signal);
        case 'read-plan': {
          const saved = await repository.read(signal);
          if (!sample) await service.remi.describeCameras(saved.plan, [], signal);
          // A saved plan holds whatever the page last showed. Only live state can say Online or Offline.
          if (!sample) for (const row of [...saved.plan.devices, ...saved.plan.cameras]) row.online = null;
          const plan = sample && saved.fresh ? null : saved.plan, text = JSON.stringify(plan);
          if (text.length < 180000) return { revision: saved.revision, sample, plan };
          if (reads.size >= 4) reads.delete(reads.keys().next().value!);
          const token = randomUUID(); reads.set(token, { text, expires: Date.now() + 60000 });
          return { revision: saved.revision, sample, plan: null, token, length: text.length };
        }
        case 'read-part': {
          const transfer = reads.get(input.token), offset = Number(input.offset);
          if (!transfer || !Number.isInteger(offset) || offset < 0 || offset % 60000 || offset >= transfer.text.length) throw new Error('Configuration read expired');
          const text = transfer.text.slice(offset, offset + 60000);
          if (offset + 60000 >= transfer.text.length) reads.delete(input.token);
          return { text };
        }
        case 'save-plan': return save(input.revision, input.plan, signal);
        case 'save-begin':
        case 'send-begin': {
          const kind = request.commandId === 'save-begin' ? 'save' : 'send';
          if (kind === 'send' && sample) throw new Error('Sample data does not send commands to equipment');
          if (transfers.size >= 2) throw new Error('Finish the pending configuration transfers first');
          const id = randomUUID(); transfers.set(id, { kind, revision: input.revision ?? null, parts: [], size: 0, expires: Date.now() + 60000 }); return { id };
        }
        case 'save-part':
        case 'send-part': {
          const transfer = transfers.get(input.id);
          const kind = request.commandId === 'save-part' ? 'save' : 'send';
          if (!transfer || transfer.kind !== kind || typeof input.text !== 'string' || input.text.length > 60000 || transfer.size + input.text.length > (kind === 'save' ? 2_000_000 : 2_500_000) || input.index !== transfer.parts.length) throw new Error('Invalid configuration transfer');
          transfer.parts.push(input.text); transfer.size += input.text.length; transfer.expires = Date.now() + 60000; return { accepted: input.index };
        }
        case 'save-commit':
        case 'send-commit': {
          const transfer = transfers.get(input.id), kind = request.commandId === 'save-commit' ? 'save' : 'send';
          if (!transfer || transfer.kind !== kind) throw new Error('Configuration transfer expired'); transfers.delete(input.id);
          let value: unknown; try { value = JSON.parse(transfer.parts.join('')); } catch { throw new Error('Invalid configuration transfer'); }
          return kind === 'save' ? save(transfer.revision, value, signal) : send(object(value), signal);
        }
        case 'find-rig': {
          if (sample) return { found: [] };
          const ignore = Array.isArray(input.ignore) ? input.ignore.filter((serial: unknown): serial is string => typeof serial === 'string').slice(0, 256) : [];
          return bounded(await service.findRig(ignore, signal));
        }
        case 'probe': { const snapshot = await service.probe(String(input.address ?? ''), signal); return { device: snapshot.device, cameraCount: snapshot.cameras.length }; }
        case 'import-device': {
          if (imports.size >= 16) throw new Error('Finish adding the selected controllers before adding more');
          const snapshot = await service.importDevice(String(input.id ?? ''), String(input.address ?? ''), signal), token = randomUUID();
          if(snapshot.cameras.length)imports.set(token, { cameras: snapshot.cameras, expires: Date.now() + 60000 });
          return { token, device: snapshot.device, lans: snapshot.lans, cameraCount: snapshot.cameras.length };
        }
        case 'import-part': {
          const transfer = imports.get(input.token), offset = Number(input.offset);
          if (!transfer || !Number.isInteger(offset) || offset < 0 || offset % 64) throw new Error('Controller import expired');
          const cameras = transfer.cameras.slice(offset, offset + 64);
          if (offset + 64 >= transfer.cameras.length) imports.delete(input.token);
          return { cameras };
        }
        case 'scan': {
          if (sample) throw new Error('Switch off sample data to discover equipment');
          const range = String(input.range ?? ''), method = input.method ?? 'ping';
          if (method === 'ping') { networkRange(range); await hostPing?.prepare(signal); }
          const started = service.startScan(range, method);
          if (method === 'ping') await service.waitForScan(signal);
          return started;
        }
        case 'stop-scan': service.stopScan(); return { stopped: true };
        case 'refresh': {
          const began = performance.now();
          const value = await watched('read-timing', 'Reading the controllers', signal, () => service.refresh(signal, Array.isArray(input.devices) ? input.devices.map(String) : undefined));
          // A controller that doesn't answer is waited on until its read times out, so a slow or failed read says which.
          const elapsed = Math.round(performance.now() - began), read = value.snapshots.length + value.failed.length;
          if (elapsed >= 1000 || value.failed.length) context.log({ level: 'info', stage: 'read-timing', message: 'Read ' + read + (read === 1 ? ' controller' : ' controllers') + ' in ' + elapsed + ' ms' +
            (value.failed.length ? ', no answer from ' + value.failed.slice(0, 8).join(', ') : '') });
          const text = JSON.stringify(value);
          if (text.length < 180000) return value;
          if (reads.size >= 4) reads.delete(reads.keys().next().value!);
          const token = randomUUID(); reads.set(token, { text, expires: Date.now() + 60000 }); return { token, length: text.length };
        }
        case 'choice-catalogs': return bounded({ catalogs: sample ? {} : await choices.read(signal) });
        case 'options': {
          if (sample) throw new Error('Sample data uses local choices');
          return bounded(await service.optionsFor(input, signal));
        }
        case 'remi-state':
          if (sample) throw new Error('Switch off sample data to read REMI configuration');
          return bounded(await service.remi.state(input, signal));
        case 'remi-send':
          if (sample) throw new Error('Sample data does not send commands to equipment');
          return bounded(await watched('route-timing', 'A REMI change', signal, () => service.remi.send(input, signal), 1000));
        case 'remi-route': {
          if (sample) throw new Error('Sample data does not send commands to equipment');
          const began = performance.now(), result = await watched('route-timing', 'A REMI route', signal, () => service.remi.route(input, signal));
          timing('route-timing', result.results, result.controllers, performance.now() - began);
          return bounded(result);
        }
        case 'send': return send(input, signal);
        default: throw new Error('Unknown Cyanview command');
      }
    },
    execute(id, fields, execution) { return control!.execute(id, fields, { ...execution, signal: AbortSignal.any([execution.signal, lifetime.signal]) }); },
    discoverChoices(query, execution) { return control!.discover(query.provider, query.draft, query.search, query.cursor, query.limit, AbortSignal.any([execution.signal, lifetime.signal])); },
    async choices(provider) { return (await control!.discover(provider, {}, '', null, 512, lifetime.signal)).choices.map(({ id, label, group }) => ({ id, label, ...(group ? { group } : {}) })); },
    subscribeFeedback(subscriptions, execution) { control!.subscribe(subscriptions, execution.signal); },
    async dispose() { if (stopped) return; stopped = true; lifetime.abort(); service.dispose(); await control!.dispose(); transfers.clear(); imports.clear(); reads.clear(); },
  };
}
export default { createInstance } satisfies HubbleModule;
