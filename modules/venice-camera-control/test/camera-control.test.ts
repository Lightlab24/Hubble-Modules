import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { encode,decode } from '@msgpack/msgpack';
import { createModuleHarness } from '@hubble/module-sdk/testing';
import module from '../src/index.js';
import { groups,fields,defaultDocument,applyMutation,clone,visibleFields,withColumnVisibility,validateDocument,addSheet,renameSheet,removeSheet,moveSheet,setOrientation,sheetList,activeSheetId,isFlipped,viewChange,setCameraCount,cameraHasData,loginVisible,sheetRowCount,withNoColumns,alertChoices,inverse,liveOn,autoSendOn,readFieldIds,type AlertChoices,type Mutation,type View } from '../src/model.js';
import { DraftStore } from '../src/draft-store.js';
import { CameraClient } from '../src/camera-client.js';
import { encodeField,decodeField,writeField,recordingState,fieldProperties } from '../src/protocol.js';
import { fakeCamera,absentCameraHost } from './fake-camera.js';
import { pingCamera } from '../src/camera-ping.js';
import { createBackend } from '../src/backend.js';

const cameraField=fields.find(f=>f.property==='P.System.Menu.ClipnamingCameraid')!;
const reelField=fields.find(f=>f.property==='P.System.Menu.ClipnamingReelNum')!;
const sdiField=fields.find(f=>f.property==='P.System.Menu.SdiOsdDisplayInfoOnoff')!;
const edit=(columnId:string,value:string,expected=''):Mutation=>({kind:'edit',edits:[{rowId:'venice-tested-body',columnId,value,expected}]});
const until=async(fn:()=>boolean)=>{for(let i=0;i<100&&!fn();i++)await delay(5);assert.ok(fn());};

test('all declared sections exclude Lens and use stable unique setting IDs',()=>{
  assert.equal(groups.length,11);assert.equal(fields.length,265);
  assert.equal(new Set(fields.map(f=>f.id)).size,265);
  assert.equal(fields.filter(f=>f.verified).length,3);
  assert.ok(!JSON.stringify(groups).match(/\blens\b|Camera\.Focus"|Camera\.Iris|Camera\.Zoom"/i));
  const before=defaultDocument(),widths=clone(before.view.widths),compact=visibleFields(before.view);
  const next=clone(before);next.view.expanded.exposure=true;
  assert.ok(visibleFields(next.view).length>compact.length);
  assert.deepEqual(next.view.widths,widths);
  assert.deepEqual(compact,[]);
  assert.ok(visibleFields(next.view).every(f=>f.group==='exposure'));
});

test('paste batches reject invalid addresses atomically and protect status/credentials',()=>{
  const doc=defaultDocument();
  assert.throws(()=>applyMutation(doc,{kind:'edit',edits:[{rowId:'venice-tested-body',columnId:cameraField.id,value:'C',expected:''},{rowId:'venice-tested-body',columnId:'camera-host',value:'10.0.0.999',expected:'192.0.2.109'}]}),/valid hostname/);
  assert.equal(doc.cameras[0]!.values[cameraField.id],undefined);
  assert.throws(()=>applyMutation(doc,edit('connection-status','Online')),/not editable/);
  assert.throws(()=>applyMutation(doc,edit('password','canary-secret')),/not editable/);
});

test('ordered saves preserve a newer edit while the first save is held',async()=>{
  let saved=defaultDocument(),release!:()=>void,calls=0;
  const held=new Promise<void>(r=>release=r);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1)await held;
    saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  store.submit(edit(cameraField.id,'B'));
  store.submit(edit(cameraField.id,'C','B'));
  assert.equal(store.document.cameras[0]!.values[cameraField.id],'C');
  release();await until(()=>store.pending.length===0);
  assert.equal(saved.cameras[0]!.values[cameraField.id],'C');
  assert.equal(store.document.cameras[0]!.values[cameraField.id],'C');
});

test('a failed save retains its invalid draft and preserves unrelated later work',async()=>{
  let saved=defaultDocument(),reject!:()=>void,calls=0;
  const held=new Promise<void>(r=>reject=r);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1){await held;throw Error('Storage unavailable');}
    saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  store.submit(edit(cameraField.id,'C'));store.submit(edit(reelField.id,'101'));
  reject();await until(()=>store.pending.length===0);
  assert.equal(saved.cameras[0]!.values[reelField.id],'101');
  assert.equal(store.invalid.get('venice-tested-body/'+cameraField.id)!.edit.value,'C');
  assert.equal(store.document.cameras[0]!.values[reelField.id],'101');
});

test('a snapshot requested before an edit cannot replace the newer saved draft',async()=>{
  const initial=defaultDocument();
  const store=new DraftStore({document:initial,revision:null},async operation=>({document:applyMutation(initial,operation),revision:'new'}));
  const oldEpoch=store.epoch;
  store.submit(edit(cameraField.id,'C'));await until(()=>store.pending.length===0);
  store.observe({document:initial,revision:'old'},oldEpoch);
  assert.equal(store.document.cameras[0]!.values[cameraField.id],'C');
});

test('non-default group layout and drafts survive a portable document round trip',()=>{
  let doc=applyMutation(defaultDocument(),edit(cameraField.id,'C'));
  const expected=clone(doc.view),view=clone(expected);
  view.expanded.outputs=true;view.widths[cameraField.id]=220;view.order.reverse();view.collapsed.identity=[reelField.id];view.collapsed.exposure=[];view.hiddenGroups=['monitoring-aids'];view.textSize=19;
  doc=applyMutation(doc,{kind:'view',view,expected});
  const imported=JSON.parse(JSON.stringify(doc));
  assert.deepEqual(imported,doc);
  assert.ok(visibleFields(imported.view).some(f=>f.id===reelField.id));
  assert.deepEqual(imported.view.hiddenGroups,['monitoring-aids']);
  assert.deepEqual(imported.view.collapsed.exposure,[]);
  assert.equal(imported.view.textSize,19);
  const legacy=clone(doc);delete legacy.view.hiddenGroups;delete legacy.view.textSize;assert.doesNotThrow(()=>applyMutation(legacy,edit(reelField.id,'101')));
});

test('visibility painting is one undoable save and keeps later cell edits usable',async()=>{
  let saved=defaultDocument(),release!:()=>void,calls=0;
  const held=new Promise<void>(resolve=>release=resolve);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1)await held;saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  const expected=clone(store.document.view),view=withColumnVisibility(expected,[{id:cameraField.id,visible:true},{id:reelField.id,visible:true}]);
  store.submit({kind:'view',expected,view});
  assert.deepEqual(visibleFields(store.document.view).map(field=>field.id),[cameraField.id,reelField.id]);
  store.submit(edit('camera-name','Second edit','VENICE 2 test'));
  assert.equal(store.pending.length,2);assert.equal(calls,1);
  release();await until(()=>store.pending.length===0);
  store.history(false);await until(()=>store.pending.length===0);
  store.history(false);assert.deepEqual(visibleFields(store.document.view),[]);
  await until(()=>store.pending.length===0);
});

test('failed paint and dependent text sizing roll back while unrelated cell edits survive',async()=>{
  let saved=defaultDocument(),release!:()=>void,calls=0;
  const held=new Promise<void>(resolve=>release=resolve);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1){await held;throw Error('Paint save rejected');}
    saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  let expected=clone(store.document.view);
  store.submit({kind:'view',expected,view:withColumnVisibility(expected,[{id:cameraField.id,visible:true},{id:reelField.id,visible:true}])});
  expected=clone(store.document.view);store.submit({kind:'view',expected,view:{...expected,textSize:18}});
  store.submit(edit('camera-name','Preserved edit','VENICE 2 test'));
  assert.equal(store.document.view.textSize,18);assert.equal(store.pending.length,3);
  release();await until(()=>store.pending.length===0);
  assert.equal(store.document.view.textSize,13);assert.deepEqual(visibleFields(store.document.view),[]);
  assert.equal(saved.cameras[0]!.values['camera-name'],'Preserved edit');
});

test('validates text sizing bounds and preserves unrelated preferences in a visibility batch',()=>{
  const document=defaultDocument();document.view.textSize=19;document.view.widths[cameraField.id]=234;
  const next=withColumnVisibility(document.view,[{id:cameraField.id,visible:true},{id:'exposure',visible:false}]);
  assert.equal(next.textSize,19);assert.equal(next.widths[cameraField.id],234);
  for(const textSize of [9,24])assert.doesNotThrow(()=>validateDocument({...document,view:{...next,textSize}}));
  for(const textSize of [8,25,13.5,NaN])assert.throws(()=>validateDocument({...document,view:{...next,textSize}}),/text size/);
});

test('camera wire encodings preserve verified string types and compound controls',()=>{
  const row=defaultDocument().cameras[0]!;
  assert.deepEqual(encodeField(cameraField,'C',row,{[cameraField.property]:'66'}),{[cameraField.property]:'67'});
  assert.deepEqual(encodeField(reelField,'101',row,{[reelField.property]:'1'}),{[reelField.property]:'101'});
  assert.deepEqual(encodeField(sdiField,'FALSE',row,{[sdiField.property]:'1'}),{[sdiField.property]:'0'});
  const fps=fields.find(f=>f.id==='shooting-fps')!;
  assert.deepEqual(encodeField(fps,'23.98',row,{'Camera.SlowAndQuickMotion.Enabled':true}),{'Camera.SlowAndQuickMotion.Enabled':true,'Camera.SlowAndQuickMotion.FrameRate':2398,'Camera.SlowAndQuickMotion.FrameRate.Denominator':100});
  assert.equal(decodeField(fps,{}),'');
  assert.equal(decodeField(fields.find(f=>f.id==='shutter-angle')!,{'Camera.Shutter.Angle.DisplayValue':'180.0'}),'180.0');
});

test('acknowledgment waits for readback and never replays the write',async()=>{
  const row=defaultDocument().cameras[0]!,signal=new AbortController().signal;
  let writes=0,reads=0;
  const client={close(){},async rpc(method:string){
    if(method==='Property.GetStatus')return {[cameraField.property]:'Unlocked'};
    if(method==='Property.SetValue'){writes++;return null;}
    reads++;return {[cameraField.property]:reads<3?'66':'67'};
  }};
  const after=await writeField(client,cameraField,'C',row,signal);
  assert.equal(writes,1);assert.equal(after[cameraField.property],'67');
  let blockedWrites=0;
  await assert.rejects(writeField({close(){},async rpc(method){if(method==='Property.SetValue')blockedWrites++;return {[cameraField.property]:method==='Property.GetStatus'?'Locked':'66'};}},cameraField,'C',row,signal),/locked/);
  assert.equal(blockedWrites,0);
});

