  function stageCell(item,field,value,isLan){
    if(item.deleting||!isLan&&isLensSetting(field)&&!lensFieldUsed(item,field))return [];
    item[field]=value;
    item.revision++;
    item.dirty.add(field);
    item.pending=true;
    item.result='Pending';
    const fields=[field];
    if(!isLan&&field==='lens'){
      delete item.lensParamsEditable;
      initializeLensFields(item);
      for(const setting of [...Object.values(axisDefinitions).flatMap(definitions=>definitions.map(definition=>definition.id)),'lensIp','lensPort']){
        const blankAxis=lensAxisForField(setting)&&!item[setting];
        if(!blankAxis&&lensFieldUsed(item,setting)&&(setting!=='lensPort'||item.lensPort&&item.lensPort!=='None')){
          item.dirty.add(setting);
          fields.push(setting);
        }
      }
      for(const dirty of item.dirty)if(isLensSetting(dirty)&&!lensFieldUsed(item,dirty))item.dirty.delete(dirty);
      if(item.lens!=='None')prefetchLensConnections(item);
      if(item.lens==='None'){
        item.lensPort='None';
        // Nothing about a lens is sent for None, so a camera not on a controller yet has nothing to send.
        item.dirty.delete('lensPort');
        if(!item.elementKey)item.dirty.delete('lens');
        // No lens leaves nothing to set up, so choosing one later starts clean.
        item.enabledLensAxes=[];
        for(const definition of Object.values(axisDefinitions).flat())item[definition.id]='';
      }
    }
    if(isLan){
      const wan=item.type==='WAN';
      if(field==='dhcp'){
        item.planned=value?'DHCP':'';
        item.operation='Edit';
        item.dirty.add('planned');
        fields.push('planned');
        // Turning DHCP on blanks a WAN's gateway and DNS on the controller in the same command, so they show blank here.
        if(wan&&value)for(const setting of ['gateway','dns1','dns2'])if(item[setting]){item[setting]='';item.dirty.add(setting);fields.push(setting);}
      }else if(item.operation==='Keep'&&field!=='operation'){
        item.operation=wan?'Edit':item.current?'Replace':'Add';
      }
      // A WAN's mode and its address go to the controller together.
      if(wan&&field==='planned'&&item.dirty.has('dhcp'))fields.push('dhcp');
      // Keep puts a WAN back the way the controller has it, which it says again for the gateway and DNS.
      if(wan&&field==='operation'&&item.operation==='Keep'&&item.elementKey){cancelLanDrafts(item.device,item.id);return [];}
      if(field==='operation'&&item.operation==='Keep'){
        item.planned=item.current;
        item.dirty.clear();
        item.pending=false;
        item.result='In sync';
        return [];
      }
    }
    return fields;
  }

  function commitCell(el){
    const isLan=!!el.closest('table[data-lan-device]');
    const item=(isLan?lans:cameras).find(row=>row.id===el.dataset.row);
    if(!item||item.deleting)return;
    const field=el.dataset.field;
    if(!isLan&&isLensSetting(field)&&!lensFieldUsed(item,field))return;
    const fields=stageCell(item,field,el.type==='checkbox'?el.checked:el.value,isLan);
    if(isLan&&['dhcp','operation'].includes(field))renderLans();
    else if(!isLan&&(['model','lens'].includes(field)||cameraSort(item.device).field===field))renderCameras();
    else paintItem(item);
    if(fields.length&&ui.sendMode==='Auto send')sendItems([item],isLan?'lan':'camera',false,item.isNew?[...item.dirty]:fields);
    remember();
  }
