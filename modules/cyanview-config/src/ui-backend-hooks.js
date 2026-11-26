  function plainRow(item){const {deleting,...saved}=item;return {...saved,dirty:[...(item.dirty||[])],jobs:0};}
  function snapshotPlan(uiState){return {formatVersion:1,devices:devices.map(({modelCatalog,models,lensOptions,snapshot,...item})=>({...item})),cameras:cameras.filter(row=>row.device!=='').map(plainRow),lans:lans.map(plainRow),uiState,cameraLogins:savedCameraLogins(),savedDevices:savedDeviceList(),defaults:savedDefaults()};}
  // Where the page is goes to this copy's own place; the plan is written only when something in it changed, and only
  // then does the page say Saving. What a save writes is taken when its turn comes, after the edit is on screen, so a
  // save queued behind another writes what the page holds then (ui-plan-follow.js).
  function persistPlan(uiState){
    savePageView(splitUiState(uiState).view);
    const sequence=++saveSequence;
    let ticket=null;
    return moduleBridge.save(()=>{ticket=presentationLedger.ticket();return repairPresentationPlan(currentPlan(),ticket);},()=>{if(ticket)presentationLedger.saved(ticket);},()=>{if(ticket)rejectPresentation(ticket);},()=>{persistence='saving';syncSummary();}).then(()=>{if(sequence===saveSequence&&persistence!=='saved'){persistence='saved';syncSummary();}}).catch(error=>{if(sequence===saveSequence){persistence='failed';syncSummary();}toast(error.message||'Changes could not be saved');});
  }
  function restoredRow(row){
    const dirty=new Set(row.dirty||[]);
    // Lens None sends nothing, so it is never an unsent change: earlier versions marked it on every new
    // row. A camera already on a controller keeps a changed lens, since None then takes its lens off.
    if(!row.lens||row.lens==='None'){dirty.delete('lensPort');if(!row.elementKey)dirty.delete('lens');}
    const restored={...row,deleting:false,dirty,revision:Number(row.revision||0),jobs:0};
    if(row.lens!==undefined&&!Array.isArray(row.enabledLensAxes)){
      restored.enabledLensAxes=[...new Set([...dirty].map(lensAxisForField).filter(Boolean))];
    }
    // A live update used to put a changed address back on Keep, which Send then refused. Typing an
    // address picks Replace or Add (Edit on a WAN), so a row saved that way gets the same again.
    if(row.operation==='Keep'&&row.planned!==undefined&&dirty.has('planned')&&row.planned!==row.current){
      restored.operation=row.type==='WAN'?'Edit':!row.current?'Add':row.planned?'Replace':'Delete';
    }
    return restored;
  }
  // One controller element is one row. A row whose send created an element the controller had already
  // reported was briefly listed twice; the copy that holds no edit of its own goes.
  function withoutDuplicateRows(collection){
    const kept=new Map();
    for(const row of collection){
      if(!row.elementKey){continue;}
      const id=row.device+'\u0000'+row.elementKey,other=kept.get(id);
      const ownsWork=item=>item.pending||item.jobs||item.dirty?.size;
      if(!other||ownsWork(row)&&!ownsWork(other))kept.set(id,row);
    }
    return collection.filter(row=>!row.elementKey||kept.get(row.device+'\u0000'+row.elementKey)===row);
  }
  // Earlier versions stored made-up motor and limit values on every camera, even with the axis off.
  const formerLensDefaults={irisMotor:'3',zoomMotor:'5',focusMotor:'2',irisMin:'1.6',irisMax:'32',irisTorque:'2',zoomTorque:'2',focusTorque:'2',irisDirection:'left',zoomDirection:'left',focusDirection:'left'};
  function withoutFormerLensDefaults(row){
    for(const [field,value] of Object.entries(formerLensDefaults)){
      if(row[field]===value&&!row.dirty.has(field)&&!row.enabledLensAxes?.includes(lensAxisForField(field)))delete row[field];
    }
    return row;
  }
  const manualDiscoveries=new Map();let scanDiscoveries=[],addingDiscovered=false;
  function mergeDiscoveries(){
    const merged=new Map();
    for(const candidate of [...scanDiscoveries,...manualDiscoveries.values()]){const previous=merged.get(candidate.serial);merged.set(candidate.serial,{...previous,...candidate,addresses:[...new Set([...(previous?.addresses||[]),...(candidate.addresses||[]),candidate.address].filter(Boolean))]});}
    results=[...merged.values()];renderResults();
  }
  function applyReceipts(plan){
    for(const collection of ['cameras','lans'])for(const saved of plan[collection]||[]){const local=(collection==='cameras'?cameras:lans).find(item=>item.id===saved.id);if(local)for(const field of ['elementKey','newElementKey','createState','needsInitialization'])if(saved[field]!==undefined)local[field]=saved[field];}
    const before=lans.length;
    lans=withoutDuplicateRows(lans);
    if(lans.length!==before){renderLans();remember();}
  }
  let liveObservations={};
  // Online and Offline only come from something that answered, or from a connection that was tried and failed.
  // An RCP, RIO or Gateway reads only from its MQTT connection.
  function controllerConnection(d){return (cameraControlDevice(d)?cameraControlState.controllers?.[d.id]:null)??null;}
  function cameraConnection(camera,controller){
    // Status reads the same MQTT state, so the two columns can't disagree.
    const reported=cameraControlDevice(controller)?cameraControlState.cameras?.[camera.id]?.online:null;
    return typeof reported==='boolean'?reported:controller?.online===false?false:null;
  }
  function connectionNote(d){
    if(d.online==null)return 'Not checked yet';
    if(!d.online)return 'Last reported offline';
    return 'Connected at '+(d.address||d.base);
  }
  function uncheckedCount(rows,separator){const count=rows.filter(row=>row.online==null).length;return count?separator+count+' not checked':'';}
  function syncConnections(){
    if(!moduleBridge||moduleBridge.preview)return;
    for(const d of devices){
      d.online=controllerConnection(d);d.lastSeen=liveObservations[d.id]?.lastSeen||d.lastSeen;
      const markup=status(d.online);
      root.querySelectorAll('[data-controller="'+d.id+'"] .hc-controller-header > .hc-status,[data-network-controller="'+d.id+'"] .hc-controller-header > .hc-status').forEach(mark=>{if(mark.outerHTML!==markup)mark.outerHTML=markup;});
      const note=root.querySelector('[data-controller="'+d.id+'"] [data-connection-note]');if(note)note.textContent=connectionNote(d);
    }
    const rows=new Map();
    for(const camera of cameras){camera.online=cameraConnection(camera,device(camera.device));rows.set(camera.id,camera);}
    root.querySelectorAll('td[data-column="control"]').forEach(cell=>{
      const camera=rows.get(cell.dataset.camera);if(!camera)return;
      const markup=status(camera.online);if(cell.innerHTML!==markup)cell.innerHTML=markup;
    });
  }
  async function initializeBackend(){
    const methodField=document.createElement('label');methodField.className='hc-field';methodField.innerHTML='<span>Discovery method</span><select data-role="discovery-method" aria-label="Discovery method"><option value="ping">Fast IP discovery</option><option value="broadcast">Broadcast discovery</option></select>';
    action('scan').before(methodField);ui.discoveryMethod='ping';ui.discoveryVersion=2;
    $('discovery-method').addEventListener('change',()=>{ui.discoveryMethod=$('discovery-method').value;remember();});
    try{
      // Which Columns menu this Hubble has decides what the first drawing of the sheets shows.
      const [plan,place]=await Promise.all([moduleBridge.read(),readPageView(),columnSectionsReady]);
      applyCameraControlState(await moduleBridge.controlState());
      await restoreCameraChoiceCatalogs();
      if(plan){restoreSavedLists(plan);devices.splice(0,devices.length,...plan.devices);cameras=(plan.cameras||[]).map(row=>withoutFormerLensDefaults(restoredRow(row)));lans=withoutDuplicateRows((plan.lans||[]).map(restoredRow));deviceOrder=devices.map(item=>item.id);openControllers.clear();if(devices[0])openControllers.add(devices[0].id);syncConnections();syncFilter();renderLans();renderCameras();const saved=withPageView(plan.uiState,place,true);if(saved)restore(saved);}
      moduleBridge.onReceipt(applyReceipts);
      moduleBridge.subscribe(applyLiveState);
      if(plan?.uiState?.privateContent?.ui?.discoveryVersion!==2&&ui.discoveryMethod==='broadcast')ui.discoveryMethod='ping';
      $('discovery-method').value=['ping','broadcast'].includes(ui.discoveryMethod)?ui.discoveryMethod:'ping';
      persistence='saved';syncSummary();preferBaseAddresses();void setupGuideLoadedNow();
    }catch(error){devices.splice(0);cameras=[];lans=[];renderLans();renderCameras();toast(error.message||'Configuration could not be loaded');}
    root.hidden=false;icons();
  }
  // The models a camera can be given when its controller's own list isn't loaded: the list its controller
  // gave in this session's read, otherwise every model any controller has listed plus every model
  // Cyanview offers, so a new camera with no Source yet can be any camera.
  function modelChoices(camera){
    const catalog=device(camera.device)?.modelCatalog;
    if(catalog?.length)return controllerChoices('model',catalog);
    return everyModelChoice();
  }
  function everyModelChoice(){
    const labels=[];
    for(const [key,{entries}] of cameraChoiceCatalogs){
      let parts;try{parts=JSON.parse(key);}catch{continue;}
      if(parts?.[1]==='Model')for(const item of entries)labels.push(String(item?.label??''));
    }
    // Brands stay together however the lists interleave them.
    const groups=new Map(),seen=new Set();
    for(const option of controllerChoices('model',[...labels,...cyanviewCameraModels].filter(label=>label&&label!=='Cyan - Imported').map(label=>({label})))){
      if(seen.has(option.value))continue;
      seen.add(option.value);
      const group=option.group??'';
      if(!groups.has(group))groups.set(group,[]);
      groups.get(group).push(option);
    }
    return [...groups.values()].flat();
  }
  function mergeSnapshot(snapshot){
    const current=device(snapshot.device.id);if(!current)return;
    // A snapshot is a one-off read, so it says nothing about live status.
    const savedName=current.name,online=current.online;Object.assign(current,snapshot.device);current.online=online;if(savedName&&savedName!==current.serial)current.name=savedName;
    for(const [name,remoteRows] of [['cameras',snapshot.cameras||[]],['lans',snapshot.lans||[]]]){
      const collection=name==='cameras'?cameras:lans;
      for(const remote of remoteRows){
        let local=collection.find(item=>item.device===current.id&&item.elementKey===remote.elementKey);
        // An element a row's own send is making right now is that row's, and the send links it when it finishes.
        // Once no send is running, everything the controller lists is shown: an address a failed change left
        // behind used to stay hidden here, on the device and not on the sheet (Nov 23, 2026).
        if(!local&&collection.some(item=>item.device===current.id&&item.newElementKey===remote.elementKey&&item.jobs>0))continue;
        if(local){
          const changingLens=name==='cameras'&&local.dirty.has('lens')&&local.lens!==remote.lens;
          for(const [field,value]of Object.entries(remote)){
            if(['id','device','dirty','pending','result','revision','jobs','online'].includes(field)||local.dirty.has(field))continue;
            // Replace, Add or Edit is what an unsent address change is for; the controller only ever says Keep.
            if(field==='operation'&&(local.pending||local.dirty.size))continue;
            if(changingLens&&(isLensSetting(field)||field.startsWith('lensParams')))continue;
            local[field]=value;
          }
          if(!local.pending)local.result=remote.result;
        }
        else{const row=restoredRow(remote);while(collection.some(item=>item.id===row.id))row.id+='-observed';collection.push(row);}
      }
      for(let index=collection.length-1;index>=0;index--){const local=collection[index];if(local.device===current.id&&local.elementKey&&!local.pending&&!local.jobs&&!remoteRows.some(item=>item.elementKey===local.elementKey))collection.splice(index,1);}
    }
    lans=withoutDuplicateRows(lans);
  }
  function applyLiveState(values){
    if(values.observations)liveObservations=values.observations;
    if(values.cameraControl)applyCameraControlState(values.cameraControl);
    if(moduleBridge.preview)return;
    noticeConfigChanges(values.configChanges);
    applyCameraEnabledJobs(values.cameraEnabledJobs);
    syncConnections();
    syncSummary();
    for(const candidate of values.lookupResults||[])manualDiscoveries.set(candidate.serial,candidate);
    if(values.lookupResults)mergeDiscoveries();
    const scan=values.discovery;if(!scan)return;
    const quick=scan.method==='broadcast',percent=quick?(scan.state==='scanning'?40:100):scan.total?Math.round(100*scan.checked/scan.total):0;
    root.querySelector('.hc-progress').hidden=quick;
    $('scan-progress').style.width=percent+'%';root.querySelector('.hc-progress').setAttribute('aria-valuenow',String(percent));
    $('scan-addresses').textContent=quick?(scan.results||[]).length+' found':scan.checked.toLocaleString()+' / '+scan.total.toLocaleString();
    $('scan-label').textContent=(quick?(scan.state==='scanning'?'Live discovery · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '):(scan.state==='scanning'?'Pinging IP addresses · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '))+scan.range;
    action('scan').disabled=scan.state==='scanning'&&!quick||!$('scan-range').value;action('stop-scan').hidden=scan.state!=='scanning';
    scanDiscoveries=scan.results||[];mergeDiscoveries();
    if(scan.error){$('discovery-error').textContent=scan.error;$('discovery-error').hidden=false;}
    if(!results.length&&scan.state!=='scanning')$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>'+(quick?'No Cyanview devices announced on this range':'No Cyanview devices found')+'</strong><span class="hc-caption">'+(quick?'Try Find by IP, or Fast IP discovery for routed networks.':'Check the network range or try a known device IP.')+'</span></div>';
  }
  async function startLiveScan(){
    const range=$('scan-range').value==='custom'?$('custom-range').value.trim():$('scan-range').value;
    if(!range)return;
    $('discovery-error').hidden=true;scanDiscoveries=[];mergeDiscoveries();action('scan').disabled=true;action('stop-scan').hidden=false;
    if(!results.length)$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>Looking for Cyanview devices…</strong></div>';
    try{await moduleBridge.scan(range,$('discovery-method').value);}catch(error){$('discovery-error').textContent=error.message;$('discovery-error').hidden=false;action('scan').disabled=false;action('stop-scan').hidden=true;}
  }
  async function probeLiveIP(){
    const address=$('manual-ip').value.trim();if(!ipv4(address)){$('discovery-error').textContent='Enter a valid IPv4 address.';$('discovery-error').hidden=false;return;}
    $('discovery-error').hidden=true;action('probe-ip').disabled=true;
    try{const reply=await moduleBridge.probe(address),candidate=reply.device;manualDiscoveries.set(candidate.serial,candidate);if(!devices.some(item=>item.serial===candidate.serial))selectedResults.add(candidate.id);$('scan-label').textContent='Device lookup complete · '+address;mergeDiscoveries();}
    catch(error){$('discovery-error').textContent=error.message;$('discovery-error').hidden=false;}
    finally{action('probe-ip').disabled=false;}
  }
  async function addLiveResults(){
    if(addingDiscovered)return;addingDiscovered=true;action('add-discovered').disabled=true;let count=0;
    try{for(const candidate of results.filter(item=>selectedResults.has(item.id)&&!devices.some(d=>d.serial===item.serial))){
      if(devices.length>=128)throw new Error('Controller capacity reached');
      const snapshot=await moduleBridge.importDevice(candidate);if(cameras.length+snapshot.cameras.length>512)throw new Error('Camera capacity reached');
      devices.push(snapshot.device);
      // Adding a controller doesn't make what is already on it yours: its cameras are listed under Not set up by Hubble (Nov 21, 2026).
      // The Simulated rig is the exception, since it stands in for a rig already set up and its tour counts those cameras as yours.
      const foreign=!moduleBridge?.simulated;cameras.push(...snapshot.cameras.map(row=>({...restoredRow(row),...(foreign?{foreign:true}:{})})));lans.push(...snapshot.lans.map(restoredRow));selectedResults.delete(candidate.id);count++;
    }}catch(error){toast(error.message);}
    if(count)await restoreCameraChoiceCatalogs();
    addingDiscovered=false;syncFilter();renderResults();renderLans();renderCameras();if(count)toast(count+' devices added');remember();
  }
  async function refreshLive(){
    action('refresh-all').disabled=true;
    try{const reply=await moduleBridge.refresh();const cleared=clearPendingSends();for(const snapshot of reply.snapshots||[])mergeSnapshot(snapshot);await restoreCameraChoiceCatalogs();renderLans();renderCameras();applyLiveState({observations:reply.observations});const failed=(reply.failed||[]).map(id=>device(id)?.name||id);const clearedText=cleared?' · '+cleared+(cleared===1?' pending change':' pending changes')+' cleared':'';toast((failed.length?'Could not read '+(failed.length===1?failed[0]:failed.length+' controllers'):'Settings refreshed')+clearedText);remember();}
    catch(error){toast(error.message);}
    finally{action('refresh-all').disabled=false;}
  }
