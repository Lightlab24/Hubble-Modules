import { ModuleFrontendValueSchema, type connectModuleFrontend } from '@hubble/module-sdk/frontend';
import { mountSpreadsheetToolbar,createSpreadsheetContextMenu,type SpreadsheetMenuItem } from '@hubble/module-sdk/spreadsheet-controls';
import { clone,groups,type Field } from './model.js';
import { applyPresetMutation,basePreset,capturedOffers,capturedValues,inversePreset,isBase,knownValues,newRole,nameRowId,offeredChange,planSend,presetById,presetFields,resolvedValues,uniqueName,type PlannedSend,type PresetDocument,type PresetMutation,type SendChoice } from './presets-model.js';
import { Drafts,type Receipt } from './draft-store.js';
import { createPresetGrid,type Chosen } from './presets-grid.js';
import type { CameraSummary,Observations,PresetSends } from './backend.js';
import './presets.css';

type Client=Awaited<ReturnType<typeof connectModuleFrontend>>;
type Snapshot=Receipt<PresetDocument>&{cameras:CameraSummary[];observations:Observations;sequence?:number;presetSends?:PresetSends};
type Live={observations?:Observations;sequence?:number;presetSends?:PresetSends;cameras?:CameraSummary[];presetsRevision?:string|null};
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const plural=(n:number,word:string)=>n+' '+word+(n===1?'':'s');
export interface PresetsViewOptions { client:Client; report:(message:string,kind?:'error'|'info')=>void; onChange:()=>void }
/**
 * The Presets tab of Camera Control: camera roles kept in their own saved document.
 * It shares the page's connection and the worker's camera state, and only follows the worker while it is the open tab.
 */
