  const openNetworkDevices=new Set(devices[0]?[devices[0].id]:[]);
  const hiddenNetworkColumnsByDevice={};
  const removedDevices=[];
  let discoveryCard=null;
  const networkFields=lanColumnDefinitions.filter(field=>field.id!=='device'&&field.id!=='status');
  function networkHidden(id){return hiddenNetworkColumnsByDevice[id]||(hiddenNetworkColumnsByDevice[id]=new Set(hiddenLanColumns));}
  function deviceBusy(id){return [...cameras,...lans].some(row=>row.device===id&&row.jobs>0);}
  function initializeDeviceWorkflow(){
    root.querySelector('[data-tab="discovery"]')?.remove();
    const panel=root.querySelector('#hc-devices'),discovery=root.querySelector('#hc-discovery');
    discovery.className='hc-discovery-block';discovery.hidden=false;discovery.setAttribute('role','region');discovery.setAttribute('aria-label','Find and add Cyanview devices');discovery.removeAttribute('aria-labelledby');
    discoveryCard=document.createElement('details');discoveryCard.className='hc-discovery-card';discoveryCard.dataset.role='device-discovery';discoveryCard.open=!devices.length;
    discoveryCard.innerHTML='<summary>'+icon('radar')+'Find &amp; add devices<span class="hc-caption">Discover RCPs and RIOs or enter an IP address</span></summary>';
    discoveryCard.append(discovery);panel.prepend(discoveryCard);
    discoveryCard.addEventListener('toggle',()=>{if(!root.hidden)remember();});
    const toolbar=action('review-lan').closest('.hc-toolbar');toolbar.querySelector('.hc-toolbar-title h3').textContent='Managed devices';action('review-lan').hidden=true;
    toolbar.insertAdjacentHTML('beforeend','<button class="hc-button" data-action="undo-remove-device" hidden>Undo removal</button><button class="hc-button" data-action="toggle-all-network" aria-label="Expand all device settings">Expand all</button>');
    root.querySelector('#hc-cameras > .hc-toolbar').insertAdjacentHTML('beforeend','<button class="hc-button" data-action="undo-remove-device" hidden>Undo removal</button>');
    panel.querySelector('.hc-toolbar-secondary').hidden=true;
    const list=document.createElement('div');list.dataset.role='network-devices';list.className='hc-controller-list';
    const oldSheet=panel.querySelector('.hc-sheet');oldSheet.replaceWith(list);
    action('add-ip').innerHTML=icon('radar')+'Find &amp; add';
    $('lan-foot').textContent='Each device has its own network settings.';
    panel.querySelector('.hc-panel-foot .hc-caption').textContent='Factory management addresses are protected';
  }
  function networkSelect(row,field,choices,disabled=false){return '<select class="hc-cell-input" data-row="'+row.id+'" data-field="'+field+'" aria-label="'+esc(field+' for '+device(row.device).name)+'"'+(disabled?' disabled':'')+'>'+(disabled?'<option value=""></option>':options(choices,row[field]))+'</select>';}
  function networkGrid(rows,d){
    const fields=networkFields.filter(field=>!networkHidden(d.id).has(field.id));
    if(!fields.length)return '<caption>No columns selected. Use Columns to show settings.</caption>';
    const header='<colgroup>'+fields.map(field=>'<col style="width:'+field.width+'px">').join('')+'</colgroup><thead><tr>'+fields.map(field=>'<th>'+field.label+'</th>').join('')+'</tr></thead>';
    return header+'<tbody>'+rows.map(row=>'<tr data-id="'+row.id+'">'+fields.map(field=>{
      const wan=row.type==='WAN',locked=row.readOnly;let content='',attrs='',inactive=false;
      if(field.id==='iface')content=locked?esc(row.iface):networkSelect(row,'iface',[...new Set([...(d.interfaces||[]),...rows.map(item=>item.iface),row.iface].filter(Boolean))]);
      else if(field.id==='current'){attrs=' data-current="'+row.id+'"';content='<span class="hc-mono hc-muted">'+esc(row.current||'—')+'</span>'+(wan?' <span class="hc-caption">WAN</span>':'');}
      else if(field.id==='planned'){inactive=locked||wan&&row.dhcp;content=inputCell(row,'planned',row.planned,'hc-mono',inactive);}
      else if(field.id==='operation'){inactive=locked;content=networkSelect(row,'operation',wan?['Keep','Edit']:['Keep','Add','Replace'],inactive);}
      else if(field.id==='sync'){attrs=' data-sync-id="'+row.id+'"';content=resultMark(row.result);}
      else if(field.id==='dhcp'){inactive=!wan||locked;content=inactive?'':'<input type="checkbox" data-row="'+row.id+'" data-field="dhcp" aria-label="DHCP for '+esc(d.name)+'"'+(row.dhcp?' checked':'')+'>';}
      else{inactive=!wan||row.dhcp||locked;content=inputCell(row,field.id,row[field.id],'hc-mono',inactive);}
      return '<td data-column="'+field.id+'"'+attrs+' class="'+(inactive?'hc-axis-inactive ':'')+(row.dirty.has(field.id)?'hc-changed':'')+'">'+content+'</td>';
    }).join('')+'</tr>').join('')+'</tbody>';
  }
  function networkColumnMenu(id){return '<section class="hc-column-section"><h4>Network columns</h4>'+networkFields.map(field=>'<label><input type="checkbox" data-network-column="'+field.id+'" data-network-device="'+id+'" aria-label="Show '+esc(field.label)+'"'+(!networkHidden(id).has(field.id)?' checked':'')+'>'+field.label+'</label>').join('')+'</section>';}
  function renderManagedDevices(){
    const list=$('network-devices');if(!list)return;
    const scrolls=new Map([...list.querySelectorAll('[data-network-controller]')].map(element=>[element.dataset.networkController,element.querySelector('.hc-scroll')?.scrollLeft||0]));
    list.innerHTML=orderedDevices().map(d=>{
      const rows=lans.filter(row=>row.device===d.id),open=openNetworkDevices.has(d.id),interfaces=new Set(rows.map(row=>row.iface)).size;
      return '<section class="hc-controller" data-network-controller="'+d.id+'"><div class="hc-controller-header"><button class="hc-controller-handle" draggable="true" data-reorder-handle="'+d.id+'" aria-label="Reorder '+esc(d.name)+'" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">'+icon('grip-vertical')+'</button><button class="hc-controller-expander" data-action="toggle-network-device" data-id="'+d.id+'" aria-expanded="'+open+'" aria-controls="network-settings-'+d.id+'">'+icon(open?'chevron-down':'chevron-right')+'<strong>'+esc(d.name)+'</strong><span class="hc-device-type">'+esc(d.kind)+'</span>'+(d.name!==d.serial?'<span class="hc-controller-serial">'+esc(d.serial)+'</span>':'')+'</button><span class="hc-controller-camera-count">'+interfaces+' interface'+(interfaces===1?'':'s')+'</span>'+status(d.online)+'</div><div id="network-settings-'+d.id+'"'+(open?'':' hidden')+'><div class="hc-controller-tools"><button class="hc-button" data-action="network-add-lan" data-id="'+d.id+'">'+icon('plus')+'LAN address</button><button class="hc-danger" data-action="remove-device" data-id="'+d.id+'" aria-label="Remove '+esc(d.name)+' from managed list">'+icon('trash-2')+'Remove device</button><span class="hc-right"></span><button data-action="network-columns" data-id="'+d.id+'">'+icon('columns-3')+'Columns</button><button class="hc-button" data-action="send-network-device" data-id="'+d.id+'">'+icon('send')+'Send settings <span>0</span></button><div class="hc-column-menu" data-network-columns-for="'+d.id+'" hidden>'+networkColumnMenu(d.id)+'</div></div><div class="hc-device-settings"><label>Device name<input class="hc-input" data-device-setting="name" data-device-id="'+d.id+'" aria-label="Device name for '+esc(d.serial)+'" value="'+esc(d.name)+'"></label><label>Connection IP<input class="hc-input hc-mono" data-device-setting="address" data-device-id="'+d.id+'" aria-label="Connection IP for '+esc(d.serial)+'" value="'+esc(d.address||d.base)+'"></label><span class="hc-caption">Factory address <span class="hc-mono">'+esc(d.base)+'</span></span></div><div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" data-lan-device="'+d.id+'" aria-label="Network settings for '+esc(d.name)+'">'+networkGrid(rows,d)+'</table></div></div><div class="hc-controller-bottom"><span>Network settings</span><span data-network-pending="'+d.id+'"></span></div></div></section>';
    }).join('')||'<div class="hc-managed-empty"><strong>No managed devices yet</strong><span>Use Find &amp; add devices above to discover or enter a device IP.</span></div>';
    for(const[id,left]of scrolls){const scroll=list.querySelector('[data-network-controller="'+id+'"] .hc-scroll');if(scroll)scroll.scrollLeft=left;}
    syncSummary();icons();
  }
  function syncNetworkControls(){
    const allOpen=devices.length>0&&devices.every(d=>openNetworkDevices.has(d.id)),toggle=action('toggle-all-network');
    if(toggle){toggle.textContent=allOpen?'Collapse all':'Expand all';toggle.disabled=!devices.length;toggle.setAttribute('aria-label',(allOpen?'Collapse':'Expand')+' all device settings');}
    root.querySelectorAll('[data-action="undo-remove-device"]').forEach(button=>button.hidden=!removedDevices.length);
    for(const d of devices){const section=root.querySelector('[data-network-controller="'+d.id+'"]');if(!section)continue;const pending=pendingLans().filter(row=>row.device===d.id).length,busy=deviceBusy(d.id);const send=section.querySelector('[data-action="send-network-device"]');send.disabled=!pending||busy;send.querySelector('span').textContent=pending;section.querySelector('[data-action="remove-device"]').disabled=busy;section.querySelector('[data-network-pending]').textContent=pending?pending+' pending':'';}
    root.querySelectorAll('[data-action="remove-device"]').forEach(button=>button.disabled=deviceBusy(button.dataset.id));
  }
  function addNetworkAddress(id){
    const d=device(id);if(!d)return;
    if(lans.length>=1024){toast('Network row capacity reached');return;}
    const iface=lans.find(row=>row.device===id&&row.readOnly)?.iface||d.interfaces?.[0]||'LAN1';
    lans.push({id:'new-lan-'+crypto.randomUUID(),device:id,type:'LAN',iface,current:'',planned:'',operation:'Add',pending:true,result:'Incomplete',dhcp:false,gateway:'',dns1:'',dns2:'',dirty:new Set(['planned']),revision:0,jobs:0});
    openNetworkDevices.add(id);renderLans();remember();
  }
  function removeManagedDevice(id){
    if(deviceBusy(id)){toast('Wait for this device’s current send to finish');return;}
    const index=devices.findIndex(d=>d.id===id);if(index<0)return;
    const d=devices[index];removedDevices.push({device:{...d},index,orderIndex:deviceOrder.indexOf(id),lans:lans.filter(row=>row.device===id),cameras:cameras.filter(row=>row.device===id),networkOpen:openNetworkDevices.has(id),cameraOpen:openControllers.has(id)});
    devices.splice(index,1);lans=lans.filter(row=>row.device!==id);cameras=cameras.filter(row=>row.device!==id);deviceOrder=deviceOrder.filter(value=>value!==id);openNetworkDevices.delete(id);openControllers.delete(id);if(!devices.length)discoveryCard.open=true;
    syncFilter();renderLans();renderCameras();renderResults();syncSummary();remember();toast(d.name+' removed from managed list');
  }
  function undoDeviceRemoval(){
    const entry=removedDevices.pop();if(!entry)return;if(device(entry.device.id)){syncSummary();toast('This device is already managed');return;}
    devices.splice(Math.min(entry.index,devices.length),0,{...entry.device,online:null});deviceOrder.splice(Math.max(0,entry.orderIndex),0,entry.device.id);lans.push(...entry.lans);cameras.push(...entry.cameras);
    if(entry.networkOpen)openNetworkDevices.add(entry.device.id);if(entry.cameraOpen)openControllers.add(entry.device.id);
    syncFilter();renderLans();renderCameras();renderResults();syncSummary();remember();toast('Device restored to managed list');
  }
  function restoreDeviceWorkflow(data){
    if(typeof data.discoveryOpen==='boolean'&&discoveryCard)discoveryCard.open=data.discoveryOpen;
    if(Array.isArray(data.openNetworkDevices)){openNetworkDevices.clear();for(const id of data.openNetworkDevices)if(device(id))openNetworkDevices.add(id);}
    for(const[id,fields]of Object.entries(data.hiddenNetworkColumnsByDevice||{}))if(device(id)&&Array.isArray(fields))hiddenNetworkColumnsByDevice[id]=new Set(fields.filter(id=>networkFields.some(field=>field.id===id)));
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;const id=button.dataset.id;
    switch(button.dataset.action){
      case 'toggle-network-device':if(openNetworkDevices.has(id))openNetworkDevices.delete(id);else openNetworkDevices.add(id);renderLans();remember();break;
      case 'toggle-all-network':if(devices.every(d=>openNetworkDevices.has(d.id)))openNetworkDevices.clear();else devices.forEach(d=>openNetworkDevices.add(d.id));renderLans();remember();break;
      case 'network-add-lan':addNetworkAddress(id);break;
      case 'send-network-device':showReview(pendingLans().filter(row=>row.device===id),'lan');break;
      case 'remove-device':removeManagedDevice(id);break;
      case 'undo-remove-device':undoDeviceRemoval();break;
      case 'network-columns':{const menu=root.querySelector('[data-network-columns-for="'+id+'"]');if(menu.hidden)showColumnMenu(menu);else menu.hidden=true;break;}
    }
  });
  root.addEventListener('change',event=>{
    const element=event.target;
    if(element.dataset.networkColumn){const id=element.dataset.networkDevice,field=element.dataset.networkColumn,hidden=networkHidden(id),scroll=element.closest('.hc-column-menu').scrollTop;if(element.checked)hidden.delete(field);else hidden.add(field);renderLans();const menu=root.querySelector('[data-network-columns-for="'+id+'"]');showColumnMenu(menu);menu.scrollTop=scroll;menu.querySelector('[data-network-column="'+field+'"]')?.focus({preventScroll:true});remember();}
    if(element.dataset.deviceSetting){const d=device(element.dataset.deviceId);if(!d)return;const field=element.dataset.deviceSetting,value=element.value.trim();if(field==='address'&&!ipv4(value)||field==='name'&&(!value||value.length>160)){element.value=d[field]||d.base;toast(field==='address'?'Enter a valid connection IP':'Enter a device name');return;}d[field]=value;syncFilter();renderLans();renderCameras();remember();}
  });
  root.addEventListener('keydown',event=>{if(event.key==='Escape')root.querySelectorAll('[data-network-columns-for]').forEach(menu=>menu.hidden=true);if(event.key==='Enter'&&event.target.dataset.deviceSetting){event.preventDefault();event.target.blur();}});