test('disabled startup and local edits use documents without opening device I/O',async()=>{
  let document:any={id:'camera-plan',version:1,revision:null,value:defaultDocument()},writes=0;
  const services={async request(_service:string,_version:number,input:any,signal:AbortSignal){
    assert.equal(_service,'documents');
    if(input.method==='watch')return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    if(input.method==='write'){writes++;document={...document,revision:'saved',value:input.value};}
    return {status:'document',document};
  }};
  const harness=createModuleHarness(module,{}, {connectionEnabled:false,services:services as any});
  await harness.instance.start?.();assert.equal(writes,0);
  await harness.instance.call!('page.cameras',{sectionId:'frontend',commandId:'save',value:{operation:edit(reelField.id,'101')} as any},harness.execution());
  assert.equal(writes,1);
  await harness.instance.call!('page.cameras',{sectionId:'frontend',commandId:'save',value:{operation:edit('camera-password','never-publish-this-canary')} as any},harness.execution());
  await assert.rejects(async()=>await harness.instance.call!('page.cameras',{sectionId:'frontend',commandId:'refresh',value:{rowId:'venice-tested-body',host:'192.0.2.109'}},harness.execution()),/disabled/);
  assert.ok(!JSON.stringify(harness.states).includes('never-publish-this-canary'));
  await harness.instance.dispose?.();await harness.instance.dispose?.();
});

test('fresh Digest and Savona authentication work against a loopback camera simulator',async()=>{
  const values:Record<string,string>={[cameraField.property]:'66'},headers:string[]=[],requests:string[]=[],writes:unknown[]=[];
  const nonces=new Set<string>();
  const verifyDigest=(header:string,uri:string)=>{
    const p=Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1]!,m[2]??m[3]!]));
    assert.ok(nonces.has(p.nonce!));assert.equal(p.uri,uri);assert.equal(p.username,'fixture-user');
    const md5=(s:string)=>crypto.createHash('md5').update(s).digest('hex');
    assert.equal(p.response,md5([md5('fixture-user:fixture:fixture-password'),p.nonce,p.nc,p.cnonce,'auth',md5('GET:'+uri)].join(':')));
  };
  const server=http.createServer((request,response)=>{
    if(request.url==='/rmt.html'){const nonce=crypto.randomBytes(12).toString('hex');nonces.add(nonce);response.writeHead(401,{'WWW-Authenticate':'Digest realm="fixture", nonce="'+nonce+'", algorithm=MD5, qop="auth"'});response.end();return;}
    headers.push(String(request.headers.authorization));
    verifyDigest(String(request.headers.authorization),request.url!);
    if(request.url==='/cgi-bin/getsavonacred.cgi'){response.writeHead(200);response.end('internal:fixture-session-secret');return;}
    response.writeHead(404);response.end();
  });
  const ws=new WebSocketServer({server});
  ws.on('connection',(socket,request)=>{
    headers.push(String(request.headers.authorization));
    verifyDigest(String(request.headers.authorization),'/linear');
    socket.on('message',bytes=>{
      const [type,id,method,args]=decode(bytes as Uint8Array) as any[];assert.equal(type,0);requests.push(method);
      const params=args[0];let result:any=null;
      if(method==='Alternate.Authentication.Basic')assert.deepEqual(params,{username:'internal',password:'fixture-session-secret'});
      else if(method==='Property.GetValue')result=Object.fromEntries(Object.keys(params).map(key=>[key,values[key]]));
      else if(method==='Property.GetStatus')result=Object.fromEntries(Object.keys(params).map(key=>[key,'Unlocked']));
      else if(method==='Property.SetValue'){writes.push(params);setTimeout(()=>Object.assign(values,params),20);}
      socket.send(encode([1,id,null,result]));
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as any).port,abort=new AbortController();
  let client:CameraClient|undefined;
  try {
    client=await CameraClient.connect('127.0.0.1:'+port,{username:'fixture-user',password:'fixture-password'},abort.signal);
    const after=await writeField(client,cameraField,'C',defaultDocument().cameras[0]!,abort.signal);
    assert.equal(after[cameraField.property],'67');assert.deepEqual(writes,[{[cameraField.property]:'67'}]);
    assert.ok(headers.length===2&&headers.every(h=>h.startsWith('Digest ')&&h.includes('cnonce=')));
    assert.ok(!headers.some(h=>h.includes('fixture-password')));
    assert.equal(requests[0],'Alternate.Authentication.Basic');
  }finally{client?.close();abort.abort();for(const socket of ws.clients)socket.terminate();await new Promise<void>(r=>ws.close(()=>server.close(()=>r())));}
});

const reel=reelField.id;
const heldStore=(fail=false)=>{
  let saved=defaultDocument(),release!:()=>void,calls=0;
  const held=new Promise<void>(r=>release=r);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1){await held;if(fail)throw Error('Tab save rejected');}
    saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  return {store,release:()=>release(),saved:()=>saved};
};

test('a plan from before tabs reads as one tab and is left alone until a tab is made',()=>{
  const doc=defaultDocument();
  assert.equal('sheets' in doc,false);
  assert.deepEqual(sheetList(doc).map(sheet=>[sheet.id,sheet.name,sheet.orientation]),[['settings','Settings','rows']]);
  const edited=applyMutation(doc,edit(reel,'101'));
  assert.equal('sheets' in edited,false);
  const expected=clone(doc.view);
  assert.equal('sheets' in applyMutation(doc,{kind:'view',view:{...expected,textSize:15},expected}),false);
  assert.equal(activeSheetId(applyMutation(doc,addSheet(doc,'two','Two'))),'two');
});

test('each tab keeps its own settings and orientation, and the open tab stays in the older layout field',()=>{
  let doc=defaultDocument();
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:reel,visible:true}])));
  doc=applyMutation(doc,addSheet(doc,'network','Network'));
  assert.deepEqual(visibleFields(doc.view).map(f=>f.id),[reel],'a new tab starts as a copy');
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:reel,visible:false},{id:cameraField.id,visible:true}])));
  doc=applyMutation(doc,setOrientation(doc,'network','columns'));
  assert.deepEqual(visibleFields(doc.view).map(f=>f.id),[cameraField.id]);
  assert.equal(isFlipped(doc),true);
  assert.equal(doc.sheets!.find(sheet=>sheet.id==='network')!.view,undefined,'the open tab lives in document.view');
  doc=applyMutation(doc,{kind:'select-sheet',sheetId:'settings'});
  assert.deepEqual(visibleFields(doc.view).map(f=>f.id),[reel]);
  assert.equal(isFlipped(doc),false);
  assert.deepEqual(sheetList(doc).map(sheet=>visibleFields(sheet.view).map(f=>f.id)),[[reel],[cameraField.id]]);
});

test('tabs can be renamed, moved and removed, but never the last one',()=>{
  let doc=applyMutation(defaultDocument(),addSheet(defaultDocument(),'b','B'));
  doc=applyMutation(doc,addSheet(doc,'c','C'));
  doc=applyMutation(doc,renameSheet(doc,'b','Bee'));
  assert.deepEqual(sheetList(doc).map(sheet=>sheet.name),['Settings','Bee','C']);
  doc=applyMutation(doc,moveSheet(doc,'c','settings')!);
  assert.deepEqual(sheetList(doc).map(sheet=>sheet.id),['c','settings','b']);
  assert.equal(moveSheet(doc,'c','settings'),null,'moving to where it already is changes nothing');
  doc=applyMutation(doc,moveSheet(doc,'c',null)!);
  assert.deepEqual(sheetList(doc).map(sheet=>sheet.id),['settings','b','c']);
  assert.equal(activeSheetId(doc),'c');
  doc=applyMutation(doc,removeSheet(doc,'c')!);
  assert.equal(activeSheetId(doc),'b','removing the open tab opens its neighbour');
  doc=applyMutation(doc,removeSheet(doc,'b')!);
  assert.equal(removeSheet(doc,'settings'),null);
});

test('undo reaches a change made on another tab and opens that tab',async()=>{
  let saved=defaultDocument();
  const store=new DraftStore({document:saved,revision:null},async operation=>{saved=applyMutation(saved,operation);return {document:saved,revision:'r'};});
  const settle=()=>until(()=>store.pending.length===0);
  store.submit(viewChange(store.document,{...clone(store.document.view),textSize:20}));
  store.submit(addSheet(store.document,'two','Two'));
  store.submit({kind:'select-sheet',sheetId:'two'},false);
  await settle();
  store.history(false);await settle();
  assert.deepEqual(sheetList(store.document).map(sheet=>sheet.id),['settings'],'undo removes the tab');
  store.history(false);await settle();
  assert.equal(store.document.view.textSize,13);
  store.history(true);store.history(true);await settle();
  assert.deepEqual(sheetList(store.document).map(sheet=>sheet.id),['settings','two']);
  assert.equal(activeSheetId(store.document),'two');
  store.submit({kind:'select-sheet',sheetId:'settings'},false);await settle();
  store.submit(viewChange(store.document,{...clone(store.document.view),textSize:16}));
  store.submit({kind:'select-sheet',sheetId:'two'},false);await settle();
  store.history(false);await settle();
  assert.equal(activeSheetId(store.document),'settings','undo opens the tab it changed');
  assert.equal(store.document.view.textSize,20);
});

test('a new tab shows before its save, and a second edit lands while the first save is held',async()=>{
  const {store,release,saved}=heldStore();
  store.submit(addSheet(store.document,'held','Held'));
  assert.equal(activeSheetId(store.document),'held');
  store.submit(setOrientation(store.document,'held','columns'));
  store.submit(edit('camera-name','Second edit','VENICE 2 test'));
  assert.equal(isFlipped(store.document),true);
  assert.equal(store.document.cameras[0]!.values['camera-name'],'Second edit');
  assert.equal('sheets' in saved(),false,'nothing is saved yet');
  release();await until(()=>store.pending.length===0);
  assert.deepEqual(saved().sheets!.map(sheet=>[sheet.id,sheet.orientation]),[['settings','rows'],['held','columns']]);
  assert.equal(saved().cameras[0]!.values['camera-name'],'Second edit');
  assert.equal(isFlipped(store.document),true);
});

