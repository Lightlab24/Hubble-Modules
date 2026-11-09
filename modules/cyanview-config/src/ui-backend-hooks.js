  function plainRow(item){const {deleting,...saved}=item;return {...saved,dirty:[...(item.dirty||[])],jobs:0};}
  function snapshotPlan(uiState){return {formatVersion:1,devices:devices.map(({modelCatalog,models,lensOptions,snapshot,...item})=>({...item})),cameras:cameras.map(plainRow),lans:lans.map(plainRow),uiState};}
  function persistPlan(uiState){
    const sequence=++saveSequence;persistence='saving';syncSummary();
    const plan=copyPresentation(snapshotPlan(uiState)),ticket=presentationLedger.ticket();
    return moduleBridge.save(()=>repairPresentationPlan(plan,ticket),()=>presentationLedger.saved(ticket),()=>rejectPresentation(ticket)).then(()=>{if(sequence===saveSequence){persistence='saved';syncSummary();}}).catch(error=>{if(sequence===saveSequence){persistence='failed';syncSummary();}toast(error.message||'Changes could not be saved');});
  }
  function restoredRow(row){
    const dirty=new Set(row.dirty||[]);
    const restored={...row,deleting:false,dirty,revision:Number(row.revision||0),jobs:0};
    if(row.lens!==undefined&&!Array.isArray(row.enabledLensAxes)){
      restored.enabledLensAxes=[...new Set([...dirty].map(lensAxisForField).filter(Boolean))];
    }
    return restored;
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
    const methodField=document.createElement('label');methodField.className='hc-field';methodField.innerHTML='<span>Discovery method</span><select data-role="discovery-method" aria-label="Discovery method"><option value="ping">Fast IP discovery</option><option value="broadcast">Broadcast discovery</option><option value="ip">Full IP scan</option></select>';
    action('scan').before(methodField);ui.discoveryMethod='ping';ui.discoveryVersion=2;
    $('discovery-method').addEventListener('change',()=>{ui.discoveryMethod=$('discovery-method').value;remember();});
    try{
      const plan=await moduleBridge.read();
      applyCameraControlState(await moduleBridge.controlState());
      await restoreCameraChoiceCatalogs();
      if(plan){devices.splice(0,devices.length,...plan.devices);cameras=(plan.cameras||[]).map(row=>withoutFormerLensDefaults(restoredRow(row)));lans=(plan.lans||[]).map(restoredRow);deviceOrder=devices.map(item=>item.id);openControllers.clear();openNetworkDevices.clear();if(devices[0]){openControllers.add(devices[0].id);openNetworkDevices.add(devices[0].id);}discoveryCard.open=!devices.length;syncConnections();syncFilter();renderLans();renderCameras();if(plan.uiState)restore(plan.uiState);}
      moduleBridge.onReceipt(applyReceipts);
      moduleBridge.subscribe(applyLiveState);
      if(plan?.uiState?.privateContent?.ui?.discoveryVersion!==2&&ui.discoveryMethod==='broadcast')ui.discoveryMethod='ping';
      $('discovery-method').value=['ping','ip','broadcast'].includes(ui.discoveryMethod)?ui.discoveryMethod:'ping';
      persistence='saved';syncSummary();
    }catch(error){devices.splice(0);cameras=[];lans=[];renderLans();renderCameras();toast(error.message||'Configuration could not be loaded');}
    root.hidden=false;icons();
  }
  function modelChoices(camera){const catalog=device(camera.device)?.modelCatalog;return [...new Set(['Choose model…',...(catalog?.length?catalog.map(item=>String(item.label).replace(/^Sony\s*-\s*/,'')):['Venice-IP','Alpha-USB','Alpha-IP','Sony FX6','Sony FX9','Sony FR7']),camera.model])];}
  function mergeSnapshot(snapshot){
    const current=device(snapshot.device.id);if(!current)return;
    // A snapshot is a one-off read, so it says nothing about live status.
    const savedName=current.name,online=current.online;Object.assign(current,snapshot.device);current.online=online;if(savedName&&savedName!==current.serial)current.name=savedName;
    for(const [name,remoteRows] of [['cameras',snapshot.cameras||[]],['lans',snapshot.lans||[]]]){
      const collection=name==='cameras'?cameras:lans;
      for(const remote of remoteRows){
        let local=collection.find(item=>item.device===current.id&&item.elementKey===remote.elementKey);
        if(local){
          const changingLens=name==='cameras'&&local.dirty.has('lens')&&local.lens!==remote.lens;
          for(const [field,value]of Object.entries(remote)){
            if(['id','device','dirty','pending','result','revision','jobs','online'].includes(field)||local.dirty.has(field))continue;
            if(changingLens&&(isLensSetting(field)||field.startsWith('lensParams')))continue;
            local[field]=value;
          }
          if(!local.pending)local.result=remote.result;
        }
        else{const row=restoredRow(remote);while(collection.some(item=>item.id===row.id))row.id+='-observed';collection.push(row);}
      }
      for(let index=collection.length-1;index>=0;index--){const local=collection[index];if(local.device===current.id&&local.elementKey&&!local.pending&&!local.jobs&&!remoteRows.some(item=>item.elementKey===local.elementKey))collection.splice(index,1);}
    }
  }
  function applyLiveState(values){
    if(values.observations)liveObservations=values.observations;
    if(values.cameraControl)applyCameraControlState(values.cameraControl);
    if(moduleBridge.preview)return;
    syncConnections();
    syncSummary();
    for(const candidate of values.lookupResults||[])manualDiscoveries.set(candidate.serial,candidate);
    if(values.lookupResults)mergeDiscoveries();
    const scan=values.discovery;if(!scan)return;
    const quick=scan.method==='broadcast',percent=quick?(scan.state==='scanning'?40:100):scan.total?Math.round(100*scan.checked/scan.total):0;
    root.querySelector('.hc-progress').hidden=quick;
    $('scan-progress').style.width=percent+'%';root.querySelector('.hc-progress').setAttribute('aria-valuenow',String(percent));
    $('scan-addresses').textContent=quick?(scan.results||[]).length+' found':scan.checked.toLocaleString()+' / '+scan.total.toLocaleString();
    $('scan-label').textContent=(quick?(scan.state==='scanning'?'Live discovery · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '):scan.method==='ping'?(scan.state==='scanning'?'Pinging IP addresses · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '):(scan.state==='scanning'?'Scanning IP addresses · ':scan.state==='complete'?'IP scan complete · ':'IP scan stopped · '))+scan.range;
    action('scan').disabled=scan.state==='scanning'&&!quick||!$('scan-range').value;action('stop-scan').hidden=scan.state!=='scanning';
    scanDiscoveries=scan.results||[];mergeDiscoveries();
    if(scan.error){$('discovery-error').textContent=scan.error;$('discovery-error').hidden=false;}
    if(!results.length&&scan.state!=='scanning')$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>'+(quick?'No Cyanview devices announced on this range':'No Cyanview devices found')+'</strong><span class="hc-caption">'+(quick?'Try Find by IP, or use Full IP scan for routed networks.':'Check the network range or try a known device IP.')+'</span></div>';
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
      devices.push(snapshot.device);openNetworkDevices.add(snapshot.device.id);cameras.push(...snapshot.cameras.map(restoredRow));lans.push(...snapshot.lans.map(restoredRow));selectedResults.delete(candidate.id);count++;
    }}catch(error){toast(error.message);}
    if(count)await restoreCameraChoiceCatalogs();
    addingDiscovered=false;syncFilter();renderResults();renderLans();renderCameras();if(count)toast(count+' devices added');remember();
  }
  async function refreshLive(){
    action('refresh-all').disabled=true;
    try{const reply=await moduleBridge.refresh();for(const snapshot of reply.snapshots||[])mergeSnapshot(snapshot);await restoreCameraChoiceCatalogs();renderLans();renderCameras();applyLiveState({observations:reply.observations});const failed=(reply.failed||[]).map(id=>device(id)?.name||id);toast(failed.length?'Could not read '+(failed.length===1?failed[0]:failed.length+' controllers')+' · edits retained':'Settings refreshed · edits retained');remember();}
    catch(error){toast(error.message);}
    finally{action('refresh-all').disabled=false;}
  }
