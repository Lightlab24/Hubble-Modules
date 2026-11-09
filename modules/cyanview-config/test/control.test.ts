import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, FakeController } from './helpers.js';
import { broker, closeBrokers } from './control-broker.js';
import { RcpSession } from '../src/control/rcp-session.js';
import { RecordingCoordinator } from '../src/control/recording-coordinator.js';
import { feedbackTimeout } from '../src/control/service.js';
import { matrix } from '../src/control/matrix.js';
import { commands, localCommands } from '../src/control/config.js';
import manifest from '../src/manifest.js';
import { createModuleDocumentClient, moduleMatrixMatches, parseModuleMatrixValue, resolveModuleMatrixField } from '@hubble/module-sdk';
import { object, type Plan } from '../src/model.js';

afterEach(closeBrokers);
const eventually = async (predicate: () => boolean, attempts = 200) => {
  for (let i = 0; i < attempts; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Expected control observation');
};
/** An RCP and a second controller, a RIO with no panel unless a test asks for another kind. */
async function fleet({ second = { Serial: 'CY-RIO-1-20', Name: 'RIO' }, secondPanel = false } = {}) {
  const a = new FakeController(), b = new FakeController();
  a.config.Product = { Serial: 'CY-RCP-1-10', Name: 'RCP' };
  b.config.Product = { ...second };
  b.config.IP.protected.IP = '10.192.1.20'; b.config.IP.old.IP = '10.20.101.201';
  for (const fake of [a, b]) fake.config.Camera = {
    a: { Number: '1', Name: 'Wide', Model: 'Sony - Venice-IP' },
    b: { Number: '2', Name: 'Tight', Model: 'Sony - Venice-IP' },
  };
  await Promise.all([a.start(), b.start()]);
  const networks = [await broker(), await broker()];
  networks[1]!.controls.panel = secondPanel;
  const addresses = new Map([['10.192.1.10', a], ['10.192.1.20', b], ['10.20.101.200', a]]);
  // Each entry slows or fails one configuration read, so tests can finish a press's check out of order.
  const verifyDelays: (number | Error)[] = [];
  const sessions: RcpSession[] = [];
  const options: Parameters<typeof fixture>[1] = {
    client: address => {
      const fake = addresses.get(address); if (!fake) throw new Error('Simulated controller offline');
      const client = fake.client(address), wait = verifyDelays.shift();
      if (wait instanceof Error) throw wait;
      if (wait) { const connect = client.connect.bind(client); client.connect = async signal => { await delay(wait); return connect(signal); }; }
      return client;
    },
    control: { session: (definition, changed) => {
      const network = networks[definition.serial === a.config.Product.Serial ? 0 : 1]!;
      const session = new RcpSession({ ...definition, requestTimeoutMs: 350 }, changed, true,
        () => createConnection({ host: '127.0.0.1', port: network.port }));
      sessions.push(session); return session;
    } },
  };
  const f = fixture({}, options);
  await f.instance.start();
  const snapshots = [a.snapshot(), b.snapshot('10.192.1.20')];
  let plan: Plan = { formatVersion: 1 as const, devices: snapshots.map(snapshot => ({ ...snapshot.device, name: 'Same label' })),
    cameras: snapshots.flatMap(snapshot => snapshot.cameras), lans: [], uiState: null };
  await f.call('save-plan', { revision: null, plan });
  const ids = plan.devices.map(device => device.id);
  const run = (command: string, controller = 0, cameraNumber?: number, signal?: AbortSignal) => f.instance.execute(command,
    { controllerId: ids[controller]!, ...(cameraNumber === undefined ? {} : { cameraNumber }) }, { ...f.execution(), ...(signal ? { signal } : {}) });
  const state = async () => f.call('camera-control-state');
  const save = async () => { const current = await f.repository.read(f.signal); await f.call('save-plan', { revision: current.revision, plan }); };
  return { f, a, b, networks, sessions, plan, ids, run, state, save, verifyDelays, options,
    async close() { await f.instance.dispose(); await Promise.all([a.close(), b.close()]); },
  };
}

test('new Matrix descriptor requires a named controller and declares camera series and portable selection', () => {
  assert.equal(matrix.fields.find(field => field.id === 'module.controllerId')!.required, true);
  assert.equal(matrix.fields.find(field => field.id === 'module.cameraNumber')!.fill, 'series');
  assert.equal(matrix.fields.find(field => field.id === 'module.controllerId')!.fill, 'copy');
  assert.equal(parseModuleMatrixValue(matrix.fields.find(field => field.id === 'module.controllerId')!, 'CY-RCP-1-10'), 'CY-RCP-1-10');
  assert.ok(manifest.documents?.some(document => document.id === 'camera-control'));
  assert.equal(manifest.actions.some(action => 'legacy' in action && action.legacy), false);
});

test('a row with no action is empty rather than incomplete, and only actions that reach equipment need a controller', () => {
  const field = (id: string) => matrix.fields.find(row => row.id === id)!;
  assert.equal(field('actionType').default, '');
  assert.equal(field('actionType').required, false);
  assert.equal(parseModuleMatrixValue(field('actionType'), ''), '');
  assert.equal(moduleMatrixMatches(matrix.inactiveWhen!, { actionType: '' }), true);
  const controller = field('module.controllerId');
  assert.equal(moduleMatrixMatches(controller.enabledWhen!, { actionType: '' }), false, 'Nothing is missing on an empty row');
  for (const [command] of commands) {
    assert.equal(moduleMatrixMatches(matrix.inactiveWhen!, { actionType: command }), false);
    assert.equal(moduleMatrixMatches(controller.enabledWhen!, { actionType: command }), true, `${command} can name a controller`);
    assert.equal(resolveModuleMatrixField(controller, { actionType: command }).required, !localCommands.includes(command), `${command} requiredness`);
    assert.equal(parseModuleMatrixValue(field('actionType'), command), command, 'Saved actions stay valid');
  }
  for (const action of manifest.actions.filter(item => commands.some(([command]) => command === item.id)))
    assert.equal(action.fields.find(item => item.id === 'controllerId')!.required, !localCommands.includes(action.id), `${action.id} in Advanced`);
});

test('named choices are offline, distinguish duplicate names, filter camera numbers, and survive rename/address changes', async () => {
  const s = await fleet();
  try {
    const query = (provider: string, draft = {}) => s.f.instance.discoverChoices!({ version: 2, provider, draft, search: '', cursor: null, limit: 128, requestRevision: 1 }, { signal: s.f.signal });
    const controllers = await query('control-controllers');
    assert.equal(controllers.choices.length, 2);
    assert.notEqual(controllers.choices[0]!.label, controllers.choices[1]!.label);
    assert.equal((await query('control-controllers', { actionType: 'select-camera' })).choices.length, 1);
    const cameras = await query('control-cameras', { 'module.controllerId': s.ids[1]! });
    assert.deepEqual(cameras.choices.map(choice => choice.values?.['module.cameraNumber']), [1, 2]);
    assert.equal(s.a.actions.length, 0);
    s.plan.devices[0]!.name = 'Stage left'; s.plan.devices[0]!.address = '10.20.101.200'; await s.save();
    assert.match((await query('control-controllers')).choices[0]!.label, /Stage left/);
    const routeResult = await s.run('select-camera', 0, 1);
    assert.equal(routeResult.status, 'success', JSON.stringify(routeResult));
    assert.equal(s.sessions.at(-1)!.definition.host, '10.20.101.200');
    assert.deepEqual(s.networks[0]!.commands.map(command => [command.topic, command.value]), [['unit/RCP/rcp/action/set/active_camera_number', '1']]);
    assert.equal(s.networks[1]!.commands.length, 0);
  } finally { await s.close(); }
});

test('a Gateway is in both pick lists, named by its name and serial or by its serial alone', async () => {
  const s = await fleet({ second: { Serial: 'CY-GATEWAY-1-40', Name: 'GATEWAY' }, secondPanel: true });
  try {
    assert.equal(s.plan.devices[1]!.kind, 'Gateway');
    const query = async (provider: string, draft = {}) => (await s.f.instance.discoverChoices!({ version: 2, provider, draft, search: '', cursor: null, limit: 128, requestRevision: 1 }, { signal: s.f.signal })).choices;
    const gateway = async (provider: string, draft = {}) => (await query(provider, draft)).find(choice => choice.id === s.ids[1]);
    for (const [provider, draft] of [['control-controllers', {}], ['control-controllers', { actionType: 'select-camera' }], ['control-rcps', {}]] as const)
      assert.ok(await gateway(provider, draft), `${provider} ${JSON.stringify(draft)} lists the Gateway`);
    assert.deepEqual((await query('control-controllers', { actionType: 'select-camera' })).map(choice => choice.id), s.ids, 'An RCP and a Gateway, not a RIO');
    s.plan.devices[1]!.name = 'CY-GATEWAY-1-40'; await s.save();
    assert.equal((await gateway('control-controllers'))!.label, 'CY-GATEWAY-1-40', 'A name that is still the serial shows once');
    s.plan.devices[1]!.name = 'Truck Gateway'; await s.save();
    assert.equal((await gateway('control-controllers'))!.label, 'Truck Gateway · CY-GATEWAY-1-40');
    const cameras = await query('control-cameras', { 'module.controllerId': s.ids[1]! });
    assert.deepEqual(cameras.map(choice => choice.values?.['module.cameraNumber']), [1, 2]);
    assert.equal(s.b.actions.length, 0);
  } finally { await s.close(); }
});

test('a Gateway is watched over MQTT from the start and takes camera commands like an RCP', async () => {
  const s = await fleet({ second: { Serial: 'CY-GATEWAY-1-40', Name: 'GATEWAY' }, secondPanel: true });
  try {
    const [, , wide] = s.plan.cameras, control = () => object(object(object(s.f.states.at(-1)).values).cameraControl);
    // Nothing is ticked or pressed, and it answers by itself.
    await eventually(() => control().controllers?.[s.ids[1]!] === true && control().cameras?.[wide!.id]?.online === true);
    assert.equal(s.networks[1]!.commands.length, 0, 'Watching sends nothing');
    const select = await s.run('select-camera', 1, 2);
    assert.equal(select.status, 'success', JSON.stringify(select));
    assert.deepEqual(s.networks[1]!.commands.map(command => [command.topic, command.value]), [['unit/RCP/rcp/action/set/active_camera_number', '2']]);
    const record = await s.run('record-camera', 1, 1);
    assert.equal(record.status, 'success', JSON.stringify(record));
    assert.equal(s.networks[1]!.commands.at(-1)!.topic, 'unit/a/camhead/action/set/keyboard');
    // Ticks and steps work on its cameras, and leave the RCP's alone.
    assert.equal((await s.run('enable-all-cameras', 1)).status, 'success');
    const { enabled } = await s.state();
    assert.deepEqual(s.plan.cameras.map(row => !!enabled[row.id]), [false, false, true, true]);
    const nd = await s.run('nd-up-enabled-cameras', 1);
    assert.equal(nd.status, 'success', JSON.stringify(nd));
    assert.deepEqual(s.networks[1]!.commands.slice(-2).map(command => command.topic), ['unit/a/camhead/action/next/nd_filter', 'unit/b/camhead/action/next/nd_filter']);
    assert.equal(s.networks[0]!.commands.length, 0);
  } finally { await s.close(); }
});

test('Select camera on a controller with no RCP panel says so, and sends nothing', async () => {
  const s = await fleet({ second: { Serial: 'CY-GATEWAY-1-40', Name: 'GATEWAY' } });
  try {
    const control = () => object(object(object(s.f.states.at(-1)).values).cameraControl);
    await eventually(() => control().controllers?.[s.ids[1]!] === true);
    const result = await s.run('select-camera', 1, 1);
    assert.equal(result.status, 'failure');
    assert.match(String((result as { message?: string }).message), /No single RCP panel has reported on this controller/);
    assert.equal(s.networks[1]!.commands.length, 0);
  } finally { await s.close(); }
});

test('Action choices separate RCP camera selection from Cyanview and retain existing saved values', async () => {
  const f=fixture();
  try {
    await f.instance.start();
    const query=(search='',cursor: string|null=null,limit=100)=>f.instance.discoverChoices!({version:2,provider:'control-actions',draft:{actionType:'select-camera'},search,cursor,limit,requestRevision:1},{signal:f.signal});
    const page=await query();
    assert.deepEqual([...new Set(page.choices.map(choice=>choice.group))],['RCP set active camera','Cyanview']);
    assert.deepEqual(page.choices.filter(choice=>choice.group==='RCP set active camera').map(choice=>choice.id),['select-camera']);
    assert.equal(page.choices.filter(choice=>choice.group==='Cyanview').length,14);
    const actionField=matrix.fields.find(field=>field.id==='actionType')!;
    for(const choice of page.choices)assert.equal(parseModuleMatrixValue(actionField,choice.id),choice.id);
    assert.equal((await query('rcp')).choices[0]?.id,'select-camera');
    assert.equal((await query('rcp')).choices.length,1);
    assert.equal((await query('',null,1)).nextCursor,'1');
    assert.equal((await query('','1',1)).choices[0]?.group,'Cyanview');
    assert.equal(f.records.size,0);
    assert.deepEqual((await f.instance.choices!('control-actions')).map(choice=>choice.group),page.choices.map(choice=>choice.group));
  } finally { await f.instance.dispose(); }
});

test('local quick groups, Enable All and Single switch are scoped to the named controller', async () => {
  const s = await fleet();
  try {
    assert.deepEqual((await s.state()).enabled, {});
    for (const index of [0, 1]) assert.equal((await s.run('enable-all-cameras', index)).status, 'success');
    await s.run('single-switch', 0);
    let state = await s.state();
    assert.deepEqual(s.plan.cameras.map(row => !!state.enabled[row.id]), [true, false, true, true]);
    await s.run('toggle-camera-enabled', 0, 2);
    state = await s.state();
    assert.deepEqual(s.plan.cameras.map(row => !!state.enabled[row.id]), [false, true, true, true]);
    await s.run('enable-all-cameras', 0);
    assert.equal((await s.state()).singleSwitch[s.ids[0]!], false);
    assert.deepEqual(s.networks.map(network => network.commands.length), [0, 0]); assert.equal(s.a.actions.length, 0);
    const ndResult = await s.run('nd-up-enabled-cameras', 1);
    assert.equal(ndResult.status, 'success', JSON.stringify(ndResult));
    assert.deepEqual(s.networks[1]!.commands.map(command => command.topic), ['unit/a/camhead/action/next/nd_filter', 'unit/b/camhead/action/next/nd_filter']);
    assert.equal(s.networks[0]!.commands.length, 0);
    assert.equal((await s.run('select-camera', 1, 1)).status, 'failure');
  } finally { await s.close(); }
});

/** A press from a Matrix row with its Cyanview controller cell left blank. */
const blankController = (s: Awaited<ReturnType<typeof fleet>>, actionType: string, cameraNumber: number | null = null) =>
  s.f.instance.execute('camera-control', { values: { enabled: true, actionType, 'module.controllerId': '', 'module.cameraNumber': cameraNumber } }, s.f.execution());

test('with no controller named, the selection actions cover every controller and contact none', async () => {
  const s = await fleet();
  try {
    const ticks = async () => { const { enabled } = await s.state(); return s.plan.cameras.map(row => !!enabled[row.id]); };
    const opened = [s.a.opened, s.b.opened];
    const first = await blankController(s, 'toggle-camera-enabled', 2);
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(first.status === 'success' && first.evidence?.kind, 'local');
    assert.deepEqual(await ticks(), [false, true, false, true], 'That number on both controllers');
    await blankController(s, 'toggle-camera-enabled', 2);
    assert.deepEqual(await ticks(), [false, false, false, false]);
    await s.run('toggle-camera-enabled', 0, 1);
    await blankController(s, 'toggle-camera-enabled', 1);
    assert.deepEqual(await ticks(), [true, false, true, false], 'A controller that disagrees is brought into line, not flipped the other way');
    await blankController(s, 'enable-all-cameras');
    assert.deepEqual(await ticks(), [true, true, true, true]);
    await blankController(s, 'enable-all-cameras');
    assert.deepEqual(await ticks(), [false, false, false, false]);
    await blankController(s, 'toggle-camera-enabled', 2);
    await blankController(s, 'single-switch');
    let state = await s.state();
    assert.deepEqual(s.ids.map(id => state.singleSwitch[id]), [true, true]);
    assert.deepEqual(await ticks(), [false, true, false, true]);
    await blankController(s, 'toggle-camera-enabled', 1);
    assert.deepEqual(await ticks(), [true, false, true, false], 'Single switch moves to that number everywhere');
    await blankController(s, 'toggle-camera-enabled', 1);
    assert.deepEqual(await ticks(), [true, false, true, false], 'Pressing the picked camera keeps it, as it does with a controller named');
    await blankController(s, 'single-switch');
    state = await s.state();
    assert.deepEqual(s.ids.map(id => state.singleSwitch[id]), [false, false]);
    assert.deepEqual([s.a.opened, s.b.opened], opened, 'No configuration read');
    assert.deepEqual(s.networks.map(network => network.commands.length), [0, 0], 'Nothing sent');
    assert.equal(s.a.actions.length + s.b.actions.length, 0);
  } finally { await s.close(); }
});

test('Single switch with no controller keeps one camera number even when controllers list cameras in a different order', async () => {
  const s = await fleet();
  try {
    const [wide, tight, otherWide, otherTight] = s.plan.cameras;
    s.plan.cameras = [wide!, tight!, otherTight!, otherWide!]; await s.save();
    await blankController(s, 'enable-all-cameras');
    await blankController(s, 'single-switch');
    const { enabled } = await s.state();
    assert.deepEqual([wide, tight, otherWide, otherTight].map(row => !!enabled[row!.id]), [true, false, true, false]);
  } finally { await s.close(); }
});

test('a blank controller still works with no controller reachable, and a press that needs one still refuses', async () => {
  const controller = new FakeController();
  controller.config.Product = { Serial: 'CY-RCP-1-10', Name: 'RCP' };
  controller.config.Camera = { a: { Number: '1', Name: 'Wide', Model: 'Sony - Venice-IP' } };
  const snapshot = controller.snapshot(), f = fixture();
  try {
    await f.instance.start();
    await f.call('save-plan', { revision: null, plan: { formatVersion: 1, devices: [snapshot.device], cameras: snapshot.cameras, lans: [], uiState: null } });
    const press = (actionType: string, cameraNumber: number | null = null) => f.instance.execute('camera-control', { values: { enabled: true, actionType, 'module.controllerId': '', 'module.cameraNumber': cameraNumber } }, f.execution());
    const result = await press('toggle-camera-enabled', 1);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal((await f.call('camera-control-state')).enabled[snapshot.cameras[0]!.id], true);
    assert.equal((await press('toggle-camera-enabled', 99)).status, 'failure', 'A number no controller has');
    for (const [command, number] of [['select-camera', 1], ['record-camera', 1], ['roll-enabled-cameras', null]] as const) {
      const refused = await press(command, number);
      assert.equal(refused.status, 'failure', command);
      assert.match(String((refused as { message?: string }).message), /Choose a named Cyanview controller/);
    }
  } finally { await f.instance.dispose(); }
});

test('a controller left blank offers each camera number once, and an unsent camera can still be ticked', async () => {
  const s = await fleet();
  try {
    const query = async (draft: Record<string, string>) => (await s.f.instance.discoverChoices!({ version: 2, provider: 'control-cameras', draft, search: '', cursor: null, limit: 128, requestRevision: 1 }, { signal: s.f.signal })).choices.map(choice => choice.values?.['module.cameraNumber']);
    assert.deepEqual(await query({ actionType: 'toggle-camera-enabled', 'module.controllerId': '' }), [1, 2]);
    assert.deepEqual(await query({ actionType: 'select-camera', 'module.controllerId': '' }), [], 'Select camera still needs its controller first');
    s.plan.cameras.push({ ...s.plan.cameras[0]!, id: 'unsent', elementKey: '', isNew: true, number: '7', name: 'New' }); await s.save();
    assert.deepEqual(await query({ actionType: 'toggle-camera-enabled', 'module.controllerId': '' }), [1, 2, 7]);
    assert.deepEqual(await query({ actionType: 'toggle-camera-enabled', 'module.controllerId': s.ids[0]! }), [1, 2, 7]);
    assert.deepEqual(await query({ actionType: 'record-camera', 'module.controllerId': s.ids[0]! }), [1, 2], 'Anything sent to a camera needs one that is on its controller');
    assert.equal((await blankController(s, 'toggle-camera-enabled', 7)).status, 'success');
  } finally { await s.close(); }
});

test('button feedback with no controller named follows every controller', async () => {
  const s = await fleet();
  try {
    const fields = (id: string, actionType: string, cameraNumber: number | null = null) => ({ actionId: id, actionColumnId: 'column-one', values: { enabled: true, actionType,
      'module.controllerId': '', 'module.cameraNumber': cameraNumber, 'module.feedbackEnabled': true, 'module.feedbackColor': '#333333 | #00FF00' } });
    await s.f.instance.subscribeFeedback!([
      { id: 'camera-control', fields: fields('camera', 'toggle-camera-enabled', 1) },
      { id: 'camera-control', fields: fields('all', 'enable-all-cameras') },
      { id: 'camera-control', fields: fields('single', 'single-switch') },
    ], { signal: s.f.signal });
    const latest = (id: string) => object(s.f.feedback.filter(item => object(object(item).fields).actionId === id).at(-1));
    await eventually(() => latest('camera').state === 'inactive' && latest('all').state === 'inactive' && latest('single').state === 'inactive');
    assert.equal(object(object(latest('camera').appearance).cells)['module.cameraNumber'].label, '1 · Wide');
    await s.run('toggle-camera-enabled', 0, 1);
    await delay(30);
    assert.equal(latest('camera').state, 'inactive', 'Camera 1 is only ticked on one controller');
    await blankController(s, 'enable-all-cameras');
    await eventually(() => latest('camera').state === 'active' && latest('all').state === 'active');
    await blankController(s, 'single-switch');
    await eventually(() => latest('single').state === 'active');
  } finally { await s.close(); }
});

test('a held save with no controller named shows at once, takes a second press, and rolls back whole', async () => {
  const s = await fleet(); let release = () => {};
  try {
    const live = () => object(object(object(s.f.states.at(-1)).values).cameraControl).enabled ?? {};
    const shown = () => s.plan.cameras.map(row => !!live()[row.id]);
    release = s.f.holdWrites('camera-control');
    const first = blankController(s, 'toggle-camera-enabled', 1);
    await eventually(() => shown()[0] === true && shown()[2] === true);
    const second = blankController(s, 'toggle-camera-enabled', 2);
    await eventually(() => shown().every(Boolean));
    assert.equal(s.f.records.has('camera-control'), false, 'Still waiting on the save');
    s.f.failNextWrite('camera-control'); release();
    assert.equal((await first).status, 'failure'); assert.equal((await second).status, 'failure');
    const { enabled } = await s.state();
    assert.deepEqual(s.plan.cameras.map(row => !!enabled[row.id]), [false, false, false, false]);
    assert.equal((await blankController(s, 'toggle-camera-enabled', 1)).status, 'success', 'Works again after the failure');
  } finally { release(); await s.close(); }
});

test('held selection writes publish immediately, accept second edits, roll back dependents and preserve other controllers', async () => {
  const s = await fleet(); let release = () => {};
  try {
    release = s.f.holdWrites('camera-control');
    const first = s.run('toggle-camera-enabled', 0, 1);
    await eventually(() => object(object(s.f.states.at(-1)).values?.cameraControl).enabled?.[s.plan.cameras[0]!.id] === true);
    const second = s.run('toggle-camera-enabled', 0, 2);
    const independent = s.run('toggle-camera-enabled', 1, 1);
    await eventually(() => object(object(s.f.states.at(-1)).values?.cameraControl).enabled?.[s.plan.cameras[2]!.id] === true);
    assert.equal(s.f.records.has('camera-control'), false);
    s.f.failNextWrite('camera-control'); release();
    assert.equal((await first).status, 'failure'); assert.equal((await second).status, 'failure');
    assert.equal((await independent).status, 'success');
    const state = await s.state();
    assert.deepEqual(s.plan.cameras.map(row => !!state.enabled[row.id]), [false, false, true, false]);
    assert.equal((await s.run('nd-up-enabled-cameras', 1)).status, 'success');
  } finally { release(); await s.close(); }
});

test('selection survives stale configuration saves, portable document transfer and worker restart', async () => {
  const s = await fleet();
  try {
    await s.run('toggle-camera-enabled', 0, 2); await s.run('single-switch', 0);
    s.plan.cameras[0]!.name = 'Edited locally'; await s.save();
    const transferred = new Map(structuredClone([...s.f.records]));
    const restored = fixture({}, {}, transferred);
    try {
      await restored.instance.start();
      const state = await restored.call('camera-control-state');
      assert.equal(state.enabled[s.plan.cameras[1]!.id], true);
      assert.equal(state.singleSwitch[s.ids[0]!], true);
      assert.equal((await restored.repository.read(restored.signal)).plan.cameras[0]!.name, 'Edited locally');
      const sample = fixture({ sampleData: true }, {}, transferred);
      try { await sample.instance.start(); assert.deepEqual((await sample.call('camera-control-state')).enabled, {}); }
      finally { await sample.instance.dispose(); }
    } finally { await restored.instance.dispose(); }
  } finally { await s.close(); }
});

test('external document changes update quick-group feedback without a page reload', async () => {
  const s=await fleet();
  try {
    const documents=createModuleDocumentClient(s.f.context.services!);
    const saved=await documents.read('camera-control',s.f.signal);
    await documents.write(saved,{enabled:{[s.plan.cameras[0]!.id]:true},singleSwitch:{[s.ids[0]!]:true}},s.f.signal);
    await eventually(()=>object(object(s.f.states.at(-1)).values?.cameraControl).enabled?.[s.plan.cameras[0]!.id]===true);
    assert.equal((await s.state()).singleSwitch[s.ids[0]!],true);
  } finally { await s.close(); }
});

test('the selection keeps following its document after the host refuses a watch, and only a lasting refusal is logged', async () => {
  const f = fixture();
  try {
    f.refuseSelectionWatches(1);
    await f.instance.start();
    const documents = createModuleDocumentClient(f.context.services!);
    await delay(50);
    const saved = await documents.read('camera-control', f.signal);
    await documents.write(saved, { enabled: { 'camera-one': true }, singleSwitch: {} }, f.signal);
    await eventually(() => object(object(f.states.at(-1)).values?.cameraControl).enabled?.['camera-one'] === true);
    const refusals = () => f.traces.filter(entry => object(entry).stage === 'control-selection').length;
    assert.equal(refusals(), 0);
    f.refuseSelectionWatches(6);
    const next = await documents.read('camera-control', f.signal);
    await documents.write(next, { enabled: { 'camera-two': true }, singleSwitch: {} }, f.signal);
    for (let i = 0; i < 800 && !refusals(); i++) await delay(5);
    assert.equal(refusals(), 1);
  } finally { await f.instance.dispose(); }
});

test('unchecked groups send nothing; applied numbers and controller identity guard against stale or staged targets', async () => {
  const s = await fleet();
  try {
    assert.equal((await s.run('nd-up-enabled-cameras')).status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 0);
    await s.run('toggle-camera-enabled', 0, 1);
    s.plan.cameras[0]!.number = '2'; s.plan.cameras[0]!.dirty = ['number']; await s.save();
    assert.equal((await s.run('nd-up-enabled-cameras')).status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 0);
    s.plan.cameras[0]!.number = '1'; s.plan.cameras[0]!.dirty = []; await s.save();
    s.a.config.Camera.a.Number = '3';
    assert.equal((await s.run('nd-up-enabled-cameras')).status, 'failure');
    s.a.config.Camera.a.Number = '1'; s.a.config.Product.Serial = 'CY-RCP-WRONG';
    assert.equal((await s.run('record-camera', 0, 1)).status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 0);
  } finally { await s.close(); }
});

test('MQTT recording preserves direct camera targeting, confirmed Start/Stop, locks and no replay', async () => {
  const s = await fleet();
  try {
    assert.equal((await s.run('record-camera', 0, 1)).status, 'success');
    assert.equal((await s.state()).enabled[s.plan.cameras[0]!.id], undefined);
    await s.run('toggle-camera-enabled', 0, 1);
    const start = await s.run('roll-enabled-cameras');
    assert.equal(start.status, 'success');
    if (start.status === 'success') assert.equal(start.evidence.kind, 'state-confirmed');
    assert.equal(s.networks[0]!.commands.length, 1); // Already recording: no duplicate toggle.
    assert.equal((await s.run('stop-enabled-cameras')).status, 'success');
    assert.deepEqual(s.networks[0]!.commands.map(command => command.value), ['Rec', 'Stop']);
    s.networks[0]!.send('unit/a/camhead/status/volatile/rec_lock', '1'); await delay(20);
    assert.equal((await s.run('roll-enabled-cameras')).status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 2);
    s.networks[0]!.disconnect(); await delay(150);
    assert.equal(s.networks[0]!.commands.length, 2);
  } finally { await s.close(); }
});

test('Start and Stop send what each connected camera accepts, and only when its state says it needs it', async () => {
  const s = await fleet();
  try {
    const live = () => object(cameraControl(s.f).cameras), network = s.networks[0]!, [wide, tight] = s.plan.cameras;
    const values = () => network.commands.map(command => [command.topic.split('/')[1], command.value]);
    await eventually(() => live()[wide!.id]?.recording === 'stopped' && live()[tight!.id]?.recording === 'stopped');
    await s.run('toggle-camera-enabled', 0, 1); await s.run('toggle-camera-enabled', 0, 2);
    // Camera a is a switch and camera b only takes a toggle.
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.deepEqual(values().sort(), [['a', 'Rec'], ['b', 'RecToggle']]);
    // Both are recording, so there's nothing to send, and a toggle would have stopped b.
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.equal(values().length, 2);
    network.commands.length = 0;
    assert.equal((await s.run('stop-enabled-cameras')).status, 'success');
    assert.deepEqual(values().sort(), [['a', 'Stop'], ['b', 'RecToggle']]);
    // Mixed states: Start only touches the camera that isn't rolling.
    network.commands.length = 0;
    network.send('unit/b/camhead/status/volatile/recording', '1');
    await eventually(() => live()[tight!.id]?.recording === 'recording');
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.deepEqual(values(), [['a', 'Rec']]);
    // Toggle Recording flips each from its own state, using what that camera accepts.
    network.commands.length = 0;
    network.send('unit/a/camhead/status/volatile/recording', '0');
    await eventually(() => live()[wide!.id]?.recording === 'stopped');
    assert.equal((await s.run('roll-toggle-enabled-cameras')).status, 'success');
    assert.deepEqual(values().sort(), [['a', 'Rec'], ['b', 'RecToggle']]);
  } finally { await s.close(); }
});

test('the wait for a camera to report its state grows with the number of cameras in the press', async () => {
  assert.equal(feedbackTimeout(1), 15_000);
  assert.equal(feedbackTimeout(11), 20_000);
  assert.equal(feedbackTimeout(31), 30_000);
  assert.equal(feedbackTimeout(500), 60_000, 'Capped well inside the host\u2019s two minute limit');
  const s = await fleet();
  try {
    await s.f.instance.dispose();
    const network = s.networks[0]!;
    // Cameras that report after 300 ms: too late for one camera's wait here, in time for two cameras'.
    network.controls.feedbackDelay = 300;
    const f = fixture({}, { ...s.options, control: { ...s.options!.control, feedbackWait: { baseMs: 100, perCameraMs: 500, maxMs: 2000 } } }, s.f.records);
    const run = (command: string, cameraNumber?: number) => f.instance.execute(command, { controllerId: s.ids[0]!, ...(cameraNumber === undefined ? {} : { cameraNumber }) }, f.execution());
    try {
      await f.instance.start();
      await eventually(() => object(cameraControl(f).cameras)[s.plan.cameras[1]!.id]?.recording === 'stopped');
      await run('toggle-camera-enabled', 1);
      assert.equal((await run('roll-enabled-cameras')).status, 'failure', 'One camera, 100 ms');
      await delay(350);
      network.send('unit/a/camhead/status/volatile/recording', '0');
      network.send('unit/b/camhead/status/volatile/recording', '0');
      await run('toggle-camera-enabled', 2);
      await eventually(() => [0, 1].every(index => object(cameraControl(f).cameras)[s.plan.cameras[index]!.id]?.recording === 'stopped'));
      assert.equal((await run('roll-enabled-cameras')).status, 'success', 'Two cameras, 600 ms');
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('a camera that isn\u2019t connected is sent nothing, on any command, and the others in the press still go', async () => {
  const s = await fleet();
  try {
    const live = () => object(cameraControl(s.f).cameras), network = s.networks[0]!, [wide, tight] = s.plan.cameras;
    const sent = () => network.commands.map(command => [command.topic, command.value]);
    await eventually(() => live()[wide!.id]?.online === true && live()[tight!.id]?.online === true);
    network.send('unit/a/camhead/status/persist/gain_mode', 'Native');
    network.send('unit/a/camhead/status/persist/model', 'Venice');
    network.send('unit/a/camhead/status/volatile/control', 'offline');
    await eventually(() => live()[wide!.id]?.online === false);
    await s.run('toggle-camera-enabled', 0, 1);
    for (const command of ['roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras', 'nd-up-enabled-cameras', 'iso-down-enabled-cameras',
      'base-gain-up-enabled-cameras', 'save-white-balance-preset-enabled-cameras'] as const) {
      const result = await s.run(command);
      assert.equal(result.status, 'failure', command);
      if (result.status === 'failure') assert.match(result.message, /isn.t connected, so nothing was sent/, command);
    }
    assert.equal((await s.run('record-camera', 0, 1)).status, 'failure');
    assert.deepEqual(sent(), [], 'Nothing reached a camera that isn\u2019t connected');
    // A toggle-only camera that isn't connected can't be stopped by mistake.
    await s.run('toggle-camera-enabled', 0, 2);
    assert.equal((await s.run('roll-enabled-cameras')).status, 'failure');
    assert.deepEqual(sent(), [['unit/b/camhead/action/set/keyboard', 'RecToggle']], 'The connected camera still went');
    network.commands.length = 0;
    network.send('unit/b/camhead/status/volatile/control', 'offline');
    await eventually(() => live()[tight!.id]?.online === false);
    assert.equal((await s.run('stop-enabled-cameras')).status, 'failure');
    assert.deepEqual(sent(), []);
    // A camera that has never said it's connected counts as not connected.
    network.send('unit/c/camhead/status/persist/number', '3');
    s.plan.cameras.push({ ...wide!, id: 'quiet', elementKey: 'c', number: '3' }); await s.save();
    s.a.config.Camera.c = { Number: '3', Name: 'Quiet', Model: 'Sony - Venice-IP' };
    await eventually(() => live().quiet?.online === null);
    assert.equal((await s.run('record-camera', 0, 3)).status, 'failure');
    assert.deepEqual(sent(), []);
    // The panel works the same way.
    network.send('unit/RCP/rcp_helper/status/volatile/control', 'offline');
    await delay(20);
    assert.equal((await s.run('select-camera', 0, 1)).status, 'failure');
    assert.deepEqual(sent(), []);
    // When a camera comes back, commands go again. Nothing was held to replay.
    network.send('unit/a/camhead/status/volatile/control', 'online');
    await eventually(() => live()[wide!.id]?.online === true);
    assert.deepEqual(sent(), []);
  } finally { await s.close(); }
});

test('a connected camera that has not reported its state still gets a switch command, and a toggle-only one waits', async () => {
  const s = await fleet();
  try {
    await s.f.instance.dispose();
    const network = s.networks[0]!;
    network.controls.initialRecording = null;
    network.controls.feedback = false;
    const f = fixture({}, s.options, s.f.records), live = () => object(cameraControl(f).cameras);
    const run = (command: string, cameraNumber?: number) => f.instance.execute(command, { controllerId: s.ids[0]!, ...(cameraNumber === undefined ? {} : { cameraNumber }) }, f.execution());
    try {
      await f.instance.start();
      const [wide, tight] = s.plan.cameras;
      await eventually(() => live()[wide!.id]?.online === true && live()[tight!.id]?.online === true);
      await run('toggle-camera-enabled', 1);
      const started = Date.now();
      const start = await run('roll-enabled-cameras');
      assert.ok(start.status === 'success' && start.evidence.kind === 'response', 'Sent, and not claimed as confirmed');
      assert.ok(Date.now() - started < 5000, 'It didn\u2019t wait on a state that may never come');
      assert.deepEqual(network.commands.map(command => [command.topic, command.value]), [['unit/a/camhead/action/set/keyboard', 'Rec']]);
      await run('toggle-camera-enabled', 1); await run('toggle-camera-enabled', 2);
      network.commands.length = 0;
      assert.equal((await run('roll-enabled-cameras')).status, 'failure', 'A blind toggle could stop a rolling camera');
      assert.equal(network.commands.length, 0);
      assert.equal((await run('roll-toggle-enabled-cameras')).status, 'success', 'A toggle is what was asked for');
      assert.deepEqual(network.commands.map(command => [command.topic, command.value]), [['unit/b/camhead/action/set/keyboard', 'RecToggle']]);
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('a connected camera with a known state is checked and confirmed, and a broker that is down sends nothing later', async () => {
  const s = await fleet();
  try {
    const live = () => object(cameraControl(s.f).cameras), network = s.networks[0]!, [wide] = s.plan.cameras;
    await eventually(() => live()[wide!.id]?.online === true);
    await s.run('toggle-camera-enabled', 0, 1);
    const start = await s.run('roll-enabled-cameras');
    assert.ok(start.status === 'success' && start.evidence.kind === 'state-confirmed');
    assert.equal(live()[wide!.id]!.message, 'Confirmed by fresh camera feedback');
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.deepEqual(network.commands.map(command => command.value), ['Rec'], 'Already recording, so nothing more to send');
    await s.f.instance.dispose();
    const f = fixture({}, s.options, s.f.records);
    try {
      network.controls.silent = true;
      await f.instance.start();
      const count = network.commands.length;
      const refused = await f.instance.execute('stop-enabled-cameras', { controllerId: s.ids[0]! }, f.execution());
      assert.equal(refused.status, 'failure', 'Nothing can be sent without the broker');
      network.controls.silent = false;
      await eventually(() => cameraControl(f).controllers?.[s.ids[0]!] === true, 800);
      await delay(50);
      assert.equal(network.commands.length, count, 'Commands are never replayed');
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('Record Group ALL is gone, and a row that has it saved sends nothing', async () => {
  const s = await fleet();
  try {
    assert.equal(commands.some(([id]) => String(id) === 'record-group-all'), false);
    assert.equal(manifest.actions.some(action => action.id === 'record-group-all'), false);
    const page = await s.f.instance.discoverChoices!({ version: 2, provider: 'control-actions', draft: {}, search: '', cursor: null, limit: 128, requestRevision: 1 }, { signal: s.f.signal });
    assert.equal(page.choices.some(choice => choice.id === 'record-group-all'), false);
    assert.throws(() => parseModuleMatrixValue(matrix.fields.find(field => field.id === 'actionType')!, 'record-group-all'));
    const result = await s.f.instance.execute('camera-control', { values: { actionType: 'record-group-all', 'module.controllerId': s.ids[0]! } }, s.f.execution());
    assert.equal(result.status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 0);
  } finally { await s.close(); }
});

test('a failed press does not stop the next press on that controller', async () => {
  const s = await fleet();
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    s.verifyDelays.push(new Error('Simulated controller offline'));
    const results = await Promise.all([s.run('roll-enabled-cameras'), s.run('roll-enabled-cameras')]);
    assert.deepEqual(results.map(result => result.status), ['failure', 'success'], JSON.stringify(results));
    assert.deepEqual(s.networks[0]!.commands.map(command => command.value), ['Rec']);
  } finally { await s.close(); }
});

test('a press cancelled while waiting its turn sends nothing', async () => {
  const s = await fleet();
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    s.verifyDelays.push(200);
    const abort = new AbortController();
    const first = s.run('roll-enabled-cameras'), second = s.run('stop-enabled-cameras', 0, undefined, abort.signal);
    await delay(20); abort.abort();
    assert.equal((await first).status, 'success');
    assert.equal((await second).status, 'failure');
    await delay(30);
    assert.deepEqual(s.networks[0]!.commands.map(command => command.value), ['Rec']);
  } finally { await s.close(); }
});

test('a tick made just before a press counts, and one made just after it does not', async () => {
  const s = await fleet();
  try {
    // The tick starts first but finishes reading the plan last.
    s.f.slowNextRead(s.f.repository.root, 100);
    const [tick, press] = await Promise.all([s.run('toggle-camera-enabled', 0, 1), s.run('roll-enabled-cameras')]);
    assert.equal(tick.status, 'success');
    assert.equal(press.status, 'success', JSON.stringify(press));
    assert.deepEqual(s.networks[0]!.commands.map(command => [command.topic, command.value]), [['unit/a/camhead/action/set/keyboard', 'Rec']]);
    // The press is still checking the controller when the later tick lands.
    s.verifyDelays.push(150);
    const [stop] = await Promise.all([s.run('stop-enabled-cameras'), s.run('toggle-camera-enabled', 0, 2)]);
    assert.equal(stop.status, 'success', JSON.stringify(stop));
    assert.deepEqual(s.networks[0]!.commands.map(command => [command.topic, command.value]), [
      ['unit/a/camhead/action/set/keyboard', 'Rec'], ['unit/a/camhead/action/set/keyboard', 'Stop'],
    ]);
  } finally { await s.close(); }
});

test('a press that counted a tick whose save fails sends nothing, even if it is still waiting behind another press', async () => {
  const s = await fleet(); let release = () => {};
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    s.verifyDelays.push(150);
    // Holds this controller's queue, so the next press hasn't started checking when the tick fails.
    const slow = s.run('nd-up-enabled-cameras');
    await delay(20);
    release = s.f.holdWrites('camera-control');
    const tick = s.run('toggle-camera-enabled', 0, 2);
    await eventually(() => object(object(s.f.states.at(-1)).values?.cameraControl).enabled?.[s.plan.cameras[1]!.id] === true);
    const press = s.run('nd-down-enabled-cameras');
    await delay(20);
    s.f.failNextWrite('camera-control'); release();
    assert.equal((await tick).status, 'failure');
    assert.equal((await slow).status, 'success');
    assert.equal((await press).status, 'failure');
    assert.deepEqual(s.networks[0]!.commands.map(command => command.topic), ['unit/a/camhead/action/next/nd_filter']);
  } finally { release(); await s.close(); }
});

test('a tick made after a press, whose save fails, does not stop that press', async () => {
  const s = await fleet(); let release = () => {};
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    s.verifyDelays.push(150);
    const press = s.run('nd-up-enabled-cameras');
    await delay(20);
    release = s.f.holdWrites('camera-control');
    const tick = s.run('toggle-camera-enabled', 0, 2);
    await eventually(() => object(object(s.f.states.at(-1)).values?.cameraControl).enabled?.[s.plan.cameras[1]!.id] === true);
    s.f.failNextWrite('camera-control'); release();
    assert.equal((await tick).status, 'failure');
    assert.equal((await press).status, 'success');
    assert.deepEqual(s.networks[0]!.commands.map(command => command.topic), ['unit/a/camhead/action/next/nd_filter']);
  } finally { release(); await s.close(); }
});

test('page edits apply in the order they were made, even if the first is slow to start', async () => {
  const s = await fleet();
  try {
    const controllerId = s.ids[0]!;
    s.f.slowNextRead(s.f.repository.root, 100);
    await Promise.all([
      s.f.call('camera-control-mutate', { requestId: 'first', mutations: [{ kind: 'all', controllerId, enabled: true }] }),
      s.f.call('camera-control-mutate', { requestId: 'second', mutations: [{ kind: 'single', controllerId, enabled: true }] }),
    ]);
    const state = await s.state();
    assert.equal(state.singleSwitch[controllerId], true);
    assert.deepEqual(s.plan.cameras.slice(0, 2).map(row => !!state.enabled[row.id]), [true, false]);
  } finally { await s.close(); }
});

test('Enable All from the page says which way it goes, so a repeat keeps the result and a button still toggles', async () => {
  const s = await fleet();
  try {
    const controllerId = s.ids[0]!, flags = async () => { const { enabled } = await s.state(); return s.plan.cameras.slice(0, 2).map(row => !!enabled[row.id]); };
    const all = (requestId: string, enabled: unknown) => s.f.call('camera-control-mutate', { requestId, mutations: [{ kind: 'all', controllerId, enabled }] });
    await all('on', true); await all('on-again', true);
    assert.deepEqual(await flags(), [true, true]);
    await all('off', false); await all('off-again', false);
    assert.deepEqual(await flags(), [false, false]);
    await assert.rejects(all('invalid', 'yes'), /Enable All/);
    assert.equal((await s.run('enable-all-cameras')).status, 'success');
    assert.deepEqual(await flags(), [true, true]);
    assert.equal((await s.run('enable-all-cameras')).status, 'success');
    assert.deepEqual(await flags(), [false, false]);
  } finally { await s.close(); }
});

test('each camera shows recording state and last result without being ticked, and watching sends nothing', async () => {
  const s = await fleet();
  try {
    const [wide, tight, otherController] = s.plan.cameras;
    const live = () => object(object(object(s.f.states.at(-1)).values?.cameraControl).cameras);
    assert.equal(s.sessions.length, 2, 'One connection for each RCP and RIO, with nothing ticked');
    await eventually(() => live()[wide!.id]?.recording === 'stopped');
    assert.deepEqual(live()[wide!.id], { recording: 'stopped', available: true, message: 'Ready', online: true });
    assert.deepEqual(live()[tight!.id], { recording: 'stopped', available: true, message: 'Ready', online: true });
    await eventually(() => live()[otherController!.id]?.online === true);
    await s.run('toggle-camera-enabled', 0, 1);
    s.networks[0]!.send('unit/b/camhead/status/volatile/recording', '1');
    await eventually(() => live()[tight!.id]?.recording === 'recording');
    assert.equal(s.networks[0]!.commands.length, 0);
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.deepEqual(live()[wide!.id], { recording: 'recording', available: true, message: 'Confirmed by fresh camera feedback', online: true });
    assert.equal((await s.run('roll-enabled-cameras')).status, 'success');
    assert.equal(live()[wide!.id]?.message, 'Camera is already recording');
    s.networks[0]!.send('unit/a/camhead/status/volatile/rec_lock', '1');
    await eventually(() => live()[wide!.id]?.message === 'Recording locked');
    s.networks[0]!.send('unit/a/camhead/status/volatile/control', 'offline');
    await eventually(() => live()[wide!.id]?.available === false);
    assert.deepEqual(live()[wide!.id], { recording: 'unknown', available: false, message: 'Camera offline', online: false });
    s.networks[0]!.disconnect();
    await eventually(() => live()[tight!.id]?.available === false);
    assert.equal(live()[tight!.id]?.recording, 'unknown');
    assert.deepEqual(s.networks[0]!.commands.map(command => command.value), ['Rec']);
  } finally { await s.close(); }
});

test('a failed press shows on the cameras it targeted, and a sent command shows while it waits', async () => {
  const s = await fleet();
  try {
    const [wide] = s.plan.cameras;
    const live = () => object(object(object(s.f.states.at(-1)).values?.cameraControl).cameras);
    await s.run('toggle-camera-enabled', 0, 1);
    await eventually(() => live()[wide!.id]?.recording === 'stopped');
    s.a.config.Product.Serial = 'CY-RCP-WRONG';
    assert.equal((await s.run('roll-enabled-cameras')).status, 'failure');
    assert.match(String(live()[wide!.id]?.message), /Controller identity changed/);
    s.a.config.Product.Serial = 'CY-RCP-1-10';
    s.networks[0]!.controls.feedbackDelay = 200;
    const press = s.run('roll-enabled-cameras');
    await eventually(() => live()[wide!.id]?.message === 'Sending…');
    assert.equal((await press).status, 'success');
    assert.equal(live()[wide!.id]?.message, 'Confirmed by fresh camera feedback');
    // A renumbered camera no longer inherits the old camera's result.
    s.plan.cameras[0]!.number = '2'; s.plan.cameras[0]!.dirty = ['number']; await s.save();
    await eventually(() => live()[wide!.id]?.available === false);
    assert.match(String(live()[wide!.id]?.message), /Send this camera/);
  } finally { await s.close(); }
});

test('camera traffic that changes nothing publishes nothing, and a real change publishes once', async () => {
  const s = await fleet();
  try {
    const [wide] = s.plan.cameras;
    const fields = { actionId: 'row-one', actionColumnId: 'column-one', values: { enabled: true, actionType: 'roll-enabled-cameras',
      'module.controllerId': s.ids[0]!, 'module.feedbackEnabled': true, 'module.feedbackColor': '#333333 | #00FF00' } };
    await s.f.instance.subscribeFeedback!([{ id: 'camera-control', fields }], { signal: s.f.signal });
    await s.run('toggle-camera-enabled', 0, 1);
    const live = () => object(object(object(s.f.states.at(-1)).values?.cameraControl).cameras);
    await eventually(() => live()[wide!.id]?.recording === 'stopped');
    await delay(30);
    const states = s.f.states.length, feedback = s.f.feedback.length;
    for (let index = 0; index < 20; index++) s.networks[0]!.send('unit/a/camhead/status/volatile/recording', '0');
    await delay(40);
    assert.equal(s.f.states.length, states);
    assert.equal(s.f.feedback.length, feedback);
    s.networks[0]!.send('unit/a/camhead/status/volatile/recording', '1');
    await eventually(() => live()[wide!.id]?.recording === 'recording');
    await delay(30);
    assert.equal(s.f.states.length, states + 1);
    assert.equal(s.f.feedback.length, feedback + 1);
    assert.equal(object(s.f.feedback.at(-1)).state, 'active');
    // A new subscription always gets its first state, even when nothing changed.
    await s.f.instance.subscribeFeedback!([{ id: 'camera-control', fields }], { signal: s.f.signal });
    assert.equal(s.f.feedback.length, feedback + 2);
  } finally { await s.close(); }
});

test('a worker restart is recognisable, so an open page accepts its first state', async () => {
  const s = await fleet();
  try {
    const before = await s.state();
    await s.run('toggle-camera-enabled', 0, 1);
    await s.run('toggle-camera-enabled', 0, 1);
    const restored = fixture({}, {}, new Map(structuredClone([...s.f.records])));
    try {
      await restored.instance.start();
      const after = await restored.call('camera-control-state');
      assert.equal(typeof after.epoch, 'string');
      assert.notEqual(after.epoch, before.epoch);
    } finally { await restored.instance.dispose(); }
  } finally { await s.close(); }
});

// What the page is told about one controller over a worker's life, in order and without repeats.
const controllerHistory = (f: ReturnType<typeof fixture>, id: string) => {
  const history: unknown[] = [];
  for (const state of f.states) {
    const value = object(object(object(state).values).cameraControl).controllers?.[id];
    if (value !== undefined && history.at(-1) !== value) history.push(value);
  }
  return history;
};
const cameraControl = (f: ReturnType<typeof fixture>) => object(object(object(f.states.at(-1)).values).cameraControl);

test('after a worker restart nothing reads Offline before it has been tried, and saved status does not come back', async () => {
  const s = await fleet();
  try {
    // What an old page saved, in both directions.
    s.plan.devices[0]!.online = true; s.plan.devices[1]!.online = false;
    s.plan.cameras[0]!.online = true; s.plan.cameras[1]!.online = false;
    await s.save();
    await s.f.instance.dispose();
    const opened = [s.a.opened, s.b.opened];
    // The attempts stay out, because the brokers accept the connection and don't answer.
    for (const network of s.networks) network.controls.silent = true;
    const f = fixture({}, s.options, s.f.records);
    try {
      await f.instance.start();
      assert.ok(f.states.length > 0);
      for (const state of f.states) assert.deepEqual(object(state).values?.observations, {});
      assert.deepEqual(Object.values(cameraControl(f).controllers), [null, null]);
      assert.ok(Object.values(object(cameraControl(f).cameras)).every(row => object(row).online === null));
      const { plan } = await f.call('read-plan');
      assert.ok(plan.devices.length && plan.cameras.length);
      for (const row of [...plan.devices, ...plan.cameras]) assert.equal(row.online, null);
      assert.deepEqual([s.a.opened, s.b.opened], opened, 'No WebSocket');
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('sample data keeps the status its rows were saved with', async () => {
  const s = await fleet();
  const f = fixture({ sampleData: true }, s.options);
  try {
    await f.instance.start();
    s.plan.devices[0]!.online = true; s.plan.devices[1]!.online = false;
    await f.call('save-plan', { revision: null, plan: s.plan });
    const { plan } = await f.call('read-plan');
    assert.deepEqual(plan.devices.map((device: { online: unknown }) => device.online), [true, false]);
  } finally { await f.instance.dispose(); await s.close(); }
});

test('after a worker restart every RCP and RIO answers by itself over MQTT, with nothing ticked', async () => {
  const s = await fleet();
  try {
    await s.f.instance.dispose();
    const opened = [s.a.opened, s.b.opened];
    const f = fixture({}, s.options, s.f.records);
    try {
      await f.instance.start();
      const [wide, tight, other] = s.plan.cameras;
      await eventually(() => [wide, tight, other].every(row => cameraControl(f).cameras?.[row!.id]?.online === true));
      assert.deepEqual(cameraControl(f).cameras[wide!.id], { recording: 'stopped', available: true, message: 'Ready', online: true });
      assert.deepEqual(controllerHistory(f, s.ids[0]!), [null, true], 'Never Offline on the way up');
      assert.deepEqual(controllerHistory(f, s.ids[1]!), [null, true]);
      assert.deepEqual([s.a.opened, s.b.opened], opened, 'No WebSocket');
      assert.equal(s.networks[0]!.commands.length, 0, 'Watching sends nothing');
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('a controller reads Offline only once a connection has failed, and a reconnect goes straight back', async () => {
  const s = await fleet();
  try {
    const [wide] = s.plan.cameras, id = s.ids[0]!;
    await s.f.instance.dispose();
    s.networks[0]!.controls.silent = true;
    const f = fixture({}, s.options, s.f.records);
    const live = () => cameraControl(f);
    try {
      await f.instance.start();
      assert.equal(live().controllers[id], null, 'An attempt still out is not an answer');
      assert.equal(live().cameras[wide!.id].online, null);
      assert.equal(live().cameras[wide!.id].message, 'Connecting to the controller');
      await eventually(() => live().controllers[id] === false);
      assert.equal(live().cameras[wide!.id].online, null, 'The camera itself has not reported');
      assert.equal(live().cameras[wide!.id].message, 'CyanView RCP connection timed out');
      s.networks[0]!.controls.silent = false;
      await eventually(() => live().controllers[id] === true, 800);
      await eventually(() => live().cameras[wide!.id].online === true);
      s.networks[0]!.disconnect();
      await eventually(() => live().controllers[id] === false);
      await eventually(() => live().controllers[id] === true, 800);
      assert.deepEqual(controllerHistory(f, id), [null, false, true, false, true]);
      assert.equal(s.networks[0]!.commands.length, 0);
    } finally { await f.instance.dispose(); }
  } finally { await s.close(); }
});

test('a camera reads online or offline only from what it has reported', async () => {
  const s = await fleet();
  try {
    const base = s.plan.cameras[0]!, live = () => object(cameraControl(s.f).cameras);
    s.plan.cameras.push({ ...base, id: 'quiet', elementKey: 'c', number: '3' }, { ...base, id: 'absent', elementKey: 'd', number: '9' },
      { ...base, id: 'staged', elementKey: 'e', number: '4', dirty: ['number'] });
    await s.save();
    await eventually(() => live()[base.id]?.online === true);
    s.networks[0]!.send('unit/c/camhead/status/persist/number', '3');
    await eventually(() => live().quiet?.message === 'Waiting for camera status');
    assert.deepEqual(live().quiet, { recording: 'unknown', available: false, message: 'Waiting for camera status', online: null });
    assert.equal(live().absent.online, null);
    assert.equal(live().absent.message, 'Camera number was not found on this RCP');
    assert.equal(live().staged.online, null);
    s.networks[0]!.send('unit/c/camhead/status/volatile/control', 'online');
    await eventually(() => live().quiet?.online === true);
    s.networks[0]!.send('unit/c/camhead/status/volatile/control', 'offline');
    await eventually(() => live().quiet?.online === false);
    assert.equal(live().quiet.message, 'Camera offline');
  } finally { await s.close(); }
});

test('a camera that reports slowly still confirms, because the status wait matches CCC', async () => {
  const s = await fleet();
  try {
    s.networks[0]!.controls.feedbackDelay = 3500;
    const result = await s.run('record-camera', 0, 1);
    assert.equal(result.status, 'success', JSON.stringify(result));
    if (result.status === 'success') assert.equal(result.evidence.kind, 'state-confirmed');
    assert.equal(s.networks[0]!.commands.length, 1);
  } finally { await s.close(); }
});

test('presses on one controller act in press order even if their checks finish out of order', async () => {
  const s = await fleet();
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    s.verifyDelays.push(200, 0);
    const results = await Promise.all([s.run('roll-enabled-cameras'), s.run('stop-enabled-cameras')]);
    assert.deepEqual(results.map(result => result.status), ['success', 'success'], JSON.stringify(results));
    assert.deepEqual(s.networks[0]!.commands.map(command => command.value), ['Rec', 'Stop']);
  } finally { await s.close(); }
});

test('a slow check on one controller holds up neither ticks nor another controller', async () => {
  const s = await fleet();
  try {
    await s.run('toggle-camera-enabled', 0, 1);
    await s.run('toggle-camera-enabled', 1, 1);
    s.verifyDelays.push(400);
    const slow = s.run('roll-enabled-cameras', 0);
    await delay(20);
    const started = Date.now();
    assert.equal((await s.run('toggle-camera-enabled', 0, 2)).status, 'success');
    assert.equal((await s.run('nd-up-enabled-cameras', 1)).status, 'success');
    assert.ok(Date.now() - started < 300, 'Expected no wait on the slow controller');
    assert.equal(s.networks[0]!.commands.length, 0);
    assert.equal((await slow).status, 'success');
  } finally { await s.close(); }
});

test('exposure commands retain variable ND, ISO, reported Base Gain and exact VENICE preset payloads', async () => {
  const s = await fleet();
  try {
    s.networks[0]!.controls.variableNd = true;
    await s.run('toggle-camera-enabled', 0, 1);
    assert.equal((await s.run('nd-up-enabled-cameras')).status, 'success');
    assert.equal((await s.run('nd-down-enabled-cameras')).status, 'success');
    assert.equal((await s.run('iso-up-enabled-cameras')).status, 'success');
    assert.equal((await s.run('iso-down-enabled-cameras')).status, 'success');
    assert.equal((await s.run('base-gain-up-enabled-cameras')).status, 'failure');
    s.networks[0]!.send('unit/a/camhead/status/persist/gain_mode', '3200');
    s.networks[0]!.send('unit/a/camhead/status/persist/model', 'Sony Venice'); await delay(20);
    assert.equal((await s.run('base-gain-up-enabled-cameras')).status, 'success');
    assert.equal((await s.run('base-gain-down-enabled-cameras')).status, 'success');
    assert.equal((await s.run('save-white-balance-preset-enabled-cameras')).status, 'success');
    assert.deepEqual(s.networks[0]!.commands.map(command => [command.topic, command.value]), [
      ['unit/a/camhead/action/mult/nd_filter', '2'], ['unit/a/camhead/action/mult/nd_filter', '0.5'],
      ['unit/a/camhead/action/next/master_gain', ''], ['unit/a/camhead/action/prev/master_gain', ''],
      ['unit/a/camhead/action/next/gain_mode', ''], ['unit/a/camhead/action/prev/gain_mode', ''],
      ['unit/a/camhead/action/set/keyboard', 'addWB'],
    ]);
    assert.ok(s.networks[0]!.commands.every(command => command.header === 0x32));
  } finally { await s.close(); }
});

test('Matrix execution and feedback use the same quick group and clear device feedback on disconnect', async () => {
  const s = await fleet();
  try {
    const fields = { actionId: 'row-one', actionColumnId: 'column-one', values: { enabled: true, actionType: 'toggle-camera-enabled',
      'module.controllerId': s.ids[0]!, 'module.cameraNumber': 1, 'module.feedbackEnabled': true, 'module.feedbackColor': '#333333 | #00FF00' } };
    await s.f.instance.subscribeFeedback!([{ id: 'camera-control', fields }], { signal: s.f.signal });
    assert.equal((await s.f.instance.execute('camera-control', fields, s.f.execution())).status, 'success');
    assert.equal(object(s.f.feedback.at(-1)).state, 'active');
    assert.equal(object(s.f.feedback.at(-1)).appearance?.backgroundColor, '#00FF00');
    const route = { ...fields, values: { ...fields.values, actionType: 'select-camera' } };
    await s.f.instance.subscribeFeedback!([{ id: 'camera-control', fields: route }], { signal: s.f.signal });
    await eventually(() => s.sessions[0]?.snapshot().phase === 'ready');
    s.networks[0]!.send('unit/RCP/rcp/status/volatile/active_camera', 'a');
    await eventually(() => object(s.f.feedback.at(-1)).state === 'active');
    s.plan.devices[0]!.address='10.20.101.200';await s.save();
    await eventually(()=>s.sessions.at(-1)!.definition.host==='10.20.101.200'&&s.sessions.at(-1)!.snapshot().phase==='ready');
    s.networks[0]!.send('unit/RCP/rcp/status/volatile/active_camera','a');
    await eventually(()=>object(s.f.feedback.at(-1)).state==='active');
    s.networks[0]!.disconnect();
    await eventually(() => object(s.f.feedback.at(-1)).state === 'unavailable');
    assert.equal(object(s.f.feedback.at(-1)).appearance?.backgroundColor, null);
  } finally { await s.close(); }
});

test('cancelled recording is not replayed and controller removal invalidates named targets', async () => {
  const s = await fleet();
  try {
    s.networks[0]!.controls.feedback = false;
    const abort = new AbortController();
    const recording = s.run('record-camera', 0, 1, abort.signal);
    await eventually(() => s.networks[0]!.commands.length === 1); abort.abort();
    assert.equal((await recording).status, 'failure');
    await delay(50); assert.equal(s.networks[0]!.commands.length, 1);
    s.plan.devices.splice(0, 1); s.plan.cameras.splice(0, 2); await s.save();
    assert.equal((await s.run('select-camera', 0, 1)).status, 'failure');
    assert.equal(s.networks[0]!.commands.length, 1);
  } finally { await s.close(); }
});

test('a command sent without a known state means the old state is not trusted until the camera reports again', async () => {
  const observation = { address: 'unit/a', number: 1, name: 'Wide', online: true, recording: null as boolean | null, recordingLocked: false,
    recordingSequence: 5, variableNd: false, baseGain: null, model: 'Sony Venice', recordMode: 'rec-stop' as const, persistentLock: false, volatileLock: false };
  const target = { address: 'unit/a', generation: 1, observation };
  const sent: string[] = [];
  const coordinator = new RecordingCoordinator({ feedbackTimeoutMs: 100 });
  try {
    const result = await coordinator.record({ key: 'camera', target, session: { observeTarget: () => observation, async sendCameraCommand(_, command) { sent.push(command); } } }, 'start');
    assert.equal(result.evidence, 'delivered'); assert.deepEqual(sent, ['Rec']);
    assert.equal(coordinator.isUncertain('camera'), true);
    observation.recording = false;
    assert.equal(coordinator.usableObservation('camera', target, observation), false, 'The state it had before the command proves nothing');
    observation.recordingSequence++;
    assert.equal(coordinator.usableObservation('camera', target, observation), true);
    assert.equal(coordinator.isUncertain('camera'), false);
  } finally { await coordinator.dispose(); }
});

test('after an unclean stop, old state is not trusted: explicit commands still go out, and a toggle waits for a fresh report', async () => {
  const camera = (recordMode: 'rec-stop' | 'toggle') => {
    const observation = { address: 'unit/a', number: 1, name: 'Wide', online: true, recording: false, recordingLocked: false,
      recordingSequence: 0, variableNd: false, baseGain: null, model: 'Sony Venice', recordMode, persistentLock: false, volatileLock: false };
    const sent: string[] = [];
    return { observation, sent, target: { key: 'camera', target: { address: 'unit/a', generation: 1, observation }, session: {
      observeTarget: () => observation,
      async sendCameraCommand(_: unknown, command: string) { sent.push(command); observation.recording = true; observation.recordingSequence++; },
    } } };
  };
  const coordinator = () => new RecordingCoordinator({ feedbackTimeoutMs: 100, recovery: 'unclean', checkpoint: { uncertain: ['camera'] } });
  const explicit = camera('rec-stop'), first = coordinator();
  try {
    const result = await first.record(explicit.target, 'start');
    assert.equal(result.outcome, 'success'); assert.equal(result.evidence, 'delivered');
    assert.deepEqual(explicit.sent, ['Rec']);
  } finally { await first.dispose(); }
  const toggle = camera('toggle'), second = coordinator();
  try {
    assert.equal((await second.record(toggle.target, 'start')).outcome, 'failure'); assert.deepEqual(toggle.sent, []);
    toggle.observation.recordingSequence++;
    assert.equal((await second.record(toggle.target, 'start')).outcome, 'success'); assert.deepEqual(toggle.sent, ['RecToggle']);
  } finally { await second.dispose(); }
});
