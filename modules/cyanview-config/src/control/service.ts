import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleContext, ModuleExecutionContext, ModuleFeedbackSubscription, ModuleValues } from '@hubble/module-sdk';
import { controlDevice, controllerLabel, emptyPlan, object, selectsCamera, type Plan, type RecordValue } from '../model.js';
import type { PlanRepository } from '../repository.js';
import { commands, commandGroup, cameraCommands, localCommands, feedbackCommands, type Command, type CyanViewRcpConnectionDefinition } from './config.js';
import { ControlSelection, everyControllerMutations, type SelectionMutation } from './selection.js';
import { RcpSession, type CyanViewCameraTarget, type CyanViewCameraParameterStep } from './rcp-session.js';
import { RecordingCoordinator } from './recording-coordinator.js';
import { recordingCheckpoint } from './recording-checkpoint.js';
import { actionResult, type RecordingTargetResult } from './recording-result.js';

export type FeedbackWait = { baseMs: number; perCameraMs: number; maxMs: number };
export type ControlOptions = {
  cameraSettleMs?: number; session?: (definition: CyanViewRcpConnectionDefinition, changed: () => void) => RcpSession; feedbackWait?: FeedbackWait;
  /** How long a Select camera press shows its camera before the RCP's own report must confirm it. */
  selectHoldMs?: number;
};
const SELECT_HOLD_MS = 2000;
/** What the page shows for one camera on a controller. `online` is null until the camera has reported. */
export type CameraStatus = { recording: 'recording' | 'stopped' | 'unknown'; available: boolean; message: string; online: boolean | null };
const steps: Partial<Record<Command, CyanViewCameraParameterStep>> = {
  'nd-up-enabled-cameras': { parameter: 'nd_filter', direction: 'next' },
  'nd-down-enabled-cameras': { parameter: 'nd_filter', direction: 'prev' },
  'iso-up-enabled-cameras': { parameter: 'master_gain', direction: 'next' },
  'iso-down-enabled-cameras': { parameter: 'master_gain', direction: 'prev' },
  'base-gain-up-enabled-cameras': { parameter: 'gain_mode', direction: 'next' },
  'base-gain-down-enabled-cameras': { parameter: 'gain_mode', direction: 'prev' },
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Cyanview action failed';
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 999999;
/** Some cameras take several seconds to report. Too short a wait leaves them refusing until fresh status. */
export const RECORDING_FEEDBACK_TIMEOUT_MS = 15_000;
/** A press on many cameras gives each longer to report its state, so a busy RCP doesn't read as a failed press. */
export const FEEDBACK_WAIT: FeedbackWait = { baseMs: RECORDING_FEEDBACK_TIMEOUT_MS, perCameraMs: 500, maxMs: 60_000 };
export const feedbackTimeout = (cameras: number, wait = FEEDBACK_WAIT) => Math.min(wait.maxMs, wait.baseMs + wait.perCameraMs * Math.max(0, cameras - 1));
const SELECTION_QUEUE = 'selection';
const controllerQueue = (id: unknown) => `controller/${String(id)}`;
// MQTT goes to a controller's own base address (10.192…), which no other controller can share. The
// address it was added by is only the way back while the base won't connect.
const mqttHost = (device: RecordValue) => String(device.base || device.address || '');
const mqttFallback = (device: RecordValue) => {
  const saved = String(device.address || '');
  return saved && saved !== mqttHost(device) ? saved : undefined;
};

/** Owns all new control paths; the standalone RCP/CCC modules are independent. */
export class CameraControl {
  private plan = emptyPlan();
  readonly selection: ControlSelection;
  private sessions = new Map<string, RcpSession>();
  private subscriptions: readonly ModuleFeedbackSubscription[] = [];
  private feedbackSignal?: AbortSignal;
  private stopped = false;
  private recording: RecordingCoordinator;
  private checkpoint?: ReturnType<typeof recordingCheckpoint>;
  private savedCheckpoint = '';
  private acceptance = new Map<string, Promise<unknown>>();
  private results = new Map<string, { number: unknown; message: string }>();
  private scheduled?: ReturnType<typeof setImmediate>;
  // The cameras each controller reports over MQTT, so a camera added, deleted or renumbered outside
  // this module is noticed without anyone pressing Refresh all.
  private cameraWatches = new Map<string, { text: string; settled: boolean; timer?: ReturnType<typeof setTimeout> }>();
  private cameraChanges: Record<string, number> = {};
  private feedbackSent = new Map<ModuleFeedbackSubscription, string>();
  /**
   * Select camera presses the controller acknowledged, shown at once until the RCP reports a camera change
   * over MQTT or the hold runs out, whichever comes first. Keyed by controller.
   */
  private pendingSelection = new Map<string, { camera: number; reports: number; until: number }>();
  // A restarted worker counts from zero again, so an open page must be able to tell.
  private readonly epoch = randomUUID();
  private stateText = '';
  private stateSequence = 0;
  private publishedSequence = -1;
  constructor(private repository: PlanRepository, private context: ModuleContext, private sample: boolean,
    private changed: () => void, private options: ControlOptions = {}) {
    this.selection = new ControlSelection(context.services!, sample, this.plan, () => this.emit(), error => {
      context.log({ level: 'error', stage: 'control-selection', message: message(error).slice(0, 1000) });
    });
    // Runtime files are initialized in start(), when the host grants the directory.
    this.recording = new RecordingCoordinator({ feedbackTimeoutMs: RECORDING_FEEDBACK_TIMEOUT_MS, changed: () => this.emit() });
  }
  async start(signal: AbortSignal) {
    if (!this.sample && this.context.runtimeDirectory) {
      this.checkpoint = recordingCheckpoint(this.context.runtimeDirectory);
      this.recording = new RecordingCoordinator({ feedbackTimeoutMs: RECORDING_FEEDBACK_TIMEOUT_MS, recovery: this.checkpoint.recovery,
        checkpoint: this.checkpoint.checkpoint, changed: () => { this.saveCheckpoint(); this.emit(); } });
      this.checkpoint.write(this.recording.checkpoint());
      this.savedCheckpoint = JSON.stringify(this.recording.checkpoint());
    }
    this.plan = (await this.repository.read(signal)).plan;
    this.selection.setPlan(this.plan);
    await this.selection.start(signal);
  }
  setPlan(plan: Plan) {
    this.plan = plan;
    for (const [id, session] of this.sessions) {
      const device = plan.devices.find(row => row.id === id && controlDevice(row));
      if (!device || mqttHost(device) !== session.definition.host || device.serial !== session.definition.serial) {
        this.sessions.delete(id); session.stop(); this.forgetCameraWatch(id);
      } else { session.definition.name = device.name; session.definition.fallbackHost = mqttFallback(device); }
    }
    const cameras = new Set(plan.cameras.map(row => row.id));
    for (const id of this.results.keys()) if (!cameras.has(id)) this.results.delete(id);
    this.selection.setPlan(plan);
  }
  /** Whether a controller's camera reports itself online over MQTT, or null while nothing has said. */
  cameraOnline(deviceId: string, number: number, key: string): boolean | null {
    const session = this.sessions.get(deviceId);
    if (!session || session.snapshot().phase !== 'ready') return null;
    try { return session.captureCamera(number, key).observation.online; } catch { return null; }
  }
  async refreshPlan(signal: AbortSignal) { this.setPlan((await this.repository.read(signal)).plan); }
  state() {
    const { enabled, singleSwitch } = this.selection.value();
    const value = { enabled, singleSwitch, controllers: this.controllerStatuses(), cameras: this.cameraStatuses(), cameraChanges: { ...this.cameraChanges } };
    const text = JSON.stringify(value);
    if (text !== this.stateText) { this.stateText = text; this.stateSequence += 1; }
    return { ...value, epoch: this.epoch, sequence: this.stateSequence };
  }
  private controllerStatuses() {
    return Object.fromEntries([...this.sessions].map(([id, session]) => [id, session.snapshot().reachable]));
  }
  private cameraStatuses() {
    const statuses: Record<string, CameraStatus> = {};
    for (const row of this.plan.cameras) {
      const session = this.sessions.get(row.device);
      if (session) statuses[row.id] = this.cameraStatus(row, session);
    }
    return statuses;
  }
  private cameraStatus(row: RecordValue, session: RcpSession): CameraStatus {
    const unavailable = (text: string, online: boolean | null = null): CameraStatus => ({ recording: 'unknown', available: false, message: text.slice(0, 256), online });
    if (!this.appliedRow(row)) return unavailable('Send this camera’s number before using Cyanview controls');
    const connection = session.snapshot();
    if (connection.phase !== 'ready') return unavailable(connection.lastError ?? 'Connecting to the controller');
    let target: CyanViewCameraTarget;
    try { target = session.captureCamera(Number(row.number), String(row.elementKey ?? '')); } catch (error) { return unavailable(message(error)); }
    const { observation } = target;
    if (observation.online === null) return unavailable('Waiting for camera status');
    if (!observation.online) return unavailable('Camera offline', false);
    const trustworthy = this.recording.usableObservation(`${row.device}/${target.address}`, target, observation);
    const known = trustworthy && observation.recording !== null;
    const last = this.results.get(row.id);
    // What stops the next press comes first, because an old result would hide it.
    const text = !trustworthy ? 'Waiting for fresh camera state' : observation.recording === null ? 'Waiting for camera status'
      : observation.recordingLocked ? 'Recording locked' : last && last.number === row.number ? last.message : 'Ready';
    return { recording: !known ? 'unknown' : observation.recording ? 'recording' : 'stopped', available: true, message: text.slice(0, 256), online: true };
  }
  private note(rows: readonly RecordValue[], text: string) {
    for (const row of rows) this.results.set(row.id, { number: row.number, message: text });
    this.emit();
  }
  private session(device: RecordValue) {
    if (this.stopped || this.sample) throw new Error('Cyanview commands are unavailable in sample data');
    let session = this.sessions.get(device.id);
    if (!session) {
      const definition = { connectionId: device.id, name: device.name, serial: device.serial,
        host: mqttHost(device), fallbackHost: mqttFallback(device), port: 1883, requestTimeoutMs: 3000 };
      const id = device.id;
      const changed = () => { this.recording.notify(); this.watchCameraSet(id); this.schedule(); };
      session = this.options.session?.(definition, changed) ?? new RcpSession(definition, changed);
      this.sessions.set(device.id, session);
      this.settleCameraWatch(id);
    }
    return session;
  }
  async mutate(input: RecordValue, signal: AbortSignal) {
    if (!Array.isArray(input.mutations)) throw new Error('Invalid Cyanview camera selection');
    await this.acceptSelection(String(input.requestId ?? randomUUID()), () => input.mutations as SelectionMutation[], signal);
    return this.state();
  }
  /** Edits apply in the order they were made. Only the wait for the save is left outside the queue, so edits stay immediate. */
  private async acceptSelection(id: string, mutations: () => SelectionMutation[] | Promise<SelectionMutation[]>, signal: AbortSignal) {
    const { saved } = await this.accept(SELECTION_QUEUE, async () => {
      await this.refreshPlan(signal);
      return { saved: this.selection.mutate(id, await mutations(), signal) };
    });
    return saved;
  }
  async discover(provider: string, draft: ModuleValues, search: string, cursor: string | null, limit: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const { plan, revision } = provider === 'control-actions'
      ? { plan: emptyPlan(), revision: 'control-actions-v1' } : await this.repository.read(signal);
    let choices: { id: string; label: string; group?: string; values?: Record<string, string | number> }[] = [];
    if (provider === 'control-actions') {
      choices = commands.map(([id, label]) => ({ id, label, group: commandGroup(id) }));
    } else if (provider === 'control-controllers' || provider === 'control-rcps') {
      choices = plan.devices.filter(device => controlDevice(device) && ((draft.actionType !== 'select-camera' && provider !== 'control-rcps') || selectsCamera(device))).map(device => ({
        id: device.id, label: controllerLabel(device),
      }));
    } else if (provider === 'control-cameras') {
      const id = draft['module.controllerId'] ?? draft.controllerId;
      const local = localCommands.includes(String(draft.actionType)), everywhere = !id && local;
      const controllers = plan.devices.filter(controlDevice).map(device => device.id);
      // A tick is only a saved value, so a camera that hasn't been sent to its controller can have one too.
      const rows = plan.cameras.filter(camera => (everywhere ? controllers.includes(camera.device) : camera.device === id) && (local ? number(Number(camera.number)) : this.appliedRow(camera)));
      // A row covering every controller has one choice per camera number.
      choices = rows.filter((camera, index) => !everywhere || rows.findIndex(row => Number(row.number) === Number(camera.number)) === index).map(camera => ({
        id: camera.id, label: `${camera.number} · ${camera.name || 'Camera'}`,
        values: { 'module.cameraNumber': Number(camera.number) },
      })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    } else throw new Error('Unknown Cyanview choice provider');
    const query = search.trim().toLowerCase();
    choices = choices.filter(choice => [choice.label, choice.group, choice.id].some(value => value?.toLowerCase().includes(query)));
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid choice cursor');
    return { revision: revision ?? 'initial', choices: choices.slice(offset, offset + limit), nextCursor: offset + limit < choices.length ? String(offset + limit) : null };
  }
  async execute(id: string, fields: ModuleValues, execution: Pick<ModuleExecutionContext, 'signal' | 'log'> & { readonly gesture?: ModuleExecutionContext['gesture'] }) {
    try {
      execution.signal.throwIfAborted();
      if (this.stopped || this.sample) throw new Error('Sample data does not send commands to equipment');
      const values = id === 'camera-control' ? object(fields.values) : fields;
      if (values.enabled === false) throw new Error('This action is disabled');
      const command = (id === 'camera-control' ? values.actionType : id) as Command;
      if (!commands.some(([supported]) => command === supported)) throw new Error('Unknown Cyanview action');
      const controllerId = values['module.controllerId'] ?? values.controllerId;
      const cameraNumber = values['module.cameraNumber'] ?? values.cameraNumber;
      if (cameraCommands.includes(command) && !number(cameraNumber)) throw new Error('Enter a camera number from 1 to 999999');
      if (localCommands.includes(command)) {
        await this.acceptSelection(randomUUID(), async () => {
          if (!controllerId) return everyControllerMutations(await this.selection.current(execution.signal), this.plan, command, cameraNumber);
          const device = this.controller(controllerId);
          if (command === 'single-switch') return [{ kind: 'single', controllerId: device.id, enabled: 'toggle' }];
          if (command !== 'toggle-camera-enabled') return [{ kind: 'all', controllerId: device.id }];
          const rows = this.plan.cameras.filter(row => row.device === device.id && Number(row.number) === cameraNumber);
          if (rows.length !== 1) throw new Error('Choose a unique camera number on this controller');
          return [{ kind: 'camera', controllerId: device.id, cameraId: rows[0]!.id, enabled: 'toggle' }];
        }, execution.signal);
        return actionResult({ outcome: 'success', targets: [] }, execution);
      }
      // A press settles which cameras it covers in order with ticks, so a tick just before it counts and one just after doesn't.
      const accepted = this.accept(SELECTION_QUEUE, async () => {
        await this.refreshPlan(execution.signal);
        const device = this.controller(controllerId);
        if (command === 'select-camera' && !selectsCamera(device)) throw new Error('Select camera needs an RCP or Gateway');
        const { enabled } = await this.selection.current(execution.signal);
        const rows = this.plan.cameras.filter(row => row.device === device.id);
        const specific = command === 'select-camera' || command === 'record-camera';
        // A press that names a camera number goes by what the controller reports over MQTT and nothing
        // else. The saved list is only kept current by reading the controller's web side, so it never
        // decides whether such a press goes. A row there only lends its identity, to settle a tie.
        const listed = rows.filter(row => Number(row.number) === cameraNumber);
        const targets: RecordValue[] = specific
          ? [{ id: listed.length === 1 ? listed[0]!.id : `${device.id}:camera:#${cameraNumber}`, device: device.id, number: String(cameraNumber), elementKey: listed.length === 1 ? String(listed[0]!.elementKey ?? '') : '', unlisted: true }]
          : rows.filter(row => enabled[row.id]);
        if (!targets.length) throw new Error('No cameras are enabled for Cyanview controls on this controller');
        // A tick that fails to save rolls back, so a press that counted it must not act on it. Later ticks don't matter here.
        const saved = this.selection.flush(device.id);
        void saved.catch(() => undefined);
        return { device, targets, saved };
      });
      // It then acts in press order per controller, so a slow configuration read can't let a later press overtake it.
      const { completion } = await this.accept(controllerQueue(controllerId), async () => {
        const { device, targets, saved } = await accepted;
        this.note(targets, 'Sending…');
        const assertCurrent = (row?: RecordValue) => {
          const current = this.plan.devices.find(item => item.id === device.id);
          if (!current || current.serial !== device.serial || mqttHost(current) !== mqttHost(device))
            throw new Error('Controller changed after the command was accepted');
          if (row && !row.unlisted && !this.plan.cameras.some(item => item.id === row.id && item.elementKey === row.elementKey && item.number === row.number && this.appliedRow(item)))
            throw new Error('Camera changed after the command was accepted');
        };
        let session: RcpSession, captured: { row: RecordValue; target?: CyanViewCameraTarget; error?: string }[];
        try {
          await saved;
          assertCurrent();
          // A press goes over MQTT alone. Its topics already say which controller and which cameras
          // answered, so nothing else is read first.
          session = this.session(device);
          await this.ready(session, execution.signal);
          const ready = session;
          captured = targets.map(row => {
            try { return { row, target: this.capture(row, ready) }; }
            catch (error) { return { row, error: message(error) }; }
          });
        } catch (error) { this.note(targets, message(error)); throw error; }
        const connected = session;
        const completion = Promise.all(captured.map(async ({ row, target, error }): Promise<RecordingTargetResult> => {
          const send = async (): Promise<RecordingTargetResult> => {
            const key = `${device.id}/${target?.address ?? row.id}`;
            try {
              if (!target) throw new Error(error);
              assertCurrent(row);
              if (command === 'select-camera') {
                const before = connected.snapshot();
                await connected.selectCamera(target.observation.number!, execution.signal);
                this.holdSelection(device.id, target.observation.number!, before.activeCameraNumber, before.activeCameraReports);
              } else if (command === 'record-camera') {
                // A tap only ever starts the camera. Stopping takes the 2-second hold, whose lane Hubble adds to the key.
                const tap = (execution.gesture ?? 'press') === 'press';
                const result = await this.recording.record({ key, session: connected, target }, tap ? 'start' : 'toggle', execution.signal, feedbackTimeout(targets.length, this.options.feedbackWait));
                return tap && result.evidence === 'noop' ? { ...result, message: 'Recording. Hold for 2 seconds to stop' } : result;
              } else if (command.startsWith('roll-') || command === 'stop-enabled-cameras') {
                return await this.recording.record({ key, session: connected, target }, command === 'roll-enabled-cameras' ? 'start' : command === 'stop-enabled-cameras' ? 'stop' : 'toggle', execution.signal, feedbackTimeout(targets.length, this.options.feedbackWait));
              } else {
                await this.recording.deliver(() => steps[command]
                  ? connected.stepCameraParameter(target, steps[command]!, execution.signal)
                  : connected.saveWhiteBalancePreset(target, execution.signal), execution.signal);
              }
              return { target: row.id, outcome: 'success', evidence: 'delivered', message: 'Controller acknowledged delivery' };
            } catch (error) { return { target: row.id, outcome: 'failure', evidence: 'error', message: message(error) }; }
          };
          const result = await send();
          this.note([row], result.message);
          return result;
        }));
        return { completion };
      });
      const results = await completion;
      return actionResult({ outcome: results.every(result => result.outcome === 'success') ? 'success' : 'failure', targets: results }, execution);
    } catch (error) {
      return { status: 'failure' as const, category: execution.signal.aborted ? 'cancelled' as const : 'unavailable' as const, message: message(error).slice(0, 1000) };
    }
  }
  private controller(controllerId: unknown) {
    const device = this.plan.devices.find(row => row.id === controllerId && controlDevice(row));
    if (!device) throw new Error('Choose a named Cyanview controller');
    return device;
  }
  private accept<T>(controllerId: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.acceptance.get(controllerId) ?? Promise.resolve()).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.acceptance.set(controllerId, tail);
    void tail.then(() => { if (this.acceptance.get(controllerId) === tail) this.acceptance.delete(controllerId); });
    return run;
  }
  private appliedRow(row: RecordValue) {
    return !!row.elementKey && !row.isNew && number(Number(row.number)) && !(Array.isArray(row.dirty) && row.dirty.includes('number'));
  }
  private capture(row: RecordValue, session: RcpSession): CyanViewCameraTarget {
    if (!row.unlisted && !this.appliedRow(row)) throw new Error('Send or refresh this camera’s number before using Cyanview controls');
    // A press names a camera by number, so one deleted and added back under a new identity still answers.
    return session.captureCamera(Number(row.number), String(row.elementKey ?? ''));
  }
  private settleCameraWatch(id: string) {
    const watch = this.cameraWatches.get(id) ?? { text: '', settled: false };
    this.cameraWatches.set(id, watch);
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      // What a session reads when it first connects is what was already there, not a change.
      if (!watch.settled) { watch.settled = true; return; }
      this.cameraChanges[id] = (this.cameraChanges[id] ?? 0) + 1;
      this.schedule();
    }, this.options.cameraSettleMs ?? (watch.settled ? 500 : 1500));
    watch.timer.unref?.();
  }
  private watchCameraSet(id: string) {
    const watch = this.cameraWatches.get(id), session = this.sessions.get(id);
    if (!watch || !session) return;
    const text = session.cameraObservations().filter(camera => camera.number !== null).map(camera => camera.address + '=' + camera.number).sort().join('|');
    if (text === watch.text) return;
    watch.text = text;
    this.settleCameraWatch(id);
  }
  private forgetCameraWatch(id: string) {
    clearTimeout(this.cameraWatches.get(id)?.timer);
    this.cameraWatches.delete(id);
  }
  private async ready(session: RcpSession, signal: AbortSignal) {
    const deadline = Date.now() + session.definition.requestTimeoutMs;
    while (session.snapshot().phase !== 'ready') {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error(session.snapshot().lastError ?? 'Camera broker did not become ready');
      await delay(20, undefined, { signal });
    }
  }
  subscribe(subscriptions: readonly ModuleFeedbackSubscription[], signal: AbortSignal) {
    this.subscriptions = subscriptions; this.feedbackSignal = signal;
    this.feedbackSent.clear();
    this.emit();
  }
  /** Every managed RCP, RIO and Gateway is watched, whether or not anything needs it yet. Watching only subscribes; it sends nothing. */
  private observe() {
    if (this.stopped || this.sample) return;
    for (const device of this.plan.devices) if (controlDevice(device)) this.session(device);
  }
  private feedback() {
    if (this.stopped || this.feedbackSignal?.aborted) return;
    for (const subscription of this.subscriptions) {
      if (subscription.id !== 'camera-control') continue;
      const values = object(subscription.fields?.values), command = String(values.actionType);
      const device = this.plan.devices.find(row => row.id === values['module.controllerId']);
      // With no controller named, a selection action covers every controller.
      const everywhere = !values['module.controllerId'] && localCommands.includes(command);
      const devices = everywhere ? this.plan.devices.filter(controlDevice) : device ? [device] : [];
      const rows = this.plan.cameras.filter(row => devices.some(item => item.id === row.device));
      const matches = rows.filter(row => Number(row.number) === values['module.cameraNumber']);
      const resolved = everywhere ? matches.length > 0 : matches.length === 1;
      const selected = this.selection.value();
      const session = device && this.sessions.get(device.id);
      const cells: RecordValue = {};
      if (device) cells['module.controllerId'] = { label: controllerLabel(device), color: null };
      if (resolved) cells['module.cameraNumber'] = { label: `${matches[0]!.number} · ${matches[0]!.name || 'Camera'}`, color: null };
      let active: boolean | null = null;
      // Recording and connection, reported as triggers beside the row's own state. Null is not known yet.
      let recording: boolean | null = null, online: boolean | null = null, stopping = false;
      // Group rows: every one, or only some, of their cameras enabled or rolling.
      let all = false, some = false;
      if (command === 'toggle-camera-enabled' && resolved) active = matches.every(row => selected.enabled[row.id] === true);
      if (devices.length && command === 'enable-all-cameras') {
        active = rows.length > 0 && rows.every(row => selected.enabled[row.id]);
        all = active;
        some = !all && rows.some(row => selected.enabled[row.id]);
      }
      if (devices.length && command === 'single-switch') active = devices.every(item => selected.singleSwitch[item.id] === true);
      const sessions = devices.map(item => this.sessions.get(item.id));
      if (sessions.length && sessions.every(item => item !== undefined)) online = sessions.every(item => item!.snapshot().phase === 'ready');
      // With no controller named, a camera row follows that camera on every controller that has it:
      // online when any of them sees it online, offline only when none can, and recording when any of them sees it roll.
      if (!device && cameraCommands.includes(command) && matches.length) {
        const seen = matches.flatMap(row => {
          const own = this.plan.devices.find(item => item.id === row.device), owner = own && this.sessions.get(own.id);
          if (!owner || owner.snapshot().phase !== 'ready') return owner ? [{ online: false, recording: null as boolean | null }] : [];
          try {
            const target = owner.captureCamera(Number(row.number)), observation = target.observation;
            const usable = observation.online === true && observation.recording !== null && this.recording.usableObservation(`${own.id}/${target.address}`, target, observation);
            return [{ online: observation.online, recording: usable ? observation.recording : null }];
          } catch { return []; }
        });
        if (seen.length) online = seen.some(item => item.online === true) ? true : seen.every(item => item.online === false) ? false : null;
        if (seen.some(item => item.recording === true)) recording = true;
        else if (seen.length && seen.every(item => item.recording === false)) recording = false;
      }
      if (session?.snapshot().phase === 'ready') {
        if (command === 'select-camera') {
          const current = this.selectedCamera(device!.id, session);
          if (current !== null) active = current === values['module.cameraNumber'];
        }
        // A camera row follows its camera, found by number on the named controller the same way its press finds it, as reported over MQTT.
        if (cameraCommands.includes(command)) {
          try {
            const target = session.captureCamera(Number(values['module.cameraNumber']));
            const observation = target.observation;
            stopping = this.recording.isStopping(`${device!.id}/${target.address}`);
            if (observation.online !== null) online = observation.online;
            if (observation.online === true && observation.recording !== null && this.recording.usableObservation(`${device!.id}/${target.address}`, target, observation)) {
              recording = observation.recording;
              if (command === 'record-camera') active = observation.recording;
            }
          } catch { /* Not on this controller, or the number is ambiguous. */ }
        }
        if (['roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras'].includes(command)) {
          const enabled = rows.filter(row => selected.enabled[row.id]);
          const observations = enabled.map(row => {
            try {
              const target = session.captureCamera(Number(row.number));
              return this.appliedRow(row) && target.observation.online === true && this.recording.usableObservation(`${device!.id}/${target.address}`, target, target.observation) ? target.observation.recording : null;
            } catch { return null; }
          });
          if (observations.length && observations.every(value => value !== null))
            active = observations.every(value => value === (command !== 'stop-enabled-cameras'));
          all = observations.length > 0 && observations.every(value => value === true);
          some = !all && observations.some(value => value === true);
        }
      }
      const observing = values.enabled !== false && values['module.feedbackEnabled'] === true && feedbackCommands.includes(command);
      const colors = String(values['module.feedbackColor'] || '#3A3A40 | #37A65B').split('|').map(color => color.trim()).filter(color => /^#[0-9a-f]{6}$/i.test(color));
      const state = !observing ? 'inactive' as const : active === null ? 'unavailable' as const : active ? 'active' as const : 'inactive' as const;
      // Each action reports its own triggers, as the matrix declares them.
      const own: Record<string, readonly (string | false)[]> = {
        'select-camera': [active === true && 'selected', recording === true && 'recording'],
        'record-camera': [stopping && 'stopping', recording === true && 'rolling'],
        'toggle-camera-enabled': [active === true && 'enabled', recording === true && 'recording'],
        'enable-all-cameras': [all && 'all-enabled', some && 'some-enabled'],
        'single-switch': [active === true && 'single-switch'],
      };
      for (const action of ['roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras']) own[action] = [all && 'all-rolling', some && 'some-rolling'];
      const connection = cameraCommands.includes(command) ? [online === true && 'online', online === false && 'offline'] : [];
      const triggers = !observing ? null : [...(own[command] ?? []), ...connection].filter((id): id is string => typeof id === 'string');
      // Hubble with feedback triggers draws the key from `triggers`; the colour is for older hosts.
      const appearance = { cells, backgroundColor: !observing || active === null ? null : active ? colors.at(-1) ?? null : colors.length === 2 ? colors[0]! : null, triggers };
      // observedAt marks a change of state, not a heartbeat, so repeated camera traffic stays off the host.
      const signature = JSON.stringify([state, appearance]);
      if (this.feedbackSent.get(subscription) === signature) continue;
      this.feedbackSent.set(subscription, signature);
      this.context.publishFeedback({ ...subscription, state, observedAt: observing && active === null ? null : new Date().toISOString(), appearance });
    }
  }
  /** Shows an acknowledged Select camera press straight away, then lets the RCP's report take over. */
  private holdSelection(deviceId: string, camera: number, before: number | null, reports: number) {
    if (before === camera) return;
    const holdMs = this.options.selectHoldMs ?? SELECT_HOLD_MS;
    this.pendingSelection.set(deviceId, { camera, reports, until: Date.now() + holdMs });
    setTimeout(() => this.emit(), holdMs + 10).unref();
    this.emit();
  }
  /** The camera a controller has selected: an acknowledged press until the RCP reports a change, then its report. */
  private selectedCamera(deviceId: string, session: RcpSession): number | null {
    const snapshot = session.snapshot(), pending = this.pendingSelection.get(deviceId);
    // Any report from the RCP after the press, the same camera or another, decides from then on.
    if (pending && (Date.now() >= pending.until || snapshot.activeCameraReports !== pending.reports)) this.pendingSelection.delete(deviceId);
    return this.pendingSelection.get(deviceId)?.camera ?? snapshot.activeCameraNumber;
  }
  private emit() {
    if (this.stopped) return;
    this.observe();
    this.feedback();
    const { sequence } = this.state();
    if (sequence !== this.publishedSequence) { this.publishedSequence = sequence; this.changed(); }
    this.saveCheckpoint();
  }
  /** Several camera messages can arrive at once. Reading them all before publishing is cheaper and shows the same result. */
  private schedule() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = undefined; this.emit(); });
  }
  private saveCheckpoint() {
    if (!this.checkpoint) return;
    const checkpoint = this.recording.checkpoint(), text = JSON.stringify(checkpoint);
    if (text !== this.savedCheckpoint) { this.checkpoint.write(checkpoint); this.savedCheckpoint = text; }
  }
  async dispose() {
    if (this.stopped) return;
    this.stopped = true; for (const id of [...this.cameraWatches.keys()]) this.forgetCameraWatch(id); this.selection.dispose();
    if (this.scheduled) clearImmediate(this.scheduled);
    await this.recording.dispose();
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    await this.selection.flush().catch(() => undefined);
    this.checkpoint?.write(this.recording.checkpoint(), true);
  }
}
