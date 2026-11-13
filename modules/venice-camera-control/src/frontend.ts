import { connectModuleFrontend, ModuleFrontendValueSchema } from '@hubble/module-sdk/frontend';
import { mountSpreadsheetSheets,mountSpreadsheetToolbar,type SpreadsheetAddress } from '@hubble/module-sdk/spreadsheet-controls';
import { alertChoices, alertsOn, autoSendOn, liveOn, readFieldIds, type AlertChoices, groups, fields, fieldById, valueOf, clone, validHost, activeSheetId, isFlipped, sheetList, sheetRowCount, addSheet, renameSheet, removeSheet, moveSheet, setOrientation, viewChange, setCameraCount, cameraHasData, loginVisible, type Camera, type CameraDocument, type CellEdit, type Field, type Mutation, type Orientation } from './model.js';
import { DraftStore, type SaveReceipt } from './draft-store.js';
import { createCameraGrid } from './ui-grid.js';
import type { Observations } from './backend.js';
import './frontend.css';

type Snapshot=SaveReceipt&{observations:Observations;sequence?:number};
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const errorBox=el('error'),saveStatus=el<HTMLOutputElement>('save-status'),pendingStatus=el('pending-status');
const dialog=el<HTMLDialogElement>('camera-dialog'),form=el<HTMLFormElement>('camera-form');
const input=(id:string)=>el<HTMLInputElement>(id);
let active:SpreadsheetAddress|undefined,observations:Observations={},busy=false;
// Per camera: settings not yet handed to the camera worker, so Cancel can still take them back.
const unsent=new Map<string,{id:string;value:string}[]>();
let errorTimer:ReturnType<typeof setTimeout>|undefined,lastSaveError='';
// Hubble delivers state on its own slow cycle, so an older copy can arrive after a newer reply.
let newestState=0;
// Which Live run is following the worker's changes. Nothing follows until the page has finished starting.
let liveRun=0,following=false,pageReady=false;
function adopt(next:{observations?:Observations;sequence?:number}){
  if(!next.observations)return;
  if(typeof next.sequence==='number'){if(next.sequence<newestState)return;newestState=next.sequence;}
  observations=next.observations;
}
function report(message:string){clearTimeout(errorTimer);errorBox.getAnimations().forEach(animation=>animation.cancel());errorBox.textContent=message;errorBox.hidden=!message;if(message){errorBox.animate([{opacity:1},{opacity:0}],{duration:250,delay:4250,fill:'forwards'});errorTimer=setTimeout(()=>{errorBox.hidden=true;},4500);}}
try {
  const client=await connectModuleFrontend(window);
  const initial=await client.call('snapshot') as unknown as Snapshot;
  adopt(initial);
  const store=new DraftStore(initial,async(operation:Mutation)=>{
    const reply=await client.call('save',ModuleFrontendValueSchema.parse({operation})) as unknown as Snapshot;
    adopt(reply);return reply;
  });
  const textControls=await mountSpreadsheetToolbar({root:el('text-size'),textSize:{
    get:()=>store.document.view.textSize??13,
    onChange(textSize){store.submit(viewChange(store.document,{...clone(store.document.view),textSize}));}
  }});
  const submitSheets=(operation:Mutation|null)=>{if(operation)store.submit(operation);};
  const sheetTabs=await mountSpreadsheetSheets({
    root:el('sheet-tabs'),
    getState(){const document=store.document,list=sheetList(document);return {sheets:list.map(({id,name})=>({id,name})),activeSheetId:activeSheetId(document),counts:new Map(list.map(sheet=>[sheet.id,sheetRowCount(document,sheet)]))};},
    onSelect(sheetId){if(sheetId!==activeSheetId(store.document))store.submit({kind:'select-sheet',sheetId},false);},
    onCreate:name=>submitSheets(addSheet(store.document,crypto.randomUUID(),name)),
    onRename:(sheetId,name)=>submitSheets(renameSheet(store.document,sheetId,name)),
    onRemove:sheetId=>submitSheets(removeSheet(store.document,sheetId)),
    onReorder:(sheetId,beforeId)=>submitSheets(moveSheet(store.document,sheetId,beforeId))
  });
  const orientationButtons=[['view-rows','rows'],['view-columns','columns']] as [string,Orientation][];
  const activeRow=()=>store.document.cameras.find(row=>row.id===active?.rowId)??store.document.cameras[0];
  const rowObservation=(id:string)=>{
    const row=store.document.cameras.find(r=>r.id===id),o=observations[id];
    return row&&o?.host===valueOf(row,'camera-host')?o:undefined;
  };
  const pending=(id:string)=>{const row=store.document.cameras.find(r=>r.id===id),obs=rowObservation(id);return row?fields.filter(f=>!!row.values[f.id]&&row.values[f.id]!==obs?.values[f.id]):[];};
  // What Send all would write now: staged settings on cameras that are online. Offline ones wait.
  const readyToSend=()=>store.document.cameras.reduce((n,r)=>n+(rowObservation(r.id)?.state==='online'?pending(r.id).length:0),0);
  const sendBlocked=()=>busy||store.pending.length>0||store.invalid.size>0;
  let grid:Awaited<ReturnType<typeof createCameraGrid>>;
  function update(){
    textControls.refresh();sheetTabs.refresh();
    for(const [id,orientation]of orientationButtons)el(id).setAttribute('aria-pressed',String((orientation==='columns')===isFlipped(store.document)));
    if(store.error!==lastSaveError){lastSaveError=store.error;if(lastSaveError)report(lastSaveError);}
    const all=store.document.cameras.reduce((n,r)=>n+pending(r.id).length,0);
    const inFlight=store.document.cameras.reduce((n,r)=>{const o=rowObservation(r.id);return n+new Set([...(unsent.get(r.id)??[]).map(entry=>entry.id),...(o?.queued??[]),...(o?.sending??[])]).size;},0);
    // Saved with the plan, so it stays as set when you leave the page. Opening the page never sends anything by itself:
    // Auto send only sends an edit as it is committed.
    const auto=autoSendOn(store.document);
    el('send-manual').setAttribute('aria-pressed',String(!auto));el('send-auto').setAttribute('aria-pressed',String(auto));
    // Send all on the toolbar does what the Pending sends panel's button does, without opening the panel.
    const sendable=readyToSend(),sendBar=el<HTMLButtonElement>('send-all-bar');
    sendBar.disabled=sendBlocked()||sendable===0;el('send-all-bar-count').textContent=String(sendable);el('send-all-bar-count').hidden=sendable===0;
    sendBar.title=sendable?'Send '+sendable+' staged setting'+(sendable===1?'':'s')+' to the cameras that are online':'Nothing is waiting to send to an online camera';
    const ready=store.document.cameras.filter(r=>rowObservation(r.id)?.state==='online').length;
    el('fleet-status').textContent=store.document.cameras.length+' camera'+(store.document.cameras.length===1?'':'s')+(ready?' / '+ready+' ready':' / offline');
    el('fleet-status').parentElement!.dataset.ready=String(ready>0);
    const cameraCount=input('camera-count');if(document.activeElement!==cameraCount)cameraCount.value=String(store.document.cameras.length);
    el<HTMLButtonElement>('refresh-camera').disabled=busy||!store.document.cameras.some(r=>valueOf(r,'camera-host'));el('refresh-label').textContent=busy?'Working…':'Refresh all';
    el('pending-count').textContent=String(all);el('pending-count').hidden=all===0;el('pending-toggle').dataset.pending=String(all>0);
    saveStatus.textContent=store.error|| (store.pending.length?'Saving…':store.invalid.size?'Correct the highlighted draft':'Workspace saved');
    saveStatus.dataset.error=String(!!store.error||store.invalid.size>0);
    pendingStatus.textContent=inFlight?inFlight+' sending · '+Math.max(0,all-inFlight)+' pending':all?all+' change'+(all===1?'':'s')+' pending':'No changes pending';
    pendingStatus.dataset.pending=String(all>0);
    el('empty').hidden=store.document.cameras.length>0;
    if(!el('setting-details').hidden)renderDetails();
    if(!el('pending-sends').hidden)renderPending();
    renderAlerts();
    syncLive();
  }
  const alertSwitches:[string,keyof AlertChoices][]=[['alert-offline-notification','offlineNotification'],['alert-offline-bounce','offlineBounce'],['alert-online-notification','onlineNotification']];
  function renderAlerts(){
    const choices=alertChoices(store.document),on=alertsOn(choices),tag=el('alerts-tag');
    for(const [id,key]of alertSwitches)input(id).checked=choices[key];
    tag.textContent=on?'On':'Off';tag.dataset.on=String(on);
  }
  function toggleAlerts(open:boolean){
    if(open)togglePending(false);
    el('alerts-panel').hidden=!open;el('alerts-toggle').setAttribute('aria-expanded',String(open));
  }
  function renderDetails(){
    const panel=el('detail-content');panel.replaceChildren();
    if(!active){panel.textContent='Select a setting.';return;}
    const row=store.document.cameras.find(r=>r.id===active!.rowId),field=fieldById.get(active.columnId);
    if(!row||!field){panel.textContent='Select a camera setting to see its readback and staged value.';return;}
    if(rowObservation(row.id)?.state!=='online'){panel.textContent='This camera isn’t online.';return;}
    const heading=document.createElement('h3');heading.textContent=field.label;panel.append(heading);
    const dl=document.createElement('dl'),obs=rowObservation(row.id);
    for(const [label,value]of [['Camera',valueOf(row,'camera-name')],['Last read',obs?.values[field.id]||'Not read'],['Staged',row.values[field.id]||'No change'],['Device test',field.verified?'Write + readback verified':'Not yet verified on this body']]){
      const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=field.kind==='boolean'?(value==='TRUE'?'On':value==='FALSE'?'Off':value):field.choices.find(c=>c.value===value)?.label??value;dl.append(dt,dd);
    }
    panel.append(dl);
    if(obs?.errors[field.id]){const p=document.createElement('p');p.textContent=obs.errors[field.id]!;panel.append(p);}
    const p=document.createElement('p');p.textContent='Availability and allowed values depend on the camera’s current recording mode.';panel.append(p);
  }
  const displayValue=(field:Field,value:string)=>field.kind==='boolean'?(value==='TRUE'?'On':'Off'):field.choices.find(c=>c.value===value)?.label??value;
  const groupNodes=new Map<string,{root:HTMLElement;name:HTMLElement;detail:HTMLElement;send:HTMLButtonElement;cancel:HTMLButtonElement}>();
  const itemNodes=new Map<string,{root:HTMLElement;setting:HTMLElement;change:HTMLElement;status:HTMLElement;cancel:HTMLButtonElement}>();
  const button=(label:string,run:()=>void)=>{const node=document.createElement('button');node.textContent=label;node.addEventListener('click',run);return node;};
  const addresses=(rowId:string)=>pending(rowId).map(field=>({rowId,fieldId:field.id}));
  function pendingGroup(rowId:string){
    let node=groupNodes.get(rowId);if(node)return node;
    const root=document.createElement('div'),text=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
    root.className='pending-camera';root.dataset.cameraId=rowId;text.append(name,detail);
    const send=button('Send',()=>void sendCameras([rowId])),cancel=button('Cancel',()=>cancelSends(addresses(rowId)));
    root.append(text,send,cancel);node={root,name,detail,send,cancel};groupNodes.set(rowId,node);return node;
  }
  function pendingItem(rowId:string,fieldId:string){
    const key=rowId+'/'+fieldId;let node=itemNodes.get(key);if(node)return node;
    const root=document.createElement('div'),setting=document.createElement('div'),change=document.createElement('div'),status=document.createElement('div');
    root.className='pending-item';root.dataset.cameraId=rowId;root.dataset.settingId=fieldId;setting.className='setting';change.className='change';status.className='status';
    const cancel=button('Cancel',()=>cancelSends([{rowId,fieldId}]));
    root.append(setting,change,status,cancel);node={root,setting,change,status,cancel};itemNodes.set(key,node);return node;
  }
  function renderPending(){
    const list=el('pending-list'),nodes:HTMLElement[]=[],groups=new Set<string>(),items=new Set<string>();
    const blocked=sendBlocked();
    let total=0,ready=0;
    for(const row of store.document.cameras){
      const waiting=pending(row.id);if(!waiting.length)continue;
      const obs=rowObservation(row.id),isOnline=obs?.state==='online',name=valueOf(row,'camera-name');
      total+=waiting.length;if(isOnline)ready+=waiting.length;groups.add(row.id);
      const group=pendingGroup(row.id);nodes.push(group.root);
      group.name.textContent=name;group.detail.textContent=valueOf(row,'camera-host')+' · '+(isOnline?'Ready':obs?.state==='error'?'Read failed':'Offline');
      group.send.disabled=blocked||!isOnline;group.send.setAttribute('aria-label','Send all changes to '+name);group.cancel.setAttribute('aria-label','Cancel all changes for '+name);
      for(const field of waiting){
        const key=row.id+'/'+field.id,item=pendingItem(row.id,field.id),sending=!!obs?.sending.includes(field.id);
        items.add(key);nodes.push(item.root);
        const queued=!!unsent.get(row.id)?.some(entry=>entry.id===field.id)||!!obs?.queued.includes(field.id),failure=obs?.errors[field.id],current=isOnline?obs?.values[field.id]:undefined;
        item.setting.textContent=field.label;item.change.textContent=(current?displayValue(field,current):'Not read')+' → '+displayValue(field,row.values[field.id]!);
        item.status.textContent=sending?'Sending…':queued?'Queued':failure??(isOnline?'':'Won’t send while this camera is offline');
        item.status.dataset.kind=sending||queued?'active':failure?'failed':isOnline?'':'offline';
        item.cancel.disabled=sending;item.cancel.setAttribute('aria-label','Cancel '+field.label+' for '+name);
      }
    }
    for(const [id,node]of groupNodes)if(!groups.has(id)){node.root.remove();groupNodes.delete(id);}
    for(const [key,node]of itemNodes)if(!items.has(key)){node.root.remove();itemNodes.delete(key);}
    nodes.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]??null);});
    el('pending-summary').textContent=total?total+' setting'+(total===1?'':'s')+' waiting. '+(autoSendOn(store.document)?'New edits send as you commit them. These stay here until you press Send.':'Nothing goes to a camera until you press Send.'):'Nothing is waiting to send.';
    const all=el<HTMLButtonElement>('send-all');all.textContent=ready?'Send all ('+ready+')':'Send all';all.disabled=blocked||ready===0;
    el<HTMLButtonElement>('cancel-all').disabled=total===0;
  }
  function togglePending(open:boolean){if(open)toggleAlerts(false);const pane=el('pending-sends');pane.hidden=!open;el('pending-toggle').setAttribute('aria-expanded',String(open));if(open)renderPending();}
  // Cancel takes a change out of the queue and clears it from the plan, as one Undo step.
  // The setting being written at that moment has already gone, so its button is off.
  function cancelSends(items:{rowId:string;fieldId:string}[]){
    const edits:CellEdit[]=[];
    for(const rowId of new Set(items.map(item=>item.rowId))){
      const ids=items.filter(item=>item.rowId===rowId).map(item=>item.fieldId),row=store.document.cameras.find(r=>r.id===rowId),obs=rowObservation(rowId);
      if(unsent.has(rowId))unsent.set(rowId,unsent.get(rowId)!.filter(entry=>!ids.includes(entry.id)));
      if(cameraWork.has(rowId))void client.call('cancel-send',{rowId,fieldIds:ids}).catch(()=>{});
      for(const fieldId of ids)if(row?.values[fieldId]&&!obs?.sending.includes(fieldId))edits.push({rowId,columnId:fieldId,value:'',expected:row.values[fieldId]!});
    }
    if(edits.length)store.submit({kind:'edit',edits});else update();
  }
  function showDialog(){
    input('camera-name').value='Camera '+(store.document.cameras.length+1);input('camera-host').value='';
    el('dialog-error').hidden=true;
    el<HTMLButtonElement>('dialog-submit').disabled=false;
    dialog.showModal();input('camera-host').focus();
  }
  grid=await createCameraGrid({
    table:el<HTMLTableElement>('camera-grid'),viewport:el('viewport'),columnEditor:el('column-editor'),store,
    observations:()=>observations,onSelect:address=>{active=address;update();},
    onZoom:ratio=>{el('zoom-status').textContent=Math.round(ratio*100)+'%';},
    onRefresh:refreshCamera,
    onEdited:autoSend,
    onRemove:rowId=>{const camera=store.document.cameras.find(r=>r.id===rowId);if(camera)store.submit({kind:'remove',camera:clone(camera)});},
    onError:report
  });
  store.subscribe(update);
  let disposed=false,snapshotRequest=0;
  const stop=client.subscribe(state=>{
    if(disposed||!state||typeof state!=='object'||Array.isArray(state))return;
    const values=(state as any).values;
    if(!values||typeof values!=='object')return;
    adopt(values);
    grid.refresh();update();
    if(values.revision!==store.revision&&!store.pending.length){
      const request=++snapshotRequest,epoch=store.epoch,targetRevision=values.revision;
      void client.call('snapshot').then(reply=>{const next=reply as unknown as Snapshot;if(!disposed&&request===snapshotRequest&&epoch===store.epoch&&next.revision===targetRevision)store.observe(next,epoch);}).catch(()=>{});
    }
  });
  const canRead=(row:Camera)=>!!valueOf(row,'camera-host')&&!!valueOf(row,'camera-username')&&!!valueOf(row,'camera-password');
  const readIds=()=>readFieldIds(store.document.view);
  const failureOf=(row:Camera,error:unknown)=>valueOf(row,'camera-name')+': '+(error instanceof Error?error.message:'Camera operation failed.');
  function refreshCamera(rowId:string){
    const row=store.document.cameras.find(r=>r.id===rowId);if(!row||busy||!valueOf(row,'camera-host'))return;
    if(canRead(row)){void refreshCameras([row]);return;}
    report('Fill in this camera\u2019s Username and Password, then press Refresh.');
    if(loginVisible(store.document.view,'camera-username'))grid.select({rowId,columnId:'camera-username'});
  }
  function finish(messages:string[]){busy=false;grid.refresh();update();if(messages.length)report(messages.join(' '));}
  // Everything for one camera runs in order. Different cameras run side by side. Jobs handle their own failures.
  const cameraWork=new Map<string,Promise<void>>();
  function onCamera(rowId:string,job:()=>Promise<void>):Promise<void>{
    const run=(cameraWork.get(rowId)??Promise.resolve()).then(job);
    cameraWork.set(rowId,run);
    void run.finally(()=>{if(cameraWork.get(rowId)===run)cameraWork.delete(rowId);});
    return run;
  }
  // A value the camera has confirmed stops being staged, so the sheet goes back to showing what the camera reports.
  function dropConfirmed(rowId:string,verified:readonly {id:string;value:string}[]=[]){
    const row=store.document.cameras.find(r=>r.id===rowId),obs=rowObservation(rowId),open=grid.editing;
    if(!row||obs?.state!=='online')return;
    store.confirm(fields.filter(f=>{
      const value=row.values[f.id];
      if(!value||(open?.rowId===rowId&&open.columnId===f.id)||unsent.get(rowId)?.some(entry=>entry.id===f.id))return false;
      return value===obs.values[f.id]||verified.some(entry=>entry.id===f.id&&entry.value===value);
    }).map(f=>({rowId,columnId:f.id,value:'',expected:row.values[f.id]!})));
  }
  // A camera coming back or a new column is read quietly, without tying up the buttons or popping up a failure.
  async function refreshCameras(rows:Camera[],skipped:string[]=[],reason:'pressed'|'background'='pressed',fieldIds=readIds()){
    const quiet=reason!=='pressed';
    if(busy&&!quiet)return;
    if(!quiet){busy=true;report('');update();}
    const messages=[...skipped];
    await Promise.all(rows.map(row=>onCamera(row.id,async()=>{
      try {
        adopt(await client.call('refresh',{rowId:row.id,host:valueOf(row,'camera-host'),fieldIds}) as unknown as {observations?:Observations;sequence?:number});
        dropConfirmed(row.id);
      } catch(error){messages.push(failureOf(row,error));}
      grid.refresh();update();
    })));
    if(!quiet)finish(messages);
  }
  async function drainSends(rowId:string,messages:string[]){
    await store.whenSaved();
    try {
      for(let waiting=unsent.get(rowId)??[];waiting.length;waiting=unsent.get(rowId)??[]){
        const row=store.document.cameras.find(r=>r.id===rowId);if(!row)break;
        unsent.set(rowId,waiting.slice(16));
        // A save that failed or a newer edit means this is no longer the value to send.
        const batch=waiting.slice(0,16).filter(entry=>row.values[entry.id]===entry.value&&!store.invalid.has(rowId+'/'+entry.id));
        if(!batch.length)continue;
        const reply=await client.call('send',{rowId,host:valueOf(row,'camera-host'),fieldIds:batch.map(entry=>entry.id)}) as unknown as {observations?:Observations;sequence?:number;outcomes?:{fieldId:string;status:string;message?:string}[]};
        adopt(reply);
        for(const outcome of reply.outcomes??[])if(outcome.status==='failed')messages.push(valueOf(row,'camera-name')+', '+(fieldById.get(outcome.fieldId)?.label??'Setting')+': '+outcome.message);
        dropConfirmed(rowId,batch.filter(entry=>reply.outcomes?.some(outcome=>outcome.fieldId===entry.id&&outcome.status==='verified')));
        grid.refresh();update();
      }
    } catch(error){const row=store.document.cameras.find(r=>r.id===rowId);if(row)messages.push(failureOf(row,error));}
    finally{unsent.delete(rowId);}
    grid.refresh();update();
  }
  function queueSend(rowId:string,entries:{id:string;value:string}[],messages:string[]):Promise<void>{
    unsent.set(rowId,[...(unsent.get(rowId)??[]).filter(entry=>!entries.some(next=>next.id===entry.id)),...entries]);
    return onCamera(rowId,()=>drainSends(rowId,messages));
  }
  async function sendCameras(rowIds:string[]){
    if(busy)return;
    busy=true;report('');
    const messages:string[]=[];
    const runs=rowIds.map(rowId=>{const row=store.document.cameras.find(r=>r.id===rowId)!;return queueSend(rowId,pending(rowId).map(f=>({id:f.id,value:row.values[f.id]!})),messages);});
    update();
    await Promise.all(runs);
    finish(messages);
  }
  // Only the edit just committed goes. Anything staged earlier stays in the list, and Undo never sends.
  function autoSend(edits:CellEdit[]){
    if(!autoSendOn(store.document))return;
    const messages:string[]=[],runs:Promise<void>[]=[];
    for(const rowId of new Set(edits.map(edit=>edit.rowId))){
      const entries=edits.filter(edit=>edit.rowId===rowId&&edit.value&&fieldById.has(edit.columnId)).map(edit=>({id:edit.columnId,value:edit.value}));
      if(entries.length&&rowObservation(rowId)?.state==='online')runs.push(queueSend(rowId,entries,messages));
    }
    if(!runs.length)return;
    update();
    void Promise.all(runs).then(()=>{if(messages.length)report(messages.join(' '));});
  }
  // A standing choice like Live, so Undo leaves it alone.
  function setAutoSend(on:boolean){const expected=autoSendOn(store.document);if(on!==expected)store.submit({kind:'auto-send',autoSend:on,expected},false);}
  // While the page is open and showing: a camera that stops answering goes Offline, and one that answers again is read once.
  // A camera that refused us waits for Refresh, so a wrong password isn't retried every few seconds.
  const watchSeconds=3;
  let watchTimer:ReturnType<typeof setTimeout>|undefined;
  async function watchCameras(){
    if(!document.hidden&&store.document.cameras.some(r=>valueOf(r,'camera-host'))){
      try {
        const before=newestState,reply=await client.call('ping') as unknown as {answered?:string[];observations?:Observations;sequence?:number};
        adopt(reply);
        if(newestState!==before){grid.refresh();update();}
        // With Live on, the camera worker reads a returning camera itself as it reconnects, so the page doesn't read it a second time.
        const returned=liveOn(store.document)?[]:store.document.cameras.filter(r=>reply.answered?.includes(r.id)&&canRead(r)&&!['online','error'].includes(rowObservation(r.id)?.state??''));
        if(returned.length)await refreshCameras(returned,[],'background');
      } catch { /* The next pass tries again. */ }
    }
    if(!disposed)watchTimer=setTimeout(()=>void watchCameras(),watchSeconds*1000);
  }
  // Live: the camera pushes its changes over a connection the camera worker holds for as long as the saved switch is on,
  // so leaving this page doesn't stop it. While the page is open it waits on the worker, so a push shows straight away.
  type LiveReply={observations?:Observations;sequence?:number};
  function syncLive(){
    const on=liveOn(store.document);
    input('live-updates').checked=on;
    if(!pageReady||on===following)return;
    following=on;const run=++liveRun;
    if(on)void followLive(run);
  }
  async function followLive(run:number){
    while(run===liveRun&&!disposed){
      try {
        const before=newestState;
        adopt(await client.call('changes',{after:newestState}) as unknown as LiveReply);
        if(newestState!==before){grid.refresh();update();}
      } catch {await new Promise(resolve=>setTimeout(resolve,1000));}
    }
  }
  // A setting new to this view, ticked in Columns or on another tab, is read straight away, and Live follows it from then on.
  let knownFields=new Set<string>();
  async function readNewFields(fieldIds:string[]){
    const online=store.document.cameras.filter(r=>canRead(r)&&rowObservation(r.id)?.state==='online');
    if(online.length)await refreshCameras(online,[],'background',fieldIds);
  }
  function noticeNewFields(){
    const now=readIds(),added=now.filter(id=>!knownFields.has(id));
    knownFields=new Set(now);
    if(added.length)void readNewFields(added);
  }
  for(const id of ['add-camera','empty-add'])el(id).addEventListener('click',()=>showDialog());
  let cameraRemoval:Extract<Mutation,{kind:'cameras'}>|undefined;
  const countInput=input('camera-count'),removeDialog=el<HTMLDialogElement>('remove-dialog');
  countInput.addEventListener('change',()=>{
    const have=store.document.cameras.length;
    try {
      const operation=setCameraCount(store.document,countInput.value===''?NaN:Number(countInput.value),()=>crypto.randomUUID());
      if(!operation)return;
      const filled=operation.remove.filter(cameraHasData);
      if(!filled.length){store.submit(operation);return;}
      cameraRemoval=operation;
      el('remove-names').textContent=filled.map(camera=>valueOf(camera,'camera-name')).join(', ');
      el('remove-title').textContent='Remove '+operation.remove.length+' camera'+(operation.remove.length===1?'':'s')+'?';
      removeDialog.showModal();
    } catch(error){report(error instanceof Error?error.message:String(error));countInput.value=String(have);}
  });
  countInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();countInput.blur();}});
  el('remove-confirm').addEventListener('click',()=>{const operation=cameraRemoval;cameraRemoval=undefined;removeDialog.close();if(operation)store.submit(operation);});
  el('remove-cancel').addEventListener('click',()=>removeDialog.close());
  removeDialog.addEventListener('close',()=>{cameraRemoval=undefined;countInput.value=String(store.document.cameras.length);});
  el('refresh-camera').addEventListener('click',()=>{
    const addressed=store.document.cameras.filter(r=>valueOf(r,'camera-host')),ready=addressed.filter(canRead);
    if(ready.length){void refreshCameras(ready,addressed.filter(r=>!canRead(r)).map(r=>valueOf(r,'camera-name')+' needs a Username and Password.'));return;}
    const row=activeRow();if(row)refreshCamera(row.id);
  });
  el('pending-toggle').addEventListener('click',()=>togglePending(el('pending-toggle').getAttribute('aria-expanded')!=='true'));
  el('pending-close').addEventListener('click',()=>togglePending(false));
  el('alerts-toggle').addEventListener('click',()=>toggleAlerts(el('alerts-toggle').getAttribute('aria-expanded')!=='true'));
  el('alerts-close').addEventListener('click',()=>toggleAlerts(false));
  // A choice, not an edit to the plan, so Undo leaves it alone.
  for(const [id,key]of alertSwitches)input(id).addEventListener('change',()=>{const expected=alertChoices(store.document);store.submit({kind:'alerts',alerts:{...expected,[key]:input(id).checked},expected},false);});
  // Saved with the plan like the alert choices, and not an edit, so Undo leaves it alone.
  input('live-updates').addEventListener('change',()=>{const expected=liveOn(store.document);store.submit({kind:'live',live:input('live-updates').checked,expected},false);});
  el('send-manual').addEventListener('click',()=>setAutoSend(false));
  el('send-auto').addEventListener('click',()=>setAutoSend(true));
  const sendAll=()=>void sendCameras(store.document.cameras.filter(r=>rowObservation(r.id)?.state==='online'&&pending(r.id).length>0).map(r=>r.id));
  el('send-all').addEventListener('click',sendAll);el('send-all-bar').addEventListener('click',sendAll);
  el('cancel-all').addEventListener('click',()=>cancelSends(store.document.cameras.flatMap(r=>addresses(r.id))));
  for(const [id,expanded]of [['expand-all',true],['collapse-all',false]] as const)el(id).addEventListener('click',()=>{const view=clone(store.document.view);view.expanded=Object.fromEntries(groups.map(g=>[g.id,expanded]));store.submit(viewChange(store.document,view));});
  for(const [id,orientation]of orientationButtons)el(id).addEventListener('click',()=>{if((orientation==='columns')!==isFlipped(store.document))store.submit(setOrientation(store.document,activeSheetId(store.document),orientation));});
  el('details-toggle').addEventListener('click',()=>{const pane=el('setting-details');pane.hidden=!pane.hidden;el('details-toggle').setAttribute('aria-expanded',String(!pane.hidden));renderDetails();});
  for(const id of ['close-dialog','cancel-dialog'])el(id).addEventListener('click',()=>dialog.close());
  async function submitDialog(){
    if(el<HTMLButtonElement>('dialog-submit').disabled)return;
    el('dialog-error').hidden=true;
    try {
      const name=input('camera-name').value.trim(),host=input('camera-host').value.trim();
      if(!name)throw Error('Enter a camera name.');if(!validHost(host))throw Error('Enter a valid hostname or IPv4 address.');
      const rowId=crypto.randomUUID();
      if(!store.submit({kind:'add',camera:{id:rowId,values:{'camera-name':name,'camera-host':host}}}))throw Error(store.error);
      dialog.close();grid.select({rowId,columnId:'camera-name'});
    }catch(error){el('dialog-error').textContent=error instanceof Error?error.message:String(error);el('dialog-error').hidden=false;}
    finally{el<HTMLButtonElement>('dialog-submit').disabled=false;}
  }
  // Custom pages intentionally omit allow-forms. Handle user intent directly:
  // browsers may block the native submission before dispatching a submit event.
  form.addEventListener('submit',event=>{event.preventDefault();void submitDialog();});
  el('dialog-submit').addEventListener('click',event=>{event.preventDefault();void submitDialog();});
  form.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.isComposing&&event.target instanceof HTMLInputElement){event.preventDefault();void submitDialog();}
  });
  el('loading').hidden=true;pageReady=true;update();
  knownFields=new Set(readIds());store.subscribe(noticeNewFields);
  void watchCameras();
  const first=store.document.cameras[0];if(first)grid.select({rowId:first.id,columnId:'camera-name'});
  window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(watchTimer);stop();grid.dispose();textControls.dispose();sheetTabs.dispose();client.dispose();},{once:true});
}catch(error){el('loading').hidden=true;report(error instanceof Error?error.message:'Camera Control could not start.');saveStatus.textContent='Workspace unavailable';}
