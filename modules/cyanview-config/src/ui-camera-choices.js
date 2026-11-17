  const cameraChoiceSources={model:'Model',lens:'LensModel',lensPort:'LensInterface',usb:'Interface'};
  const cameraChoiceCatalogs=new Map();
  function choiceContext(camera,field){
    const source=cameraChoiceSources[field],controller=device(camera.device);
    return source&&controller?cameraChoiceKey(controller.serial,source,camera.elementKey,camera.model,camera.lens):null;
  }
  async function restoreCameraChoiceCatalogs(){
    if(!moduleBridge||moduleBridge.preview)return;
    const before=new Map(cameraChoiceCatalogs);
    try{
      const {catalogs}=await moduleBridge.choiceCatalogs();
      for(const [key,entries] of Object.entries(catalogs)){
        if(cameraChoiceCatalogs.get(key)===before.get(key))cameraChoiceCatalogs.set(key,{entries,saved:true});
      }
    }catch{ /* Built-in options and any choices already loaded remain usable. */ }
  }
  function choiceLabel(field){
    if(isAssignmentField(field))return assignmentLabel(field);
    return ({model:'Camera model',lens:'Lens model',lensPort:'Lens connection',usb:'Camera interface'})[field]
      ||axisDefinitions[lensAxisForField(field)]?.find(item=>item.id===field)?.label||field;
  }
  function choiceEntry(value,label=value,group){
    return {value,label,group};
  }
  function controllerChoices(field,entries){
    return entries.flatMap(item=>{
      const label=String(item.label??'');
      if(field==='model'){
        if(!label)return [];
        const value=label.replace(/^Sony\s*-\s*/i,'');
        return [choiceEntry(value,value,label.includes(' - ')?label.split(' - ')[0]:undefined)];
      }
      if(field==='usb')return item.port==null?[]:[item.port==='*'?choiceEntry('USB · Automatic'):choiceEntry(String(item.port),label||String(item.port))];
      if(field==='lensPort')return label?[choiceEntry(label,label,label.includes(' : ')?label.split(' : ')[0]:undefined)]:[];
      return [choiceEntry(label||'None')];
    });
  }
  // A controller lists the connections for the lens a camera has on it now, so a lens picked but not
  // sent yet, or a camera not on its controller yet, has no list of its own. It is offered what the
  // same controller listed before: for this lens if it ever did, otherwise for this camera, otherwise
  // for any of its cameras. Send sets the lens first and then checks the connection against it.
  function knownLensConnections(camera){
    const controller=device(camera.device);
    if(!controller)return null;
    const lens=String(camera.lens||'None').trim().toLowerCase();
    let best=null,rank=3;
    for(const [key,{entries}] of cameraChoiceCatalogs){
      let parts;try{parts=JSON.parse(key);}catch{continue;}
      if(parts?.[0]!==controller.serial||parts[1]!=='LensInterface'||!entries?.length)continue;
      const order=parts[4]===lens?0:camera.elementKey&&parts[2]===camera.elementKey?1:2;
      if(order<rank){rank=order;best=[];}
      if(order===rank)best.push(...entries);
    }
    // A RIO that has never listed any has its two lens ports, named as every RIO names them, so the
    // list opens at once instead of waiting on the controller.
    if(!best&&/^CY-RIO-/i.test(String(controller.serial)))best=[1,2].map(port=>({label:String(controller.serial).replace(/^CY-/i,'')+' : '+port}));
    return best&&controllerChoices('lensPort',best);
  }
  // Picking a lens asks its controller for the connections straight away, so they are ready to open.
  function prefetchLensConnections(camera){
    const controller=device(camera.device);
    if(!moduleBridge||moduleBridge.preview||!camera.elementKey||!controller||controller.online===false)return;
    moduleBridge.options({device:camera.device,rowId:camera.id,field:'LensInterface'})
      .then(({key,entries,saved})=>{if(key&&entries?.length)cameraChoiceCatalogs.set(key,{entries,saved});})
      .catch(()=>{ /* The list still opens from what is known, and asks again when opened. */ });
  }
  function cameraCellChoices(camera,field){
    const catalog=cameraChoiceCatalogs.get(choiceContext(camera,field));
    const live=catalog&&controllerChoices(field,catalog.entries);
    let entries=[];
    if(field==='model'){
      entries=(live||modelChoices(camera)).filter(option=>option.value!=='Choose model…');
    }else if(field==='lens'){
      entries=live||lensModels.map(value=>choiceEntry(value));
    }else if(field==='lensPort'){
      const sample=(!moduleBridge||moduleBridge.preview)
        ?camera.lens==='ARRI - cforce'?['USB · CAN adapter']:['RIO 01 : 1','RIO 01 : 2','RIO 02 : 1','RIO 02 : 2','USB · Serial converter']
        :[];
      entries=[choiceEntry('None'),...(live||knownLensConnections(camera)||sample.map(value=>choiceEntry(value,value,value.includes(' : ')?value.split(' : ')[0]:undefined)))];
    }else if(field==='usb'){
      entries=[choiceEntry('USB · Automatic'),...(live||[])];
    }else if(field.endsWith('Torque')){
      entries=['1','2','3','4'].map(value=>choiceEntry(value));
    }else if(field.endsWith('Direction')){
      entries=irisSwapCell(camera,field)?irisSwapChoices.map(option=>choiceEntry(option.value,option.label)):[choiceEntry('left','Left'),choiceEntry('right','Right')];
    }
    // A swap cell shows which way round the numbers are, not a saved value.
    const current=irisSwapCell(camera,field)?'':camera[field];
    if(current&&current!=='Choose model…'&&!entries.some(option=>option.value===current))entries=[...entries,choiceEntry(current)];
    return [...new Map(entries.map(option=>[option.value,option])).values()];
  }
  function cameraChoiceCell(camera,field,disabled=false){
    const inactive=disabled||camera.deleting||importedCamera(camera);
    const value=inactive?'':irisSwapCell(camera,field)?irisSwapValue(camera):camera[field]??(field==='usb'?'USB · Automatic':'');
    const label=cameraCellChoices(camera,field).find(option=>option.value===value)?.label??value;
    return '<button type="button" tabindex="-1" class="hc-cell-input hc-choice-cell" data-row="'+esc(camera.id)+'" data-field="'+field+'" data-camera-choice value="'+esc(value)+'" aria-label="'+esc(choiceLabel(field)+' for camera '+camera.number+(label?' · '+label:''))+'"'+(inactive?' disabled':'')+'>'+esc(label)+'</button>';
  }
  function cameraChoiceProvider(camera, field, context){
    let request;
    let warning = '';
    let reported = false;
    const tell = message => { if(message&&!reported) { reported = true; toast(message); } };
    const ask = () => request ??= moduleBridge.options({device:camera.device,rowId:camera.id,field:cameraChoiceSources[field]})
      .then(({key,entries,saved}) => {
        if(key&&entries.length)cameraChoiceCatalogs.set(key,{entries,saved});
        if(key!==context) warning = 'Controller is using a different configuration';
        else if(!entries.length) warning = 'Controller returned no choices';
        else if(!saved) warning = 'Live choices could not be saved for offline use';
      }).catch(() => {
        const available = cameraChoiceCatalogs.get(context);
        warning = (available?.saved ? 'Using saved choices' : 'Showing available choices') + ' · controller unavailable';
      });
    // Asking the controller opens a new connection, and an unreachable one takes 5 seconds to give up.
    // So a list we already have shows straight away and the controller only freshens it for next time.
    return (_query, signal) => {
      const known = field !== 'lensPort' || cameraChoiceCatalogs.has(context) || !!knownLensConnections(camera)?.length;
      if(device(camera.device)?.online === false) {
        if(!known) tell('Controller offline · its lens connections will list once it is reachable');
        return cameraCellChoices(camera,field);
      }
      const answered = ask();
      if(known) return cameraCellChoices(camera,field);
      return answered.then(() => {
        signal.throwIfAborted();
        const choices = cameraCellChoices(camera,field);
        // The controller's list for the lens it has now still offers its ports for the one picked.
        if(field !== 'lensPort' || choices.length <= 1) tell(warning);
        return choices;
      });
    };
  }
