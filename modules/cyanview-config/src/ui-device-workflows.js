  const removedDevices=[];
  // A redraw leaves the element in use where it is. The cell being typed in and the path down to it
  // stay in the page, and everything around them is replaced. Replacing the cell itself made the
  // browser commit its half-typed text, so an unfinished address was refused and cleared, and a
  // name lost the keyboard, whenever a controller reported a change (Nov 17, 2026).
  let redrawing=0;
  function copyAttributes(element,other,skip=[]){
    for(const name of element.getAttributeNames())if(!other.hasAttribute(name)&&!skip.includes(name))element.removeAttribute(name);
    for(const name of other.getAttributeNames())if(!skip.includes(name)&&element.getAttribute(name)!==other.getAttribute(name))element.setAttribute(name,other.getAttribute(name));
  }
  /** Draws markup into host around kept. Returns what kept would have been replaced with, or null when everything was replaced. */
  function redrawAround(host,markup,kept,findTwin){
    const next=document.createElement('div');next.innerHTML=markup;
    const twin=kept&&host.contains(kept)?findTwin(next):null;
    const path=(top,leaf)=>{const nodes=[];for(let node=leaf;node&&node!==top;node=node.parentElement)nodes.unshift(node);return nodes;};
    const from=twin?path(host,kept):[],to=twin?path(next,twin):[];
    if(!twin||from.length!==to.length||from.some((node,index)=>node.tagName!==to[index].tagName)){
      // Removing a focused box makes the browser report it as left; nothing is committed from that.
      redrawing++;try{host.innerHTML=markup;}finally{redrawing--;}
      return null;
    }
    let parent=host,source=next;
    for(const[index,child]of from.entries()){
      const other=to[index];let before=true;
      for(const sibling of[...parent.childNodes])if(sibling!==child)sibling.remove();
      for(const sibling of[...source.childNodes]){if(sibling===other){before=false;continue;}if(before)parent.insertBefore(sibling,child);else parent.append(sibling);}
      if(child!==kept)copyAttributes(child,other);
      parent=child;source=other;
    }
    return twin;
  }
  function deviceBusy(id){return [...cameras,...lans].some(row=>row.device===id&&row.jobs>0);}
  // The Devices tab is the device sheet. The old finder panel stays out of sight: the sheet's toolbar
  // takes its scan controls, and found devices list as rows in the sheet.
  function initializeDeviceWorkflow(){
    root.querySelector('[data-tab="discovery"]')?.remove();
    const panel=root.querySelector('#hc-devices');
    const toolbar=action('review-lan').closest('.hc-toolbar');action('review-lan').hidden=true;action('add-ip').remove();
    toolbar.insertAdjacentHTML('beforeend','<button class="hc-button" data-action="undo-remove-device" hidden>Undo removal</button>');
    root.querySelector('#hc-cameras > .hc-toolbar').insertAdjacentHTML('beforeend','<button class="hc-button" data-action="undo-remove-device" hidden>Undo removal</button>');
    panel.querySelector('.hc-toolbar-secondary').hidden=true;
    panel.querySelector('.hc-panel-foot .hc-caption').textContent='Factory management addresses are protected';
  }
  function syncDeviceControls(){
    root.querySelectorAll('[data-action="undo-remove-device"]').forEach(button=>button.hidden=!removedDevices.length);
    root.querySelectorAll('[data-action="remove-device"]').forEach(button=>button.disabled=deviceBusy(button.dataset.id));
  }
  function removeManagedDevice(id){
    if(deviceBusy(id)){toast('Wait for this device’s current send to finish');return;}
    const index=devices.findIndex(d=>d.id===id);if(index<0)return;
    const d=devices[index];removedDevices.push({device:{...d},index,orderIndex:deviceOrder.indexOf(id),lans:lans.filter(row=>row.device===id),cameras:cameras.filter(row=>row.device===id),cameraOpen:openControllers.has(id)});
    devices.splice(index,1);lans=lans.filter(row=>row.device!==id);cameras=cameras.filter(row=>row.device!==id);deviceOrder=deviceOrder.filter(value=>value!==id);openControllers.delete(id);
    syncFilter();renderLans();renderCameras();renderResults();syncSummary();remember();toast(d.name+' removed from managed list');
  }
  function undoDeviceRemoval(){
    const entry=removedDevices.pop();if(!entry)return;if(device(entry.device.id)){syncSummary();toast('This device is already managed');return;}
    devices.splice(Math.min(entry.index,devices.length),0,{...entry.device,online:null});deviceOrder.splice(Math.max(0,entry.orderIndex),0,entry.device.id);lans.push(...entry.lans);cameras.push(...entry.cameras);
    if(entry.cameraOpen)openControllers.add(entry.device.id);
    syncFilter();renderLans();renderCameras();renderResults();syncSummary();remember();toast('Device restored to managed list');
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;const id=button.dataset.id;
    switch(button.dataset.action){
      case 'remove-device':removeManagedDevice(id);break;
      case 'undo-remove-device':undoDeviceRemoval();break;
    }
  });
