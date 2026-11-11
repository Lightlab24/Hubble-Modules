import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeController, FakeRemiFleet, fixture } from './helpers.js';
import { object } from '../src/model.js';
import type { SocketFactory } from '../src/transport.js';

async function setup() {
  const rio = new FakeController(), master = new FakeController(), leaf = new FakeController();
  const devices = [rio,master,leaf], addresses = ['10.192.1.10','10.192.1.20','10.192.1.30'];
  for (const [index, device] of devices.entries()) {
    device.config.IP.protected.IP = addresses[index];
    device.config.IP.old.IP = '10.20.101.' + (200+index);
    if (index) device.config.Product = { Serial: 'CY-RCP-1-'+(10+index*10), Name:'RCP', MaxCam:'unlimited' };
  }
  rio.config.Camera.original = { Number:'1', Name:'Wide', Model:'Sony - Venice-IP', IP:'10.20.20.1', Port:'80' };
  rio.config.Camera.second = { Number:'2', Name:'Close', Model:'Sony - Venice-IP', IP:'10.20.20.2', Port:'80' };
  const fleet = new FakeRemiFleet(devices);
  await Promise.all(devices.map(device=>device.start()));
  const snapshots = devices.map((device,index)=>device.snapshot(addresses[index]));
  const [source, receiver, downstream] = snapshots.map(snapshot=>snapshot.device.id) as [string,string,string];
  const socket: SocketFactory = (url,options) => fleet.deviceAt(new URL(url).hostname)!.socket(url,options);
  const options = { client:fleet.client,socket };
  const session = fixture({},options);
  await session.instance.start();
  const plan = { formatVersion:1, devices:snapshots.map(snapshot=>snapshot.device), cameras:snapshots.flatMap(snapshot=>snapshot.cameras), lans:[], uiState:null };
  await session.call('save-plan',{revision:null,plan});
  const assignment = (to:string, from:string, key:string, extra = {}) => session.call('remi-send',{receiver:to,
    items:[{id:key,kind:'camera',source:from,key,enable:true,...extra}]});
  const camera = { ...plan.cameras.find(row=>row.elementKey==='original')! };
  const rename = (name:string) => session.call('send',{kind:'camera',item:{...camera,name},fields:['name']});
  const renumber = (number:string) => session.call('send',{kind:'camera',item:{...camera,number},fields:['number']});
  const close = async () => { await session.instance.dispose(); await Promise.all(devices.map(device=>device.close())); };
  return { rio,master,leaf,fleet,session,source,receiver,downstream,assignment,rename,renumber,close,options };
}

