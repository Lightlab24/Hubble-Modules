import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeController, fixture, planFor } from './helpers.js';
import { emptyPlan } from '../src/model.js';

const live = { retryMs: [20, 40], settleMs: 10, connectMs: 500 };
async function waitFor(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await delay(5);
  assert.ok(condition(), what);
}
const changes = (f: ReturnType<typeof fixture>) => (f.states.at(-1) as any)?.values?.configChanges;
const count = (f: ReturnType<typeof fixture>, id: string) => changes(f)?.counts?.[id];

async function managed() {
  const fake = new FakeController();
  await fake.start();
  fake.config.Camera.c1 = { Number: '1', Name: 'Cam 1', Model: 'Sony - Venice-IP' };
  fake.config.Camera.c2 = { Number: '2', Name: 'Cam 2', Model: 'Sony - Venice-IP' };
  const f = fixture({}, { client: fake.client, liveConfig: live });
  await f.instance.start();
  const plan = planFor(fake), id = String(plan.devices[0]!.id);
  const saved = await f.call('save-plan', { revision: null, plan });
  await waitFor(() => fake.sockets.size === 1 && count(f, id) === 1, 'The managed controller has its settings socket open and its first configuration counted');
  return { fake, f, id, saved };
}

test('a change made outside Hubble is reported from the open socket, and the live read opens nothing new', async () => {
  const { fake, f, id } = await managed();
  try {
    const opened = fake.opened;
    // Someone renames a camera in Cyanview's own page. The controller pushes its configuration to every socket.
    fake.config.Camera.c1.Name = 'Renamed elsewhere';
    fake.config.Camera.c1.Password = 'CANARY_LIVE_PASSWORD';
    fake.broadcast();
    await waitFor(() => count(f, id) === 2, 'The change was counted');
    const reply = await f.call('refresh', { devices: [id], live: true });
    assert.equal(reply.snapshots[0].cameras.find((row: any) => row.elementKey === 'c1').name, 'Renamed elsewhere');
    assert.deepEqual(reply.failed, []);
    assert.equal(fake.opened - opened, 0, 'The live read used the socket already open');
    assert.equal(fake.actions.length, 0, 'Nothing was written to the controller');
    assert.doesNotMatch(JSON.stringify(f.states), /CANARY_LIVE_PASSWORD/, 'A pushed configuration stays out of public state');
    // The same configuration again isn't a change.
    fake.broadcast();
    await delay(60);
    assert.equal(count(f, id), 2);
    // Refresh all still reads afresh.
    await f.call('refresh');
    assert.ok(fake.opened - opened >= 1, 'Refresh all opened its own socket');
    await waitFor(() => fake.sockets.size === 1, 'Only the held socket stays open after Refresh all');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a send from Hubble counts once for its burst of pushes', async () => {
  const { fake, f, id } = await managed();
  try {
    // A controller can push several times for one change. Pushes this close together count once.
    fake.config.Camera.c2.Name = 'Step 1'; fake.broadcast();
    fake.config.Camera.c2.Name = 'Step 2'; fake.broadcast();
    fake.config.Camera.c2.Name = 'Step 3'; fake.broadcast();
    await waitFor(() => count(f, id) === 2, 'The burst was counted');
    await delay(60);
    assert.equal(count(f, id), 2);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a dropped settings socket is opened again, and a change made while it was closed still counts', async () => {
  const { fake, f, id } = await managed();
  try {
    const before = fake.opened;
    for (const socket of fake.sockets) socket.terminate();
    fake.config.Camera.c2.Number = '7';
    await waitFor(() => fake.opened > before && fake.sockets.size === 1, 'The socket was opened again');
    await waitFor(() => count(f, id) === 2, 'The change made while it was closed was counted');
    // Reopening onto the same configuration isn't a change.
    for (const socket of fake.sockets) socket.terminate();
    await waitFor(() => fake.opened > before + 1 && fake.sockets.size === 1, 'The socket was opened again');
    await delay(60);
    assert.equal(count(f, id), 2);
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('removing a controller closes its socket, and disposing the worker closes the rest', async () => {
  const { fake, f, saved } = await managed();
  try {
    await f.call('save-plan', { revision: saved.revision, plan: emptyPlan() });
    await waitFor(() => fake.sockets.size === 0, 'The removed controller\'s socket was closed');
    const opened = fake.opened;
    await delay(100);
    assert.equal(fake.opened, opened, 'A removed controller is not reopened');
    await f.call('save-plan', { revision: (await f.repository.read(f.signal)).revision, plan: planFor(fake) });
    await waitFor(() => fake.sockets.size === 1, 'A controller added back is watched again');
    await f.instance.dispose();
    await waitFor(() => fake.sockets.size === 0, 'Disposing the worker closed every settings socket');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('a socket that answers as another controller is not held', async () => {
  const fake = new FakeController();
  await fake.start();
  const f = fixture({}, { client: fake.client, liveConfig: live });
  try {
    await f.instance.start();
    const plan = planFor(fake);
    // The saved controller is a different one now living at this address.
    plan.devices[0]!.serial = 'CY-RIO-9-99';
    await f.call('save-plan', { revision: null, plan });
    const id = String(plan.devices[0]!.id);
    await waitFor(() => fake.opened >= 3, 'The address was tried more than once');
    await delay(30);
    assert.equal(count(f, id), undefined, 'Nothing it said was counted');
    const reply = await f.call('refresh', { devices: [id], live: true });
    assert.deepEqual(reply.failed, [id], 'A live read falls back to a fresh one, which finds the wrong controller');
  } finally { await f.instance.dispose(); await fake.close(); }
});

test('sample data opens no settings sockets', async () => {
  const fake = new FakeController();
  await fake.start();
  const f = fixture({ sampleData: true }, { client: fake.client, liveConfig: live });
  try {
    await f.instance.start();
    await f.call('save-plan', { revision: null, plan: planFor(fake) });
    await delay(100);
    assert.equal(fake.opened, 0);
    assert.equal(changes(f)?.counts && Object.keys(changes(f).counts).length, 0);
  } finally { await f.instance.dispose(); await fake.close(); }
});
