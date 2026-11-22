import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import module from '../src/index.js';
import { fields,defaultDocument,clone,reelProperty,applyMutation,inverse,validateDocument,type CameraDocument } from '../src/model.js';
import { Drafts } from '../src/draft-store.js';
import { createBackend } from '../src/backend.js';
import {
  applyPresetMutation,inversePreset,defaultPresetDocument,resolvedValues,presetValue,newRole,uniqueName,capturedValues,planSend,sendOrder,
  validatePresetDocument,presetFields,isPresetField,roleFieldIds,cameraIdField,baseId,nameRowId,heldFieldIds,capturedOffers,offeredChange,type PresetDocument,type PresetMutation
} from '../src/presets-model.js';
import { fakeCamera } from './fake-camera.js';

const field=(id:string)=>fields.find(f=>f.id===id)!;
const sdiField=fields.find(f=>f.property==='P.System.Menu.SdiOsdDisplayInfoOnoff')!;
const until=async(fn:()=>boolean,ms=4000)=>{const end=Date.now()+ms;while(!fn()&&Date.now()<end)await delay(5);assert.ok(fn());};
/** Base holds a whole camera; C Cam holds only what makes it C. */
function roles():PresetDocument {
  const doc=defaultPresetDocument();
  doc.presets[0]!.values={[cameraIdField.id]:'A','ei':'800','base-iso':'800','wb-temperature':'5600',[sdiField.id]:'TRUE'};
  doc.presets.push({id:'a',name:'A Cam',values:{[cameraIdField.id]:'A'}},{id:'c',name:'C Cam',values:{[cameraIdField.id]:'C','wb-temperature':'4300'}});
  return doc;
}

test('a role sends Base with its own values on top, and Base alone sends only Base',()=>{
  const doc=roles();
  assert.deepEqual(resolvedValues(doc,'c'),{[cameraIdField.id]:'C','ei':'800','base-iso':'800','wb-temperature':'4300',[sdiField.id]:'TRUE'});
  assert.deepEqual(resolvedValues(doc,baseId),doc.presets[0]!.values);
  assert.deepEqual(presetValue(doc,'c','ei'),{value:'800',own:false});
  assert.deepEqual(presetValue(doc,'c','wb-temperature'),{value:'4300',own:true});
  assert.deepEqual(presetValue(doc,baseId,'gain'),{value:'',own:false});
  assert.deepEqual([...roleFieldIds(doc)].sort(),[cameraIdField.id,'wb-temperature'].sort());
});

test('the reel is never part of a preset, and a capture keeps only values a preset can hold',()=>{
  const reel=fields.find(f=>f.property===reelProperty)!;
  assert.ok(!isPresetField(reel.id));assert.equal(presetFields.length,fields.length-1);
  assert.throws(()=>applyPresetMutation(roles(),{kind:'edit',edits:[{rowId:reel.id,columnId:baseId,value:'12',expected:''}]}),/reel/i);
  const {values,dropped}=capturedValues({[reel.id]:'12','ei':'800',[cameraIdField.id]:'not a letter','wb-temperature':'',[sdiField.id]:'TRUE'});
  assert.deepEqual(values,{'ei':'800',[sdiField.id]:'TRUE'});assert.deepEqual(dropped,[cameraIdField.id]);
});

test('editing a role gives it its own value, and clearing it goes back to Base',()=>{
  let doc=roles();
  doc=applyPresetMutation(doc,{kind:'edit',edits:[{rowId:'ei',columnId:'c',value:'1600',expected:''}]});
  assert.equal(resolvedValues(doc,'c').ei,'1600');
  const undo=inversePreset(roles(),{kind:'edit',edits:[{rowId:'ei',columnId:'c',value:'1600',expected:''}]});
  doc=applyPresetMutation(doc,undo);
  assert.equal(doc.presets[2]!.values.ei,undefined);assert.equal(resolvedValues(doc,'c').ei,'800');
  assert.throws(()=>applyPresetMutation(doc,{kind:'edit',edits:[{rowId:'ei',columnId:'c',value:'900',expected:'1600'}]}),/changed in another editor/);
});