test('REMI adds cameras using one manual connection and refreshes existing copies through an RCP chain', async () => {
  const s = await setup();
  try {
    const initial = await s.session.call('remi-state',{receiver:s.receiver,source:s.source});
    assert.deepEqual(initial.cameras.map((row: { assigned: boolean })=>row.assigned),[false,false]);
    const added = await s.session.call('remi-send',{receiver:s.receiver,items:['original','second'].map(key=>({
      id:key,kind:'camera',source:s.source,key,enable:true,address:'10.20.101.200',
    }))});
    assert.equal(added.results.every((row: { verified: boolean })=>row.verified),true);
    assert.deepEqual(s.master.actions.filter(row=>row.new).map(row=>row.new),[['CyElement.SessionImporter','10.20.101.200']]);
    const imported = Object.keys(s.master.config.Camera);
    assert.equal(imported.length,2);
    const wide = imported.find(key=>s.master.config.Camera[key].Name==='Wide')!;
    const untouched = imported.find(key=>s.master.config.Camera[key].Name==='Close')!;
    const attached = await s.assignment(s.downstream,s.receiver,wide);
    assert.equal(attached.results[0].verified,true);
    assert.deepEqual(attached.snapshot.cameras[0].remi.origin,{serial:s.source,model:'Venice-IP'});
    const leafBefore = Object.keys(s.leaf.config.Camera)[0]!;
    // Discover a chain that existed before the module stored assignment receipts.
    const store = await s.session.repository.readRemi(s.session.signal);
    store.data.links = [];
    await s.session.repository.writeRemi(store,s.session.signal);
    const refreshed = await s.session.call('refresh');
    // The page saves what a Refresh all brings back, and that record is what a rename goes by.
    const read = await s.session.repository.read(s.session.signal);
    await s.session.call('save-plan',{revision:read.revision,plan:{...read.plan,cameras:refreshed.snapshots.flatMap((snapshot: { cameras: unknown[] })=>snapshot.cameras)}});
    for (const id of [s.receiver,s.downstream]) {
      const copy = refreshed.snapshots.find((snapshot: { device: { id: string } })=>snapshot.device.id===id).cameras[0];
      assert.deepEqual(copy.remi.origin,{serial:s.source,model:'Venice-IP'});
    }

    s.fleet.writes.length = 0;
    const changed = await s.rename('Wide renamed');
    assert.equal(changed.verified,true);
    assert.equal(changed.remiError,undefined);
    assert.equal(changed.remiRefresh,true);
    assert.equal(s.master.config.Camera[wide],undefined);
    assert.equal(s.master.config.Camera[untouched].Name,'Close');
    assert.equal(s.leaf.config.Camera[leafBefore],undefined);
    const wideAfter = Object.keys(s.master.config.Camera).find(key=>s.master.config.Camera[key].Name==='Wide renamed')!;
    assert.ok(wideAfter);
    assert.deepEqual(Object.values(object(s.leaf.config.Camera)).map(row=>row.Name),['Wide renamed']);
    assert.deepEqual(s.fleet.writes,[
      {device:s.downstream,enable:'0',sourceKey:wide},
      {device:s.receiver,enable:'0',sourceKey:'original'},
      {device:s.receiver,enable:'1',sourceKey:'original'},
      {device:s.downstream,enable:'1',sourceKey:wideAfter},
    ]);
    s.fleet.writes.length = 0;
    await s.rename('Wide renamed');
    assert.deepEqual(s.fleet.writes,[]);
    assert.equal((await s.renumber('9')).remiError,undefined);
    assert.deepEqual(Object.values(object(s.leaf.config.Camera)).map(row=>[row.Number,row.Name]),[['9','Wide renamed']]);
    assert.equal(s.fleet.writes.length,4);
    const tags = await s.session.call('remi-send',{receiver:s.receiver,items:[{id:'new-tag',kind:'tag',tag:'stage',enable:true}]});
    assert.equal(tags.results[0].verified,true);
    assert.deepEqual(s.master.config.Remi.relay.Tags,['fixture-access-tag','stage']);
    assert.doesNotMatch(JSON.stringify(s.session.states),/fixture-access-tag/);
  } finally { await s.close(); }
});

test('REMI import verifies capacity before creating a link and reconciles a lost create reply', async () => {
  const s = await setup();
  try {
    const items = ['original','second'].map(key=>({ id:key,kind:'camera',source:s.source,key,enable:true }));
    s.master.config.Product.MaxCam = '1';
    await assert.rejects(()=>s.session.call('remi-send',{receiver:s.receiver,items}),/camera capacity/);
    assert.equal(s.master.actions.length,0);

    s.master.config.Product.MaxCam = 'unlimited';
    s.master.dropCreateReply = true;
    const uncertain = await s.assignment(s.receiver,s.source,'original');
    assert.match(uncertain.results[0].error,/could not confirm/i);
    assert.equal((await s.assignment(s.receiver,s.source,'original')).results[0].verified,true);
    assert.equal(s.master.actions.filter(row=>row.new).length,1);
    assert.equal(Object.keys(s.master.config.Camera).length,1);
  } finally { await s.close(); }
});

