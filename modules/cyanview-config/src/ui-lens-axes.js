  function lensAxisForField(field){
    return /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.exec(field)?.[1];
  }
  function lensAxisAvailable(camera){
    return lensCapabilities(camera).iris&&camera.lens!=='cmotion cGate'&&!importedCamera(camera);
  }
  function lensAxisEnabled(camera,axis){
    return lensAxisAvailable(camera)&&camera.enabledLensAxes?.includes(axis);
  }
  function lensAxisControl(camera,axis,summary){
    if(!lensAxisAvailable(camera))return '<span title="Unavailable for this camera">—</span>';
    const enabled=lensAxisEnabled(camera,axis);
    const label='Configure '+axisName(axis)+' for camera '+camera.number;
    return '<label class="hc-axis-toggle"><input type="checkbox" data-lens-axis="'+axis+'" aria-label="'+esc(label)+'"'+(enabled?' checked':'')+(camera.deleting?' disabled':'')+'>'+(summary?'<span>'+esc(enabled?axisSummary(camera,axis):'Off')+'</span>':'')+'</label>';
  }
  root.addEventListener('change',event=>{
    const input=event.target,axis=input.dataset.lensAxis;
    if(!axis)return;
    const id=input.closest('tr').dataset.id,camera=cameras.find(row=>row.id===id);
    if(!camera||camera.deleting||!lensAxisAvailable(camera))return;
    const enabled=new Set(camera.enabledLensAxes);
    if(input.checked)enabled.add(axis);
    else enabled.delete(axis);
    camera.enabledLensAxes=[...enabled];
    const fields=axisDefinitions[axis].map(field=>field.id).filter(field=>lensFieldUsed(camera,field));
    for(const field of axisDefinitions[axis])camera.dirty.delete(field.id);
    for(const field of fields)camera.dirty.add(field);
    camera.revision++;
    camera.pending=camera.dirty.size>0;
    camera.result=camera.jobs?'Sending':camera.pending?'Pending':'In sync';
    renderCameras();
    root.querySelector('tr[data-id="'+id+'"] [data-lens-axis="'+axis+'"]')?.focus({preventScroll:true});
    if(fields.length&&ui.sendMode==='Auto send')sendItems([camera],'camera',false,camera.isNew?[...camera.dirty]:fields);
    remember();
  });