test('a rejected new tab goes away with what depended on it, and later cell edits survive',async()=>{
  const {store,release,saved}=heldStore(true);
  store.submit(addSheet(store.document,'doomed','Doomed'));
  store.submit(viewChange(store.document,{...clone(store.document.view),textSize:21}));
  store.submit(edit('camera-name','Survives','VENICE 2 test'));
  assert.equal(activeSheetId(store.document),'doomed');
  release();await until(()=>store.pending.length===0);
  assert.deepEqual(sheetList(store.document).map(sheet=>sheet.id),['settings']);
  assert.equal(activeSheetId(store.document),'settings');
  assert.equal(store.document.view.textSize,13);
  assert.match(store.error,/tab was removed/);
  assert.equal(saved().cameras[0]!.values['camera-name'],'Survives');
});

test('non-default tabs and flipped sizes survive a portable round trip and an older reader',()=>{
  let doc=applyMutation(defaultDocument(),edit(reel,'101'));
  doc=applyMutation(doc,addSheet(doc,'lens-free','Exposure'));
  doc=applyMutation(doc,viewChange(doc,{...withColumnVisibility(doc.view,[{id:cameraField.id,visible:true}]),textSize:18,cameraWidths:{'venice-tested-body':260},settingHeights:{[cameraField.id]:48,'connection-status':40},settingLabelWidth:300}));
  doc=applyMutation(doc,setOrientation(doc,'lens-free','columns'));
  doc=applyMutation(doc,{kind:'select-sheet',sheetId:'settings'});
  const alerts={offlineNotification:true,offlineBounce:false,onlineNotification:true};
  doc=applyMutation(doc,{kind:'alerts',alerts,expected:alertChoices(doc)});
  const imported=validateDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(imported,doc);
  assert.deepEqual(alertChoices(imported),alerts);
  // Stored keys may come back in another order; the next alert change must still match.
  const shuffled=clone(imported);shuffled.alerts={onlineNotification:true,offlineBounce:false,offlineNotification:true};
  assert.equal(alertChoices(applyMutation(shuffled,{kind:'alerts',alerts:{...alerts,offlineBounce:true},expected:alertChoices(shuffled)})).offlineBounce,true);
  const tab=sheetList(imported).find(sheet=>sheet.id==='lens-free')!;
  assert.equal(tab.orientation,'columns');assert.equal(tab.view.textSize,18);
  assert.equal(tab.view.cameraWidths!['venice-tested-body'],260);assert.equal(tab.view.settingHeights![cameraField.id],48);assert.equal(tab.view.settingLabelWidth,300);
  assert.deepEqual(visibleFields(tab.view).map(f=>f.id),[cameraField.id]);
  // Key order may change in storage; a later edit must still match.
  const reordered=JSON.parse(JSON.stringify(imported));reordered.sheets[1]={view:reordered.sheets[1].view,orientation:reordered.sheets[1].orientation,name:reordered.sheets[1].name,id:reordered.sheets[1].id};
  assert.doesNotThrow(()=>applyMutation(reordered,renameSheet(imported,'lens-free','Renamed')));
  assert.deepEqual(applyMutation(doc,edit(reel,'102','101')).sheets,doc.sheets);
});

test('rejects tabs and flipped sizes the page could not show',()=>{
  const doc=applyMutation(defaultDocument(),addSheet(defaultDocument(),'b','B'));
  const bad=(change:(value:any)=>void)=>{const value=clone(doc) as any;change(value);return ()=>validateDocument(value);};
  assert.throws(bad(v=>{v.sheets[1].id=v.sheets[0].id;v.activeSheetId=v.sheets[0].id;}),/identity/);
  assert.throws(bad(v=>{v.sheets[1].name='settings';}),/own name/);
  assert.throws(bad(v=>{v.sheets[1].name='x'.repeat(65);}),/own name/);
  assert.throws(bad(v=>{v.sheets[0].orientation='sideways';}),/layout/);
  assert.throws(bad(v=>{v.activeSheetId='gone';}),/open tab/);
  assert.throws(bad(v=>{v.sheets=[];}),/tabs/);
  assert.throws(bad(v=>{delete v.sheets[0].view;}));
  assert.throws(bad(v=>{v.view.cameraWidths={a:9000};}),/camera width/);
  assert.throws(bad(v=>{v.view.settingHeights={nope:40};}),/setting height/);
  assert.throws(bad(v=>{v.view.settingLabelWidth=20;}),/name width/);
  assert.throws(()=>{let many=doc;for(let i=0;i<40;i++)many=applyMutation(many,addSheet(many,'s'+i,'S'+i));},/tabs/);
});

let nextCamera=0;
const newCamera=()=>'camera-'+(++nextCamera);
test('setting a camera count adds blank rows or trims the end as one undo step',async()=>{
  let saved=defaultDocument();
  const store=new DraftStore({document:saved,revision:null},async operation=>{saved=applyMutation(saved,operation);return {document:saved,revision:'r'};});
  const settle=()=>until(()=>store.pending.length===0);
  store.submit(setCameraCount(store.document,4,newCamera)!);
  assert.deepEqual(store.document.cameras.map(c=>c.values['camera-name']),['VENICE 2 test','Camera 2','Camera 3','Camera 4']);
  assert.deepEqual(store.document.cameras.map(c=>c.values['camera-host']),['192.0.2.109','','','']);
  await settle();
  assert.equal(setCameraCount(store.document,4,newCamera),null);
  assert.throws(()=>setCameraCount(store.document,25,newCamera),/from 0 to 24/);
  assert.throws(()=>setCameraCount(store.document,2.5,newCamera),/from 0 to 24/);
  assert.throws(()=>setCameraCount(store.document,NaN,newCamera),/from 0 to 24/);
  const before=clone(store.document.cameras);
  store.submit(setCameraCount(store.document,1,newCamera)!);await settle();
  assert.equal(saved.cameras.length,1);
  store.history(false);await settle();
  assert.deepEqual(store.document.cameras,before,'undo returns them in order');
  store.history(false);await settle();
  assert.equal(store.document.cameras.length,1);
  assert.deepEqual(applyMutation(defaultDocument(),setCameraCount(defaultDocument(),0,newCamera)!).cameras,[]);
});

test('a blank address is allowed, a bad one is not',()=>{
  const doc=applyMutation(defaultDocument(),setCameraCount(defaultDocument(),2,newCamera)!),id=doc.cameras[1]!.id;
  const set=(columnId:string,value:string,expected:string,from=doc)=>applyMutation(from,{kind:'edit',edits:[{rowId:id,columnId,value,expected}]});
  assert.doesNotThrow(()=>validateDocument(doc));
  const filled=set('camera-host','192.0.2.2','');
  assert.equal(filled.cameras[1]!.values['camera-host'],'192.0.2.2');
  assert.doesNotThrow(()=>set('camera-host','','192.0.2.2',filled));
  assert.throws(()=>set('camera-host','10.0.0.999',''),/valid hostname/);
  assert.throws(()=>set('camera-name','','Camera 2'),/camera name/);
});

test('only rows someone filled in need confirming before they go',()=>{
  assert.equal(cameraHasData({id:'a',values:{'camera-name':'Camera 7','camera-host':''}}),false);
  assert.equal(cameraHasData({id:'a',values:{'camera-name':'Wide','camera-host':''}}),true);
  assert.equal(cameraHasData({id:'a',values:{'camera-name':'Camera 7','camera-host':'10.0.0.1'}}),true);
  assert.equal(cameraHasData({id:'a',values:{'camera-name':'Camera 7','camera-host':'','camera-password':'x'}}),true);
});

test('logins are saved sheet values with limits, and the Login section can be hidden per tab',()=>{
  let doc=applyMutation(defaultDocument(),edit('camera-username','admin'));
  doc=applyMutation(doc,edit('camera-password','s3cret'));
  assert.equal(validateDocument(JSON.parse(JSON.stringify(doc))).cameras[0]!.values['camera-password'],'s3cret');
  assert.throws(()=>applyMutation(doc,edit('camera-username','x'.repeat(257),'admin')),/up to 256/);
  assert.throws(()=>applyMutation(doc,edit('camera-password','a\nb','s3cret')),/control/);
  assert.equal(fields.some(f=>f.id==='camera-password'),false,'a login is never a setting to send');
  const hiddenOne=withColumnVisibility(doc.view,[{id:'camera-password',visible:false}]);
  assert.equal(loginVisible(hiddenOne,'camera-password'),false);assert.equal(loginVisible(hiddenOne,'camera-username'),true);
  const hiddenAll=withColumnVisibility(hiddenOne,[{id:'login',visible:false}]);
  assert.equal(loginVisible(hiddenAll,'camera-username'),false);
  assert.deepEqual(withColumnVisibility(hiddenAll,[{id:'camera-username',visible:true}]).hiddenLogin,['camera-password']);
  assert.doesNotThrow(()=>validateDocument({...doc,view:{...hiddenAll,widths:{'camera-username':150,'camera-password':140},settingHeights:{'camera-password':44}}}));
  assert.throws(()=>validateDocument({...doc,view:{...doc.view,hiddenLogin:['nope']}}),/hidden login/);
});

test('a count change shows at once and a rejected one rolls back while later edits stay',async()=>{
  let saved=defaultDocument(),release!:()=>void,calls=0;
  const held=new Promise<void>(r=>release=r);
  const store=new DraftStore({document:saved,revision:null},async operation=>{
    if(++calls===1){await held;throw Error('Count save rejected');}
    saved=applyMutation(saved,operation);return {document:saved,revision:String(calls)};
  });
  store.submit(setCameraCount(store.document,3,newCamera)!);
  assert.equal(store.document.cameras.length,3);
  store.submit(edit('camera-name','Survives','VENICE 2 test'));
  release();await until(()=>store.pending.length===0);
  assert.equal(store.document.cameras.length,1);
  assert.equal(saved.cameras[0]!.values['camera-name'],'Survives');
  assert.match(store.error,/Count save rejected/);
});

