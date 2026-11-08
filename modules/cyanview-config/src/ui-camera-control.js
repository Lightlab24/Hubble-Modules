  let cameraControlState={epoch:null,sequence:-1,enabled:{},singleSwitch:{},controllers:{},cameras:{}};
  const cameraControlDrafts=new Map();
  let cameraControlEdit=0;
  function cameraControlDevice(d){return ['RCP','RIO','Gateway'].includes(d?.kind);}
  // Edits still saving replay over the module's last state, so the page is right before any save returns.
  function cameraControlProjection(){
    const enabled={...cameraControlState.enabled},singleSwitch={...cameraControlState.singleSwitch};
    for(const mutations of cameraControlDrafts.values())for(const mutation of mutations){
      const rows=cameras.filter(camera=>camera.device===mutation.controllerId);
      if(mutation.kind==='all'){
        if(mutation.enabled)singleSwitch[mutation.controllerId]=false;
        for(const camera of rows)enabled[camera.id]=mutation.enabled;
      }else if(mutation.kind==='single'){
        singleSwitch[mutation.controllerId]=mutation.enabled;
        if(mutation.enabled){const first=rows.find(camera=>enabled[camera.id]);for(const camera of rows)enabled[camera.id]=camera===first;}
      }else{
        if(mutation.enabled&&singleSwitch[mutation.controllerId])for(const camera of rows)enabled[camera.id]=false;
        enabled[mutation.cameraId]=mutation.enabled;
      }
    }
    return {enabled,singleSwitch};
  }
  function cameraControlFlags(){return cameraControlProjection().enabled;}
  function cameraControlEnabled(camera){return cameraControlFlags()[camera.id]===true;}
  function cameraControlCell(camera){
    const controller=device(camera.device),disabled=camera.deleting||!cameraControlDevice(controller);
    return '<input type="checkbox" class="hc-control-check" value="'+(cameraControlEnabled(camera)?'TRUE':'FALSE')+'" data-row="'+esc(camera.id)+'" data-field="controlEnabled" aria-label="Camera Control Enabled for camera '+esc(camera.number)+' on '+esc(controller?.name||'controller')+'"'+(cameraControlEnabled(camera)?' checked':'')+(disabled?' disabled':'')+'>';
  }
  function cameraRecordingText(id){
    const recording=cameraControlState.cameras?.[id]?.recording;
    return recording==='recording'?'Recording':recording==='stopped'?'Stopped':recording==='unknown'?'Unknown':'';
  }
  function cameraRecordingCell(id){
    const text=cameraRecordingText(id);
    // Nothing is watching this controller yet, so there is no state to show.
    if(!text)return '<span class="hc-status hc-muted">—</span>';
    return '<span class="hc-status '+(text==='Recording'?'hc-recording':'hc-muted')+'"><span class="hc-dot"></span>'+text+'</span>';
  }
  function cameraStatusText(id){return cameraControlState.cameras?.[id]?.message||'';}
  function cameraStatusCell(id){
    const text=esc(cameraStatusText(id));
    return '<span class="hc-camera-status" title="'+text+'">'+text+'</span>';
  }
  function cameraControlRows(id){return cameras.filter(camera=>camera.device===id);}
  function cameraControlAllLabel(id,enabled){
    const rows=cameraControlRows(id);
    return rows.length&&rows.every(camera=>enabled[camera.id]===true)?'Disable all':'Enable all';
  }
  function cameraControlCountMarkup(id,enabled){
    const rows=cameraControlRows(id).filter(camera=>enabled[camera.id]===true);
    const unavailable=rows.filter(camera=>cameraControlState.cameras?.[camera.id]?.available===false).length;
    return rows.length+' enabled'+(unavailable?' · <span class="hc-pending-text">'+unavailable+' unavailable</span>':'');
  }
  function cameraControlCount(d){
    if(!cameraControlDevice(d))return '';
    return '<span class="hc-controller-camera-count" data-control-count="'+esc(d.id)+'">'+cameraControlCountMarkup(d.id,cameraControlFlags())+'</span>';
  }
  function cameraControlTools(d){
    if(!cameraControlDevice(d))return '';
    const {enabled,singleSwitch}=cameraControlProjection(),label=cameraControlAllLabel(d.id,enabled);
    return '<label class="hc-control-single"><input type="checkbox" data-control-single="'+esc(d.id)+'" aria-label="Single switch for '+esc(d.name)+'"'+(singleSwitch[d.id]===true?' checked':'')+'>Single switch</label>'+
      '<button class="hc-button" data-action="control-enable-all" data-id="'+esc(d.id)+'" aria-label="'+label+' cameras on '+esc(d.name)+'"'+(cameraControlRows(d.id).length?'':' disabled')+'>'+label+'</button>';
  }
  function paintCameraControl(){
    const {enabled,singleSwitch}=cameraControlProjection();
    root.querySelectorAll('input[data-field="controlEnabled"]').forEach(input=>{input.checked=enabled[input.dataset.row]===true;input.value=input.checked?'TRUE':'FALSE';});
    root.querySelectorAll('input[data-control-single]').forEach(input=>{input.checked=singleSwitch[input.dataset.controlSingle]===true;});
    root.querySelectorAll('button[data-action="control-enable-all"]').forEach(button=>{
      const id=button.dataset.id,label=cameraControlAllLabel(id,enabled);
      button.textContent=label;button.setAttribute('aria-label',label+' cameras on '+(device(id)?.name||'controller'));button.disabled=!cameraControlRows(id).length;
    });
    root.querySelectorAll('[data-control-count]').forEach(count=>{
      const markup=cameraControlCountMarkup(count.dataset.controlCount,enabled);
      if(count.innerHTML!==markup)count.innerHTML=markup;
    });
    root.querySelectorAll('td[data-column="recording"],td[data-column="cameraStatus"]').forEach(cell=>{
      const id=cell.dataset.hubbleRow,markup=cell.dataset.column==='recording'?cameraRecordingCell(id):cameraStatusCell(id);
      if(cell.innerHTML!==markup)cell.innerHTML=markup;
    });
  }
  function applyCameraControlState(state){
    if(!state||typeof state.sequence!=='number')return;
    // A restarted worker counts from zero again, so only compare within one worker.
    if(state.epoch===cameraControlState.epoch&&state.sequence<cameraControlState.sequence)return;
    cameraControlState=state;paintCameraControl();syncConnections();
  }
  function controlBoolean(value){
    const text=String(value).trim().toLowerCase();
    if(['true','1','yes','on','✓'].includes(text))return true;
    if(['false','0','no','off',''].includes(text))return false;
    throw new Error('Use TRUE or FALSE for Camera Control Enabled');
  }
  function submitCameraControl(mutations){
    if(!mutations.length)return;
    const requestId='sheet-'+Date.now()+'-'+(++cameraControlEdit);
    cameraControlDrafts.set(requestId,mutations);paintCameraControl();
    if(!moduleBridge){
      cameraControlState={...cameraControlState,...cameraControlProjection()};cameraControlDrafts.delete(requestId);return;
    }
    // Sample rows are initially frontend fixtures; save their workspace identities first.
    if(moduleBridge.preview)remember();
    void moduleBridge.controlMutate({requestId,mutations}).then(state=>{
      cameraControlDrafts.delete(requestId);applyCameraControlState(state);paintCameraControl();
    }).catch(async error=>{
      cameraControlDrafts.delete(requestId);paintCameraControl();toast(error.message||'Cyanview camera selection could not be saved');
      try{applyCameraControlState(await moduleBridge.controlState());}catch{}
    });
  }
  function editCameraControl(edits){
    const mutations=[];
    try{
      for(const {rowId,value}of edits){
        const camera=cameras.find(row=>row.id===rowId);
        if(!camera||camera.deleting||!cameraControlDevice(device(camera.device)))continue;
        mutations.push({kind:'camera',controllerId:camera.device,cameraId:camera.id,enabled:controlBoolean(value)});
      }
    }catch(error){toast(error.message);return;}
    submitCameraControl(mutations);
  }
  root.addEventListener('change',event=>{
    const input=event.target;
    if(input.matches('input[data-field="controlEnabled"]'))editCameraControl([{rowId:input.dataset.row,value:input.checked}]);
    else if(input.matches('input[data-control-single]'))submitCameraControl([{kind:'single',controllerId:input.dataset.controlSingle,enabled:input.checked}]);
  });
  root.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action="control-enable-all"]');if(!button)return;
    const id=button.dataset.id,enabled=cameraControlFlags();
    // Says which way it goes, so the edit reads the same however many times it replays.
    submitCameraControl([{kind:'all',controllerId:id,enabled:!cameraControlRows(id).every(camera=>enabled[camera.id]===true)}]);
  });