test('REMI refresh recovery survives restart and resumes from the restored upstream copy', async () => {
  const s = await setup();
  let restarted: ReturnType<typeof fixture> | undefined;
  try {
    assert.equal((await s.assignment(s.receiver,s.source,'original')).results[0].verified,true);
    const masterBefore = Object.keys(s.master.config.Camera)[0]!;
    assert.equal((await s.assignment(s.downstream,s.receiver,masterBefore)).results[0].verified,true);
    s.fleet.failEnable = s.downstream;
    s.fleet.writes.length = 0;
    const changed = await s.rename('Wide updated');
    assert.equal(changed.verified,true);
    assert.match(changed.remiError,/rejected/);
    assert.equal(s.rio.config.Camera.original.Name,'Wide updated');
    assert.equal(Object.keys(s.leaf.config.Camera).length,0);
    const masterAfter = Object.keys(s.master.config.Camera)[0]!;
    assert.notEqual(masterAfter,masterBefore);
    assert.deepEqual((await s.session.repository.readRemi(s.session.signal)).data.refreshes[0]?.steps?.map(step=>step.phase),['done','adding']);
    await assert.rejects(()=>s.rename('Another edit'),/Retry this camera/);

    await s.session.instance.dispose();
    s.fleet.failEnable = '';
    s.fleet.writes.length = 0;
    restarted = fixture({},s.options,s.session.records);
    await restarted.instance.start();
    const retry = await restarted.call('remi-send',{receiver:s.source,operation:'retry'});
    assert.equal(retry.results[0].verified,true);
    assert.equal(Object.keys(s.master.config.Camera)[0],masterAfter);
    assert.deepEqual(s.fleet.writes,[{device:s.downstream,enable:'1',sourceKey:masterAfter}]);
    assert.deepEqual(Object.values(object(s.leaf.config.Camera)).map(row=>row.Name),['Wide updated']);
    assert.deepEqual((await restarted.repository.readRemi(restarted.signal)).data.refreshes,[]);
  } finally { await restarted?.instance.dispose(); await s.close(); }
});

async function routeSetup(extra = 0) {
  const s = await setup();
  const others: FakeController[] = [];
  const ids: string[] = [];
  for (let index = 0; index < extra; index++) {
    const device = new FakeController(), suffix = 40 + index * 10;
    device.config.Product = { Serial: 'CY-RCP-1-' + suffix, Name: 'RCP', MaxCam: 'unlimited' };
    device.config.IP.protected.IP = '10.192.1.' + suffix;
    device.config.IP.old.IP = '10.20.101.' + (210 + index);
    others.push(device);
  }
  if (others.length) {
    s.fleet.adopt(others);
    await Promise.all(others.map(device => device.start()));
    const { plan, revision } = await s.session.repository.read(s.session.signal);
    const snapshots = others.map(device => device.snapshot(device.config.IP.protected.IP));
    ids.push(...snapshots.map(snapshot => snapshot.device.id as string));
    await s.session.call('save-plan', { revision, plan: { ...plan, devices: [...plan.devices, ...snapshots.map(snapshot => snapshot.device)], cameras: [...plan.cameras, ...snapshots.flatMap(snapshot => snapshot.cameras)] } });
  }
  const cameraRow = { camera: s.source, key: 'original' };
  const route = (tree: Record<string, string>, expected: Record<string, string>, extraFields = cameraRow) => s.session.call('remi-route', { items: [{ id: 'wide', ...extraFields, tree, expected }] });
  const close = async () => { await s.close(); await Promise.all(others.map(device => device.close())); };
  return { ...s, close, route, others, ids };
}
const names = (device: FakeController) => Object.values(object(device.config.Camera)).map(row => row.Name);

test('a route takes a RIO camera to a source RCP, a master, then each individual RCP', async () => {
  const s = await routeSetup(2);
  try {
    const [truck, stage] = s.ids as [string, string];
    const tree = { [s.receiver]: s.source, [s.downstream]: s.receiver, [truck]: s.downstream, [stage]: s.downstream };
    const sent = await s.route(tree, {});
    assert.equal(sent.results[0].verified, true, sent.results[0].error);
    for (const device of [s.master, s.leaf, ...s.others]) assert.deepEqual(names(device), ['Wide']);
    assert.deepEqual(s.fleet.writes.map(row => row.device), [s.receiver, s.downstream, truck, stage]);
    const onMaster = sent.snapshots.find((row: { device: { id: string } }) => row.device.id === s.downstream).cameras[0];
    const onTruck = sent.snapshots.find((row: { device: { id: string } }) => row.device.id === truck).cameras[0];
    assert.equal(onTruck.remi.sourceKey, onMaster.elementKey);

    // Asking for what is already there writes nothing.
    s.fleet.writes.length = 0;
    assert.equal((await s.route(tree, tree)).results[0].verified, true);
    assert.equal(s.fleet.writes.length, 0);

    // Dropping one individual RCP leaves the master and the others alone.
    const { [stage]: _gone, ...fewer } = tree;
    assert.equal((await s.route(fewer, tree)).results[0].verified, true);
    assert.deepEqual(names(s.others[1]!), []);
    assert.deepEqual(names(s.others[0]!), ['Wide']);
    assert.deepEqual((s.fleet.writes as { device: string; enable: string }[]).map(row => [row.device, row.enable]), [[stage, '0']]);

    // Removing everything takes the copies out, furthest first.
    s.fleet.writes.length = 0;
    assert.equal((await s.route({}, fewer)).results[0].verified, true);
    assert.deepEqual((s.fleet.writes as { device: string; enable: string }[]).map(row => row.device), [truck, s.downstream, s.receiver]);
    for (const device of [s.master, s.leaf, ...s.others]) assert.deepEqual(names(device), []);
  } finally { await s.close(); }
});

