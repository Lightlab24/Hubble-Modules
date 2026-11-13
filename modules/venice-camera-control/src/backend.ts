import { createModuleDocumentClient, ModuleDocumentConflictError, ModuleDocumentValueSchema, type HubbleModule, type ModuleJsonValue } from '@hubble/module-sdk';
import { CameraClient, CameraOfflineError } from './camera-client.js';
import { pingCamera } from './camera-ping.js';
import { alertChoices, applyMutation, fieldById, fields, liveOn, readFieldIds, validateDocument, type CameraDocument, type Mutation, type Camera, type Field } from './model.js';
import { readFields, decodeField, writeField, fieldProperties, baseIsoChoices, ndChoices, recordingProperties, recordingState, recordingSignals, clipNameProperty } from './protocol.js';
export interface Observation { state:'offline'|'online'|'error'; host:string; values:Record<string,string>; choices:Record<string,{value:string;label:string}[]>; updatedAt?:string; errors:Record<string,string>; sending:string[]; queued:string[]; live?:boolean; recording?:string }
export type Observations=Record<string,Observation>;
export function createBackend(context:Parameters<HubbleModule['createInstance']>[0],ping:typeof pingCamera=pingCamera,options:{keepAliveMs?:number;keepAliveTimeoutMs?:number;watchMs?:number}={}) {
  if(!context.services)throw Error('Camera Control requires Hubble portable documents.');
  const documents=createModuleDocumentClient(context.services),lifetime=new AbortController();
  const clients=new Set<CameraClient>(),observations:Observations={};
  let latestRevision:string|null=null,sequence=0,plan:CameraDocument|undefined;
  // Clock-based so it keeps rising across a worker restart. The page uses it to ignore state that arrives late.
  const waiters=new Set<()=>void>();
  const publish=()=>{sequence=Math.max(sequence+1,Date.now());context.publishState({phase:'ready',message:null,observedAt:new Date().toISOString(),values:{revision:latestRevision,sequence,observations:ModuleDocumentValueSchema.parse(observations)}});for(const wake of [...waiters])wake();};
  // Pushes can come in bursts, so the page hears about them at most ten times a second.
  let publishTimer:ReturnType<typeof setTimeout>|undefined;
  const publishSoon=()=>{publishTimer??=setTimeout(()=>{publishTimer=undefined;publish();},100);};
  const snapshot=async(signal:AbortSignal)=>{
    const saved=await documents.read('camera-plan',signal);latestRevision=saved.revision;const doc=validateDocument(saved.value);planChanged(doc);
    return {document:doc,revision:saved.revision,observations,sequence};
  };
  const activeCamera=(doc:CameraDocument,id:unknown):Camera=>{const row=doc.cameras.find(r=>r.id===id);if(!row)throw Error('Choose a camera in this workspace.');return row;};
  const selectFields=(raw:unknown):Field[]=>{
    if(!Array.isArray(raw)||raw.length>265)throw Error('Invalid setting selection.');
    return [...new Set(raw)].map(id=>{if(typeof id!=='string'||!fieldById.has(id))throw Error('Unknown camera setting.');return fieldById.get(id)!;});
  };
  const stateFor=(row:Camera):Observation=>observations[row.id]??(observations[row.id]={state:'offline',host:row.values['camera-host']!,values:{},choices:{},errors:{},sending:[],queued:[]});
  async function open(row:Camera,signal:AbortSignal,pinged=false):Promise<CameraClient> {
    if(context.connectionEnabled===false)throw Error('Device connections are disabled.');
    const host=row.values['camera-host']??'',username=row.values['camera-username'],password=row.values['camera-password'];
    if(!host)throw Error('Enter this camera\u2019s IP address first.');
    // A camera's login is only ever its Username and Password fields.
    const auth=username&&password?{username,password}:undefined;
    if(!auth)throw Error('Fill in this camera\u2019s Username and Password first.');
    const combined=AbortSignal.any([signal,lifetime.signal]);
    // A camera that doesn't answer a ping gets no login attempt. If ping couldn't run, try the camera anyway.
    // A Live start comes straight from a pass that just heard the camera, so it doesn't ask twice.
    if(!pinged&&await ping(host,combined)==='silent')throw new CameraOfflineError('Camera did not answer a ping.');
    combined.throwIfAborted();
    const client=await CameraClient.connect(host,auth,combined);combined.throwIfAborted();clients.add(client);return client;
  }
  function close(client:CameraClient){client.close();clients.delete(client);}
  // Which cameras have been seen, so one dropping out can be told apart from one that was never there.
  interface Presence {host:string;misses:number;alerted:boolean}
  const presence=new Map<string,Presence>();
  const alertName=(row:Camera)=>row.values['camera-name']||row.values['camera-host']||row.id;
  function noticed(row:Camera,result:'answered'|'silent'|'unknown',confirmed=false){
    const host=row.values['camera-host']??'',seen=presence.get(row.id);
    if(!seen||seen.host!==host){presence.delete(row.id);if(result==='answered')presence.set(row.id,{host,misses:0,alerted:false});return;}
    if(result==='unknown')return;
    if(result==='answered'){
      seen.misses=0;if(!seen.alerted)return;seen.alerted=false;
      context.log({level:'info',stage:'camera-presence',message:alertName(row)+' answered again at '+host});
      // Alerts are the operator's choice in the Alerts panel, and every choice starts off.
      const choices=alertChoices(plan);
      if(choices.onlineNotification)context.publishEvent?.('host.alert.v1',{key:'camera-up:'+row.id,title:('Camera back online: '+alertName(row)).slice(0,120),body:host+' is answering again.',severity:'info',notification:true,dockBounce:false});
      return;
    }
    // One lost ping can be the network. Two in a row, or a lost Live connection that then misses a ping, is the camera.
    seen.misses=confirmed?2:seen.misses+1;
    if(seen.misses<2||seen.alerted)return;
    seen.alerted=true;
    context.log({level:'error',stage:'camera-presence',message:alertName(row)+' stopped answering at '+host});
    const choices=alertChoices(plan);
    if(choices.offlineNotification||choices.offlineBounce)context.publishEvent?.('host.alert.v1',{key:'camera-down:'+row.id,title:('Camera offline: '+alertName(row)).slice(0,120),body:host+' stopped answering.',severity:'critical',notification:choices.offlineNotification,dockBounce:choices.offlineBounce});
  }
  // Only ever a 4-byte echo. The page and the background watch share one pass, so a camera is never pinged twice over.
  let passing:Promise<string[]>|undefined,lastPass=0,watchTimer:ReturnType<typeof setTimeout>|undefined;
  const pingPass=(doc:CameraDocument)=>passing??=(async()=>{
    const answered:string[]=[],reachable:string[]=[];let changed=false;
    for(const id of presence.keys())if(!doc.cameras.some(row=>row.id===id))presence.delete(id);
    await Promise.all(doc.cameras.filter(row=>row.values['camera-host']&&!liveSessions.has(row.id)).map(async row=>{
      const seen=observations[row.id]?.updatedAt,result=await ping(row.values['camera-host']!,lifetime.signal);
      noticed(row,result);
      if(result==='answered'){answered.push(row.id);reachable.push(row.id);return;}
      // Ping couldn't run, which says nothing. A camera that was just read is still worth following, as before ping existed.
      if(result==='unknown'&&observations[row.id]?.state==='online')reachable.push(row.id);
      const state=observations[row.id];
      // A read that landed during the ping, or a send still running, knows better than a missed echo.
      if(result!=='silent'||!state||state.state==='offline'||state.updatedAt!==seen||state.sending.length||state.queued.length)return;
      state.state='offline';state.values={};state.choices={};changed=true;
    }));
    if(changed)publish();
    // Live is the operator's standing choice, so every camera that answers and has a login is followed, page open or not.
    if(liveWanted())for(const row of doc.cameras)if(reachable.includes(row.id)&&canLogIn(row))void startLive(row,answered.includes(row.id));
    return answered;
  })().finally(()=>{passing=undefined;lastPass=Date.now();});
  const watchMs=options.watchMs??0;
  // The page stops watching when it isn't on screen. This keeps going, so a drop is reported from any page.
  function watch(){watchTimer=setTimeout(async()=>{try{if(plan&&Date.now()-lastPass>=watchMs-500)await pingPass(plan);}catch{/* The next pass tries again. */}if(!lifetime.signal.aborted)watch();},watchMs);}
  // Live updates: one connection held open per camera for as long as the saved Live switch is on.
  // The worker holds them, so leaving the page or closing HubDash doesn't end them. Only switching Live off does.
  interface LiveSession {client:CameraClient;host:string;fields:Field[];raw:Record<string,any>;keepAlive?:ReturnType<typeof setInterval>}
  // A refusal is remembered against the login that was refused, so fixing the Username or Password tries again.
  const liveSessions=new Map<string,LiveSession>(),liveOpening=new Set<string>(),liveRefused=new Map<string,string>();
  const keepAliveMs=options.keepAliveMs??3000,keepAliveTimeoutMs=options.keepAliveTimeoutMs??2000;
  const liveWanted=()=>context.connectionEnabled!==false&&liveOn(plan);
  // What the open tab shows, the same list the page reads, so a push lands in a cell someone can see.
  const liveFields=():Field[]=>plan?readFieldIds(plan.view).map(id=>fieldById.get(id)!):[];
  const canLogIn=(row:Camera)=>!!(row.values['camera-host']&&row.values['camera-username']&&row.values['camera-password']);
  const loginOf=(row:Camera)=>JSON.stringify([row.values['camera-host']??'',row.values['camera-username']??'',row.values['camera-password']??'']);
  function endLive(rowId:string){
    const session=liveSessions.get(rowId);if(!session)return;
    liveSessions.delete(rowId);clearInterval(session.keepAlive);close(session.client);
    const state=observations[rowId];if(state?.live){delete state.live;publishSoon();}
  }
  function endAllLive(){for(const rowId of [...liveSessions.keys()])endLive(rowId);}
  // Brings the held connections in line with the plan: Live off ends them all, a removed or re-addressed camera ends its own,
  // and the others follow whatever the open tab now shows.
  function reconcileLive(){
    if(!liveWanted()){endAllLive();liveRefused.clear();return;}
    const wanted=liveFields();
    for(const [rowId,session]of [...liveSessions]){
      const row=plan!.cameras.find(r=>r.id===rowId);
      if(!row||row.values['camera-host']!==session.host){endLive(rowId);continue;}
      session.fields=wanted;
    }
    for(const [rowId,login]of [...liveRefused]){const row=plan!.cameras.find(r=>r.id===rowId);if(!row||loginOf(row)!==login)liveRefused.delete(rowId);}
  }
  function planChanged(doc:CameraDocument){
    const was=liveWanted();plan=doc;reconcileLive();
    // Switching Live on reaches the cameras straight away rather than at the next watch pass.
    if(!was&&liveWanted())void pingPass(doc).catch(()=>{});
  }
  // The connection is gone, so one ping says whether the camera went with it. If it answers, the next pass reconnects.
  async function liveLost(rowId:string,session:LiveSession){
    if(liveSessions.get(rowId)!==session)return;
    endLive(rowId);
    const result=await ping(session.host,lifetime.signal).catch(()=>'unknown' as const),state=observations[rowId],row=plan?.cameras.find(r=>r.id===rowId);
    if(!lifetime.signal.aborted)context.log({level:'info',stage:'camera-live',message:(row?valueLabel(row):rowId)+' Live connection ended; ping '+result});
    if(row&&row.values['camera-host']===session.host)noticed(row,result,true);
    if(result!=='silent'||state?.state!=='online'||state.host!==session.host||state.sending.length||state.queued.length)return;
    state.state='offline';state.values={};state.choices={};publish();
  }
  // One line each time a camera's recording state changes, with what the camera said, so a wrong REC can be traced.
  function noteRecording(rowId:string,next:string,raw:Record<string,any>){
    const row=plan?.cameras.find(r=>r.id===rowId);
    context.log({level:'info',stage:'camera-recording',message:(row?valueLabel(row):rowId)+' '+(next||'no state')+' ('+recordingSignals(raw)+')'});
  }
  function applyPush(rowId:string,session:LiveSession,changes:unknown){
    const state=observations[rowId];
    if(!state||liveSessions.get(rowId)!==session||!changes||typeof changes!=='object')return;
    Object.assign(session.raw,changes);
    let changed=false;
    for(const field of session.fields){
      if(!fieldProperties(field).some(property=>property in changes))continue;
      const next=decodeField(field,session.raw);
      if(next!==state.values[field.id]){state.values[field.id]=next;changed=true;}
    }
    if(recordingProperties.some(property=>property in changes)){const next=recordingState(session.raw);if(next!==(state.recording??'')){noteRecording(rowId,next,session.raw);state.recording=next;changed=true;}}
    if(changed){state.updatedAt=new Date().toISOString();publishSoon();}
  }
  async function startLive(row:Camera,pinged=false){
    const login=loginOf(row);
    if(liveOpening.has(row.id)||liveSessions.has(row.id)||liveRefused.get(row.id)===login)return;
    liveOpening.add(row.id);
    let client:CameraClient|undefined;
    try {
      client=await open(row,lifetime.signal,pinged);
      const session:LiveSession={client,host:row.values['camera-host']!,fields:liveFields(),raw:{}};
      client.onClosed=()=>void liveLost(row.id,session);
      client.onNotification=(name,data)=>{if(name==='Notify.Property.Value.Changed')applyPush(row.id,session,(data as unknown[])?.[0]);};
      // The current values first, so the sheet is right before the first push. This is also the camera's read, so Live needs no Refresh.
      session.raw=await update(client,row,session.fields,lifetime.signal);
      const subscribed=await client.rpc('Notify.Subscribe',['Notify.Properties','Notify.Process','Notify.Property'],lifetime.signal);
      context.log({level:'info',stage:'camera-live',message:valueLabel(row)+' Live on, following '+session.fields.length+' settings; subscribe answered '+(JSON.stringify(subscribed)??'nothing').slice(0,200)});
      const current=plan?.cameras.find(r=>r.id===row.id),state=observations[row.id];
      // Live went off, or the camera was removed or its login changed, while this was connecting.
      if(!liveWanted()||!current||loginOf(current)!==login||!state||state.state!=='online'){close(client);return;}
      session.fields=liveFields();
      liveSessions.set(row.id,session);state.live=true;delete state.errors['connection-status'];publish();
      // Sony's page asks every 3 seconds and gives up after 2. While this answers, the camera needs no ping.
      const keptClient=client;
      session.keepAlive=setInterval(()=>{keptClient.rpc('Property.GetValue',{'Network.Connection.KeepAlive':['cam']},lifetime.signal,keepAliveTimeoutMs).catch(()=>void liveLost(row.id,session));},keepAliveMs);
    } catch(error) {
      if(client)close(client);
      if(lifetime.signal.aborted||error instanceof CameraOfflineError)return;
      // Refused rather than lost, so it isn't tried again until Live is switched off and on, the login changes or Refresh reads it.
      liveRefused.set(row.id,login);
      const message=error instanceof Error?error.message:'Live updates failed.',state=stateFor(row);
      context.log({level:'error',stage:'camera-live',message:valueLabel(row)+': '+message});
      if(state.state!=='online')state.state='error';
      state.errors['connection-status']='Live updates unavailable: '+message;publishSoon();
    } finally {liveOpening.delete(row.id);}
  }
  const valueLabel=(row:Camera)=>row.values['camera-name']??row.id;
  async function update(client:CameraClient,row:Camera,selected:Field[],signal:AbortSignal):Promise<Record<string,any>> {
    const raw=await readFields(client,selected,signal,recordingProperties),state=stateFor(row),held=liveSessions.get(row.id);
    const recording=recordingState(raw);if(recording!==(state.recording??''))noteRecording(row.id,recording,raw);state.recording=recording;
    if(held?.client===client)Object.assign(held.raw,raw);
    state.state='online';state.host=row.values['camera-host']!;state.updatedAt=new Date().toISOString();noticed(row,'answered');
    for(const field of selected)state.values[field.id]=decodeField(field,raw);
    if(selected.some(field=>field.id==='base-iso')){const pair=baseIsoChoices(state.values['base-iso']!);if(pair.length)state.choices['base-iso']=pair.map(value=>({value,label:value}));}
    if(selected.some(field=>field.id==='nd')){state.choices.nd=ndChoices.map(value=>({value,label:value}));context.log({level:'info',stage:'camera-nd',message:valueLabel(row)+' ND value '+JSON.stringify(raw['Camera.NDFilter.Value'])+' mode '+JSON.stringify(raw['Camera.NDFilter.Mode'])});}
    try {
      const names=[...new Set(selected.flatMap(fieldProperties))].filter(name=>name!==clipNameProperty),caps=names.length?await client.rpc('Capability.GetValue',names,signal):{};
      for(const field of selected) {
        const key=field.property.split(' / ')[0]!.replace(/ \[[^\]]+\]$/,''),axis=/\[([^\]]+)\]$/.exec(field.property)?.[1]??'cam';
        let list=caps?.[key]?.[2];if(list&&!Array.isArray(list)&&typeof list==='object')list=list[axis];
        if(!Array.isArray(list))continue;
        state.choices[field.id]=list.filter(v=>['string','number','boolean'].includes(typeof v)).slice(0,1000).map(v=>{const actual=decodeField(field,{[key]:v});return {value:actual,label:field.choices.find(c=>c.value===actual)?.label??actual};}).filter(c=>!!c.value);
      }
    } catch(error){if(signal.aborted)throw error;}
    publish();
    return raw;
  }
  return {
    async execute(){throw Error('This workspace module has no Matrix actions.');},
    async start(){
      await snapshot(lifetime.signal);publish();
      if(watchMs>0&&context.connectionEnabled!==false)watch();
      void (async()=>{for await(const saved of documents.watch('camera-plan',lifetime.signal)){
        latestRevision=saved.revision;const doc=validateDocument(saved.value);planChanged(doc);
        for(const [id,seen]of Object.entries(observations)){
          const row=doc.cameras.find(r=>r.id===id);
          if(!row||(row.values['camera-host']??'')!==seen.host){delete observations[id];continue;}
          // A failure only means something while that change is still waiting to go.
          for(const field of Object.keys(seen.errors))if(!row.values[field])delete seen.errors[field];
        }
        publish();
      }})().catch(()=>{if(!lifetime.signal.aborted)context.log({level:'error',stage:'camera-plan-watch',message:'Camera plan observation stopped.'});});
    },
    async call(method:string,raw:ModuleJsonValue|undefined,execution:{signal:AbortSignal}):Promise<ModuleJsonValue>{
      if(method!=='page.cameras'||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Unknown camera page command.');
      const command=raw as {sectionId?:string;commandId?:string;value?:any};
      if(command.sectionId!=='frontend')throw Error('Unknown camera view.');
      const {signal}=execution;signal.throwIfAborted();
      if(command.commandId==='snapshot')return await snapshot(signal) as unknown as ModuleJsonValue;
      if(command.commandId==='save') {
        const operation=command.value?.operation as Mutation;
        for(let attempt=0;attempt<3;attempt++) {
          const saved=await documents.read('camera-plan',signal),next=applyMutation(validateDocument(saved.value),operation);
          try {const result=await documents.write(saved,ModuleDocumentValueSchema.parse(next),signal);latestRevision=result.revision;planChanged(next);publish();return {document:next,revision:result.revision,observations,sequence} as unknown as ModuleJsonValue;}
          catch(error){if(!(error instanceof ModuleDocumentConflictError)||attempt===2)throw error;}
        }
        throw Error('Camera plan changed before saving.');
      }
      if(command.commandId==='cancel-send') {
        // Whatever is mid-write finishes. Everything behind it comes out of the queue.
        const state=observations[String(command.value?.rowId)];
        if(state){const drop=new Set(Array.isArray(command.value?.fieldIds)?command.value.fieldIds:state.queued);state.queued=state.queued.filter(id=>!drop.has(id));publish();}
        return {status:'cancelled'};
      }
      if(command.commandId==='changes') {
        // Parks until something changes, so a camera's push reaches the page straight away.
        const after=Number(command.value?.after??0);
        if(sequence<=after)await new Promise<void>(resolve=>{
          const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);waiters.delete(finish);resolve();};
          const timer=setTimeout(finish,20000);
          signal.addEventListener('abort',finish,{once:true});waiters.add(finish);
        });
        return {observations,sequence} as unknown as ModuleJsonValue;
      }
      if(command.commandId==='ping') {
        if(context.connectionEnabled===false)return {answered:[],observations,sequence} as unknown as ModuleJsonValue;
        const answered=await pingPass((await snapshot(signal)).document);
        return {answered,observations,sequence} as unknown as ModuleJsonValue;
      }
      const input=command.value??{},doc=(await snapshot(signal)).document,row=activeCamera(doc,input.rowId);
      if(input.host!==(row.values['camera-host']??''))throw Error('Camera address changed. Reconnect using the current address.');
      if(command.commandId==='disconnect'){delete observations[row.id];publish();return {status:'disconnected'};}
      const selected=selectFields(input.fieldIds??fields.filter(f=>f.verified).map(f=>f.id)),state=stateFor(row);
      if(!['refresh','send'].includes(command.commandId??''))throw Error('Unknown camera operation.');
      if(command.commandId==='send') {
        if(selected.length>32)throw Error('Send up to 32 fields per camera batch.');
        // Queued before connecting, so a cancel during the login still counts.
        state.queued=selected.map(f=>f.id);publish();
      }
      let client:CameraClient|undefined;
      const session=liveSessions.get(row.id);
      try {
        client=session?.client??await open(row,signal);
        // A camera whose login failed is tried for Live again once a Refresh gets in. A quiet read of a camera that only refused to subscribe changes nothing.
        if(command.commandId==='refresh'){const failed=state.state==='error';await update(client,row,selected,signal);if(failed)liveRefused.delete(row.id);return {status:'read',observations,sequence} as unknown as ModuleJsonValue;}
        const outcomes:{fieldId:string;status:string;message?:string}[]=[];
        while(state.queued.length) {
          signal.throwIfAborted();
          const field=fieldById.get(state.queued.shift()!)!;
          // The saved plan decides at the moment of writing, so a change cancelled since Send never goes out.
          const latest=(await snapshot(signal)).document.cameras.find(r=>r.id===row.id);
          if(!latest||latest.values['camera-host']!==row.values['camera-host'])break;
          const value=latest.values[field.id];delete state.errors[field.id];
          if(!value||value===state.values[field.id])continue;
          state.sending=[field.id];publish();
          try {const after=await writeField(client,field,value,latest,signal);for(const other of selected){const decoded=decodeField(other,after);if(decoded!=='')state.values[other.id]=decoded;}state.values[field.id]=decodeField(field,after);state.state='online';state.updatedAt=new Date().toISOString();delete state.errors[field.id];outcomes.push({fieldId:field.id,status:'verified'});context.log({level:'info',stage:'camera-send',message:valueLabel(row)+' '+field.id+' confirmed'});}
          catch(error){if(signal.aborted||error instanceof CameraOfflineError)throw error;const message=error instanceof Error?error.message:'Camera setting failed.',readback=(error as {readback?:unknown}).readback;context.log({level:'error',stage:'camera-send',message:(valueLabel(row)+' '+field.id+': '+message+(readback?' Camera reports '+JSON.stringify(readback):'')).slice(0,600)});state.errors[field.id]=message;outcomes.push({fieldId:field.id,status:'failed',message});}
          finally{state.sending=[];publish();}
        }
        return {status:'sent',outcomes,observations,sequence} as unknown as ModuleJsonValue;
      } catch(error){
        const offline=error instanceof CameraOfflineError;
        state.sending=[];state.queued=[];
        // A cancelled request says nothing about the camera.
        if(!signal.aborted){state.state=offline?'offline':'error';if(offline){state.values={};state.choices={};}}
        publish();
        // A camera that isn't there is an ordinary answer to Refresh, not a failure to report.
        if(offline&&command.commandId==='refresh')return {status:'offline',observations,sequence} as unknown as ModuleJsonValue;
        throw error;
      }
      finally{if(command.commandId==='send')state.queued=[];if(client&&client!==session?.client)close(client);}
    },
    async dispose(){endAllLive();clearTimeout(publishTimer);clearTimeout(watchTimer);for(const wake of [...waiters])wake();lifetime.abort();for(const client of clients)client.close();clients.clear();for(const id of Object.keys(observations))delete observations[id];}
  };
}