test('names are unique, Base keeps its name and can’t be removed, and a new role takes the next camera letter',()=>{
  const doc=roles();
  assert.throws(()=>applyPresetMutation(doc,{kind:'edit',edits:[{rowId:nameRowId,columnId:'c',value:'a cam',expected:'C Cam'}]}),/own name/);
  assert.throws(()=>applyPresetMutation(doc,{kind:'edit',edits:[{rowId:nameRowId,columnId:baseId,value:'Main',expected:'Base'}]}),/Base keeps/);
  assert.throws(()=>applyPresetMutation(doc,{kind:'remove',preset:clone(doc.presets[0]!),index:0}),/Base/);
  const renamed=applyPresetMutation(doc,{kind:'edit',edits:[{rowId:nameRowId,columnId:'c',value:'  Steadicam ',expected:'C Cam'}]});
  assert.equal(renamed.presets[2]!.name,'Steadicam');
  assert.equal(applyPresetMutation(renamed,inversePreset(doc,{kind:'edit',edits:[{rowId:nameRowId,columnId:'c',value:'  Steadicam ',expected:'C Cam'}]})).presets[2]!.name,'C Cam');
  const next=newRole(doc,'n');
  assert.deepEqual(next,{id:'n',name:'B Cam',values:{[cameraIdField.id]:'B'}},'A and C are taken, so B is next');
  assert.equal(uniqueName(doc,'C Cam'),'C Cam 2');
  assert.equal(newRole(defaultPresetDocument(),'first').name,'A Cam');
  const capturedA=defaultPresetDocument();capturedA.presets[0]!.values[cameraIdField.id]='A';
  assert.equal(newRole(capturedA,'first').name,'A Cam','Base captured from camera A still leaves A for the first role');
});

test('adding, removing and capturing are each one undo step that puts things back exactly',()=>{
  const doc=roles();
  const add:PresetMutation={kind:'add',preset:{id:'d',name:'D Cam',values:{[cameraIdField.id]:'D'}},index:3};
  const added=applyPresetMutation(doc,add);
  assert.deepEqual(applyPresetMutation(added,inversePreset(doc,add)),doc);
  const remove:PresetMutation={kind:'remove',preset:clone(doc.presets[1]!),index:1};
  const removed=applyPresetMutation(doc,remove);
  assert.deepEqual(applyPresetMutation(removed,inversePreset(doc,remove)),doc,'the role comes back in its place');
  const capture:PresetMutation={kind:'values',presetId:baseId,values:{'ei':'1280'},expected:clone(doc.presets[0]!.values)};
  const captured=applyPresetMutation(doc,capture);
  assert.deepEqual(captured.presets[0]!.values,{'ei':'1280'});assert.equal(resolvedValues(captured,'c')[cameraIdField.id],'C','roles keep their own values');
  assert.deepEqual(applyPresetMutation(captured,inversePreset(doc,capture)),doc);
});

test('saved presets refuse what the page could not show',()=>{
  assert.throws(()=>validatePresetDocument({...defaultPresetDocument(),presets:[]}),/presets/);
  assert.throws(()=>validatePresetDocument({...defaultPresetDocument(),presets:[{id:'x',name:'X',values:{}}]}),/Base comes first/);
  assert.throws(()=>validatePresetDocument({...roles(),presets:[...roles().presets,{id:'a',name:'Again',values:{}}]}),/identity/);
  assert.throws(()=>validatePresetDocument({...roles(),send:{presetId:5 as unknown as string}}),/send choice/);
  const big=defaultPresetDocument();big.presets[0]!.values={'L3_FILE_ID':'x'.repeat(500)};
  for(let n=0;n<31;n++)big.presets.push({id:'p'+n,name:'P'+n,values:Object.fromEntries(presetFields.filter(f=>f.kind==='text'&&!f.choices.length).slice(0,40).map(f=>[f.id,'y'.repeat(200)]))});
  assert.throws(()=>validatePresetDocument(big),/workspace document limit/);
});