test('several first and second REMIs branch from a camera set up on an RCP', async () => {
  const s = await routeSetup(2);
  try {
    const [truck, stage] = s.ids as [string, string];
    s.master.config.Camera.jib = { Number: '7', Name: 'Jib', Model: 'Sony - Venice-IP', IP: '10.20.20.7', Port: '80' };
    s.master.broadcast();
    const jib = { camera: s.receiver, key: 'jib' };
    const tree = { [s.downstream]: s.receiver, [truck]: s.receiver, [stage]: truck };
    const sent = await s.route(tree, {}, jib);
    assert.equal(sent.results[0].verified, true, sent.results[0].error);
    assert.deepEqual(names(s.leaf), ['Jib']);
    assert.deepEqual(names(s.others[0]!), ['Jib']);
    assert.deepEqual(names(s.others[1]!), ['Jib']);
    assert.deepEqual(names(s.rio), ['Wide', 'Close']);

    // Moving a second REMI to a different first rebuilds only that copy.
    s.fleet.writes.length = 0;
    const moved = { ...tree, [stage]: s.downstream };
    assert.equal((await s.route(moved, tree, jib)).results[0].verified, true);
    assert.deepEqual((s.fleet.writes as { device: string; enable: string }[]).map(row => [row.device, row.enable]), [[stage, '0'], [stage, '1']]);
    assert.deepEqual(names(s.others[1]!), ['Jib']);
  } finally { await s.close(); }
});

test('changing the first hop rebuilds everything below it', async () => {
  const s = await routeSetup();
  try {
    assert.equal((await s.route({ [s.receiver]: s.source, [s.downstream]: s.receiver }, {})).results[0].verified, true);
    s.fleet.writes.length = 0;
    const swapped = await s.route({ [s.downstream]: s.source, [s.receiver]: s.downstream }, { [s.receiver]: s.source, [s.downstream]: s.receiver });
    assert.equal(swapped.results[0].verified, true, swapped.results[0].error);
    assert.deepEqual((s.fleet.writes as { device: string; enable: string }[]).map(row => [row.device, row.enable]), [[s.downstream, '0'], [s.receiver, '0'], [s.downstream, '1'], [s.receiver, '1']]);
    assert.deepEqual(names(s.leaf), ['Wide']);
    assert.deepEqual(names(s.master), ['Wide']);
  } finally { await s.close(); }
});

test('an unfinished refresh holds back only its own camera, and can be listed and dismissed', async () => {
  const s = await routeSetup();
  try {
    const store = await s.session.repository.readRemi(s.session.signal);
    store.data.refreshes.push({ source: s.source, camera: { key: 'original', number: '1', name: 'Renamed' }, before: { key: 'original', number: '1', name: 'Wide' },
      steps: [{ source: s.source, sourceKey: 'original', receiver: s.receiver, entry: { importer: 'i', connection: 'c', address: '10.192.1.10', manual: false, peer: 'x', connected: true, selector: 's', label: '1 Wide', localKey: 'gone', enabled: true }, parent: -1, phase: 'adding' }] } as any);
    await s.session.repository.writeRemi(store, s.session.signal);

    // The second camera on the same controllers has nothing to do with the stuck job.
    const other = await s.route({ [s.receiver]: s.source }, {}, { camera: s.source, key: 'second' });
    assert.equal(other.results[0].verified, true, JSON.stringify(other.results));
    assert.match((await s.route({ [s.receiver]: s.source }, {})).results[0].error, /pending REMI refresh for this camera/);

    const listed = await s.session.call('remi-send', { operation: 'jobs' });
    assert.deepEqual(listed.jobs, [{ source: s.source, key: 'original', number: '1', name: 'Renamed', receivers: [s.receiver] }]);
    assert.deepEqual(await s.session.call('remi-send', { operation: 'dismiss', source: s.source, key: 'original' }), { dismissed: 1 });
    assert.deepEqual((await s.session.call('remi-send', { operation: 'jobs' })).jobs, []);
    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
  } finally { await s.close().catch(() => undefined); }
});

