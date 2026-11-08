(() => {
  const root=document.getElementById('cyanview-design'); if(!root)return;
  const $=role=>root.querySelector('[data-role="'+role+'"]');
  const action=name=>root.querySelector('[data-action="'+name+'"]');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=name=>'<i data-lucide="'+name+'" class="hc-icon" aria-hidden="true"></i>';
  const icons=()=>{if(globalThis.lucide)globalThis.lucide.createIcons({attrs:{width:15,height:15}});};
  const ui={density:'Comfortable',networkAdvanced:false,cameraCredentials:true,lensColumns:true,cameraCore:true,serials:false,sendMode:'Manual'};
  const lensModels=['None','DC Motors','B4 Generic','B4 Fuji','Canon Remote','Cyan Motors','Tilta - Nucleus-M','Tilta - Nucleus-M II','Tilta - Nano-II','ARRI - cforce','DJI - Ronin CAN','cmotion cGate'];
  const devices = [
    { id:'rcp1', name:'RCP 01', kind:'RCP', serial:'CY-RCP-10-54', base:'10.192.10.54', alias:'10.20.101.200', online:true },
    { id:'rcp2', name:'RCP 02', kind:'RCP', serial:'CY-RCP-10-55', base:'10.192.10.55', alias:'', online:true },
    { id:'rio1', name:'RIO 01', kind:'RIO', serial:'CY-RIO-54-19', base:'10.192.54.19', alias:'10.20.100.13', online:true },
    { id:'rio2', name:'RIO 02', kind:'RIO', serial:'CY-RIO-90-153', base:'10.192.90.153', alias:'10.20.101.108', online:true },
    { id:'rio3', name:'RIO 03', kind:'RIO', serial:'CY-RIO-24-87', base:'10.192.24.87', alias:'10.20.101.110', online:false },
  ];
  let lans = [
    { id:'lan1', device:'rcp1', type:'LAN', iface:'LAN1', current:'10.20.101.200/16', planned:'10.20.101.200/16', operation:'Keep', result:'In sync', dhcp:false, gateway:'', dns1:'', dns2:'' },
    { id:'lan2', device:'rcp2', type:'LAN', iface:'LAN1', current:'', planned:'10.20.101.201/16', operation:'Add', result:'Pending', dhcp:false, gateway:'', dns1:'', dns2:'' },
    { id:'lan3', device:'rio1', type:'LAN', iface:'LAN1', current:'10.20.100.13/16', planned:'10.20.101.106/16', operation:'Replace', result:'Pending', dhcp:false, gateway:'', dns1:'', dns2:'' },
    { id:'lan4', device:'rio2', type:'LAN', iface:'LAN1', current:'10.20.101.108/16', planned:'10.20.101.108/16', operation:'Keep', result:'In sync', dhcp:false, gateway:'', dns1:'', dns2:'' },
    { id:'lan5', device:'rio3', type:'LAN', iface:'LAN1', current:'10.20.101.110/16', planned:'10.20.101.110/16', operation:'Keep', result:'Last seen', dhcp:false, gateway:'', dns1:'', dns2:'' },
    { id:'wan1', device:'rio2', type:'WAN', iface:'LAN1', current:'DHCP', planned:'DHCP', operation:'Keep', result:'In sync', dhcp:true, gateway:'', dns1:'', dns2:'' },
  ];
  let cameras = [
    { id:'cam1', device:'rcp1', number:'1', name:'Venice 2 — tight', model:'Venice-IP', ip:'10.20.100.101', lens:'B4 Generic', lensPort:'RIO 01 : 1', online:true, pending:false, result:'In sync', port:'80', login:'admin', password:'demo' },
    { id:'cam2', device:'rcp1', number:'2', name:'Venice 2 — wide', model:'Venice-IP', ip:'10.20.100.102', lens:'B4 Generic', lensPort:'RIO 01 : 2', online:true, pending:true, result:'Pending', port:'80', login:'admin', password:'demo' },
    { id:'cam3', device:'rcp1', number:'3', name:'Venice 2 — handheld', model:'Venice-IP', ip:'10.20.100.103', lens:'None', lensPort:'None', online:true, pending:false, result:'In sync', port:'80', login:'admin', password:'demo' },
    { id:'cam4', device:'rcp2', number:'1', name:'Venice 2 — tight', model:'Venice-IP', ip:'10.20.100.101', lens:'None', lensPort:'None', online:true, pending:false, result:'In sync', port:'80', login:'admin', password:'demo' },
    { id:'cam5', device:'rcp2', number:'2', name:'Venice 2 — wide', model:'Venice-IP', ip:'10.20.100.102', lens:'None', lensPort:'None', online:true, pending:false, result:'In sync', port:'80', login:'admin', password:'demo' },
    { id:'cam6', device:'rio1', number:'11', name:'FX3 — remote', model:'Alpha-USB', ip:'', lens:'B4 Generic', lensPort:'RIO 01 : 1', online:false, pending:false, result:'In sync', port:'', login:'', password:'' },
    { id:'cam7', device:'rio2', number:'9', name:'FX3 — lens test', model:'Alpha-USB', ip:'', lens:'B4 Generic', lensPort:'RIO 02 : 1', online:false, pending:false, result:'In sync', port:'', login:'', password:'' },
    { id:'cam8', device:'rcp1', number:'4', name:'Venice 2 — reverse', model:'Venice-IP', ip:'10.20.100.104', lens:'None', lensPort:'None', online:true, pending:false, result:'In sync', port:'80', login:'admin', password:'demo' },
  ];

  let tab='cameras',results=[],scanTimer=null,toastTimer=null,reviewItems=[];
  const openControllers=new Set(['rcp1']);
  let deviceOrder=devices.map(d=>d.id),draggedDevice=null;
  const orderedDevices=()=>[...deviceOrder.map(id=>devices.find(d=>d.id===id)).filter(Boolean),...devices.filter(d=>!deviceOrder.includes(d.id))];
  const selectedCameras=new Set(),selectedResults=new Set(),deviceQueues=new Map();
  const cellSelections=new Map();
  const device=id=>devices.find(d=>d.id===id);
  const options=(list,current)=>list.map(v=>'<option value="'+esc(typeof v==='string'?v:v.id)+'"'+((typeof v==='string'?v:v.id)===current?' selected':'')+'>'+esc(typeof v==='string'?v:v.label)+'</option>').join('');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const status=online=>'<span class="hc-status '+(online?'hc-online':'hc-offline')+'"><span class="hc-dot"></span>'+(online?'Online':'Offline')+'</span>';
  const resultMark=result=>'<span class="hc-status '+(result==='Verified'?'hc-online':['Sending','Verifying','Queued','Pending'].includes(result)?'hc-pending-text':['Invalid IP','Incomplete','Offline · unsent'].includes(result)?'hc-error-text':'hc-muted')+'">'+(result==='Verified'?icon('check'):'')+esc(result)+'</span>';
  lans.forEach(l=>{l.pending=l.result==='Pending';l.dirty=new Set(l.pending?['planned']:[]);l.revision=0;l.jobs=0;});
  cameras.forEach(c=>{c.dirty=new Set(c.pending?['name']:[]);c.revision=0;c.jobs=0;});
  const pendingLans=()=>lans.filter(l=>l.pending);
  const pendingCameras=id=>cameras.filter(c=>c.pending&&(!id||c.device===id));
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},2800);}
  let lastSavedPrivateContent='';
  function remember(){
    try{const snapshot={modelContent:{activeTab:tab,layout:'Fleet LAN sheet',cameraOrganization:'Expandable spreadsheet per RCP/RIO',sendMode:ui.sendMode,sendModeScope:'Camera/lens and LAN',density:ui.density,lensColumns:ui.lensColumns,deviceOrder:orderedDevices().slice(0,16).map(d=>d.name),lensPresentation:'Inline Iris, Zoom and Focus column groups',axisGroups:axisGroups('rcp1'),reordering:'Drag handles with Alt+Up/Down keyboard support',columnVisibility:'Individual column checkboxes per sheet',hiddenCameraColumns:[...hiddenCameraColumns('rcp1')],hiddenLanColumns:[...hiddenLanColumns],remiSharing:'Deferred until a later capture'},privateContent:{revision:6,hiddenCameraColumnsByDevice:Object.fromEntries(Object.entries(hiddenCameraColumnsByDevice).map(([id,fields])=>[id,[...fields]])),hiddenLanColumns:[...hiddenLanColumns],tab,ui:{...ui},axisGroupsByDevice:JSON.parse(JSON.stringify(axisGroupsByDevice)),deviceOrder:orderedDevices().map(d=>d.id),openControllers:[...openControllers],scanRange:$('scan-range').value,deviceFilter:$('device-filter').value}};lastSavedPrivateContent=JSON.stringify(snapshot.privateContent);const p=window.openai?.setWidgetState?.(snapshot);if(p?.catch)p.catch(()=>{});}catch{}
  }
  function syncFilter(){const select=$('device-filter'),old=select.value;select.innerHTML='<option value="all">All devices</option>'+options(orderedDevices().map(d=>({id:d.id,label:d.name+' · '+d.serial})),old);select.value=devices.some(d=>d.id===old)?old:'all';}
  function syncOrganization(){
    const ordered=orderedDevices(),allOpen=ordered.length>0&&ordered.every(d=>openControllers.has(d.id)),button=action('toggle-all-controllers');
    button.innerHTML=icon(allOpen?'chevrons-down-up':'chevrons-up-down')+'<span data-role="expand-all-label">'+(allOpen?'Collapse all':'Expand all')+'</span>';
    button.setAttribute('aria-label',(allOpen?'Collapse':'Expand')+' all device spreadsheets');
    icons();
  }
  function setOrder(ids,focusId=null){
    const known=new Set(devices.map(d=>d.id));deviceOrder=[...new Set(ids.filter(id=>known.has(id)))];devices.forEach(d=>{if(!deviceOrder.includes(d.id))deviceOrder.push(d.id);});
    const list=$('controllers');
    deviceOrder.forEach(id=>{const section=root.querySelector('[data-controller="'+id+'"]');if(section)list.append(section);});
    syncFilter();renderLans();syncOrganization();remember();
    if(focusId)root.querySelector('[data-reorder-handle="'+focusId+'"]')?.focus();
  }
  function moveDevice(id,direction){
    const ids=orderedDevices().map(d=>d.id),index=ids.indexOf(id),target=index+(direction==='up'?-1:1);
    if(index<0||target<0||target>=ids.length)return;
    [ids[index],ids[target]]=[ids[target],ids[index]];setOrder(ids,id);
  }
  function dropDevice(id,target,after){
    if(!id||id===target)return;
    const ids=orderedDevices().map(d=>d.id).filter(value=>value!==id),index=ids.indexOf(target);if(index<0)return;
    ids.splice(index+(after?1:0),0,id);setOrder(ids,id);
  }
  function clearDrag(){draggedDevice=null;root.querySelectorAll('[data-drop],[data-dragging]').forEach(el=>{delete el.dataset.drop;delete el.dataset.dragging;});}
  function syncSummary(){
    const nl=pendingLans().length,nc=pendingCameras().length,inFlight=[...lans,...cameras].filter(i=>i.jobs>0).length;
    $('device-count').textContent=devices.length;$('camera-count').textContent=cameras.length;
    $('live-summary').textContent=' · '+devices.filter(d=>d.online).length+' online / '+devices.filter(d=>!d.online).length+' offline';
    $('device-summary').textContent=devices.length+' managed devices';$('camera-summary').textContent=devices.length+' devices · '+cameras.length+' cameras';
    $('lan-pending').textContent=nl;
    $('pending-summary').textContent=inFlight?inFlight+' sending · '+Math.max(0,nl+nc-inFlight)+' pending':nl+nc?(nl+nc)+' changes pending':'All changes verified';
    $('pending-summary').classList.toggle('hc-changes-label',!!(nl+nc));
    $('saved-label').textContent='Workspace saved · '+ui.sendMode;
    $('lan-foot').textContent=ui.sendMode==='Manual'?'Manual · edit, then Send changes.':'Auto send · Enter, Tab, or leave a cell to send.';
    $('camera-foot').textContent=nc+' pending · '+cameras.filter(c=>!c.online).length+' cameras offline';
    $('camera-mode-note').textContent=ui.sendMode==='Manual'?"Expand Iris, Zoom or Focus in the sheet headers to edit each axis.":'Auto send · committed cell edits send to that device. Existing staged edits stay pending.';
    action('review-lan').disabled=!nl;
    root.style.setProperty('--hc-row',ui.density==='Compact'?'37px':'47px');
    root.querySelectorAll('[data-design]').forEach(el=>{el.checked=!!ui[el.dataset.design];});
    root.querySelectorAll('[data-action="send-mode"]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.mode===ui.sendMode)));
    devices.forEach(d=>{
      const group=root.querySelector('[data-controller="'+d.id+'"]');if(!group)return;
      const pending=pendingCameras(d.id).length;
      group.querySelector('[data-controller-pending]').textContent=pending?pending+' pending':'';
      const b=group.querySelector('[data-action="send-controller"]');b.disabled=!pending||!d.online||cameras.some(c=>c.device===d.id&&c.jobs>0);b.querySelector('span').textContent=pending;
      group.querySelector('[data-action="delete-controller"]').disabled=!cameras.some(c=>c.device===d.id&&selectedCameras.has(c.id));
    });
    syncOrganization();
  }
  function paintItem(item){
    root.querySelectorAll('[data-sync-id="'+item.id+'"]').forEach(el=>el.innerHTML=resultMark(item.result));
    const row=root.querySelector('tr[data-id="'+item.id+'"]');
    if(row)row.querySelectorAll('input[data-field],select[data-field]').forEach(el=>el.closest('td').classList.toggle('hc-changed',item.dirty.has(el.dataset.field)));
    syncSummary();icons();
  }
  function inputCell(row,key,value,cls='',disabled=false){return '<input class="hc-cell-input '+cls+'" data-row="'+row.id+'" data-field="'+key+'" value="'+(disabled?'':esc(value))+'" aria-label="'+esc(key+' for '+(device(row.device)?.name||'new row'))+'"'+(disabled?' disabled':'')+'>';}
  function gridHeader(cols,widths){return '<colgroup>'+widths.map(w=>'<col style="width:'+w+'px">').join('')+'</colgroup><thead><tr class="hc-letters">'+cols.map((_,i)=>'<th'+(i===0?' class="hc-num"':'')+'>'+(i===0?'':String.fromCharCode(64+i))+'</th>').join('')+'</tr><tr>'+cols.map((s,i)=>'<th'+(i===0?' class="hc-num"':'')+'>'+s+'</th>').join('')+'</tr></thead>';}
  function emptyRows(cols,start,count=2){return Array.from({length:count},(_,i)=>'<tr class="hc-empty"><td class="hc-num">'+(start+i)+'</td>'+Array(cols-1).fill('<td></td>').join('')+'</tr>').join('');}
  const hiddenCameraColumnsByDevice={};
  let hiddenLanColumns=new Set(['dhcp','gateway','dns1','dns2']);
  const lanColumnDefinitions=[
    {id:'device',label:'Device',width:124},{id:'status',label:'Status',width:76},{id:'iface',label:'Interface',width:83},
    {id:'current',label:'Current address',width:144},{id:'planned',label:'Planned address',width:144},{id:'operation',label:'Operation',width:93},
    {id:'sync',label:'Sync',width:90},{id:'dhcp',label:'DHCP',width:58},{id:'gateway',label:'Gateway',width:135},{id:'dns1',label:'DNS 1',width:135},{id:'dns2',label:'DNS 2',width:135},
  ];
  function cameraColumnSections(){
    return [
      {label:'Camera',fields:[{id:'number',label:'Camera number'},{id:'name',label:'Camera name'},{id:'model',label:'Camera model'},{id:'ip',label:'Camera IP / interface'},{id:'port',label:'Port'},{id:'login',label:'Username'},{id:'password',label:'Password'},{id:'control',label:'Control status'},{id:'sync',label:'Sync status'}]},
      {label:'Lens',fields:[{id:'lens',label:'Lens model'},{id:'connection',label:'Lens connection'}]},
      ...['iris','zoom','focus'].map(axis=>({label:axisName(axis),axis,fields:axisDefinitions[axis]})),
    ];
  }
  function hiddenCameraColumns(id){return hiddenCameraColumnsByDevice[id]||(hiddenCameraColumnsByDevice[id]=new Set());}
  function cameraColumnVisible(id,field){return !hiddenCameraColumns(id).has(field);}
  function cameraColumnMenu(id){
    const hidden=hiddenCameraColumns(id);
    return cameraColumnSections().map(section=>'<section class="hc-column-section"><h4>'+section.label+'</h4>'+section.fields.map(field=>'<label><input type="checkbox" data-column-sheet="camera" data-column-device="'+id+'" data-column-field="'+field.id+'" aria-label="Show '+esc((section.axis?section.label+' ':'')+field.label)+'"'+(!hidden.has(field.id)?' checked':'')+'>'+esc(field.label)+'</label>').join('')+'</section>').join('');
  }
  function renderLanColumnMenu(){
    $('lan-columns-menu').innerHTML='<section class="hc-column-section"><h4>Network columns</h4>'+lanColumnDefinitions.map(field=>'<label><input type="checkbox" data-column-sheet="lan" data-column-field="'+field.id+'" aria-label="Show '+esc(field.label)+'"'+(!hiddenLanColumns.has(field.id)?' checked':'')+'>'+esc(field.label)+'</label>').join('')+'</section>';
  }
  function showColumnMenu(menu){
    root.querySelectorAll('.hc-column-menu').forEach(other=>{if(other!==menu)other.hidden=true;});
    menu.hidden=false;
    menu.style.top='100%';
    const boundary=menu.closest('.hc-controller')||root.querySelector('.hc-window');
    menu.style.maxHeight=Math.min(360,Math.max(120,boundary.getBoundingClientRect().bottom-menu.getBoundingClientRect().top-10))+'px';
  }
  function changeColumnVisibility(el){
    const sheet=el.dataset.columnSheet,id=el.dataset.columnDevice,field=el.dataset.columnField;
    const menu=sheet==='camera'?root.querySelector('[data-columns-for="'+id+'"]'):$('lan-columns-menu'),scroll=menu.scrollTop;
    const hidden=sheet==='camera'?hiddenCameraColumns(id):hiddenLanColumns;
    if(el.checked)hidden.delete(field);else hidden.add(field);
    if(sheet==='camera')renderCameras();else renderLans();
    const nextMenu=sheet==='camera'?root.querySelector('[data-columns-for="'+id+'"]'):$('lan-columns-menu');
    showColumnMenu(nextMenu);nextMenu.scrollTop=scroll;
    nextMenu.querySelector('[data-column-field="'+field+'"]')?.focus({preventScroll:true});remember();
  }
  function restoreColumnVisibility(data){
    const known=new Set(cameraColumnSections().flatMap(section=>section.fields.map(field=>field.id)));
    if(data.hiddenCameraColumnsByDevice&&typeof data.hiddenCameraColumnsByDevice==='object'){
      for(const [id,fields] of Object.entries(data.hiddenCameraColumnsByDevice))if(device(id)&&Array.isArray(fields))hiddenCameraColumnsByDevice[id]=new Set(fields.filter(field=>known.has(field)));
    }else if(data.revision<6){
      devices.forEach(d=>{
        const hidden=hiddenCameraColumns(d.id);
        if(!ui.cameraCore)['model','ip','control'].forEach(field=>hidden.add(field));
        if(!ui.cameraCredentials)['port','login','password'].forEach(field=>hidden.add(field));
        if(!ui.lensColumns)['lens','connection',...Object.values(axisDefinitions).flatMap(fields=>fields.map(field=>field.id))].forEach(field=>hidden.add(field));
      });
    }
    if(Array.isArray(data.hiddenLanColumns)){const knownLan=new Set(lanColumnDefinitions.map(field=>field.id));hiddenLanColumns=new Set(data.hiddenLanColumns.filter(field=>knownLan.has(field)));}
    else if(data.revision<6)hiddenLanColumns=ui.networkAdvanced?new Set():new Set(['dhcp','gateway','dns1','dns2']);
  }
  function renderLans(){
    const filter=$('device-filter').value,rank=new Map(orderedDevices().map((d,i)=>[d.id,i])),rows=lans.filter(l=>filter==='all'||l.device===filter).slice().sort((a,b)=>rank.get(a.device)-rank.get(b.device));
    const fields=lanColumnDefinitions.filter(field=>!hiddenLanColumns.has(field.id));
    let columns=[{id:'row',label:'',width:28},...fields];
    const header=gridHeader(columns.map(field=>field.label),columns.map(field=>field.width));
    $('lan-grid').innerHTML=header+'<tbody>'+rows.map((l,index)=>{
      const d=device(l.device),wan=l.type==='WAN';
      return '<tr data-id="'+l.id+'">'+columns.map(column=>{
        let content='',cls='',attrs=' data-column="'+column.id+'"';
        switch(column.id){
          case 'row':cls='hc-num';content=index+2;break;
          case 'device':cls='hc-frozen';content='<div class="hc-device-cell"><button data-device="'+d.id+'" data-tooltip="'+esc(d.serial)+'">'+esc(ui.serials?d.serial:d.name)+'</button><span class="hc-device-type">'+d.kind+'</span></div>';break;
          case 'status':content=status(d.online);break;
          case 'iface':content=esc(l.iface)+(wan?' <span class="hc-muted">WAN</span>':'');break;
          case 'current':cls='hc-mono hc-muted';attrs+=' data-current="'+l.id+'"';content=esc(l.current||'—');break;
          case 'planned':cls=l.dirty.has('planned')?'hc-changed':'';content=inputCell(l,'planned',l.planned,'hc-mono',wan&&l.dhcp);break;
          case 'operation':content='<select class="hc-cell-input" data-row="'+l.id+'" data-field="operation" aria-label="Operation for '+esc(d.name)+'">'+options(wan?['Keep','Edit']:['Keep','Add','Replace'],l.operation)+'</select>';break;
          case 'sync':attrs+=' data-sync-id="'+l.id+'"';content=resultMark(l.result);break;
          case 'dhcp':content=wan?'<input type="checkbox" data-row="'+l.id+'" data-field="dhcp" aria-label="DHCP for '+esc(d.name)+'"'+(l.dhcp?' checked':'')+'>':'';if(!wan)cls='hc-axis-inactive';break;
          default:content=inputCell(l,column.id,l[column.id],'hc-mono',!wan||l.dhcp);
        }
        return '<td'+attrs+(cls?' class="'+cls+'"':'')+'>'+content+'</td>';
      }).join('')+'</tr>';
    }).join('')+emptyRows(columns.length,rows.length+2,3)+'</tbody>';
    renderLanColumnMenu();syncSummary();icons();
  }
  const axisGroupsByDevice={};
  const axisDefinitions={
    iris:[{id:'irisMotor',label:'Motor ID',width:66},{id:'irisMin',label:'Open',width:65},{id:'irisMax',label:'Closed',width:65},{id:'irisTorque',label:'Torque',width:65},{id:'irisDirection',label:'Direction',width:85}],
    zoom:[{id:'zoomMotor',label:'Motor ID',width:66},{id:'zoomTorque',label:'Torque',width:65},{id:'zoomDirection',label:'Direction',width:85}],
    focus:[{id:'focusMotor',label:'Motor ID',width:66},{id:'focusTorque',label:'Torque',width:65},{id:'focusDirection',label:'Direction',width:85}],
  };
  const axisName=axis=>axis[0].toUpperCase()+axis.slice(1);
  function axisGroups(deviceId){return axisGroupsByDevice[deviceId]||(axisGroupsByDevice[deviceId]={iris:false,zoom:false,focus:false});}
  function initializeLensFields(camera){
    const defaults={irisMotor:'3',zoomMotor:'5',focusMotor:'2',irisMin:'1.6',irisMax:'32',irisTorque:'2',zoomTorque:'2',focusTorque:'2',irisDirection:'left',zoomDirection:'left',focusDirection:'left',lensIp:''};
    for(const [field,value] of Object.entries(defaults))if(camera[field]===undefined)camera[field]=value;
  }
  function lensCapabilities(camera){const torque=camera.lens==='ARRI - cforce'||camera.lens==='cmotion cGate',motor=camera.lens==='Tilta - Nucleus-M';return {torque,direction:torque,motor,iris:torque||motor,ip:camera.lens==='cmotion cGate',port:camera.lens!=='None'&&camera.lens!=='cmotion cGate'};}
  function lensFieldUsed(camera,field){
    const p=lensCapabilities(camera);
    if(field==='lensIp')return p.ip;if(field==='lensPort')return p.port;
    if(field.endsWith('Motor'))return p.motor;
    if(field.endsWith('Torque'))return p.torque;
    if(field.endsWith('Direction'))return p.direction;
    if(field==='irisMin'||field==='irisMax')return p.iris;
    return true;
  }
  function isLensSetting(field){return ['lensIp','lensPort','irisMin','irisMax'].includes(field)||/^(iris|zoom|focus)(Motor|Torque|Direction)$/.test(field);}
  function axisSummary(camera,axis){
    const p=lensCapabilities(camera);
    if(axis==='iris'&&p.iris)return camera.irisMin+'–'+camera.irisMax;
    if(p.motor)return 'Motor '+camera[axis+'Motor'];
    if(p.torque)return 'T'+camera[axis+'Torque']+' '+(camera[axis+'Direction']==='left'?'Left':'Right');
    return '';
  }
  function lensParameters(camera){
    const p=lensCapabilities(camera);if(!p.iris)return '';
    if(p.motor)return camera.irisMotor+':I:'+camera.irisMin+':'+camera.irisMax+','+camera.zoomMotor+':Z,'+camera.focusMotor+':F';
    return camera.irisMin+':'+camera.irisMax+':iris:'+camera.irisTorque+':'+camera.irisDirection+',zoom:'+camera.zoomTorque+':'+camera.zoomDirection+',focus:'+camera.focusTorque+':'+camera.focusDirection;
  }
  function cameraGrid(rows,deviceId){
    const groups=axisGroups(deviceId);
    let columns=[{id:'row',label:'',width:26,frozen:0},{id:'selected',label:'<input type="checkbox" data-action="select-controller-cameras" aria-label="Select cameras in this sheet">',width:24,frozen:26},{id:'number',label:'#',width:28,frozen:50},{id:'name',label:'Camera name',width:100,frozen:78}];
    columns.push({id:'model',label:'Camera model',width:120},{id:'ip',label:'Camera IP / interface',width:142});
    columns.push({id:'port',label:'Port',width:55},{id:'login',label:'Username',width:96},{id:'password',label:'Password',width:114});
    columns.push({id:'control',label:'Control',width:72});
    columns.push({id:'lens',label:'Lens model',width:126},{id:'connection',label:'Lens connection',width:100});
    for(const axis of ['iris','zoom','focus']){
      const childFields=axisDefinitions[axis].filter(field=>cameraColumnVisible(deviceId,field.id));
      if(!childFields.length)continue;
      if(groups[axis])columns.push(...childFields.map(field=>({...field,group:axis})));
      else columns.push({id:axis+'Summary',label:axisName(axis),width:78,group:axis,summary:true});
    }
    columns.push({id:'sync',label:'Sync',width:70});
    columns=columns.filter(column=>column.id==='row'||column.id==='selected'||column.summary||cameraColumnVisible(deviceId,column.id));
    let frozenLeft=0;for(const column of columns)if(column.frozen!==undefined){column.frozen=frozenLeft;frozenLeft+=column.width;}
    const anyExpanded=columns.some(column=>column.group&&!column.summary),span=anyExpanded?2:1;
    const frozenAttr=column=>column.frozen===undefined?'':' class="hc-camera-frozen'+(column.id==='row'?' hc-num':'')+'" style="left:'+column.frozen+'px"';
    let top='',second='';
    for(let index=0;index<columns.length;index++){
      const column=columns[index];
      if(column.group){
        if(index===0||columns[index-1].group!==column.group){const count=columns.filter(c=>c.group===column.group).length;top+='<th class="hc-axis-header" data-axis-header="'+column.group+'" '+(groups[column.group]?'colspan="'+count+'"':'rowspan="'+span+'"')+'><button data-action="toggle-axis" data-axis="'+column.group+'" data-id="'+deviceId+'" aria-expanded="'+groups[column.group]+'" aria-label="'+(groups[column.group]?'Collapse ':'Expand ')+axisName(column.group)+' columns">'+icon(groups[column.group]?'chevron-down':'chevron-right')+axisName(column.group)+'</button></th>';}
        if(groups[column.group])second+='<th class="hc-axis-child" data-field-header="'+column.id+'">'+column.label+'</th>';
      }else top+='<th rowspan="'+span+'"'+frozenAttr(column)+'>'+column.label+'</th>';
    }
    const letters='<tr class="hc-letters">'+columns.map((c,i)=>'<th'+frozenAttr(c)+'>'+(i===0?'':String.fromCharCode(64+i))+'</th>').join('')+'</tr>';
    const header='<colgroup>'+columns.map(c=>'<col style="width:'+c.width+'px">').join('')+'</colgroup><thead>'+letters+'<tr>'+top+'</tr>'+(anyExpanded?'<tr>'+second+'</tr>':'')+'</thead>';
    function selectCell(camera,field,list,disabled=false){return '<select class="hc-cell-input" data-row="'+camera.id+'" data-field="'+field+'" aria-label="'+esc(field+' for camera '+camera.number)+'"'+(disabled?' disabled':'')+'>'+(disabled?'<option value=""></option>':options(list,camera[field]))+'</select>';}
    function cell(camera,column,index){
      const p=lensCapabilities(camera),field=column.id,changed=camera.dirty.has(field),inactive=isLensSetting(field)&&!lensFieldUsed(camera,field);
      let content='',attrs=' data-column="'+field+'"',classes=[];
      if(column.frozen!==undefined){classes.push('hc-camera-frozen');attrs+=' style="left:'+column.frozen+'px"';}
      if(changed)classes.push('hc-changed');if(inactive)classes.push('hc-axis-inactive');
      if(field==='row'){classes.push('hc-num');content=index+2;}
      else if(field==='selected'){classes.push('hc-check');content='<input type="checkbox" data-select-camera="'+camera.id+'" aria-label="Select camera '+esc(camera.number)+' on '+esc(device(camera.device).name)+'"'+(selectedCameras.has(camera.id)?' checked':'')+'>';}
      else if(field==='number'||field==='name')content=inputCell(camera,field,camera[field]);
      else if(field==='model')content=selectCell(camera,field,['Choose model…','Venice-IP','Alpha-USB','Alpha-IP','Sony FX6','Sony FX9','Sony FR7']);
      else if(field==='ip')content=camera.model==='Alpha-USB'?selectCell(camera,'usb',['USB · Automatic','USB · FX3A 00421']):inputCell(camera,'ip',camera.ip,'hc-mono');
      else if(field==='control')content=status(camera.online);
      else if(field==='lens')content=selectCell(camera,field,lensModels);
      else if(field==='connection'){
        if(p.ip)content=inputCell(camera,'lensIp',camera.lensIp,'hc-mono');
        else content=selectCell(camera,'lensPort',camera.lens==='ARRI - cforce'?['None','USB · CAN adapter']:['None','RIO 01 : 1','RIO 01 : 2','RIO 02 : 1','RIO 02 : 2','USB · Serial converter'],!p.port);
        if(!p.ip&&!p.port)classes.push('hc-axis-inactive');
      }
      else if(column.summary){classes.push('hc-axis-summary');if(!p.iris)classes.push('hc-axis-inactive');content=esc(axisSummary(camera,column.group));}
      else if(field.endsWith('Torque'))content=selectCell(camera,field,['1','2','3','4'],inactive);
      else if(field.endsWith('Direction'))content=selectCell(camera,field,[{id:'left',label:'Left'},{id:'right',label:'Right'}],inactive);
      else if(isLensSetting(field))content=inputCell(camera,field,camera[field],'hc-mono',inactive);
      else if(['port','login','password'].includes(field))content=inputCell(camera,field,camera[field],field==='port'?'hc-mono':'',camera.model==='Alpha-USB');
      else if(field==='sync'){attrs+=' data-sync-id="'+camera.id+'"';content=resultMark(camera.result);}
      return '<td'+attrs+(classes.length?' class="'+classes.join(' ')+'"':'')+'>'+content+'</td>';
    }
    return header+'<tbody>'+rows.map((camera,index)=>{initializeLensFields(camera);return '<tr data-id="'+camera.id+'"'+(selectedCameras.has(camera.id)?' class="hc-row-selected"':'')+'>'+columns.map(column=>cell(camera,column,index)).join('')+'</tr>';}).join('')+emptyRows(columns.length,rows.length+2,1)+'</tbody>';
  }
  function renderCameras(){
    const scrolls=new Map([...root.querySelectorAll('[data-controller]')].map(el=>[el.dataset.controller,el.querySelector('.hc-scroll')?.scrollLeft||0]));
    $('controllers').innerHTML=orderedDevices().map(d=>{
      const rows=cameras.filter(c=>c.device===d.id),open=openControllers.has(d.id),selection=cellSelections.get(d.id)||['C2',rows[0]?.name||''];
      return '<section class="hc-controller" data-controller="'+d.id+'"><div class="hc-controller-header"><button class="hc-controller-handle" draggable="true" data-reorder-handle="'+d.id+'" aria-label="Reorder '+esc(d.name)+'" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" data-tooltip="Drag to reorder; Alt + up/down also moves this device">'+icon('grip-vertical')+'</button><button class="hc-controller-expander" data-action="toggle-controller" data-id="'+d.id+'" aria-expanded="'+open+'" aria-controls="hc-controller-'+d.id+'">'+icon(open?'chevron-down':'chevron-right')+'<strong>'+esc(d.name)+'</strong><span class="hc-device-type">'+d.kind+'</span><span class="hc-controller-serial">'+esc(d.serial)+'</span></button><span class="hc-controller-camera-count">'+rows.length+' camera'+(rows.length===1?'':'s')+'</span>'+status(d.online)+'<span class="hc-controller-pending" data-controller-pending></span></div><div id="hc-controller-'+d.id+'"'+(!open?' hidden':'')+'><div class="hc-controller-tools"><select data-new-camera="'+d.id+'" aria-label="Add camera to '+esc(d.name)+'"><option value="">+ Add camera…</option><option value="Venice-IP">Sony · Venice-IP</option><option value="Alpha-USB">Sony · Alpha-USB</option><option value="Alpha-IP">Sony · Alpha-IP</option><option value="Choose model…">Blank camera row</option></select><button class="hc-danger" data-action="delete-controller" data-id="'+d.id+'" disabled>'+icon('trash-2')+'Delete selected</button><span class="hc-right"></span><button data-action="camera-columns" data-id="'+d.id+'">'+icon('columns-3')+'Columns</button><button class="hc-button" data-action="send-controller" data-id="'+d.id+'">'+icon('send')+'Send changes <span>0</span></button><div class="hc-column-menu" data-columns-for="'+d.id+'" hidden>'+cameraColumnMenu(d.id)+'</div></div><div class="hc-sheet"><div class="hc-formula"><span class="hc-address" data-formula-address="'+d.id+'">'+esc(selection[0])+'</span><span class="hc-fx">fx</span><span class="hc-formula-value" data-formula-value="'+d.id+'">'+esc(selection[1])+'</span></div><div class="hc-scroll"><table class="hc-grid" data-camera-device="'+d.id+'" aria-label="Camera and lens spreadsheet for '+esc(d.name)+'">'+cameraGrid(rows,d.id)+'</table></div><div class="hc-sheet-tabs"><span class="hc-sheet-tab">'+esc(d.name)+' cameras</span><span class="hc-sheet-caption">'+esc(d.alias||d.base)+'</span></div></div><div class="hc-controller-bottom"><span>Camera &amp; lens settings</span><span>'+esc(d.online?'Connected at '+d.base:'Offline · edits stay pending')+'</span></div></div></section>';
    }).join('');syncSummary();icons();
    for(const [id,left] of scrolls){const scroll=root.querySelector('[data-controller="'+id+'"] .hc-scroll');if(scroll)scroll.scrollLeft=left;}
  }
  function setTab(next,save=true){tab=next;root.querySelectorAll('[data-tab]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.tab===next)));for(const id of ['devices','discovery','cameras'])root.querySelector('#hc-'+id).hidden=id!==next;$('lan-columns-menu').hidden=true;$('drawer').hidden=true;if(save)remember();}
  function showDevice(id){
    const d=device(id);if(!d)return;
    $('drawer').innerHTML='<div class="hc-drawer-head"><div><h3>'+esc(d.name)+'</h3><span class="hc-mono hc-muted">'+esc(d.serial)+'</span></div><button data-action="close-drawer" aria-label="Close details">'+icon('x')+'</button></div><div class="hc-detail-section"><h4>DEVICE STATUS</h4><div class="hc-detail-line"><span>Connection</span>'+status(d.online)+'</div><div class="hc-detail-line"><span>LAN1 link</span><span>'+(d.online?'Up':'Unknown')+'</span></div></div><div class="hc-detail-section"><h4>MANAGEMENT ADDRESS</h4><div class="hc-address-item"><div class="hc-mono">'+esc(d.base)+'/16<small>LAN1 · built-in</small></div><span class="hc-retained">'+icon('lock-keyhole')+'Protected</span></div></div><div class="hc-detail-section"><h4>CONFIGURABLE ADDRESSES</h4>'+lans.filter(l=>l.device===id).map(l=>'<div class="hc-address-item"><div class="hc-mono">'+esc(l.current||'Not assigned')+'<small>'+esc(l.iface+' · '+l.type)+'</small></div>'+resultMark(l.result)+'</div>').join('')+'</div><div class="hc-detail-section"><button class="hc-button" data-action="device-cameras" data-id="'+id+'" style="width:100%">Open camera &amp; lens sheet '+icon('arrow-right')+'</button></div>';$('drawer').hidden=false;icons();
  }
  const ipv4=s=>/^\d{1,3}(\.\d{1,3}){3}$/.test(s)&&s.split('.').every(x=>Number(x)<=255);
  function valid(item,kind){
    if(!device(item.device)?.online)return 'Offline · unsent';
    if(kind==='lan'){if(item.dhcp&&item.type==='WAN')return '';const parts=String(item.planned).split('/');return parts.length===2&&ipv4(parts[0])&&/^\d{1,2}$/.test(parts[1])&&Number(parts[1])<=32?'':'Invalid IP';}
    if(!item.number||!item.name||item.model==='Choose model…')return 'Incomplete';
    if(item.model!=='Alpha-USB'&&!ipv4(item.ip))return 'Incomplete';
    initializeLensFields(item);const p=lensCapabilities(item);
    if(p.iris&&(!(Number(item.irisMin)>0)||!(Number(item.irisMax)>Number(item.irisMin))))return 'Incomplete';
    if(p.motor){const ids=[item.irisMotor,item.zoomMotor,item.focusMotor];if(ids.some(id=>!/^\d+$/.test(id)||Number(id)<1)||new Set(ids.map(Number)).size!==3)return 'Incomplete';}
    if(p.ip&&!ipv4(item.lensIp))return 'Incomplete';return '';
  }
  function sendItems(items,kind,deleting=false,fields=null){
    const accepted=[];
    items.forEach(item=>{const error=deleting?'':valid(item,kind);if(error){item.result=error;paintItem(item);}else accepted.push(item);});
    if(!accepted.length){toast('Complete the pending rows before sending');return;}
    accepted.forEach(item=>{
      const captured={...item},sentFields=(fields||[...item.dirty]).filter(field=>kind==='lan'||!isLensSetting(field)||lensFieldUsed(item,field)),revision=item.revision;
      if(!sentFields.length&&!deleting)return;
      item.jobs++;item.result='Queued';paintItem(item);
      const previous=deviceQueues.get(item.device)||Promise.resolve();
      const next=previous.catch(()=>{}).then(async()=>{
        item.result='Sending';paintItem(item);await sleep(350);item.result='Verifying';paintItem(item);await sleep(400);
        if(deleting){cameras=cameras.filter(c=>c.id!==item.id);selectedCameras.delete(item.id);renderCameras();}
        else{
          if(kind==='lan'&&sentFields.some(f=>['planned','dhcp'].includes(f))){item.current=captured.planned;const td=root.querySelector('[data-current="'+item.id+'"]');if(td)td.textContent=item.current;if(item.type==='LAN')device(item.device).alias=captured.planned.split('/')[0];}
          sentFields.forEach(field=>{if(item[field]===captured[field])item.dirty.delete(field);});
          if(item.isNew&&revision===item.revision){item.dirty.clear();item.isNew=false;}
          item.pending=item.dirty.size>0;item.result=item.pending?'Pending':'Verified';
        }
        item.jobs--;paintItem(item);
      });
      deviceQueues.set(item.device,next);next.catch(()=>{item.jobs=Math.max(0,item.jobs-1);item.result='Error';paintItem(item);});
    });
    remember();
  }
  function showReview(items,kind,deleting=false){
    if(!items.length)return;reviewItems=items.map(i=>i.id);
    const title=deleting?'Delete cameras from device':kind==='lan'?'Send LAN changes':'Send camera changes';
    $('modal-layer').innerHTML='<section class="hc-modal" role="dialog" aria-modal="true" aria-labelledby="hc-review-title"><div class="hc-modal-head"><div><h3 id="hc-review-title">'+title+'</h3><p>'+items.length+' '+(deleting?'camera':'change')+(items.length===1?'':'s')+' · '+new Set(items.map(i=>i.device)).size+' devices</p></div><button data-action="close-modal" aria-label="Close">'+icon('x')+'</button></div><div class="hc-modal-body">'+items.map(item=>'<div class="hc-change-item"><div><strong>'+esc(device(item.device).name)+(kind==='camera'?' · Camera '+esc(item.number):'')+'</strong><span class="hc-caption">'+esc(deleting?'Delete':kind==='lan'?item.operation:item.isNew?'Create':'Update')+'</span></div>'+(kind==='lan'?'<div class="hc-diff hc-mono"><span class="hc-before">'+esc(item.current||'Not assigned')+'</span>'+icon('arrow-right')+'<span class="hc-after">'+esc(item.planned)+'</span></div><small>Management retained · '+esc(device(item.device).base)+'</small>':'<div>'+esc(item.name)+'</div><small>'+esc(item.model+(item.lens!=='None'?' · '+item.lens+' / '+item.lensPort:''))+'</small>')+'</div>').join('')+'</div><div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button><button class="'+(deleting?'hc-button hc-danger':'hc-primary')+'" data-action="confirm-send" data-kind="'+kind+'" data-delete="'+deleting+'">'+(deleting?'Delete selected cameras':'Send '+items.length+' changes')+'</button></div></section>';$('modal-layer').hidden=false;icons();
  }
  function addCamera(id,model){
    const nums=cameras.filter(c=>c.device===id).map(c=>Number(c.number));
    const c={id:'new-camera-'+Date.now(),device:id,number:String(Math.max(0,...nums)+1),name:'New camera',model,ip:'',lens:'None',lensPort:'None',online:false,pending:true,result:model==='Alpha-USB'?'Pending':'Incomplete',port:model==='Alpha-USB'?'':'80',login:model==='Alpha-USB'?'':'admin',password:'',isNew:true,dirty:new Set(['number','name','model','ip','lens','lensPort']),revision:0,jobs:0};
    cameras.push(c);openControllers.add(id);renderCameras();if(ui.sendMode==='Auto send'&&!valid(c,'camera'))sendItems([c],'camera');toast('Camera row added to '+device(id).name);remember();
  }
  function addLan(){const id=$('device-filter').value==='all'?'rio1':$('device-filter').value;lans.push({id:'new-lan-'+Date.now(),device:id,type:'LAN',iface:'LAN1',current:'',planned:'',operation:'Add',pending:true,result:'Incomplete',dhcp:false,gateway:'',dns1:'',dns2:'',dirty:new Set(['planned']),revision:0,jobs:0});renderLans();remember();}
  function renderResults(){
    const countNew=results.filter(r=>!devices.some(d=>d.serial===r.serial)).length;$('found-count').textContent=results.length+' found · '+countNew+' new';
    if(results.length)$('discovery-results').innerHTML='<table class="hc-results-table" aria-label="Discovered devices"><thead><tr><th></th><th>Device</th><th>Reachable addresses</th><th>Status</th><th>Managed list</th></tr></thead><tbody>'+results.map(r=>{const added=devices.some(d=>d.serial===r.serial);return '<tr><td><input type="checkbox" data-select-found="'+r.id+'" aria-label="Select '+esc(r.serial)+'"'+(added?' disabled':selectedResults.has(r.id)?' checked':'')+'></td><td>'+esc(r.name)+'<small class="hc-mono">'+esc(r.serial)+'</small></td><td class="hc-mono">'+esc(r.base)+(r.alias?'<small class="hc-mono">'+esc(r.alias)+'</small>':'')+'</td><td>'+status(true)+'</td><td><span class="hc-collection-state">'+(added?'Added':'Not added')+'</span></td></tr>';}).join('')+'</tbody></table>';
    const selected=results.filter(r=>selectedResults.has(r.id)&&!devices.some(d=>d.serial===r.serial)).length;$('found-selected').textContent=selected;action('add-discovered').disabled=!selected;
  }
  function startScan(){
    if(scanTimer)return;const range=$('scan-range').value==='custom'?$('custom-range').value.trim():$('scan-range').value;
    const parts=range.split('/');if(!ipv4(parts[0])||!/^\d{1,2}$/.test(parts[1]||'')||Number(parts[1])<16||Number(parts[1])>32){$('discovery-error').textContent='Enter a range such as 10.20.101.0/24.';$('discovery-error').hidden=false;return;}
    $('discovery-error').hidden=true;
    const candidates=[...devices.filter(d=>['rcp1','rio1','rio2'].includes(d.id)),{id:'rcp3',name:'RCP 03',kind:'RCP',serial:'CY-RCP-10-56',base:'10.192.10.56',alias:'10.20.101.202',online:true},{id:'rio4',name:'RIO 04',kind:'RIO',serial:'CY-RIO-62-21',base:'10.192.62.21',alias:'10.20.101.111',online:true}].map(d=>({...d,base:range.startsWith('10.20')?(d.alias||d.base):d.base,alias:range.startsWith('10.20')?d.base:d.alias}));
    let tick=0;const total=Math.max(1,2**(32-Number(parts[1]))-(Number(parts[1])<31?2:0));results=[];selectedResults.clear();action('scan').disabled=true;action('stop-scan').hidden=false;$('scan-label').textContent='Scanning '+range;$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>Looking for Cyanview devices…</strong></div>';
    scanTimer=setInterval(()=>{tick++;const percent=Math.min(tick*10,100);$('scan-progress').style.width=percent+'%';root.querySelector('.hc-progress').setAttribute('aria-valuenow',String(percent));$('scan-addresses').textContent=Math.round(total*percent/100).toLocaleString()+' / '+total.toLocaleString();results=candidates.slice(0,Math.min(5,Math.ceil(tick/2)));results.forEach(r=>{if(!devices.some(d=>d.serial===r.serial))selectedResults.add(r.id);});renderResults();if(percent===100){clearInterval(scanTimer);scanTimer=null;action('scan').disabled=false;action('stop-scan').hidden=true;$('scan-label').textContent='Scan complete · '+range;remember();}},240);
  }
  function addResults(){let count=0;for(const r of results)if(selectedResults.has(r.id)&&!devices.some(d=>d.serial===r.serial)){const d={...r};if(d.base.startsWith('10.20.')&&d.alias.startsWith('10.192.')){const before=d.base;d.base=d.alias;d.alias=before;}devices.push(d);count++;lans.push({id:'lan-'+d.id,device:d.id,type:'LAN',iface:'LAN1',current:d.alias?d.alias+'/16':'',planned:d.alias?d.alias+'/16':'',operation:'Keep',pending:false,result:'In sync',dhcp:false,gateway:'',dns1:'',dns2:'',dirty:new Set(),revision:0,jobs:0});}selectedResults.clear();syncFilter();renderResults();renderLans();renderCameras();toast(count+' devices added');remember();}
  function probeIP(){const ip=$('manual-ip').value.trim();if(!ipv4(ip)){$('discovery-error').textContent='Enter a valid IPv4 address.';$('discovery-error').hidden=false;return;}$('discovery-error').hidden=true;const existing=devices.find(d=>d.base===ip||d.alias===ip),parts=ip.split('.'),candidate=existing||{id:'manual-'+parts.join('-'),name:'RCP '+String(devices.filter(d=>d.kind==='RCP').length+1).padStart(2,'0'),kind:'RCP',serial:'CY-RCP-'+parts.slice(2).join('-'),base:ip,alias:'',online:true};if(!results.some(r=>r.serial===candidate.serial))results.push({...candidate});if(!existing)selectedResults.add(candidate.id);$('scan-label').textContent='Device lookup complete · '+ip;renderResults();remember();}
  function commitCell(el){
    const isLan=el.closest('table')===$('lan-grid'),collection=isLan?lans:cameras,item=collection.find(r=>r.id===el.dataset.row);if(!item)return;
    if(!isLan&&isLensSetting(el.dataset.field)&&!lensFieldUsed(item,el.dataset.field))return;
    const field=el.dataset.field;item[field]=el.type==='checkbox'?el.checked:el.value;item.revision++;item.dirty.add(field);item.pending=true;item.result='Pending';
    const fields=[field];
    if(!isLan&&field==='lens'){initializeLensFields(item);for(const dirty of [...item.dirty])if(isLensSetting(dirty)&&!lensFieldUsed(item,dirty))item.dirty.delete(dirty);}
    if(isLan){if(field==='dhcp'){item.planned=el.checked?'DHCP':'';item.operation='Edit';item.dirty.add('planned');fields.push('planned');}else if(item.operation==='Keep'&&field!=='operation')item.operation=item.current?'Replace':'Add';if(field==='operation'&&item.operation==='Keep'){item.planned=item.current;item.dirty.clear();item.pending=false;item.result='In sync';renderLans();remember();return;}}
    else if(field==='lens'&&item.lens==='None'){item.lensPort='None';item.dirty.add('lensPort');fields.push('lensPort');}
    if((isLan&&['dhcp','operation'].includes(field))||(!isLan&&['model','lens'].includes(field))){if(isLan)renderLans();else renderCameras();}else paintItem(item);
    if(ui.sendMode==='Auto send')sendItems([item],isLan?'lan':'camera',false,item.isNew?[...item.dirty]:fields);
    remember();
  }
  function updateDesign(){renderLans();renderCameras();remember();}
  function restore(snapshot){const data=snapshot?.privateContent;if(!data||![2,3,4,5,6].includes(data.revision))return;if(data.ui)for(const k of Object.keys(ui))if(typeof data.ui[k]===typeof ui[k])ui[k]=data.ui[k];if(data.revision<5){ui.cameraCore=true;ui.cameraCredentials=true;}restoreColumnVisibility(data);if(data.axisGroupsByDevice&&typeof data.axisGroupsByDevice==='object'){for(const [id,groups] of Object.entries(data.axisGroupsByDevice)){if(!device(id)||!groups||typeof groups!=='object')continue;for(const axis of ['iris','zoom','focus'])if(typeof groups[axis]==='boolean')axisGroups(id)[axis]=groups[axis];}}if(Array.isArray(data.deviceOrder)){const known=new Set(devices.map(d=>d.id));deviceOrder=[...new Set(data.deviceOrder.filter(id=>known.has(id)))];devices.forEach(d=>{if(!deviceOrder.includes(d.id))deviceOrder.push(d.id);});}if(Array.isArray(data.openControllers)){openControllers.clear();data.openControllers.forEach(id=>{if(device(id))openControllers.add(id);});}if(['devices','discovery','cameras'].includes(data.tab))setTab(data.tab,false);if(['','10.192.0.0/16','10.20.0.0/16','custom'].includes(data.scanRange))$('scan-range').value=data.scanRange;$('custom-range-field').hidden=$('scan-range').value!=='custom';action('scan').disabled=!$('scan-range').value;syncFilter();renderLans();renderCameras();}
  root.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b||!root.contains(b))return;
    if(b.dataset.tab){setTab(b.dataset.tab);return;}if(b.dataset.device){showDevice(b.dataset.device);return;}
    switch(b.dataset.action){
      case 'send-mode':ui.sendMode=b.dataset.mode;syncSummary();toast(ui.sendMode==='Auto send'?'Auto send enabled · existing edits remain staged':'Manual mode · use Send changes');remember();break;
      case 'toggle-all-controllers':{const ordered=orderedDevices(),allOpen=ordered.every(d=>openControllers.has(d.id));if(allOpen)openControllers.clear();else ordered.forEach(d=>openControllers.add(d.id));renderCameras();remember();break;}
      case 'toggle-axis':{const groups=axisGroups(b.dataset.id);groups[b.dataset.axis]=!groups[b.dataset.axis];renderCameras();const header=root.querySelector('[data-controller="'+b.dataset.id+'"] [data-action="toggle-axis"][data-axis="'+b.dataset.axis+'"]');header?.scrollIntoView({block:'nearest',inline:'nearest'});remember();break;}
      case 'toggle-controller':if(openControllers.has(b.dataset.id))openControllers.delete(b.dataset.id);else openControllers.add(b.dataset.id);renderCameras();remember();break;
      case 'send-controller':sendItems(pendingCameras(b.dataset.id),'camera');break;
      case 'delete-controller':showReview(cameras.filter(c=>c.device===b.dataset.id&&selectedCameras.has(c.id)),'camera',true);break;
      case 'review-lan':showReview(pendingLans(),'lan');break;
      case 'camera-columns':{const menu=root.querySelector('[data-columns-for="'+b.dataset.id+'"]');if(menu.hidden)showColumnMenu(menu);else menu.hidden=true;break;}
      case 'lan-columns':{const menu=$('lan-columns-menu');if(menu.hidden)showColumnMenu(menu);else menu.hidden=true;break;}
      case 'close-modal':$('modal-layer').hidden=true;break;
      case 'confirm-send':{const kind=b.dataset.kind,items=(kind==='lan'?lans:cameras).filter(i=>reviewItems.includes(i.id));$('modal-layer').hidden=true;sendItems(items,kind,b.dataset.delete==='true');break;}
      case 'close-drawer':$('drawer').hidden=true;break;
      case 'device-cameras':openControllers.add(b.dataset.id);setTab('cameras');renderCameras();break;
      case 'add-lan':addLan();break;
      case 'add-ip':setTab('discovery');$('manual-ip').focus();break;
      case 'scan':startScan();break;
      case 'stop-scan':if(scanTimer)clearInterval(scanTimer);scanTimer=null;action('scan').disabled=false;action('stop-scan').hidden=true;$('scan-label').textContent='Scan stopped · partial results';break;
      case 'add-discovered':addResults();break;
      case 'probe-ip':probeIP();break;
      case 'refresh-all':action('refresh-all').disabled=true;setTimeout(()=>{action('refresh-all').disabled=false;toast('Status refreshed · edits retained');},500);break;
    }
  });
  root.addEventListener('dragstart',event=>{const handle=event.target.closest('[data-reorder-handle]');if(!handle||!root.contains(handle))return;draggedDevice=handle.dataset.reorderHandle;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedDevice);handle.closest('[data-controller]').dataset.dragging='true';});
  root.addEventListener('dragover',event=>{const group=event.target.closest('[data-controller]');if(!draggedDevice||!group)return;event.preventDefault();event.dataTransfer.dropEffect='move';root.querySelectorAll('[data-drop]').forEach(el=>delete el.dataset.drop);if(group.dataset.controller!==draggedDevice){const rect=group.querySelector('.hc-controller-header').getBoundingClientRect();group.dataset.drop=event.clientY>rect.top+rect.height/2?'after':'before';}});
  root.addEventListener('drop',event=>{const group=event.target.closest('[data-controller]');if(!draggedDevice||!group)return;event.preventDefault();const source=draggedDevice,target=group.dataset.controller,rect=group.querySelector('.hc-controller-header').getBoundingClientRect(),after=event.clientY>rect.top+rect.height/2;clearDrag();dropDevice(source,target,after);});
  root.addEventListener('dragend',clearDrag);
  root.addEventListener('keydown',event=>{const handle=event.target.closest('[data-reorder-handle]');if(event.key==='Escape')clearDrag();if(handle&&event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();moveDevice(handle.dataset.reorderHandle,event.key==='ArrowUp'?'up':'down');}});
  root.addEventListener('focusin',event=>{const el=event.target;if(!el.dataset?.row)return;const table=el.closest('table'),row=el.closest('tr'),cell=el.closest('td');if(!table||!row||!cell)return;const address=String.fromCharCode(64+cell.cellIndex)+(Array.from(row.parentNode.children).indexOf(row)+2);if(table===$('lan-grid')){$('lan-address').textContent=address;$('lan-value').textContent=el.value;}else{const id=table.dataset.cameraDevice;cellSelections.set(id,[address,el.value]);root.querySelector('[data-formula-address="'+id+'"]').textContent=address;root.querySelector('[data-formula-value="'+id+'"]').textContent=el.value;}});
  root.addEventListener('input',event=>{const el=event.target;if(!el.dataset?.row||el.type==='checkbox')return;const isLan=el.closest('table')===$('lan-grid'),item=(isLan?lans:cameras).find(i=>i.id===el.dataset.row);if(!item)return;if(!isLan&&isLensSetting(el.dataset.field)&&!lensFieldUsed(item,el.dataset.field))return;item[el.dataset.field]=el.value;item.dirty.add(el.dataset.field);item.pending=true;item.result='Pending';if(isLan){$('lan-value').textContent=el.value;if(item.operation==='Keep')item.operation=item.current?'Replace':'Add';}else{const id=item.device;root.querySelector('[data-formula-value="'+id+'"]').textContent=el.value;}paintItem(item);});
  root.addEventListener('change',event=>{const el=event.target;if(el.dataset.columnSheet){changeColumnVisibility(el);return;}if(el.dataset.design){ui[el.dataset.design]=el.checked;updateDesign();return;}if(el.dataset.newCamera){if(el.value)addCamera(el.dataset.newCamera,el.value);return;}if(el===$('device-filter')){renderLans();remember();return;}if(el===$('scan-range')){$('custom-range-field').hidden=el.value!=='custom';action('scan').disabled=!el.value;remember();return;}if(el.dataset.selectCamera){if(el.checked)selectedCameras.add(el.dataset.selectCamera);else selectedCameras.delete(el.dataset.selectCamera);el.closest('tr').classList.toggle('hc-row-selected',el.checked);syncSummary();return;}if(el.dataset.action==='select-controller-cameras'){const id=el.closest('[data-controller]').dataset.controller;cameras.filter(c=>c.device===id).forEach(c=>{if(el.checked)selectedCameras.add(c.id);else selectedCameras.delete(c.id);});renderCameras();return;}if(el.dataset.selectFound){if(el.checked)selectedResults.add(el.dataset.selectFound);else selectedResults.delete(el.dataset.selectFound);renderResults();return;}if(el.dataset.row&&el.dataset.field)commitCell(el);});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){$('modal-layer').hidden=true;$('drawer').hidden=true;$('lan-columns-menu').hidden=true;root.querySelectorAll('[data-columns-for]').forEach(el=>el.hidden=true);}if(event.target.dataset?.row&&event.key==='Enter'){event.preventDefault();event.target.blur();return;}if(event.target===$('manual-ip')&&event.key==='Enter'){event.preventDefault();probeIP();return;}if(event.target.closest('[role="tablist"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=Array.from(root.querySelectorAll('[data-tab]'));let i=tabs.findIndex(b=>b.dataset.tab===tab);i=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;setTab(tabs[i].dataset.tab);tabs[i].focus();}});
  syncFilter();renderLans();renderCameras();setTab('cameras',false);restore(window.openai?.widgetState);
  window.addEventListener('openai:set_globals',event=>{const snapshot=event.detail?.globals?.widgetState;if(snapshot&&JSON.stringify(snapshot.privateContent)!==lastSavedPrivateContent)restore(snapshot);});
  if(globalThis.Tweak){const tweak=new globalThis.Tweak({container:root,onChange:updateDesign});tweak.addSelect(ui,'density',{label:'Row density',options:['Compact','Comfortable']});tweak.addToggle(ui,'serials',{label:'Use full device serials'});}
})();