test('a send writes only what differs, in an order a VENICE accepts, and one of shutter angle or speed',()=>{
  const resolved={'ei':'3200','base-iso':'3200','shutter-mode':'Angle','shutter-angle':'180.0','shutter-speed':'1/48.00','L3_SYSTEM_FRAME_RATE':'6','shooting-fps':'24','wb-temperature':'5600',[cameraIdField.id]:'C','look-category':'ART','art-look':'2'};
  const current={'ei':'800','base-iso':'800','shutter-mode':'Speed','shutter-angle':'172.8','shutter-speed':'1/50.00','L3_SYSTEM_FRAME_RATE':'5','shooting-fps':'23.98','wb-temperature':'5600',[cameraIdField.id]:'A','look-category':'ART'};
  const plan=planSend(resolved,current,{[cameraIdField.id]:[{value:'A'},{value:'B'}]});
  assert.deepEqual(plan.send.map(s=>s.id),['L3_SYSTEM_FRAME_RATE','shooting-fps','base-iso','ei','shutter-mode','shutter-angle']);
  assert.equal(plan.same,2,'temperature and look category already match');
  assert.deepEqual(plan.skipped.map(s=>s.id).sort(),['art-look',cameraIdField.id].sort());
  assert.match(plan.skipped.find(s=>s.id===cameraIdField.id)!.reason,/doesn’t offer C/);
  assert.match(plan.skipped.find(s=>s.id==='art-look')!.reason,/doesn’t report/);
  assert.deepEqual(sendOrder(['ei','base-iso']),['base-iso','ei']);
  assert.deepEqual(planSend({'shutter-mode':'Speed','shutter-angle':'180.0','shutter-speed':'1/48.00'},{'shutter-mode':'Angle','shutter-angle':'172.8','shutter-speed':'1/50.00'},{}).send.map(s=>s.id),['shutter-mode','shutter-speed']);
  assert.deepEqual(planSend({'shutter-angle':'180.0','shutter-speed':'1/48.00'},{'shutter-angle':'172.8','shutter-speed':'1/50.00'},{}).send.map(s=>s.id),['shutter-angle'],'with no mode, angle wins');
});

test('a new preset shows before its save, a rename lands while that save is held, and a refused add takes only what depended on it',async()=>{
  let saved=roles(),release!:(fail:boolean)=>void,calls=0;
  const held=new Promise<boolean>(r=>release=r);
  const store=new Drafts<PresetDocument,PresetMutation>({document:saved,revision:'1'},async operation=>{
    if(++calls===1&&await held)throw Error('Preset save rejected');
    saved=applyPresetMutation(saved,operation);return {document:saved,revision:String(calls+1)};
  },applyPresetMutation,inversePreset);
  store.submit({kind:'add',preset:{id:'d',name:'D Cam',values:{[cameraIdField.id]:'D'}},index:3});
  assert.equal(store.document.presets.length,4,'the new column is there before any save answers');
  store.submit({kind:'edit',edits:[{rowId:nameRowId,columnId:'d',value:'Crane',expected:'D Cam'}]});
  store.submit({kind:'edit',edits:[{rowId:'ei',columnId:'c',value:'1600',expected:''}]});
  assert.equal(store.document.presets[3]!.name,'Crane');assert.equal(store.document.presets[2]!.values.ei,'1600');
  release(true);await until(()=>store.pending.length===0);
  assert.equal(store.document.presets.length,3,'the refused preset and its rename are gone');
  assert.equal(store.document.presets[2]!.values.ei,'1600','an unrelated edit survives');assert.equal(saved.presets[2]!.values.ei,'1600');
  assert.match(store.error,/rejected|removed/);
});

test('an open Presets tab is saved with the plan, reverses as a pair and an older plan opens on its camera tab',()=>{
  const before=defaultDocument();
  assert.equal(before.presetsOpen,undefined);
  const open=applyMutation(before,{kind:'presets-open',open:true,expected:false});
  assert.equal(open.presetsOpen,true);assert.deepEqual(validateDocument(JSON.parse(JSON.stringify(open))),open);
  assert.deepEqual(applyMutation(open,inverse(before,{kind:'presets-open',open:true,expected:false})),before,'closing leaves no field behind');
  assert.throws(()=>applyMutation(open,{kind:'presets-open',open:true,expected:false}),/another editor/);
  assert.throws(()=>validateDocument({...before,presetsOpen:'yes'}),/open tab/);
});