test('Refresh uses a saved login, needs one when there is none, and refuses a blank address',async()=>{
  const value=defaultDocument();value.cameras[0]!.values['camera-host']='127.0.0.1:1';
  const blank=clone(value);blank.cameras[0]!.values['camera-host']='';
  const withLogin=clone(value);withLogin.cameras[0]!.values['camera-username']='fixture-user';withLogin.cameras[0]!.values['camera-password']='never-publish-this-canary';
  const run=async(doc:typeof value)=>{
    const document:any={id:'camera-plan',version:1,revision:'one',value:doc};
    const services={async request(_service:string,_version:number,input:any,signal:AbortSignal){
      if(input.method==='watch')return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
      return {status:'document',document};
    }};
    const harness=createModuleHarness(module,{}, {connectionEnabled:true,services:services as any});
    await harness.instance.start?.();
    try {
      await harness.instance.call!('page.cameras',{sectionId:'frontend',commandId:'refresh',value:{rowId:'venice-tested-body',host:doc.cameras[0]!.values['camera-host']!,fieldIds:[cameraField.id]}},harness.execution());
      return {message:'read',states:harness.states};
    } catch(error){return {message:(error as Error).message,states:harness.states};}
    finally{await harness.instance.dispose?.();}
  };
  assert.match((await run(blank)).message,/IP address first/);
  assert.match((await run(value)).message,/Username and Password first/);
  const saved=await run(withLogin);
  assert.doesNotMatch(saved.message,/Username and Password first|IP address first/,'it went on to try the camera');
  assert.ok(!JSON.stringify(saved.states).includes('never-publish-this-canary'));
});

test('a tab counts every row it shows, including the login rows',()=>{
  let doc=applyMutation(defaultDocument(),setCameraCount(defaultDocument(),9,newCamera)!);
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:cameraField.id,visible:true},{id:reelField.id,visible:true}])));
  const list=()=>sheetList(doc)[0]!;
  assert.equal(sheetRowCount(doc,list()),9,'cameras in rows counts cameras');
  doc=applyMutation(doc,setOrientation(doc,'settings','columns'));
  assert.equal(sheetRowCount(doc,list()),8,'camera, address, recording, connection, username, password and two settings');
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:'camera-password',visible:false}])));
  assert.equal(sheetRowCount(doc,list()),7);
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:'login',visible:false}])));
  assert.equal(sheetRowCount(doc,list()),6);
});

test('clearing all columns empties one tab, and anything ticked afterwards shows alone',()=>{
  let doc=defaultDocument();
  doc=applyMutation(doc,viewChange(doc,withColumnVisibility(doc.view,[{id:cameraField.id,visible:true},{id:reelField.id,visible:true}])));
  doc=applyMutation(doc,addSheet(doc,'empty','Empty'));
  const before=clone(doc.view);
  doc=applyMutation(doc,viewChange(doc,withNoColumns(doc.view)));
  assert.deepEqual(visibleFields(doc.view),[]);
  assert.equal(loginVisible(doc.view,'camera-username'),false);
  assert.deepEqual(doc.view.hiddenGroups,groups.map(g=>g.id));
  assert.deepEqual(sheetList(doc).find(s=>s.id==='settings')!.view.collapsed.identity!.length>0,true,'other tabs keep their columns');
  const ticked=withColumnVisibility(doc.view,[{id:reelField.id,visible:true}]);
  assert.deepEqual(visibleFields(ticked).map(f=>f.id),[reelField.id]);
  assert.equal(ticked.hiddenGroups!.includes('identity'),false);
  assert.equal(loginVisible(withColumnVisibility(doc.view,[{id:'camera-username',visible:true}]),'camera-username'),true);
  assert.deepEqual(inverseView(doc,before),before,'undo puts the layout back');
});
function inverseView(doc:ReturnType<typeof defaultDocument>,before:ReturnType<typeof defaultDocument>['view']){
  return applyMutation(doc,{kind:'view',view:before,expected:clone(doc.view)}).view;
}

test('status for a removed or re-addressed camera is dropped without any saved session',async()=>{
  const first=defaultDocument();first.cameras[0]!.values['camera-host']='127.0.0.1:1';first.cameras[0]!.values['camera-username']='u';first.cameras[0]!.values['camera-password']='p';
  let document:any={id:'camera-plan',version:1,revision:'one',value:first},push!:(value:any)=>void;
  const change=new Promise<any>(resolve=>push=resolve);let watches=0;
  const services={async request(_service:string,_version:number,input:any,signal:AbortSignal){
    if(input.method==='watch'){if(++watches===1){document=await change;return {status:'document',document};}return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}
    return {status:'document',document};
  }};
  const harness=createModuleHarness(module,{}, {connectionEnabled:true,services:services as any});
  await harness.instance.start?.();
  const seen=()=>Object.keys((harness.states.at(-1) as any).values.observations);
  try {
    assert.equal((await harness.instance.call!('page.cameras',{sectionId:'frontend',commandId:'refresh',value:{rowId:'venice-tested-body',host:'127.0.0.1:1',fieldIds:[cameraField.id]}},harness.execution()) as any).status,'offline');
    assert.deepEqual(seen(),['venice-tested-body']);
    const next=clone(first);next.cameras=[];
    push({id:'camera-plan',version:1,revision:'two',value:next});
    await until(()=>seen().length===0);
  } finally {await harness.instance.dispose?.();}
});

// Everything below talks to loopback fake cameras only.
const pause=(ms:number)=>delay(ms);
const signalNow=()=>new AbortController().signal;
test('only an explicit Locked stops a write, and status is asked the way the camera expects',async()=>{
  const row=defaultDocument().cameras[0]!;
  for(const answer of [undefined,null,'Available','Unlocked',{cam:'Unlocked'}]){
    let writes=0,asked:any;
    const client={close(){},async rpc(method:string,params:any){
      if(method==='Property.GetStatus'){asked=params;return {[reelField.property]:answer};}
      if(method==='Property.SetValue'){writes++;return null;}
      return {[reelField.property]:writes?'101':'1'};
    }};
    await writeField(client,reelField,'101',row,signalNow());
    assert.equal(writes,1,'status '+JSON.stringify(answer)+' should still write');
    assert.deepEqual(asked,{[reelField.property]:null});
  }
  let writes=0;
  await writeField({close(){},async rpc(method:string){
    if(method==='Property.GetStatus')throw Error('Camera rejected the request (-1).');
    if(method==='Property.SetValue'){writes++;return null;}
    return {[reelField.property]:writes?'101':'1'};
  }},reelField,'101',row,signalNow());
  assert.equal(writes,1,'a status query the camera refuses should not stop the write');
  for(const answer of ['Locked',{cam:'Locked'}]){
    let blocked=0;
    await assert.rejects(writeField({close(){},async rpc(method:string){
      if(method==='Property.GetStatus')return {[reelField.property]:answer};
      if(method==='Property.SetValue')blocked++;
      return {[reelField.property]:'1'};
    }},reelField,'101',row,signalNow()),/locked/);
    assert.equal(blocked,0);
  }
});

function cameraPlan(hosts:string[],staged:Record<string,string>[]=[],alerts?:AlertChoices,extra:{live?:boolean;view?:View}={}){
  const plan=defaultDocument();
  if(alerts)plan.alerts=alerts;
  if(extra.live!==undefined)plan.live=extra.live;
  if(extra.view)plan.view=extra.view;
  plan.cameras=hosts.map((host,index)=>({id:'cam-'+index,values:{'camera-name':'Camera '+(index+1),'camera-host':host,'camera-username':'operator','camera-password':'fixture-password',...staged[index]}}));
  let document:any={id:'camera-plan',version:1,revision:'1',value:plan},saves=1;
  const services={async request(_service:string,_version:number,input:any,signal:AbortSignal){
    if(input.method==='watch')return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    if(input.method==='write')document={...document,revision:String(++saves),value:input.value};
    return {status:'document',document};
  }};
  return {services,saved:()=>document.value as ReturnType<typeof defaultDocument>};
}
// The open tab showing only these settings, which is what Live follows.
const showing=(...ids:string[]):View=>withColumnVisibility(withNoColumns(defaultDocument().view),ids.map(id=>({id,visible:true})));
// The page's Live switch: saved with the plan, never an Undo step.
const switchLive=(run:(commandId:string,value:any)=>Promise<any>,on:boolean)=>run('save',{operation:{kind:'live',live:on,expected:!on}});
const startBackend=async(plan:ReturnType<typeof cameraPlan>)=>{
  const harness=createModuleHarness(module,{}, {connectionEnabled:true,services:plan.services as any});
  await harness.instance.start?.();
  const run=(commandId:string,value:any)=>harness.instance.call!('page.cameras',{sectionId:'frontend',commandId,value},harness.execution()) as Promise<any>;
  const last=()=>(harness.states.at(-1) as any).values.observations as Record<string,any>;
  return {harness,run,last};
};

test('Refresh reads every camera at once, asks only for the requested settings and treats an absent camera as offline',async()=>{
  const reelProperty=reelField.property,idProperty=cameraField.property;
  const first=await fakeCamera({values:{[reelProperty]:'1',[idProperty]:'65'},readDelay:150}),second=await fakeCamera({values:{[reelProperty]:'2',[idProperty]:'66'},readDelay:150}),missing=await absentCameraHost();
  const plan=cameraPlan([first.host,second.host,missing],[{[sdiField.id]:'TRUE'}]);
  const {harness,run,last}=await startBackend(plan);
  try {
    const started=Date.now();
    const replies=await Promise.all(plan.saved().cameras.map(row=>run('refresh',{rowId:row.id,host:row.values['camera-host'],fieldIds:[reelField.id]})));
    assert.ok(Date.now()-started<280,'cameras should be read side by side, took '+(Date.now()-started)+'ms');
    assert.equal(replies[2].status,'offline');
    assert.equal(last()['cam-0'].state,'online');assert.equal(last()['cam-1'].values[reelField.id],'2');assert.equal(last()['cam-2'].state,'offline');
    assert.deepEqual(first.reads,[[reelProperty,'Clip.Mediabox.ClipName','Clip.Mediabox.Status','Storage.Media.Recording','Storage.Media.Recordable']],'a staged but hidden setting must not be read; the reel brings its clip name');
    await second.close();
    assert.equal((await run('refresh',{rowId:'cam-1',host:second.host,fieldIds:[reelField.id]})).status,'offline');
    assert.equal(last()['cam-1'].state,'offline');assert.deepEqual(last()['cam-1'].values,{},'a camera that went away keeps no old values');
  } finally {await harness.instance.dispose?.();await first.close();await second.close();}
});