test('a route refuses a stale view, an impossible tree and an unreachable controller', async () => {
  const s = await routeSetup();
  try {
    assert.match((await s.route({ [s.downstream]: s.source }, { [s.receiver]: s.source })).results[0].error, /changed/);
    assert.equal(s.fleet.writes.length, 0);
    assert.match((await s.route({ [s.source]: s.receiver }, {})).results[0].error, /set up on/);
    assert.match((await s.route({ [s.downstream]: s.receiver }, {})).results[0].error, /trace back/);
    assert.match((await s.route({ [s.receiver]: s.downstream, [s.downstream]: s.receiver }, {})).results[0].error, /trace back/);
    assert.equal(s.fleet.writes.length, 0);
    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
    await s.leaf.close();
    assert.match((await s.route({ [s.receiver]: s.source, [s.downstream]: s.receiver }, { [s.receiver]: s.source })).results[0].error, /Cannot reach|Simulated controller is offline/);
    assert.equal(names(s.master).length, 1);
  } finally { await s.close().catch(() => undefined); }
});

const sourceCamera = async (s: Awaited<ReturnType<typeof routeSetup>>) =>
  (await s.session.repository.read(s.session.signal)).plan.cameras.find(row => row.device === s.source && row.elementKey === 'original')!;

test('an edit a copy never shows leaves the copies and every other controller alone', async () => {
  const s = await routeSetup();
  try {
    assert.equal((await s.route({ [s.receiver]: s.source, [s.downstream]: s.receiver }, {})).results[0].verified, true);
    s.rio.addressable('original');
    const camera = await sourceCamera(s), opened = () => [s.rio, s.master, s.leaf].map(device => device.opened), before = opened();
    s.fleet.writes.length = 0;
    const sent = await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, ip: '10.20.20.9' }, fields: ['ip'] }] });
    assert.equal(sent.results[0].verified, true, sent.results[0].error);
    assert.equal(sent.results[0].remiRefresh, undefined);
    assert.equal(s.rio.config.Camera.original.IP, '10.20.20.9');
    assert.deepEqual(s.fleet.writes, [], 'No copy is taken off or put back');
    assert.deepEqual(opened(), [before[0]! + 1, before[1], before[2]], 'One socket, to the camera’s own controller');
    for (const device of [s.master, s.leaf]) assert.deepEqual(names(device), ['Wide']);
  } finally { await s.close(); }
});

test('a rename reads only the controllers on record as holding a copy, and none when there is no copy', async () => {
  const s = await routeSetup(1);
  try {
    const camera = await sourceCamera(s), others = [s.master, s.leaf, s.others[0]!], opened = () => others.map(device => device.opened);
    let before = opened();
    const alone = await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, name: 'Solo' }, fields: ['name'] }] });
    assert.equal(alone.results[0].verified, true, alone.results[0].error);
    assert.equal(alone.results[0].remiRefresh, undefined);
    assert.deepEqual(opened(), before, 'With no copy on record no other controller is opened');

    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
    assert.deepEqual(names(s.master), ['Solo']);
    before = opened();
    s.fleet.writes.length = 0;
    const sent = await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, name: 'Wide renamed' }, fields: ['name'] }] });
    assert.equal(sent.results[0].verified, true, sent.results[0].error);
    assert.equal(sent.results[0].remiError, undefined);
    assert.equal(sent.results[0].remiRefresh, true);
    assert.deepEqual(names(s.master), ['Wide renamed']);
    assert.deepEqual(s.fleet.writes.map(row => [row.device, row.enable]), [[s.receiver, '0'], [s.receiver, '1']]);
    assert.ok(opened()[0]! > before[0]!);
    assert.deepEqual(opened().slice(1), before.slice(1), 'Controllers with no copy of this camera are not opened');
  } finally { await s.close(); }
});