test('only settings a preset holds show, and a capture keeps the values the camera allows for them',()=>{
  const doc=roles();
  assert.deepEqual([...heldFieldIds(doc)].sort(),[cameraIdField.id,'ei','base-iso','wb-temperature',sdiField.id].sort());
  assert.deepEqual(heldFieldIds(defaultPresetDocument()).size,0,'before a capture nothing shows');
  const offers=capturedOffers({ei:[{value:'800'},{value:'1600'},{value:'800'}],[cameraIdField.id]:[{value:'A'},{value:'not a letter'},{value:'C'}],'wb-tint':[{value:'0'}],'gain':[]},{ei:'800',[cameraIdField.id]:'A',gain:'0'});
  assert.deepEqual(offers,{ei:['800','1600'],[cameraIdField.id]:['A','C']},'duplicates and values a preset can’t hold go; settings not captured are left out');
  const before=clone(doc.presets[0]!.values),capture:PresetMutation={kind:'values',presetId:baseId,values:{ei:'800'},expected:before,...offeredChange(doc,offers)};
  const captured=applyPresetMutation(doc,capture);
  assert.deepEqual(captured.offered,offers);
  assert.deepEqual(applyPresetMutation(captured,inversePreset(doc,capture)),doc,'Undo takes the allowed values away again');
  const again=applyPresetMutation(captured,{kind:'values',presetId:baseId,values:{ei:'800'},expected:{ei:'800'},...offeredChange(captured,{ei:['800','3200']})});
  assert.deepEqual(again.offered,{ei:['800','3200'],[cameraIdField.id]:['A','C']},'a later capture replaces only what it read');
  assert.throws(()=>validatePresetDocument({...doc,offered:{ei:['eight hundred']}}),/allowed values/);
  assert.throws(()=>validatePresetDocument({...doc,offered:{[fields.find(f=>f.property===reelProperty)!.id]:['1']}}),/allowed values/);
  const huge=Object.fromEntries(presetFields.filter(f=>f.kind==='number').map(f=>[f.id,Array.from({length:300},(_,n)=>({value:String(n*7)}))]));
  const kept=capturedOffers(huge,Object.fromEntries(Object.keys(huge).map(id=>[id,'0'])));
  assert.ok(JSON.stringify(kept).length<=120000,'long lists are dropped before the saved presets grow too large');
});

// Everything below talks to loopback fake cameras only.
function workspace(plan:CameraDocument,presets:PresetDocument=defaultPresetDocument()){
  const docs:Record<string,any>={'camera-plan':{id:'camera-plan',version:1,revision:'1',value:plan},'camera-presets':{id:'camera-presets',version:1,revision:'1',value:presets}};
  let saves=1;
  const services={async request(_service:string,_version:number,input:any,signal:AbortSignal){
    if(input.method==='watch')return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    const current=docs[input.id];if(!current)throw Error('Unknown document '+input.id);
    if(input.method==='write')docs[input.id]={...current,revision:String(++saves),value:input.value};
    return {status:'document',document:docs[input.id]};
  }};
  return {services,saved:(id:string)=>docs[id].value};
}
const planFor=(hosts:string[],staged:Record<string,string>[]=[])=>{const plan=defaultDocument();plan.cameras=hosts.map((host,index)=>({id:'cam-'+index,values:{'camera-name':'Camera '+(index+1),'camera-host':host,'camera-username':'operator','camera-password':'fixture-password',...staged[index]}}));return plan;};
async function presetsBackend(ws:ReturnType<typeof workspace>){
  const states:any[]=[],logs:string[]=[];
  const backend=createBackend({services:ws.services,connectionEnabled:true,log:(trace:any)=>logs.push(trace.message),publishState:(state:any)=>states.push(state)} as any,async()=>'answered',{});
  await backend.start();
  // Everything goes through Camera Control's page: the presets are one of its tabs.
  const call=(commandId:string,value?:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal} as any) as Promise<any>;
  const values=()=>states.at(-1).values;
  return {backend,call,values,logs};
}
// What a real VENICE reports for the settings these tests use.
// A VENICE reports menu settings as numbers; the fake takes them as given.
const cameraValues=(id:number,extra:Record<string,unknown>={}):Record<string,any>=>({'P.System.Menu.ClipnamingCameraid':id,'Camera.Gain.ExposureIndex.Value':'800EI','Camera.Gain.ISOValue':'ISO 800','Camera.WhiteBalance.ColorTemperature.Value':'5600','P.System.Menu.SdiOsdDisplayInfoOnoff':0,'Clip.Mediabox.Status':{main:'Standby'},...extra});

