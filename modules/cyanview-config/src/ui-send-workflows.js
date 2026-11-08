  async function sendItems(items,kind,deleting=false,fields=null){
    const jobs=[];
    for(const item of items){
      if(item.deleting)continue;
      const selectedFields=fields instanceof Map?fields.get(item.id):fields;
      const sentFields=(selectedFields||[...item.dirty]).filter(field=>kind==='lan'||!isLensSetting(field)||lensFieldUsed(item,field));
      if(!sentFields.length&&!deleting)continue;
      const error=deleting?'':valid(item,kind,sentFields);
      if(error){item.result=error;paintItem(item);continue;}
      const captured={...item};
      jobs.push({item,captured,sentFields});item.jobs++;if(deleting)item.deleting=true;item.result='Sending';paintItem(item);
    }
    if(!jobs.length){toast('Complete the pending rows before sending');return;}
    remember();
    let results;
    try{
      if(moduleBridge&&!moduleBridge.preview){
        const report=await moduleBridge.send({items:jobs.map(({captured,sentFields})=>({kind,deleting,item:plainRow(captured),fields:sentFields}))});
        results=report.results;
      }else{
        await sleep(350);for(const {item} of jobs){item.result='Verifying';paintItem(item);}await sleep(400);
        results=jobs.map(({item})=>({id:item.id,verified:true}));
      }
    }catch(error){results=jobs.map(({item})=>({id:item.id,error:error.message||'Settings could not be confirmed'}));}
    const errors=[], remiWarnings=[];
    let remiChanged=false;
    for(const {item,captured,sentFields} of jobs){
      const report=results?.find(result=>result.id===item.id)||{error:'Settings could not be confirmed'};
      if(report.remiRefresh)remiChanged=true;
      if(report.remiError)remiWarnings.push({device:item.device,error:report.remiError});
      for(const field of ['elementKey','newElementKey','createState','needsInitialization'])if(report[field]!==undefined)item[field]=report[field];
      if(report.error){if(deleting)item.deleting=false;item.result='Error';errors.push(report.error);}
      else{
        if(report.devicePatch)Object.assign(device(item.device),report.devicePatch);
        item.newElementKey=null;item.createState=null;item.needsInitialization=false;
        if(deleting)cameras=cameras.filter(camera=>camera.id!==item.id);
        else{
          if(kind==='lan'&&sentFields.some(field=>['planned','dhcp'].includes(field))){item.current=captured.planned;const cell=root.querySelector('[data-current="'+item.id+'"]');if(cell)cell.textContent=item.current;if(item.type==='LAN')device(item.device).alias=captured.planned.split('/')[0];}
          for(const field of sentFields)if(item[field]===captured[field])item.dirty.delete(field);
          if(item.isNew){item.isNew=false;for(const field of [...item.dirty])if(kind==='camera'&&isLensSetting(field)&&!lensFieldUsed(item,field))item.dirty.delete(field);}
          item.pending=item.dirty.size>0;item.result=item.pending?'Pending':'Verified';
        }
      }
      item.jobs=Math.max(0,item.jobs-1);if(item.deleting)item.result='Sending';paintItem(item);
    }
    if(deleting)renderCameras();
    if(errors.length)toast(errors.length+' '+(errors.length===1?'change':'changes')+' could not be confirmed: '+errors[0]);
    remember();
    if(remiChanged){
      try{await remiRefreshSheets();}
      catch(error){toast(error.message||'REMI camera sheets could not be refreshed');}
      if(remiWarnings.length){
        for(const warning of remiWarnings){
          const state=remiPanelState(warning.device);state.open=true;state.retry=true;state.error=warning.error;
        }
        renderCameras();
        toast('Camera saved. REMI refresh needs attention.');
      }
    }
  }