const threeStaged={[reelField.id]:'101',[cameraField.id]:'C',[sdiField.id]:'FALSE'};
const threeValues={[reelField.property]:'1',[cameraField.property]:'65',[sdiField.property]:'1'};
const threeIds=[reelField.id,cameraField.id,sdiField.id];
test('Cancel stops queued settings while one is being written',async()=>{
  const camera=await fakeCamera({values:threeValues,writeDelay:150});
  const plan=cameraPlan([camera.host],[threeStaged]);
  const {harness,run,last}=await startBackend(plan);
  try {
    const sending=run('send',{rowId:'cam-0',host:camera.host,fieldIds:threeIds});
    await until(()=>camera.writes.length===1);
    assert.deepEqual(last()['cam-0'].sending,[reelField.id]);assert.deepEqual(last()['cam-0'].queued,[cameraField.id,sdiField.id]);
    await run('cancel-send',{rowId:'cam-0',fieldIds:[sdiField.id]});
    assert.deepEqual(last()['cam-0'].queued,[cameraField.id]);
    const reply=await sending;
    assert.deepEqual(reply.outcomes.map((o:any)=>o.fieldId),[reelField.id,cameraField.id]);
    assert.equal(camera.writes.length,2);assert.ok(!camera.writes.some(w=>sdiField.property in w));
    assert.deepEqual(last()['cam-0'].queued,[]);
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('Cancel during the camera login stops everything',async()=>{
  const camera=await fakeCamera({values:threeValues,loginDelay:80});
  const {harness,run,last}=await startBackend(cameraPlan([camera.host],[threeStaged]));
  try {
    const sending=run('send',{rowId:'cam-0',host:camera.host,fieldIds:threeIds});
    await until(()=>last()['cam-0']?.queued.length===3);
    await run('cancel-send',{rowId:'cam-0'});
    assert.deepEqual((await sending).outcomes,[]);assert.equal(camera.writes.length,0);
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('a change cleared from the plan after Send started never reaches the camera',async()=>{
  const camera=await fakeCamera({values:threeValues,writeDelay:120});
  const plan=cameraPlan([camera.host],[threeStaged]);
  const {harness,run}=await startBackend(plan);
  try {
    const sending=run('send',{rowId:'cam-0',host:camera.host,fieldIds:threeIds});
    await until(()=>camera.writes.length===1);
    await run('save',{operation:{kind:'edit',edits:[{rowId:'cam-0',columnId:cameraField.id,value:'',expected:'C'}]}});
    await sending;
    assert.ok(!camera.writes.some(w=>cameraField.property in w));assert.equal(camera.writes.length,2);
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('a Locked setting is not written and is reported on that setting, and a retry clears the old failure',async()=>{
  let locked=true;
  const camera=await fakeCamera({values:{[reelField.property]:'1'},status:()=>locked?'Locked':undefined});
  const plan=cameraPlan([camera.host],[{[reelField.id]:'101'}]);
  const {harness,run,last}=await startBackend(plan);
  try {
    const reply=await run('send',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    assert.equal(reply.outcomes[0].status,'failed');assert.match(last()['cam-0'].errors[reelField.id],/locked/);assert.equal(camera.writes.length,0);
    locked=false;
    await run('send',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    assert.equal(camera.writes.length,1);assert.deepEqual(last()['cam-0'].errors,{});assert.equal(last()['cam-0'].values[reelField.id],'101');
    assert.ok(!JSON.stringify(harness.states).includes('fixture-password'));
    await pause(0);
  } finally {await harness.instance.dispose?.();await camera.close();}
});

// 192.0.2.1 is reserved for documentation, so nothing on any network answers it.
const silentAddress='192.0.2.1';
test('ping tells an answering address from a silent one and ignores a port',async()=>{
  assert.equal(await pingCamera('127.0.0.1',signalNow()),'answered');
  assert.equal(await pingCamera('127.0.0.1:8080',signalNow()),'answered');
  assert.equal(await pingCamera(silentAddress,signalNow()),'silent');
});

test('a camera that does not answer the ping is offline with no login attempt, for Refresh and for Send',async()=>{
  const plan=cameraPlan([silentAddress],[{[reelField.id]:'101'}]);
  const {harness,run,last}=await startBackend(plan);
  try {
    const started=Date.now();
    assert.equal((await run('refresh',{rowId:'cam-0',host:silentAddress,fieldIds:[reelField.id]})).status,'offline');
    assert.ok(Date.now()-started<3500,'a login attempt would have taken longer, took '+(Date.now()-started)+'ms');
    assert.equal(last()['cam-0'].state,'offline');
    await assert.rejects(run('send',{rowId:'cam-0',host:silentAddress,fieldIds:[reelField.id]}),/ping/);
    assert.equal(last()['cam-0'].state,'offline');assert.deepEqual(last()['cam-0'].queued,[]);
  } finally {await harness.instance.dispose?.();}
});

test('whenSaved waits for held saves, and a confirmed value leaves the plan and the Undo history',async()=>{
  const {store,release}=heldStore();
  store.submit(edit(reel,'101'));
  let saved=false;void store.whenSaved().then(()=>{saved=true;});
  await pause(10);assert.equal(saved,false);
  release();await until(()=>saved);
  store.submit(edit(cameraField.id,'C'));await store.whenSaved();
  store.confirm([{rowId:'venice-tested-body',columnId:reel,value:'',expected:'101'}]);await store.whenSaved();
  assert.equal(store.document.cameras[0]!.values[reel],'');assert.equal(store.undo.length,1);
  store.history(false);await store.whenSaved();
  assert.equal(store.error,'');assert.equal(store.document.cameras[0]!.values[cameraField.id],'');
  store.history(false);await store.whenSaved();assert.equal(store.error,'');
});

test('a refused save leaves nothing in Undo that could jam it',async()=>{
  const {store,release}=heldStore(true);
  store.submit(edit(cameraField.id,'C'));
  store.submit(edit(reel,'101'));
  release();await store.whenSaved();
  assert.equal(store.undo.length,1);
  store.history(false);await store.whenSaved();
  assert.equal(store.error,'');assert.equal(store.document.cameras[0]!.values[reel],'');
});

test('every published state and every reply carries a rising sequence, so late state can be recognised',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}});
  const {harness,run}=await startBackend(cameraPlan([camera.host]));
  try {
    const reply=await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    const sequences=harness.states.map((state:any)=>state.values.sequence);
    assert.ok(sequences.every((value:number,index:number)=>index===0||value>sequences[index-1]));
    assert.equal(reply.sequence,sequences.at(-1));
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('a dropped WebSocket counts as offline, but a refused login stays a failure',async()=>{
  const dropped=await fakeCamera({values:{[reelField.property]:'1'},dropSocket:true}),refused=await fakeCamera({values:{[reelField.property]:'1'},rejectLogin:true});
  const {harness,run,last}=await startBackend(cameraPlan([dropped.host,refused.host]));
  try {
    assert.equal((await run('refresh',{rowId:'cam-0',host:dropped.host,fieldIds:[reelField.id]})).status,'offline');
    assert.equal(last()['cam-0'].state,'offline');
    await assert.rejects(run('refresh',{rowId:'cam-1',host:refused.host,fieldIds:[reelField.id]}),/login was not accepted/);
    assert.equal(last()['cam-1'].state,'error');
  } finally {await harness.instance.dispose?.();await dropped.close();await refused.close();}
});

test('losing the connection part way through a send stops it, marks the camera offline and keeps the change',async()=>{
  const camera=await fakeCamera({values:threeValues,writeDelay:60});
  const plan=cameraPlan([camera.host],[threeStaged]);
  const {harness,run,last}=await startBackend(plan);
  try {
    const sending=run('send',{rowId:'cam-0',host:camera.host,fieldIds:threeIds});
    await until(()=>camera.writes.length===1);
    await camera.close();
    await assert.rejects(sending,/Camera/);
    assert.equal(last()['cam-0'].state,'offline');assert.deepEqual(last()['cam-0'].queued,[]);
    assert.equal(plan.saved().cameras[0]!.values[reelField.id],'101');
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('the ping check reports who answered and takes a silent camera offline without logging in',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}});
  const plan=cameraPlan([camera.host,silentAddress]);
  const {harness,run,last}=await startBackend(plan);
  try {
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    const logins=camera.logins;
    const reply=await run('ping',undefined);
    assert.deepEqual(reply.answered,['cam-0']);assert.equal(camera.logins,logins);assert.equal(last()['cam-0'].state,'online');
  } finally {await harness.instance.dispose?.();await camera.close();}
  const disabled=createModuleHarness(module,{}, {connectionEnabled:false,services:cameraPlan([silentAddress]).services as any});
  await disabled.instance.start?.();
  const started=Date.now(),reply=await disabled.instance.call!('page.cameras',{sectionId:'frontend',commandId:'ping'},disabled.execution()) as any;
  assert.deepEqual(reply.answered,[]);assert.ok(Date.now()-started<500,'connections disabled must not ping');
  await disabled.instance.dispose?.();
});

test('Base ISO offers the pair that matches the sensor',async()=>{
  const iso=fields.find(f=>f.id==='base-iso')!;
  const eightHundred=await fakeCamera({values:{[iso.property]:'ISO 800'}}),twentyFive=await fakeCamera({values:{[iso.property]:'ISO 2500'}}),other=await fakeCamera({values:{[iso.property]:'ISO 1600'}});
  const {harness,run,last}=await startBackend(cameraPlan([eightHundred.host,twentyFive.host,other.host]));
  const list=(id:string)=>last()[id].choices[iso.id]?.map((c:any)=>c.value);
  try {
    await run('refresh',{rowId:'cam-0',host:eightHundred.host,fieldIds:[iso.id]});
    await run('refresh',{rowId:'cam-1',host:twentyFive.host,fieldIds:[iso.id]});
    await run('refresh',{rowId:'cam-2',host:other.host,fieldIds:[iso.id]});
    assert.deepEqual(list('cam-0'),['800','3200']);assert.deepEqual(list('cam-1'),['500','2500']);assert.equal(list('cam-2'),undefined);
    assert.deepEqual(encodeField(iso,'3200',defaultDocument().cameras[0]!,{}),{[iso.property]:'ISO 3200'});
  } finally {await harness.instance.dispose?.();await eightHundred.close();await twentyFive.close();await other.close();}
});

const fieldNamed=(id:string)=>fields.find(f=>f.id===id)!;
const ndValue='Camera.NDFilter.Value',ndMode='Camera.NDFilter.Mode';
test('ND reads and writes as density, in the shape the camera really uses',async()=>{
  const nd=fieldNamed('nd'),row=defaultDocument().cameras[0]!;
  for(const [factor,density] of [[2,'0.3'],[4,'0.6'],[8,'0.9'],[16,'1.2'],[32,'1.5'],[64,'1.8'],[128,'2.1'],[256,'2.4']] as const)assert.equal(decodeField(nd,{[ndValue]:{cam:factor},[ndMode]:'Preset'}),density);
  assert.equal(decodeField(nd,{[ndValue]:{cam:1},[ndMode]:'Preset'}),'Clear');
  assert.equal(decodeField(nd,{[ndValue]:{cam:4096},[ndMode]:'Preset'}),'Clear');
  assert.equal(decodeField(nd,{[ndValue]:{cam:8},[ndMode]:'PresetClear'}),'0.9','the number decides, as on Sony\u2019s page');
  assert.equal(decodeField(nd,{[ndValue]:{cam:65535}}),'');assert.equal(decodeField(nd,{[ndValue]:{cam:65530}}),'Custom 2');
  assert.deepEqual(encodeField(nd,'1.8',row,{}),{[ndMode]:'Preset',[ndValue]:64});
  assert.deepEqual(encodeField(nd,'Clear',row,{}),{[ndMode]:'PresetClear',[ndValue]:1});
  assert.throws(()=>encodeField(nd,'16',row,{}),/available ND/);
  const camera=await fakeCamera({values:{[ndValue]:16,[ndMode]:'Preset'} as any,camProperties:[ndValue]});
  const {harness,run,last}=await startBackend(cameraPlan([camera.host],[{nd:'1.8'}]));
  try {
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:['nd']});
    assert.equal(last()['cam-0'].values.nd,'1.2');assert.equal(last()['cam-0'].choices.nd.length,9);
    const reply=await run('send',{rowId:'cam-0',host:camera.host,fieldIds:['nd']});
    assert.deepEqual(reply.outcomes,[{fieldId:'nd',status:'verified'}]);assert.equal(last()['cam-0'].values.nd,'1.8');
  } finally {await harness.instance.dispose?.();await camera.close();}
});

const shutterValues=(menu:any)=>({'Camera.Shutter.Mode':'Speed','P.System.Menu.ShutterMode':menu,'Camera.Shutter.Angle.DisplayValue':'143.9','Camera.Shutter.Speed.DisplayValue':'1/60.00'}) as any;
test('Speed to Angle goes through the menu setting and is confirmed by the mode the camera reports',async()=>{
  const menu='P.System.Menu.ShutterMode',plain=await fakeCamera({values:shutterValues('0'),shutterMenu:true}),numeric=await fakeCamera({values:shutterValues(0),shutterMenu:true});
  const locked=await fakeCamera({values:shutterValues('0'),shutterMenu:true,status:key=>key==='P.System.Menu.ShutterModeForWifiFull.MenuItem'?'Locked':undefined});
  const deaf=await fakeCamera({values:shutterValues('0'),status:()=>undefined});
  const staged={'shutter-mode':'Angle'};
  const {harness,run,last}=await startBackend(cameraPlan([plain.host,numeric.host,locked.host,deaf.host],[staged,staged,staged,staged]));
  const send=(id:string,host:string)=>run('send',{rowId:id,host,fieldIds:['shutter-mode']});
  try {
    assert.deepEqual((await send('cam-0',plain.host)).outcomes,[{fieldId:'shutter-mode',status:'verified'}]);
    assert.deepEqual(plain.writes,[{[menu]:'1'}]);assert.equal(last()['cam-0'].values['shutter-mode'],'Angle');
    await send('cam-1',numeric.host);assert.deepEqual(numeric.writes,[{[menu]:1}]);
    const refused=await send('cam-2',locked.host);
    assert.equal(refused.outcomes[0].status,'failed');assert.match(refused.outcomes[0].message,/locked/);assert.equal(locked.writes.length,0);
    const ignored=await send('cam-3',deaf.host);
    assert.equal(ignored.outcomes[0].status,'failed');assert.match(ignored.outcomes[0].message,/did not confirm/);
  } finally {await harness.instance.dispose?.();for(const camera of [plain,numeric,locked,deaf])await camera.close();}
});

test('Live subscribes once, applies what the camera pushes and shares the one connection',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}});
  const plan=cameraPlan([camera.host],[],undefined,{view:showing(reelField.id)});
  const {harness,run,last}=await startBackend(plan);
  const fieldIds=[reelField.id];
  try {
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds});
    await switchLive(run,true);
    assert.equal(plan.saved().live,true);
    await until(()=>last()['cam-0'].live===true);
    assert.deepEqual(camera.subscribes,[['Notify.Properties','Notify.Process','Notify.Property']]);
    const logins=camera.logins;
    const parked=run('changes',{after:(harness.states.at(-1) as any).values.sequence});
    let woke=false;void parked.then(()=>{woke=true;});
    await pause(40);assert.equal(woke,false);
    camera.notify({[reelField.property]:'55'});
    const reply=await parked;
    assert.equal(reply.observations['cam-0'].values[reelField.id],'55');
    await run('ping',undefined);await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds});
    assert.equal(camera.logins,logins);assert.equal(camera.subscribes.length,1);assert.equal(camera.subscribers,1);
    const off=await switchLive(run,false);
    assert.equal(off.observations['cam-0'].live,undefined,'the reply to switching off already shows it off');
    assert.equal(plan.saved().live,false);
    await until(()=>camera.subscribers===0);await until(()=>last()['cam-0'].live===undefined);
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('the reel comes from the clip name the camera reports, and the Reel Number setting only when there is none',()=>{
  const menu=reelField.property;
  assert.equal(decodeField(reelField,{[menu]:'501','Clip.Mediabox.ClipName':{main:'B502C001\u0000'}}),'502','a lagging setting loses to the clip name');
  assert.equal(decodeField(reelField,{[menu]:'501'}),'501');
  assert.equal(decodeField(reelField,{[menu]:'7','Clip.Mediabox.ClipName':{main:'A007C012\u0000'}}),'7','shown the way the setting is, without the padding');
  assert.equal(decodeField(reelField,{[menu]:'9','Clip.Mediabox.ClipName':{main:''}}),'9');
  assert.equal(decodeField(reelField,{[menu]:'9','Clip.Mediabox.ClipName':{main:'unexpected'}}),'9');
  assert.equal(decodeField(reelField,{'Clip.Mediabox.ClipName':{main:'C502C001\u0000'}}),'502');
  assert.deepEqual(fieldProperties(reelField),[menu,'Clip.Mediabox.ClipName']);
});

test('Live shows the reel the clip name reports, follows it when it moves, and a reel write still confirms on the setting',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'501','Clip.Mediabox.ClipName':{main:'B502C001\u0000'}} as any});
  const plan=cameraPlan([camera.host],[],undefined,{view:showing(reelField.id)}),states:any[]=[],logs:{stage:string;message:string}[]=[];
  const backend=createBackend({services:plan.services,connectionEnabled:true,log:(trace:any)=>logs.push(trace),publishState:(state:any)=>states.push(state)} as any,async()=>'answered',{});
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  const seen=()=>states.at(-1).values.observations;
  try {
    await switchLive(run,true);
    await until(()=>seen()['cam-0']?.live===true);
    assert.equal(seen()['cam-0'].values[reelField.id],'502','the read at Live start already shows the reel being recorded to');
    assert.ok(!camera.capabilityRequests.some((names:any)=>JSON.stringify(names).includes('Clip.Mediabox.ClipName')),'the clip name is never asked for a choice list');
    assert.ok(logs.some(line=>line.stage==='camera-live'&&/^Camera 1 Live on, following \d+ settings; subscribe answered null$/.test(line.message)));
    camera.notify({'Clip.Mediabox.ClipName':{main:'B503C001\u0000'}});
    await until(()=>seen()['cam-0'].values[reelField.id]==='503');
    camera.notify({[reelField.property]:'502'});
    await pause(150);
    assert.equal(seen()['cam-0'].values[reelField.id],'503','a lagging setting pushed later does not take the cell back');
    const row=plan.saved().cameras[0]!;
    await run('save',{operation:{kind:'edit',edits:[{rowId:row.id,columnId:reelField.id,value:'600',expected:row.values[reelField.id]??''}]}});
    const sent=await run('send',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    assert.deepEqual(sent.outcomes.map((o:any)=>[o.fieldId,o.status]),[[reelField.id,'verified']],'the write is confirmed by reading the setting back');
    assert.equal(seen()['cam-0'].values[reelField.id],'600');
    assert.deepEqual(camera.writes.at(-1),{[reelField.property]:'600'},'only the Reel Number setting is written');
  } finally {await backend.dispose();await camera.close();}
});

