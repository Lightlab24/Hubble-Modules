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
  function cameraCellChoices(camera,field){
    const catalog=cameraChoiceCatalogs.get(choiceContext(camera,field));
    const live=catalog&&controllerChoices(field,catalog.entries);
    let entries=[];
    if(field==='model'){
      entries=(live||modelChoices(camera).map(value=>choiceEntry(value,value,'Sony'))).filter(option=>option.value!=='Choose model…');
    }else if(field==='lens'){
      entries=live||lensModels.map(value=>choiceEntry(value));
    }else if(field==='lensPort'){
      const sample=(!moduleBridge||moduleBridge.preview)
        ?camera.lens==='ARRI - cforce'?['USB · CAN adapter']:['RIO 01 : 1','RIO 01 : 2','RIO 02 : 1','RIO 02 : 2','USB · Serial converter']
        :[];
      entries=[choiceEntry('None'),...(live||sample.map(value=>choiceEntry(value,value,value.includes(' : ')?value.split(' : ')[0]:undefined)))];
    }else if(field==='usb'){
      entries=[choiceEntry('USB · Automatic'),...(live||[])];
    }else if(field.endsWith('Torque')){
      entries=['1','2','3','4'].map(value=>choiceEntry(value));
    }else if(field.endsWith('Direction')){
      entries=[choiceEntry('left','Left'),choiceEntry('right','Right')];
    }
    const current=camera[field];
    if(current&&current!=='Choose model…'&&!entries.some(option=>option.value===current))entries=[...entries,choiceEntry(current)];
    return [...new Map(entries.map(option=>[option.value,option])).values()];
  }
  function cameraChoiceCell(camera,field,disabled=false){
    const inactive=disabled||camera.deleting||importedCamera(camera);
    const value=inactive?'':camera[field]??(field==='usb'?'USB · Automatic':'');
    const label=cameraCellChoices(camera,field).find(option=>option.value===value)?.label??value;
    return '<button type="button" tabindex="-1" class="hc-cell-input hc-choice-cell" data-row="'+esc(camera.id)+'" data-field="'+field+'" data-camera-choice value="'+esc(value)+'" aria-label="'+esc(choiceLabel(field)+' for camera '+camera.number+(label?' · '+label:''))+'"'+(inactive?' disabled':'')+'>'+esc(label)+'</button>';
  }
  function cameraChoiceProvider(camera, field, context){
    let request;
    let warning = '';
    let reported = false;
    return async (_query, signal) => {
      request ??= moduleBridge.options({device:camera.device,rowId:camera.id,field:cameraChoiceSources[field]})
        .then(({key,entries,saved}) => {
          if(key&&entries.length)cameraChoiceCatalogs.set(key,{entries,saved});
          if(key!==context) warning = 'Controller is using a different configuration';
          else if(!entries.length) warning = 'Controller returned no choices';
          else if(!saved) warning = 'Live choices could not be saved for offline use';
        }).catch(() => {
          const available = cameraChoiceCatalogs.get(context);
          warning = (available?.saved ? 'Using saved choices' : 'Showing available choices') + ' · controller unavailable';
        });
      await request;
      signal.throwIfAborted();
      if(warning&&!reported) { reported = true; toast(warning); }
      return cameraCellChoices(camera,field);
    };
  }
