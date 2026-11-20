import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MODULE_PROMPT_CHANNEL, type ModuleContext, type ModuleExecutionContext, type ModuleFeedbackSubscription, type ModulePromptInput, type ModuleValues } from '@hubble/module-sdk';
import { controlDevice, controllerLabel, emptyPlan, object, selectsCamera, type Plan, type RecordValue } from '../model.js';
import type { PlanRepository } from '../repository.js';
import { commands, commandGroup, cameraCommands, localCommands, feedbackCommands, ndCommands, baseGainCommands, type Command, type CyanViewRcpConnectionDefinition } from './config.js';
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
  /** How long an ND In or ND Out press waits for the camera to report the ND state it asked for. */
  ndConfirmMs?: number;
  /** How long a White Balance answer waits for each camera to report the temperature and tint it asked for. */
  whiteBalanceConfirmMs?: number;
  /** How old the plan in memory may be before a press that uses it also has it read again in the background. */
  planRecheckMs?: number;
};
const SELECT_HOLD_MS = 2000;
// Camera 1 on RCP 1 reported each ND change about 65 ms after the command (Nov 18 2026). This leaves room for a slow path.
const ND_CONFIRM_MS = 5000;
const WB_CONFIRM_MS = 5000;
const WB_DIALOG = 'wb-dialog-enabled-cameras';
// How long a White Balance dialog waits for Send.
const WB_DIALOG_MS = 120_000;
// What the dialog takes. Cyanview reports tint as -0.99 to 0.99; the dialog shows it as -99 to +99.
const WB_TEMP = { min: 2000, max: 15000 }, WB_TINT = { min: -99, max: 99 };
const signedTint = (tint: number) => { const value = Math.round(tint * 100); return value > 0 ? `+${value}` : String(value); };
const cameraList = (numbers: readonly string[]) => numbers.length === 1 ? `Camera ${numbers[0]}` : `Cameras ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
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
/**
 * A press acts on the plan in memory while the watch on the saved plan says it is the saved one. A watch that went
 * quiet without failing would never say otherwise, so a press on a plan last read longer ago than this also has it
 * read again, behind the press.
 */
const PLAN_RECHECK_MS = 30_000;
const controllerQueue = (id: unknown) => `controller/${String(id)}`;
// MQTT goes to a controller's own base address (10.192…), which no other controller can share. The
// address it was added by is only the way back while the base won't connect.
const mqttHost = (device: RecordValue) => String(device.base || device.address || '');
/**
 * A camera's path as the controller sees it: online, its RIO reached with no camera there, or its RIO not reached.
 * The RCP keeps a connection report for every camera whose RIO is up, "online" or "offline", and a new listener has it
 * before the controller reads as ready. A camera it lists with no report has no RIO reaching it (RCP 1, Nov 18 2026:
 * cameras 1-5 listed, their RIOs off the network, no report). The RIO is the camera's only way in, and a Gateway or
 * controller that drops reaches no RIO either, so those read as RIO offline too.
 */
// Not configured: no controller has a camera under that number, so there is nothing to reach (Nov 18 2026: CC9 and CC11).
type Connection = 'online' | 'camera-offline' | 'rio-offline' | 'not-configured';
const reportedConnection = (observation: { readonly online: boolean | null }): Connection =>
  observation.online === true ? 'online' : observation.online === false ? 'camera-offline' : 'rio-offline';
/** The key trigger for each connection state. */
const connectionTrigger: Record<Connection, string> = { online: 'online', 'camera-offline': 'offline', 'rio-offline': 'rio-offline', 'not-configured': 'not-configured' };
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
   * White Balance dialogs this module has open in HubDash, by controller, until Send or their expiry. A camera checked,
   * cleared or reporting a new value refreshes the dialog in place.
   */
  private openWhiteBalance = new Map<string, { until: number; actionId: string; fields: ModuleValues; prompt: ModulePromptInput; text: string }>();
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
  /** The saved revision `plan` was read at, or undefined when it came from anywhere else and a press must read first. */
  private planRevision: string | null | undefined;
  /** The newest saved revision the plan's watch has reported, or undefined while no watch is running. */
  private watchedRevision: string | null | undefined;
  private planReadAt = 0;
  private planRefresh?: Promise<void>;
  private planRefreshAgain = false;
  private lifetime?: AbortSignal;
  constructor(private repository: PlanRepository, private context: ModuleContext, private sample: boolean,
    private changed: () => void, private options: ControlOptions = {}) {
    this.selection = new ControlSelection(context.services!, sample, this.plan, () => this.emit(), error => {
      context.log({ level: 'error', stage: 'control-selection', message: message(error).slice(0, 1000) });
    });
    // Runtime files are initialized in start(), when the host grants the directory.
    this.recording = new RecordingCoordinator({ feedbackTimeoutMs: RECORDING_FEEDBACK_TIMEOUT_MS, changed: () => this.emit() });
  }
  async start(signal: AbortSignal) {
    // Recording that isn't known after a restart is about real cameras, so Simulated keeps none of it in the shared file.
    if (!this.sample && this.context.runtimeDirectory) {
      this.checkpoint = recordingCheckpoint(this.context.runtimeDirectory);
      this.recording = new RecordingCoordinator({ feedbackTimeoutMs: RECORDING_FEEDBACK_TIMEOUT_MS, recovery: this.checkpoint.recovery,
        checkpoint: this.checkpoint.checkpoint, changed: () => { this.saveCheckpoint(); this.emit(); } });
      this.checkpoint.write(this.recording.checkpoint());
      this.savedCheckpoint = JSON.stringify(this.recording.checkpoint());
    }
    const saved = await this.repository.read(signal);
    this.plan = saved.plan; this.planRevision = saved.revision; this.planReadAt = Date.now();
    this.selection.setPlan(this.plan);
    await this.selection.start(signal);
    this.lifetime = signal;
    void this.followPlan(signal);
  }
  /** `revision` is the saved revision this plan was read at. A plan from anywhere else has none, and the next press reads the saved one. */
  setPlan(plan: Plan, revision?: string | null) {
    this.plan = plan; this.planRevision = revision;
    if (revision !== undefined) this.planReadAt = Date.now();
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
  /** True once a controller's MQTT link has been tried and isn't up. False while it is up, untried or not watched. */
  controllerDown(deviceId: string): boolean {
    return this.sessions.get(deviceId)?.snapshot().reachable === false;
  }
  /** Whether a controller's camera reports itself online over MQTT, or null while nothing has said. */
  cameraOnline(deviceId: string, number: number, key: string): boolean | null {
    const session = this.sessions.get(deviceId);
    if (!session || session.snapshot().phase !== 'ready') return null;
    try { return session.captureCamera(number, key).observation.online; } catch { return null; }
  }
  /**
   * A camera as one controller can reach it, for a key's connection: its own report, RIO offline when the controller is
   * down, doesn't list that number, or lists it with no report, and null while that isn't known (a number listed twice).
   * The controller being up is not enough.
   */
  private cameraReach(session: RcpSession | undefined, number: number): { connection: Connection | null; target: CyanViewCameraTarget | null } {
    if (!session) return { connection: null, target: null };
    if (session.snapshot().phase !== 'ready') return { connection: 'rio-offline', target: null };
    try {
      const target = session.captureCamera(number);
      return { connection: reportedConnection(target.observation), target };
    } catch { return { connection: session.listsCamera(number) === false ? 'not-configured' : null, target: null }; }
  }
  async refreshPlan(signal: AbortSignal) {
    const saved = await this.repository.read(signal);
    if (!this.stopped) this.setPlan(saved.plan, saved.revision);
  }
  /** The plan in memory is the saved one: read at the revision the watch last reported, with no newer save of this module's own. */
  private planIsCurrent() {
    return this.watchedRevision !== undefined && this.planRevision === this.watchedRevision && this.planRevision === this.repository.revision;
  }
  /**
   * The plan a press acts on. Reading the saved plan takes four requests to Hubble, so a press only waits for that
   * when the plan in memory may be behind: a save was reported, this module saved one itself, or nothing is watching.
   */
  private async currentPlan(signal: AbortSignal) {
    if (this.planIsCurrent()) {
      if (Date.now() - this.planReadAt > (this.options.planRecheckMs ?? PLAN_RECHECK_MS)) this.refreshPlanBehind();
      return;
    }
    // A read the watch started serves every press waiting on it. If it failed, the press reads for itself and reports why.
    if (this.planRefresh) await this.planRefresh.catch(() => undefined);
    signal.throwIfAborted();
    if (!this.planIsCurrent()) await this.refreshPlan(signal);
  }
  /** Reads the saved plan without holding anything up, and again if another save is reported meanwhile. */
  private refreshPlanBehind() {
    const signal = this.lifetime;
    if (this.stopped || !signal) return;
    if (this.planRefresh) { this.planRefreshAgain = true; return; }
    const refresh = (async () => {
      do { this.planRefreshAgain = false; await this.refreshPlan(signal); }
      while (this.planRefreshAgain && !this.planIsCurrent() && !this.stopped && !signal.aborted);
    })();
    this.planRefresh = refresh;
    void refresh.catch(error => {
      // The plan in memory stays marked as behind, so the next press reads the saved one itself.
      if (!this.stopped && !signal.aborted) this.context.log({ level: 'info', stage: 'control-plan', message: ('Reading the saved configuration failed: ' + message(error)).slice(0, 1000) });
    }).then(() => { if (this.planRefresh === refresh) this.planRefresh = undefined; });
  }
  /**
   * Follows the saved plan, so a press need not read it. While no watch is running nothing vouches for the plan in
   * memory, and each press reads the saved plan first, as every press did before.
   */
  private async followPlan(signal: AbortSignal) {
    for (let failures = 0; !signal.aborted && !this.stopped;) {
      try {
        // Each new watch starts by reading the document, so it catches up on anything missed. Only a later change shows the watch works.
        let changes = 0;
        for await (const document of this.repository.watch(signal)) {
          if (this.stopped) return;
          if (++changes > 1) failures = 0;
          this.watchedRevision = document.revision;
          if (!this.planIsCurrent()) this.refreshPlanBehind();
        }
      } catch (error) {
        this.watchedRevision = undefined;
        if (signal.aborted || this.stopped) return;
        failures += 1;
        if (failures === 3) this.context.log({ level: 'error', stage: 'control-plan', message: message(error).slice(0, 1000) });
        await delay(Math.min(250 * failures, 5000), undefined, { signal }).catch(() => undefined);
      }
    }
    this.watchedRevision = undefined;
  }
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
  /**
   * Whether a camera comes in through a RIO: the device it is plugged into, its own or the one its REMI copy comes
   * from, is a RIO. A camera on a Gateway or RCP has no RIO to be offline (Nov 18 2026: cameras 6 and 10 on the
   * Gateway). Where a copy's origin isn't known, it may come through one.
   */
  private throughRio(row: RecordValue): boolean {
    const remi = row.remi as { origin?: { serial?: unknown } } | undefined;
    const serial = String(remi ? remi.origin?.serial ?? '' : this.plan.devices.find(device => device.id === row.device)?.serial ?? '').toLowerCase();
    if (!serial) return true;
    const device = this.plan.devices.find(item => String(item.serial).toLowerCase() === serial);
    return device ? device.kind === 'RIO' : serial.startsWith('cy-rio-');
  }
  /** A camera with no RIO can't have its RIO offline, so it reads Camera offline instead. */
  private withoutRio(connection: Connection | null, rows: readonly RecordValue[]): Connection | null {
    return connection === 'rio-offline' && rows.length > 0 && rows.every(row => !this.throughRio(row)) ? 'camera-offline' : connection;
  }
  private cameraStatus(row: RecordValue, session: RcpSession): CameraStatus {
    const unavailable = (text: string, online: boolean | null = null): CameraStatus => ({ recording: 'unknown', available: false, message: text.slice(0, 256), online });
    if (!this.appliedRow(row)) return unavailable('Send this camera’s number before using Cyanview controls');
    const connection = session.snapshot();
    if (connection.phase !== 'ready') return unavailable(connection.lastError ?? 'Connecting to the controller');
    let target: CyanViewCameraTarget;
    try { target = session.captureCamera(Number(row.number), String(row.elementKey ?? '')); } catch (error) { return unavailable(message(error)); }
    const { observation } = target;
    const connected = this.withoutRio(reportedConnection(observation), [row]);
    if (connected !== 'online') return unavailable(connected === 'rio-offline' ? 'RIO offline' : 'Camera offline', false);
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
    if (this.stopped) throw new Error('Cyanview module is unavailable');
    // Simulated always brings its own sessions to the simulated controllers, and must never fall back to a real one.
    if (this.sample && !this.options.session) throw new Error('Simulated controllers are unavailable');
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
      await this.currentPlan(signal);
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
      if (this.stopped) throw new Error('Cyanview module is unavailable');
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
        await this.currentPlan(execution.signal);
        const device = this.controller(controllerId);
        if (command === 'select-camera' && !selectsCamera(device)) throw new Error('Select camera needs an RCP or Gateway');
        const rows = this.plan.cameras.filter(row => row.device === device.id);
        const specific = command === 'select-camera' || command === 'record-camera';
        // Only a press on the ticked cameras goes by the ticks. One that names its camera has nothing to read.
        const enabled = specific ? {} : (await this.selection.current(execution.signal)).enabled;
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
      const { completion, asked } = await this.accept(controllerQueue(controllerId), async () => {
        const { device, targets, saved } = await accepted;
        // The press that only opens the White Balance dialog sends nothing yet.
        if (!(command === WB_DIALOG && fields.prompt === undefined)) this.note(targets, 'Sending…');
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
        const nd = ndCommands.includes(command) ? this.ndPlan(command, captured) : null;
        if (nd) captured = nd.captured;
        if (baseGainCommands.includes(command))
          captured = this.leaveOut(captured, observation => observation.baseGain === null, 'No base gain on this camera', 'No checked camera on this controller reports a base gain');
        // White Balance: a press asks HubDash for the values; the dialog's Send comes back with them under `prompt`.
        const typed = command === WB_DIALOG ? this.typedWhiteBalance(fields.prompt) : null;
        if (command === WB_DIALOG && typed === null) {
          if (!this.context.publishEvent) throw new Error('This Hubble can’t show the White Balance dialog; update Hubble');
          const { prompt, asked } = this.whiteBalancePrompt(device, captured, id, fields);
          this.context.publishEvent(MODULE_PROMPT_CHANNEL, prompt as never);
          this.openWhiteBalance.set(String(device.id), { until: Date.now() + WB_DIALOG_MS, actionId: id, fields, prompt, text: JSON.stringify(prompt) });
          return { completion: Promise.resolve([]), asked };
        }
        // Send closed the dialog, so nothing refreshes it any more.
        if (typed) this.openWhiteBalance.delete(String(device.id));
        if (typed) captured = this.leaveOut(captured, observation => observation.wbTemp === null, 'No colour temperature on this camera', 'No enabled camera on this controller reports a colour temperature');
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
              } else if (typed) {
                return await this.sendWhiteBalance(row, connected, target, typed, execution.signal);
              } else if (nd) {
                await this.recording.deliver(() => connected.setNdClear(target, nd.clear, execution.signal), execution.signal);
                const wanted = nd.clear ? 'ND out' : 'ND in';
                return await this.ndReported(connected, target, nd.clear, execution.signal)
                  ? { target: row.id, outcome: 'success', evidence: 'confirmed', message: wanted }
                  : { target: row.id, outcome: 'failure', evidence: 'unconfirmed', message: `The camera hasn’t reported ${wanted}` };
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
        return { completion, asked: undefined as string | undefined };
      });
      if (asked !== undefined) return { status: 'success' as const, evidence: { kind: 'local' as const, summary: asked } };
      const results = await completion;
      return actionResult({ outcome: results.every(result => result.outcome === 'success') ? 'success' : 'failure', targets: results }, execution);
    } catch (error) {
      return { status: 'failure' as const, category: execution.signal.aborted ? 'cancelled' as const : 'unavailable' as const, message: message(error).slice(0, 1000) };
    }
  }
  /**
   * Which cameras an ND press goes to, and which way. A connected camera that has never reported ND in/out has none,
   * so it is left out. ND In puts it in, ND Out takes it out, and the toggle takes it out of every camera when all of
   * them have it in, and otherwise puts it in, so one press brings them all the same way.
   */
  private ndPlan<T extends { row: RecordValue; target?: CyanViewCameraTarget }>(command: Command, captured: readonly T[]) {
    const left = this.leaveOut(captured, observation => observation.ndClear === null, 'No ND in/out on this camera', 'No checked camera on this controller has ND in/out');
    const known = left.flatMap(item => item.target?.observation.online === true && item.target.observation.ndClear !== null ? [item.target.observation.ndClear] : []);
    const clear = command === 'nd-out-enabled-cameras' || (command === 'nd-toggle-enabled-cameras' && known.length > 0 && known.every(value => !value));
    return { captured: left, clear };
  }
  /**
   * Leaves out the connected cameras that lack what a press needs, so a rig of mixed cameras can be pressed together,
   * and says so on each one. A press that leaves no camera is refused. A camera that isn't connected stays in and fails.
   */
  private leaveOut<T extends { row: RecordValue; target?: CyanViewCameraTarget }>(captured: readonly T[],
    lacks: (observation: CyanViewCameraTarget['observation']) => boolean, note: string, none: string): T[] {
    const without = captured.filter(item => item.target?.observation.online === true && lacks(item.target.observation));
    if (without.length) this.note(without.map(item => item.row), note);
    const left = captured.filter(item => !without.includes(item));
    if (!left.length) throw new Error(none);
    return left;
  }
  /** The temperature and tint typed in the White Balance dialog, or null on the press that opens it. */
  private typedWhiteBalance(prompt: unknown): { temperature: number; tint: number | null } | null {
    if (prompt === undefined) return null;
    const values = object(prompt), temperature = values.temperature, tint = values.tint;
    const whole = (value: unknown, range: { min: number; max: number }): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
    if (!whole(temperature, WB_TEMP)) throw new Error(`Temperature must be from ${WB_TEMP.min} to ${WB_TEMP.max} K`);
    if (tint !== undefined && !whole(tint, WB_TINT)) throw new Error(`Tint must be from ${WB_TINT.min} to +${WB_TINT.max}`);
    return { temperature, tint: tint === undefined ? null : tint };
  }
  /**
   * The White Balance dialog for a controller's enabled cameras: each one's temperature and tint now, and what each will
   * get. A camera with no tint gets the temperature only; an offline one, or one with no temperature, gets nothing.
   * A press needs at least one camera to send to; a refresh (`previous`) keeps the last fields when none is left.
   */
  private whiteBalancePrompt<T extends { row: RecordValue; target?: CyanViewCameraTarget }>(device: RecordValue, captured: readonly T[], actionId: string, fields: ModuleValues, previous?: ModulePromptInput) {
    const cameras = captured.map(({ row, target }) => ({
      number: String(row.number), name: String(row.name || target?.observation.name || 'Camera'),
      online: target?.observation.online === true, temp: target?.observation.wbTemp ?? null, tint: target?.observation.wbTint ?? null,
    }));
    const receivers = cameras.filter(camera => camera.online && camera.temp !== null);
    if (!receivers.length && !previous) throw new Error('No enabled camera on this controller reports a colour temperature');
    const offline = cameras.filter(camera => !camera.online).map(camera => camera.number);
    const noTemp = cameras.filter(camera => camera.online && camera.temp === null).map(camera => camera.number);
    const noTint = receivers.filter(camera => camera.tint === null).map(camera => camera.number);
    const withTint = receivers.find(camera => camera.tint !== null);
    const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, Math.round(value)));
    const count = (n: number) => `${n} enabled camera${n === 1 ? '' : 's'}`;
    const prompt: ModulePromptInput = {
      key: `white-balance.${String(device.id)}`,
      title: 'White Balance',
      description: `Cyanview · ${String(device.name || device.serial || 'Controller')} · ${count(cameras.length)}`.slice(0, 200),
      icon: 'thermometer',
      fields: receivers.length ? [
        { id: 'temperature', label: 'Temperature', type: 'number', default: clamp(receivers[0]!.temp!, WB_TEMP), ...WB_TEMP, integer: true, unit: 'K', hint: `${WB_TEMP.min} to ${WB_TEMP.max}` },
        ...(withTint ? [{ id: 'tint', label: 'Tint', type: 'number' as const, default: clamp(withTint.tint! * 100, WB_TINT), ...WB_TINT, integer: true, hint: '−99 green to +99 magenta', optional: true }] : []),
      ] : previous!.fields,
      table: {
        label: 'Enabled cameras',
        columns: [{ id: 'number', label: '#' }, { id: 'camera', label: 'Camera' }, { id: 'now', label: 'Now' }, { id: 'tint', label: 'Tint' }],
        rows: cameras.slice(0, 64).map(camera => ({
          number: camera.number, camera: camera.name.slice(0, 80),
          now: !camera.online ? 'Offline' : camera.temp === null ? '—' : `${Math.round(camera.temp)} K`,
          tint: !camera.online || camera.temp === null ? '—' : camera.tint === null ? 'none' : signedTint(camera.tint),
        })),
      },
      notes: [
        ...(!receivers.length ? ['No checked camera reports a colour temperature, so Send has nothing to send to.'] : []),
        ...(withTint && noTint.length ? [`${cameraList(noTint)} ${noTint.length === 1 ? 'has' : 'have'} no tint, so ${noTint.length === 1 ? 'it gets' : 'they get'} the temperature only.`] : []),
        ...(noTemp.length ? [`${cameraList(noTemp)} ${noTemp.length === 1 ? 'reports' : 'report'} no colour temperature, so ${noTemp.length === 1 ? 'it gets' : 'they get'} nothing.`] : []),
        ...(offline.length ? [`${cameraList(offline)} ${offline.length === 1 ? 'is' : 'are'} offline, so ${offline.length === 1 ? 'it gets' : 'they get'} nothing.`] : []),
      ].map(note => note.slice(0, 200)).slice(0, 4),
      submitLabel: `Send to ${receivers.length} camera${receivers.length === 1 ? '' : 's'}`,
      answer: { actionId, fields: fields as never },
      expiresInMs: WB_DIALOG_MS,
    };
    return { prompt, asked: `Asked HubDash for a white balance for ${count(receivers.length)}` };
  }
  /** Keeps each open White Balance dialog on the cameras checked now and what they report, without touching what was typed. */
  private refreshWhiteBalance() {
    if (!this.openWhiteBalance.size || !this.context.publishEvent) return;
    const now = Date.now(), { enabled } = this.selection.snapshot();
    for (const [deviceId, open] of this.openWhiteBalance) {
      if (now >= open.until) { this.openWhiteBalance.delete(deviceId); continue; }
      const device = this.plan.devices.find(row => row.id === deviceId), session = this.sessions.get(deviceId);
      if (!device || !session || session.snapshot().phase !== 'ready') continue;
      const captured = this.plan.cameras.filter(row => row.device === deviceId && enabled[row.id]).map(row => {
        try { return { row, target: this.capture(row, session) }; } catch { return { row }; }
      });
      const { prompt } = this.whiteBalancePrompt(device, captured, open.actionId, open.fields, open.prompt);
      const text = JSON.stringify(prompt);
      if (text === open.text) continue;
      open.prompt = prompt; open.text = text;
      // Only refreshes the dialog: Hubble ignores it once the dialog has closed.
      this.context.publishEvent(MODULE_PROMPT_CHANNEL, { ...prompt, update: true } as never);
    }
  }
  /**
   * Moves one camera to the typed temperature and tint with the RCP's own `add` commands, by the difference from
   * where the camera reports it is, then waits for it to report the result.
   */
  private async sendWhiteBalance(row: RecordValue, session: RcpSession, target: CyanViewCameraTarget, typed: { temperature: number; tint: number | null }, signal: AbortSignal): Promise<RecordingTargetResult> {
    const before = session.observeTarget(target);
    const tempStep = Math.round(typed.temperature - before.wbTemp!);
    const tintNow = before.wbTint === null ? null : Math.round(before.wbTint * 100);
    const tintStep = typed.tint === null || tintNow === null ? 0 : typed.tint - tintNow;
    const describe = (temp: number | null, tint: number | null) => `${temp === null ? '—' : Math.round(temp)} K${tint === null || typed.tint === null ? '' : `, tint ${signedTint(tint)}`}`;
    if (tempStep === 0 && tintStep === 0) return { target: row.id, outcome: 'success', evidence: 'noop', message: `Already at ${describe(before.wbTemp, before.wbTint)}` };
    if (tempStep !== 0) await this.recording.deliver(() => session.addWhiteBalance(target, 'wb_temp', String(tempStep), signal), signal);
    if (tintStep !== 0) await this.recording.deliver(() => session.addWhiteBalance(target, 'wb_tint', (tintStep / 100).toFixed(6), signal), signal);
    // A camera may settle on its own nearest step, so within 10 K and half a tint step counts as there.
    const there = (now: CyanViewCameraTarget['observation']) =>
      now.wbTemp !== null && Math.abs(now.wbTemp - typed.temperature) <= 10 &&
      (tintStep === 0 || (now.wbTint !== null && Math.abs(now.wbTint * 100 - typed.tint!) < 0.5));
    const deadline = Date.now() + (this.options.whiteBalanceConfirmMs ?? WB_CONFIRM_MS);
    let now = session.observeTarget(target);
    while (!there(now) && Date.now() < deadline) { await delay(20, undefined, { signal }); now = session.observeTarget(target); }
    if (there(now)) return { target: row.id, outcome: 'success', evidence: 'confirmed', message: describe(now.wbTemp, now.wbTint) };
    if (now.wbTemp !== before.wbTemp || now.wbTint !== before.wbTint)
      return { target: row.id, outcome: 'success', evidence: 'delivered', message: `Camera settled at ${describe(now.wbTemp, now.wbTint)}` };
    return { target: row.id, outcome: 'failure', evidence: 'unconfirmed', message: 'The camera hasn’t reported the new colour temperature' };
  }
  /** Waits for the camera's own report of the ND state a press asked for. A camera already there has reported it. */
  private async ndReported(session: RcpSession, target: CyanViewCameraTarget, clear: boolean, signal: AbortSignal) {
    const deadline = Date.now() + (this.options.ndConfirmMs ?? ND_CONFIRM_MS);
    for (;;) {
      if (session.observeTarget(target).ndClear === clear) return true;
      if (Date.now() >= deadline) return false;
      await delay(20, undefined, { signal });
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
    if (this.stopped || (this.sample && !this.options.session)) return;
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
      let recording: boolean | null = null, connection: Connection | null = null, stopping = false;
      // Group rows: every one, or only some, of their cameras enabled or rolling.
      let all = false, some = false;
      if (command === 'toggle-camera-enabled' && resolved) active = matches.every(row => selected.enabled[row.id] === true);
      if (devices.length && command === 'enable-all-cameras') {
        active = rows.length > 0 && rows.every(row => selected.enabled[row.id]);
        all = active;
        some = !all && rows.some(row => selected.enabled[row.id]);
      }
      if (devices.length && command === 'single-switch') active = devices.every(item => selected.singleSwitch[item.id] === true);
      // A camera row's connection is the camera's own path. A controller being up says nothing about a camera it doesn't have.
      // With no controller named, a camera row follows that camera on every controller that has it: online when any of
      // them sees it online, Camera offline when any reaches its RIO, RIO offline when none does, and recording when any sees it roll.
      if (!device && cameraCommands.includes(command) && devices.length) {
        const seen = matches.flatMap(row => {
          const own = this.plan.devices.find(item => item.id === row.device), owner = own && this.sessions.get(own.id);
          if (!owner) return [];
          const { connection: found, target } = this.cameraReach(owner, Number(row.number)), observation = target?.observation;
          const reached = this.withoutRio(found, [row]);
          const usable = !!target && observation!.online === true && observation!.recording !== null && this.recording.usableObservation(`${own.id}/${target.address}`, target, observation!);
          return [{ connection: reached, recording: usable ? observation!.recording : null }];
        });
        // A number no controller has is not configured. Otherwise: online through any controller, Camera offline when
        // any reaches its RIO, RIO offline when none does, and not configured when no controller lists it.
        if (!matches.length) connection = devices.every(item => this.sessions.has(item.id)) ? 'not-configured' : null;
        else if (seen.length) connection = seen.some(item => item.connection === 'online') ? 'online'
          : seen.some(item => item.connection === 'camera-offline') ? 'camera-offline'
          : seen.some(item => item.connection === 'rio-offline') && seen.every(item => item.connection === 'rio-offline' || item.connection === 'not-configured') ? 'rio-offline'
          : seen.every(item => item.connection === 'not-configured') ? 'not-configured' : null;
        if (seen.some(item => item.recording === true)) recording = true;
        else if (seen.length && seen.every(item => item.recording === false)) recording = false;
      }
      // A camera row with a controller named follows its camera there, found by number the same way its press finds it, as reported over MQTT.
      const reach = device && cameraCommands.includes(command) ? this.cameraReach(session, Number(values['module.cameraNumber'])) : null;
      if (reach) connection = reach.connection;
      // A named controller with no camera under the number in the setup has nothing to reach, unless the controller has one.
      if (reach && !reach.target && !matches.length) connection = 'not-configured';
      if (reach) connection = this.withoutRio(connection, matches);
      // A key naming a controller the setup doesn't have, or with no controller to ask, has no camera set up behind it.
      if (cameraCommands.includes(command) && !device && !devices.length) connection = 'not-configured';
      if (session?.snapshot().phase === 'ready') {
        if (command === 'select-camera') {
          const current = this.selectedCamera(device!.id, session);
          if (current !== null) active = current === values['module.cameraNumber'];
        }
        if (reach?.target) {
          const target = reach.target, observation = target.observation;
          stopping = this.recording.isStopping(`${device!.id}/${target.address}`);
          if (observation.online === true && observation.recording !== null && this.recording.usableObservation(`${device!.id}/${target.address}`, target, observation)) {
            recording = observation.recording;
            if (command === 'record-camera') active = observation.recording;
          }
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
        if (ndCommands.includes(command)) {
          // Only checked cameras with ND in/out count. One that is offline, or not reported yet, leaves the key unknown.
          const states = rows.filter(row => selected.enabled[row.id]).flatMap(row => {
            try {
              const observation = session.captureCamera(Number(row.number)).observation;
              if (observation.online === true && observation.ndClear === null) return [];
              return [this.appliedRow(row) && observation.online === true ? observation.ndClear : null];
            } catch { return [null]; }
          });
          if (states.length && states.every(value => value !== null))
            active = states.every(clear => clear === (command === 'nd-out-enabled-cameras'));
          all = states.length > 0 && states.every(clear => clear === false);
          some = !all && states.some(clear => clear === false);
        }
        if (baseGainCommands.includes(command)) {
          // Only checked cameras reporting Low or High count. One that is offline leaves the key unknown.
          const wanted = command === 'base-gain-up-enabled-cameras' ? 'high' : 'low';
          const states = rows.filter(row => selected.enabled[row.id]).flatMap(row => {
            try {
              const observation = session.captureCamera(Number(row.number)).observation;
              const base = observation.baseGain?.toLowerCase() ?? null;
              if (observation.online === true && base !== 'low' && base !== 'high') return [];
              return [this.appliedRow(row) && observation.online === true ? base : null];
            } catch { return [null]; }
          });
          if (states.length && states.every(value => value !== null)) active = states.every(base => base === wanted);
          all = states.length > 0 && states.every(base => base === wanted);
          some = states.some(base => base === 'low') && states.some(base => base === 'high');
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
      for (const action of ndCommands) own[action] = [all && 'nd-in', some && 'some-nd-in'];
      own['base-gain-up-enabled-cameras'] = [all && 'base-high', some && 'base-mixed'];
      own['base-gain-down-enabled-cameras'] = [all && 'base-low', some && 'base-mixed'];
      const path = cameraCommands.includes(command) && connection !== null ? [connectionTrigger[connection]] : [];
      const triggers = !observing ? null : [...(own[command] ?? []), ...path].filter((id): id is string => typeof id === 'string');
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
    this.refreshWhiteBalance();
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