test('Live stays on with no page asking for it, comes back after a restart and ends only when switched off',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}});
  const plan=cameraPlan([camera.host],[],undefined,{view:showing(reelField.id)}),states:any[]=[];
  const backendFor=()=>createBackend({services:plan.services,connectionEnabled:true,log(){},publishState:(state:any)=>states.push(state)} as any,async()=>'answered',{keepAliveMs:20,keepAliveTimeoutMs:40,watchMs:30});
  const seen=()=>states.at(-1).values.observations;
  let backend=backendFor();
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  try {
    // Switched on, then the page goes away: nothing renews anything from here on.
    await switchLive(run,true);
    await until(()=>seen()['cam-0']?.live===true);
    assert.equal(seen()['cam-0'].values[reelField.id],'1','Live reads a camera nobody pressed Refresh on');
    const kept=camera.keepAlives;
    await pause(400);
    assert.equal(camera.subscribers,1);assert.equal(seen()['cam-0'].live,true);
    assert.ok(camera.keepAlives>=kept+5,'the worker keeps the connection alive by itself');
    camera.notify({[reelField.property]:'77'});
    await until(()=>seen()['cam-0'].values[reelField.id]==='77');
    assert.equal(camera.subscribes.length,1);
    // Hubble restarting the module brings Live back from the saved plan, still with no page.
    await backend.dispose();
    await until(()=>camera.subscribers===0);
    states.splice(0);backend=backendFor();await backend.start();
    await until(()=>seen()?.['cam-0']?.live===true);
    assert.equal(camera.subscribers,1);assert.equal(camera.subscribes.length,2);
    await switchLive(run,false);
    await until(()=>camera.subscribers===0);assert.equal(seen()['cam-0'].live,undefined);
    const logins=camera.logins;await pause(120);
    assert.equal(camera.logins,logins,'once off, the watch passes never reconnect');assert.equal(camera.subscribers,0);
  } finally {await backend.dispose();await camera.close();}
});