test('a route opens only the controller losing or gaining a copy, and for a new copy the one it comes from', async () => {
  const s = await routeSetup(1);
  try {
    const [truck] = s.ids as [string], all = [s.rio, s.master, s.leaf, s.others[0]!], opened = () => all.map(device => device.opened);
    let before = opened();
    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
    let after = opened();
    assert.ok(after[0]! > before[0]! && after[1]! > before[1]!);
    assert.deepEqual(after.slice(2), before.slice(2), 'Controllers the change doesn’t involve are not opened');

    // A controller nothing here touches can be off, and a copy made from a copy doesn't open the camera's own controller.
    await s.leaf.close();
    before = opened();
    const tree = { [s.receiver]: s.source, [truck]: s.receiver };
    const chained = await s.route(tree, { [s.receiver]: s.source });
    assert.equal(chained.results[0].verified, true, chained.results[0].error);
    after = opened();
    assert.equal(after[0], before[0]);
    assert.ok(after[1]! > before[1]! && after[3]! > before[3]!);
    assert.deepEqual(names(s.others[0]!), ['Wide']);

    // Taking one copy off opens the controller it is on and no other.
    before = opened();
    assert.equal((await s.route({ [s.receiver]: s.source }, tree)).results[0].verified, true);
    after = opened();
    assert.deepEqual(after.slice(0, 3), before.slice(0, 3));
    assert.ok(after[3]! > before[3]!);
    assert.deepEqual(names(s.others[0]!), []);
    assert.deepEqual(names(s.master), ['Wide']);
  } finally { await s.close().catch(() => undefined); }
});

test('a copy with no receipt is taken off by where the page showed it, and one already gone counts as done', async () => {
  const s = await routeSetup();
  try {
    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
    const key = Object.keys(s.master.config.Camera)[0]!, shown = { [s.receiver]: s.source };
    const store = await s.session.repository.readRemi(s.session.signal);
    store.data.links = [];
    await s.session.repository.writeRemi(store, s.session.signal);
    // Nothing on record and nothing from the page: the view is out of date.
    assert.match((await s.route({}, shown)).results[0].error, /changed/);
    assert.deepEqual(names(s.master), ['Wide']);
    // A key that isn't a copy is never removed.
    s.master.config.Camera.local = { Number: '7', Name: 'Local', Model: 'Sony - Venice-IP' };
    assert.match((await s.route({}, shown, { camera: s.source, key: 'original', copies: { [s.receiver]: 'local' } } as never)).results[0].error, /changed/);
    assert.deepEqual(names(s.master).sort(), ['Local', 'Wide']);
    const rioOpened = s.rio.opened;
    assert.equal((await s.route({}, shown, { camera: s.source, key: 'original', copies: { [s.receiver]: key } } as never)).results[0].verified, true);
    assert.deepEqual(names(s.master), ['Local']);
    assert.equal(s.rio.opened, rioOpened, 'Taking a copy off doesn’t open the camera’s own controller');
    // The same request again finds it gone, which is what was asked for.
    s.fleet.writes.length = 0;
    assert.equal((await s.route({}, shown, { camera: s.source, key: 'original', copies: { [s.receiver]: key } } as never)).results[0].verified, true);
    assert.deepEqual(s.fleet.writes, []);
  } finally { await s.close(); }
});

