/**
 * The Cyanview setup guide: seven steps, each ticked from what the page and the worker can see, in
 * the same shape as HubDash's Guided setup checklist.
 *
 * Progress (open, skipped, a press that has been seen) describes this computer, as HubDash's does,
 * so it is not workspace data: exporting a workspace must not carry a claim that someone here
 * already walked through it. HubDash keeps its progress in the browser, but a module page runs in a
 * frame with no storage of its own, so the worker keeps this in its runtime folder on this Mac.
 */

export const SETUP_GUIDE_STEP_IDS = ['find', 'name', 'cameras', 'send', 'remi', 'actions', 'press'] as const;
export type SetupGuideStepId = (typeof SETUP_GUIDE_STEP_IDS)[number];

export const SETUP_GUIDE_STEP_TITLES: Readonly<Record<SetupGuideStepId, string>> = {
  find: 'Find your controllers',
  name: 'Name your controllers',
  cameras: 'Add your cameras',
  send: 'Send to the controllers',
  remi: 'Share cameras with REMI',
  actions: 'Add Cyanview actions',
  press: 'Press a key',
};

/** REMI is only for cameras that go on to other RCPs, so it never holds the rest up. */
export const SETUP_GUIDE_OPTIONAL: ReadonlySet<SetupGuideStepId> = new Set(['remi']);

export interface SetupGuideFacts {
  /** False until the page has read the saved plan, so an empty list isn't mistaken for a new setup. */
  readonly loaded: boolean;
  readonly controllers: number;
  readonly online: number;
  /** Controllers still named by their serial number, as a new one is. */
  readonly unnamed: number;
  /** Cameras with a Source, so they belong to a controller. */
  readonly cameras: number;
  /** Everything waiting in Pending sends. */
  readonly pending: number;
  /** What Send would send now; the rest is waiting on something else. */
  readonly ready: number;
  readonly remiCopies: number;
  /** Button Matrix keys with a Cyanview action. */
  readonly keys: number;
  /** A Cyanview key has been pressed since the worker started. */
  readonly pressed: boolean;
  readonly simulated: boolean;
}

export interface SetupGuideProgress {
  readonly open: boolean;
  /** The panel has opened by itself once. It never does again. */
  readonly offered: boolean;
  readonly skipped: readonly SetupGuideStepId[];
  /** Steps seen done once that stay done: a press is over as soon as it happens. */
  readonly confirmed: readonly SetupGuideStepId[];
}

export const INITIAL_SETUP_GUIDE_PROGRESS: SetupGuideProgress = Object.freeze({ open: false, offered: false, skipped: [], confirmed: [] });

export type SetupGuideStepStatus = 'done' | 'skipped' | 'current' | 'upcoming';
export interface SetupGuideStep {
  readonly id: SetupGuideStepId;
  readonly title: string;
  readonly optional: boolean;
  readonly status: SetupGuideStepStatus;
}

const isStep = (value: unknown): value is SetupGuideStepId => SETUP_GUIDE_STEP_IDS.includes(value as SetupGuideStepId);
const steps = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter(isStep))] : [];

/** Reads saved progress, keeping what makes sense and dropping the rest. */
export function parseSetupGuideProgress(value: unknown): SetupGuideProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return INITIAL_SETUP_GUIDE_PROGRESS;
  const saved = value as Record<string, unknown>;
  return { open: saved.open === true, offered: saved.offered === true, skipped: steps(saved.skipped), confirmed: steps(saved.confirmed) };
}

/** True when the page or the worker can see the step's result, rather than taking anyone's word. */
export function setupGuideStepDetected(id: SetupGuideStepId, facts: SetupGuideFacts): boolean {
  switch (id) {
    case 'find': return facts.controllers > 0;
    case 'name': return facts.controllers > 0 && facts.unnamed === 0;
    case 'cameras': return facts.cameras > 0;
    case 'send': return facts.cameras > 0 && facts.pending === 0;
    case 'remi': return facts.remiCopies > 0;
    case 'actions': return facts.keys > 0;
    case 'press': return facts.pressed;
  }
}

export function setupGuideSteps(facts: SetupGuideFacts, progress: SetupGuideProgress): SetupGuideStep[] {
  let current = false;
  return SETUP_GUIDE_STEP_IDS.map(id => {
    const done = setupGuideStepDetected(id, facts) || progress.confirmed.includes(id);
    let status: SetupGuideStepStatus = done ? 'done' : progress.skipped.includes(id) ? 'skipped' : 'upcoming';
    if (status === 'upcoming' && !current) { status = 'current'; current = true; }
    return { id, title: SETUP_GUIDE_STEP_TITLES[id], optional: SETUP_GUIDE_OPTIONAL.has(id), status };
  });
}

/** Done and skipped steps both count, as in HubDash. */
export const setupGuideFinished = (steps: readonly SetupGuideStep[]) => steps.filter(step => step.status === 'done' || step.status === 'skipped').length;

/**
 * Progress after the facts change: a press seen once stays done, and the panel opens by itself the
 * first time the page has loaded and has no controllers.
 */
export function nextSetupGuideProgress(progress: SetupGuideProgress, facts: SetupGuideFacts): SetupGuideProgress {
  let next = progress;
  if (facts.pressed && !next.confirmed.includes('press')) next = { ...next, confirmed: [...next.confirmed, 'press'] };
  if (facts.loaded && !next.offered && facts.controllers === 0) next = { ...next, open: true, offered: true };
  return next;
}