test('a refused Live subscribe or login is tried once, then again only after Refresh gets in or the login changes',async()=>{
  const lateOptions={values:{[reelField.property]:'1'},rejectLogin:true};
  const open=await fakeCamera({values:{[reelField.property]:'1'}}),refusing=await fakeCamera({values:{[reelField.property]:'1'},rejectSubscribe:true}),locked=await fakeCamera({values:{[reelField.property]:'1'},rejectLogin:true}),late=await fakeCamera(lateOptions);
  const plan=cameraPlan([open.host,refusing.host,locked.host,late.host],[],undefined,{view:showing(reelField.id)}),states:any[]=[],logs:string[]=[];
  const backend=createBackend({services:plan.services,connectionEnabled:true,log:(trace:any)=>logs.push(trace.message),publishState:(state:any)=>states.push(state)} as any,async()=>'answered',{});
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  const seen=()=>states.at(-1).values.observations;
  try {
    await switchLive(run,true);
    await until(()=>seen()['cam-0']?.live===true);
    for(const id of ['cam-1','cam-2','cam-3'])await until(()=>!!seen()[id]?.errors['connection-status']);
    assert.match(seen()['cam-1'].errors['connection-status'],/Live updates unavailable/);
    assert.equal(seen()['cam-1'].state,'online','a camera that reads but will not subscribe still shows its values');
    assert.equal(seen()['cam-2'].state,'error','a refused login reads as Read failed, not Offline');
    for(let i=0;i<3;i++)await run('ping',undefined);
    await pause(30);
    assert.equal(refusing.subscribes.length,1);assert.equal(locked.logins,1,'a wrong password is not hammered');assert.equal(late.logins,1);
    assert.ok(logs.some(line=>line.includes('Camera 2')));
    // The page's quiet read of a camera that only refused to subscribe doesn't bring the subscribe back.
    await run('refresh',{rowId:'cam-1',host:refusing.host,fieldIds:[reelField.id]});
    await run('ping',undefined);await pause(30);
    assert.equal(refusing.subscribes.length,1);
    // A camera that refused its login and now lets Refresh in goes Live at the next pass.
    lateOptions.rejectLogin=false;
    await run('ping',undefined);await pause(30);assert.equal(late.logins,1);
    await run('refresh',{rowId:'cam-3',host:late.host,fieldIds:[reelField.id]});
    await run('ping',undefined);await until(()=>seen()['cam-3']?.live===true);
    const row=plan.saved().cameras[2]!;
    await run('save',{operation:{kind:'edit',edits:[{rowId:row.id,columnId:'camera-password',value:'new-password',expected:row.values['camera-password']}]}});
    await run('ping',undefined);await until(()=>locked.logins===2);
  } finally {await backend.dispose();for(const camera of [open,refusing,locked,late])await camera.close();}
});

test('with device connections disabled a saved Live never reaches a camera',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}}),pings:string[]=[];
  const plan=cameraPlan([camera.host],[],undefined,{live:true});
  const backend=createBackend({services:plan.services,connectionEnabled:false,log(){},publishState(){}} as any,async(host:string)=>{pings.push(host);return 'answered';},{watchMs:10});
  await backend.start();
  try {await pause(60);assert.deepEqual(pings,[]);assert.equal(camera.logins,0);assert.equal(camera.subscribers,0);}
  finally {await backend.dispose();await camera.close();}
});

test('Live takes the current values when it starts, and a new column joins without reconnecting',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1',[cameraField.property]:'65',[sdiField.property]:'0'}});
  const plan=cameraPlan([camera.host],[],undefined,{view:showing(reelField.id)});
  const identity=[...fields.filter(f=>f.group===reelField.group).map(f=>f.property),'Clip.Mediabox.ClipName'].sort();
  const {harness,run,last}=await startBackend(plan);
  try {
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    camera.values[reelField.property]='9';
    await switchLive(run,true);
    await until(()=>last()['cam-0'].live===true);
    assert.equal(last()['cam-0'].values[reelField.id],'9');
    assert.deepEqual(camera.reads.at(-1)!.filter(name=>!['Clip.Mediabox.Status','Storage.Media.Recording','Storage.Media.Recordable'].includes(name)).sort(),identity,'Live reads only the sections the open tab shows');
    const logins=camera.logins,expected=plan.saved().view;
    // A section from elsewhere is ticked: the page reads it once and the held connection follows it from then on.
    await run('save',{operation:{kind:'view',expected,view:withColumnVisibility(expected,[{id:sdiField.id,visible:true}])}});
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:[cameraField.id,sdiField.id]});
    assert.equal(last()['cam-0'].values[sdiField.id],'FALSE');
    camera.notify({[sdiField.property]:'1'});
    await until(()=>last()['cam-0'].values[sdiField.id]==='TRUE');
    assert.equal(last()['cam-0'].values[cameraField.id],'A');assert.equal(last()['cam-0'].live,true);
    camera.notify({[cameraField.property]:'67'});
    await until(()=>last()['cam-0'].values[cameraField.id]==='C');
    assert.equal(camera.logins,logins);assert.equal(camera.subscribes.length,1);assert.equal(camera.subscribers,1);
    camera.notify({[reelField.property]:'10'});
    await until(()=>last()['cam-0'].values[reelField.id]==='10');
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('a Live camera gets no regular ping, and a failed keep-alive pings once to decide what happened',async()=>{
  const gone=await fakeCamera({values:{[reelField.property]:'1'}}),glitch=await fakeCamera({values:{[reelField.property]:'1'}}),idle=await fakeCamera({values:{[reelField.property]:'1'}});
  const plan=cameraPlan([gone.host,glitch.host,idle.host],[],undefined,{view:showing(reelField.id)}),states:any[]=[],pinged:string[]=[];
  let goneAnswers=true;
  const backend=createBackend({services:plan.services,connectionEnabled:true,log(){},publishState:(state:any)=>states.push(state)} as any,async(host:string)=>{pinged.push(host);return host===gone.host&&!goneAnswers?'silent':'answered';},{keepAliveMs:30,keepAliveTimeoutMs:40});
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  const seen=()=>states.at(-1).values.observations;
  const fieldIds=[reelField.id];
  try {
    await run('refresh',{rowId:'cam-0',host:gone.host,fieldIds});await run('refresh',{rowId:'cam-1',host:glitch.host,fieldIds});await run('refresh',{rowId:'cam-2',host:idle.host,fieldIds});
    await switchLive(run,true);
    await until(()=>seen()['cam-0'].live===true&&seen()['cam-1'].live===true&&seen()['cam-2'].live===true);
    pinged.splice(0);
    const passed=await run('ping',undefined);
    assert.deepEqual([...pinged],[]);assert.deepEqual(passed.answered,[]);
    goneAnswers=false;gone.mute(true);
    await until(()=>seen()['cam-0'].state==='offline');
    assert.deepEqual(seen()['cam-0'].values,{});assert.deepEqual([...pinged],[gone.host]);
    glitch.mute(true);
    await until(()=>seen()['cam-1'].live===undefined);await until(()=>pinged.includes(glitch.host));
    assert.equal(seen()['cam-1'].state,'online');
    glitch.mute(false);
    // The next pass hears the camera and reconnects by itself.
    await run('ping',undefined);
    await until(()=>seen()['cam-1'].live===true);
    assert.equal(glitch.subscribes.length,2);
    pinged.splice(0);
    const next=await run('ping',undefined);
    assert.deepEqual([...pinged],[gone.host]);assert.deepEqual(next.answered,[]);
  } finally {await backend.dispose();await gone.close();await glitch.close();await idle.close();}
});

const allAlerts:AlertChoices={offlineNotification:true,offlineBounce:true,onlineNotification:true};
const alertBackend=(hosts:string[],answer:(host:string)=>'answered'|'silent'|'unknown',extra:Record<string,unknown>={},options:Record<string,number>={},choices:AlertChoices|null=allAlerts)=>{
  const plan=cameraPlan(hosts,[],choices??undefined),alerts:any[]=[],pings:string[]=[];
  const backend=createBackend({services:plan.services,connectionEnabled:true,log(){},publishState(){},publishEvent:(channel:string,value:any)=>{assert.equal(channel,'host.alert.v1');alerts.push(value);},...extra} as any,async(host:string)=>{pings.push(host);return answer(host);},options);
  const pass=()=>backend.call('page.cameras',{sectionId:'frontend',commandId:'ping'},{signal:new AbortController().signal}) as Promise<any>;
  return {backend,alerts,pings,pass};
};

test('a camera that drops alerts once after two missed passes, and once when it returns',async()=>{
  let answer:'answered'|'silent'|'unknown'='answered';
  const {backend,alerts,pass}=alertBackend(['10.0.0.1'],()=>answer);
  await backend.start();
  try {
    await pass();assert.deepEqual(alerts,[]);
    answer='silent';await pass();assert.deepEqual(alerts,[]);
    await pass();
    assert.deepEqual(alerts,[{key:'camera-down:cam-0',title:'Camera offline: Camera 1',body:'10.0.0.1 stopped answering.',severity:'critical',notification:true,dockBounce:true}]);
    await pass();await pass();assert.equal(alerts.length,1);
    answer='answered';await pass();
    assert.deepEqual(alerts[1],{key:'camera-up:cam-0',title:'Camera back online: Camera 1',body:'10.0.0.1 is answering again.',severity:'info',notification:true,dockBounce:false});
    await pass();assert.equal(alerts.length,2);
  } finally {await backend.dispose();}
});