test('the rest of a rig is found from the controllers a read one lists, and only by reading', async () => {
  const s = await routeSetup(1);
  try {
    assert.equal((await s.route({ [s.receiver]: s.source, [s.downstream]: s.receiver }, {})).results[0].verified, true);
    // Hubble was only given the first RCP. The last RCP is listed by the RIO alone, and one serial is left over from another job.
    const [truck] = s.ids as [string];
    s.fleet.remembered = ['cy-rcp-9-99'];
    s.fleet.sees = (from, to) => to !== s.others[0] || from === s.rio;
    s.fleet.publish();
    const { plan, revision } = await s.session.repository.read(s.session.signal);
    await s.session.call('save-plan', { revision, plan: { ...plan, devices: plan.devices.filter(device => device.id === s.receiver), cameras: plan.cameras.filter(row => row.device === s.receiver) } });
    const actions = () => [s.rio, s.master, s.leaf, s.others[0]!].map(device => device.actions.length), before = actions();
    await s.session.call('refresh');
    const started = Date.now();
    const rig = await s.session.call('find-rig', { ignore: [] });
    assert.deepEqual(rig.found.map((device: { id: string }) => device.id).sort(), [s.source, s.downstream, truck].sort());
    assert.ok(Date.now() - started < 4000, 'A serial nothing answers to doesn’t hold the search up');
    assert.deepEqual(actions(), before, 'Nothing is written to any controller');
    // What it found can be added the way a typed address is, and comes in on its base address with its cameras.
    const rio = rig.found.find((device: { id: string }) => device.id === s.source);
    assert.equal(rio.base, '10.192.1.10');
    const imported = await s.session.call('import-device', { id: rio.id, address: rio.address || rio.base });
    assert.equal(imported.cameraCount, 2);
    // A controller that was removed by hand is left out.
    const again = await s.session.call('find-rig', { ignore: [s.source.toLowerCase(), truck] });
    assert.deepEqual(again.found.map((device: { id: string }) => device.id), [s.downstream]);
  } finally { await s.close(); }
});

test('a route checks capacity before adding a copy', async () => {
  const s = await routeSetup();
  try {
    s.master.config.Product.MaxCam = '0';
    assert.match((await s.route({ [s.receiver]: s.source }, {})).results[0].error, /camera capacity/);
    assert.equal(s.master.actions.length, 0);
  } finally { await s.close(); }
});

test('the log says why a send was not confirmed, how long the copies took, and which controller gave a read no answer', async () => {
  const s = await routeSetup();
  try {
    const camera = await sourceCamera(s), lines = () => (s.session.traces as { stage?: unknown; message?: unknown }[]).filter(row => /-timing$/.test(String(row.stage))).map(row => String(row.message));
    assert.equal((await s.route({ [s.receiver]: s.source }, {})).results[0].verified, true);
    const renamed = await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, name: 'Renamed' }, fields: ['name'] }] });
    assert.equal(renamed.results[0].remiRefresh, true);
    assert.equal(typeof renamed.results[0].copiesMs, 'number', 'Rebuilding the copies is timed apart from the send');
    const plain = await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, name: 'Renamed' }, fields: ['port'] }] });
    assert.equal(plain.results[0].copiesMs, undefined, 'Nothing is timed when no copy is rebuilt');

    await s.session.call('send', { items: [{ kind: 'camera', item: { ...camera, name: '' }, fields: ['name'] }] });
    assert.match(lines().at(-1)!, /^1 camera on 1 controller in \d+ ms.*, 1 not confirmed: Enter a camera number and name$/);

    // A send that is refused outright has no result, and used to leave nothing in the log.
    await assert.rejects(s.session.call('send', { items: [] }), /Choose between 1 and 1536/);
    assert.match(lines().at(-1)!, /^A send gave up after \d+ ms: Choose between 1 and 1536 configuration rows$/);
    await assert.rejects(s.session.call('remi-route', { items: [] }), /Choose between 1 and 512/);
    assert.match(lines().at(-1)!, /^A REMI route gave up after \d+ ms: Choose between 1 and 512 camera assignments$/);

    // A quick read of controllers that all answer stays out of the log.
    const before = lines().length;
    assert.deepEqual((await s.session.call('refresh', {})).failed, []);
    assert.equal(lines().length, before);
    const { revision, plan } = await s.session.repository.read(s.session.signal);
    Object.assign(plan.devices.find(device => device.id === s.downstream)!, { base: '10.99.99.99', alias: '', address: '10.99.99.99' });
    await s.session.call('save-plan', { revision, plan });
    assert.deepEqual((await s.session.call('refresh', {})).failed, [s.downstream]);
    assert.match(lines().at(-1)!, new RegExp('^Read 3 controllers in \\d+ ms, no answer from ' + s.downstream + '$'));
  } finally { await s.close(); }
});