test('the Presets page reads its own document and the cameras, never their logins',async()=>{
  const ws=workspace(planFor(['127.0.0.1:9']),roles());
  const {backend,call}=await presetsBackend(ws);
  try {
    const reply=await call('presets-snapshot');
    assert.deepEqual(reply.document,roles());
    assert.deepEqual(reply.cameras,[{id:'cam-0',name:'Camera 1',host:'127.0.0.1:9',login:true}]);
    assert.ok(!JSON.stringify(reply).includes('fixture-password'));
    const saved=await call('presets-save',{operation:{kind:'edit',edits:[{rowId:'ei',columnId:'c',value:'1600',expected:''}]}});
    assert.equal(saved.document.presets[2].values.ei,'1600');assert.equal(ws.saved('camera-presets').presets[2].values.ei,'1600');
    assert.equal(ws.saved('camera-plan').cameras.length,1,'the camera plan is untouched');
  } finally {await backend.dispose();}
});

test('a capture reads every setting a preset can hold, including ones no tab shows',async()=>{
  const camera=await fakeCamera({values:cameraValues(66),offers:{'Camera.Gain.ExposureIndex.Value':['800EI','1600EI','3200EI'],'P.System.Menu.ClipnamingCameraid':[65,66,67]}});
  const ws=workspace(planFor([camera.host]));
  const {backend,call,values}=await presetsBackend(ws);
  try {
    await call('refresh',{rowId:'cam-0',host:camera.host,fieldIds:presetFields.map(f=>f.id)});
    const read=new Set(camera.reads.flat());
    for(const id of [cameraIdField.id,'ei','wb-temperature',sdiField.id])for(const property of [field(id).property])assert.ok(read.has(property),property+' should be read');
    assert.ok(!read.has(reelProperty),'the reel is not part of a capture');
    const obs=values().observations['cam-0'],{values:captured}=capturedValues(obs.values);
    assert.equal(captured[cameraIdField.id],'B');assert.equal(captured.ei,'800');assert.equal(captured[sdiField.id],'FALSE');
    assert.deepEqual(capturedOffers(obs.choices,captured),{ei:['800','1600','3200'],[cameraIdField.id]:['A','B','C'],'base-iso':['800','3200']},'the camera’s allowed values come with the capture, and Base ISO its sensor’s pair');
  } finally {await backend.dispose();await camera.close();}
});

test('sending C Cam writes only what differs, confirms each one and clears Camera Control’s older staged values',async()=>{
  const camera=await fakeCamera({values:cameraValues(65,{'Camera.WhiteBalance.ColorTemperature.Value':'3200'})});
  const ws=workspace(planFor([camera.host],[{'wb-temperature':'3000','ei':'1600'}]),roles());
  const {backend,call,values,logs}=await presetsBackend(ws);
  try {
    const reply=await call('send-preset',{presetId:'c',rowId:'cam-0',host:camera.host});
    assert.equal(reply.status,'started');assert.equal(reply.job.total,3);assert.equal(reply.job.same,2,'EI and base ISO already match');
    await until(()=>values().presetSends['cam-0']?.running===false);
    const job=values().presetSends['cam-0'];
    assert.equal(job.done,3);assert.deepEqual(job.failed,[]);assert.equal(job.settled,3);
    assert.deepEqual(camera.writes.map(w=>Object.keys(w)[0]),['P.System.Menu.ClipnamingCameraid','Camera.WhiteBalance.ColorTemperature.Value','P.System.Menu.SdiOsdDisplayInfoOnoff']);
    assert.equal(camera.values['P.System.Menu.ClipnamingCameraid'],67);assert.equal(camera.values['Camera.WhiteBalance.ColorTemperature.Value'],'4300');
    const obs=values().observations['cam-0'];
    assert.equal(obs.values[cameraIdField.id],'C');assert.equal(obs.values['wb-temperature'],'4300');assert.deepEqual(obs.queued,[]);
    assert.equal(ws.saved('camera-plan').cameras[0].values['wb-temperature']||'','', 'Send all in Camera Control can no longer put 3000 back');
    assert.equal(ws.saved('camera-plan').cameras[0].values.ei||'','');
    assert.ok(logs.some(line=>/Camera 1 ← C Cam: 3 confirmed, 0 failed/.test(line)));
    const again=await call('send-preset',{presetId:'c',rowId:'cam-0',host:camera.host});
    assert.equal(again.status,'nothing-to-send');assert.equal(camera.writes.length,3);
  } finally {await backend.dispose();await camera.close();}
});

