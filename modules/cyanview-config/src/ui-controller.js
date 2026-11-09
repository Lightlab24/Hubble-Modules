import { createSpreadsheetContextMenu, mountSpreadsheetControls, mountSpreadsheetColumnGroup, mountSpreadsheetResize, mountSpreadsheetColumnEditor, mountSpreadsheetSheets, mountSpreadsheetToolbar, mountSpreadsheetViewport } from '@hubble/module-sdk/spreadsheet-controls';
import { cameraChoiceKey } from './choice-context.js';
import { PresentationLedger } from './presentation-ledger.js';
(() => {
  const root=document.getElementById('cyanview-design'); if(!root)return;
  const moduleBridge=globalThis.cyanviewModuleBridge;
  if(moduleBridge)root.hidden=true;
  let persistence='saved',saveSequence=0;
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
  const selectedResults=new Set();
  const cellSelections=new Map();
  const device=id=>devices.find(d=>d.id===id);
  const options=(list,current)=>list.map(v=>'<option value="'+esc(typeof v==='string'?v:v.id)+'"'+((typeof v==='string'?v:v.id)===current?' selected':'')+'>'+esc(typeof v==='string'?v:v.label)+'</option>').join('');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  // Null means nothing has answered yet, which isn't the same as Offline.
  const connectionText=online=>online==null?'Not checked':online?'Online':'Offline';
  const status=online=>'<span class="hc-status '+(online==null?'hc-unchecked':online?'hc-online':'hc-offline')+'"'+(online==null?' title="Nothing has reported this yet."':'')+'><span class="hc-dot"></span>'+connectionText(online)+'</span>';
  const resultMark=result=>'<span class="hc-status '+(result==='Verified'?'hc-online':['Sending','Verifying','Queued','Pending'].includes(result)?'hc-pending-text':['Invalid IP','Incomplete','Offline · unsent'].includes(result)?'hc-error-text':'hc-muted')+'">'+(result==='Verified'?icon('check'):'')+esc(result)+'</span>';
  lans.forEach(l=>{l.pending=l.result==='Pending';l.dirty=new Set(l.pending?['planned']:[]);l.revision=0;l.jobs=0;});
  cameras.forEach(c=>{c.dirty=new Set(c.pending?['name']:[]);c.revision=0;c.jobs=0;});
  const pendingLans=()=>lans.filter(l=>l.pending);
  const pendingCameras=id=>cameras.filter(c=>c.pending&&(!id||c.device===id));
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},2800);}
  let lastSavedPrivateContent='';
  function remember(){
    try{const snapshot={modelContent:{activeTab:tab,layout:'Fleet LAN sheet',cameraOrganization:'Expandable spreadsheet per RCP/RIO',sendMode:ui.sendMode,sendModeScope:'Camera/lens and LAN',density:ui.density,lensColumns:ui.lensColumns,deviceOrder:orderedDevices().slice(0,16).map(d=>d.name),lensPresentation:'Inline Iris, Zoom and Focus column groups',axisGroups:axisGroups('rcp1'),reordering:'Drag handles with Alt+Up/Down keyboard support',columnVisibility:'Individual column checkboxes per sheet',hiddenCameraColumns:[...hiddenCameraColumns('rcp1')],hiddenLanColumns:[...hiddenLanColumns],remiSharing:'Managed camera sources'},privateContent:{revision:6,hiddenCameraColumnsByDevice:Object.fromEntries(Object.entries(hiddenCameraColumnsByDevice).map(([id,fields])=>[id,[...fields]])),hiddenLanColumns:[...hiddenLanColumns],tab,ui:{...ui},axisGroupsByDevice:JSON.parse(JSON.stringify(axisGroupsByDevice)),deviceOrder:orderedDevices().map(d=>d.id),openControllers:[...openControllers],openNetworkDevices:[...openNetworkDevices],cameraSortByDevice:JSON.parse(JSON.stringify(cameraSortByDevice)),cameraLayouts:saveCameraLayouts(),cameraSheetsByDevice:saveCameraSheets(),hiddenNetworkColumnsByDevice:Object.fromEntries(Object.entries(hiddenNetworkColumnsByDevice).map(([id,fields])=>[id,[...fields]])),discoveryOpen:discoveryCard?.open,remiDrafts:saveRemiDrafts(),scanRange:$('scan-range').value,deviceFilter:$('device-filter').value}};lastSavedPrivateContent=JSON.stringify(snapshot.privateContent);if(moduleBridge){return persistPlan(snapshot);}const p=window.openai?.setWidgetState?.(snapshot);if(p?.catch)p.catch(()=>{});}catch{}
  }
  function syncFilter(){const select=$('device-filter'),old=select.value;select.innerHTML='<option value="all">All devices</option>'+options(orderedDevices().map(d=>({id:d.id,label:d.name+' · '+d.serial})),old);select.value=devices.some(d=>d.id===old)?old:'all';}
  function syncOrganization(){
    const ordered=orderedDevices(),allOpen=ordered.length>0&&ordered.every(d=>openControllers.has(d.id)),button=action('toggle-all-controllers');
    button.innerHTML=icon(allOpen?'chevrons-down-up':'chevrons-up-down')+'<span data-role="expand-all-label">'+(allOpen?'Collapse all':'Expand all')+'</span>';
    button.disabled=!ordered.length;
    button.setAttribute('aria-label',(allOpen?'Collapse':'Expand')+' all device spreadsheets');
    icons();
  }
  function setOrder(ids,focusId=null){
    const known=new Set(devices.map(d=>d.id));deviceOrder=[...new Set(ids.filter(id=>known.has(id)))];devices.forEach(d=>{if(!deviceOrder.includes(d.id))deviceOrder.push(d.id);});
    const list=$('controllers');
    deviceOrder.forEach(id=>{const section=root.querySelector('[data-controller="'+id+'"]');if(section)list.append(section);});
    syncFilter();renderLans();syncOrganization();remember();
    if(focusId)root.querySelector('#hc-'+tab+' [data-reorder-handle="'+focusId+'"]')?.focus();
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
    $('live-summary').textContent=' · '+devices.filter(d=>d.online).length+' online / '+devices.filter(d=>d.online===false).length+' offline'+uncheckedCount(devices,' / ');
    $('device-summary').textContent=devices.length+' managed devices';$('camera-summary').textContent=devices.length+' devices · '+cameras.length+' cameras';
    $('lan-pending').textContent=nl;
    $('pending-summary').textContent=inFlight?inFlight+' sending · '+Math.max(0,nl+nc-inFlight)+' pending':nl+nc?(nl+nc)+' changes pending':'All changes verified';
    $('pending-summary').classList.toggle('hc-changes-label',!!(nl+nc));
    $('saved-label').textContent=(moduleBridge?.preview||!moduleBridge?'Sample data · ':persistence==='saving'?'Saving… · ':persistence==='failed'?'Changes not saved · ':persistence==='draft'?'Unsaved edits · ':'Workspace saved · ')+ui.sendMode;action('add-lan').disabled=!devices.length;
    $('lan-foot').textContent=ui.sendMode==='Manual'?'Manual · edit, then Send settings.':'Auto send · Enter, Tab, or leave a cell to send.';
    $('camera-foot').textContent=nc+' pending · '+cameras.filter(c=>c.online===false).length+' cameras offline'+uncheckedCount(cameras,' · ');
    $('camera-mode-note').textContent=ui.sendMode==='Manual'?"Expand Iris, Zoom or Focus, then tick Use Iris, Use Zoom or Use Focus for a camera to configure that axis.":'Auto send · committed cell edits send to that device. Existing staged edits stay pending.';
    action('review-lan').disabled=!nl;
    root.style.setProperty('--hc-row',ui.density==='Compact'?'37px':'47px');
    root.querySelectorAll('[data-design]').forEach(el=>{el.checked=!!ui[el.dataset.design];});
    root.querySelectorAll('[data-action="send-mode"]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.mode===ui.sendMode)));
    devices.forEach(d=>{
      const group=root.querySelector('[data-controller="'+d.id+'"]');if(!group)return;
      const pending=pendingCameras(d.id).length;
      group.querySelector('[data-controller-pending]').textContent=pending?pending+' pending':'';
      const b=group.querySelector('[data-action="send-controller"]');b.disabled=!pending||cameras.some(c=>c.device===d.id&&c.jobs>0);b.querySelector('span').textContent=pending;
      syncCameraDeleteButton(group);
    });
    syncOrganization();syncNetworkControls();
  }
  function paintItem(item){
    root.querySelectorAll('[data-sync-id="'+item.id+'"]').forEach(el=>el.innerHTML=resultMark(item.result));
    const row=root.querySelector('tr[data-id="'+item.id+'"]');
    if(row)row.querySelectorAll('[data-field]').forEach(el=>el.closest('td').classList.toggle('hc-changed',item.dirty.has(el.dataset.field)));
    if(item.deleting&&row)row.querySelectorAll('[data-field],input[data-lens-axis]').forEach(el=>el.disabled=true);
    paintCameraColumn(item);
    syncSummary();icons();
  }
  function inputCell(row,key,value,cls='',disabled=false){return '<input class="hc-cell-input '+cls+'" data-row="'+row.id+'" data-field="'+key+'" value="'+(disabled?'':esc(value))+'" aria-label="'+esc(key+' for '+(device(row.device)?.name||'new row'))+'"'+(disabled||row.deleting?' disabled':'')+'>';}
  function gridHeader(cols,widths){return '<colgroup>'+widths.map(w=>'<col style="width:'+w+'px">').join('')+'</colgroup><thead><tr class="hc-letters">'+cols.map((_,i)=>'<th'+(i===0?' class="hc-num"':'')+'>'+(i===0?'':String.fromCharCode(64+i))+'</th>').join('')+'</tr><tr>'+cols.map((s,i)=>'<th'+(i===0?' class="hc-num"':'')+'>'+s+'</th>').join('')+'</tr></thead>';}
  function emptyRows(){return '';}
  function legacyEmptyRows(cols,start,count=2){return Array.from({length:count},(_,i)=>'<tr class="hc-empty"><td class="hc-num">'+(start+i)+'</td>'+Array(cols-1).fill('<td></td>').join('')+'</tr>').join('');}
  const hiddenCameraColumnsByDevice={};
  let hiddenLanColumns=new Set(['dhcp','gateway','dns1','dns2']);
  const lanColumnDefinitions=[
    {id:'device',label:'Device',width:124},{id:'status',label:'Status',width:76},{id:'iface',label:'Interface',width:83},
    {id:'current',label:'Current address',width:144},{id:'planned',label:'Planned address',width:144},{id:'operation',label:'Operation',width:93},
    {id:'sync',label:'Sync',width:90},{id:'dhcp',label:'DHCP',width:58},{id:'gateway',label:'Gateway',width:135},{id:'dns1',label:'DNS 1',width:135},{id:'dns2',label:'DNS 2',width:135},
  ];
  function cameraColumnSections(){return cameraSheetSections();}
  function hiddenCameraColumns(id){return hiddenCameraColumnsByDevice[id]||(hiddenCameraColumnsByDevice[id]=new Set());}
  function cameraColumnVisible(id,field){return cameraFieldVisible(id,field);}
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
  function renderLans(){return renderManagedDevices();}
  function renderLegacyLans(){
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
          case 'planned':cls=l.dirty.has('planned')?'hc-changed':'';content=inputCell(l,'planned',l.planned,'hc-mono',l.readOnly||wan&&l.dhcp);break;
          case 'operation':content='<select class="hc-cell-input" data-row="'+l.id+'" data-field="operation"'+(l.readOnly?' disabled':'')+' aria-label="Operation for '+esc(d.name)+'">'+options(l.readOnly?['']:wan?['Keep','Edit']:['Keep','Add','Replace'],l.readOnly?'':l.operation)+'</select>';break;
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
    // Blank until someone enters a value or the controller reports one.
    for(const field of ['irisMotor','zoomMotor','focusMotor','irisMin','irisMax','irisTorque','zoomTorque','focusTorque','irisDirection','zoomDirection','focusDirection','lensIp'])if(camera[field]===undefined)camera[field]='';
  }
  function lensCapabilities(camera){const editable=camera.lensParamsEditable!==false,torque=editable&&(camera.lens==='ARRI - cforce'||camera.lens==='cmotion cGate'),motor=editable&&camera.lens==='Tilta - Nucleus-M';return {torque,direction:torque,motor,iris:torque||motor,ip:camera.lens==='cmotion cGate',port:camera.lens!=='None'&&camera.lens!=='cmotion cGate'};}
  function lensFieldUsed(camera,field){
    const p=lensCapabilities(camera);
    if(field==='lensIp')return p.ip;if(field==='lensPort')return p.port;
    const axis=lensAxisForField(field);if(axis&&!lensAxisEnabled(camera,axis))return false;
    if(field.endsWith('Motor'))return p.motor;
    if(field.endsWith('Torque'))return p.torque;
    if(field.endsWith('Direction'))return p.direction;
    if(field==='irisMin'||field==='irisMax')return p.iris;
    return true;
  }
  function isLensSetting(field){return ['lensIp','lensPort','irisMin','irisMax'].includes(field)||/^(iris|zoom|focus)(Motor|Torque|Direction)$/.test(field);}
  function axisSummary(camera,axis){
    const p=lensCapabilities(camera);
    if(axis==='iris'&&p.iris)return camera.irisMin&&camera.irisMax?camera.irisMin+'–'+camera.irisMax:'';
    if(p.motor)return camera[axis+'Motor']?'Motor '+camera[axis+'Motor']:'';
    if(p.torque)return camera[axis+'Torque']&&camera[axis+'Direction']?'T'+camera[axis+'Torque']+' '+(camera[axis+'Direction']==='left'?'Left':'Right'):'';
    return '';
  }
  function cameraGrid(rows,deviceId){rows=sortCameraRows(rows,deviceId);
    let columns=[{id:'row',label:'',width:26,frozen:0},{id:'number',label:'#',width:42,frozen:50},{id:'name',label:'Camera name',width:160,frozen:78}];
    columns.push({id:'model',label:'Camera model',width:120},{id:'ip',label:'Camera IP / interface',width:142});
    columns.push({id:'port',label:'Port',width:55},{id:'login',label:'Username',width:88},{id:'password',label:'Password',width:96});
    columns.push({id:'controlEnabled',label:'Camera Control Enabled',width:175});
    columns.push({id:'control',label:'Control',width:104},{id:'recording',label:'Recording',width:96},{id:'cameraStatus',label:'Status',width:200});
    columns.push({id:'lens',label:'Lens model',width:126},{id:'connection',label:'Lens connection',width:116});
    for (const axis of ['iris', 'zoom', 'focus']) {
      columns.push(...cameraAxisColumns(deviceId, axis));
    }
    columns.push({ id: 'sync', label: 'Sync', width: 70 });
    columns = columns.filter(column => column.id === 'row' || column.group || cameraColumnVisible(deviceId, column.id));
    let frozenLeft = 0;
    for (const column of columns) {
      column.width = cameraColumnWidth(deviceId, column);
      if (column.frozen !== undefined) {
        column.frozen = frozenLeft;
        frozenLeft += column.width;
      }
    }
    const header = cameraGridHeader(columns, deviceId);
    function cell(camera,column){
      if(column.placeholder)return '<td class="hc-empty-axis" aria-hidden="true"></td>';
      const p=lensCapabilities(camera),field=column.id,changed=camera.dirty.has(cameraField(camera,field)),inactive=isLensSetting(field)&&!lensFieldUsed(camera,field);
      let content='',attrs=' data-column="'+field+'"'+(field==='row'?' role="rowheader" aria-label="Camera '+esc(camera.number)+'"':' role="gridcell"'+cameraCellPosition(deviceId,camera.id,field)),classes=[];
      if(column.frozen!==undefined){classes.push('hc-camera-frozen');attrs+=' style="left:'+column.frozen+'px"';}
      if(changed)classes.push('hc-changed');if(inactive)classes.push('hc-axis-inactive');
      if(field==='row')classes.push('hc-camera-row-gutter');
      else if(field==='controlEnabled'){classes.push('hc-check');content=cameraControlCell(camera);}
      else if(field==='number'||field==='name')content=inputCell(camera,field,camera[field]);
      else if(field==='model')content=cameraChoiceCell(camera,field);
      else if(field==='ip')content=camera.model==='Alpha-USB'?cameraChoiceCell(camera,'usb'):inputCell(camera,'ip',camera.ip,'hc-mono');
      else if(field==='control')content=status(camera.online);
      else if(field==='recording')content=cameraRecordingCell(camera.id);
      else if(field==='cameraStatus')content=cameraStatusCell(camera.id);
      else if(field==='lens')content=cameraChoiceCell(camera,field);
      else if(field==='connection'){
        if(p.ip)content=inputCell(camera,'lensIp',camera.lensIp,'hc-mono');
        else content=cameraChoiceCell(camera,'lensPort',!p.port);
        if(!p.ip&&!p.port)classes.push('hc-axis-inactive');
      }
      else if(column.summary){classes.push('hc-axis-summary');if(!lensAxisAvailable(camera))classes.push('hc-axis-inactive');content=lensAxisControl(camera,column.group,!axisGroups(deviceId)[column.group]);}
      else if(field.endsWith('Torque'))content=cameraChoiceCell(camera,field,inactive);
      else if(field.endsWith('Direction'))content=cameraChoiceCell(camera,field,inactive);
      else if(isLensSetting(field))content=inputCell(camera,field,camera[field],'hc-mono',inactive);
      else if(['port','login','password'].includes(field))content=inputCell(camera,field,camera[field],field==='port'?'hc-mono':'',camera.model==='Alpha-USB');
      else if(field==='sync'){attrs+=' data-sync-id="'+camera.id+'"';content=resultMark(camera.result);}
      return '<td'+attrs+(classes.length?' class="'+classes.join(' ')+'"':'')+'>'+content+'</td>';
    }
    if(cameraSheetView(deviceId)==='columns')return flippedCameraGrid(rows,columns,deviceId,cell);
    return header+'<tbody>'+rows.map(camera=>{
      initializeLensFields(camera);
      return '<tr data-id="'+esc(camera.id)+'">'+columns.map(column=>cell(camera,column)).join('')+'</tr>';
    }).join('')+'</tbody>';
  }
  function renderCameras(){
    const scrolls=new Map([...root.querySelectorAll('[data-controller]')].map(el=>[el.dataset.controller,el.querySelector('.hc-scroll')?.scrollLeft||0]));
    $('controllers').innerHTML=orderedDevices().map(d=>{
      const rows=cameras.filter(c=>c.device===d.id),open=openControllers.has(d.id),selection=cellSelections.get(d.id)||['C2',rows[0]?.name||''];
      return '<section class="hc-controller" data-controller="'+d.id+'"><div class="hc-controller-header"><button class="hc-controller-handle" draggable="true" data-reorder-handle="'+d.id+'" aria-label="Reorder '+esc(d.name)+'" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" data-tooltip="Drag to reorder; Alt + up/down also moves this device">'+icon('grip-vertical')+'</button><button class="hc-controller-expander" data-action="toggle-controller" data-id="'+d.id+'" aria-expanded="'+open+'" aria-controls="hc-controller-'+d.id+'">'+icon(open?'chevron-down':'chevron-right')+'<strong>'+esc(d.name)+'</strong><span class="hc-device-type">'+d.kind+'</span><span class="hc-controller-serial">'+esc(d.serial)+'</span></button><span class="hc-controller-camera-count">'+rows.length+' camera'+(rows.length===1?'':'s')+'</span>'+cameraControlCount(d)+status(d.online)+'<span class="hc-controller-pending" data-controller-pending></span></div><div id="hc-controller-'+d.id+'"'+(!open?' hidden':'')+'><div class="hc-controller-tools"><select data-new-camera="'+d.id+'" aria-label="Add camera to '+esc(d.name)+'"><option value="">+ Add camera…</option><option value="Venice-IP">Sony · Venice-IP</option><option value="Alpha-USB">Sony · Alpha-USB</option><option value="Alpha-IP">Sony · Alpha-IP</option><option value="Choose model…">Blank camera row</option></select><button class="hc-danger" data-action="delete-controller" data-id="'+d.id+'" disabled>'+icon('trash-2')+'<span data-camera-delete-label>Delete camera</span></button>'+cameraControlTools(d)+'<span class="hc-right"></span><button class="hc-danger" data-action="remove-device" data-id="'+d.id+'" aria-label="Remove '+esc(d.name)+' from managed list">'+icon('trash-2')+'Remove device</button><button class="hc-button" data-action="send-controller" data-id="'+d.id+'">'+icon('send')+'Send changes <span>0</span></button></div><div class="hc-sheet">'+cameraSelectionStrip(d.id)+'<div class="hc-scroll"><table class="hc-grid" role="grid" data-camera-device="'+d.id+'" aria-label="Camera and lens spreadsheet for '+esc(d.name)+'">'+cameraGrid(rows,d.id)+'</table></div><div class="hc-sheet-tabs"><div class="hc-camera-sheet-tabs" data-camera-sheets></div><span class="hc-sheet-caption">'+esc(d.alias||d.base)+'</span></div></div><div class="hc-controller-bottom"><span>Camera &amp; lens settings</span><span data-connection-note>'+esc(connectionNote(d))+'</span></div></div></section>';
    }).join('');syncSummary();icons();
    for(const [id,left] of scrolls){const scroll=root.querySelector('[data-controller="'+id+'"] .hc-scroll');if(scroll)scroll.scrollLeft=left;}
  }
  function setTab(next,save=true){if(next==='discovery'){next='devices';if(discoveryCard)discoveryCard.open=true;}tab=next;root.querySelectorAll('[data-tab]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.tab===next)));for(const id of ['devices','cameras'])root.querySelector('#hc-'+id).hidden=id!==next;$('lan-columns-menu').hidden=true;$('drawer').hidden=true;refreshCameraSheets();if(save)remember();}
  function showDevice(id){
    const d=device(id);if(!d)return;
    $('drawer').innerHTML='<div class="hc-drawer-head"><div><h3>'+esc(d.name)+'</h3><span class="hc-mono hc-muted">'+esc(d.serial)+'</span></div><button data-action="close-drawer" aria-label="Close details">'+icon('x')+'</button></div><div class="hc-detail-section"><h4>DEVICE STATUS</h4><div class="hc-detail-line"><span>Connection</span>'+status(d.online)+'</div><div class="hc-detail-line"><span>LAN1 link</span><span>'+(d.online?'Up':'Unknown')+'</span></div></div><div class="hc-detail-section"><h4>MANAGEMENT ADDRESS</h4><div class="hc-address-item"><div class="hc-mono">'+esc(d.base)+'/16<small>LAN1 · built-in</small></div><span class="hc-retained">'+icon('lock-keyhole')+'Protected</span></div></div><div class="hc-detail-section"><h4>CONFIGURABLE ADDRESSES</h4>'+lans.filter(l=>l.device===id).map(l=>'<div class="hc-address-item"><div class="hc-mono">'+esc(l.current||'Not assigned')+'<small>'+esc(l.iface+' · '+l.type)+'</small></div>'+resultMark(l.result)+'</div>').join('')+'</div><div class="hc-detail-section"><button class="hc-button" data-action="device-cameras" data-id="'+id+'" style="width:100%">Open camera &amp; lens sheet '+icon('arrow-right')+'</button></div>';$('drawer').hidden=false;icons();
  }
  const ipv4=s=>/^\d{1,3}(\.\d{1,3}){3}$/.test(s)&&s.split('.').every(x=>Number(x)<=255);
  function valid(item,kind,fields=[]){
    if(kind==='lan'){if(item.dhcp&&item.type==='WAN')return '';const parts=String(item.planned).split('/');return parts.length===2&&ipv4(parts[0])&&/^\d{1,2}$/.test(parts[1])&&Number(parts[1])<=32?'':'Invalid IP';}
    if(!item.number||!item.name||item.model==='Choose model…')return 'Incomplete';
    if(item.model!=='Alpha-USB'&&!ipv4(item.ip))return 'Incomplete';
    initializeLensFields(item);const p=lensCapabilities(item);
    const filled=fields.filter(field=>!lensAxisBeingCleared(item,field));
    if(filled.some(field=>field==='irisMin'||field==='irisMax')&&(!(Number(item.irisMin)>0)||!(Number(item.irisMax)>Number(item.irisMin))))return 'Incomplete';
    const ids=filled.filter(field=>lensAxisForField(field)&&field.endsWith('Motor')).map(field=>item[field]);
    if(ids.some(id=>!/^\d+$/.test(id)||Number(id)<1)||new Set(ids.map(Number)).size!==ids.length)return 'Incomplete';
    for(const axis of new Set(filled.map(lensAxisForField).filter(Boolean)))if(axisDefinitions[axis].some(definition=>lensFieldUsed(item,definition.id)&&!item[definition.id]))return 'Incomplete';
    if(p.ip&&!ipv4(item.lensIp))return 'Incomplete';return '';
  }
  async function sendItems(items,kind,deleting=false,fields=null){
    const jobs=[];
    for(const item of items){
      if(item.deleting)continue;
      const selectedFields=fields instanceof Map?fields.get(item.id):fields;
      const sendable=field=>kind==='lan'||!isLensSetting(field)||lensFieldUsed(item,field)||lensAxisBeingCleared(item,field);
      const sentFields=(selectedFields||[...item.dirty]).filter(sendable);
      // An axis reaches the controller whole, so parts held back while it was incomplete go with the last one.
      if(kind==='camera')for(const field of item.dirty)if(lensAxisForField(field)&&sendable(field)&&!sentFields.includes(field)&&sentFields.some(sent=>lensAxisForField(sent)===lensAxisForField(field)))sentFields.push(field);
      if(!sentFields.length&&!deleting)continue;
      const error=deleting?'':valid(item,kind,sentFields);
      if(error){item.result=error;paintItem(item);continue;}
      const captured={...item};
      jobs.push({item,captured,sentFields});item.jobs++;if(deleting)item.deleting=true;item.result='Sending';paintItem(item);
    }
    // A single auto-sent edit says so in its Sync cell, and more typing is usually on the way.
    if(!jobs.length){if(!fields)toast('Complete the pending rows before sending');return;}
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
    let remiChanged=false,axisCleared=false;
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
          if(kind==='camera'&&settleClearedLensAxes(item,captured,sentFields))axisCleared=true;
          if(item.isNew){item.isNew=false;for(const field of [...item.dirty])if(kind==='camera'&&isLensSetting(field)&&!lensFieldUsed(item,field))item.dirty.delete(field);}
          item.pending=item.dirty.size>0;item.result=item.pending?'Pending':'Verified';
        }
      }
      item.jobs=Math.max(0,item.jobs-1);if(item.deleting)item.result='Sending';paintItem(item);
    }
    if(deleting||axisCleared)renderCameras();
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
  function showReview(items,kind,deleting=false){
    if(!items.length)return;reviewItems=items.map(i=>i.id);
    const remiRemoval=deleting&&importedCamera(items[0]);
    const title=deleting?(remiRemoval?'Remove REMI camera':'Delete camera from device'):kind==='lan'?'Send LAN changes':'Send camera changes';
    $('modal-layer').innerHTML='<section class="hc-modal" role="dialog" aria-modal="true" aria-labelledby="hc-review-title"><div class="hc-modal-head"><div><h3 id="hc-review-title">'+title+'</h3><p>'+items.length+' '+(deleting?'camera':'change')+(items.length===1?'':'s')+' · '+new Set(items.map(i=>i.device)).size+' devices</p></div><button data-action="close-modal" aria-label="Close">'+icon('x')+'</button></div><div class="hc-modal-body">'+items.map(item=>'<div class="hc-change-item"><div><strong>'+esc(device(item.device).name)+(kind==='camera'?' · Camera '+esc(item.number):'')+'</strong><span class="hc-caption">'+esc(deleting?'Delete':kind==='lan'?item.operation:item.isNew?'Create':'Update')+'</span></div>'+(kind==='lan'?'<div class="hc-diff hc-mono"><span class="hc-before">'+esc(item.current||'Not assigned')+'</span>'+icon('arrow-right')+'<span class="hc-after">'+esc(item.planned)+'</span></div><small>Management retained · '+esc(device(item.device).base)+'</small>':'<div>'+esc(item.name)+'</div><small>'+esc(item.model+(item.lens!=='None'?' · '+item.lens+' / '+item.lensPort:''))+'</small>')+'</div>').join('')+'</div><div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button><button class="'+(deleting?'hc-button hc-danger':'hc-primary')+'" data-action="confirm-send" data-kind="'+kind+'" data-delete="'+deleting+'">'+(deleting?(remiRemoval&&ui.sendMode==='Manual'?'Stage removal':remiRemoval?'Remove camera':'Delete camera'):'Send '+items.length+' changes')+'</button></div></section>';$('modal-layer').hidden=false;icons();
  }
  function addCamera(id,model){
    if(cameras.length>=512){toast('Camera capacity reached');return;}
    const nums=cameras.filter(c=>c.device===id).map(c=>Number(c.number));
    const c={id:'new-camera-'+Date.now(),device:id,number:String(Math.max(0,...nums)+1),name:'New camera',model,ip:'',lens:'None',lensPort:'None',online:null,pending:true,result:model==='Alpha-USB'?'Pending':'Incomplete',port:model==='Alpha-USB'?'':'80',login:model==='Alpha-USB'?'':'admin',password:'',isNew:true,dirty:new Set(['number','name','model','ip','lens','lensPort']),revision:0,jobs:0};
    cameras.push(c);openControllers.add(id);renderCameras();if(ui.sendMode==='Auto send'&&!valid(c,'camera'))sendItems([c],'camera');toast('Camera row added to '+device(id).name);remember();
  }
  function addLan(){const id=$('device-filter').value==='all'?(orderedDevices()[0]?.id||''):$('device-filter').value;lans.push({id:'new-lan-'+Date.now(),device:id,type:'LAN',iface:'LAN1',current:'',planned:'',operation:'Add',pending:true,result:'Incomplete',dhcp:false,gateway:'',dns1:'',dns2:'',dirty:new Set(['planned']),revision:0,jobs:0});renderLans();remember();}
  function renderResults(){
    const countNew=results.filter(r=>!devices.some(d=>d.serial===r.serial)).length;$('found-count').textContent=results.length+' found · '+countNew+' new';
    if(results.length)$('discovery-results').innerHTML='<table class="hc-results-table" aria-label="Discovered devices"><thead><tr><th></th><th>Device</th><th>Reachable addresses</th><th>Status</th><th>Managed list</th></tr></thead><tbody>'+results.map(r=>{const added=devices.some(d=>d.serial===r.serial);return '<tr><td><input type="checkbox" data-select-found="'+r.id+'" aria-label="Select '+esc(r.serial)+'"'+(added?' disabled':selectedResults.has(r.id)?' checked':'')+'></td><td>'+esc(r.name)+'<small class="hc-mono">'+esc(r.serial)+'</small></td><td class="hc-mono">'+esc(r.base)+(r.alias?'<small class="hc-mono">'+esc(r.alias)+'</small>':'')+'</td><td>'+status(true)+'</td><td><span class="hc-collection-state">'+(added?'Added':'Not added')+'</span></td></tr>';}).join('')+'</tbody></table>';
    const selected=results.filter(r=>selectedResults.has(r.id)&&!devices.some(d=>d.serial===r.serial)).length;$('found-selected').textContent=selected;action('add-discovered').disabled=!selected||addingDiscovered;
  }
  function startScan(){
    if(moduleBridge&&!moduleBridge.preview){startLiveScan();return;}
    if(scanTimer)return;const range=$('scan-range').value==='custom'?$('custom-range').value.trim():$('scan-range').value;
    const parts=range.split('/');if(!ipv4(parts[0])||!/^\d{1,2}$/.test(parts[1]||'')||Number(parts[1])<16||Number(parts[1])>32){$('discovery-error').textContent='Enter a range such as 10.20.101.0/24.';$('discovery-error').hidden=false;return;}
    $('discovery-error').hidden=true;
    const candidates=[...devices.filter(d=>['rcp1','rio1','rio2'].includes(d.id)),{id:'rcp3',name:'RCP 03',kind:'RCP',serial:'CY-RCP-10-56',base:'10.192.10.56',alias:'10.20.101.202',online:true},{id:'rio4',name:'RIO 04',kind:'RIO',serial:'CY-RIO-62-21',base:'10.192.62.21',alias:'10.20.101.111',online:true}].map(d=>({...d,base:range.startsWith('10.20')?(d.alias||d.base):d.base,alias:range.startsWith('10.20')?d.base:d.alias}));
    let tick=0;const total=Math.max(1,2**(32-Number(parts[1]))-(Number(parts[1])<31?2:0));results=[];selectedResults.clear();action('scan').disabled=true;action('stop-scan').hidden=false;$('scan-label').textContent='Scanning '+range;$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>Looking for Cyanview devices…</strong></div>';
    scanTimer=setInterval(()=>{tick++;const percent=Math.min(tick*10,100);$('scan-progress').style.width=percent+'%';root.querySelector('.hc-progress').setAttribute('aria-valuenow',String(percent));$('scan-addresses').textContent=Math.round(total*percent/100).toLocaleString()+' / '+total.toLocaleString();results=candidates.slice(0,Math.min(5,Math.ceil(tick/2)));results.forEach(r=>{if(!devices.some(d=>d.serial===r.serial))selectedResults.add(r.id);});renderResults();if(percent===100){clearInterval(scanTimer);scanTimer=null;action('scan').disabled=false;action('stop-scan').hidden=true;$('scan-label').textContent='Scan complete · '+range;remember();}},240);
  }
  function addResults(){if(moduleBridge&&!moduleBridge.preview){void addLiveResults();return;}let count=0;for(const r of results)if(selectedResults.has(r.id)&&!devices.some(d=>d.serial===r.serial)){const d={...r};if(d.base.startsWith('10.20.')&&d.alias.startsWith('10.192.')){const before=d.base;d.base=d.alias;d.alias=before;}devices.push(d);count++;lans.push({id:'lan-'+d.id,device:d.id,type:'LAN',iface:'LAN1',current:d.alias?d.alias+'/16':'',planned:d.alias?d.alias+'/16':'',operation:'Keep',pending:false,result:'In sync',dhcp:false,gateway:'',dns1:'',dns2:'',dirty:new Set(),revision:0,jobs:0});}selectedResults.clear();syncFilter();renderResults();renderLans();renderCameras();toast(count+' devices added');remember();}
  function probeIP(){if(moduleBridge&&!moduleBridge.preview){void probeLiveIP();return;}const ip=$('manual-ip').value.trim();if(!ipv4(ip)){$('discovery-error').textContent='Enter a valid IPv4 address.';$('discovery-error').hidden=false;return;}$('discovery-error').hidden=true;const existing=devices.find(d=>d.base===ip||d.alias===ip),parts=ip.split('.'),candidate=existing||{id:'manual-'+parts.join('-'),name:'RCP '+String(devices.filter(d=>d.kind==='RCP').length+1).padStart(2,'0'),kind:'RCP',serial:'CY-RCP-'+parts.slice(2).join('-'),base:ip,alias:'',online:true};if(!results.some(r=>r.serial===candidate.serial))results.push({...candidate});if(!existing)selectedResults.add(candidate.id);$('scan-label').textContent='Device lookup complete · '+ip;renderResults();remember();}
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
      if(item.lens==='None'){
        item.lensPort='None';
        // No lens leaves nothing to set up, so choosing one later starts clean.
        item.enabledLensAxes=[];
        for(const definition of Object.values(axisDefinitions).flat())item[definition.id]='';
      }
    }
    if(isLan){
      if(field==='dhcp'){
        item.planned=value?'DHCP':'';
        item.operation='Edit';
        item.dirty.add('planned');
        fields.push('planned');
      }else if(item.operation==='Keep'&&field!=='operation'){
        item.operation=item.current?'Replace':'Add';
      }
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
  function updateDesign(){renderLans();renderCameras();remember();}
  function restore(snapshot){const data=snapshot?.privateContent;if(!data||![2,3,4,5,6].includes(data.revision))return;if(data.ui)for(const k of Object.keys(ui))if(typeof data.ui[k]===typeof ui[k])ui[k]=data.ui[k];if(data.revision<5){ui.cameraCore=true;ui.cameraCredentials=true;}restoreColumnVisibility(data);restoreDeviceWorkflow(data);restoreCameraSorting(data);restoreCameraLayouts(data);restoreRemiDrafts(data);if(data.axisGroupsByDevice&&typeof data.axisGroupsByDevice==='object'){for(const [id,groups] of Object.entries(data.axisGroupsByDevice)){if(!device(id)||!groups||typeof groups!=='object')continue;for(const axis of ['iris','zoom','focus'])if(typeof groups[axis]==='boolean')axisGroups(id)[axis]=groups[axis];}}restoreCameraSheets(data);if(Array.isArray(data.deviceOrder)){const known=new Set(devices.map(d=>d.id));deviceOrder=[...new Set(data.deviceOrder.filter(id=>known.has(id)))];devices.forEach(d=>{if(!deviceOrder.includes(d.id))deviceOrder.push(d.id);});}if(Array.isArray(data.openControllers)){openControllers.clear();data.openControllers.forEach(id=>{if(device(id))openControllers.add(id);});}if(['devices','discovery','cameras'].includes(data.tab))setTab(data.tab,false);if(['','10.192.0.0/16','10.20.0.0/16','custom'].includes(data.scanRange))$('scan-range').value=data.scanRange;$('custom-range-field').hidden=$('scan-range').value!=='custom';action('scan').disabled=!$('scan-range').value;syncFilter();if(data.deviceFilter==='all'||devices.some(item=>item.id===data.deviceFilter))$('device-filter').value=data.deviceFilter;renderLans();renderCameras();}
  root.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b||!root.contains(b))return;
    if(b.dataset.tab){setTab(b.dataset.tab);return;}if(b.dataset.device){showDevice(b.dataset.device);return;}
    switch(b.dataset.action){
      case 'send-mode':ui.sendMode=b.dataset.mode;syncSummary();toast(ui.sendMode==='Auto send'?'Auto send enabled · existing edits remain staged':'Manual mode · use Send changes');remember();break;
      case 'toggle-all-controllers':{const ordered=orderedDevices(),allOpen=ordered.every(d=>openControllers.has(d.id));if(allOpen)openControllers.clear();else ordered.forEach(d=>openControllers.add(d.id));renderCameras();remember();break;}
      case 'toggle-controller':if(openControllers.has(b.dataset.id))openControllers.delete(b.dataset.id);else openControllers.add(b.dataset.id);renderCameras();remember();break;
      case 'send-controller':sendItems(pendingCameras(b.dataset.id),'camera');break;
      case 'delete-controller':reviewCameraDeletion(activeCamera(b.closest('[data-controller]').querySelector('table[data-camera-device]')));break;
      case 'review-lan':showReview(pendingLans(),'lan');break;
      case 'camera-columns':{const menu=root.querySelector('[data-columns-for="'+b.dataset.id+'"]');if(menu.hidden)showColumnMenu(menu);else menu.hidden=true;break;}
      case 'lan-columns':{const menu=$('lan-columns-menu');if(menu.hidden)showColumnMenu(menu);else menu.hidden=true;break;}
      case 'close-modal':$('modal-layer').hidden=true;break;
      case 'confirm-send':{const kind=b.dataset.kind,items=(kind==='lan'?lans:cameras).filter(i=>reviewItems.includes(i.id));$('modal-layer').hidden=true;if(kind==='camera'&&b.dataset.delete==='true')deleteReviewedCamera(items[0]);else sendItems(items,kind);break;}
      case 'close-drawer':$('drawer').hidden=true;break;
      case 'device-cameras':openControllers.add(b.dataset.id);setTab('cameras');renderCameras();break;
      case 'add-lan':addLan();break;
      case 'add-ip':setTab('discovery');$('manual-ip').focus();break;
      case 'scan':startScan();break;
      case 'stop-scan':if(moduleBridge&&!moduleBridge.preview)void moduleBridge.stopScan().catch(error=>toast(error.message));if(scanTimer)clearInterval(scanTimer);scanTimer=null;action('scan').disabled=false;action('stop-scan').hidden=true;$('scan-label').textContent='Scan stopped · partial results';break;
      case 'add-discovered':addResults();break;
      case 'probe-ip':probeIP();break;
      case 'refresh-all':if(moduleBridge&&!moduleBridge.preview){void refreshLive();break;}action('refresh-all').disabled=true;setTimeout(()=>{action('refresh-all').disabled=false;toast('Settings refreshed · edits retained');},500);break;
    }
  });
  root.addEventListener('dragstart',event=>{const handle=event.target.closest('[data-reorder-handle]');if(!handle||!root.contains(handle))return;draggedDevice=handle.dataset.reorderHandle;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedDevice);handle.closest('[data-controller],[data-network-controller]').dataset.dragging='true';});
  root.addEventListener('dragover',event=>{const group=event.target.closest('[data-controller],[data-network-controller]');if(!draggedDevice||!group)return;event.preventDefault();event.dataTransfer.dropEffect='move';root.querySelectorAll('[data-drop]').forEach(el=>delete el.dataset.drop);if((group.dataset.controller||group.dataset.networkController)!==draggedDevice){const rect=group.querySelector('.hc-controller-header').getBoundingClientRect();group.dataset.drop=event.clientY>rect.top+rect.height/2?'after':'before';}});
  root.addEventListener('drop',event=>{const group=event.target.closest('[data-controller],[data-network-controller]');if(!draggedDevice||!group)return;event.preventDefault();const source=draggedDevice,target=(group.dataset.controller||group.dataset.networkController),rect=group.querySelector('.hc-controller-header').getBoundingClientRect(),after=event.clientY>rect.top+rect.height/2;clearDrag();dropDevice(source,target,after);});
  root.addEventListener('dragend',clearDrag);
  root.addEventListener('keydown',event=>{const handle=event.target.closest('[data-reorder-handle]');if(event.key==='Escape')clearDrag();if(handle&&event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();moveDevice(handle.dataset.reorderHandle,event.key==='ArrowUp'?'up':'down');}});
  root.addEventListener('input',event=>{const el=event.target;if(!el.dataset?.row||el.type==='checkbox'||el.closest('table[data-camera-device]'))return;persistence='draft';saveSequence++;const isLan=!!el.closest('table[data-lan-device]'),item=(isLan?lans:cameras).find(i=>i.id===el.dataset.row);if(!item)return;if(!isLan&&isLensSetting(el.dataset.field)&&!lensFieldUsed(item,el.dataset.field))return;item[el.dataset.field]=el.value;item.dirty.add(el.dataset.field);item.pending=true;item.result='Pending';if(isLan){if($('lan-value'))$('lan-value').textContent=el.value;if(item.operation==='Keep')item.operation=item.current?'Replace':'Add';}paintItem(item);});
  root.addEventListener('change',event=>{const el=event.target;if(el.dataset.columnSheet){changeColumnVisibility(el);return;}if(el.dataset.design){ui[el.dataset.design]=el.checked;updateDesign();return;}if(el.dataset.newCamera){if(el.value)addCamera(el.dataset.newCamera,el.value);return;}if(el===$('device-filter')){renderLans();remember();return;}if(el===$('scan-range')){$('custom-range-field').hidden=el.value!=='custom';action('scan').disabled=!el.value;remember();return;}if(el.dataset.selectFound){if(el.checked)selectedResults.add(el.dataset.selectFound);else selectedResults.delete(el.dataset.selectFound);renderResults();return;}if(el.dataset.row&&el.dataset.field&&!el.closest('table[data-camera-device]'))commitCell(el);});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){$('modal-layer').hidden=true;$('drawer').hidden=true;$('lan-columns-menu').hidden=true;root.querySelectorAll('[data-columns-for]').forEach(el=>el.hidden=true);}if(event.target.dataset?.row&&event.key==='Enter'){event.preventDefault();event.target.blur();return;}if(event.target===$('manual-ip')&&event.key==='Enter'){event.preventDefault();probeIP();return;}if(event.target.closest('[role="tablist"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=Array.from(root.querySelectorAll('[data-tab]'));let i=tabs.findIndex(b=>b.dataset.tab===tab);i=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;setTab(tabs[i].dataset.tab);tabs[i].focus();}});
  let cameraControlState={epoch:null,sequence:-1,enabled:{},singleSwitch:{},controllers:{},cameras:{}};
  const cameraControlDrafts=new Map();
  let cameraControlEdit=0;
  function cameraControlDevice(d){return ['RCP','RIO','Gateway'].includes(d?.kind);}
  // Edits still saving replay over the module's last state, so the page is right before any save returns.
  function cameraControlProjection(){
    const enabled={...cameraControlState.enabled},singleSwitch={...cameraControlState.singleSwitch};
    for(const mutations of cameraControlDrafts.values())for(const mutation of mutations){
      const rows=cameras.filter(camera=>camera.device===mutation.controllerId);
      if(mutation.kind==='all'){
        if(mutation.enabled)singleSwitch[mutation.controllerId]=false;
        for(const camera of rows)enabled[camera.id]=mutation.enabled;
      }else if(mutation.kind==='single'){
        singleSwitch[mutation.controllerId]=mutation.enabled;
        if(mutation.enabled){const first=rows.find(camera=>enabled[camera.id]);for(const camera of rows)enabled[camera.id]=camera===first;}
      }else{
        if(mutation.enabled&&singleSwitch[mutation.controllerId])for(const camera of rows)enabled[camera.id]=false;
        enabled[mutation.cameraId]=mutation.enabled;
      }
    }
    return {enabled,singleSwitch};
  }
  function cameraControlFlags(){return cameraControlProjection().enabled;}
  function cameraControlEnabled(camera){return cameraControlFlags()[camera.id]===true;}
  function cameraControlCell(camera){
    return '<span data-hubble-boolean data-field="controlEnabled" data-row="'+esc(camera.id)+'"></span>';
  }
  function cameraRecordingText(id){
    const recording=cameraControlState.cameras?.[id]?.recording;
    return recording==='recording'?'Recording':recording==='stopped'?'Stopped':recording==='unknown'?'Unknown':'';
  }
  function cameraRecordingCell(id){
    const text=cameraRecordingText(id);
    // Nothing is watching this controller yet, so there is no state to show.
    if(!text)return '<span class="hc-status hc-muted">—</span>';
    return '<span class="hc-status '+(text==='Recording'?'hc-recording':'hc-muted')+'"><span class="hc-dot"></span>'+text+'</span>';
  }
  function cameraStatusText(id){return cameraControlState.cameras?.[id]?.message||'';}
  function cameraStatusCell(id){
    const text=esc(cameraStatusText(id));
    return '<span class="hc-camera-status" title="'+text+'">'+text+'</span>';
  }
  function cameraControlRows(id){return cameras.filter(camera=>camera.device===id);}
  function cameraControlAllLabel(id,enabled){
    const rows=cameraControlRows(id);
    return rows.length&&rows.every(camera=>enabled[camera.id]===true)?'Disable all':'Enable all';
  }
  function cameraControlCountMarkup(id,enabled){
    const rows=cameraControlRows(id).filter(camera=>enabled[camera.id]===true);
    const unavailable=rows.filter(camera=>cameraControlState.cameras?.[camera.id]?.available===false).length;
    return rows.length+' enabled'+(unavailable?' · <span class="hc-pending-text">'+unavailable+' unavailable</span>':'');
  }
  function cameraControlCount(d){
    if(!cameraControlDevice(d))return '';
    return '<span class="hc-controller-camera-count" data-control-count="'+esc(d.id)+'">'+cameraControlCountMarkup(d.id,cameraControlFlags())+'</span>';
  }
  function cameraControlTools(d){
    if(!cameraControlDevice(d))return '';
    const {enabled,singleSwitch}=cameraControlProjection(),label=cameraControlAllLabel(d.id,enabled);
    return '<label class="hc-control-single"><input type="checkbox" data-control-single="'+esc(d.id)+'" aria-label="Single switch for '+esc(d.name)+'"'+(singleSwitch[d.id]===true?' checked':'')+'>Single switch</label>'+
      '<button class="hc-button" data-action="control-enable-all" data-id="'+esc(d.id)+'" aria-label="'+label+' cameras on '+esc(d.name)+'"'+(cameraControlRows(d.id).length?'':' disabled')+'>'+label+'</button>';
  }
  let paintedCameraFlags='';
  function paintCameraControl(){
    const {enabled,singleSwitch}=cameraControlProjection();
    // The host draws these checkboxes from getCell, so it only needs telling when one changed.
    const flags=JSON.stringify(enabled);
    if(flags!==paintedCameraFlags){paintedCameraFlags=flags;for(const sheet of cameraSheets.values())sheet.controls?.refresh();}
    root.querySelectorAll('input[data-control-single]').forEach(input=>{input.checked=singleSwitch[input.dataset.controlSingle]===true;});
    root.querySelectorAll('button[data-action="control-enable-all"]').forEach(button=>{
      const id=button.dataset.id,label=cameraControlAllLabel(id,enabled);
      button.textContent=label;button.setAttribute('aria-label',label+' cameras on '+(device(id)?.name||'controller'));button.disabled=!cameraControlRows(id).length;
    });
    root.querySelectorAll('[data-control-count]').forEach(count=>{
      const markup=cameraControlCountMarkup(count.dataset.controlCount,enabled);
      if(count.innerHTML!==markup)count.innerHTML=markup;
    });
    root.querySelectorAll('td[data-column="recording"],td[data-column="cameraStatus"]').forEach(cell=>{
      const id=cell.dataset.camera,markup=cell.dataset.column==='recording'?cameraRecordingCell(id):cameraStatusCell(id);
      if(cell.innerHTML!==markup)cell.innerHTML=markup;
    });
  }
  function applyCameraControlState(state){
    if(!state||typeof state.sequence!=='number')return;
    // A restarted worker counts from zero again, so only compare within one worker.
    if(state.epoch===cameraControlState.epoch&&state.sequence<cameraControlState.sequence)return;
    cameraControlState=state;paintCameraControl();syncConnections();
  }
  function controlBoolean(value){
    const text=String(value).trim().toLowerCase();
    if(['true','1','yes','on','✓'].includes(text))return true;
    if(['false','0','no','off',''].includes(text))return false;
    throw new Error('Use TRUE or FALSE for Camera Control Enabled');
  }
  function submitCameraControl(mutations){
    if(!mutations.length)return;
    const requestId='sheet-'+Date.now()+'-'+(++cameraControlEdit);
    cameraControlDrafts.set(requestId,mutations);paintCameraControl();
    if(!moduleBridge){
      cameraControlState={...cameraControlState,...cameraControlProjection()};cameraControlDrafts.delete(requestId);return;
    }
    // Sample rows are initially frontend fixtures; save their workspace identities first.
    if(moduleBridge.preview)remember();
    void moduleBridge.controlMutate({requestId,mutations}).then(state=>{
      cameraControlDrafts.delete(requestId);applyCameraControlState(state);paintCameraControl();
    }).catch(async error=>{
      cameraControlDrafts.delete(requestId);paintCameraControl();toast(error.message||'Cyanview camera selection could not be saved');
      try{applyCameraControlState(await moduleBridge.controlState());}catch{}
    });
  }
  function editCameraControl(edits){
    const mutations=[];
    try{
      for(const {rowId,value}of edits){
        const camera=cameras.find(row=>row.id===rowId);
        if(!camera||camera.deleting||!cameraControlDevice(device(camera.device)))continue;
        mutations.push({kind:'camera',controllerId:camera.device,cameraId:camera.id,enabled:controlBoolean(value)});
      }
    }catch(error){toast(error.message);return;}
    submitCameraControl(mutations);
  }
  root.addEventListener('change',event=>{
    const input=event.target;
    if(input.matches('input[data-control-single]'))submitCameraControl([{kind:'single',controllerId:input.dataset.controlSingle,enabled:input.checked}]);
  });
  root.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action="control-enable-all"]');if(!button)return;
    const id=button.dataset.id,enabled=cameraControlFlags();
    // Says which way it goes, so the edit reads the same however many times it replays.
    submitCameraControl([{kind:'all',controllerId:id,enabled:!cameraControlRows(id).every(camera=>enabled[camera.id]===true)}]);
  });

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

  const cameraLayouts = new Map();
  const cameraAxes = ['iris', 'zoom', 'focus'];
  function cameraLayout(id) {
    if (!cameraLayouts.has(id)) cameraLayouts.set(id, {
      version: 2, columns: {}, rows: {}, groups: {}, hiddenGroups: [], textSize: 13,
    });
    return cameraLayouts.get(id);
  }
  function cameraSheetSections() {
    return [
      { id: 'camera', label: 'Camera', fields: [
        { id: 'number', label: 'Camera number' }, { id: 'name', label: 'Camera name' },
        { id: 'model', label: 'Camera model' }, { id: 'ip', label: 'Camera IP / interface' },
        { id: 'port', label: 'Port' }, { id: 'login', label: 'Username' }, { id: 'password', label: 'Password' },
        { id: 'controlEnabled', label: 'Camera Control Enabled' }, { id: 'control', label: 'Control status' },
        { id: 'recording', label: 'Recording' }, { id: 'cameraStatus', label: 'Recording status' }, { id: 'sync', label: 'Sync status' },
      ] },
      { id: 'lens', label: 'Lens', fields: [{ id: 'lens', label: 'Lens model' }, { id: 'connection', label: 'Lens connection' }] },
      ...cameraAxes.map(axis => ({ id: axis, axis, label: axisName(axis), fields: [
        { id: axis + 'Summary', label: 'Use ' + axisName(axis), width: 88, summary: true }, ...axisDefinitions[axis],
      ] })),
    ];
  }
  function cameraFieldVisible(id, field, ignoreGroup = false) {
    const section = cameraSheetSections().find(section => section.fields.some(column => column.id === field));
    const retained = section?.axis && !axisGroups(id)[section.axis] && cameraLayout(id).groups[section.axis]?.collapsed.includes(field);
    return (!hiddenCameraColumns(id).has(field) || retained) && (ignoreGroup || !cameraLayout(id).hiddenGroups.includes(section?.id));
  }
  function cameraAxisGroup(id, axis) {
    const fields = cameraSheetSections().find(section => section.id === axis).fields.map(field => ({ ...field, group: axis }));
    const saved = cameraLayout(id).groups[axis];
    const order = [...new Set([...(saved?.order ?? []), ...fields.map(field => field.id)])];
    return {
      id: axis, label: axisName(axis), columns: order.flatMap(id => fields.filter(field => field.id === id)),
      expanded: axisGroups(id)[axis], collapsedColumnIds: (saved?.collapsed ?? []).filter(id => fields.some(column => column.id === id)),
    };
  }
  function cameraAxisColumns(id, axis) {
    if (cameraLayout(id).hiddenGroups.includes(axis)) return [];
    const group = cameraAxisGroup(id, axis);
    const columns = group.columns.filter(column => cameraFieldVisible(id, column.id) && (group.expanded || group.collapsedColumnIds.includes(column.id)));
    return columns.length ? columns : [{ id: axis + 'Placeholder', group: axis, placeholder: true, label: '', width: Math.max(130, axisName(axis).length * 12 + 50) }];
  }
  function cameraColumnWidth(id, column) { return cameraLayouts.get(id)?.columns[column.id] ?? column.width; }
  function pruneCameraLayout(id, layout) {
    const ids = new Set(cameras.filter(camera => camera.device === id).map(camera => camera.id));
    const kept = sizes => Object.fromEntries(Object.entries(sizes).filter(([cameraId]) => ids.has(cameraId)));
    return { ...layout, rows: kept(layout.rows), ...(layout.cameraWidths && { cameraWidths: kept(layout.cameraWidths) }) };
  }
  function saveCameraLayouts() {
    return Object.fromEntries([...cameraLayouts].filter(([id]) => device(id)).map(([id, layout]) => [id, pruneCameraLayout(id, layout)]));
  }
  function restoreCameraLayouts(data) {
    cameraLayouts.clear();
    for (const d of devices) cameraLayouts.set(d.id, cleanCameraLayout(d.id, data.cameraLayouts?.[d.id]));
  }
  function cleanCameraLayout(id, saved = {}) {
    const layout = { version: 2, columns: {}, rows: {}, groups: {}, hiddenGroups: [], textSize: 13 };
    const columnIds = cameraSheetSections().flatMap(section => section.fields.map(field => field.id));
    const cameraIds = new Set(cameras.filter(camera => camera.device === id).map(camera => camera.id));
    const within = (value, least, most) => Number.isInteger(value) && value >= least && value <= most;
    for (const [column, size] of Object.entries(saved.columns ?? {})) if (columnIds.includes(column) && within(size, 36, 640)) layout.columns[column] = size;
    for (const [rowId, size] of Object.entries(saved.rows ?? {})) if (cameraIds.has(rowId) && within(size, 30, 240)) layout.rows[rowId] = size;
    for (const [camera, size] of Object.entries(saved.cameraWidths ?? {})) if (cameraIds.has(camera) && within(size, 72, 640)) (layout.cameraWidths ??= {})[camera] = size;
    for (const [field, size] of Object.entries(saved.settingHeights ?? {})) if (columnIds.includes(field) && within(size, 30, 240)) (layout.settingHeights ??= {})[field] = size;
    if (within(saved.settingWidth, 100, 640)) layout.settingWidth = saved.settingWidth;
    for (const axis of cameraAxes) {
      const group = saved.groups?.[axis], ids = [axis + 'Summary', ...axisDefinitions[axis].map(field => field.id)];
      const valid = values => [...new Set(values.filter(value => ids.includes(value)))];
      if (Array.isArray(group?.order) && Array.isArray(group.collapsed)) layout.groups[axis] = { order: valid(group.order), collapsed: valid(group.collapsed) };
      else if (saved.version !== 2) layout.groups[axis] = { order: ids, collapsed: [axis + 'Summary'] };
    }
    if (Array.isArray(saved.hiddenGroups)) layout.hiddenGroups = [...new Set(saved.hiddenGroups.filter(group => cameraSheetSections().some(section => section.id === group)))];
    if (within(saved.textSize, 9, 24)) layout.textSize = saved.textSize;
    return layout;
  }
  function cameraGridHeader(columns, deviceId) {
    const hasGroups = columns.some(column => column.group), top = [], fields = [];
    for (const [index, column] of columns.entries()) {
      const id = column.id;
      const attributes = column.placeholder ? ' aria-hidden="true"' : ' data-field-header="' + id + '"' + cameraSortAria(column, deviceId);
      const heading = column.placeholder ? '' : cameraSortHeading(column, deviceId);
      if (column.group) {
        if (columns[index - 1]?.group !== column.group) top.push('<th class="hc-camera-group-header" scope="colgroup" colspan="' + columns.filter(field => field.group === column.group).length + '"><div data-axis-header="' + column.group + '"></div></th>');
        fields.push('<th scope="col"' + attributes + '>' + heading + '</th>');
      } else {
        const frozen = column.frozen === undefined ? '' : ' class="hc-camera-frozen" style="left:' + column.frozen + 'px"';
        top.push('<th scope="col" rowspan="' + (hasGroups ? 2 : 1) + '"' + frozen + attributes + '>' + heading + '</th>');
      }
    }
    return '<colgroup>' + columns.map(column => '<col' + (column.placeholder ? '' : ' data-hubble-column="' + column.id + '" data-label="' + esc(column.label) + '"') + ' style="width:' + column.width + 'px">').join('') + '</colgroup><thead>' + cameraColumnBands(columns) + '<tr>' + top.join('') + '</tr>' + (fields.length ? '<tr>' + fields.join('') + '</tr>' : '') + '</thead>';
  }
  function cameraColumnItems(id) {
    return cameraSheetSections().map(section => ({
      id: 'section:' + section.id, label: section.label, visible: !cameraLayout(id).hiddenGroups.includes(section.id),
      fields: section.fields.map(field => ({ id: field.id, label: field.label, visible: cameraFieldVisible(id, field.id, true) && (!section.axis || axisGroups(id)[section.axis] || cameraAxisGroup(id, section.axis).collapsedColumnIds.includes(field.id)) })),
    }));
  }
  function changeCameraVisibility(id, changes) {
    changeCameraPresentation(id, () => {
      const layout = cameraLayout(id), hidden = hiddenCameraColumns(id);
      for (const { id: field, visible } of changes) {
        if (field.startsWith('section:')) {
          const group = field.slice(8);
          layout.hiddenGroups = layout.hiddenGroups.filter(id => id !== group);
          if (!visible) layout.hiddenGroups.push(group);
          continue;
        }
        const section = cameraSheetSections().find(section => section.fields.some(column => column.id === field));
        if (!section) continue;
        if (visible) hidden.delete(field); else hidden.add(field);
        if (section.axis) {
          const group = cameraAxisGroup(id, section.axis);
          layout.groups[section.axis] = { order: group.columns.map(column => column.id), collapsed: group.collapsedColumnIds.filter(id => id !== field) };
          if (visible && !group.expanded) layout.groups[section.axis].collapsed.push(field);
        }
      }
    });
  }
  function mountCameraLayoutControls(table, viewport, sheet) {
    const id = table.dataset.cameraDevice, groups = new Map();
    let resize, disposed = false;
    function refresh() {
      const slots = new Map([...table.querySelectorAll('[data-axis-header]')].map(slot => [slot.dataset.axisHeader, slot]));
      for (const [axis, group] of groups) {
        const slot = slots.get(axis);
        if (slot) { if (slot !== group.slot) slot.replaceWith(group.slot); group.controls?.refresh(); slots.delete(axis); }
        else { group.controls?.dispose(); groups.delete(axis); }
      }
      for (const [axis, slot] of slots) {
        const group = { slot }; groups.set(axis, group);
        void mountSpreadsheetColumnGroup({ root: slot, getGroup: () => cameraAxisGroup(id, axis),
          onChange(next) {
            const focused = slot.contains(document.activeElement) ? document.activeElement : null;
            changeCameraPresentation(id, () => {
              axisGroups(id)[axis] = next.expanded;
              cameraLayout(id).groups[axis] = { order: next.columns.map(column => column.id), collapsed: [...next.collapsedColumnIds] };
              for (const field of next.collapsedColumnIds) hiddenCameraColumns(id).delete(field);
            });
            focused?.focus({ preventScroll: true });
          }, onError: error => toast(error.message),
        }).then(controls => { if (disposed || groups.get(axis) !== group) controls.dispose(); else group.controls = controls; }).catch(error => { if (!disposed) toast(error.message); });
      }
      resize?.refresh();
    }
    void mountSpreadsheetResize({ root: table, viewport, getScale: () => sheet.scale ?? 1,
      getItems: () => cameraSheetView(id) === 'columns' ? flippedResizeItems(table) : [
        ...[...table.querySelectorAll('th[data-field-header]:not([data-field-header="row"])')].map(header => ({ id: header.dataset.fieldHeader, header, axis: 'column', label: cameraSortLabels[header.dataset.fieldHeader] ?? 'Use ' + axisName(header.dataset.fieldHeader.replace(/Summary$/, '')), size: header.offsetWidth, min: header.dataset.fieldHeader.endsWith('Summary') ? 72 : 36, max: 640 })),
        ...[...table.tBodies[0].rows].map(row => ({ id: row.dataset.id, header: row.cells[0], axis: 'row', label: 'camera ' + (cameras.find(item => item.id === row.dataset.id)?.number ?? row.sectionRowIndex + 1) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
      ], onResize({ id: item, axis }, size) { changeCameraPresentation(id, () => { if (cameraSheetView(id) === 'columns') resizeFlippedSheet(id, item, axis, size); else cameraLayout(id)[axis === 'row' ? 'rows' : 'columns'][item] = size; }); },
    }).then(controls => { if (disposed) controls.dispose(); else { resize = controls; resize.refresh(); } }).catch(error => { if (!disposed) toast(error.message); });
    refresh();
    return { refresh, dispose() { disposed = true; for (const group of groups.values()) group.controls?.dispose(); resize?.dispose(); } };
  }
  function cameraColumnBands(columns){
    const cameraFields=new Set(['number','name','model','ip','port','login','password','controlEnabled','control','recording','cameraStatus']);
    const bands=[
      {label:'',kind:'gutter',count:columns.filter(column=>column.id==='row').length},
      {label:'Camera',kind:'camera',count:columns.filter(column=>cameraFields.has(column.id)).length},
      {label:'Lens',kind:'lens',count:columns.filter(column=>column.id==='lens'||column.id==='connection'||column.group).length},
      {label:'Sync',kind:'sync',count:columns.filter(column=>column.id==='sync').length},
    ];
    return '<tr class="hc-camera-bands">'+bands.filter(band=>band.count).map(band=>
      '<th colspan="'+band.count+'" scope="colgroup" class="hc-camera-band hc-camera-band-'+band.kind+'">'+band.label+'</th>'
    ).join('')+'</tr>';
  }

  function cameraSelectionStrip(deviceId){
    return '<div class="hc-camera-selection" data-camera-selection="'+esc(deviceId)+'">'+
      '<span class="hc-camera-location" data-camera-location>Select a cell</span>'+
      '<span class="hc-camera-value" data-camera-value></span>'+
      '<span class="hc-camera-grid-shortcuts"><span data-camera-search-hint hidden>Type to search <span aria-hidden="true">·</span> </span>'+cameraClipboardHint()+' <span aria-hidden="true">·</span> Drag to fill</span>'+
      '<span data-camera-zoom aria-label="Sheet zoom">100%</span>'+
      '<div data-camera-text-size></div>'+cameraViewControl(deviceId)+'<div data-camera-columns title="Choose which settings this tab shows"></div>'+
      '</div>';
  }

  function cameraClipboardHint(){
    const modifier=/Mac/.test(navigator.platform)?'⌘':'Ctrl+';
    return '<kbd>'+modifier+'C</kbd> Copy <kbd>'+modifier+'V</kbd> Paste';
  }

  function paintCameraSelectionSummary(strip,cell){
    const location=strip.querySelector('[data-camera-location]'),value=strip.querySelector('[data-camera-value]');
    const search=strip.querySelector('[data-camera-search-hint]');
    search.hidden=true;
    value.textContent='';
    value.removeAttribute('title');
    if(!cell){location.textContent='Select a cell';return;}
    const input=cell.querySelector('[data-field]'),column=cell.dataset.column;
    const row=cameras.find(camera=>camera.id===cell.dataset.camera);
    const choice=input?.hasAttribute('data-camera-choice');
    const axisSetup=column.endsWith('Summary');
    const label=choice?choiceLabel(input.dataset.field):axisSetup?'Use '+axisName(column.replace(/Summary$/,'')):cameraSortLabels[column]||column;
    location.textContent='Camera '+(row?.number||'—')+' · '+label;
    if(column==='password')value.textContent=input?.value?'••••••••':'';
    else if(axisSetup&&cell.classList.contains('hc-axis-inactive'))value.textContent='Unavailable for this camera';
    else if(cell.querySelector('[role="checkbox"]'))value.textContent=cell.querySelector('[role="checkbox"]').getAttribute('aria-checked')==='true'?'On':'Off';
    else value.textContent=input?.disabled?'':choice?input.textContent:input?.value??cell.textContent.trim();
    if(value.textContent&&column!=='password')value.title=value.textContent;
    search.hidden=!choice||input.disabled;
  }

  // A tab is a saved way of looking at one controller's cameras: which settings it
  // shows, their sizes, and which way round the sheet is. The cameras and their values
  // are the same on every tab. The page's layout stores always hold the tab on screen,
  // so nothing else on the page needs to know that tabs exist.
  const cameraSheetsByDevice = {};
  const settingHeaderId = 'hc:setting';
  let cameraSheetSequence = 0;
  function cameraSheetState(id) {
    return cameraSheetsByDevice[id] ??= { activeSheetId: 'settings', sheets: [{ id: 'settings', name: 'Settings', view: 'rows' }] };
  }
  function activeCameraSheet(id) {
    const state = cameraSheetState(id);
    return state.sheets.find(sheet => sheet.id === state.activeSheetId) ?? state.sheets[0];
  }
  function cameraSheetView(id) { return activeCameraSheet(id).view; }
  function liveCameraSheet(id) {
    return { layout: cameraLayout(id), hidden: [...hiddenCameraColumns(id)], expanded: axisGroups(id) };
  }
  function cameraSheetList(id) {
    const active = activeCameraSheet(id);
    return cameraSheetState(id).sheets.map(sheet => ({ ...sheet, ...(sheet === active ? liveCameraSheet(id) : {}) }));
  }
  function parkCameraSheet(id) { Object.assign(activeCameraSheet(id), copyPresentation(liveCameraSheet(id))); }
  function showCameraSheet(id, sheet) {
    cameraSheetState(id).activeSheetId = sheet.id;
    cameraLayouts.set(id, copyPresentation(sheet.layout));
    hiddenCameraColumnsByDevice[id] = new Set(sheet.hidden);
    axisGroupsByDevice[id] = { ...sheet.expanded };
  }
  function selectCameraSheet(id, sheetId) {
    const state = cameraSheetState(id), next = state.sheets.find(sheet => sheet.id === sheetId);
    if (!next || next.id === state.activeSheetId) return;
    parkCameraSheet(id);
    showCameraSheet(id, next);
    renderCameras();
    remember();
  }
  function createCameraSheet(id, name) {
    changeCameraPresentation(id, () => {
      const current = activeCameraSheet(id);
      parkCameraSheet(id);
      // A new tab starts as a copy of the one you're on.
      const sheet = { id: 'sheet-' + Date.now() + '-' + (++cameraSheetSequence), name, view: current.view, ...copyPresentation({ layout: current.layout, hidden: current.hidden, expanded: current.expanded }) };
      cameraSheetState(id).sheets.push(sheet);
      showCameraSheet(id, sheet);
    });
  }
  function renameCameraSheet(id, sheetId, name) {
    changeCameraPresentation(id, () => {
      const sheet = cameraSheetState(id).sheets.find(item => item.id === sheetId);
      if (sheet) sheet.name = name;
    });
  }
  function removeCameraSheet(id, sheetId) {
    changeCameraPresentation(id, () => {
      const state = cameraSheetState(id), index = state.sheets.findIndex(sheet => sheet.id === sheetId);
      if (index < 0 || state.sheets.length < 2) return;
      if (state.activeSheetId === sheetId) showCameraSheet(id, state.sheets[index + 1] ?? state.sheets[index - 1]);
      state.sheets.splice(index, 1);
    });
  }
  function moveCameraSheet(id, sheetId, beforeId) {
    changeCameraPresentation(id, () => {
      const state = cameraSheetState(id), sheet = state.sheets.find(item => item.id === sheetId);
      if (!sheet) return;
      const rest = state.sheets.filter(item => item !== sheet), index = rest.findIndex(item => item.id === beforeId);
      rest.splice(index < 0 ? rest.length : index, 0, sheet);
      state.sheets = rest;
    });
  }
  function setCameraSheetView(id, view) {
    if (cameraSheetView(id) !== view) changeCameraPresentation(id, () => { activeCameraSheet(id).view = view; });
  }
  // The host calls every count "rows", so a tab counts the rows it actually has.
  function cameraSheetRowCount(id, sheet) {
    if (sheet.view !== 'columns') return cameras.filter(camera => camera.device === id).length;
    const hidden = new Set(sheet.hidden);
    return cameraSheetSections().filter(section => !sheet.layout.hiddenGroups.includes(section.id)).reduce((count, section) => {
      const collapsed = sheet.layout.groups[section.axis]?.collapsed ?? [];
      return count + section.fields.filter(field => section.axis && !sheet.expanded[section.axis] ? collapsed.includes(field.id) : !hidden.has(field.id)).length;
    }, 0);
  }
  function cameraSheetBarState(id) {
    const { activeSheetId } = cameraSheetState(id), sheets = cameraSheetList(id);
    return { sheets: sheets.map(sheet => ({ id: sheet.id, name: sheet.name })), activeSheetId, counts: new Map(sheets.map(sheet => [sheet.id, cameraSheetRowCount(id, sheet)])) };
  }
  // The tab on screen is saved in the existing layout fields, so an older version of
  // this module still opens the workspace showing that tab.
  function cameraSheetsRecord(id, sheets, activeSheetId) {
    return { activeSheetId, sheets: sheets.map(({ layout, hidden, expanded, ...sheet }) => sheet.id === activeSheetId ? sheet : { ...sheet, layout: pruneCameraLayout(id, layout), hidden, expanded }) };
  }
  function saveCameraSheets() {
    return Object.fromEntries(devices.map(d => [d.id, cameraSheetsRecord(d.id, cameraSheetList(d.id), cameraSheetState(d.id).activeSheetId)]));
  }
  function restoreCameraSheets(data) {
    for (const id of Object.keys(cameraSheetsByDevice)) delete cameraSheetsByDevice[id];
    const known = new Set(cameraSheetSections().flatMap(section => section.fields.map(field => field.id)));
    for (const d of devices) {
      const saved = data.cameraSheetsByDevice?.[d.id];
      if (!Array.isArray(saved?.sheets)) continue;
      const sheets = [];
      for (const sheet of saved.sheets) {
        const name = typeof sheet?.name === 'string' ? sheet.name.trim() : '';
        if (typeof sheet?.id !== 'string' || !sheet.id || !name || sheets.some(item => item.id === sheet.id)) continue;
        const expanded = Object.fromEntries(cameraAxes.map(axis => [axis, sheet.expanded?.[axis] === true]));
        sheets.push({ id: sheet.id, name, view: sheet.view === 'columns' ? 'columns' : 'rows', layout: cleanCameraLayout(d.id, sheet.layout), hidden: Array.isArray(sheet.hidden) ? sheet.hidden.filter(field => known.has(field)) : [], expanded });
      }
      if (!sheets.length) continue;
      const active = sheets.find(sheet => sheet.id === saved.activeSheetId);
      cameraSheetsByDevice[d.id] = { activeSheetId: (active ?? sheets[0]).id, sheets };
      if (!active) showCameraSheet(d.id, sheets[0]);
    }
  }
  function cameraCellPosition(deviceId, cameraId, field) {
    const flipped = cameraSheetView(deviceId) === 'columns';
    return ' data-camera="' + esc(cameraId) + '" data-hubble-column="' + esc(flipped ? cameraId : field) + '" data-hubble-row="' + esc(flipped ? field : cameraId) + '"';
  }
  function cameraViewControl(id) {
    const button = (view, label) => '<button type="button" data-action="camera-view" data-id="' + esc(id) + '" data-view="' + view + '" aria-pressed="' + (cameraSheetView(id) === view) + '">' + label + '</button>';
    return '<div class="hc-segment hc-camera-view" role="group" aria-label="Sheet layout for this tab">' + button('rows', 'Cameras in rows') + button('columns', 'Cameras in columns') + '</div>';
  }
  function paintCameraView(strip, id) {
    const view = cameraSheetView(id);
    strip.querySelectorAll('[data-action="camera-view"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  }
  const cameraHeading = camera => '<strong>' + esc(camera.number) + '</strong><span>' + esc(camera.name) + '</span>';
  function cameraColumnSection(field) {
    if (field.group) return { id: field.group, label: axisName(field.group), axis: field.group };
    if (field.id === 'sync') return { id: 'sync', label: 'Sync' };
    if (field.id === 'lens' || field.id === 'connection') return { id: 'lens', label: 'Lens' };
    return { id: 'camera', label: 'Camera' };
  }
  function flippedCameraGrid(rows, columns, deviceId, cell) {
    const layout = cameraLayout(deviceId), width = camera => layout.cameraWidths?.[camera.id] ?? 168;
    const fields = columns.filter(column => column.id !== 'row').map(({ frozen, ...field }) => ({ ...field, label: cameraSortLabels[field.id] ?? field.label }));
    const frozen = ' class="hc-camera-frozen" style="left:0"';
    const head = '<colgroup><col style="width:' + (layout.settingWidth ?? 190) + 'px">' + rows.map(camera => '<col data-hubble-column="' + esc(camera.id) + '" data-label="Camera ' + esc(camera.number) + '" style="width:' + width(camera) + 'px">').join('') + '</colgroup>' +
      '<thead><tr><th scope="col"' + frozen + ' data-setting-header>Setting</th>' + rows.map(camera => '<th scope="col" data-camera-header="' + esc(camera.id) + '" title="' + esc(camera.name) + '"><div class="hc-camera-heading" data-camera-heading="' + esc(camera.id) + '">' + cameraHeading(camera) + '</div></th>').join('') + '</tr></thead>';
    let section = null, body = '';
    for (const field of fields) {
      const band = cameraColumnSection(field);
      if (band.id !== section) {
        section = band.id;
        body += '<tr class="hc-camera-section-row"><td class="hc-camera-frozen hc-camera-section-label" style="left:0" role="rowheader">' + (band.axis ? '<div data-axis-header="' + band.axis + '"></div>' : esc(band.label)) + '</td>' + (rows.length ? '<td class="hc-camera-section-rest" colspan="' + rows.length + '"></td>' : '') + '</tr>';
      }
      if (field.placeholder) continue;
      body += '<tr data-setting="' + field.id + '"><td class="hc-camera-frozen hc-camera-setting-label" style="left:0" role="rowheader"' + cameraSortAria(field, deviceId) + '>' + cameraSortHeading(field, deviceId) + '</td>' + rows.map(camera => { initializeLensFields(camera); return cell(camera, field); }).join('') + '</tr>';
    }
    return head + '<tbody>' + body + '</tbody>';
  }
  // Cameras as columns have no row of their own, so their cells are found by camera.
  function paintCameraColumn(item) {
    const id = CSS.escape(item.id);
    root.querySelectorAll('tr[data-setting] td[data-camera="' + id + '"]').forEach(cell => {
      const control = cell.querySelector('[data-field]');
      if (control) cell.classList.toggle('hc-changed', item.dirty.has(control.dataset.field));
      if (item.deleting) cell.querySelectorAll('[data-field],input[data-lens-axis]').forEach(element => { element.disabled = true; });
    });
    root.querySelectorAll('[data-camera-heading="' + id + '"]').forEach(heading => {
      const markup = cameraHeading(item);
      if (heading.innerHTML !== markup) heading.innerHTML = markup;
      heading.closest('th').title = item.name;
    });
  }
  function flippedResizeItems(table) {
    return [
      ...[...table.querySelectorAll('th[data-setting-header],th[data-camera-header]')].map(header => {
        const camera = header.dataset.cameraHeader;
        return { id: camera ?? settingHeaderId, header, axis: 'column', label: camera ? 'camera ' + (cameras.find(item => item.id === camera)?.number ?? '') : 'setting names', size: header.offsetWidth, min: camera ? 72 : 100, max: 640 };
      }),
      ...[...table.tBodies[0].querySelectorAll('tr[data-setting]')].map(row => ({ id: row.dataset.setting, header: row.cells[0], axis: 'row', label: (cameraSortLabels[row.dataset.setting] ?? 'Use ' + axisName(row.dataset.setting.replace(/Summary$/, ''))) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
    ];
  }
  function resizeFlippedSheet(id, item, axis, size) {
    const layout = cameraLayout(id);
    if (axis === 'row') (layout.settingHeights ??= {})[item] = size;
    else if (item === settingHeaderId) layout.settingWidth = size;
    else (layout.cameraWidths ??= {})[item] = size;
  }
  root.querySelector('#hc-cameras .hc-panel-foot .hc-caption').textContent = 'Each tab keeps its own settings and layout';
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-action="camera-view"]');
    if (button) setCameraSheetView(button.dataset.id, button.dataset.view);
  });

  const cameraSortByDevice={};
  const cameraSortFields=cameraColumnSections().flatMap(section=>section.fields.filter(field=>!field.summary).map(field=>field.id));
  const cameraSortLabels=Object.fromEntries(cameraColumnSections().flatMap(section=>section.fields.filter(field=>!field.summary).map(field=>[field.id,field.label])));
  function cameraSort(id){return cameraSortByDevice[id]||(cameraSortByDevice[id]={field:'number',direction:'asc'});}
  function sortCameraValue(camera,field){
    if(field==='controlEnabled')return cameraControlEnabled(camera)?'1':'0';
    if(field==='model'&&importedCamera(camera))return remiModelName(camera);
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
    if(!cameraSortFields.includes(column.id))return column.label;
    const sort=cameraSort(id),label=cameraSortLabels[column.id]||column.label;
    return '<button class="hc-sort-heading" data-action="sort-cameras" data-id="'+id+'" data-sort-field="'+column.id+'" aria-label="Sort by '+esc(label)+'">'+column.label+(sort.field===column.id?'<span aria-hidden="true">'+(sort.direction==='asc'?'↑':'↓')+'</span>':'')+'</button>';
  }
  function restoreCameraSorting(data){
    for(const[id,sort]of Object.entries(data.cameraSortByDevice||{}))if(device(id)&&sort&&cameraSortFields.includes(sort.field)&&['asc','desc'].includes(sort.direction))cameraSortByDevice[id]={field:sort.field,direction:sort.direction};
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="sort-cameras"]');if(!button)return;
    const id=button.dataset.id,field=button.dataset.sortField,previous=cameraSort(id);
    cameraSortByDevice[id]={field,direction:previous.field===field&&previous.direction==='asc'?'desc':'asc'};
    renderCameras();remember();root.querySelector('[data-controller="'+id+'"] [data-sort-field="'+field+'"]')?.focus({preventScroll:true});
  });

  function plainRow(item){const {deleting,...saved}=item;return {...saved,dirty:[...(item.dirty||[])],jobs:0};}
  function snapshotPlan(uiState){return {formatVersion:1,devices:devices.map(({modelCatalog,models,lensOptions,snapshot,...item})=>({...item})),cameras:cameras.map(plainRow),lans:lans.map(plainRow),uiState};}
  function persistPlan(uiState){
    const sequence=++saveSequence;persistence='saving';syncSummary();
    const plan=copyPresentation(snapshotPlan(uiState)),ticket=presentationLedger.ticket();
    return moduleBridge.save(()=>repairPresentationPlan(plan,ticket),()=>presentationLedger.saved(ticket),()=>rejectPresentation(ticket)).then(()=>{if(sequence===saveSequence){persistence='saved';syncSummary();}}).catch(error=>{if(sequence===saveSequence){persistence='failed';syncSummary();}toast(error.message||'Changes could not be saved');});
  }
  function restoredRow(row){
    const dirty=new Set(row.dirty||[]);
    const restored={...row,deleting:false,dirty,revision:Number(row.revision||0),jobs:0};
    if(row.lens!==undefined&&!Array.isArray(row.enabledLensAxes)){
      restored.enabledLensAxes=[...new Set([...dirty].map(lensAxisForField).filter(Boolean))];
    }
    return restored;
  }
  // Earlier versions stored made-up motor and limit values on every camera, even with the axis off.
  const formerLensDefaults={irisMotor:'3',zoomMotor:'5',focusMotor:'2',irisMin:'1.6',irisMax:'32',irisTorque:'2',zoomTorque:'2',focusTorque:'2',irisDirection:'left',zoomDirection:'left',focusDirection:'left'};
  function withoutFormerLensDefaults(row){
    for(const [field,value] of Object.entries(formerLensDefaults)){
      if(row[field]===value&&!row.dirty.has(field)&&!row.enabledLensAxes?.includes(lensAxisForField(field)))delete row[field];
    }
    return row;
  }
  const manualDiscoveries=new Map();let scanDiscoveries=[],addingDiscovered=false;
  function mergeDiscoveries(){
    const merged=new Map();
    for(const candidate of [...scanDiscoveries,...manualDiscoveries.values()]){const previous=merged.get(candidate.serial);merged.set(candidate.serial,{...previous,...candidate,addresses:[...new Set([...(previous?.addresses||[]),...(candidate.addresses||[]),candidate.address].filter(Boolean))]});}
    results=[...merged.values()];renderResults();
  }
  function applyReceipts(plan){
    for(const collection of ['cameras','lans'])for(const saved of plan[collection]||[]){const local=(collection==='cameras'?cameras:lans).find(item=>item.id===saved.id);if(local)for(const field of ['elementKey','newElementKey','createState','needsInitialization'])if(saved[field]!==undefined)local[field]=saved[field];}
  }
  let liveObservations={};
  // Online and Offline only come from something that answered, or from a connection that was tried and failed.
  // An RCP, RIO or Gateway reads only from its MQTT connection.
  function controllerConnection(d){return (cameraControlDevice(d)?cameraControlState.controllers?.[d.id]:null)??null;}
  function cameraConnection(camera,controller){
    // Status reads the same MQTT state, so the two columns can't disagree.
    const reported=cameraControlDevice(controller)?cameraControlState.cameras?.[camera.id]?.online:null;
    return typeof reported==='boolean'?reported:controller?.online===false?false:null;
  }
  function connectionNote(d){
    if(d.online==null)return 'Not checked yet';
    if(!d.online)return 'Last reported offline';
    return 'Connected at '+(d.address||d.base);
  }
  function uncheckedCount(rows,separator){const count=rows.filter(row=>row.online==null).length;return count?separator+count+' not checked':'';}
  function syncConnections(){
    if(!moduleBridge||moduleBridge.preview)return;
    for(const d of devices){
      d.online=controllerConnection(d);d.lastSeen=liveObservations[d.id]?.lastSeen||d.lastSeen;
      const markup=status(d.online);
      root.querySelectorAll('[data-controller="'+d.id+'"] .hc-controller-header > .hc-status,[data-network-controller="'+d.id+'"] .hc-controller-header > .hc-status').forEach(mark=>{if(mark.outerHTML!==markup)mark.outerHTML=markup;});
      const note=root.querySelector('[data-controller="'+d.id+'"] [data-connection-note]');if(note)note.textContent=connectionNote(d);
    }
    const rows=new Map();
    for(const camera of cameras){camera.online=cameraConnection(camera,device(camera.device));rows.set(camera.id,camera);}
    root.querySelectorAll('td[data-column="control"]').forEach(cell=>{
      const camera=rows.get(cell.dataset.camera);if(!camera)return;
      const markup=status(camera.online);if(cell.innerHTML!==markup)cell.innerHTML=markup;
    });
  }
  async function initializeBackend(){
    const methodField=document.createElement('label');methodField.className='hc-field';methodField.innerHTML='<span>Discovery method</span><select data-role="discovery-method" aria-label="Discovery method"><option value="ping">Fast IP discovery</option><option value="broadcast">Broadcast discovery</option><option value="ip">Full IP scan</option></select>';
    action('scan').before(methodField);ui.discoveryMethod='ping';ui.discoveryVersion=2;
    $('discovery-method').addEventListener('change',()=>{ui.discoveryMethod=$('discovery-method').value;remember();});
    try{
      const plan=await moduleBridge.read();
      applyCameraControlState(await moduleBridge.controlState());
      await restoreCameraChoiceCatalogs();
      if(plan){devices.splice(0,devices.length,...plan.devices);cameras=(plan.cameras||[]).map(row=>withoutFormerLensDefaults(restoredRow(row)));lans=(plan.lans||[]).map(restoredRow);deviceOrder=devices.map(item=>item.id);openControllers.clear();openNetworkDevices.clear();if(devices[0]){openControllers.add(devices[0].id);openNetworkDevices.add(devices[0].id);}discoveryCard.open=!devices.length;syncConnections();syncFilter();renderLans();renderCameras();if(plan.uiState)restore(plan.uiState);}
      moduleBridge.onReceipt(applyReceipts);
      moduleBridge.subscribe(applyLiveState);
      if(plan?.uiState?.privateContent?.ui?.discoveryVersion!==2&&ui.discoveryMethod==='broadcast')ui.discoveryMethod='ping';
      $('discovery-method').value=['ping','ip','broadcast'].includes(ui.discoveryMethod)?ui.discoveryMethod:'ping';
      persistence='saved';syncSummary();
    }catch(error){devices.splice(0);cameras=[];lans=[];renderLans();renderCameras();toast(error.message||'Configuration could not be loaded');}
    root.hidden=false;icons();
  }
  function modelChoices(camera){const catalog=device(camera.device)?.modelCatalog;return [...new Set(['Choose model…',...(catalog?.length?catalog.map(item=>String(item.label).replace(/^Sony\s*-\s*/,'')):['Venice-IP','Alpha-USB','Alpha-IP','Sony FX6','Sony FX9','Sony FR7']),camera.model])];}
  function mergeSnapshot(snapshot){
    const current=device(snapshot.device.id);if(!current)return;
    // A snapshot is a one-off read, so it says nothing about live status.
    const savedName=current.name,online=current.online;Object.assign(current,snapshot.device);current.online=online;if(savedName&&savedName!==current.serial)current.name=savedName;
    for(const [name,remoteRows] of [['cameras',snapshot.cameras||[]],['lans',snapshot.lans||[]]]){
      const collection=name==='cameras'?cameras:lans;
      for(const remote of remoteRows){
        let local=collection.find(item=>item.device===current.id&&item.elementKey===remote.elementKey);
        if(local){
          const changingLens=name==='cameras'&&local.dirty.has('lens')&&local.lens!==remote.lens;
          for(const [field,value]of Object.entries(remote)){
            if(['id','device','dirty','pending','result','revision','jobs','online'].includes(field)||local.dirty.has(field))continue;
            if(changingLens&&(isLensSetting(field)||field.startsWith('lensParams')))continue;
            local[field]=value;
          }
          if(!local.pending)local.result=remote.result;
        }
        else{const row=restoredRow(remote);while(collection.some(item=>item.id===row.id))row.id+='-observed';collection.push(row);}
      }
      for(let index=collection.length-1;index>=0;index--){const local=collection[index];if(local.device===current.id&&local.elementKey&&!local.pending&&!local.jobs&&!remoteRows.some(item=>item.elementKey===local.elementKey))collection.splice(index,1);}
    }
  }
  function applyLiveState(values){
    if(values.observations)liveObservations=values.observations;
    if(values.cameraControl)applyCameraControlState(values.cameraControl);
    if(moduleBridge.preview)return;
    syncConnections();
    syncSummary();
    for(const candidate of values.lookupResults||[])manualDiscoveries.set(candidate.serial,candidate);
    if(values.lookupResults)mergeDiscoveries();
    const scan=values.discovery;if(!scan)return;
    const quick=scan.method==='broadcast',percent=quick?(scan.state==='scanning'?40:100):scan.total?Math.round(100*scan.checked/scan.total):0;
    root.querySelector('.hc-progress').hidden=quick;
    $('scan-progress').style.width=percent+'%';root.querySelector('.hc-progress').setAttribute('aria-valuenow',String(percent));
    $('scan-addresses').textContent=quick?(scan.results||[]).length+' found':scan.checked.toLocaleString()+' / '+scan.total.toLocaleString();
    $('scan-label').textContent=(quick?(scan.state==='scanning'?'Live discovery · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '):scan.method==='ping'?(scan.state==='scanning'?'Pinging IP addresses · ':scan.state==='complete'?'Discovery complete · ':'Discovery stopped · '):(scan.state==='scanning'?'Scanning IP addresses · ':scan.state==='complete'?'IP scan complete · ':'IP scan stopped · '))+scan.range;
    action('scan').disabled=scan.state==='scanning'&&!quick||!$('scan-range').value;action('stop-scan').hidden=scan.state!=='scanning';
    scanDiscoveries=scan.results||[];mergeDiscoveries();
    if(scan.error){$('discovery-error').textContent=scan.error;$('discovery-error').hidden=false;}
    if(!results.length&&scan.state!=='scanning')$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>'+(quick?'No Cyanview devices announced on this range':'No Cyanview devices found')+'</strong><span class="hc-caption">'+(quick?'Try Find by IP, or use Full IP scan for routed networks.':'Check the network range or try a known device IP.')+'</span></div>';
  }
  async function startLiveScan(){
    const range=$('scan-range').value==='custom'?$('custom-range').value.trim():$('scan-range').value;
    if(!range)return;
    $('discovery-error').hidden=true;scanDiscoveries=[];mergeDiscoveries();action('scan').disabled=true;action('stop-scan').hidden=false;
    if(!results.length)$('discovery-results').innerHTML='<div class="hc-state-empty"><strong>Looking for Cyanview devices…</strong></div>';
    try{await moduleBridge.scan(range,$('discovery-method').value);}catch(error){$('discovery-error').textContent=error.message;$('discovery-error').hidden=false;action('scan').disabled=false;action('stop-scan').hidden=true;}
  }
  async function probeLiveIP(){
    const address=$('manual-ip').value.trim();if(!ipv4(address)){$('discovery-error').textContent='Enter a valid IPv4 address.';$('discovery-error').hidden=false;return;}
    $('discovery-error').hidden=true;action('probe-ip').disabled=true;
    try{const reply=await moduleBridge.probe(address),candidate=reply.device;manualDiscoveries.set(candidate.serial,candidate);if(!devices.some(item=>item.serial===candidate.serial))selectedResults.add(candidate.id);$('scan-label').textContent='Device lookup complete · '+address;mergeDiscoveries();}
    catch(error){$('discovery-error').textContent=error.message;$('discovery-error').hidden=false;}
    finally{action('probe-ip').disabled=false;}
  }
  async function addLiveResults(){
    if(addingDiscovered)return;addingDiscovered=true;action('add-discovered').disabled=true;let count=0;
    try{for(const candidate of results.filter(item=>selectedResults.has(item.id)&&!devices.some(d=>d.serial===item.serial))){
      if(devices.length>=128)throw new Error('Controller capacity reached');
      const snapshot=await moduleBridge.importDevice(candidate);if(cameras.length+snapshot.cameras.length>512)throw new Error('Camera capacity reached');
      devices.push(snapshot.device);openNetworkDevices.add(snapshot.device.id);cameras.push(...snapshot.cameras.map(restoredRow));lans.push(...snapshot.lans.map(restoredRow));selectedResults.delete(candidate.id);count++;
    }}catch(error){toast(error.message);}
    if(count)await restoreCameraChoiceCatalogs();
    addingDiscovered=false;syncFilter();renderResults();renderLans();renderCameras();if(count)toast(count+' devices added');remember();
  }
  async function refreshLive(){
    action('refresh-all').disabled=true;
    try{const reply=await moduleBridge.refresh();for(const snapshot of reply.snapshots||[])mergeSnapshot(snapshot);await restoreCameraChoiceCatalogs();renderLans();renderCameras();applyLiveState({observations:reply.observations});const failed=(reply.failed||[]).map(id=>device(id)?.name||id);toast(failed.length?'Could not read '+(failed.length===1?failed[0]:failed.length+' controllers')+' · edits retained':'Settings refreshed · edits retained');remember();}
    catch(error){toast(error.message);}
    finally{action('refresh-all').disabled=false;}
  }

  const remiPanels = new Map();
  const remiMenu = '__remi__';
  let remiReview = '';
  const remiGroup = id => root.querySelector('[data-controller="'+id+'"]');
  const importedCamera = row => !!row.remi || [row.modelLabel,row.model].some(label => /^cyan\s*-\s*imported$/i.test(String(label||'').trim()));
  const remiModelName = row => row.remi?.origin?.model || row.name || 'Remote camera';
  const remiPeers = id => orderedDevices().filter(item => item.id !== id);
  const remiDeviceName = peer => devices.find(item => item.serial.toLowerCase() === String(peer || '').toLowerCase())?.name || peer || 'Remote source';
  function remiPanelState(id) {
    if (!remiPanels.has(id)) remiPanels.set(id, {
      source: remiPeers(id)[0]?.id || '', drafts: new Map(), overrides: {}, picks: new Set(),
      data: null, open: false, settings: false, busy: false, loading: false, error: '', retry: false,
    });
    return remiPanels.get(id);
  }
  function saveRemiDrafts() {
    return Object.fromEntries([...remiPanels].filter(([id,state]) => device(id) &&
      (state.drafts.size || Object.keys(state.overrides).length)).map(([id,state]) =>
      [id,{ drafts:[...state.drafts.values()], overrides:state.overrides }]));
  }
  function restoreRemiDrafts(data) {
    for (const [id,value] of Object.entries(data.remiDrafts || {})) {
      if (!device(id) || !value || !Array.isArray(value.drafts)) continue;
      const state = remiPanelState(id);
      state.drafts = new Map(value.drafts.filter(item => item?.id && ['camera','remove','tag'].includes(item.kind)).map(item => [item.id,item]));
      state.overrides = Object.fromEntries(Object.entries(value.overrides || {}).filter(([source,address]) => device(source) && typeof address === 'string' && ipv4(address)));
    }
  }
  function remiButton(name,label,disabled=false,extra='') {
    return '<button type="button" class="hc-button" data-remi-action="'+name+'"'+(disabled?' disabled':'')+extra+'>'+label+'</button>';
  }
  function remiDraw(id, panel) {
    if (!panel) return;
    const state = remiPanelState(id), source = device(state.source), data = state.data;
    state.settings = panel.querySelector('details')?.open ?? state.settings;
    const unavailable = state.busy || state.loading || !data || !!data.refreshes.length || state.retry;
    const rows = data?.cameras || [], tags = data?.tags;
    const peers = remiPeers(id).map(item => {
      const duplicate = devices.some(other => other.id !== item.id && other.id !== id && other.kind === item.kind && other.name === item.name);
      return {id:item.id,label:item.name+' · '+item.kind+(duplicate?' · '+item.serial:'')};
    });
    const cameraChange = row => state.drafts.get('camera:'+state.source+':'+row.key) ||
      (row.localKey && state.drafts.get('remove:'+row.localKey));
    const wanted = row => cameraChange(row)?.enable ?? row.assigned;
    const can = (enable, selected) => rows.some(row => !row.ambiguous && (!selected || state.picks.has(row.key)) && wanted(row) !== enable);
    const tagNames = new Set([...(tags || []), ...[...state.drafts.values()].filter(item => item.kind === 'tag').map(item => item.tag)]);
    panel.innerHTML =
      '<div class="hc-remi-row"><strong>REMI cameras</strong><span class="hc-caption">Receiving on '+esc(device(id).name)+'</span><span class="hc-right"></span>'+
        remiButton('refresh','Refresh source',state.loading||state.busy)+remiButton('close','Close',state.busy)+'</div>'+
      '<div class="hc-remi-row"><label>Source <select data-remi-source aria-label="REMI source"'+(state.busy?' disabled':'')+'>'+
        (peers.length?options(peers,state.source):'<option>Add a source in Devices</option>')+'</select></label>'+
        '<span class="hc-caption">'+esc(state.loading?'Loading cameras…':data?rows.length+' cameras on source':'')+'</span></div>'+
      (state.error?'<div class="hc-remi-row"><span class="hc-error" role="alert">'+esc(state.error)+'</span>'+
        (data?.addresses.length?remiButton('source-ip','Change source IP',state.busy):'')+'</div>':'')+
      (data?.refreshes.length||state.retry?'<div class="hc-remi-row"><span class="hc-pending-text">REMI refresh pending</span>'+
        remiButton('retry','Retry REMI refresh',state.busy)+'</div>':'')+
      (rows.length?'<div class="hc-remi-catalog"><table class="hc-grid" aria-label="Remote cameras">'+
        '<colgroup><col style="width:28px"><col style="width:38px"><col><col style="width:112px"><col style="width:72px"></colgroup>'+
        '<thead><tr><th></th><th>#</th><th>Camera name</th><th>On receiver</th><th></th></tr></thead><tbody>'+
        rows.map(row => {
          const draft = cameraChange(row), label = row.ambiguous?'Ambiguous':draft?(draft.enable?'Pending add':'Pending removal'):row.assigned?'Added':'Available';
          return '<tr><td class="hc-check"><input type="checkbox" data-remi-pick="'+esc(row.key)+'" aria-label="Select camera '+esc(row.number+' '+row.name)+'"'+
            (state.picks.has(row.key)?' checked':'')+(unavailable||row.ambiguous?' disabled':'')+'></td><td>'+esc(row.number)+'</td><td>'+esc(row.name)+
            '</td><td class="'+(draft?'hc-pending-text':row.assigned?'hc-online':'hc-muted')+'">'+label+'</td><td>'+
            remiButton('camera',draft?'Undo':row.assigned?'Remove':'Add',unavailable||row.ambiguous,' data-key="'+esc(row.key)+'"')+'</td></tr>';
        }).join('')+'</tbody></table></div><div class="hc-remi-row">'+remiButton('add-selected','Add selected',unavailable||!can(true,true))+
        remiButton('add-all','Add all',unavailable||!can(true,false))+remiButton('remove-selected','Remove selected',unavailable||!can(false,true))+
        remiButton('remove-all','Remove all',unavailable||!can(false,false))+'</div>':'')+
      '<details class="hc-remi-settings"'+(state.settings?' open':'')+'><summary>REMI settings</summary>'+
        (source?'<div class="hc-remi-row"><label>Source IP <select data-remi-address aria-label="Source IP"'+(state.busy?' disabled':'')+'><option value="">Automatic</option>'+
          options((data?.addresses||[]).map(address => ({id:address,label:address+(address===source.base?' · Factory':'')})),state.overrides[source.id])+'</select></label></div>':'')+
        '<div class="hc-remi-row"><span class="hc-caption">REMI tags</span>'+
        [...tagNames].map(tag => '<span class="hc-remi-chip">'+esc(tag)+
          remiButton('tag-remove','×',state.busy,' data-tag="'+esc(tag)+'" aria-label="Remove or undo tag '+esc(tag)+'"')+'</span>').join('')+
        (Array.isArray(tags)?'<input class="hc-input" data-remi-tag aria-label="New REMI tag" placeholder="New tag" maxlength="160">'+
          remiButton('tag-add','Add tag',state.busy):'<span class="hc-caption">Tags unavailable</span>')+'</div></details>';
    icons();
  }
  async function remiLoad(id) {
    const state = remiPanelState(id);
    if (!moduleBridge || moduleBridge.preview) {
      state.error = 'REMI is available for managed devices.';
      remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
      return;
    }
    if (!device(state.source)) state.source = remiPeers(id)[0]?.id || '';
    const source = state.source, request = Symbol();
    state.request = request;
    state.loading = true;
    state.error = '';
    state.data = null;
    remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
    try {
      const data = await moduleBridge.remiState({receiver:id,source});
      if (state.request !== request) return;
      state.data = data;
      state.retry = !!data.refreshes.length;
    } catch (error) {
      if (state.request === request) state.error = error.message || 'REMI cameras could not be read';
    } finally {
      if (state.request === request) {
        state.loading = false;
        remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
      }
    }
  }
  function remiOpen(id) {
    const state = remiPanelState(id);
    state.open = true;
    renderCameras();
    void remiLoad(id);
  }
  async function remiRefreshSheets() {
    const result = await moduleBridge.refresh();
    for (const snapshot of result.snapshots || []) mergeSnapshot(snapshot);
    applyLiveState({observations:result.observations});
    renderLans();
    renderCameras();
    remember();
    await Promise.all([...remiPanels].filter(([id,state]) => state.open && device(id)).map(([id]) => remiLoad(id)));
  }
  async function remiSend(id, items, retry = false) {
    const state = remiPanelState(id);
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    syncSummary();
    remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
    try {
      const report = await moduleBridge.remiSend({receiver:id,items,...(retry?{operation:'retry'}:{})});
      for (const result of report.results || []) {
        const sent = items.find(item => item.id === result.id);
        if (sent && result.verified && state.drafts.get(sent.id) === sent) state.drafts.delete(sent.id);
      }
      if (report.snapshot) mergeSnapshot(report.snapshot);
      if (report.refresh) await remiRefreshSheets();
      if (state.open) await remiLoad(id);
      const failed = report.results?.filter(item => item.error) || [];
      state.error = failed.length ? failed[0].error : '';
      toast(failed.length ? state.error : retry ? 'REMI refresh complete' : 'REMI changes verified');
    } catch (error) {
      state.error = error.message || 'REMI changes could not be confirmed';
      toast(state.error);
    } finally {
      state.busy = false;
      renderCameras();
      remember();
    }
  }
  function remiStage(id, items) {
    const state = remiPanelState(id);
    for (const item of items) {
      if (item.kind === 'camera' && item.enable === item.assigned) state.drafts.delete(item.id);
      else state.drafts.set(item.id,item);
    }
    renderCameras();
    remember();
    if (ui.sendMode === 'Auto send') {
      const pending = items.filter(item => state.drafts.get(item.id) === item);
      if (pending.length) void remiSend(id,pending);
    }
  }
  function remiShowReview(id) {
    remiReview = id;
    const drafts = [...remiPanelState(id).drafts.values()];
    const local = pendingCameras(id);
    const changes = [...drafts.map(item => {
      if (item.kind === 'tag') return item.enable?'Add REMI tag':'Remove REMI tag';
      return (item.enable?'Import ':'Remove ')+item.label+(item.source&&device(item.source)?' · '+device(item.source).name:'');
    }), ...local.map(row => 'Update camera '+row.number+' · '+row.name)];
    $('modal-layer').innerHTML = '<section class="hc-modal" role="dialog" aria-modal="true" aria-label="Send camera changes">'+
      '<div class="hc-modal-head"><div><h3>Send camera changes</h3><p>'+esc(device(id).name)+'</p></div>'+
      '<button data-action="close-modal" aria-label="Close">'+icon('x')+'</button></div>'+
      '<div class="hc-modal-body">'+changes.map(label => '<div class="hc-change-item">'+esc(label)+'</div>').join('')+'</div>'+
      '<div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button>'+
      '<button class="hc-primary" data-remi-apply>Send '+changes.length+(changes.length===1?' change':' changes')+'</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('[data-remi-apply]').focus();
  }
  const syncCameraSummary = syncSummary;
  syncSummary = function() {
    syncCameraSummary();
    let total = 0;
    for (const [id,state] of remiPanels) {
      const group = remiGroup(id);
      if (!group) continue;
      const pending = state.drafts.size+pendingCameras(id).length;
      total += state.drafts.size;
      if (state.drafts.size || state.busy || state.retry) {
        group.querySelector('[data-controller-pending]').textContent = state.retry?'REMI refresh pending':state.busy?'Sending REMI changes':pending+' pending';
        const send = group.querySelector('[data-action="send-controller"]');
        send.disabled = !pending || state.busy || cameras.some(row => row.device===id&&row.jobs);
        send.querySelector('span').textContent = pending;
      }
    }
    if (total) {
      $('pending-summary').textContent = (total+pendingCameras().length+pendingLans().length)+' changes pending';
      $('pending-summary').classList.add('hc-changes-label');
    }
  };
  const renderCameraSheets = renderCameras;
  renderCameras = function() {
    const focus = cameraSheetFocus();
    for (const panel of root.querySelectorAll('[data-remi-panel]')) {
      const state = remiPanelState(panel.dataset.remiPanel);
      state.settings = panel.querySelector('details')?.open ?? state.settings;
    }
    renderCameraSheets();
    for (const item of devices) {
      const group = remiGroup(item.id);
      if (!group) continue;
      group.querySelector('[data-new-camera]').add(new Option('REMI cameras…',remiMenu),1);
      const state = remiPanels.get(item.id);
      if (state?.open) {
        const panel = document.createElement('section');
        panel.className = 'hc-remi-panel';
        panel.dataset.remiPanel = item.id;
        panel.setAttribute('aria-label','REMI on '+item.name);
        group.querySelector('.hc-controller-tools').after(panel);
        remiDraw(item.id,panel);
      }
      for (const row of cameras.filter(row => row.device===item.id&&importedCamera(row))) {
        const selector = 'td[data-camera="'+CSS.escape(row.id)+'"]';
        for (const field of group.querySelectorAll(selector+' [data-field]:not([data-field="controlEnabled"])')) field.disabled = true;
        const model = group.querySelector(selector+'[data-column="model"]');
        if (model) {
          const origin = row.remi?.origin, camera = remiModelName(row);
          const source = remiDeviceName(origin?.serial || row.remi?.peer || row.remiPeer);
          model.innerHTML = '<span class="hc-remi-model" title="'+esc(camera+' · '+source)+'">'+
            '<span data-remi-model>'+esc(camera)+'</span><span class="hc-caption" data-remi-model-source>'+esc(source)+'</span></span>';
        }
      }
    }
    icons();
    refreshCameraSheets(focus);
  };
  root.addEventListener('change',event => {
    const input = event.target;
    if (input.dataset.newCamera && input.value===remiMenu) {
      event.stopImmediatePropagation();
      remiOpen(input.dataset.newCamera);
      remiGroup(input.dataset.newCamera)?.querySelector('[data-remi-source]')?.focus();
      return;
    }
    const panel = input.closest('[data-remi-panel]');
    if (!panel) return;
    const id = panel.dataset.remiPanel, state = remiPanelState(id);
    if (input.hasAttribute('data-remi-source')) {
      state.source = input.value;
      state.picks.clear();
      void remiLoad(id);
    } else if (input.hasAttribute('data-remi-address')) {
      if (input.value) state.overrides[state.source] = input.value;
      else delete state.overrides[state.source];
      for (const item of state.drafts.values()) if (item.kind==='camera' && item.source===state.source && item.enable) {
        item.address = input.value || '';
      }
      remember();
    } else if (input.dataset.remiPick) {
      const key = input.dataset.remiPick;
      if (input.checked) state.picks.add(key); else state.picks.delete(key);
      remiDraw(id,panel);
      [...panel.querySelectorAll('[data-remi-pick]')].find(input=>input.dataset.remiPick===key)?.focus();
    }
  },true);
  root.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-remi-apply')) {
      const id = remiReview;
      $('modal-layer').hidden = true;
      const local = pendingCameras(id);
      void remiSend(id,[...remiPanelState(id).drafts.values()]).then(() => {
        if (local.length) void sendItems(local,'camera');
      });
      return;
    }
    const id = button.dataset.id;
    if (button.dataset.action==='send-controller' && remiPanels.get(id)?.drafts.size) {
      event.stopImmediatePropagation();
      remiShowReview(id);
      return;
    }
    const panel = button.closest('[data-remi-panel]'), command = button.dataset.remiAction;
    if (!panel || !command) return;
    const receiver = panel.dataset.remiPanel, state = remiPanelState(receiver);
    if (command==='close') {
      state.open = false;
      renderCameras();
      remiGroup(receiver)?.querySelector('[data-new-camera]')?.focus();
    } else if (command==='refresh') void remiLoad(receiver);
    else if (command==='retry') void remiSend(receiver,[],true);
    else if (command==='source-ip') {
      panel.querySelector('details').open=true;
      panel.querySelector('[data-remi-address]')?.focus();
    }
    else if (command==='tag-add'||command==='tag-remove') {
      const enable = command==='tag-add', tag = enable?panel.querySelector('[data-remi-tag]').value.trim():button.dataset.tag;
      if (!tag || tag.includes(',')) { toast('Enter a tag without commas'); return; }
      const key = 'tag:'+tag;
      if (!enable && state.drafts.delete(key)) { renderCameras(); remember(); }
      else remiStage(receiver,[{id:key,kind:'tag',tag,enable}]);
    } else {
      const rows = state.data?.cameras || [];
      const make = (row,enable) => ({id:'camera:'+state.source+':'+row.key,kind:'camera',source:state.source,key:row.key,
        enable,assigned:row.assigned,address:state.overrides[state.source]||'',label:row.number+' · '+row.name});
      if (command==='camera') {
        const row = rows.find(row=>row.key===button.dataset.key);
        if (!row) return;
        const key = 'camera:'+state.source+':'+row.key;
        if (state.drafts.delete(key) || (row.localKey && state.drafts.delete('remove:'+row.localKey))) { renderCameras(); remember(); }
        else remiStage(receiver,[make(row,!row.assigned)]);
      } else {
        const enable = command.startsWith('add');
        const items = rows.filter(row => !row.ambiguous && (command.endsWith('all')||state.picks.has(row.key)) &&
          (state.drafts.get('camera:'+state.source+':'+row.key)?.enable??row.assigned)!==enable).map(row=>make(row,enable));
        remiStage(receiver,items);
      }
    }
  },true);

  function lensAxisForField(field){
    return /^(iris|zoom|focus)(Motor|Min|Max|Torque|Direction)$/.exec(field)?.[1];
  }
  function lensAxisForUseColumn(column){
    return /^(iris|zoom|focus)Summary$/.exec(column)?.[1];
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
      const known = field !== 'lensPort' || cameraChoiceCatalogs.has(context);
      if(device(camera.device)?.online === false) {
        if(!known) tell('Controller offline · its lens connections will list once it is reachable');
        return cameraCellChoices(camera,field);
      }
      const answered = ask();
      if(known) return cameraCellChoices(camera,field);
      return answered.then(() => {
        signal.throwIfAborted();
        tell(warning);
        return cameraCellChoices(camera,field);
      });
    };
  }

  const presentationLedger = new PresentationLedger();
  const cameraHistories = new Map();
  const copyPresentation = value => JSON.parse(JSON.stringify(value));
  function cameraHistory(id) {
    if (!cameraHistories.has(id)) cameraHistories.set(id, { undo: [], redo: [] });
    return cameraHistories.get(id);
  }
  function cameraPresentation(id) {
    return copyPresentation({ sheets: cameraSheetList(id) });
  }
  function applyCameraPresentation(id, value, preferred) {
    const state = cameraSheetState(id), sheets = copyPresentation(value.sheets);
    const find = sheetId => sheets.find(sheet => sheet.id === sheetId);
    state.sheets = sheets;
    showCameraSheet(id, find(preferred) ?? find(state.activeSheetId) ?? find(value.activeSheetId) ?? sheets[0]);
  }
  function recordCameraHistory(id, entry) {
    const history = cameraHistory(id);
    history.undo.push(entry); history.undo = history.undo.slice(-200); history.redo = [];
  }
  function changeCameraPresentation(id, change, redraw = true, record = true) {
    const before = cameraPresentation(id), activeBefore = cameraSheetState(id).activeSheetId;
    change();
    const after = cameraPresentation(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    // Which tab was open only matters if the change that opened another one fails.
    const epoch = presentationLedger.change('camera:' + id, { ...before, activeSheetId: activeBefore }, after);
    if (record) recordCameraHistory(id, { kind: 'layout', before, after, epoch, activeBefore, activeAfter: cameraSheetState(id).activeSheetId });
    if (redraw) renderCameras();
    else for (const [table, sheet] of cameraSheets) if (table.dataset.cameraDevice === id) sheet.refresh?.();
    remember();
    return epoch;
  }
  function repairPresentationPlan(plan, ticket) {
    const data = plan.uiState?.privateContent;
    if (!data) return plan;
    for (const { key, value } of presentationLedger.repairs(ticket)) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('camera:')) {
        const active = value.sheets.find(sheet => sheet.id === data.cameraSheetsByDevice?.[id]?.activeSheetId) ?? value.sheets[0];
        (data.cameraLayouts ??= {})[id] = copyPresentation(active.layout);
        (data.hiddenCameraColumnsByDevice ??= {})[id] = [...active.hidden];
        (data.axisGroupsByDevice ??= {})[id] = { ...active.expanded };
        (data.cameraSheetsByDevice ??= {})[id] = copyPresentation(cameraSheetsRecord(id, value.sheets, active.id));
      }
    }
    return plan;
  }
  function rejectPresentation(ticket) {
    const rejected = presentationLedger.failed(ticket);
    for (const { key, value, epochs } of rejected) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('camera:')) {
        applyCameraPresentation(id, value);
        const history = cameraHistory(id);
        for (const side of ['undo', 'redo']) history[side] = history[side].filter(entry => !epochs.includes(entry.epoch));
      }
    }
    if (rejected.length) renderCameras();
  }
  function cameraDraftSnapshot(rows) {
    const skipped = new Set(['id', 'device', 'dirty', 'pending', 'result', 'revision', 'jobs', 'online', 'deleting', 'elementKey', 'newElementKey', 'createState', 'needsInitialization']);
    return rows.map(row => ({ id: row.id, values: copyPresentation(Object.fromEntries(Object.entries(row).filter(([key]) => !skipped.has(key)))), dirty: [...row.dirty], pending: row.pending, result: row.result }));
  }
  function recordCameraDrafts(before, rows) {
    const after = cameraDraftSnapshot(rows), byDevice = new Map();
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      if (!next) continue;
      const fields = [...new Set([...Object.keys(old.values), ...Object.keys(next.values)])].filter(key => JSON.stringify(old.values[key]) !== JSON.stringify(next.values[key]));
      if (!fields.length) continue;
      const id = rows.find(row => row.id === old.id).device;
      if (!byDevice.has(id)) byDevice.set(id, []);
      byDevice.get(id).push({ before: old, after: next, fields });
    }
    for (const [id, patches] of byDevice) recordCameraHistory(id, { kind: 'cells', patches });
  }
  function cameraHistoryStep(id, direction) {
    const history = cameraHistory(id), forward = direction === 'redo';
    const from = history[forward ? 'redo' : 'undo'], to = history[forward ? 'undo' : 'redo'];
    const entry = from.at(-1);
    if (!entry) return;
    const source = forward ? 'before' : 'after', target = forward ? 'after' : 'before';
    if (entry.kind === 'layout') {
      if (JSON.stringify(cameraPresentation(id)) !== JSON.stringify(entry[source])) { toast('The sheet layout has changed; this history entry is no longer available'); return; }
      entry.epoch = changeCameraPresentation(id, () => applyCameraPresentation(id, entry[target], forward ? entry.activeAfter : entry.activeBefore), true, false);
    } else {
      for (const patch of entry.patches) {
        const row = cameras.find(row => row.id === patch[source].id);
        if (!row || row.jobs || row.deleting || patch.fields.some(field => JSON.stringify(row[field]) !== JSON.stringify(patch[source].values[field]) || row.dirty.has(field) !== patch[source].dirty.includes(field))) {
          toast('This camera has changed since the edit; its current settings are retained'); return;
        }
      }
      for (const patch of entry.patches) {
        const row = cameras.find(row => row.id === patch[target].id);
        for (const field of patch.fields) {
          if (field in patch[target].values) row[field] = copyPresentation(patch[target].values[field]); else delete row[field];
          if (patch[target].dirty.includes(field)) row.dirty.add(field); else row.dirty.delete(field);
        }
        row.pending = row.isNew || row.dirty.size > 0;
        row.result = row.pending ? 'Pending' : patch[target].result; row.revision++;
      }
      renderCameras(); remember();
    }
    from.pop(); to.push(entry);
  }

  const cameraSheets = new Map();
  const cameraAddresses = new Map();
  let spreadsheetUnavailable = false;
  const cameraAddress = cell => ({ rowId: cell.dataset.hubbleRow, columnId: cell.dataset.hubbleColumn });
  const cameraCellSelector = '[data-hubble-row][data-hubble-column]';
  const activeCameraCell = cameraCellSelector + '[data-hubble-spreadsheet-active="true"]';
  const cameraCellKey = ({ rowId, columnId }) => JSON.stringify([rowId, columnId]);
  const seriesFields = ['number', 'name', 'ip'];

  function activeCamera(table) {
    const cell = table?.querySelector(activeCameraCell);
    return cell && cameras.find(camera => camera.device === table.dataset.cameraDevice && camera.id === cell.dataset.camera);
  }

  function syncCameraDeleteButton(group) {
    const button = group.querySelector('[data-action="delete-controller"]');
    const camera = activeCamera(group.querySelector('table[data-camera-device]'));
    const label = button.querySelector('[data-camera-delete-label]');
    const text = camera?.number ? 'Delete camera ' + camera.number : 'Delete camera';
    if (label.textContent !== text) label.textContent = text;
    button.disabled = !camera || !!camera.deleting;
    button.title = camera ? camera.name : 'Select a camera cell to delete';
  }

  function reviewCameraDeletion(camera) {
    if (!camera || camera.deleting) return;
    if (importedCamera(camera) && !camera.remi) {
      toast('Refresh the REMI assignment before removing this camera');
      return;
    }
    showReview([camera], 'camera', true);
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }

  function deleteReviewedCamera(camera) {
    if (!camera || camera.deleting) return;
    if (!importedCamera(camera)) {
      void sendItems([camera], 'camera', true);
    } else if (camera.remi) {
      remiStage(camera.device, [{
        id: 'remove:' + camera.elementKey, kind: 'remove', key: camera.elementKey, enable: false,
        selector: camera.remi.selector, connection: camera.remi.connection, label: camera.name,
      }]);
    }
  }

  function cameraField(camera, column) {
    if (column === 'ip') return camera.model === 'Alpha-USB' ? 'usb' : 'ip';
    if (column === 'connection') return lensCapabilities(camera).ip ? 'lensIp' : 'lensPort';
    return column;
  }

  function cameraSheetFocus() {
    const element = document.activeElement;
    // Tabs and view buttons survive a redraw, but moving them drops their focus.
    if (element?.closest('[data-camera-selection],[data-camera-sheets]')) return { chrome: element };
    const table = element?.closest('table[data-camera-device]');
    if (!table) return null;
    const cell = element.closest(cameraCellSelector);
    const editor = element.matches('input[data-field].hc-cell-editing');
    if (editor) element.classList.remove('hc-cell-editing');
    return {
      deviceId: table.dataset.cameraDevice,
      address: cell ? cameraAddress(cell) : cameraAddresses.get(table.dataset.cameraDevice),
      editor: editor ? { value: element.value, start: element.selectionStart, end: element.selectionEnd } : null,
    };
  }

  function refreshCameraSheets(focus) {
    const tables = new Map([...root.querySelectorAll('table[data-camera-device]')].map(table => [table.dataset.cameraDevice, table]));
    for (const [table, sheet] of cameraSheets) {
      if (table.isConnected) { sheet.refresh?.(); continue; }
      const replacement = tables.get(table.dataset.cameraDevice);
      if (replacement && sheet.refresh) {
        // Keep the mounted grid and viewport so the host retains the range.
        const viewport = replacement.closest('.hc-scroll');
        const scrollLeft = viewport.scrollLeft;
        replacement.closest('.hc-sheet').querySelector('[data-camera-selection]').replaceWith(sheet.strip);
        replacement.closest('.hc-sheet').querySelector('[data-camera-sheets]').replaceWith(sheet.tabs);
        table.setAttribute('aria-label', replacement.getAttribute('aria-label'));
        table.replaceChildren(...replacement.childNodes);
        viewport.replaceWith(sheet.viewport);
        sheet.refresh(true);
        sheet.viewport.scrollLeft = scrollLeft;
        sheet.restoreFocus(focus);
        tables.set(table.dataset.cameraDevice, table);
        continue;
      }
      sheet.listeners.abort();
      sheet.menu?.dispose();
      sheet.layout?.dispose();
      sheet.presentation?.forEach(control => control.dispose());
      sheet.controls?.dispose();
      cameraSheets.delete(table);
    }
    for (const id of cameraAddresses.keys()) if (!device(id)) cameraAddresses.delete(id);
    if (focus?.chrome?.isConnected) focus.chrome.focus({ preventScroll: true });
    if (spreadsheetUnavailable) return;
    for (const table of tables.values()) {
      if (!cameraSheets.has(table)) void mountCameraSheet(table, focus);
    }
  }

  async function mountCameraSheet(table, focus) {
    const deviceId = table.dataset.cameraDevice;
    let rows, columns, cells, cameraById;
    const providers = new Map();
    const listeners = new AbortController();
    const sheet = { listeners, controls: null, viewport: table.closest('.hc-scroll'), strip: table.closest('.hc-sheet').querySelector('[data-camera-selection]'), tabs: table.closest('.hc-sheet').querySelector('[data-camera-sheets]'), presentation: [], scale: 1 };
    cameraSheets.set(table, sheet);

    function indexSheet() {
      const flipped = cameraSheetView(deviceId) === 'columns';
      const visibleRows = [...table.tBodies[0].rows].filter(row => flipped ? row.dataset.setting : row.dataset.id);
      const visibleColumns = [...table.querySelectorAll('col[data-hubble-column]')];
      rows = visibleRows.map(row => flipped ? row.dataset.setting : row.dataset.id);
      columns = visibleColumns.filter(col => col.dataset.hubbleColumn !== 'row').map(col => ({
        id: col.dataset.hubbleColumn,
        label: col.dataset.label,
        fill: seriesFields.includes(col.dataset.hubbleColumn) ? 'series' : 'copy',
      }));
      table.style.width = [...table.querySelectorAll('col')].reduce((width, col) => width + Number.parseInt(col.style.width, 10), 0) + 'px';
      const heights = flipped ? cameraLayouts.get(deviceId)?.settingHeights : cameraLayouts.get(deviceId)?.rows;
      for (const row of visibleRows) {
        const height = heights?.[flipped ? row.dataset.setting : row.dataset.id];
        if (height) row.style.setProperty('--hc-camera-row-height', height + 'px');
      }
      cells = new Map([...table.querySelectorAll(cameraCellSelector)].map(cell => [cameraCellKey(cameraAddress(cell)), cell]));
      cameraById = new Map(cameras.filter(camera => camera.device === deviceId).map(camera => [camera.id, camera]));
      for (const cell of cells.values()) {
        const input = cell.querySelector('input[data-field]');
        if (input) input.tabIndex = -1;
        if (!cell.querySelector('[data-field]:enabled,[data-hubble-boolean]')) cell.setAttribute('aria-readonly', 'true');
      }
      providers.clear();
    }
    indexSheet();

    function showSelection(address) {
      const strip = table.closest('.hc-sheet').querySelector('[data-camera-selection]');
      paintCameraSelectionSummary(strip, address && cells.get(cameraCellKey(address)));
      syncCameraDeleteButton(table.closest('[data-controller]'));
    }

    // Across cameras the host fills per column, but here it's the setting that decides.
    function selectedFill() {
      const selected = [...table.querySelectorAll('[data-hubble-spreadsheet-selected]')];
      return selected.length && selected.every(cell => seriesFields.includes(cell.dataset.column)) ? 'series' : 'copy';
    }
    // The host names a dropdown after its column, but across cameras that should be the setting.
    function flippedColumns() {
      const fill = selectedFill(), open = sheet.selected && cameraSortLabels[sheet.selected.field];
      return columns.map(column => ({ ...column, fill, label: open && column.id === sheet.selected.camera ? open : column.label }));
    }
    function logicalEdits(edits) {
      return cameraSheetView(deviceId) === 'columns' ? edits.map(({ rowId, columnId, ...edit }) => ({ ...edit, rowId: columnId, columnId: rowId })) : edits;
    }
    // Keep the same camera and setting selected when the sheet flips or changes tab.
    function followSelection() {
      if (!sheet.selected) return;
      const cell = table.querySelector('td[data-camera="' + CSS.escape(sheet.selected.camera) + '"][data-column="' + sheet.selected.field + '"]');
      const address = cell && cameraAddress(cell), current = cameraAddresses.get(deviceId);
      if (address && (!current || cameraCellKey(address) !== cameraCellKey(current))) sheet.controls.select(address, address, { focus: false });
    }

    function getCell(address) {
      const key = cameraCellKey(address);
      const cell = cells.get(key);
      const camera = cell && cameraById.get(cell.dataset.camera);
      if (!cell || !camera || cell.classList.contains('hc-axis-inactive')) return null;
      const axis = lensAxisForUseColumn(cell.dataset.column);
      if (axis) return { kind: 'boolean', value: lensAxisEnabled(camera, axis) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting };
      const control = cell.querySelector('[data-field]');
      if (!control) {
        return ['control', 'recording', 'cameraStatus', 'sync'].includes(cell.dataset.column)
          ? { value: cell.textContent.trim(), readOnly: true }
          : null;
      }
      if (control.disabled) return null;
      const field = control.dataset.field;
      if (field === 'controlEnabled') return { kind: 'boolean', value: cameraControlEnabled(camera) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting || !cameraControlDevice(device(camera.device)) };
      const value = String(camera[field] ?? (field === 'usb' ? 'USB · Automatic' : ''));
      if (camera.deleting || importedCamera(camera)) return { value, readOnly: true };
      if (!control.hasAttribute('data-camera-choice')) return { value };
      const context = choiceContext(camera, field);
      if (!context || !moduleBridge || moduleBridge.preview || !camera.elementKey) {
        return { value, choices: cameraCellChoices(camera, field) };
      }
      let provider = providers.get(key);
      if (provider?.context !== context) {
        provider = { context, choices: cameraChoiceProvider(camera, field, context) };
        providers.set(key, provider);
      }
      return { value, choices: provider.choices };
    }

    try {
      sheet.controls = await mountSpreadsheetControls({
        root: table,
        viewport: sheet.viewport,
        extendedEditing: true,
        getRows: () => rows,
        getColumns: () => cameraSheetView(deviceId) === 'columns' ? flippedColumns() : columns,
        getCell,
        onHistory(direction) { cameraHistoryStep(deviceId, direction); },
        onSelection(address) {
          const cell = address && cells.get(cameraCellKey(address));
          if (address) cameraAddresses.set(deviceId, address);
          else cameraAddresses.delete(deviceId);
          if (cell) sheet.selected = { camera: cell.dataset.camera, field: cell.dataset.column };
          else if (!address) sheet.selected = null;
          if (cameraSheetView(deviceId) === 'columns') sheet.controls?.refresh();
          showSelection(address);
        },
        onEdit({ edits }) { applyCameraGridEdits(logicalEdits(edits), cameraById); },
        onError(error) { toast(error.message); },
      });
    } catch (error) {
      if (table.isConnected && !spreadsheetUnavailable) {
        spreadsheetUnavailable = true;
        toast(error.message);
      }
      return;
    }
    const controls = sheet.controls;
    if (!table.isConnected || listeners.signal.aborted) { controls.dispose(); return; }
    const activeCellObserver = new MutationObserver(() => {
      const group = table.closest('[data-controller]');
      if (group) syncCameraDeleteButton(group);
    });
    // The shared fill handle can move the active cell without a selection callback.
    activeCellObserver.observe(table, { subtree: true, attributeFilter: ['data-hubble-spreadsheet-active'] });
    listeners.signal.addEventListener('abort', () => activeCellObserver.disconnect(), { once: true });
    sheet.refresh = (reindex = false) => {
      if (reindex) indexSheet();
      table.style.setProperty('--hc-camera-text-size', (cameraLayout(deviceId).textSize ?? 13) + 'px');
      paintCameraView(sheet.strip, deviceId);
      controls.refresh();
      if (reindex) followSelection();
      for (const control of sheet.presentation) control.refresh?.();
      if (table.closest('.hc-panel[hidden], [id^="hc-controller-"][hidden]')) {
        sheet.layout?.dispose();
        sheet.layout = null;
      } else if (sheet.layout) sheet.layout.refresh();
      else sheet.layout = mountCameraLayoutControls(table, sheet.viewport, sheet);
      showSelection(cameraAddresses.get(deviceId));
    };
    sheet.refresh();
    const presentation = await Promise.all([
      mountSpreadsheetColumnEditor({ root: sheet.strip.querySelector('[data-camera-columns]'), getItems: () => cameraColumnItems(deviceId), onVisibilityChange: (id, visible) => changeCameraVisibility(deviceId, [{ id, visible }]), onVisibilityChanges: changes => changeCameraVisibility(deviceId, changes) }),
      mountSpreadsheetSheets({ root: sheet.tabs, getState: () => cameraSheetBarState(deviceId), onSelect: sheetId => selectCameraSheet(deviceId, sheetId), onCreate: name => createCameraSheet(deviceId, name), onRename: (sheetId, name) => renameCameraSheet(deviceId, sheetId, name), onRemove: sheetId => removeCameraSheet(deviceId, sheetId), onReorder: (sheetId, beforeId) => moveCameraSheet(deviceId, sheetId, beforeId) }),
      mountSpreadsheetToolbar({ root: sheet.strip.querySelector('[data-camera-text-size]'), textSize: { get: () => cameraLayout(deviceId).textSize ?? 13, onChange: size => changeCameraPresentation(deviceId, () => { cameraLayout(deviceId).textSize = size; }, false) } }),
      mountSpreadsheetViewport({ root: table, viewport: sheet.viewport, getFrozen: () => [...table.querySelectorAll('.hc-camera-frozen')].map(element => ({ element, left: Number.parseFloat(element.style.left) || 0 })), onZoom(ratio) { sheet.scale = ratio; sheet.strip.querySelector('[data-camera-zoom]').textContent = Math.round(ratio * 100) + '%'; controls.refresh(); sheet.layout?.refresh(); } }),
    ]);
    if (listeners.signal.aborted) { presentation.forEach(control => control.dispose()); return; }
    sheet.presentation = presentation;

    let menuReady;
    function openCameraMenu(camera, cell, x, y) {
      if (!camera) return;
      if (cell) {
        const address = cameraAddress(cell);
        controls.select(address, address, { focus: false });
      }
      menuReady ??= createSpreadsheetContextMenu({ root: table, onError: error => toast(error.message) })
        .then(menu => {
          if (listeners.signal.aborted) { menu.dispose(); return; }
          sheet.menu = menu;
          return menu;
        }).catch(error => {
          if (!listeners.signal.aborted) toast(error.message);
          menuReady = null;
        });
      void menuReady.then(menu => {
        if (!menu || !table.isConnected || table.closest('[hidden]')) return;
        menu.open({
          x, y, label: 'Camera ' + camera.number + ' · ' + camera.name,
          items: [{
            id: 'delete-camera', label: 'Delete camera', icon: 'delete', danger: true, disabled: !!camera.deleting,
            run: () => reviewCameraDeletion(cameraById.get(camera.id)),
          }],
        });
      });
    }

    const options = { signal: listeners.signal };
    function editText(cell, replacement) {
      const input = cell?.querySelector('input[data-field]:enabled');
      if (!input || input.type === 'checkbox') return false;
      const address = cameraAddress(cell);
      const field = getCell(address);
      if (!field || field.readOnly) return false;
      controls.select(address, address, { focus: false });
      input.focus({ preventScroll: true });
      if (replacement === undefined) input.select();
      else {
        input.value = replacement;
        input.setSelectionRange(replacement.length, replacement.length);
      }
      return true;
    }
    function finishText(input, cancel) {
      input.classList.remove('hc-cell-editing');
      const address = cameraAddress(input.closest(cameraCellSelector));
      const value = getCell(address)?.value ?? '';
      if (cancel) input.value = value;
      else if (input.value !== value) applyCameraGridEdits(logicalEdits([{ ...address, value: input.value }]), cameraById);
    }

    table.addEventListener('dblclick', event => {
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(cameraCellSelector);
      if (cell && table.contains(cell)) editText(cell);
    }, options);
    table.addEventListener('contextmenu', event => {
      const cell = event.target.closest(cameraCellSelector) ?? event.target.closest('tbody tr[data-id]')?.querySelector(cameraCellSelector);
      const camera = cameraById.get(cell?.dataset.camera ?? event.target.closest('th[data-camera-header]')?.dataset.cameraHeader);
      if (!camera) return;
      event.preventDefault();
      openCameraMenu(camera, cell, event.clientX, event.clientY);
    }, options);
    table.addEventListener('focusin', event => {
      const input = event.target;
      if (!input.matches('input[data-field]:enabled') || input.type === 'checkbox') return;
      input.classList.add('hc-cell-editing');
      const address = cameraAddress(input.closest(cameraCellSelector));
      controls.select(address, address, { focus: false });
    }, options);
    table.addEventListener('focusout', event => {
      if (event.target.matches('input.hc-cell-editing')) finishText(event.target, false);
    }, options);
    table.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target.matches('input.hc-cell-editing')) {
        if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const input = event.target;
        input.classList.remove('hc-cell-editing');
        table.focus({ preventScroll: true });
        if (event.key === 'Tab') controls.move?.(event.shiftKey ? -1 : 1, 0);
        finishText(input, event.key === 'Escape');
        return;
      }
      if (event.target !== table || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        const cell = table.querySelector(activeCameraCell);
        if (!cell) return;
        const { left, bottom } = cell.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        openCameraMenu(cameraById.get(cell.dataset.camera), cell, left, bottom);
        return;
      }
      const address = cameraAddresses.get(deviceId);
      if (!address) return;
      const selected = getCell(address);
      if (selected?.kind === 'boolean' && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (!selected.readOnly) applyCameraGridEdits(logicalEdits([{ ...address, value: selected.value === 'TRUE' ? 'FALSE' : 'TRUE' }]), cameraById);
        return;
      }
      const replacement = event.key.length === 1 ? event.key : undefined;
      if ((replacement !== undefined || ['Enter', 'F2'].includes(event.key)) && editText(cells.get(cameraCellKey(address)), replacement)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, options);
    sheet.restoreFocus = focus => {
      if (focus?.deviceId !== deviceId || document.activeElement !== document.body || table.closest('[hidden]')) return;
      table.focus({ preventScroll: true });
      if (focus.editor && focus.address) {
        const input = cells.get(cameraCellKey(focus.address))?.querySelector('input[data-field]:enabled');
        if (input) {
          input.value = focus.editor.value;
          input.focus({ preventScroll: true });
          input.setSelectionRange(focus.editor.start, focus.editor.end);
        }
      }
    };
    const selected = cameraAddresses.get(deviceId);
    if (selected && cells.has(cameraCellKey(selected))) controls.select(selected, selected, { focus: false });
    sheet.restoreFocus(focus);
  }

  // What pressing Delete leaves behind in a choice cell that always holds something.
  const clearedCameraChoices = { model: 'Choose model…', usb: 'USB · Automatic', lens: 'None', lensPort: 'None' };

  function applyCameraGridEdits(edits, cameraById) {
    const controlEdits=edits.filter(edit=>edit.columnId==='controlEnabled');
    if(controlEdits.length)editCameraControl(controlEdits);
    edits=edits.filter(edit=>edit.columnId!=='controlEnabled');
    const historyRows = [...new Set(edits.map(edit => cameraById.get(edit.rowId)).filter(Boolean))];
    const historyBefore = cameraDraftSnapshot(historyRows);
    const changed = new Map();
    // Model and lens change what the other columns mean. A Use box going on has to land before its
    // settings, and one going off after them, so a Delete across both still empties the settings.
    const order = ({ columnId, value }) => ({ model: 0, lens: 1 })[columnId] ??
      (!lensAxisForUseColumn(columnId) ? 3 : value.trim().toUpperCase() === 'TRUE' ? 2 : 4);
    let invalid = 0;
    let redraw = false;
    for (const { rowId, columnId, value } of [...edits].sort((a, b) => order(a) - order(b))) {
      const camera = cameraById.get(rowId);
      if (!camera || camera.deleting || importedCamera(camera)) continue;
      const axis = lensAxisForUseColumn(columnId);
      if (axis) {
        if (!lensAxisAvailable(camera)) continue;
        const text = value.trim().toUpperCase();
        if (!['', 'TRUE', 'FALSE'].includes(text)) { invalid++; continue; }
        const staged = setLensAxis(camera, axis, text === 'TRUE');
        if (!staged) continue;
        const fields = changed.get(camera) ?? new Set();
        for (const edited of staged) fields.add(edited);
        changed.set(camera, fields);
        redraw = true;
        continue;
      }
      const field = cameraField(camera, columnId);
      if (isLensSetting(field) && !lensFieldUsed(camera, field)) continue;
      if (camera.model === 'Alpha-USB' && ['port', 'login', 'password'].includes(field)) continue;
      let next = value;
      if (cameraChoiceSources[field] || field.endsWith('Torque') || field.endsWith('Direction')) {
        const text = value.trim().toLocaleLowerCase();
        if (!text) next = clearedCameraChoices[field] ?? '';
        else {
          const choices = cameraCellChoices(camera, field);
          const choice = choices.find(option => option.value === value) ??
            choices.find(option => option.value.toLocaleLowerCase() === text || option.label.toLocaleLowerCase() === text);
          if (!choice) { invalid++; continue; }
          next = choice.value;
        }
      }
      if (String(camera[field] ?? '') === next) continue;
      const fields = changed.get(camera) ?? new Set();
      for (const edited of stageCell(camera, field, next, false)) fields.add(edited);
      changed.set(camera, fields);
      redraw ||= field === 'model' || field === 'lens' || cameraSort(camera.device).field === field;
    }
    if (changed.size) {
      recordCameraDrafts(historyBefore, historyRows);
      if (redraw) renderCameras();
      else {
        for (const [camera, fields] of changed) {
          for (const field of fields) {
            const control = root.querySelector('table[data-camera-device] [data-row="' + CSS.escape(camera.id) + '"][data-field="' + field + '"]');
            if (!control) continue;
            if (control.hasAttribute('data-camera-choice')) {
              control.closest('td').innerHTML = cameraChoiceCell(camera, field);
            } else control.value = camera[field];
          }
          paintItem(camera);
        }
        for (const sheet of cameraSheets.values()) sheet.refresh?.();
      }
      remember();
      if (ui.sendMode === 'Auto send') {
        const jobs = [...changed.keys()].filter(camera => changed.get(camera).size);
        const fields = new Map(jobs.map(camera => [camera.id, [...(camera.isNew ? camera.dirty : changed.get(camera))]]));
        if (jobs.length) void sendItems(jobs, 'camera', false, fields);
      }
    }
    if (invalid) toast(invalid + ' ' + (invalid === 1 ? 'choice is' : 'choices are') + ' unavailable for the destination');
  }

  window.addEventListener('pagehide', () => {
    for (const sheet of cameraSheets.values()) {
      sheet.listeners.abort();
      sheet.menu?.dispose();
      sheet.layout?.dispose();
      sheet.presentation?.forEach(control => control.dispose());
      sheet.controls?.dispose();
    }
    cameraSheets.clear();
  }, { once: true });

  initializeDeviceWorkflow();syncFilter();renderLans();renderCameras();setTab('devices',false);restore(window.openai?.widgetState);
  if(moduleBridge)void initializeBackend();else root.hidden=false;
  window.addEventListener('openai:set_globals',event=>{const snapshot=event.detail?.globals?.widgetState;if(snapshot&&JSON.stringify(snapshot.privateContent)!==lastSavedPrivateContent)restore(snapshot);});
  if(globalThis.Tweak){const tweak=new globalThis.Tweak({container:root,onChange:updateDesign});tweak.addSelect(ui,'density',{label:'Row density',options:['Compact','Comfortable']});tweak.addToggle(ui,'serials',{label:'Use full device serials'});}
})();