export async function mountPresetsView({client,report,onChange}:PresetsViewOptions){
  let observations:Observations={},presetSends:PresetSends={},cameras:CameraSummary[]=[],newest=0,shown=false,disposed=false;
  // Cameras read in full while this tab was open, so a setting they don't report really is missing rather than not yet read.
  const fullyRead=new Map<string,string>(),reading=new Set<string>();
  function adopt(next:Live|undefined){
    if(!next)return;
    if(typeof next.sequence==='number'){if(next.sequence<newest)return;newest=next.sequence;}
    if(next.observations)observations=next.observations;
    if(next.presetSends)presetSends=next.presetSends;
    if(next.cameras)cameras=next.cameras;
  }
  const initial=await client.call('presets-snapshot') as unknown as Snapshot;
  adopt(initial);
  const store=new Drafts<PresetDocument,PresetMutation>(initial,async operation=>{
    const reply=await client.call('presets-save',ModuleFrontendValueSchema.parse({operation})) as unknown as Snapshot;
    adopt(reply);return reply;
  },applyPresetMutation,inversePreset);
  const doc=()=>store.document;
  const textControls=await mountSpreadsheetToolbar({root:el('preset-text-size'),textSize:{
    get:()=>doc().view.textSize??13,
    onChange(textSize){store.submit({kind:'view',view:{...clone(doc().view),textSize},expected:clone(doc().view)});}
  }});
  const menu=await createSpreadsheetContextMenu({root:el('preset-grid'),onError:error=>report(error.message)});
  // The Send box. A role is the usual choice; Base works too.
  const chosenPreset=()=>presetById(doc(),doc().send?.presetId)??doc().presets[1]??basePreset(doc());
  const chosenCamera=()=>cameras.find(c=>c.id===doc().send?.cameraId)??cameras.find(c=>c.host);
  const observationOf=(camera?:CameraSummary)=>{const o=camera&&observations[camera.id];return o&&o.host===camera!.host?o:undefined;};
  function plan():PlannedSend|undefined{
    const camera=chosenCamera(),obs=observationOf(camera),preset=chosenPreset();
    if(!camera||obs?.state!=='online')return undefined;
    const planned=planSend(resolvedValues(doc(),preset.id),obs.values,obs.choices);
    // Until the camera has been read in full, a setting it hasn't reported may simply not have been asked for yet.
    if(fullyRead.get(camera.id)!==camera.host)planned.skipped=planned.skipped.filter(entry=>obs.values[entry.id]);
    return planned;
  }
  const chosen=():Chosen=>{const camera=chosenCamera(),preset=chosenPreset(),job=camera?presetSends[camera.id]:undefined;return {presetId:preset.id,camera,observation:observationOf(camera),job:job?.host===camera?.host?job:undefined,plan:plan()};};
  function choices(field:Field){
    // What the module knows comes first, so these are dropdowns with or without a camera.
    const known=knownValues(field.id);
    if(known)return known.map(value=>({value,label:field.choices.find(c=>c.value===value)?.label??(field.kind==='boolean'?(value==='TRUE'?'On':'Off'):value)}));
    const seen=new Map<string,{value:string;label:string}>();
    for(const obs of Object.values(observations))for(const choice of obs.choices[field.id]??[])if(!seen.has(choice.value))seen.set(choice.value,choice);
    return [...seen.values()];
  }
  function setSend(next:SendChoice){const expected=clone(doc().send??{});const merged={...expected,...next};if(JSON.stringify(merged)!==JSON.stringify(expected))store.submit({kind:'send',send:merged,expected},false);}
  const grid=await createPresetGrid({
    table:el<HTMLTableElement>('preset-grid'),viewport:el('preset-viewport'),columnEditor:el('preset-column-editor'),store,chosen,choices,
    onSelect:()=>{},onZoom:ratio=>{if(shown)el('zoom-status').textContent=Math.round(ratio*100)+'%';},onError:report,
    onChoosePreset:presetId=>setSend({presetId}),
    onDuplicate(presetId){const source=presetById(doc(),presetId);if(!source)return;const id=crypto.randomUUID();
      store.submit({kind:'add',preset:{id,name:uniqueName(doc(),source.name+' copy'),values:clone(source.values)},index:doc().presets.indexOf(source)+1});},
    onRemove(presetId){const preset=presetById(doc(),presetId);if(preset&&!isBase(preset))store.submit({kind:'remove',preset:clone(preset),index:doc().presets.indexOf(preset)});},
    onRefreshCamera:()=>{const camera=chosenCamera();if(camera)void readCamera(camera,'pressed');}
  });
  let busy='';
  function update(){
    onChange();
    if(!shown)return;
    textControls.refresh();
    const preset=chosenPreset(),camera=chosenCamera(),obs=observationOf(camera),job=chosen().job,planned=plan();
    el('pick-preset-name').textContent=preset.name;
    el('pick-camera-name').textContent=camera?.name??'Choose camera';el('pick-camera-host').textContent=camera?.host??'';
    const send=el<HTMLButtonElement>('preset-send'),stop=el<HTMLButtonElement>('preset-stop'),count=planned?.send.length??0,rolling=obs?.recording==='recording';
    stop.hidden=!job?.running;
    send.disabled=!!busy||!!job?.running||!camera||obs?.state!=='online'||rolling||count===0||store.pending.length>0;
    el('preset-send-label').textContent=job?.running?'Sending '+job.settled+' of '+job.total+'…':count?'Send '+plural(count,'change'):'Send';
    send.title=!camera?'Choose a camera in the Send box':obs?.state!=='online'?camera.name+' isn’t online':rolling?camera.name+' is rolling':count?'Write '+plural(count,'setting')+' from '+preset.name+' to '+camera.name+', each confirmed by the camera':camera.name+' already matches '+preset.name;
    // One line at the bottom says where the send stands, so nothing in the sheet moves.
    let status='',kind='';
    if(job?.running){status='Sending '+job.name+' to '+camera!.name+': '+job.settled+' of '+job.total+(job.failed.length?' · '+job.failed.length+' failed':'');kind='active';}
    else if(job?.finishedAt&&job.presetId===preset.id&&!job.error&&count===0&&!job.failed.length){status=job.name+' is on '+camera!.name+': '+plural(job.done,'setting')+' confirmed'+(job.skipped.length?' · '+job.skipped.length+' skipped':'');kind='done';}
    else if(job?.finishedAt&&(job.error||job.failed.length)){status=job.name+' → '+camera!.name+': '+job.done+' confirmed'+(job.failed.length?', '+job.failed.length+' failed':'')+(job.skipped.length?', '+job.skipped.length+' skipped':'')+(job.error?' · '+job.error:'');kind='failed';}
    else if(!Object.keys(resolvedValues(doc(),preset.id)).length)status=preset.name+' holds no settings yet. Capture a camera into Base.';
    else if(!camera)status='Choose a camera to compare with '+preset.name;
    else if(obs?.state!=='online')status=camera.name+(obs?.state==='error'?' couldn’t be read':' isn’t answering');
    else if(rolling)status=camera.name+' is rolling. Send when it stops.';
    else if(planned){status=count?preset.name+' → '+camera.name+': '+plural(count,'setting')+' differ'+(planned.skipped.length?' · '+planned.skipped.length+' can’t be sent':''):camera.name+' matches '+preset.name+(planned.skipped.length?' · '+planned.skipped.length+' can’t be sent':'');kind=count?'pending':'done';}
    const line=el('preset-status');line.textContent=status;line.dataset.kind=kind;
    const save=el('save-status');save.textContent=store.error||(store.pending.length?'Saving…':store.invalid.size?'Correct the highlighted cell':busy||'Workspace saved');
    save.dataset.error=String(!!store.error||store.invalid.size>0);
    el<HTMLButtonElement>('preset-capture').disabled=!!busy||!cameras.some(c=>c.host);
    // A camera that comes back, or a newly chosen one, is read in full so the comparison covers everything the preset holds.
    if(camera&&obs?.state==='online'&&fullyRead.get(camera.id)!==camera.host&&!reading.has(camera.id))void readCamera(camera,'quiet');
  }
  let lastError='';
  store.subscribe(()=>{if(store.error!==lastError){lastError=store.error;if(lastError&&shown)report(lastError);}grid.refresh();update();});
  const refresh=()=>{if(shown)grid.refresh();update();};

  // Reading a camera asks for everything a preset can hold, so the comparison and a capture see the whole camera.
  async function readCamera(camera:CameraSummary,reason:'pressed'|'quiet'):Promise<boolean>{
    if(!camera.host)return false;
    if(!camera.login){if(reason==='pressed')report(camera.name+' needs a Username and Password. Add them on the Cameras tab.');return false;}
    reading.add(camera.id);
    try {
      const reply=await client.call('refresh',{rowId:camera.id,host:camera.host,fieldIds:presetFields.map(f=>f.id)}) as unknown as Live&{status?:string};
      adopt(reply);
      if(reply.status==='offline'){if(reason==='pressed')report(camera.name+' didn’t answer.');return false;}
      fullyRead.set(camera.id,camera.host);return true;
    } catch(error){if(reason==='pressed')report(camera.name+': '+(error instanceof Error?error.message:'couldn’t be read.'));return false;}
    finally{reading.delete(camera.id);refresh();}
  }
  async function capture(camera:CameraSummary,into:'base'|'new'){
    if(busy)return;
    busy='Reading '+camera.name+'…';update();
    try {
      if(!await readCamera(camera,'pressed'))return;
      const obs=observationOf(camera);if(obs?.state!=='online'){report(camera.name+' couldn’t be read.');return;}
      const {values,dropped}=capturedValues(obs.values),count=Object.keys(values).length;
      if(!count){report(camera.name+' reported no settings a preset can hold.');return;}
      // The values the camera allows for each setting come with it, so the dropdowns offer only those.
      const offers=capturedOffers(obs.choices,values),lists=Object.keys(offers).length,change=offeredChange(doc(),offers);
      if(into==='base'){const base=basePreset(doc());store.submit({kind:'values',presetId:base.id,values,expected:clone(base.values),...change});}
      else{const id=crypto.randomUUID();store.submit({kind:'add',preset:{id,name:uniqueName(doc(),camera.name),values},index:doc().presets.length,...change});grid.select({rowId:nameRowId,columnId:id});}
      report('Captured '+plural(count,'setting')+' from '+camera.name+(into==='base'?' into Base':' as a new preset')+(lists?', with the values it allows for '+plural(lists,'setting'):'')+(dropped.length?'. '+plural(dropped.length,'setting')+' had values a preset can’t hold yet.':'.'),'info');
    } finally {busy='';refresh();}
  }
  async function sendPreset(){
    const preset=chosenPreset(),camera=chosenCamera();if(!camera||busy)return;
    busy='Checking '+camera.name+'…';update();
    try {
      // The worker sends what is saved, so every edit lands first.
      await store.whenSaved();
      adopt(await client.call('send-preset',{presetId:preset.id,rowId:camera.id,host:camera.host}) as unknown as Live);
      fullyRead.set(camera.id,camera.host);
    } catch(error){report(error instanceof Error?error.message:'The preset couldn’t be sent.');}
    finally{busy='';refresh();}
  }
  // Toolbar pickers use Hubble's own menu.
  function openMenu(button:HTMLElement,label:string,items:SpreadsheetMenuItem[]){
    const box=button.getBoundingClientRect();button.setAttribute('aria-expanded','true');
    menu.open({x:box.left,y:box.bottom+4,label,items});
    const reset=()=>button.setAttribute('aria-expanded','false');setTimeout(()=>document.addEventListener('pointerdown',reset,{once:true,capture:true}),0);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')reset();},{once:true});
  }
  const cameraState=(camera:CameraSummary)=>{const obs=observationOf(camera);return !camera.host?'No address':!camera.login?'No login':obs?.state==='online'?(obs.recording==='recording'?'Rolling':'Ready'):obs?.state==='error'?'Read failed':obs?'Offline':'Not read';};
  const openCapture=(button:HTMLElement)=>{
    if(!cameras.length){report('Add cameras on the Cameras tab first.');return;}
    openMenu(button,'Capture every setting from',cameras.map(camera=>({id:camera.id,label:camera.name+' · '+cameraState(camera),disabled:!camera.host||!camera.login,items:[
      {id:'base',label:'Into Base (replaces '+plural(Object.keys(basePreset(doc()).values).length,'setting')+')',run:()=>void capture(camera,'base')},
      {id:'new',label:'As a new preset',icon:'add' as const,run:()=>void capture(camera,'new')}
    ]})));
  };
  el('preset-capture').addEventListener('click',()=>openCapture(el('preset-capture')));
  el('pick-preset').addEventListener('click',()=>openMenu(el('pick-preset'),'Send which preset',doc().presets.map(preset=>({id:preset.id,label:preset.name+(preset.id===chosenPreset().id?'  ✓':''),run:()=>setSend({presetId:preset.id})}))));
  el('pick-camera').addEventListener('click',()=>{
    if(!cameras.length){report('Add cameras on the Cameras tab first.');return;}
    openMenu(el('pick-camera'),'Send to which camera',cameras.map(camera=>({id:camera.id,label:camera.name+(camera.host?' · '+camera.host:'')+' · '+cameraState(camera)+(camera.id===chosenCamera()?.id?'  ✓':''),disabled:!camera.host,run:()=>{setSend({cameraId:camera.id});void readCamera(camera,'pressed');}})));
  });
  el('preset-send').addEventListener('click',()=>void sendPreset());
  el('preset-stop').addEventListener('click',()=>{const camera=chosenCamera();if(camera)void client.call('cancel-preset',{rowId:camera.id}).then(reply=>{adopt(reply as unknown as Live);refresh();}).catch(error=>report(error instanceof Error?error.message:String(error)));});
  el('new-preset').addEventListener('click',()=>{
    const preset=newRole(doc(),crypto.randomUUID());
    if(store.submit({kind:'add',preset,index:doc().presets.length})){setSend({presetId:preset.id});grid.select({rowId:nameRowId,columnId:preset.id});}
  });
  for(const [id,expanded]of [['preset-expand-all',true],['preset-collapse-all',false]] as const)el(id).addEventListener('click',()=>{const view=clone(doc().view);view.expanded=Object.fromEntries(groups.map(g=>[g.id,expanded]));store.submit({kind:'view',view,expected:clone(doc().view)});});

  // Hubble hands state over on its own slow cycle, so while the tab is open it also waits on the worker for each change.
  let snapshotRequest=0,following=0;
  const stopState=client.subscribe(state=>{
    if(disposed||!state||typeof state!=='object'||Array.isArray(state))return;
    const values=(state as {values?:Live}).values;if(!values||typeof values!=='object')return;
    adopt(values);refresh();
    if(values.presetsRevision&&values.presetsRevision!==store.revision&&!store.pending.length){
      const request=++snapshotRequest,epoch=store.epoch,target=values.presetsRevision;
      void client.call('presets-snapshot').then(reply=>{const next=reply as unknown as Snapshot;if(!disposed&&request===snapshotRequest&&next.revision===target){adopt(next);store.observe(next,epoch);}}).catch(()=>{});
    }
  });
  async function follow(run:number){
    while(!disposed&&shown&&run===following){
      try {const before=newest;adopt(await client.call('changes',{after:newest}) as unknown as Live);if(newest!==before)refresh();}
      catch {await new Promise(resolve=>setTimeout(resolve,1000));}
    }
  }
  el('preset-loading').hidden=true;
  return {
    get count(){return doc().presets.length;},
    get shown(){return shown;},
    show(){
      if(shown)return;shown=true;
      void follow(++following);
      grid.refresh();update();
      const camera=chosenCamera();if(camera)void readCamera(camera,'quiet');
      if(!grid.active)grid.select({rowId:nameRowId,columnId:chosenPreset().id});
    },
    hide(){shown=false;following++;},
    dispose(){disposed=true;following++;stopState();grid.dispose();textControls.dispose();menu.dispose();}
  };
}
