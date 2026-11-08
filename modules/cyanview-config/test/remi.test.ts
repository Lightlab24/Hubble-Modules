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
