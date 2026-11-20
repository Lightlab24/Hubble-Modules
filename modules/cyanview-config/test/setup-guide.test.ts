import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INITIAL_SETUP_GUIDE_PROGRESS, nextSetupGuideProgress, parseSetupGuideProgress, setupGuideFinished, setupGuideSteps, type SetupGuideFacts,
} from '../src/setup-guide-model.js';
import { setupGuideStore } from '../src/setup-guide-store.js';

const empty: SetupGuideFacts = { loaded: true, controllers: 0, online: 0, unnamed: 0, cameras: 0, pending: 0, ready: 0, remiCopies: 0, keys: 0, pressed: false, simulated: false };
const statuses = (facts: Partial<SetupGuideFacts>, progress = INITIAL_SETUP_GUIDE_PROGRESS) =>
  setupGuideSteps({ ...empty, ...facts }, progress).map(step => step.id + ':' + step.status).join(' ');

test('a new setup starts on Find your controllers with nothing done', () => {
  assert.equal(statuses({}), 'find:current name:upcoming cameras:upcoming send:upcoming remi:upcoming actions:upcoming press:upcoming');
  assert.equal(setupGuideFinished(setupGuideSteps(empty, INITIAL_SETUP_GUIDE_PROGRESS)), 0);
});

test('each step ticks from what the page and the worker can see', () => {
  // Controllers found but still named by serial number.
  assert.equal(statuses({ controllers: 3, unnamed: 1 }).split(' ').slice(0, 3).join(' '), 'find:done name:current cameras:upcoming');
  // Cameras added with edits still waiting to send.
  assert.match(statuses({ controllers: 3, cameras: 4, pending: 2 }), /cameras:done send:current/);
  // Everything sent: REMI is next and says it's optional, and a skip moves on to actions.
  const sent = setupGuideSteps({ ...empty, controllers: 3, cameras: 4 }, INITIAL_SETUP_GUIDE_PROGRESS);
  assert.deepEqual(sent.find(step => step.id === 'remi'), { id: 'remi', title: 'Share cameras with REMI', optional: true, status: 'current' });
  assert.match(statuses({ controllers: 3, cameras: 4 }, { ...INITIAL_SETUP_GUIDE_PROGRESS, skipped: ['remi'] }), /remi:skipped actions:current/);
  // A key using Cyanview and a press finish it.
  const all = setupGuideSteps({ ...empty, controllers: 3, cameras: 4, remiCopies: 2, keys: 5, pressed: true }, INITIAL_SETUP_GUIDE_PROGRESS);
  assert.equal(setupGuideFinished(all), 7);
});

test('a new edit puts Send back, since it is read live', () => {
  assert.match(statuses({ controllers: 1, cameras: 1, pending: 0 }), /send:done/);
  assert.match(statuses({ controllers: 1, cameras: 1, pending: 1 }), /send:current/);
});

test('a press stays done once seen, though the worker forgets it on restart', () => {
  const seen = nextSetupGuideProgress(INITIAL_SETUP_GUIDE_PROGRESS, { ...empty, controllers: 1, pressed: true });
  assert.deepEqual(seen.confirmed, ['press']);
  assert.match(statuses({ controllers: 1, pressed: false }, seen), /press:done/);
  assert.equal(nextSetupGuideProgress(seen, { ...empty, controllers: 1, pressed: true }), seen);
});

test('the panel opens by itself once, after the plan has loaded with no controllers', () => {
  assert.equal(nextSetupGuideProgress(INITIAL_SETUP_GUIDE_PROGRESS, { ...empty, loaded: false }), INITIAL_SETUP_GUIDE_PROGRESS);
  assert.equal(nextSetupGuideProgress(INITIAL_SETUP_GUIDE_PROGRESS, { ...empty, controllers: 2 }), INITIAL_SETUP_GUIDE_PROGRESS);
  const opened = nextSetupGuideProgress(INITIAL_SETUP_GUIDE_PROGRESS, empty);
  assert.deepEqual([opened.open, opened.offered], [true, true]);
  // Closed by hand, it stays closed even with no controllers.
  const closed = { ...opened, open: false };
  assert.equal(nextSetupGuideProgress(closed, empty), closed);
});

test('saved progress keeps what makes sense and drops the rest', () => {
  assert.deepEqual(parseSetupGuideProgress({ open: true, offered: true, skipped: ['remi'], confirmed: ['press'] }), { open: true, offered: true, skipped: ['remi'], confirmed: ['press'] });
  assert.deepEqual(parseSetupGuideProgress({ open: 'yes', skipped: ['remi', 'nonsense', 4, 'remi'], confirmed: 'press' }), { open: false, offered: false, skipped: ['remi'], confirmed: [] });
  for (const bad of [null, undefined, 'text', 4, []]) assert.equal(parseSetupGuideProgress(bad), INITIAL_SETUP_GUIDE_PROGRESS);
});

test("progress is kept in the module's runtime folder on this Mac, apart for Simulated", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'cyanview-guide-'));
  try {
    const store = setupGuideStore(() => folder);
    assert.equal(store.read('real'), INITIAL_SETUP_GUIDE_PROGRESS);
    store.write('real', { open: false, offered: true, skipped: ['remi'], confirmed: ['press'] });
    store.write('simulated', { open: true, offered: true, skipped: [], confirmed: [] });
    // A new worker, as after a restart, reads both back from the file.
    const restarted = setupGuideStore(() => folder);
    assert.deepEqual(restarted.read('real'), { open: false, offered: true, skipped: ['remi'], confirmed: ['press'] });
    assert.deepEqual(restarted.read('simulated'), { open: true, offered: true, skipped: [], confirmed: [] });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(folder, 'setup-guide.json'), 'utf8'))).sort(), ['real', 'simulated']);
    // A damaged file starts the guide afresh rather than failing.
    await writeFile(path.join(folder, 'setup-guide.json'), 'not json');
    assert.equal(setupGuideStore(() => folder).read('real'), INITIAL_SETUP_GUIDE_PROGRESS);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('before Hubble grants the folder, progress lasts for this run only', () => {
  const store = setupGuideStore(() => undefined);
  store.write('real', { open: true, offered: true, skipped: [], confirmed: [] });
  assert.deepEqual(store.read('real'), { open: true, offered: true, skipped: [], confirmed: [] });
  assert.equal(setupGuideStore(() => undefined).read('real'), INITIAL_SETUP_GUIDE_PROGRESS);
});
