  function lensAxisForField(field){
    return /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.exec(field)?.[1];
  }
  function lensAxisForUseColumn(column){
    return /^(iris|zoom|focus)Summary$/.exec(column)?.[1];
  }
  // A Tilta motor has no direction setting, so its iris is reversed by swapping Open and Closed. Its
  // Direction cell says which way round they are, and picking the other one swaps the two numbers.
  const irisSwapChoices=[{value:'normal',label:'Normal'},{value:'swapped',label:'Swapped'}];
  function irisSwapCell(camera,field){
    return field==='irisDirection'&&lensCapabilities(camera).motor&&lensAxisEnabled(camera,'iris');
  }
  function irisSwapValue(camera){
    const open=Number(camera.irisMin),closed=Number(camera.irisMax);
    return open>0&&closed>0&&open!==closed?(open>closed?'swapped':'normal'):'';
  }
  // Open below Closed, except on a Tilta, where either order is a range.
  function irisRangeValid(camera){
    const open=Number(camera.irisMin),closed=Number(camera.irisMax);
    return open>0&&(lensCapabilities(camera).motor?closed>0&&closed!==open:closed>open);
  }
  // Open and Closed can change from a typed value, a paste, undo or a read, so the cell follows the row.
  function paintIrisSwap(camera){
    root.querySelectorAll('table[data-camera-device] [data-row="'+CSS.escape(camera.id)+'"][data-field="irisDirection"]').forEach(control=>{
      const cell=control.closest('td'),swap=irisSwapCell(camera,'irisDirection');
      const markup=cameraChoiceCell(camera,'irisDirection',!swap&&!lensFieldUsed(camera,'irisDirection'));
      if(cell.innerHTML!==markup)cell.innerHTML=markup;
    });
  }
  function lensAxisAvailable(camera){
    return lensCapabilities(camera).iris&&camera.lens!=='cmotion cGate'&&!importedCamera(camera);
  }
  function lensAxisEnabled(camera,axis){
    return lensAxisAvailable(camera)&&camera.enabledLensAxes?.includes(axis);
  }
  function lensAxisControl(camera,axis,summary){
    if(!lensAxisAvailable(camera))return '<span title="Unavailable for this camera">—</span>';
    const text=summary?(lensAxisEnabled(camera,axis)?axisSummary(camera,axis):'Off'):'';
    return '<div class="hc-axis-toggle"><span data-hubble-boolean data-lens-axis="'+axis+'"></span>'+(text?'<span>'+esc(text)+'</span>':'')+'</div>';
  }
  // The settings this lens has for an axis, whether or not the axis is in use.
  function lensAxisSettings(camera,axis){
    const p=lensCapabilities(camera);
    return axisDefinitions[axis].map(field=>field.id).filter(field=>field.endsWith('Motor')?p.motor:field==='irisMin'||field==='irisMax'?p.iris:p.torque);
  }
  // Someone deleted a setting of this axis. One that was never filled in doesn't count.
  function lensAxisBeingCleared(camera,field){
    const axis=lensAxisForField(field);
    return !!axis&&lensAxisAvailable(camera)&&lensAxisSettings(camera,axis).some(setting=>camera.dirty.has(setting)&&!camera[setting]);
  }
  // The controller can't hold part of an axis, so once a deletion lands the sheet shows what's left of it.
  // Only a Tilta iris can lose part: it keeps its motor without limits. Returns whether a cell changed.
  function settleClearedLensAxes(item,captured,sentFields){
    let changed=false;
    for(const axis of new Set(sentFields.map(lensAxisForField).filter(Boolean))){
      const settings=lensAxisSettings(captured,axis);
      if(!settings.some(setting=>sentFields.includes(setting)&&!captured[setting]))continue;
      const keepsMotor=captured.lens==='Tilta - Nucleus-M'&&axis==='iris'&&captured.irisMotor;
      for(const setting of settings)if(!(keepsMotor&&setting==='irisMotor')&&item[setting]&&item[setting]===captured[setting]){item[setting]='';changed=true;}
    }
    return changed;
  }
  // Returns the settings to send, or null when the axis was already that way.
  function setLensAxis(camera,axis,on){
    const enabled=new Set(camera.enabledLensAxes);
    if(enabled.has(axis)===on)return null;
    // Turning an axis off drops its pending edits, unless one of them deleted a setting.
    const deleted=!on&&lensAxisSettings(camera,axis).some(field=>camera.dirty.has(field)&&!camera[field]);
    if(on)enabled.add(axis);
    else enabled.delete(axis);
    camera.enabledLensAxes=[...enabled];
    if(!deleted)for(const field of axisDefinitions[axis])camera.dirty.delete(field.id);
    // A setting nobody has filled in has nothing to send yet.
    const fields=axisDefinitions[axis].map(field=>field.id).filter(field=>lensFieldUsed(camera,field)&&camera[field]);
    for(const field of fields)camera.dirty.add(field);
    camera.revision++;
    camera.pending=camera.dirty.size>0;
    camera.result=camera.jobs?'Sending':camera.pending?'Pending':'In sync';
    return fields;
  }