test('a rolling camera, an empty preset and a changed address are refused before anything is written',async()=>{
  const camera=await fakeCamera({values:cameraValues(65,{'Clip.Mediabox.Status':{main:'Recording'}})});
  const empty=defaultPresetDocument();
  const ws=workspace(planFor([camera.host]),roles());
  const {backend,call,values}=await presetsBackend(ws);
  try {
    await assert.rejects(call('send-preset',{presetId:'c',rowId:'cam-0',host:camera.host}),/Camera 1 is rolling/);
    assert.equal(camera.writes.length,0);assert.equal(values().presetSends['cam-0'].running,false);
    await assert.rejects(call('send-preset',{presetId:'c',rowId:'cam-0',host:'10.0.0.9'}),/address changed/);
    await call('presets-save',{operation:{kind:'values',presetId:baseId,values:{},expected:roles().presets[0]!.values}});
    await call('presets-save',{operation:{kind:'remove',preset:roles().presets[2],index:2}});
    await call('presets-save',{operation:{kind:'remove',preset:roles().presets[1],index:1}});
    assert.deepEqual(ws.saved('camera-presets').presets,empty.presets);
    await assert.rejects(call('send-preset',{presetId:baseId,rowId:'cam-0',host:camera.host}),/holds no settings/);
  } finally {await backend.dispose();await camera.close();}
});

test('Stop lets the setting being written finish and sends nothing after it, and Camera Control waits for the preset',async()=>{
  const camera=await fakeCamera({values:cameraValues(65,{'Camera.WhiteBalance.ColorTemperature.Value':'3200'}),writeDelay:150});
  const ws=workspace(planFor([camera.host],[{[sdiField.id]:'TRUE'}]),roles());
  const {backend,call,values}=await presetsBackend(ws);
  try {
    await call('send-preset',{presetId:'c',rowId:'cam-0',host:camera.host});
    await until(()=>camera.writes.length===1);
    await assert.rejects(call('send',{rowId:'cam-0',host:camera.host,fieldIds:[sdiField.id]}),/preset is being sent/);
    await assert.rejects(call('send-preset',{presetId:'a',rowId:'cam-0',host:camera.host}),/already sending/);
    await call('cancel-preset',{rowId:'cam-0'});
    await until(()=>values().presetSends['cam-0']?.running===false);
    const job=values().presetSends['cam-0'];
    assert.equal(camera.writes.length,1);assert.equal(job.done,1);assert.equal(job.cancelled,true);
  } finally {await backend.dispose();await camera.close();}
});

test('a camera that drops part way through stops the send and shows offline',async()=>{
  const camera=await fakeCamera({values:cameraValues(65,{'Camera.WhiteBalance.ColorTemperature.Value':'3200'}),writeDelay:150});
  const ws=workspace(planFor([camera.host]),roles());
  const {backend,call,values}=await presetsBackend(ws);
  try {
    await call('send-preset',{presetId:'c',rowId:'cam-0',host:camera.host});
    await until(()=>camera.writes.length===1);
    await camera.close();
    await until(()=>values().presetSends['cam-0']?.running===false);
    const job=values().presetSends['cam-0'];
    assert.match(job.error,/stopped answering/);assert.equal(values().observations['cam-0'].state,'offline');
  } finally {await backend.dispose();await camera.close();}
});

test('Presets is a tab of Camera Control: one page, its own document and its commands',async()=>{
  const {default:manifest}=await import('../src/manifest.js');
  assert.deepEqual(manifest.pages!.map(p=>[p.id,p.label]),[['cameras','Camera Control']]);
  assert.ok(!manifest.capabilities.includes('service.page.presets'));
  const section=manifest.pages![0]!.sections[0] as {commands:{id:string}[]};
  for(const id of ['presets-snapshot','presets-save','send-preset','cancel-preset'])assert.ok(section.commands.some(c=>c.id===id),id);
  assert.deepEqual(manifest.documents!.map(d=>d.id),['camera-plan','camera-presets']);
  assert.deepEqual(validatePresetDocument(manifest.documents![1]!.defaultValue),defaultPresetDocument());
  assert.equal(typeof module.createInstance,'function');
});
