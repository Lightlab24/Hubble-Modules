  const cameraSortByDevice={};
  const cameraSortFields=cameraColumnSections().flatMap(section=>section.fields.filter(field=>!field.summary&&!field.id.startsWith('remi:')).map(field=>field.id));
  const cameraSortLabels=Object.fromEntries(cameraColumnSections().flatMap(section=>section.fields.filter(field=>!field.summary).map(field=>[field.id,field.label])));
  function cameraSort(id){return cameraSortByDevice[id]||(cameraSortByDevice[id]={field:'number',direction:'asc'});}
  function sortCameraValue(camera,field){
    if(field==='controlEnabled')return cameraControlEnabled(camera)?'1':'0';
    if(isAssignmentField(field))return assignmentSortValue(camera,field);
    if(field==='model'&&importedCamera(camera))return remiModelName(camera);
    if(irisSwapCell(camera,field))return irisSwapValue(camera);
    if(isLensSetting(field)&&!lensFieldUsed(camera,field))return '';
    if(field==='control')return connectionText(camera.online);
    if(field==='recording')return cameraRecordingText(camera.id);
    if(field==='cameraStatus')return cameraStatusText(camera.id);
    if(field==='sync')return camera.result||'';
    if(field==='ip'&&camera.model==='Alpha-USB')return camera.usb||'';
    if(['port','login','password'].includes(field)&&camera.model==='Alpha-USB')return '';
    if(field==='connection'){const capabilities=lensCapabilities(camera);return capabilities.ip?camera.lensIp||'':capabilities.port?camera.lensPort||'':'';}
    return String(camera[field]??'').trim();
  }
  function sortCameraRows(rows,id){
    const sort=cameraSort(id),direction=sort.direction==='desc'?-1:1;
    return rows.map((row,index)=>({row,index})).sort((a,b)=>{
      const left=sortCameraValue(a.row,sort.field),right=sortCameraValue(b.row,sort.field);
      if(!left||!right)return left? -1:right?1:a.index-b.index;
      return direction*left.localeCompare(right,undefined,{numeric:true,sensitivity:'base'})||a.index-b.index;
    }).map(entry=>entry.row);
  }
  function cameraSortAria(column,id){
    if(!cameraSortFields.includes(column.id))return '';
    const sort=cameraSort(id);return ' data-sort-header="'+column.id+'" aria-sort="'+(sort.field===column.id?(sort.direction==='asc'?'ascending':'descending'):'none')+'"';
  }
  function cameraSortHeading(column,id){
    if(!cameraSortFields.includes(column.id))return esc(column.label);
    const sort=cameraSort(id),label=cameraSortLabels[column.id]||column.label;
    return '<button class="hc-sort-heading" data-action="sort-cameras" data-id="'+id+'" data-sort-field="'+column.id+'" aria-label="Sort by '+esc(label)+'">'+column.label+(sort.field===column.id?'<span aria-hidden="true">'+(sort.direction==='asc'?'↑':'↓')+'</span>':'')+'</button>';
  }
  function restoreCameraSorting(data){
    for(const[id,sort]of Object.entries(data.cameraSortByDevice||{}))if(sheetOwner(id)&&sort&&cameraSortFields.includes(sort.field)&&['asc','desc'].includes(sort.direction))cameraSortByDevice[id]={field:sort.field,direction:sort.direction};
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="sort-cameras"]');if(!button)return;
    const id=button.dataset.id,field=button.dataset.sortField,previous=cameraSort(id);
    cameraSortByDevice[id]={field,direction:previous.field===field&&previous.direction==='asc'?'desc':'asc'};
    renderCameras();remember();root.querySelector('[data-controller="'+id+'"] [data-sort-field="'+field+'"]')?.focus({preventScroll:true});
  });