test('a new plan raises no alert at all until the operator turns one on',async()=>{
  assert.deepEqual(alertChoices(defaultDocument()),{offlineNotification:false,offlineBounce:false,onlineNotification:false});
  let answer:'answered'|'silent'='answered';
  const {backend,alerts,pass}=alertBackend(['10.0.0.1'],()=>answer,{},{},null);
  await backend.start();
  try {
    await pass();answer='silent';await pass();await pass();
    answer='answered';await pass();
    assert.deepEqual(alerts,[]);
  } finally {await backend.dispose();}
});

test('each alert choice is honoured on its own',async()=>{
  let answer:'answered'|'silent'='answered';
  const {backend,alerts,pass}=alertBackend(['10.0.0.1'],()=>answer,{},{},{offlineNotification:false,offlineBounce:true,onlineNotification:false});
  await backend.start();
  try {
    await pass();answer='silent';await pass();await pass();
    assert.deepEqual(alerts.map(alert=>[alert.key,alert.notification,alert.dockBounce]),[['camera-down:cam-0',false,true]]);
    answer='answered';await pass();
    assert.equal(alerts.length,1,'back online stays quiet while its switch is off');
  } finally {await backend.dispose();}
});

test('alert choices save with the plan, undo as a pair and refuse anything unknown',()=>{
  const before=defaultDocument(),on={offlineNotification:true,offlineBounce:false,onlineNotification:false};
  const change={kind:'alerts' as const,alerts:on,expected:alertChoices(before)};
  const after=applyMutation(before,change);
  assert.deepEqual(after.alerts,on);
  assert.deepEqual(alertChoices(applyMutation(after,inverse(before,change))),alertChoices(before));
  assert.throws(()=>applyMutation(after,change),/changed in another editor/);
  assert.throws(()=>applyMutation(before,{...change,alerts:{...on,loud:true} as any}),/Invalid alert choices/);
  assert.throws(()=>validateDocument({...before,alerts:{offlineNotification:'yes'}}),/Invalid alert choices/);
});

test('Live saves with the plan, reverses as a pair and an older plan reads as off',()=>{
  const before=defaultDocument();
  assert.equal(liveOn(before),false);assert.equal(before.live,undefined,'a new plan says nothing about Live until it is switched');
  const on={kind:'live' as const,live:true,expected:false},after=applyMutation(before,on);
  assert.equal(after.live,true);assert.equal(liveOn(validateDocument(clone(after))),true);
  assert.equal(liveOn(applyMutation(after,inverse(before,on))),false);
  assert.throws(()=>applyMutation(after,on),/switched in another editor/);
  assert.throws(()=>applyMutation(before,{...on,live:'yes'} as any),/Invalid Live choice/);
  assert.throws(()=>validateDocument({...before,live:1}),/Invalid Live choice/);
  assert.deepEqual(readFieldIds(showing(reelField.id)).sort(),fields.filter(f=>f.group===reelField.group).map(f=>f.id).sort(),'Live follows whole sections, like Refresh');
});

test('Auto send saves with the plan, reverses as a pair and an older plan reads as Manual',()=>{
  const before=defaultDocument();
  assert.equal(autoSendOn(before),false);assert.equal(before.autoSend,undefined);
  const on={kind:'auto-send' as const,autoSend:true,expected:false},after=applyMutation(before,on);
  assert.equal(after.autoSend,true);assert.equal(autoSendOn(validateDocument(clone(after))),true);
  assert.equal(autoSendOn(applyMutation(after,inverse(before,on))),false);
  assert.throws(()=>applyMutation(after,on),/changed in another editor/);
  assert.throws(()=>applyMutation(before,{...on,autoSend:'yes'} as any),/Invalid send mode/);
  assert.throws(()=>validateDocument({...before,autoSend:1}),/Invalid send mode/);
});

test('alerts stay quiet for a single lost ping, a camera never seen, or a ping that could not run',async()=>{
  const script:Record<string,('answered'|'silent'|'unknown')[]>={'10.0.0.1':['answered','silent','answered','silent','answered'],'10.0.0.2':['silent','silent','silent','silent','silent'],'10.0.0.3':['answered','unknown','unknown','unknown','unknown']};
  const {backend,alerts,pass}=alertBackend(Object.keys(script),host=>script[host]!.shift()!);
  await backend.start();
  try {for(let i=0;i<5;i++)await pass();assert.deepEqual(alerts,[]);}
  finally {await backend.dispose();}
});

test('the background watch keeps checking with no page open and shares passes with the page',async()=>{
  let answer:'answered'|'silent'='answered';
  const {backend,alerts,pings,pass}=alertBackend(['10.0.0.1'],()=>answer,{},{watchMs:20});
  await backend.start();
  try {
    await until(()=>pings.length>=1);
    answer='silent';
    await until(()=>alerts.length===1);
    assert.equal(alerts[0].severity,'critical');
    const before=pings.length;
    await Promise.all([pass(),pass(),pass()]);
    assert.ok(pings.length<=before+2,'three page passes at once share one ping');
  } finally {await backend.dispose();}
  const stopped=pings.length;
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(pings.length,stopped,'a disposed module stops watching');
});

test('with device connections disabled the watch never pings',async()=>{
  const {backend,alerts,pings}=alertBackend(['10.0.0.1'],()=>'answered',{connectionEnabled:false},{watchMs:10});
  await backend.start();
  try {await new Promise(resolve=>setTimeout(resolve,60));assert.deepEqual(pings,[]);assert.deepEqual(alerts,[]);}
  finally {await backend.dispose();}
});

test('a Live camera whose keep-alive fails and then misses a ping alerts straight away',async()=>{
  const camera=await fakeCamera({values:{[reelField.property]:'1'}}),states:any[]=[];
  let answers=true;
  const {backend,alerts}=alertBackend([camera.host],()=>answers?'answered':'silent',{publishState:(state:any)=>states.push(state)},{keepAliveMs:30,keepAliveTimeoutMs:40});
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  try {
    const fieldIds=[reelField.id];
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds});
    await switchLive(run,true);
    await until(()=>states.at(-1).values.observations['cam-0'].live===true);
    answers=false;camera.mute(true);
    await until(()=>alerts.length===1);
    assert.equal(alerts[0].key,'camera-down:cam-0');
  } finally {await backend.dispose();await camera.close();}
});

test('recording status follows the same states as Sony’s page, on a read and when pushed',async()=>{
  const status='Clip.Mediabox.Status';
  assert.equal(recordingState({[status]:{main:'Recording'}}),'recording');assert.equal(recordingState({[status]:{main:'Standby'}}),'standby');
  assert.equal(recordingState({[status]:{main:'PreparingToRecord'}}),'starting');assert.equal(recordingState({[status]:{main:'NoMedia'}}),'');assert.equal(recordingState({}),'');
  const camera=await fakeCamera({values:{[reelField.property]:'1',[status]:{main:'Standby'}} as any});
  const {harness,run,last}=await startBackend(cameraPlan([camera.host]));
  try {
    await run('refresh',{rowId:'cam-0',host:camera.host,fieldIds:[reelField.id]});
    assert.equal(last()['cam-0'].recording,'standby');
    await switchLive(run,true);
    await until(()=>last()['cam-0'].live===true);
    camera.notify({[status]:{main:'Recording'}} as any);
    await until(()=>last()['cam-0'].recording==='recording');
  } finally {await harness.instance.dispose?.();await camera.close();}
});

test('a card that is recording means REC even while the media box says NoMedia, as real VENICE 2s report a roll',async()=>{
  const status='Clip.Mediabox.Status',cards='Storage.Media.Recording',ready='Storage.Media.Recordable';
  const idle={'media.1':'NotRecording','media.2':'NotRecording','media.4':'NotRecording','media.5':'NotRecording'},rolling={...idle,'media.4':'Recording'};
  const recordable={'media.1':'NotRecordable','media.2':'NotRecordable','media.4':'Recordable','media.5':'NotRecordable'};
  assert.equal(recordingState({[status]:{main:'NoMedia'},[cards]:rolling,[ready]:recordable}),'recording');
  assert.equal(recordingState({[status]:{main:'Standby'},[cards]:rolling}),'recording');
  assert.equal(recordingState({[status]:{main:'Recording'},[cards]:idle,[ready]:recordable}),'standby','the cards say the roll has ended');
  assert.equal(recordingState({[status]:{main:'NoMedia'},[cards]:idle,[ready]:recordable}),'standby');
  assert.equal(recordingState({[status]:{main:'NoMedia'},[cards]:idle,[ready]:{...recordable,'media.4':'NotRecordable'}}),'','no card ready to record');
  assert.equal(recordingState({[status]:{main:'PreparingToRecord'},[cards]:idle}),'starting');
  assert.equal(recordingState({[status]:{main:'Playing'},[cards]:idle,[ready]:recordable}),'');
  const camera=await fakeCamera({values:{[reelField.property]:'1',[status]:{main:'Standby'},[cards]:idle,[ready]:recordable} as any});
  const plan=cameraPlan([camera.host]),states:any[]=[],logs:{stage:string;message:string}[]=[];
  const backend=createBackend({services:plan.services,connectionEnabled:true,log:(trace:any)=>logs.push(trace),publishState:(state:any)=>states.push(state)} as any,async()=>'answered',{});
  await backend.start();
  const run=(commandId:string,value:any)=>backend.call('page.cameras',{sectionId:'frontend',commandId,value},{signal:new AbortController().signal}) as Promise<any>;
  const seen=()=>states.at(-1).values.observations['cam-0'];
  try {
    await switchLive(run,true);
    await until(()=>seen()?.live===true);
    assert.equal(seen().recording,'standby');
    // What the cameras sent as they rolled: the media box went NoMedia and the card went Recording.
    camera.notify({[status]:{main:'NoMedia'}} as any);
    camera.notify({[cards]:rolling} as any);
    await until(()=>seen().recording==='recording');
    await pause(150);assert.equal(seen().recording,'recording');
    camera.notify({[status]:{main:'NoMedia'}} as any);camera.notify({[cards]:idle} as any);
    await until(()=>seen().recording==='standby');
    const lines=logs.filter(line=>line.stage==='camera-recording').map(line=>line.message);
    assert.deepEqual(lines.map(line=>line.split(' (')[0]),['Camera 1 standby','Camera 1 recording','Camera 1 standby'],'one line per change, none for a repeat');
    assert.match(lines[1]!,/media box NoMedia, cards \{.*"media\.4":"Recording"/);
  } finally {await backend.dispose();await camera.close();}
});
