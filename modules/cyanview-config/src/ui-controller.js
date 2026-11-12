import { createSpreadsheetContextMenu, mountSpreadsheetControls, mountSpreadsheetColumnGroup, mountSpreadsheetResize, mountSpreadsheetColumnEditor, mountSpreadsheetViewport } from '@hubble/module-sdk/spreadsheet-controls';
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
  const pendingCameras=id=>cameras.filter(c=>c.pending&&c.device!==''&&(!id||c.device===id));
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},2800);}
  let lastSavedPrivateContent='';
  function remember(){
    try{const snapshot={modelContent:{activeTab:tab,layout:'Fleet LAN sheet',cameraOrganization:'Expandable spreadsheet per RCP/RIO',sendMode:ui.sendMode,sendModeScope:'Camera/lens and LAN',density:ui.density,lensColumns:ui.lensColumns,deviceOrder:orderedDevices().slice(0,16).map(d=>d.name),lensPresentation:'Inline Iris, Zoom and Focus column groups',axisGroups:axisGroups('rcp1'),reordering:'Drag handles with Alt+Up/Down keyboard support',columnVisibility:'Individual column checkboxes per sheet',hiddenCameraColumns:[...hiddenCameraColumns('rcp1')],hiddenLanColumns:[...hiddenLanColumns],remiSharing:'Managed camera sources'},privateContent:{revision:6,hiddenCameraColumnsByDevice:Object.fromEntries(Object.entries(hiddenCameraColumnsByDevice).map(([id,fields])=>[id,[...fields]])),hiddenLanColumns:[...hiddenLanColumns],tab,ui:{...ui},axisGroupsByDevice:JSON.parse(JSON.stringify(axisGroupsByDevice)),deviceOrder:orderedDevices().map(d=>d.id),openControllers:[...openControllers],openNetworkDevices:[...openNetworkDevices],cameraSortByDevice:JSON.parse(JSON.stringify(cameraSortByDevice)),cameraLayouts:saveCameraLayouts(),cameraSheetsByDevice:saveCameraSheets(),hiddenNetworkColumnsByDevice:Object.fromEntries(Object.entries(hiddenNetworkColumnsByDevice).map(([id,fields])=>[id,[...fields]])),discoveryOpen:discoveryCard?.open,remiDrafts:saveRemiDrafts(),remiView:saveRemiView(),scanRange:$('scan-range').value,deviceFilter:$('device-filter').value}};lastSavedPrivateContent=JSON.stringify(snapshot.privateContent);if(moduleBridge){return persistPlan(snapshot);}const p=window.openai?.setWidgetState?.(snapshot);if(p?.catch)p.catch(()=>{});}catch{}
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
    root.querySelectorAll('[data-sync-id="'+item.id+'"]').forEach(el=>el.innerHTML=resultMark(syncResult(item)));
    const row=root.querySelector('tr[data-id="'+item.id+'"]');
    if(row)row.querySelectorAll('[data-field]').forEach(el=>el.closest('td').classList.toggle('hc-changed',item.dirty.has(el.dataset.field)||routeChanged(item,el.dataset.field)));
    if(item.deleting&&row)row.querySelectorAll('[data-field],input[data-lens-axis]').forEach(el=>el.disabled=true);
    paintCameraColumn(item);
    paintIrisSwap(item);
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
      for(const [id,fields] of Object.entries(data.hiddenCameraColumnsByDevice))if(sheetOwner(id)&&Array.isArray(fields))hiddenCameraColumnsByDevice[id]=new Set(fields.filter(field=>known.has(field)));
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
    iris:[{id:'irisMotor',label:'Motor ID',width:66},{id:'irisMin',label:'Open',width:65},{id:'irisMax',label:'Closed',width:65},{id:'irisTorque',label:'Torque',width:65},{id:'irisDirection',label:'Direction',width:100}],
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
    columns.push({id:'control',label:'Control',width:104},{id:'cameraEnabled',label:'Camera Enabled',width:236},{id:'recording',label:'Recording',width:96},{id:'cameraStatus',label:'Status',width:200});
    columns.push({id:'lens',label:'Lens model',width:126},{id:'connection',label:'Lens connection',width:116});
    for (const axis of ['iris', 'zoom', 'focus']) {
      columns.push(...cameraAxisColumns(deviceId, axis));
    }
    // The Source or Master RCP goes after the settings people paste as a block, and the frozen
    // columns keep the delete button on screen however far the sheet scrolls.
    if (deviceId !== allCamerasSheet) {
      columns.splice(columns.findIndex(column => column.id === 'password') + 1, 0, deviceId === cameraSetupSheet ? { id: 'source', label: 'Source', width: 140 } : { id: 'remiMaster', label: 'Master RCP', width: 130 });
      columns.splice(columns.findIndex(column => column.id === 'name') + 1, 0, { id: 'remove', label: '', width: 62, tool: true, frozen: 0 });
    }
    columns.push({ id: 'sync', label: 'Sync', width: 70 });
    if (deviceId === allCamerasSheet) columns = arrangeAllCameraColumns(columns);
    columns = columns.filter(column => column.id === 'row' || column.group || column.tool || cameraColumnVisible(deviceId, column.id));
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
      if(column.tool)return removeCell(camera,column);
      const p=lensCapabilities(camera),field=column.id,changed=camera.dirty.has(cameraField(camera,field))||routeChanged(camera,field),inactive=isLensSetting(field)&&!lensFieldUsed(camera,field)&&!irisSwapCell(camera,field);
      let content='',attrs=' data-column="'+field+'"'+(field==='row'?' role="rowheader" aria-label="Camera '+esc(camera.number)+'"':' role="gridcell"'+cameraCellPosition(deviceId,camera.id,field)),classes=[];
      if(column.frozen!==undefined){classes.push('hc-camera-frozen');attrs+=' style="left:'+column.frozen+'px"';}
      if(changed)classes.push('hc-changed');if(inactive)classes.push('hc-axis-inactive');
      if(field==='row')classes.push('hc-camera-row-gutter');
      else if(field==='controlEnabled'){classes.push('hc-check');content=cameraControlCell(camera);}
      else if(isAssignmentField(field)){if(field.startsWith('remi:'))classes.push('hc-check');content=assignmentCell(camera,field,deviceId);}
      else if(field==='number'||field==='name')content=inputCell(camera,field,camera[field]);
      else if(field==='model')content=cameraChoiceCell(camera,field);
      else if(field==='ip')content=camera.model==='Alpha-USB'?cameraChoiceCell(camera,'usb'):inputCell(camera,'ip',camera.ip,'hc-mono');
      else if(field==='control')content=status(camera.online);
      else if(field==='cameraEnabled')content=cameraEnabledCell(camera);
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
      else if(field==='sync'){attrs+=' data-sync-id="'+camera.id+'"';content=resultMark(syncResult(camera));}
      return '<td'+attrs+(classes.length?' class="'+classes.join(' ')+'"':'')+'>'+content+'</td>';
    }
    if(cameraSheetView(deviceId)==='columns')return flippedCameraGrid(rows,columns,deviceId,cell);
    return header+'<tbody>'+rows.map(camera=>{
      initializeLensFields(camera);
      return '<tr data-id="'+esc(camera.id)+'"'+(removalStaged(camera)?' class="hc-remove-staged"':'')+'>'+columns.map(column=>cell(camera,column)).join('')+'</tr>';
    }).join('')+'</tbody>';
  }
  function renderCameras(){
    const scrolls=new Map([...root.querySelectorAll('[data-controller]')].map(el=>[el.dataset.controller,el.querySelector('.hc-scroll')?.scrollLeft||0]));
    $('controllers').innerHTML=orderedDevices().map(d=>{
      const rows=cameras.filter(c=>c.device===d.id),open=openControllers.has(d.id),selection=cellSelections.get(d.id)||['C2',rows[0]?.name||''];
      return '<section class="hc-controller" data-controller="'+d.id+'"><div class="hc-controller-header"><button class="hc-controller-handle" draggable="true" data-reorder-handle="'+d.id+'" aria-label="Reorder '+esc(d.name)+'" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" data-tooltip="Drag to reorder; Alt + up/down also moves this device">'+icon('grip-vertical')+'</button><button class="hc-controller-expander" data-action="toggle-controller" data-id="'+d.id+'" aria-expanded="'+open+'" aria-controls="hc-controller-'+d.id+'">'+icon(open?'chevron-down':'chevron-right')+'<strong>'+esc(d.name)+'</strong><span class="hc-device-type">'+d.kind+'</span><span class="hc-controller-serial">'+esc(d.serial)+'</span></button><span class="hc-controller-camera-count">'+rows.length+' camera'+(rows.length===1?'':'s')+'</span>'+cameraControlCount(d)+status(d.online)+'<span class="hc-controller-pending" data-controller-pending></span></div><div id="hc-controller-'+d.id+'"'+(!open?' hidden':'')+'><div class="hc-controller-tools">'+cameraCountControl(d.id)+'<button class="hc-danger" data-action="delete-controller" data-id="'+d.id+'" disabled>'+icon('trash-2')+'<span data-camera-delete-label>Delete camera</span></button>'+cameraControlTools(d)+'<span class="hc-right"></span><button class="hc-danger" data-action="clear-device-cameras" data-id="'+d.id+'"'+(rows.length?'':' disabled')+'>'+icon('eraser')+'Clear all cameras</button><button class="hc-danger" data-action="remove-device" data-id="'+d.id+'" aria-label="Remove '+esc(d.name)+' from managed list">'+icon('trash-2')+'Remove device</button><button class="hc-button" data-action="send-controller" data-id="'+d.id+'">'+icon('send')+'Send changes <span>0</span></button>'+cameraSelectionStrip(d.id)+'</div><div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" role="grid" data-camera-device="'+d.id+'" aria-label="Camera and lens spreadsheet for '+esc(d.name)+'">'+cameraGrid(rows,d.id)+'</table></div></div><span class="hc-visually-hidden" data-connection-note>'+esc(connectionNote(d))+'</span></div></section>';
    }).join('');syncSummary();icons();
    for(const [id,left] of scrolls){const scroll=root.querySelector('[data-controller="'+id+'"] .hc-scroll');if(scroll)scroll.scrollLeft=left;}
  }
  function setTab(next,save=true){if(next==='discovery'){next='devices';if(discoveryCard)discoveryCard.open=true;}tab=next;root.querySelectorAll('[data-tab]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.tab===next)));for(const id of ['devices','setup','cameras','assignment'])root.querySelector('#hc-'+id).hidden=id!==next;$('lan-columns-menu').hidden=true;$('drawer').hidden=true;refreshCameraSheets();if(save)remember();}
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
    if(filled.some(field=>field==='irisMin'||field==='irisMax')&&!irisRangeValid(item))return 'Incomplete';
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
    const nums=(id?cameras.filter(c=>c.device===id):cameras).map(c=>Number(c.number));
    const c={id:'new-camera-'+Date.now(),device:id,number:String(Math.max(0,...nums)+1),name:'New camera',model,ip:'',lens:'None',lensPort:'None',online:null,pending:true,result:model==='Alpha-USB'?'Pending':'Incomplete',port:model==='Alpha-USB'?'':'80',login:model==='Alpha-USB'?'':'admin',password:'',isNew:true,dirty:new Set(['number','name','model','ip','lens','lensPort']),revision:0,jobs:0};
    cameras.push(c);openControllers.add(id);renderCameras();if(ui.sendMode==='Auto send'&&!valid(c,'camera'))sendItems([c],'camera');toast(id?'Camera row added to '+device(id).name:'Camera added · choose its Source');remember();
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
  function restore(snapshot){const data=snapshot?.privateContent;if(!data||![2,3,4,5,6].includes(data.revision))return;if(data.ui)for(const k of Object.keys(ui))if(typeof data.ui[k]===typeof ui[k])ui[k]=data.ui[k];if(data.revision<5){ui.cameraCore=true;ui.cameraCredentials=true;}restoreColumnVisibility(data);restoreDeviceWorkflow(data);restoreCameraSorting(data);restoreCameraLayouts(data);restoreRemiDrafts(data);restoreRemiView(data);if(data.axisGroupsByDevice&&typeof data.axisGroupsByDevice==='object'){for(const [id,groups] of Object.entries(data.axisGroupsByDevice)){if(!sheetOwner(id)||!groups||typeof groups!=='object')continue;for(const axis of ['iris','zoom','focus'])if(typeof groups[axis]==='boolean')axisGroups(id)[axis]=groups[axis];}}restoreCameraSheets(data);if(Array.isArray(data.deviceOrder)){const known=new Set(devices.map(d=>d.id));deviceOrder=[...new Set(data.deviceOrder.filter(id=>known.has(id)))];devices.forEach(d=>{if(!deviceOrder.includes(d.id))deviceOrder.push(d.id);});}if(Array.isArray(data.openControllers)){openControllers.clear();data.openControllers.forEach(id=>{if(device(id))openControllers.add(id);});}if(['devices','discovery','setup','cameras','assignment'].includes(data.tab))setTab(data.tab,false);if(['','10.192.0.0/16','10.20.0.0/16','custom'].includes(data.scanRange))$('scan-range').value=data.scanRange;$('custom-range-field').hidden=$('scan-range').value!=='custom';action('scan').disabled=!$('scan-range').value;syncFilter();if(data.deviceFilter==='all'||devices.some(item=>item.id===data.deviceFilter))$('device-filter').value=data.deviceFilter;renderLans();renderCameras();}
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
    cameraControlState=state;paintCameraControl();syncConnections();noticeCameraChanges(state.cameraChanges);
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
  // The All Cameras tab is one more sheet with its own layout, sort and tabs, but no controller of its own.
  const allCamerasSheet = '__all-cameras__';
  const cameraSetupSheet = '__camera-setup__';
  function virtualSheet(name) { return name === 'assignment' ? allCamerasSheet : name === 'setup' ? cameraSetupSheet : null; }
  const canBeMaster = d => d?.kind === 'RCP' || d?.kind === 'Gateway';
  const remiControllers = () => orderedDevices().filter(canBeMaster);
  const routeReceivers = remiControllers;
  const isAssignmentField = field => field === 'source' || field === 'remiMaster' || String(field).startsWith('remi:');
  const assignmentLabel = field => field === 'source' ? 'Source device' : field === 'remiMaster' ? 'Master RCP' : 'REMI to ' + (device(field.slice(5))?.name ?? field.slice(5));
  // The matrix shows where each camera goes, Camera Configuration its settings and Source, and a
  // controller's own sheet its settings and master.
  const sheetSections = id => cameraSheetSections().filter(section => id === allCamerasSheet ? ['source', 'remi', 'route'].includes(section.id) : id === cameraSetupSheet ? !['remi', 'route'].includes(section.id) : !['source', 'route'].includes(section.id));
  const cameraFieldName = field => isAssignmentField(field) ? assignmentLabel(field) : cameraSortLabels[field] ?? 'Use ' + axisName(field.replace(/Summary$/, ''));
  const sheetOwner = id => id === allCamerasSheet || id === cameraSetupSheet || !!device(id);
  const sheetOwners = () => [...devices, { id: allCamerasSheet }, { id: cameraSetupSheet }];
  const cameraAxes = ['iris', 'zoom', 'focus'];
  function cameraLayout(id) {
    if (!cameraLayouts.has(id)) cameraLayouts.set(id, {
      version: 2, columns: {}, rows: {}, groups: {}, hiddenGroups: [], textSize: 13,
    });
    return cameraLayouts.get(id);
  }
  function cameraSheetSections() {
    return [
      { id: 'source', label: 'Source', fields: [{ id: 'source', label: 'Source device' }] },
      { id: 'route', label: 'REMI to', fields: routeReceivers().map(d => ({ id: 'remi:' + d.id, label: d.name })) },
      { id: 'remi', label: 'REMI', fields: [{ id: 'remiMaster', label: 'Master RCP' }] },
      { id: 'camera', label: 'Camera', fields: [
        { id: 'number', label: 'Camera number' }, { id: 'name', label: 'Camera name' },
        { id: 'model', label: 'Camera model' }, { id: 'ip', label: 'Camera IP / interface' },
        { id: 'port', label: 'Port' }, { id: 'login', label: 'Username' }, { id: 'password', label: 'Password' },
        { id: 'controlEnabled', label: 'Camera Control Enabled' }, { id: 'control', label: 'Control status' }, { id: 'cameraEnabled', label: 'Camera Enabled' },
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
    const ids = new Set(sheetCameras(id).map(camera => camera.id));
    const kept = sizes => Object.fromEntries(Object.entries(sizes).filter(([cameraId]) => ids.has(cameraId)));
    return { ...layout, rows: kept(layout.rows), ...(layout.cameraWidths && { cameraWidths: kept(layout.cameraWidths) }) };
  }
  function saveCameraLayouts() {
    return Object.fromEntries([...cameraLayouts].filter(([id]) => sheetOwner(id)).map(([id, layout]) => [id, pruneCameraLayout(id, layout)]));
  }
  function restoreCameraLayouts(data) {
    cameraLayouts.clear();
    for (const d of sheetOwners()) cameraLayouts.set(d.id, cleanCameraLayout(d.id, data.cameraLayouts?.[d.id]));
  }
  function cleanCameraLayout(id, saved = {}) {
    const layout = { version: 2, columns: {}, rows: {}, groups: {}, hiddenGroups: [], textSize: 13 };
    const columnIds = cameraSheetSections().flatMap(section => section.fields.map(field => field.id));
    const cameraIds = new Set(sheetCameras(id).map(camera => camera.id));
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
      const quiet = column.placeholder || column.tool;
      const attributes = quiet ? ' aria-hidden="true"' : ' data-field-header="' + id + '"' + cameraSortAria(column, deviceId);
      const heading = quiet ? '' : cameraSortHeading(column, deviceId);
      if (column.group) {
        if (columns[index - 1]?.group !== column.group) top.push('<th class="hc-camera-group-header" scope="colgroup" colspan="' + columns.filter(field => field.group === column.group).length + '"><div data-axis-header="' + column.group + '"></div></th>');
        fields.push('<th scope="col"' + attributes + '>' + heading + '</th>');
      } else {
        const frozen = column.frozen === undefined ? '' : ' class="hc-camera-frozen' + (column.tool ? ' hc-row-remove' : '') + '" style="left:' + column.frozen + 'px"';
        top.push('<th scope="col" rowspan="' + (hasGroups ? 2 : 1) + '"' + frozen + attributes + '>' + heading + '</th>');
      }
    }
    return '<colgroup>' + columns.map(column => '<col' + (column.placeholder || column.tool ? '' : ' data-hubble-column="' + column.id + '" data-label="' + esc(column.label) + '"') + ' style="width:' + column.width + 'px">').join('') + '</colgroup><thead>' + cameraColumnBands(columns, deviceId) + '<tr>' + top.join('') + '</tr>' + (fields.length ? '<tr>' + fields.join('') + '</tr>' : '') + '</thead>';
  }
  function cameraColumnItems(id) {
    return sheetSections(id).map(section => ({
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
        ...[...table.querySelectorAll('th[data-field-header]:not([data-field-header="row"])')].map(header => ({ id: header.dataset.fieldHeader, header, axis: 'column', label: cameraFieldName(header.dataset.fieldHeader), size: header.offsetWidth, min: header.dataset.fieldHeader.endsWith('Summary') ? 72 : 36, max: 640 })),
        ...[...table.tBodies[0].rows].map(row => ({ id: row.dataset.id, header: row.cells[0], axis: 'row', label: 'camera ' + (cameras.find(item => item.id === row.dataset.id)?.number ?? row.sectionRowIndex + 1) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
      ], onResize({ id: item, axis }, size) { changeCameraPresentation(id, () => { if (cameraSheetView(id) === 'columns') resizeFlippedSheet(id, item, axis, size); else cameraLayout(id)[axis === 'row' ? 'rows' : 'columns'][item] = size; }); },
    }).then(controls => { if (disposed) controls.dispose(); else { resize = controls; resize.refresh(); } }).catch(error => { if (!disposed) toast(error.message); });
    refresh();
    return { refresh, dispose() { disposed = true; for (const group of groups.values()) group.controls?.dispose(); resize?.dispose(); } };
  }
  function cameraColumnBands(columns,deviceId){
    const cameraFields=new Set(['number','name','model','ip','port','login','password','controlEnabled','control','cameraEnabled','recording','cameraStatus']);
    const all=deviceId===allCamerasSheet;
    const labels={gutter:'',route:'REMI',camera:'Camera',lens:'Lens',sync:all?'':'Sync',remi:'REMI to'};
    const kindOf=column=>column.id==='row'?'gutter':column.tool?'camera':String(column.id).startsWith('remi:')?'remi':isAssignmentField(column.id)?(all?'route':'camera'):column.id==='sync'?'sync':all||cameraFields.has(column.id)?'camera':'lens';
    const bands=[];
    for(const column of columns){
      const kind=kindOf(column),last=bands.at(-1);
      if(last?.kind===kind)last.count++;else bands.push({kind,count:1,left:column.frozen});
    }
    return '<tr class="hc-camera-bands">'+bands.map(band=>
      '<th colspan="'+band.count+'" scope="colgroup" class="hc-camera-band hc-camera-band-'+band.kind+(all&&band.left!==undefined?' hc-camera-frozen" style="left:'+band.left+'px':'')+'">'+labels[band.kind]+'</th>'
    ).join('')+'</tr>';
  }

  // The sheet's view controls sit at the end of its toolbar. The selected cell's address and value
  // are still kept up to date for screen readers, out of sight.
  function cameraSelectionStrip(deviceId){
    return '<div class="hc-camera-selection" data-camera-selection="'+esc(deviceId)+'">'+
      '<span class="hc-camera-location hc-visually-hidden" data-camera-location>Select a cell</span>'+
      '<span class="hc-camera-value hc-visually-hidden" data-camera-value></span>'+
      '<span data-camera-search-hint hidden></span>'+
      '<span data-camera-zoom hidden>100%</span>'+
      cameraViewControl(deviceId)+'<div data-camera-columns title="Choose which settings this sheet shows"></div>'+
      '</div>';
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
    const label=isAssignmentField(column)?assignmentLabel(column):choice?choiceLabel(input.dataset.field):axisSetup?'Use '+axisName(column.replace(/Summary$/,'')):cameraSortLabels[column]||column;
    location.textContent='Camera '+(row?.number||'—')+' · '+label;
    if(column==='password')value.textContent=input?.value?'••••••••':'';
    else if(axisSetup&&cell.classList.contains('hc-axis-inactive'))value.textContent='Unavailable for this camera';
    else if(cell.querySelector('[role="checkbox"]'))value.textContent=cell.querySelector('[role="checkbox"]').getAttribute('aria-checked')==='true'?'On':'Off';
    else value.textContent=input?.disabled?'':choice?input.textContent:input?.value??cell.textContent.trim();
    if(value.textContent&&column!=='password')value.title=value.textContent;
    search.hidden=!choice||input.disabled;
  }

  // A tab is a saved way of looking at one controller's cameras: which settings it
  // shows, their sizes, and which way round the sheet is. The tab strip is gone from the
  // page, so each sheet shows the tab it was last on, and the saved tabs are kept as they
  // were so an older version of this module still opens them.
  const cameraSheetsByDevice = {};
  const settingHeaderId = 'hc:setting';
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
  function showCameraSheet(id, sheet) {
    cameraSheetState(id).activeSheetId = sheet.id;
    cameraLayouts.set(id, copyPresentation(sheet.layout));
    hiddenCameraColumnsByDevice[id] = new Set(sheet.hidden);
    axisGroupsByDevice[id] = { ...sheet.expanded };
  }
  function setCameraSheetView(id, view) {
    if (cameraSheetView(id) !== view) changeCameraPresentation(id, () => { activeCameraSheet(id).view = view; });
  }
  // The tab on screen is saved in the existing layout fields, so an older version of
  // this module still opens the workspace showing that tab.
  function cameraSheetsRecord(id, sheets, activeSheetId) {
    return { activeSheetId, sheets: sheets.map(({ layout, hidden, expanded, ...sheet }) => sheet.id === activeSheetId ? sheet : { ...sheet, layout: pruneCameraLayout(id, layout), hidden, expanded }) };
  }
  function saveCameraSheets() {
    return Object.fromEntries(sheetOwners().map(d => [d.id, cameraSheetsRecord(d.id, cameraSheetList(d.id), cameraSheetState(d.id).activeSheetId)]));
  }
  function restoreCameraSheets(data) {
    for (const id of Object.keys(cameraSheetsByDevice)) delete cameraSheetsByDevice[id];
    const known = new Set(cameraSheetSections().flatMap(section => section.fields.map(field => field.id)));
    for (const d of sheetOwners()) {
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
    if (isAssignmentField(field.id)) return { id: 'route', label: 'REMI' };
    if (field.id === 'sync') return { id: 'sync', label: 'Sync' };
    if (field.id === 'lens' || field.id === 'connection') return { id: 'lens', label: 'Lens' };
    return { id: 'camera', label: 'Camera' };
  }
  function flippedCameraGrid(rows, columns, deviceId, cell) {
    const layout = cameraLayout(deviceId), width = camera => layout.cameraWidths?.[camera.id] ?? 168;
    const fields = columns.filter(column => column.id !== 'row' && !column.tool).map(({ frozen, ...field }) => ({ ...field, label: cameraSortLabels[field.id] ?? field.label }));
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
      if (control) cell.classList.toggle('hc-changed', item.dirty.has(control.dataset.field) || routeChanged(item, control.dataset.field));
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
      ...[...table.tBodies[0].querySelectorAll('tr[data-setting]')].map(row => ({ id: row.dataset.setting, header: row.cells[0], axis: 'row', label: cameraFieldName(row.dataset.setting) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
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

  function plainRow(item){const {deleting,...saved}=item;return {...saved,dirty:[...(item.dirty||[])],jobs:0};}
  function snapshotPlan(uiState){return {formatVersion:1,devices:devices.map(({modelCatalog,models,lensOptions,snapshot,...item})=>({...item})),cameras:cameras.filter(row=>row.device!=='').map(plainRow),lans:lans.map(plainRow),uiState};}
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
      persistence='saved';syncSummary();preferBaseAddresses();
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
    noticeConfigChanges(values.configChanges);
    applyCameraEnabledJobs(values.cameraEnabledJobs);
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
    try{const reply=await moduleBridge.refresh();const cleared=clearPendingSends();for(const snapshot of reply.snapshots||[])mergeSnapshot(snapshot);await restoreCameraChoiceCatalogs();renderLans();renderCameras();applyLiveState({observations:reply.observations});const failed=(reply.failed||[]).map(id=>device(id)?.name||id);const clearedText=cleared?' · '+cleared+(cleared===1?' pending change':' pending changes')+' cleared':'';toast((failed.length?'Could not read '+(failed.length===1?failed[0]:failed.length+' controllers'):'Settings refreshed')+clearedText);remember();}
    catch(error){toast(error.message);}
    finally{action('refresh-all').disabled=false;}
  }

  const remiPanels = new Map();
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
    for (const snapshot of result.snapshots || []) mergeOwn(snapshot);
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
      if (report.snapshot) mergeOwn(report.snapshot);
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
      group.querySelector('[data-camera-count]')?.insertAdjacentHTML('afterend', '<button type="button" class="hc-button" data-action="open-remi-panel" data-id="' + esc(item.id) + '" aria-expanded="' + !!remiPanels.get(item.id)?.open + '">REMI cameras</button>');
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
    if (button.dataset.action === 'open-remi-panel' && device(button.dataset.id)) {
      const id = button.dataset.id;
      if (remiPanelState(id).open) { remiPanelState(id).open = false; renderCameras(); return; }
      remiOpen(id);
      remiGroup(id)?.querySelector('[data-remi-source]')?.focus();
      return;
    }
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
      remiGroup(receiver)?.querySelector('[data-action="open-remi-panel"]')?.focus();
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
    if(isAssignmentField(field))return assignmentLabel(field);
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
      entries=irisSwapCell(camera,field)?irisSwapChoices.map(option=>choiceEntry(option.value,option.label)):[choiceEntry('left','Left'),choiceEntry('right','Right')];
    }
    // A swap cell shows which way round the numbers are, not a saved value.
    const current=irisSwapCell(camera,field)?'':camera[field];
    if(current&&current!=='Choose model…'&&!entries.some(option=>option.value===current))entries=[...entries,choiceEntry(current)];
    return [...new Map(entries.map(option=>[option.value,option])).values()];
  }
  function cameraChoiceCell(camera,field,disabled=false){
    const inactive=disabled||camera.deleting||importedCamera(camera);
    const value=inactive?'':irisSwapCell(camera,field)?irisSwapValue(camera):camera[field]??(field==='usb'?'USB · Automatic':'');
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
    const skipped = new Set(['id', 'dirty', 'pending', 'result', 'revision', 'jobs', 'online', 'deleting', 'elementKey', 'newElementKey', 'createState', 'needsInitialization', 'sentValues']);
    return rows.map(row => ({ id: row.id, values: copyPresentation(Object.fromEntries(Object.entries(row).filter(([key]) => !skipped.has(key)))), dirty: [...row.dirty], pending: row.pending, result: row.result }));
  }
  function recordCameraDrafts(before, rows) {
    const after = cameraDraftSnapshot(rows), byDevice = new Map();
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      if (!next) continue;
      const fields = [...new Set([...Object.keys(old.values), ...Object.keys(next.values)])].filter(key => JSON.stringify(old.values[key]) !== JSON.stringify(next.values[key]));
      if (!fields.length) continue;
      // What it was before the first edit since the last send, which is what Cancel goes back to.
      const row = rows.find(item => item.id === old.id);
      for (const field of fields) if (!['routeDraft', 'device', 'remiMaster', 'removeStaged'].includes(field) && !(field in (row.sentValues ??= {}))) row.sentValues[field] = old.values[field] ?? null;
      // Undo belongs to the sheet the edit was made on.
      const id = virtualSheet(tab) ?? row.device;
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
    if (entry.kind === 'cleared') setClearedRows(entry.rows, forward);
    else if (entry.kind === 'layout') {
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
    return cell && sheetCameras(table.dataset.cameraDevice).find(camera => camera.id === cell.dataset.camera);
  }

  function selectedCameras(table) {
    const ids = new Set([...(table?.querySelectorAll('[data-hubble-spreadsheet-selected]') ?? [])].map(cell => cell.dataset.camera));
    return table ? sheetCameras(table.dataset.cameraDevice).filter(camera => ids.has(camera.id) && !camera.jobs && !camera.deleting) : [];
  }

  function syncCameraDeleteButton(group) {
    const clear = group.querySelector('[data-action="clear-selected"]');
    if (clear) {
      const count = selectedCameras(group.querySelector('table[data-camera-device]')).length, text = count > 1 ? 'Clear ' + count + ' from view' : 'Clear from view', label = clear.querySelector('[data-camera-clear-label]');
      if (label.textContent !== text) label.textContent = text;
      clear.disabled = !count;
    }
    const button = group.querySelector('[data-action="delete-controller"]');
    const camera = activeCamera(group.querySelector('table[data-camera-device]'));
    const label = button.querySelector('[data-camera-delete-label]');
    const text = !camera?.number ? 'Delete camera' : (removalStaged(camera) ? 'Keep camera ' : 'Delete camera ') + camera.number;
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
    if (element?.closest('[data-camera-selection]')) return { chrome: element };
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
        // The view controls live in the sheet's toolbar, which a redraw may or may not have replaced.
        const strip = replacement.closest('.hc-controller').querySelector('[data-camera-selection]');
        if (strip && strip !== sheet.strip) strip.replaceWith(sheet.strip);
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
    for (const id of cameraAddresses.keys()) if (!sheetOwner(id)) cameraAddresses.delete(id);
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
    const sheet = { listeners, controls: null, viewport: table.closest('.hc-scroll'), strip: table.closest('.hc-controller').querySelector('[data-camera-selection]'), presentation: [], scale: 1 };
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
      cameraById = new Map(sheetCameras(deviceId).map(camera => [camera.id, camera]));
      for (const cell of cells.values()) {
        const input = cell.querySelector('input[data-field]');
        if (input) input.tabIndex = -1;
        if (!cell.querySelector('[data-field]:enabled,[data-hubble-boolean]')) cell.setAttribute('aria-readonly', 'true');
      }
      providers.clear();
    }
    indexSheet();

    function showSelection(address) {
      const strip = table.closest('.hc-controller').querySelector('[data-camera-selection]');
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

    // A camera waiting to be deleted can't be edited until that is cancelled.
    function getCell(address) {
      const shown = cellFor(address), camera = shown && cameraById.get(cells.get(cameraCellKey(address))?.dataset.camera);
      return shown && camera?.removeStaged ? { ...shown, readOnly: true, choices: undefined } : shown;
    }
    function cellFor(address) {
      const key = cameraCellKey(address);
      const cell = cells.get(key);
      const camera = cell && cameraById.get(cell.dataset.camera);
      if (!cell || !camera || cell.classList.contains('hc-axis-inactive')) return null;
      if (isAssignmentField(cell.dataset.column)) return assignmentSheetCell(camera, cell.dataset.column, deviceId);
      const axis = lensAxisForUseColumn(cell.dataset.column);
      if (axis) return { kind: 'boolean', value: lensAxisEnabled(camera, axis) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting };
      const control = cell.querySelector('[data-field]');
      if (!control) {
        return ['control', 'cameraEnabled', 'recording', 'cameraStatus', 'sync'].includes(cell.dataset.column)
          ? { value: cell.textContent.trim(), readOnly: true }
          : null;
      }
      if (control.disabled) return null;
      const field = control.dataset.field;
      if (field === 'controlEnabled') return { kind: 'boolean', value: cameraControlEnabled(camera) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting || !cameraControlDevice(device(camera.device)) };
      const value = irisSwapCell(camera, field) ? irisSwapValue(camera) : String(camera[field] ?? (field === 'usb' ? 'USB · Automatic' : ''));
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
          items: cameraMenuItems(camera, cameraById),
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
    const routeEdits=edits.filter(edit=>isAssignmentField(edit.columnId));
    if(routeEdits.length)editCameraRoutes(routeEdits,cameraById);
    edits=edits.filter(edit=>edit.columnId!=='controlEnabled'&&!isAssignmentField(edit.columnId));
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
      if (irisSwapCell(camera, field)) {
        // Picking the other direction swaps Open and Closed, which is all a Tilta has for it.
        const text = value.trim().toLocaleLowerCase(), current = irisSwapValue(camera);
        const wanted = irisSwapChoices.find(option => option.value === text || option.label.toLocaleLowerCase() === text)?.value;
        // Left and Right belong to another lens, so a row pasted from one leaves this cell alone.
        if (text && !wanted && !['left', 'right'].includes(text)) invalid++;
        if (!wanted || !current || wanted === current) continue;
        const fields = changed.get(camera) ?? new Set(), open = camera.irisMin, closed = camera.irisMax;
        for (const edited of [...stageCell(camera, 'irisMin', closed, false), ...stageCell(camera, 'irisMax', open, false)]) fields.add(edited);
        changed.set(camera, fields);
        continue;
      }
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
      redraw ||= field === 'model' || field === 'lens' || cameraSort(virtualSheet(tab) ?? camera.device).field === field;
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

  // Camera Configuration is one list of every camera and where each one is set up. The REMI Matrix
  // is where a camera is attached to other RCPs, and it can also show the sheets of each controller.
  // A REMI copy is the same camera on another controller, so it shows in its source's row.
  //
  // A camera's copies go from its Source device to its Master RCP, then from the master to each
  // filled circle. With no master they go straight from the source. Nothing changes a controller
  // until it is sent from Pending sends, which every view shares.
  const controllerName = id => device(id)?.name || id;
  const sampleRouteMessage = 'REMI is available for managed devices.';
  let movedCameraSequence = 0;
  // The new copy of a camera being moved. The row on screen stays the original until the move is done.
  const movesInFlight = new Set();
  let routeTreeMemo = null;
  let pendingSendsOpen = false;
  let remiByController = false;
  const queuedSends = new Set();
  const routeErrors = new Map();
  // A camera with no Source yet isn't on any controller, so it is only ever saved with the page.
  const unassigned = camera => camera.device === '';

  const pendingAside = document.createElement('aside');
  (function createCameraTabs() {
    const configTab = root.querySelector('#hc-tab-cameras');
    configTab.dataset.tab = 'setup';
    configTab.setAttribute('aria-controls', 'hc-setup');
    const button = document.createElement('button');
    Object.assign(button, { className: 'hc-tab', id: 'hc-tab-assignment', innerHTML: 'REMI Matrix <span class="hc-tab-count" data-role="all-camera-count">0</span>' });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'hc-assignment');
    button.setAttribute('aria-selected', 'false');
    button.dataset.tab = 'assignment';
    configTab.after(button);
    const toggle = pendingSendsToggle();
    const viewSwitch = '<div class="hc-segment hc-remi-view" role="group" aria-label="REMI Matrix view"><button type="button" data-remi-view="matrix" aria-pressed="true">Matrix</button><button type="button" data-remi-view="controllers" aria-pressed="false">By controller</button></div>';
    const deleteButton = id => '<button class="hc-button" data-action="clear-selected" disabled title="Forget the selected cameras here. Nothing is sent to a controller.">' + icon('eye-off') + '<span data-camera-clear-label>Clear from view</span></button><button class="hc-danger" data-action="delete-controller" data-id="' + id + '" disabled>' + icon('trash-2') + '<span data-camera-delete-label>Delete camera</span></button>';
    const setup = document.createElement('section');
    Object.assign(setup, { id: 'hc-setup', className: 'hc-panel', hidden: true });
    setup.setAttribute('role', 'tabpanel');
    setup.setAttribute('aria-labelledby', 'hc-tab-cameras');
    setup.innerHTML =
      '<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>Cameras</h3><span data-role="setup-summary"></span></div>' + toggle + '</div>' +
      '<div class="hc-mode-note" data-role="setup-note"></div>' +
      '<div class="hc-assignment-body" data-pending-host="setup"><div class="hc-controller-list"><section class="hc-controller" data-role="setup-group">' +
        '<div class="hc-controller-tools">' +
          cameraCountControl(cameraSetupSheet) + '<span class="hc-caption hc-count-hint">New rows join the end</span>' +
          '<span class="hc-right"></span>' + deleteButton(cameraSetupSheet) +
        '</div>' +
        '<div data-role="setup-sheet"></div>' +
      '</section></div></div>' +
      '<div class="hc-panel-foot"><span data-role="setup-foot"></span></div>';
    const panel = document.createElement('section');
    Object.assign(panel, { id: 'hc-assignment', className: 'hc-panel', hidden: true });
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'hc-tab-assignment');
    panel.innerHTML =
      '<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>REMI matrix</h3><span data-role="assignment-summary"></span></div>' + viewSwitch + toggle + '</div>' +
      '<div class="hc-mode-note" data-role="assignment-note"></div>' +
      '<div class="hc-assignment-body" data-pending-host="assignment"><div class="hc-controller-list"><section class="hc-controller" data-role="assignment-group">' +
        '<div class="hc-controller-tools">' +
          '<span class="hc-right"></span>' + deleteButton(allCamerasSheet) +
        '</div>' +
        '<div data-role="assignment-sheet"></div>' +
      '</section></div></div>' +
      '<div class="hc-panel-foot"><span data-role="assignment-foot"></span></div>';
    const cameraPanel = root.querySelector('#hc-cameras');
    cameraPanel.before(setup);
    cameraPanel.after(panel);
    cameraPanel.setAttribute('aria-labelledby', 'hc-tab-assignment');
    // The sheets of each controller are another view of the matrix, beside the same list.
    const controllers = $('controllers'), body = document.createElement('div');
    body.className = 'hc-assignment-body';
    body.dataset.pendingHost = 'cameras';
    controllers.before(body);
    body.append(controllers);
    cameraPanel.querySelector('.hc-toolbar').insertAdjacentHTML('beforeend', viewSwitch + toggle);
    Object.assign(pendingAside, { className: 'hc-pending-sends', id: 'hc-pending-sends', hidden: true });
    pendingAside.dataset.role = 'pending-sends';
    pendingAside.setAttribute('aria-label', 'Pending sends');
    pendingAside.innerHTML =
      '<header><h3>Pending sends</h3><button type="button" data-action="toggle-pending-sends" aria-label="Close pending sends">' + icon('x') + '</button></header>' +
      '<p data-role="pending-sends-summary"></p>' +
      '<div class="hc-pending-actions"><button type="button" class="hc-primary" data-action="send-all-pending">Send all</button><button type="button" data-action="cancel-all-pending">Cancel all</button></div>' +
      '<div class="hc-pending-list" data-role="pending-sends-list"></div>';
    body.append(pendingAside);
  })();
  function pendingSendsToggle() {
    return '<button class="hc-button hc-pending-toggle" data-action="toggle-pending-sends" data-pending="false" aria-expanded="false" aria-controls="hc-pending-sends" aria-label="Pending sends"><span class="hc-pending-dot" aria-hidden="true"></span><span class="hc-pending-count" data-pending-sends-count hidden>0</span><span data-pending-sends-word>All sent</span>' + icon('chevron-down') + '</button>' +
      '<button class="hc-primary hc-pending-quick" data-action="send-all-pending-quick" hidden>' + icon('send') + '<span data-pending-quick-label>Send</span></button>';
  }
  function placePendingSends() {
    const host = root.querySelector('[data-pending-host="' + tab + '"]');
    if (host && pendingAside.parentElement !== host) host.append(pendingAside);
    // The list floats over the sheet just under its toolbar, so the toolbar's buttons stay in reach.
    const tools = host?.querySelector('.hc-controller-tools');
    pendingAside.style.top = tools ? Math.max(0, tools.getBoundingClientRect().bottom - host.getBoundingClientRect().top) + 'px' : '';
  }

  // Number and name stay frozen, then where the camera starts and its master, then a circle per RCP.
  function arrangeAllCameraColumns(columns) {
    const frozen = columns.filter(column => column.frozen !== undefined), sync = columns.filter(column => column.id === 'sync');
    return [...frozen, { id: 'source', label: 'Source', width: 140 }, { id: 'remiMaster', label: 'Master RCP', width: 140 },
      ...routeReceivers().map(d => ({ id: 'remi:' + d.id, label: d.name, width: Math.max(84, Math.min(150, d.name.length * 8 + 24)) })), ...sync];
  }

  // Which row each copy came from. Reading a copy's source is a search of every row, and a
  // redraw asks for each row's route several times, so one pass answers a whole draw.
  function routeTree() {
    if (routeTreeMemo) return routeTreeMemo;
    const owners = new Map(devices.map(d => [String(d.serial).toLowerCase(), d]));
    const byKey = new Map(cameras.filter(row => row.elementKey).map(row => [row.device + '\n' + row.elementKey, row]));
    const parents = new Map(), children = new Map();
    for (const row of cameras) {
      const info = row.remi, owner = info && owners.get(String(info.peer ?? '').toLowerCase());
      if (!owner) continue;
      let parent = info.sourceKey ? byKey.get(owner.id + '\n' + info.sourceKey) : undefined;
      if (!info.sourceKey && info.label) {
        const named = cameras.filter(camera => camera.device === owner.id && camera.elementKey && (camera.number + ' ' + camera.name).trim() === info.label);
        if (named.length === 1) parent = named[0];
      }
      if (!parent || parent === row) continue;
      parents.set(row, parent);
      children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    routeTreeMemo = { parents, children };
    queueMicrotask(() => { routeTreeMemo = null; });
    return routeTreeMemo;
  }
  // A copy whose source isn't in this workspace keeps its own row, since nothing else can show it.
  function assignmentRows() {
    const { parents } = routeTree();
    return cameras.filter(camera => !movesInFlight.has(camera) && (!importedCamera(camera) || !parents.has(camera)));
  }
  function sheetCameras(id) {
    return id === cameraSetupSheet ? assignmentRows() : id === allCamerasSheet ? matrixRows() : cameras.filter(camera => camera.device === id);
  }
  function matrixRows() { return assignmentRows().filter(camera => !unassigned(camera)); }
  // The camera a copy was made from, however many copies away.
  function sourceRowOf(copy) {
    const { parents } = routeTree();
    let row = copy;
    for (let hops = 0; parents.has(row) && hops < 8; hops++) row = parents.get(row);
    return row === copy || importedCamera(row) ? null : row;
  }

  // Where the camera really is: the controller it is set up on, and every copy and where that comes from.
  function actualRoute(camera) {
    const { children } = routeTree(), kids = row => children.get(row) ?? [];
    const links = {}, keys = {}, copies = [], seen = new Set([camera]);
    (function walk(row) {
      for (const copy of kids(row)) {
        if (seen.has(copy)) continue;
        seen.add(copy);
        copies.push(copy);
        links[copy.device] = row.device;
        // Where the copy sits on its controller, so a send can go straight to it.
        if (copy.elementKey) keys[copy.device] = copy.elementKey;
        walk(copy);
      }
    })(camera);
    const fixed = copies.length !== Object.keys(links).length || copies.some(copy => !canBeMaster(device(copy.device)));
    return { source: camera.device, links, fixed, keys };
  }
  function wantedRoute(camera) {
    const actual = actualRoute(camera), draft = camera.routeDraft ?? {};
    return { source: draft.source ?? actual.source, links: draft.links ?? actual.links };
  }
  // The one RCP everything goes through. A camera with a single copy only has a master if one was chosen.
  function masterOf(route, chosen) {
    const receivers = Object.keys(route.links), first = receivers.filter(rcp => route.links[rcp] === route.source);
    return first.length === 1 && (receivers.length > 1 || chosen === first[0]) ? first[0] : '';
  }
  const wantedMaster = camera => masterOf(wantedRoute(camera), camera.remiMaster);
  const actualMaster = camera => masterOf(actualRoute(camera), camera.remiMaster);
  const routeCircles = (route, chosen) => { const master = masterOf(route, chosen); return Object.keys(route.links).filter(rcp => rcp !== master); };
  function routeFromSource(source, master, circles) {
    const links = {}, hub = master || source;
    if (master && master !== source) links[master] = source;
    for (const rcp of circles) if (rcp !== source && rcp !== master) links[rcp] = hub;
    return links;
  }
  const routeText = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const sameRoute = (a, b) => routeText(a) === routeText(b);
  const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));
  const routeHasChanges = camera => !!camera.routeDraft;
  const isMove = camera => !!camera.elementKey && !!camera.routeDraft?.source;
  const masterChanged = camera => routeHasChanges(camera) && wantedMaster(camera) !== actualMaster(camera);
  // These delete a camera or re-route all of its copies, so Auto send leaves them in Pending sends.
  const waitsForSend = camera => isMove(camera) || masterChanged(camera) || !!camera.removeStaged;
  function copyRemoval(copy) {
    if (!importedCamera(copy)) return false;
    const source = sourceRowOf(copy);
    return !!source && (!!source.removeStaged || routeHasChanges(source) && !(copy.device in wantedRoute(source).links));
  }
  function removalStaged(camera) { return !!camera.removeStaged || copyRemoval(camera); }
  function routeChanged(camera, field) {
    if (!isAssignmentField(field) || !routeHasChanges(camera) || camera.removeStaged) return false;
    const actual = actualRoute(camera), wanted = wantedRoute(camera);
    if (field === 'source') return wanted.source !== actual.source;
    const before = masterOf(actual, camera.remiMaster), after = masterOf(wanted, camera.remiMaster);
    if (field === 'remiMaster') return before !== after;
    const rcp = field.slice(5);
    // A move or a new master re-routes every copy, and the cell that changed already says so.
    return wanted.source !== actual.source || before !== after ? rcp in wanted.links !== rcp in actual.links : (wanted.links[rcp] ?? '') !== (actual.links[rcp] ?? '');
  }
  function syncResult(camera) {
    if (unassigned(camera)) return 'Not assigned';
    if (removalStaged(camera) && !camera.jobs && !camera.deleting) return 'Delete';
    if (queuedSends.has(camera) && !camera.jobs) return 'Queued';
    return !camera.jobs && routeHasChanges(camera) && ['In sync', 'Verified'].includes(camera.result) ? 'Pending' : camera.result;
  }
  function setRouteDraft(camera, wanted) {
    const actual = actualRoute(camera), draft = {};
    if (wanted.source !== actual.source) draft.source = wanted.source;
    if (!sameRoute(wanted.links, actual.links)) draft.links = wanted.links;
    if (Object.keys(draft).length) camera.routeDraft = draft;
    else delete camera.routeDraft;
  }
  function settleRouteDraft(camera) {
    if (camera.routeDraft) setRouteDraft(camera, wantedRoute(camera));
  }
  // A camera that isn't on any controller yet has nothing to move, only somewhere to be created.
  function applyWantedRoute(camera, wanted) {
    if (!camera.elementKey && !camera.createState && wanted.source !== camera.device) {
      camera.device = wanted.source;
      routeTreeMemo = null;
    }
    setRouteDraft(camera, wanted);
  }

  function assignmentDisplay(camera, field, sheetId = allCamerasSheet) {
    if (importedCamera(camera)) {
      const peer = camera.remi?.origin?.serial || camera.remi?.peer || camera.remiPeer;
      const label = field !== 'source' ? '' : peer ? remiDeviceName(peer) : 'Copy on ' + controllerName(camera.device);
      return { value: '', label, locked: peer ? 'Its source controller is not in this workspace.' : 'This is a REMI copy and its source is not known yet. Press Refresh all while this controller is reachable.' };
    }
    const wanted = wantedRoute(camera), noSource = 'Choose a Source on Camera Configuration first.';
    const locked = camera.removeStaged ? 'This camera is waiting to be deleted. Cancel that in Pending sends to change it.' : camera.deleting ? 'This camera is being deleted.' : actualRoute(camera).fixed ? 'This camera’s REMI copies don’t fit this table. Use the REMI panel in Camera Configuration.' : '';
    if (field === 'source') return { value: wanted.source, label: wanted.source ? controllerName(wanted.source) : 'Choose source', none: !wanted.source, locked, readOnly: sheetId === cameraSetupSheet ? '' : 'Change the Source on Camera Configuration.' };
    const master = masterOf(wanted, camera.remiMaster);
    if (field === 'remiMaster') return { value: master, label: master ? controllerName(master) : 'None', none: !master, locked: locked || (wanted.source ? '' : noSource) };
    const rcp = field.slice(5);
    if (rcp === wanted.source) return { label: 'Source', locked: 'This is the camera’s Source device.' };
    if (rcp === master) return { label: 'Master', master: true, locked: 'This is the camera’s Master RCP. Change it in the Master RCP column.' };
    return { circle: true, on: rcp in wanted.links, locked: locked || (wanted.source ? '' : noSource) };
  }
  function assignmentCell(camera, field, sheetId = allCamerasSheet) {
    const shown = assignmentDisplay(camera, field, sheetId), why = shown.locked || shown.readOnly, title = why ? ' title="' + esc(why) + '"' : '';
    if (shown.circle) return '<span data-hubble-boolean data-field="' + esc(field) + '" data-row="' + esc(camera.id) + '"' + title + '></span>';
    if (shown.master) return '<span class="hc-route-master"' + title + '>Master</span>';
    if ((field === 'remiMaster' || field === 'source') && !shown.locked && !shown.readOnly) return '<button type="button" tabindex="-1" class="hc-cell-input hc-choice-cell' + (shown.none ? ' hc-route-none' : '') + '" data-row="' + esc(camera.id) + '" data-field="' + field + '" data-camera-choice value="' + esc(shown.value) + '" aria-label="' + esc(assignmentLabel(field) + ' for camera ' + camera.number + ' · ' + shown.label) + '">' + esc(shown.label) + '</button>';
    return shown.label ? '<span class="hc-route-text' + (shown.none || shown.label === 'Source' ? ' hc-route-none' : '') + '"' + title + '>' + esc(shown.label) + '</span>' : '';
  }
  function assignmentSheetCell(camera, field, sheetId = allCamerasSheet) {
    const shown = assignmentDisplay(camera, field, sheetId);
    if (shown.circle) return { kind: 'boolean', value: shown.on ? 'TRUE' : 'FALSE', readOnly: !!shown.locked };
    if ((field === 'remiMaster' || field === 'source') && !shown.locked && !shown.readOnly) return { value: shown.value || 'None', choices: field === 'source' ? sourceChoices(camera) : masterChoices(camera) };
    return { value: shown.label, readOnly: true };
  }
  const assignmentSortValue = (camera, field) => assignmentDisplay(camera, field).label ?? '';
  function controllerChoice(d) {
    const twin = devices.some(other => other !== d && other.name === d.name);
    return { value: d.id, label: d.name + (twin ? ' · ' + d.serial : ''), group: d.kind };
  }
  // Once a camera is on a controller it can move, but it can't go back to being nowhere.
  const sourceChoices = camera => [...(camera.elementKey || camera.createState ? [] : [{ value: 'None', label: 'Not assigned' }]), ...orderedDevices().map(controllerChoice)];
  const masterChoices = camera => [{ value: 'None', label: 'None' }, ...remiControllers().filter(d => d.id !== wantedRoute(camera).source).map(controllerChoice)];
  function assignmentTarget(field, value) {
    const text = String(value).trim().toLocaleLowerCase(), match = list => list.map(controllerChoice).find(choice => choice.value.toLocaleLowerCase() === text || choice.label.toLocaleLowerCase() === text)?.value;
    if (field === 'source') return !text || text === 'none' || text === 'not assigned' ? '' : match(orderedDevices());
    if (field === 'remiMaster') return !text || text === 'none' ? '' : match(remiControllers());
    return ['true', '1', 'yes', 'on', '✓', '●'].includes(text) ? true : ['false', '0', 'no', 'off', ''].includes(text) ? false : undefined;
  }
  // Returns whether anything changed. Back where the controllers already are, their chain of copies
  // is kept as it is, so clicking one RCP doesn't re-route the others.
  function stageRoute(camera, field, next) {
    const before = JSON.stringify([camera.routeDraft ?? null, camera.remiMaster ?? null, camera.device]);
    const wanted = wantedRoute(camera), actual = actualRoute(camera), master = masterOf(wanted, camera.remiMaster);
    if (field === 'source' || field === 'remiMaster') {
      const source = field === 'source' ? next : wanted.source;
      if (field === 'source' && (next === wanted.source || !next && (camera.elementKey || camera.createState))) return false;
      const chosen = field === 'remiMaster' ? (next === source ? '' : next) : master === source ? '' : master;
      const circles = routeCircles(wanted, camera.remiMaster).filter(rcp => rcp !== source && rcp !== chosen);
      const unchanged = source === actual.source && chosen === masterOf(actual, chosen) && sameSet(circles, routeCircles(actual, chosen));
      camera.remiMaster = chosen;
      applyWantedRoute(camera, { source, links: unchanged ? actual.links : routeFromSource(source, chosen, circles) });
    } else {
      const rcp = field.slice(5), links = { ...wanted.links }, hub = master || wanted.source;
      // Clicking a circle shouldn't undo a master that was only known from how the copies are chained.
      if (master) camera.remiMaster = master;
      if (next) {
        const parent = actual.links[rcp];
        links[rcp] = parent && (parent === wanted.source || parent in links) ? parent : hub;
      } else {
        delete links[rcp];
        for (const [child, parent] of Object.entries(links)) if (parent === rcp) links[child] = hub;
      }
      applyWantedRoute(camera, { source: wanted.source, links });
    }
    return before !== JSON.stringify([camera.routeDraft ?? null, camera.remiMaster ?? null, camera.device]);
  }
  function paintRoute(camera) {
    for (const field of ['source', 'remiMaster', ...routeReceivers().map(d => 'remi:' + d.id)]) {
      for (const cell of root.querySelectorAll('table[data-camera-device] td[data-camera="' + CSS.escape(camera.id) + '"][data-column="' + CSS.escape(field) + '"]')) {
        const markup = assignmentCell(camera, field, cell.closest('table').dataset.cameraDevice);
        // The host draws the circle inside this slot, so a slot that stays a slot is left for it to update.
        if (!markup.includes('data-hubble-boolean') || !cell.querySelector('[data-hubble-boolean]')) cell.innerHTML = markup;
        if (cell.querySelector('[data-field]:enabled,[data-hubble-boolean]')) cell.removeAttribute('aria-readonly');
        else cell.setAttribute('aria-readonly', 'true');
        cell.classList.toggle('hc-changed', routeChanged(camera, field));
      }
    }
    paintItem(camera);
  }
  function editCameraRoutes(edits, cameraById, hold = false) {
    const rows = [...new Set(edits.map(edit => cameraById.get(edit.rowId)).filter(Boolean))];
    const before = cameraDraftSnapshot(rows), changed = new Set();
    // Where it starts and its master decide what the circles mean, so they go first.
    const order = ({ columnId }) => columnId === 'source' ? 0 : columnId === 'remiMaster' ? 1 : 2;
    let invalid = 0;
    for (const edit of [...edits].sort((a, b) => order(a) - order(b))) {
      const camera = cameraById.get(edit.rowId);
      if (!camera || assignmentDisplay(camera, edit.columnId).locked) continue;
      const next = assignmentTarget(edit.columnId, edit.value);
      if (next === undefined) { invalid++; continue; }
      if (stageRoute(camera, edit.columnId, next)) { changed.add(camera); routeErrors.delete(camera.id); }
    }
    if (invalid) toast(invalid + ' ' + (invalid === 1 ? 'choice is' : 'choices are') + ' unavailable for that camera');
    if (!changed.size) return;
    recordCameraDrafts(before, rows);
    // A circle only changes its own row, so it needn't redraw the sheet. The rest can change which columns say what.
    if (hold || !edits.every(edit => edit.columnId.startsWith('remi:')) || isAssignmentField(cameraSort(virtualSheet(tab) ?? allCamerasSheet).field)) renderCameras();
    else {
      for (const camera of changed) paintRoute(camera);
      for (const sheet of cameraSheets.values()) sheet.refresh?.();
    }
    remember();
    const waiting = [...changed].filter(camera => hold || waitsForSend(camera)), rest = [...changed].filter(camera => !waiting.includes(camera));
    if (ui.sendMode === 'Auto send' && rest.length) void sendRoutes(rest);
  }

  // Delete only marks the camera. It goes to the controller from Pending sends, like everything else.
  function stageRemoval(rows, on) {
    rows = rows.filter(camera => !camera.jobs && !camera.deleting && !importedCamera(camera) && !!camera.removeStaged !== on);
    if (!rows.length) return;
    const before = cameraDraftSnapshot(rows);
    for (const camera of rows) {
      routeErrors.delete(camera.id);
      // A camera that never reached a controller has nothing to delete there.
      if (on && camera.isNew && !camera.elementKey && !camera.createState) { cameras = cameras.filter(row => row !== camera); queuedSends.delete(camera); continue; }
      if (on) camera.removeStaged = true;
      else delete camera.removeStaged;
    }
    recordCameraDrafts(before, rows.filter(camera => cameras.includes(camera)));
    renderCameras();
    remember();
  }
  // Clearing only forgets a camera here. Nothing goes to a controller, so the next read of one that
  // still has it brings it back. Its copies live in its row, so they go with it.
  function clearFromView(rows) {
    const { children } = routeTree(), gone = new Set();
    const add = row => { if (gone.has(row)) return; gone.add(row); for (const copy of children.get(row) ?? []) if (importedCamera(copy)) add(copy); };
    for (const camera of rows) if (!camera.jobs && !camera.deleting) add(camera);
    if (!gone.size) return;
    const saved = [...gone].map(row => copyPresentation(plainRow(row)));
    cameras = cameras.filter(row => !gone.has(row));
    for (const row of gone) { queuedSends.delete(row); routeErrors.delete(row.id); }
    recordCameraHistory(virtualSheet(tab) ?? [...gone][0].device, { kind: 'cleared', rows: saved });
    routeTreeMemo = null;
    renderCameras();
    remember();
    toast((rows.length === 1 ? 'Camera ' + rows[0].number : rows.length + ' cameras') + ' cleared from view. Anything still on a controller comes back on the next read.');
  }
  function setClearedRows(rows, gone) {
    const ids = new Set(rows.map(row => row.id));
    if (gone) cameras = cameras.filter(row => !ids.has(row.id));
    // A read may have brought it back already.
    else for (const saved of rows) if (!cameras.some(row => row.id === saved.id || row.elementKey && row.device === saved.device && row.elementKey === saved.elementKey)) cameras.push(restoredRow(copyPresentation(saved)));
    routeTreeMemo = null;
    renderCameras();
    remember();
  }
  function cameraMenuItems(camera, cameraById) {
    const staged = removalStaged(camera);
    return [{ id: 'refresh-camera', label: 'Refresh camera', disabled: !camera.elementKey || !!camera.deleting || !!camera.jobs || cameraEnabledSent.has(camera.id) || !!cameraEnabledJob(camera), run: () => runCameraEnabled(cameraById.get(camera.id) ?? camera, 'refresh') }, { id: 'clear-camera', label: 'Clear from view', disabled: !!camera.deleting || !!camera.jobs, run: () => clearFromView([cameraById.get(camera.id) ?? camera]) }, { id: 'delete-camera', label: staged ? 'Keep camera' : importedCamera(camera) ? 'Remove REMI copy' : 'Delete camera', icon: staged ? undefined : 'delete', danger: !staged, disabled: !!camera.deleting || !!camera.jobs, run: () => reviewCameraDeletion(cameraById.get(camera.id) ?? camera) }];
  }
  function removeCell(camera, column) {
    const staged = removalStaged(camera), label = (staged ? 'Keep camera ' : importedCamera(camera) ? 'Remove the REMI copy of camera ' : 'Delete camera ') + camera.number;
    const busy = camera.deleting || camera.jobs ? ' disabled' : '', clearLabel = 'Clear camera ' + camera.number + ' from view';
    const clear = camera.elementKey || importedCamera(camera) ? '<button type="button" class="hc-row-remove-button" data-action="clear-from-view" data-clear-row="' + esc(camera.id) + '" aria-label="' + esc(clearLabel) + '" title="' + esc(clearLabel) + '. Nothing is sent to a controller."' + busy + '>' + icon('eye-off') + '</button>' : '';
    return '<td class="hc-camera-frozen hc-row-remove" style="left:' + column.frozen + 'px">' + clear + '<button type="button" class="hc-row-remove-button" data-action="stage-remove" data-remove-row="' + esc(camera.id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (camera.deleting || camera.jobs ? ' disabled' : '') + '>' + icon(staged ? 'undo-2' : 'trash-2') + '</button></td>';
  }

  const requestFailure = (items, error) => ({ results: items.map(item => ({ id: item.id, error: error.message || 'REMI changes could not be confirmed' })), refresh: true });
  async function requestRoutes(items) {
    let report;
    try { report = await moduleBridge.remiRoute({ items }); }
    catch (error) { report = requestFailure(items, error); }
    for (const snapshot of report.snapshots || []) mergeOwn(snapshot);
    if (report.refresh) {
      try { await remiRefreshSheets(); }
      catch (error) { toast(error.message || 'Camera sheets could not be refreshed'); }
    }
    return report;
  }
  async function runRoutes(rows) {
    if (!moduleBridge || moduleBridge.preview) { toast(sampleRouteMessage); return; }
    const jobs = [];
    for (const camera of rows) {
      if (!cameras.includes(camera) || !camera.elementKey || !routeHasChanges(camera) || isMove(camera)) continue;
      const actual = actualRoute(camera), tree = wantedRoute(camera).links;
      if (sameRoute(tree, actual.links)) { delete camera.routeDraft; continue; }
      jobs.push({ camera, draft: camera.routeDraft, item: { id: camera.id, camera: camera.device, key: camera.elementKey, tree, expected: actual.links, copies: actual.keys } });
      camera.jobs++;
      camera.result = 'Sending';
      routeErrors.delete(camera.id);
      paintItem(camera);
    }
    if (!jobs.length) { renderCameras(); remember(); return; }
    const report = await requestRoutes(jobs.map(job => job.item));
    const errors = [];
    for (const { camera, draft } of jobs) {
      camera.jobs = Math.max(0, camera.jobs - 1);
      queuedSends.delete(camera);
      const result = report.results?.find(row => row.id === camera.id) ?? { error: 'REMI changes could not be confirmed' };
      if (result.error) {
        camera.result = 'Error';
        routeErrors.set(camera.id, result.error);
        errors.push(result.error);
        settleRouteDraft(camera);
        continue;
      }
      if (camera.routeDraft === draft) delete camera.routeDraft;
      else settleRouteDraft(camera);
      camera.result = camera.pending ? 'Pending' : 'Verified';
    }
    renderCameras();
    remember();
    toast(errors.length ? errors.length + ' ' + (errors.length === 1 ? 'assignment' : 'assignments') + ' could not be confirmed: ' + errors[0] : 'Camera assignments verified');
  }
  // One at a time, so each send starts from what the last one left on the controllers.
  let routeQueue = Promise.resolve();
  let sendsRunning = 0;
  function enqueueSend(run) {
    sendsRunning++;
    routeQueue = routeQueue.catch(() => undefined).then(run).finally(() => { sendsRunning--; schedulePendingSends(); });
    return routeQueue;
  }
  function sendRoutes(rows) {
    const ready = rows.filter(camera => !camera.jobs && camera.elementKey && !isMove(camera));
    for (const camera of ready) { queuedSends.add(camera); paintItem(camera); }
    return enqueueSend(async () => {
      try { await runRoutes(ready.filter(camera => queuedSends.has(camera))); }
      finally { for (const camera of ready) { queuedSends.delete(camera); if (cameras.includes(camera)) paintItem(camera); } }
    });
  }
  // What Pending sends sends: deletions first, then settings, since a new camera can't be REMI'd
  // until it exists, then copies, then moves. Cancel takes a queued camera out at any point here.
  function sendPending(rows) {
    const ready = rows.filter(camera => !camera.jobs && !queuedSends.has(camera) && !pendingState(camera).blocked);
    if (!ready.length) return;
    for (const camera of ready) { queuedSends.add(camera); routeErrors.delete(camera.id); paintItem(camera); }
    return enqueueSend(async () => {
      const waiting = () => ready.filter(camera => queuedSends.has(camera) && cameras.includes(camera));
      try {
        const removals = waiting().filter(row => row.removeStaged);
        if (removals.length) await removeCameras(removals);
        const settings = waiting().filter(camera => camera.pending && !isMove(camera));
        if (settings.length) {
          await sendItems(settings, 'camera');
          for (const camera of settings) if (camera.pending || !routeHasChanges(camera)) queuedSends.delete(camera);
        }
        const routes = waiting().filter(camera => routeHasChanges(camera) && !isMove(camera));
        if (routes.length) await runRoutes(routes);
        for (const camera of waiting()) {
          queuedSends.delete(camera);
          if (isMove(camera)) await moveCamera(camera);
        }
      } finally {
        for (const camera of ready) { queuedSends.delete(camera); if (cameras.includes(camera)) paintItem(camera); }
        renderCameras();
        schedulePendingSends();
        void loadRemiJobs();
      }
    });
  }
  // One request for all the copies and one for all the deletes, so each controller sees one socket
  // however many cameras go. The copies come off first, or they'd be left pointing at nothing.
  async function removeCameras(rows) {
    for (const camera of rows) queuedSends.delete(camera);
    const chained = rows.map(camera => ({ camera, ...actualRoute(camera) })).filter(item => Object.keys(item.links).length), stuck = new Set();
    if (chained.length && moduleBridge && !moduleBridge.preview) {
      for (const { camera } of chained) { camera.jobs++; paintItem(camera); }
      const report = await requestRoutes(chained.map(({ camera, links, keys }) => ({ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: links, copies: keys })));
      for (const { camera } of chained) {
        camera.jobs = Math.max(0, camera.jobs - 1);
        const result = report.results?.find(row => row.id === camera.id);
        if (result?.verified) continue;
        stuck.add(camera);
        camera.result = 'Error';
        routeErrors.set(camera.id, 'Not deleted: ' + (result?.error || 'its REMI copies could not be removed'));
        paintItem(camera);
      }
    }
    const ready = rows.filter(camera => !stuck.has(camera) && cameras.includes(camera));
    if (!ready.length) return;
    await sendItems(ready, 'camera', true);
    for (const camera of ready) if (cameras.includes(camera)) routeErrors.set(camera.id, 'Not deleted from ' + controllerName(camera.device) + '.');
  }

  // Everything the sheet shows travels with the camera. A lens connection is a physical port on the
  // old controller, so it only comes along if the new controller offers the same one.
  async function restoreLensConnection(moved, port) {
    try {
      const { key, entries, saved } = await moduleBridge.options({ device: moved.device, rowId: moved.id, field: 'LensInterface' });
      if (key && entries.length) cameraChoiceCatalogs.set(key, { entries, saved });
      if (!entries.some(entry => entry.label === port)) return false;
      moved.lensPort = port;
      moved.dirty.add('lensPort');
      await sendItems([moved], 'camera', false, ['lensPort']);
      return moved.result === 'Verified';
    } catch { return false; }
  }
  async function moveCamera(camera) {
    if (!moduleBridge || moduleBridge.preview) { toast(sampleRouteMessage); return; }
    camera.jobs++;
    routeErrors.delete(camera.id);
    try { await carryCameraToController(camera); }
    finally { camera.jobs = Math.max(0, camera.jobs - 1); paintItem(camera); }
  }
  async function carryCameraToController(camera) {
    const wanted = wantedRoute(camera), actual = actualRoute(camera), target = device(wanted.source);
    const fail = message => { camera.result = 'Error'; routeErrors.set(camera.id, message); paintItem(camera); toast(message); };
    if (!target) { fail('Choose a Source device for this camera'); return; }
    if (camera.lensParams && !camera.lensParamsEditable) { fail('Camera ' + camera.number + '’s lens parameters can’t be carried over. Set it up on ' + target.name + ' by hand.'); return; }
    const hasCopies = Object.keys(actual.links).length > 0, holdsCopy = target.id in actual.links, oldName = controllerName(camera.device);
    const takeCopiesOff = async () => {
      const result = (await requestRoutes([{ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: actual.links, copies: actual.keys }])).results?.[0];
      if (!result?.verified) fail('Camera ' + camera.number + ' was not fully moved: ' + (result?.error || 'its REMI copies could not be removed'));
      return !!result?.verified;
    };
    camera.result = 'Sending';
    paintItem(camera);
    // A controller already holding a copy would refuse a second camera with the same number.
    if (holdsCopy && !await takeCopiesOff()) { renderCameras(); remember(); return; }
    initializeLensFields(camera);
    const { id, elementKey, newElementKey, createState, needsInitialization, remi, remiPeer, routeDraft, sentValues, jobs, deleting, dirty, ...settings } = camera;
    const moved = { ...settings, id: 'moved-camera-' + Date.now() + '-' + (++movedCameraSequence), device: target.id, enabledLensAxes: [...(camera.enabledLensAxes ?? [])], usb: 'USB · Automatic', lensPort: 'None', online: null, isNew: true, pending: true, result: 'Sending', revision: 0, jobs: 0, dirty: new Set() };
    const lensFields = [...Object.values(axisDefinitions).flat().map(definition => definition.id), 'lensIp'].filter(field => lensFieldUsed(moved, field) && moved[field]);
    const fields = ['number', 'name', 'model', 'ip', 'port', 'login', 'password', 'usb', 'lens', ...lensFields];
    moved.dirty = new Set(fields);
    const controlWasOn = cameraControlEnabled(camera);
    movesInFlight.add(moved);
    cameras.push(moved);
    await sendItems([moved], 'camera', false, fields);
    if (!moved.elementKey || moved.result !== 'Verified') {
      movesInFlight.delete(moved);
      // Nothing reached the new controller, so the row has nothing to stand for. The original is untouched.
      if (!moved.elementKey && !moved.createState) cameras = cameras.filter(row => row !== moved);
      if (holdsCopy) setRouteDraft(camera, wanted);
      fail('Camera ' + camera.number + ' was not moved to ' + target.name + '. It is still on ' + oldName + (holdsCopy ? ', with its REMI copies removed.' : '.'));
      renderCameras();
      remember();
      return;
    }
    const lensKept = !lensCapabilities(moved).port || !camera.lensPort || camera.lensPort === 'None' || await restoreLensConnection(moved, camera.lensPort);
    if (hasCopies && !holdsCopy && !await takeCopiesOff()) {
      movesInFlight.delete(moved);
      toast('Camera ' + camera.number + ' is now on both ' + target.name + ' and ' + oldName + '.');
      renderCameras();
      remember();
      return;
    }
    delete camera.routeDraft;
    await sendItems([camera], 'camera', true);
    movesInFlight.delete(moved);
    if (cameras.includes(camera)) {
      fail('Camera ' + camera.number + ' is now on both ' + target.name + ' and ' + oldName + ': it could not be deleted from the old controller.');
      renderCameras();
      return;
    }
    if (controlWasOn && cameraControlDevice(target)) submitCameraControl([{ kind: 'camera', controllerId: target.id, cameraId: moved.id, enabled: true }]);
    routeTreeMemo = null;
    setRouteDraft(moved, wanted);
    if (routeHasChanges(moved)) await runRoutes([moved]);
    renderCameras();
    remember();
    toast(lensKept ? 'Camera moved to ' + target.name : 'Camera moved to ' + target.name + ' · choose its lens connection there');
  }

  function describeRoute({ source, links }) {
    const stops = [controllerName(source)];
    for (let level = [source]; level.length;) {
      level = Object.keys(links).filter(rcp => level.includes(links[rcp]));
      if (level.length) stops.push(level.map(controllerName).join(', '));
    }
    return stops.join(' → ');
  }
  function settingLabel(field) {
    const axis = lensAxisForField(field);
    if (axis) return axisName(axis) + ' · ' + (axisDefinitions[axis].find(definition => definition.id === field)?.label ?? field);
    return { usb: 'Camera interface', lensPort: 'Lens connection', lensIp: 'Lens IP' }[field] ?? cameraSortLabels[field] ?? field;
  }
  function settingText(field, value) {
    if (value === null || value === undefined || value === '') return 'Blank';
    return field === 'password' ? '••••••••' : String(value);
  }
  function routeLines(camera) {
    if (!routeHasChanges(camera)) return [];
    const actual = actualRoute(camera), wanted = wantedRoute(camera), lines = [], moving = wanted.source !== actual.source;
    const before = masterOf(actual, camera.remiMaster), after = masterOf(wanted, camera.remiMaster);
    if (moving) lines.push({ id: 'source', label: 'Source device', change: controllerName(actual.source) + ' → ' + controllerName(wanted.source),
      note: !camera.elementKey ? '' : 'Moves the camera. Created on ' + controllerName(wanted.source) + ' with all its settings, then deleted from ' + controllerName(actual.source) + (Object.keys(actual.links).length ? '. It drops off the other RCPs until their REMIs are rebuilt.' : '.') });
    if (before !== after) lines.push({ id: 'master', label: 'Master RCP', change: (before ? controllerName(before) : 'None') + ' → ' + (after ? controllerName(after) : 'None') });
    for (const rcp of new Set([...Object.keys(actual.links), ...Object.keys(wanted.links)])) {
      if (rcp === wanted.source || before !== after && (rcp === before || rcp === after) || rcp in actual.links === rcp in wanted.links) continue;
      lines.push({ id: 'remi:' + rcp, label: 'REMI to ' + controllerName(rcp), change: rcp in actual.links ? 'On → Off' : 'Off → On' });
    }
    const repathed = Object.keys(wanted.links).some(rcp => rcp in actual.links && wanted.links[rcp] !== actual.links[rcp]);
    if (!moving && before === after && repathed) lines.push({ id: 'route', label: 'Route', change: describeRoute(wanted), note: 'Currently ' + describeRoute(actual) });
    if (!moving && lines.length) lines[lines.length - 1].note ??= 'Goes ' + describeRoute(wanted);
    return lines;
  }
  function settingLines(camera) {
    if (camera.isNew) return camera.pending ? [{ id: 'new', label: 'New camera', change: 'Created on ' + controllerName(camera.device), cancellable: !camera.createState }] : [];
    return [...camera.dirty].map(field => {
      const known = camera.sentValues && field in camera.sentValues;
      return { id: 'setting:' + field, label: settingLabel(field), change: (known ? settingText(field, camera.sentValues[field]) + ' → ' : 'Now ') + settingText(field, camera[field]) };
    });
  }
  function pendingLines(camera) {
    if (importedCamera(camera) || unassigned(camera)) return [];
    if (camera.removeStaged) {
      const copies = Object.keys(actualRoute(camera).links).map(controllerName);
      return [{ id: 'delete', label: 'Delete camera', change: 'Deleted from ' + controllerName(camera.device), note: copies.length ? 'Its REMI copies on ' + copies.join(' and ') + ' come off first.' : '' }];
    }
    return [...routeLines(camera), ...settingLines(camera)];
  }
  function pendingState(camera) {
    if (camera.deleting || camera.jobs) return { text: 'Sending…', kind: 'active', blocked: true };
    if (queuedSends.has(camera)) return { text: 'Queued', kind: 'active', blocked: true };
    const wanted = wantedRoute(camera), actual = actualRoute(camera);
    const offline = [...new Set([camera.device, wanted.source, ...Object.keys(actual.links), ...Object.keys(wanted.links)])].filter(id => device(id)?.online === false);
    const error = routeErrors.get(camera.id) ?? (['Pending', 'Verified', 'In sync', 'Queued', 'Sending', 'Verifying', 'Error'].includes(camera.result) ? '' : camera.result);
    if (error) return { text: error, kind: 'failed', blocked: !!offline.length };
    if (offline.length) return { text: 'Won’t send while ' + offline.map(controllerName).join(' and ') + (offline.length === 1 ? ' is' : ' are') + ' offline', kind: 'offline', blocked: true };
    return { text: camera.result === 'Error' ? 'Could not be confirmed' : '', kind: camera.result === 'Error' ? 'failed' : '', blocked: false };
  }
  const pendingRows = () => sortCameraRows(assignmentRows(), allCamerasSheet).flatMap(camera => { const lines = pendingLines(camera); return lines.length ? [{ camera, lines }] : []; });
  // REMI changes staged per controller have no camera row to sit on, but they still wait to be sent.
  const remiDraftGroups = () => [...remiPanels].filter(([id, state]) => device(id) && state.drafts.size).map(([id, state]) => ({ id, state, items: [...state.drafts.values()] }));
  const remiDraftLabel = item => item.kind === 'tag' ? (item.enable ? 'Add REMI tag' : 'Remove REMI tag') : item.enable ? 'Import REMI camera' : 'Remove REMI copy';
  const remiGroupBlocked = ({ id, state }) => state.busy || device(id)?.online === false;
  function remiGroupMarkup(group) {
    const { id, state, items } = group, name = esc(controllerName(id));
    return '<div class="hc-pending-camera" data-pending-remi="' + esc(id) + '"><div><strong>' + name + '</strong><small>REMI copies</small></div>' +
      pendingButton('Send', 'data-pending-remi-send="' + esc(id) + '" aria-label="Send REMI changes on ' + name + '"', remiGroupBlocked(group)) +
      pendingButton('Cancel', 'data-pending-remi-cancel="' + esc(id) + '" aria-label="Cancel REMI changes on ' + name + '"', state.busy) + '</div>' +
      items.map((item, index) => '<div class="hc-pending-item" data-pending-remi-line="' + esc(item.id) + '"><div class="hc-pending-setting">' + esc(remiDraftLabel(item)) + '</div><div class="hc-pending-change">' + esc(item.label ?? item.tag ?? '') + '</div>' +
        (index === 0 && device(id)?.online === false ? '<div class="hc-pending-status" data-kind="offline">Won’t send while ' + name + ' is offline</div>' : '') +
        pendingButton('Cancel', 'data-pending-remi-item="' + esc(item.id) + '" data-pending-remi-device="' + esc(id) + '" aria-label="Cancel ' + esc(remiDraftLabel(item)) + ' on ' + name + '"', state.busy) + '</div>').join('');
  }
  // Any change to a camera with copies is finished on each controller that has one. If one
  // of them can't be reached it stays unfinished, and that camera's copies can't change until it is
  // retried or dismissed.
  let remiJobs = [];
  async function loadRemiJobs() {
    if (!moduleBridge || moduleBridge.preview) return;
    try {
      const reply = await moduleBridge.remiSend({ operation: 'jobs' });
      const next = Array.isArray(reply.jobs) ? reply.jobs : [];
      if (JSON.stringify(next) === JSON.stringify(remiJobs)) return;
      remiJobs = next;
      schedulePendingSends();
    } catch { /* The list is read again after the next send or refresh. */ }
  }
  let remiJobBusy = false;
  function remiJobMarkup(job) {
    const where = job.receivers.map(controllerName), id = esc(job.source + '\n' + job.key), name = 'camera ' + esc(job.number);
    return '<div class="hc-pending-camera" data-pending-job="' + esc(job.key) + '"><div><strong>' + esc(job.number + ' · ' + job.name) + '</strong><small>Unfinished REMI refresh · ' + esc(controllerName(job.source)) + '</small></div>' +
      pendingButton('Retry', 'data-pending-job-retry="' + id + '" aria-label="Retry the REMI refresh for ' + name + '"', remiJobBusy) +
      pendingButton('Dismiss', 'data-pending-job-dismiss="' + id + '" aria-label="Dismiss the REMI refresh for ' + name + '"', remiJobBusy) + '</div>' +
      '<div class="hc-pending-item"><div class="hc-pending-setting">A change to this camera wasn’t finished' + (where.length ? ' on ' + esc(where.join(' and ')) : '') + '</div>' +
      '<div class="hc-pending-note">Until then this camera’s copies can’t be changed. Retry needs ' + esc([controllerName(job.source), ...where].join(', ')) + ' to be reachable. Dismiss it if those copies already look right.</div></div>';
  }
  async function settleRemiJob(value, operation) {
    const [source, key] = value.split('\n');
    if (remiJobBusy || !device(source)) return;
    remiJobBusy = true;
    paintPendingSends();
    try {
      const reply = await moduleBridge.remiSend({ receiver: source, operation, source, key });
      const failed = (reply.results || []).find(result => result.error);
      toast(failed ? failed.error : operation === 'retry' ? 'REMI refresh complete' : 'REMI refresh dismissed');
      if (operation === 'retry') { try { await remiRefreshSheets(); } catch { /* Refresh all reads them again. */ } }
    } catch (error) { toast(error.message || 'The REMI refresh could not be settled'); }
    remiJobBusy = false;
    await loadRemiJobs();
    renderCameras();
    schedulePendingSends();
  }
  // Network changes made on the Devices sheet wait here too, one group per device.
  function lanColumnLabel(row) {
    if (row.type === 'WAN') return 'WAN';
    const index = lans.filter(item => item.device === row.device && item.type !== 'WAN' && !item.readOnly).indexOf(row);
    return index <= 0 ? 'LAN IP' : 'LAN IP ' + (index + 1);
  }
  const lanDraftGroups = () => orderedDevices().map(d => ({ id: d.id, rows: lans.filter(row => row.device === d.id && row.pending) })).filter(group => group.rows.length);
  const lanGroupBlocked = group => group.rows.some(row => row.jobs > 0) || device(group.id)?.online === false;
  function lanChangeText(row) {
    const extras = [['gateway', 'gateway'], ['dns1', 'DNS 1'], ['dns2', 'DNS 2']].filter(([field]) => row.dirty.has(field)).map(([field, label]) => label + ' ' + (row[field] || 'blank'));
    return (row.current || 'Blank') + ' → ' + (row.type === 'WAN' && row.dhcp ? 'DHCP' : row.planned || 'Blank') + (extras.length ? ' · ' + extras.join(' · ') : '');
  }
  function lanGroupMarkup(group) {
    const { id, rows } = group, name = esc(controllerName(id)), busy = rows.some(row => row.jobs > 0);
    return '<div class="hc-pending-camera" data-pending-lan="' + esc(id) + '"><div><strong>' + name + '</strong><small>Network settings</small></div>' +
      pendingButton('Send', 'data-pending-lan-send="' + esc(id) + '" aria-label="Send network changes to ' + name + '"', lanGroupBlocked(group)) +
      pendingButton('Cancel', 'data-pending-lan-cancel="' + esc(id) + '" aria-label="Cancel network changes for ' + name + '"', busy) + '</div>' +
      rows.map((row, index) => {
        const failed = !row.jobs && !['Pending', 'In sync', 'Verified', 'Sending', 'Verifying'].includes(row.result) ? row.result : '';
        const state = row.jobs ? ['Sending…', 'active'] : failed ? [failed === 'Error' ? 'Could not be confirmed' : failed, 'failed'] : index === 0 && device(id)?.online === false ? ['Won’t send while ' + controllerName(id) + ' is offline', 'offline'] : null;
        return '<div class="hc-pending-item" data-pending-lan-line="' + esc(row.id) + '"><div class="hc-pending-setting">' + esc(lanColumnLabel(row)) + '</div><div class="hc-pending-change">' + esc(lanChangeText(row)) + '</div>' +
          (state ? '<div class="hc-pending-status" data-kind="' + state[1] + '">' + esc(state[0]) + '</div>' : '') +
          pendingButton('Cancel', 'data-pending-lan-item="' + esc(row.id) + '" data-pending-lan-device="' + esc(id) + '" aria-label="Cancel ' + esc(lanColumnLabel(row)) + ' for ' + name + '"', row.jobs > 0) + '</div>';
      }).join('');
  }
  function cancelLanDrafts(id, rowId) {
    const rows = lans.filter(row => row.device === id && row.pending && !row.jobs && (!rowId || row.id === rowId));
    if (!rows.length) return;
    lans = lans.filter(row => !rows.includes(row) || row.elementKey);
    for (const row of rows) {
      if (!row.elementKey) continue;
      row.planned = row.current;
      row.operation = 'Keep';
      row.dirty.clear();
      row.pending = false;
      row.result = 'In sync';
      if (row.type === 'WAN') row.dhcp = row.current === 'DHCP';
    }
    renderLans();
    remember();
    // A WAN's gateway and DNS have no earlier value kept here, so the controller says what they were.
    if (rows.some(row => row.elementKey && row.type === 'WAN') && moduleBridge && !moduleBridge.preview) { autoReads.add(id); scheduleAutoRead(50); }
  }
  const sendLanGroup = group => sendItems(group.rows.filter(row => !row.jobs), 'lan').then(() => { renderLans(); });
  const pendingButton = (label, attributes, disabled) => '<button type="button" ' + attributes + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  function pendingGroupMarkup({ camera, lines }) {
    const state = pendingState(camera), id = esc(camera.id), name = 'camera ' + esc(camera.number), busy = !!camera.jobs || !!camera.deleting;
    return '<div class="hc-pending-camera" data-pending-camera="' + id + '"><div><strong>' + esc(camera.number) + ' · ' + esc(camera.name) + '</strong><small>' + esc(controllerName(camera.device)) + '</small></div>' +
      pendingButton('Send', 'data-pending-send="' + id + '" aria-label="Send all changes to ' + name + '"', state.blocked) +
      pendingButton('Cancel', 'data-pending-cancel="' + id + '" aria-label="Cancel all changes for ' + name + '"', busy) + '</div>' +
      lines.map((line, index) => '<div class="hc-pending-item" data-pending-line="' + esc(line.id) + '"><div class="hc-pending-setting">' + esc(line.label) + '</div><div class="hc-pending-change">' + esc(line.change) + '</div>' +
        (line.note ? '<div class="hc-pending-note">' + esc(line.note) + '</div>' : '') + (index === 0 && state.text ? '<div class="hc-pending-status" data-kind="' + state.kind + '">' + esc(state.text) + '</div>' : '') +
        pendingButton('Cancel', 'data-pending-cancel-line="' + esc(line.id) + '" data-pending-camera-id="' + id + '" aria-label="Cancel ' + esc(line.label) + ' for ' + name + '"', busy || line.cancellable === false) + '</div>').join('');
  }
  let paintedPending = null, pendingPaintQueued = false;
  function schedulePendingSends() {
    if (pendingPaintQueued) return;
    pendingPaintQueued = true;
    queueMicrotask(() => { pendingPaintQueued = false; paintPendingSends(); });
  }
  function paintPendingSends() {
    const rows = pendingRows(), groups = remiDraftGroups(), networks = lanDraftGroups();
    const total = rows.reduce((count, row) => count + row.lines.length, 0) + groups.reduce((count, group) => count + group.items.length, 0) + networks.reduce((count, group) => count + group.rows.length, 0) + remiJobs.length;
    for (const count of root.querySelectorAll('[data-pending-sends-count]')) { count.textContent = total; count.hidden = !total; }
    for (const word of root.querySelectorAll('[data-pending-sends-word]')) word.textContent = total ? ' pending' : 'All sent';
    for (const toggle of root.querySelectorAll('.hc-toolbar [data-action="toggle-pending-sends"]')) { toggle.dataset.pending = String(total > 0); toggle.setAttribute('aria-expanded', String(pendingSendsOpen)); }
    const cameraRows = assignmentRows();
    const foot = total + ' pending · ' + cameraRows.filter(camera => camera.online === false).length + ' cameras offline' + uncheckedCount(cameraRows, ' · ');
    $('assignment-foot').textContent = foot;
    $('setup-foot').textContent = foot;
    if (total && !cameras.some(camera => camera.jobs > 0) && !lans.some(lan => lan.jobs > 0)) {
      const everything = total;
      $('pending-summary').textContent = everything + (everything === 1 ? ' change pending' : ' changes pending');
      $('pending-summary').classList.add('hc-changes-label');
    }
    const ready = rows.filter(row => !pendingState(row.camera).blocked), readyCount = ready.reduce((sum, row) => sum + row.lines.length, 0) + groups.filter(group => !remiGroupBlocked(group)).reduce((sum, group) => sum + group.items.length, 0) + networks.filter(group => !lanGroupBlocked(group)).reduce((sum, group) => sum + group.rows.length, 0);
    for (const quick of root.querySelectorAll('[data-action="send-all-pending-quick"]')) {
      quick.hidden = !readyCount;
      quick.querySelector('[data-pending-quick-label]').textContent = 'Send ' + readyCount;
      quick.setAttribute('aria-label', 'Send ' + readyCount + (readyCount === 1 ? ' pending change' : ' pending changes'));
    }
    placePendingSends();
    pendingAside.hidden = !pendingSendsOpen || !['devices', 'setup', 'cameras', 'assignment'].includes(tab);
    if (pendingAside.hidden) { paintedPending = null; return; }
    pendingAside.querySelector('h3').textContent = total ? total + ' pending' : 'Pending sends';
    const markup = remiJobs.map(remiJobMarkup).join('') + networks.map(lanGroupMarkup).join('') + rows.map(pendingGroupMarkup).join('') + groups.map(remiGroupMarkup).join('');
    if (markup !== paintedPending) { $('pending-sends-list').innerHTML = markup; paintedPending = markup; }
    $('pending-sends-summary').textContent = !total ? (sendsRunning ? 'Sending…' : 'Nothing is waiting to send.') : total + (groups.length + networks.length + remiJobs.length ? (total === 1 ? ' item. ' : ' items. ') : total === 1 ? ' change on ' : ' changes on ') + (groups.length + networks.length + remiJobs.length ? '' : rows.length + (rows.length === 1 ? ' camera. ' : ' cameras. ')) + (ui.sendMode === 'Auto send' ? 'New edits send as you make them. Deletes, moves and Master RCP changes stay here until you press Send.' : 'Nothing goes to a controller until you press Send.');
    const all = action('send-all-pending');
    all.textContent = readyCount ? 'Send all (' + readyCount + ')' : 'Send all';
    all.disabled = !readyCount;
    action('cancel-all-pending').disabled = total === remiJobs.length || !groups.length && !networks.length && rows.every(row => row.camera.jobs || row.camera.deleting);
  }
  function setPendingSendsOpen(open) {
    if (pendingSendsOpen === open) return;
    pendingSendsOpen = open;
    paintPendingSends();
    remember();
  }
  // The list floats over the sheet, so Escape from inside it puts it away.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingSendsOpen || !event.target.closest?.('.hc-pending-sends, [data-action="toggle-pending-sends"]')) return;
    event.preventDefault();
    setPendingSendsOpen(false);
    root.querySelector('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]')?.focus();
  });

  const lensBlock = field => field === 'lens' || field === 'enabledLensAxes' || field === 'lensParamsEditable' || isLensSetting(field);
  function pruneSentValues(camera) {
    if (!camera.sentValues) return;
    if (!camera.dirty.size) { delete camera.sentValues; return; }
    if (camera.dirty.has('model')) return;
    const lensWaiting = [...camera.dirty].some(lensBlock);
    for (const field of Object.keys(camera.sentValues)) if (!camera.dirty.has(field) && !(lensWaiting && lensBlock(field))) delete camera.sentValues[field];
  }
  // A model or lens decides what the settings around it mean, so those go back together. An edit
  // saved by an older version has no earlier value here, so only the controller can say what it was.
  function cancelSetting(camera, field) {
    const saved = camera.sentValues ?? {}, all = [...new Set([...camera.dirty, ...Object.keys(saved)])];
    let unknown = false;
    for (const name of field === 'model' ? all : lensBlock(field) ? all.filter(lensBlock) : [field]) {
      if (!(name in saved)) { unknown ||= camera.dirty.has(name); camera.dirty.delete(name); continue; }
      if (saved[name] === null) delete camera[name];
      else camera[name] = saved[name];
      delete saved[name];
      camera.dirty.delete(name);
    }
    return unknown;
  }
  function cancelRouteLine(camera, line) {
    const wanted = wantedRoute(camera), actual = actualRoute(camera);
    if (line === 'source') { stageRoute(camera, 'source', actual.source); return; }
    if (line === 'master') { stageRoute(camera, 'remiMaster', masterOf(actual, camera.remiMaster)); return; }
    const hub = masterOf(wanted, camera.remiMaster) || wanted.source, links = { ...wanted.links };
    if (line === 'route') {
      for (const rcp of Object.keys(links)) { const parent = actual.links[rcp]; links[rcp] = parent && (parent === wanted.source || parent in links) ? parent : hub; }
    } else {
      const rcp = line.slice(5);
      if (rcp in actual.links) { const parent = actual.links[rcp]; links[rcp] = parent === wanted.source || parent in links ? parent : hub; }
      else { delete links[rcp]; for (const [child, parent] of Object.entries(links)) if (parent === rcp) links[child] = hub; }
    }
    setRouteDraft(camera, { source: wanted.source, links });
  }
  function cancelLine(camera, line) {
    if (line === 'new') { cameras = cameras.filter(row => row !== camera); queuedSends.delete(camera); return false; }
    if (line === 'delete') { delete camera.removeStaged; routeErrors.delete(camera.id); if (camera.result === 'Error') camera.result = camera.pending ? 'Pending' : 'In sync'; return false; }
    const unknown = line.startsWith('setting:') && cancelSetting(camera, line.slice(8));
    if (!line.startsWith('setting:')) cancelRouteLine(camera, line);
    camera.pending = !!camera.isNew || camera.dirty.size > 0;
    camera.revision++;
    camera.result = camera.pending ? 'Pending' : 'In sync';
    routeErrors.delete(camera.id);
    if (!pendingLines(camera).length) queuedSends.delete(camera);
    return unknown;
  }
  // Cancel clears a staged change as one Undo step. Whatever is being sent right now has already gone.
  function cancelPending(targets) {
    const open = targets.filter(({ camera }) => !camera.jobs && !camera.deleting);
    if (!open.length) return;
    const rows = [...new Set(open.map(target => target.camera))], before = cameraDraftSnapshot(rows);
    let reread = false;
    for (const { camera, line } of open) if (cameras.includes(camera) && cancelLine(camera, line)) reread = true;
    recordCameraDrafts(before, rows.filter(camera => cameras.includes(camera)));
    routeTreeMemo = null;
    renderCameras();
    remember();
    if (reread && moduleBridge && !moduleBridge.preview) void refreshLive();
  }
  // A camera's lines are worked out again after each one, since cancelling a move changes the others.
  function cancelCamera(camera) {
    const lines = pendingLines(camera).filter(line => line.cancellable !== false);
    if (lines.some(line => line.id === 'delete' || line.id === 'new')) { cancelPending(lines.filter(line => line.id === 'delete' || line.id === 'new').map(line => ({ camera, line: line.id }))); return; }
    const rows = [camera], before = cameraDraftSnapshot(rows);
    let reread = false;
    if (camera.routeDraft) { setRouteDraft(camera, actualRoute(camera)); }
    for (const line of settingLines(camera)) if (cancelLine(camera, line.id)) reread = true;
    camera.pending = !!camera.isNew || camera.dirty.size > 0;
    camera.result = camera.pending ? 'Pending' : 'In sync';
    routeErrors.delete(camera.id);
    queuedSends.delete(camera);
    recordCameraDrafts(before, rows);
    routeTreeMemo = null;
    renderCameras();
    remember();
    if (reread && moduleBridge && !moduleBridge.preview) void refreshLive();
  }
  function cancelRemiDrafts(id, itemId) {
    const state = remiPanels.get(id);
    if (!state || state.busy) return;
    if (itemId) state.drafts.delete(itemId);
    else state.drafts.clear();
    renderCameras();
    remember();
  }
  function cancelAllPending() {
    for (const { camera } of pendingRows()) if (!camera.jobs && !camera.deleting) cancelCamera(camera);
    for (const { id } of remiDraftGroups()) cancelRemiDrafts(id);
    for (const { id } of lanDraftGroups()) cancelLanDrafts(id);
  }
  async function sendAllPending() {
    for (const group of lanDraftGroups()) if (!lanGroupBlocked(group)) await sendLanGroup(group);
    await sendPending(pendingRows().map(item => item.camera));
    for (const group of remiDraftGroups()) if (!remiGroupBlocked(group)) await remiSend(group.id, group.items);
  }
  // Refresh all starts again from what the controllers say, so nothing is left waiting to be sent.
  function clearPendingSends() {
    const cleared = pendingRows().reduce((count, row) => count + row.lines.length, 0) + pendingLans().length + [...remiPanels.values()].reduce((count, state) => count + state.drafts.size, 0);
    queuedSends.clear();
    routeErrors.clear();
    routeQueue = Promise.resolve();
    for (const camera of [...cameras]) {
      camera.jobs = 0;
      camera.deleting = false;
      if (unassigned(camera)) continue;
      // A create with an unknown outcome: the read shows whether it happened.
      if (camera.createState) { cameras = cameras.filter(row => row !== camera); continue; }
      delete camera.routeDraft;
      delete camera.removeStaged;
      // A camera that never reached a controller keeps what was typed, and goes back to having no Source.
      if (camera.isNew && !camera.elementKey) { camera.device = ''; continue; }
      for (const [field, value] of Object.entries(camera.sentValues ?? {})) {
        if (value === null) delete camera[field];
        else camera[field] = value;
      }
      delete camera.sentValues;
      camera.dirty.clear();
      camera.pending = false;
      camera.result = 'In sync';
    }
    lans = lans.filter(lan => lan.elementKey || !lan.pending);
    for (const lan of lans) {
      lan.jobs = 0;
      if (!lan.pending && !lan.dirty.size) continue;
      lan.dirty.clear();
      lan.pending = false;
      lan.planned = lan.current;
      lan.operation = 'Keep';
      lan.result = 'In sync';
    }
    for (const state of remiPanels.values()) { state.drafts.clear(); state.picks.clear(); }
    routeTreeMemo = null;
    void loadRemiJobs();
    return cleared;
  }

  const virtualHosts = { [allCamerasSheet]: 'assignment', [cameraSetupSheet]: 'setup' };
  function drawVirtualSheet(sheetId) {
    const setup = sheetId === cameraSetupSheet, host = $(virtualHosts[sheetId] + '-sheet'), left = host.querySelector('.hc-scroll')?.scrollLeft || 0, rows = sheetCameras(sheetId);
    const tools = host.closest('.hc-controller').querySelector('.hc-controller-tools');
    if (!tools.querySelector('[data-camera-selection]')) tools.insertAdjacentHTML('beforeend', cameraSelectionStrip(sheetId));
    host.innerHTML = '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" role="grid" data-camera-device="' + sheetId + '" aria-label="' + (setup ? 'Cameras' : 'REMI matrix') + '">' + cameraGrid(rows, sheetId) + '</table></div></div>';
    const scroll = host.querySelector('.hc-scroll');
    if (scroll) scroll.scrollLeft = left;
    if (!setup) return;
    // A copy with no source here can't be edited, and it says which controller it came from.
    for (const row of rows.filter(importedCamera)) {
      const selector = 'td[data-camera="' + CSS.escape(row.id) + '"]';
      for (const field of host.querySelectorAll(selector + ' [data-field]:not([data-field="controlEnabled"])')) field.disabled = true;
      const model = host.querySelector(selector + '[data-column="model"]');
      if (model) model.textContent = remiModelName(row);
    }
  }
  const renderControllerSheets = renderCameras;
  renderCameras = function() {
    routeTreeMemo = null;
    // A read may have found the controllers already match what was waiting to be sent.
    for (const camera of cameras) if (!camera.jobs) settleRouteDraft(camera);
    const current = virtualSheet(tab);
    // A sheet only counts as being on the page while its tab has one drawn.
    for (const [sheet, name] of Object.entries(virtualHosts)) {
      if (sheet === current) continue;
      $(name + '-sheet').innerHTML = '';
      delete $(name + '-group').dataset.controller;
    }
    if (!current) { renderControllerSheets(); return; }
    $(virtualHosts[current] + '-group').dataset.controller = current;
    const focus = cameraSheetFocus();
    $('controllers').innerHTML = '';
    drawVirtualSheet(current);
    syncSummary();
    icons();
    refreshCameraSheets(focus);
  };
  function paintRemiView() {
    for (const button of root.querySelectorAll('[data-remi-view]')) button.setAttribute('aria-pressed', String((button.dataset.remiView === 'controllers') === remiByController));
  }
  const showTab = setTab;
  setTab = function(next, save = true) {
    // The REMI Matrix tab comes back to whichever view was last open.
    if (next === 'assignment' && remiByController) next = 'cameras';
    if (next === 'cameras') remiByController = true;
    const crossing = virtualSheet(tab) !== virtualSheet(next);
    showTab(next, false);
    if (next === 'cameras') root.querySelector('#hc-tab-assignment').setAttribute('aria-selected', 'true');
    paintRemiView();
    if (crossing) renderCameras();
    placePendingSends();
    paintPendingSends();
    if (save) remember();
  };
  const saveRemiView = () => ({ panelOpen: pendingSendsOpen, byController: remiByController, unassigned: cameras.filter(unassigned).map(plainRow), devices: { ...deviceSheet },
    ignored: [...ignoredControllers].filter(serial => !devices.some(d => d.serial === serial)).slice(0, 256) });
  function restoreRemiView(data) {
    const view = data.remiView, saved = Array.isArray(view?.unassigned) ? view.unassigned.filter(row => typeof row?.id === 'string' && row.device === '') : [];
    pendingSendsOpen = view?.panelOpen === true;
    remiByController = view?.byController === true;
    ignoredControllers.clear();
    for (const serial of Array.isArray(view?.ignored) ? view.ignored : []) if (typeof serial === 'string' && serial && serial.length <= 160) ignoredControllers.add(serial);
    const sheet = view?.devices ?? {};
    Object.assign(deviceSheet, { lanOpen: sheet.lanOpen === true, wanOpen: sheet.wanOpen === true, details: sheet.details === true,
      sort: deviceSortable.has(sheet.sort?.field) && ['asc', 'desc'].includes(sheet.sort.direction) ? { field: sheet.sort.field, direction: sheet.sort.direction } : null });
    paintDeviceView();
    // Saved before Camera Configuration was one list, this tab meant that page and not the view under REMI Matrix.
    if (data.tab === 'cameras' && view?.byController === undefined) data.tab = 'setup';
    cameras = [...cameras.filter(camera => !unassigned(camera)), ...saved.map(restoredRow)];
  }
  const syncBeforeAssignment = syncSummary;
  syncSummary = function() {
    syncBeforeAssignment();
    const rows = assignmentRows(), matrix = matrixRows(), waiting = rows.length - matrix.length;
    $('all-camera-count').textContent = matrix.length;
    $('camera-count').textContent = rows.length;
    $('assignment-summary').textContent = devices.length + ' controllers · ' + matrix.length + ' cameras';
    $('setup-summary').textContent = rows.length + (rows.length === 1 ? ' camera' : ' cameras') + (waiting ? ' · ' + waiting + ' not assigned' : '');
    $('assignment-note').textContent = ui.sendMode === 'Manual' ? 'Manual · click a circle to send a camera on to that RCP, then send it from Pending sends.' : 'Auto send · circles send as you click them. Deletes, moves and Master RCP changes wait in Pending sends.';
    $('setup-note').textContent = 'Set up each camera, then choose its Source. ' + (ui.sendMode === 'Manual' ? 'Nothing goes to a controller until you press Send in Pending sends.' : 'Settings send as you make them. Deletes and moves wait in Pending sends.');
    for (const name of Object.values(virtualHosts)) {
      const group = $(name + '-group');
      if (group.querySelector('table[data-camera-device]')) syncCameraDeleteButton(group);
    }
    if (['devices', 'setup', 'cameras', 'assignment'].includes(tab)) schedulePendingSends();
  };
  const sendCameraItems = sendItems;
  sendItems = async function(items, kind, deleting = false, fields = null) {
    if (kind === 'camera') items = items.filter(item => !unassigned(item));
    if (!items.length) return;
    await sendCameraItems(items, kind, deleting, fields);
    if (kind !== 'camera' || deleting) return;
    for (const item of items) pruneSentValues(item);
    // A new camera can't be REMI'd until it exists on its controller.
    if (ui.sendMode !== 'Auto send') return;
    const ready = items.filter(item => item.elementKey && !item.jobs && !queuedSends.has(item) && routeHasChanges(item) && !waitsForSend(item));
    if (ready.length) void sendRoutes(ready);
  };
  const mergeControllerSnapshot = mergeSnapshot;
  mergeSnapshot = function(snapshot) {
    const id = snapshot.device.id, before = cameras.filter(row => row.device === id && row.elementKey), flags = cameraControlFlags();
    mergeControllerSnapshot(snapshot);
    routeTreeMemo = null;
    // A camera deleted and added back under a new identity is still that camera, matched by its number
    // on that controller, so it keeps its tick and its chosen master.
    const carried = [];
    for (const old of before) {
      if (cameras.includes(old)) continue;
      const replacement = cameras.find(row => row.device === id && row.elementKey && row.number === old.number && !before.includes(row));
      if (!replacement) continue;
      if (old.remiMaster !== undefined && replacement.remiMaster === undefined) replacement.remiMaster = old.remiMaster;
      if (flags[old.id] === true && flags[replacement.id] !== true) carried.push({ kind: 'camera', controllerId: id, cameraId: replacement.id, enabled: true });
    }
    // The tick is saved against the camera's row, so the row is saved first.
    if (carried.length) queueMicrotask(() => { remember(); submitCameraControl(carried); });
  };
  // A LAN address can be set on two controllers by mistake and a base address can't, so a controller
  // saved on a LAN address is read over its base as soon as the page opens.
  function preferBaseAddresses() {
    if (!moduleBridge || moduleBridge.preview) return;
    void loadRemiJobs();
    for (const d of devices) if (d.base && (d.address || d.base) !== d.base) autoReads.add(d.id);
    if (autoReads.size) scheduleAutoRead(1200);
  }
  // MQTT reports a camera added, deleted or renumbered on a controller, so read that controller again
  // and the lists catch up with no Refresh all. Unlike Refresh all, this leaves pending changes alone.
  const seenCameraChanges = new Map(), autoReads = new Set();
  let autoReadTimer = null;
  function noticeCameraChanges(changes) {
    if (!moduleBridge || moduleBridge.preview || !changes) return;
    for (const [id, count] of Object.entries(changes)) {
      if ((seenCameraChanges.get(id) ?? 0) !== count && device(id)) autoReads.add(id);
      seenCameraChanges.set(id, count);
    }
    if (autoReads.size) scheduleAutoRead(200);
  }
  // Each managed controller also keeps a settings socket open and reports every change to its
  // configuration, whoever made it, so any setting catches up the same way, not just the camera list.
  let configChangesEpoch = null;
  const seenConfigChanges = new Map();
  function noticeConfigChanges(changes) {
    if (!moduleBridge || moduleBridge.preview || !changes?.counts) return;
    // A restarted worker counts from zero again.
    if (changes.epoch !== configChangesEpoch) { configChangesEpoch = changes.epoch; seenConfigChanges.clear(); }
    for (const [id, count] of Object.entries(changes.counts)) {
      if (seenConfigChanges.get(id) !== count && device(id)) autoReads.add(id);
      seenConfigChanges.set(id, count);
    }
    // The worker has already waited for a burst of changes to finish.
    if (autoReads.size) scheduleAutoRead(30);
  }
  function scheduleAutoRead(wait) { autoReadTimer ??= setTimeout(runAutoRead, wait); }
  // A send reports its own results, and a read partway through one would show half a change.
  const autoReadWaits = () => sendsRunning || cameras.some(camera => camera.jobs > 0 || camera.deleting) || [...remiPanels.values()].some(state => state.busy);
  async function runAutoRead() {
    autoReadTimer = null;
    if (!autoReads.size) return;
    if (autoReadWaits()) { scheduleAutoRead(500); return; }
    const ids = [...autoReads];
    autoReads.clear();
    try {
      const reply = await moduleBridge.refresh(ids, true);
      // A send that began during the read may already have changed what it read. The send's own change reads again after it.
      if (autoReadWaits()) { for (const id of ids) autoReads.add(id); scheduleAutoRead(500); return; }
      for (const snapshot of reply.snapshots || []) mergeSnapshot(snapshot);
      renderLans();
      renderCameras();
      remember();
    } catch { /* The next change or Refresh all reads it again. */ }
  }
  // Delete marks the camera for Pending sends. A copy comes off by clearing its circle on the camera
  // it was made from, and one whose source isn't here still asks first, as it always has.
  const reviewDeletion = reviewCameraDeletion;
  reviewCameraDeletion = function(camera) {
    if (!camera || camera.deleting) return;
    if (!importedCamera(camera)) { stageRemoval([camera], !camera.removeStaged); return; }
    const source = sourceRowOf(camera);
    if (!source || assignmentDisplay(source, 'remi:' + camera.device).locked && wantedMaster(source) !== camera.device) { reviewDeletion(camera); return; }
    if (source.removeStaged) { stageRemoval([source], false); return; }
    const on = camera.device in wantedRoute(source).links, edit = wantedMaster(source) === camera.device
      ? { rowId: source.id, columnId: 'remiMaster', value: on ? 'None' : camera.device }
      : { rowId: source.id, columnId: 'remi:' + camera.device, value: on ? 'FALSE' : 'TRUE' };
    editCameraRoutes([edit], new Map([[source.id, source]]), true);
  };
  const deleteCameraRow = deleteReviewedCamera;
  deleteReviewedCamera = async function(camera) {
    const { links, keys } = camera && !importedCamera(camera) ? actualRoute(camera) : { links: {}, keys: {} };
    if (Object.keys(links).length) {
      const result = (await requestRoutes([{ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: links, copies: keys }])).results?.[0];
      if (!result?.verified) {
        camera.result = 'Error';
        paintItem(camera);
        toast('Camera ' + camera.number + ' was not deleted: ' + (result?.error || 'its REMI copies could not be removed'));
        return;
      }
    }
    deleteCameraRow(camera);
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset, row = id => cameras.find(camera => camera.id === id);
    if (data.remiView) { remiByController = data.remiView === 'controllers'; setTab(remiByController ? 'cameras' : 'assignment'); }
    else if (data.action === 'toggle-pending-sends') setPendingSendsOpen(!pendingSendsOpen);
    else if (data.action === 'stage-remove' && row(data.removeRow)) reviewCameraDeletion(row(data.removeRow));
    else if (data.action === 'clear-from-view' && row(data.clearRow)) clearFromView([row(data.clearRow)]);
    else if (data.action === 'clear-selected') clearFromView(selectedCameras(button.closest('[data-controller]').querySelector('table[data-camera-device]')));
    else if (data.action === 'send-all-pending' || data.action === 'send-all-pending-quick') void sendAllPending();
    else if (data.pendingJobRetry) void settleRemiJob(data.pendingJobRetry, 'retry');
    else if (data.pendingJobDismiss) void settleRemiJob(data.pendingJobDismiss, 'dismiss');
    else if (data.pendingLanSend) { const group = lanDraftGroups().find(item => item.id === data.pendingLanSend); if (group) void sendLanGroup(group); }
    else if (data.pendingLanCancel) cancelLanDrafts(data.pendingLanCancel);
    else if (data.pendingLanItem) cancelLanDrafts(data.pendingLanDevice, data.pendingLanItem);
    else if (data.pendingRemiSend) { const group = remiDraftGroups().find(item => item.id === data.pendingRemiSend); if (group) void remiSend(group.id, group.items); }
    else if (data.pendingRemiCancel) cancelRemiDrafts(data.pendingRemiCancel);
    else if (data.pendingRemiItem) cancelRemiDrafts(data.pendingRemiDevice, data.pendingRemiItem);
    else if (data.action === 'cancel-all-pending') cancelAllPending();
    else if (data.pendingSend && row(data.pendingSend)) void sendPending([row(data.pendingSend)]);
    else if (data.pendingCancel && row(data.pendingCancel)) cancelCamera(row(data.pendingCancel));
    else if (data.pendingCancelLine && row(data.pendingCameraId)) cancelPending([{ camera: row(data.pendingCameraId), line: data.pendingCancelLine }]);
  });

  // Camera Enabled is Cyanview's own Enabled setting on each camera, not Hubble's Camera Control Enabled
  // checkmark. A REMI copy follows the camera it comes from, so its switch is locked. Refresh switches a
  // camera off and on again, then each copy made from it, which brings back a copy its RCP stopped selecting.
  let cameraEnabledJobs = [];
  const cameraEnabledSent = new Set();
  const cameraEnabledJob = camera => cameraEnabledJobs.find(job => job.device === camera.device && job.key === camera.elementKey);
  function cameraEnabledCell(camera) {
    if (!camera.elementKey || !camera.device) return '<span class="hc-caption">—</span>';
    const copy = importedCamera(camera), job = cameraEnabledJob(camera);
    const busy = !!job || cameraEnabledSent.has(camera.id) || !!camera.deleting || !!camera.jobs;
    const where = 'camera ' + camera.number + ' on ' + (device(camera.device)?.name || camera.device);
    const source = copy ? remiDeviceName(camera.remi?.peer || camera.remiPeer) : '';
    const choice = on => '<button type="button" data-action="camera-enabled" data-camera-enabled="' + (on ? 'on' : 'off') + '" data-enabled-row="' + esc(camera.id) +
      '" aria-pressed="' + String(camera.cameraEnabled === on) + '"' + (copy || busy ? ' disabled' : '') + '>' + (on ? 'On' : 'Off') + '</button>';
    const segment = '<span class="hc-segment hc-camera-enabled-switch' + (copy ? ' hc-locked' : '') + '" role="group" aria-label="Camera Enabled for ' + esc(where) + '"' +
      (copy ? ' title="Follows ' + esc(source) + '"' : '') + '>' + choice(true) + choice(false) + '</span>';
    const refresh = '<button type="button" class="hc-row-refresh-button' + (job ? ' hc-busy' : '') + '" data-action="refresh-camera" data-refresh-row="' + esc(camera.id) +
      '" aria-label="Refresh ' + esc(where) + '" title="' + esc(copy ? 'Off and on again on this RCP, then any copies made from it' : 'Off and on again, then its REMI copies') + '"' + (busy ? ' disabled' : '') + '>' + icon('refresh-cw') + '</button>';
    const note = job ? job.text : copy ? 'follows ' + source : '';
    return '<span class="hc-camera-enabled">' + segment + refresh + (note ? '<span class="hc-caption" data-camera-enabled-note>' + esc(note) + '</span>' : '') + '</span>';
  }
  function paintCameraEnabled(rows = cameras) {
    let painted = false;
    for (const camera of rows) for (const cell of root.querySelectorAll('td[data-column="cameraEnabled"][data-camera="' + CSS.escape(camera.id) + '"]')) {
      const markup = cameraEnabledCell(camera);
      if (cell.innerHTML !== markup) { cell.innerHTML = markup; painted = true; }
    }
    if (painted) icons();
  }
  function applyCameraEnabledJobs(jobs) {
    if (!Array.isArray(jobs)) return;
    const text = JSON.stringify(jobs);
    if (text === JSON.stringify(cameraEnabledJobs)) return;
    cameraEnabledJobs = jobs;
    paintCameraEnabled();
  }
  async function runCameraEnabled(camera, mode) {
    if (!moduleBridge || moduleBridge.preview) { toast('Sample data does not send commands to equipment'); return; }
    if (!camera?.elementKey || cameraEnabledSent.has(camera.id)) return;
    const before = camera.cameraEnabled, where = 'Camera ' + camera.number + ' on ' + (device(camera.device)?.name || camera.device);
    cameraEnabledSent.add(camera.id);
    // The switch moves at once. The controller's own report then confirms it, and a failure puts it back.
    if (mode !== 'refresh') camera.cameraEnabled = mode;
    paintCameraEnabled([camera]);
    try {
      const reply = mode === 'refresh' ? await moduleBridge.cameraRefresh(camera.device, camera.elementKey) : await moduleBridge.cameraEnabled(camera.device, camera.elementKey, mode);
      const copies = Number(reply?.copies) || 0, unread = (reply?.unread || []).map(id => device(id)?.name || id);
      const done = mode === 'refresh' ? where + ' refreshed' : where + ' switched ' + (mode ? 'on' : 'off');
      toast(done + (copies ? ' with ' + copies + (copies === 1 ? ' copy' : ' copies') : '') + (unread.length ? ' · could not reach ' + unread.join(', ') : ''));
    } catch (error) {
      if (mode !== 'refresh') camera.cameraEnabled = before;
      toast(error.message || 'Camera Enabled could not be changed');
    } finally {
      cameraEnabledSent.delete(camera.id);
      paintCameraEnabled([camera]);
    }
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-action="camera-enabled"],button[data-action="refresh-camera"]');
    if (!button || button.disabled) return;
    const camera = cameras.find(row => row.id === (button.dataset.enabledRow || button.dataset.refreshRow));
    if (!camera) return;
    if (button.dataset.action === 'refresh-camera') { void runCameraEnabled(camera, 'refresh'); return; }
    const on = button.dataset.cameraEnabled === 'on';
    if (camera.cameraEnabled !== on) void runCameraEnabled(camera, on);
  });

  // ── A rig that was set up outside Hubble ───────────────────────────────────
  // What is already on the controllers is read in as it is. Each controller lists the others it has
  // seen, so after a read the ones that answer are added, with their cameras and where each copy
  // comes from. Nothing is sent to a controller for any of this.
  // A controller removed here is left out of the search until it is added back by hand.
  const ignoredControllers = new Set();
  let findingRig = false;
  async function findRig() {
    if (!moduleBridge || moduleBridge.preview || findingRig) return;
    findingRig = true;
    const added = [];
    try {
      for (const serial of [...ignoredControllers]) if (devices.some(d => d.serial === serial)) ignoredControllers.delete(serial);
      const reply = await moduleBridge.findRig({ ignore: [...ignoredControllers] });
      for (const candidate of reply.found || []) {
        if (devices.some(d => d.serial === candidate.serial) || ignoredControllers.has(candidate.serial)) continue;
        if (devices.length >= 128) break;
        const snapshot = await moduleBridge.importDevice(candidate);
        if (cameras.length + snapshot.cameras.length > 512) break;
        devices.push(snapshot.device);
        cameras.push(...snapshot.cameras.map(row => ({ ...restoredRow(row), foreign: true })));
        lans.push(...snapshot.lans.map(restoredRow));
        added.push(snapshot.device);
      }
    } catch { /* A search that fails leaves the list as it was. */ }
    finally { findingRig = false; }
    if (!added.length) return;
    routeTreeMemo = null;
    try { await restoreCameraChoiceCatalogs(); } catch { /* The rows are still usable without their choice lists. */ }
    syncFilter();
    renderResults();
    renderLans();
    renderCameras();
    remember();
    toast('Added ' + added.length + (added.length === 1 ? ' controller' : ' controllers') + ' found on the network: ' + added.map(d => d.name).join(', '));
  }
  const refreshBeforeRig = refreshLive;
  refreshLive = async function() { await refreshBeforeRig(); void findRig(); };
  const addBeforeRig = addLiveResults;
  addLiveResults = async function() {
    const before = devices.length;
    await addBeforeRig();
    if (devices.length > before) void findRig();
  };
  const removeBeforeRig = removeManagedDevice;
  removeManagedDevice = function(id) {
    const removed = device(id);
    removeBeforeRig(id);
    if (removed && !device(id)) { ignoredControllers.add(removed.serial); remember(); }
  };

  // ── What Hubble didn't configure ───────────────────────────────────────────
  // A camera or REMI copy that a read turns up, and that wasn't here before, was set up outside
  // Hubble. It shows up like anything else and is asked about once: keep it as it is, or clear it.
  // What Hubble sends itself comes back through mergeOwn and is never asked about.
  let ownMerge = 0;
  function mergeOwn(snapshot) {
    ownMerge++;
    try { mergeSnapshot(snapshot); } finally { ownMerge--; }
  }
  const mergeBeforeRig = mergeSnapshot;
  mergeSnapshot = function(snapshot) {
    const known = ownMerge ? null : new Set(cameras);
    mergeBeforeRig(snapshot);
    if (known) for (const camera of cameras) if (!known.has(camera) && camera.elementKey && camera.device === snapshot.device?.id) camera.foreign = true;
  };
  const copyLabel = camera => (String(camera.number ?? '') + ' ' + String(camera.name ?? '')).trim() || 'Camera';
  const listed = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  // A camera and the copies of it that also weren't configured here are one thing to decide.
  function foreignItems() {
    const rows = cameras.filter(camera => camera.foreign && camera.elementKey && !camera.deleting), grouped = new Set(), items = [];
    for (const camera of rows.filter(row => !importedCamera(row))) {
      const copies = rows.filter(row => importedCamera(row) && sourceRowOf(row) === camera), on = Object.keys(actualRoute(camera).links).map(controllerName);
      for (const row of [camera, ...copies]) grouped.add(row);
      items.push({ id: camera.id, kind: 'camera', camera, rows: [camera, ...copies], title: copyLabel(camera) + ' · set up on ' + controllerName(camera.device),
        detail: on.length ? 'Also on ' + listed(on) + ' as ' + (on.length === 1 ? 'a REMI copy.' : 'REMI copies.') : 'Not REMI’d to another controller.' });
    }
    for (const copy of rows.filter(row => importedCamera(row) && !grouped.has(row))) {
      const source = sourceRowOf(copy);
      items.push({ id: copy.id, kind: 'copy', camera: copy, source, rows: [copy], title: copyLabel(copy) + ' on ' + controllerName(copy.device) + ' · REMI copy',
        detail: source ? 'A copy of ' + copyLabel(source) + ' from ' + controllerName(source.device) + '.' : 'Hubble can’t tell which camera it was made from.' });
    }
    return items;
  }
  function paintForeignReview() {
    const tools = root.querySelector('[data-role="setup-group"] .hc-controller-tools');
    if (!tools) return;
    let button = tools.querySelector('[data-action="review-foreign"]'), note = tools.querySelector('[data-role="foreign-note"]');
    if (!button) {
      (tools.querySelector('.hc-count-hint') ?? tools.querySelector('[data-camera-count]')).insertAdjacentHTML('afterend', '<button type="button" class="hc-primary hc-foreign-review" data-action="review-foreign" hidden></button><span class="hc-caption hc-foreign-note" data-role="foreign-note" hidden></span>');
      button = tools.querySelector('[data-action="review-foreign"]');
      note = tools.querySelector('[data-role="foreign-note"]');
    }
    const count = foreignItems().length;
    button.hidden = note.hidden = !count;
    button.disabled = sendsRunning > 0;
    button.textContent = 'Review ' + count + (count === 1 ? ' item' : ' items');
    note.textContent = count + (count === 1 ? ' thing on this rig wasn’t' : ' things on this rig weren’t') + ' configured by Hubble';
  }
  const renderBeforeRig = renderCameras;
  renderCameras = function() { renderBeforeRig(); paintForeignReview(); };
  // The button waits for a send that is running, so it is painted again when one ends.
  const paintPendingBeforeRig = paintPendingSends;
  paintPendingSends = function() { paintPendingBeforeRig(); paintForeignReview(); };
  function reviewForeign() {
    const items = foreignItems();
    if (!items.length) return;
    const rows = items.map(item => '<div class="hc-change-item hc-review-item"><div class="hc-review-text"><div><strong>' + esc(item.title) + '</strong></div><small>' + esc(item.detail) + '</small></div>' +
      '<div class="hc-segment" role="group" aria-label="' + esc(item.title) + '" data-review-item="' + esc(item.id) + '"><button type="button" data-review-choice="keep" aria-pressed="true">Keep as is</button><button type="button" data-review-choice="clear" aria-pressed="false">Clear</button></div></div>');
    $('modal-layer').innerHTML = '<section class="hc-modal hc-review-modal" role="dialog" aria-modal="true" aria-label="Not configured by Hubble"><div class="hc-modal-head"><div><h3>' + (items.length === 1 ? 'This wasn’t' : 'These weren’t') + ' configured by Hubble</h3><p>' + (items.length === 1 ? 'It is' : 'They are') + ' already on your controllers, so ' + (items.length === 1 ? 'it shows' : 'they show') + ' up here. Nothing has been changed.</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body">' + rows.join('') +
      '<div class="hc-change-item"><small><strong>Keep as is</strong> leaves it exactly as it is and stops asking about it.<br><strong>Clear</strong> deletes it from its controller, along with any REMI copies of it. That can’t be undone from Hubble.</small></div></div>' +
      '<div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Not now</button><button class="hc-primary" data-review-apply>Apply</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  function applyForeignReview(choices) {
    const items = foreignItems().filter(item => choices.has(item.id));
    const kept = items.filter(item => choices.get(item.id) !== 'clear'), clearing = items.filter(item => choices.get(item.id) === 'clear');
    for (const item of kept) for (const row of item.rows) delete row.foreign;
    const said = (cleared, problems) => {
      const parts = [];
      if (kept.length) parts.push('Kept ' + kept.length + (kept.length === 1 ? ' as it is' : ' as they are'));
      if (cleared) parts.push('Cleared ' + cleared);
      toast(problems.length ? problems[0] : parts.join(' · '));
    };
    if (!clearing.length) { renderCameras(); remember(); said(0, []); return; }
    if (!moduleBridge || moduleBridge.preview) { renderCameras(); remember(); toast(sampleRouteMessage); return; }
    return enqueueSend(async () => {
      let cleared = 0;
      const problems = [];
      // A camera goes with its copies, which come off first.
      const own = clearing.filter(item => item.kind === 'camera').map(item => item.camera).filter(camera => cameras.includes(camera));
      if (own.length) {
        try { await removeCameras(own); } catch (error) { problems.push(error.message || 'A camera could not be cleared'); }
        for (const camera of own) {
          if (!cameras.includes(camera)) cleared++;
          else problems.push(routeErrors.get(camera.id) || copyLabel(camera) + ' could not be cleared from ' + controllerName(camera.device) + '.');
        }
      }
      for (const item of clearing.filter(item => item.kind === 'copy')) {
        const copy = item.camera, where = controllerName(copy.device), label = copyLabel(copy);
        if (!cameras.includes(copy)) continue;
        try {
          if (item.source && cameras.includes(item.source)) {
            // The copy comes off, with anything that was made from it.
            const actual = actualRoute(item.source), tree = { ...actual.links }, gone = new Set([copy.device]);
            for (let grew = true; grew;) { grew = false; for (const [receiver, parent] of Object.entries(tree)) if (!gone.has(receiver) && gone.has(parent)) { gone.add(receiver); grew = true; } }
            for (const receiver of gone) delete tree[receiver];
            const result = (await requestRoutes([{ id: item.source.id, camera: item.source.device, key: item.source.elementKey, tree, expected: actual.links, copies: actual.keys }])).results?.[0];
            if (!result?.verified) throw new Error(label + ' could not be cleared from ' + where + ': ' + (result?.error || 'no answer'));
          } else {
            let removed;
            if (copy.remi) removed = await moduleBridge.remiSend({ receiver: copy.device, items: [{ id: 'remove:' + copy.elementKey, kind: 'remove', key: copy.elementKey, enable: false, selector: copy.remi.selector, connection: copy.remi.connection, label: copy.name }] });
            else removed = await moduleBridge.send({ items: [{ kind: 'camera', deleting: true, orphan: true, item: plainRow(copy), fields: [] }] });
            const result = removed.results?.[0];
            if (!result || result.error) throw new Error(label + ' could not be cleared from ' + where + ': ' + (result?.error || 'no answer'));
            cameras = cameras.filter(camera => camera !== copy);
            if (removed.snapshot) mergeOwn(removed.snapshot);
          }
          cleared++;
        } catch (error) { problems.push(error.message || label + ' could not be cleared'); }
      }
      routeTreeMemo = null;
      renderCameras();
      remember();
      said(cleared, problems);
    }).finally(paintForeignReview);
  }
  root.addEventListener('click', event => {
    const target = event.target.closest?.('[data-action="review-foreign"], [data-review-choice], [data-review-apply]');
    if (!target) return;
    if (target.dataset.action === 'review-foreign') { reviewForeign(); return; }
    if (target.dataset.reviewChoice) {
      for (const button of target.parentElement.querySelectorAll('[data-review-choice]')) button.setAttribute('aria-pressed', String(button === target));
      return;
    }
    const choices = new Map([...$('modal-layer').querySelectorAll('[data-review-item]')].map(group => [group.dataset.reviewItem, group.querySelector('[aria-pressed="true"]')?.dataset.reviewChoice || 'keep']));
    $('modal-layer').hidden = true;
    void applyForeignReview(choices);
  });

  // The Devices tab as one sheet: a row per controller with its addresses as columns. LAN and WAN
  // settings fold away behind their own groups. A device is added by typing its IP in the last row,
  // and found devices list under the managed ones, each with its own Add. The cards this replaces
  // stay as the Details view, and every edit here goes through the same rows and sends they use.
  // The remove button sits beside the name, where it is on the camera sheets.
  const deviceSheet = { lanOpen: false, wanOpen: false, sort: null, details: false };
  let selectedDeviceId = '', deviceAddNote = '', deviceAddBusy = false;
  const deviceGroups = {
    lan: { label: 'LAN IP settings', open: [['lan1', 'LAN IP', 158], ['lan2', 'LAN IP 2', 158]], closed: [['lan1', 'LAN IP', 190]] },
    wan: { label: 'WAN settings', open: [['wanMode', 'Mode', 96], ['wanIp', 'WAN IP', 158], ['gateway', 'Gateway', 130], ['dns1', 'DNS 1', 122], ['dns2', 'DNS 2', 122]], closed: [['wan', 'WAN', 150]] },
  };
  const deviceSortable = new Set(['name', 'type', 'serial', 'status', 'base', 'lan1', 'lan2', 'wan', 'wanIp', 'connected', 'cameras']);

  function deviceNetwork(d) {
    const rows = lans.filter(row => row.device === d.id);
    return { lan: rows.filter(row => row.type !== 'WAN' && !row.readOnly), wan: rows.find(row => row.type === 'WAN' && !row.readOnly) };
  }
  const plainAddress = value => String(value ?? '').split('/')[0];
  function deviceConnectedOn(d) {
    const address = d.address || d.base;
    if (d.online === false || d.online == null) return '—';
    if (address === d.base) return 'Base';
    const index = deviceNetwork(d).lan.findIndex(row => plainAddress(row.current) === address);
    return index < 0 ? address : index ? 'LAN IP ' + (index + 1) : 'LAN IP';
  }
  function deviceSyncText(d) {
    const rows = lans.filter(row => row.device === d.id);
    if (rows.some(row => row.jobs > 0)) return 'Sending';
    const failed = rows.find(row => row.pending && !['Pending', 'In sync', 'Verified', 'Sending', 'Verifying'].includes(row.result));
    if (failed) return failed.result;
    return rows.some(row => row.pending) ? 'Pending' : d.online ? 'In sync' : '—';
  }
  const deviceCameraCount = d => cameras.filter(camera => camera.device === d.id).length;
  function deviceSortValue(d, field) {
    const net = deviceNetwork(d);
    return String({
      name: d.name, type: d.kind, serial: d.serial, status: d.online ? '1 Online' : d.online === false ? '2 Offline' : '3', base: d.base,
      lan1: plainAddress(net.lan[0]?.planned), lan2: plainAddress(net.lan[1]?.planned), wan: net.wan ? (net.wan.dhcp ? 'DHCP' : plainAddress(net.wan.planned)) : '',
      wanIp: net.wan && !net.wan.dhcp ? plainAddress(net.wan.planned) : '', connected: deviceConnectedOn(d), cameras: String(deviceCameraCount(d)),
    }[field] ?? '');
  }
  // Sorting reorders the devices themselves, so every other list of them follows.
  function sortDevices(field) {
    const previous = deviceSheet.sort, direction = previous?.field === field && previous.direction === 'asc' ? 'desc' : 'asc', sign = direction === 'desc' ? -1 : 1;
    deviceSheet.sort = { field, direction };
    setOrder(orderedDevices().map((d, index) => ({ d, index, value: deviceSortValue(d, field) })).sort((a, b) => {
      if (!a.value || !b.value) return a.value ? -1 : b.value ? 1 : a.index - b.index;
      return sign * a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }) || a.index - b.index;
    }).map(entry => entry.d.id));
  }

  function deviceSheetColumns() {
    const group = name => (deviceGroups[name][deviceSheet[name + 'Open'] ? 'open' : 'closed']).map(([id, label, width]) => ({ id, label, width, group: name }));
    const plain = list => list.map(([id, label, width]) => ({ id, label, width }));
    return [...plain([['row', '#', 36], ['name', 'Name', 170], ['remove', '', 40], ['type', 'Type', 82], ['serial', 'Serial', 172], ['status', 'Status', 104], ['base', 'Base IP', 130]]),
      ...group('lan'), ...group('wan'), ...plain([['connected', 'Connected on', 116], ['cameras', 'Cameras', 128], ['sync', 'Sync', 96]])];
  }
  function deviceSheetHeader(columns) {
    const sortHead = column => {
      if (!deviceSortable.has(column.id)) return esc(column.label);
      const active = deviceSheet.sort?.field === column.id;
      return '<button type="button" class="hc-sort-heading" data-device-sort="' + column.id + '" aria-label="Sort by ' + esc(column.label) + '">' + esc(column.label) + (active ? '<span aria-hidden="true">' + (deviceSheet.sort.direction === 'asc' ? '↑' : '↓') + '</span>' : '') + '</button>';
    };
    const top = [], fields = [];
    for (const [index, column] of columns.entries()) {
      if (!column.group) { top.push('<th scope="col" rowspan="2">' + sortHead(column) + '</th>'); continue; }
      if (columns[index - 1]?.group !== column.group) {
        const open = deviceSheet[column.group + 'Open'], label = deviceGroups[column.group].label;
        top.push('<th scope="colgroup" class="hc-device-group-head" colspan="' + columns.filter(item => item.group === column.group).length + '"><button type="button" class="hc-device-group" data-action="toggle-device-group" data-group="' + column.group + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Collapse ' : 'Expand ') + label + '"><span class="hc-device-group-box" aria-hidden="true">' + (open ? '−' : '+') + '</span>' + label + '</button></th>');
      }
      fields.push('<th scope="col">' + sortHead(column) + '</th>');
    }
    return '<colgroup>' + columns.map(column => '<col style="width:' + column.width + 'px">').join('') + '</colgroup><thead><tr>' + top.join('') + '</tr><tr>' + fields.join('') + '</tr></thead>';
  }
  function deviceCell(d, column, index) {
    const net = deviceNetwork(d), id = esc(d.id), busy = deviceBusy(d.id);
    const input = (field, value, label, disabled = false) => '<input class="hc-cell-input hc-mono" data-device-cell="' + id + ':' + field + '" value="' + esc(value ?? '') + '" aria-label="' + esc(label + ' for ' + d.name) + '"' + (disabled ? ' disabled' : '') + ' spellcheck="false" autocomplete="off">';
    const cell = (content, changed = false, extra = '') => '<td data-device-column="' + column.id + '"' + (changed ? ' class="hc-changed"' : '') + extra + '>' + content + '</td>';
    const waiting = rows => { const count = rows.filter(row => row?.pending).length; return count ? '<span class="hc-device-waiting">+' + count + ' pending</span>' : ''; };
    const quiet = text => '<span class="hc-muted">' + esc(text) + '</span>';
    switch (column.id) {
      case 'row': return cell(quiet(String(index + 1)));
      case 'name': return cell('<input class="hc-cell-input hc-device-name" data-device-cell="' + id + ':name" data-device-setting="name" data-device-id="' + id + '" value="' + esc(d.name) + '" aria-label="Device name for ' + esc(d.serial) + '" maxlength="160">');
      case 'type': return cell(quiet(d.kind));
      case 'serial': return cell('<span class="hc-mono hc-muted">' + esc(d.serial) + '</span>');
      case 'status': return cell(status(d.online), false, ' data-device-status="' + id + '"');
      case 'base': return cell('<span class="hc-mono hc-muted">' + esc(d.base || '') + '</span>');
      case 'lan1': return cell(input('lan1', net.lan[0]?.planned, 'LAN IP', busy) + (deviceSheet.lanOpen ? '' : waiting(net.lan.slice(1))), !!net.lan[0]?.pending);
      case 'lan2': return cell(input('lan2', net.lan[1]?.planned, 'LAN IP 2', busy) + waiting(net.lan.slice(2)), !!net.lan[1]?.pending);
      case 'wan': return cell(net.wan ? (net.wan.dhcp || net.wan.current ? esc(net.wan.dhcp ? 'DHCP' : net.wan.current) : quiet('Not set')) + waiting([net.wan]) : quiet('—'), !!net.wan?.pending);
      // The controllers haven't shown how a WAN address or DHCP is written, so these two are read, not set.
      case 'wanMode': return cell(net.wan ? quiet(net.wan.dhcp ? 'DHCP' : net.wan.current ? 'Static' : 'Not set') : quiet('—'), false, ' title="WAN mode can’t be set from Hubble yet. Gateway and DNS can."');
      case 'wanIp': return cell(net.wan ? '<span class="hc-mono hc-muted">' + esc(net.wan.dhcp ? '' : net.wan.current) + '</span>' : '', false, ' title="A WAN address can’t be set from Hubble yet. Gateway and DNS can."');
      case 'gateway': case 'dns1': case 'dns2': return cell(net.wan ? input(column.id, net.wan[column.id], column.label, busy || net.wan.dhcp) : '', !!net.wan?.dirty.has(column.id));
      case 'connected': return cell(quiet(deviceConnectedOn(d)), false, ' data-device-connected="' + id + '"');
      case 'cameras': return cell(deviceCamerasMarkup(d), false, ' data-device-cameras="' + id + '"');
      case 'sync': return cell(resultMark(deviceSyncText(d)), false, ' data-device-sync="' + id + '"');
      default: return cell('<button type="button" class="hc-row-remove-button" data-action="remove-device" data-id="' + id + '" aria-label="Remove ' + esc(d.name) + ' from this list" title="Remove ' + esc(d.name) + ' from this list. Nothing is deleted on the device."' + (busy ? ' disabled' : '') + '>' + icon('trash-2') + '</button>');
    }
  }
  // Clearing a controller's cameras starts from its own row, after a confirmation.
  function deviceCamerasMarkup(d) {
    const count = deviceCameraCount(d);
    if (!count) return '<span class="hc-device-camera-count">0</span>';
    return '<span class="hc-device-camera-count">' + count + '</span><button type="button" class="hc-clear-cameras" data-action="clear-device-cameras" data-id="' + esc(d.id) + '" aria-label="Clear all cameras on ' + esc(d.name) + '" title="Deletes every camera configuration on ' + esc(d.name) + ', after you confirm"' + (deviceBusy(d.id) || sendsRunning > 0 ? ' disabled' : '') + '>' + icon('eraser') + 'Clear all</button>';
  }
  const foundDevices = () => results.filter(candidate => !devices.some(d => d.serial === candidate.serial));
  function deviceSheetFocus() {
    const element = document.activeElement;
    if (!element?.closest?.('[data-role="device-sheet"]')) return null;
    const key = element.dataset.deviceCell ?? (element.hasAttribute('data-device-add') ? 'add' : '');
    return key ? { key, value: element.value, start: element.selectionStart, end: element.selectionEnd } : null;
  }
  function renderDeviceSheet() {
    const host = $('device-sheet');
    if (!host) return;
    const focus = deviceSheetFocus(), left = host.querySelector('.hc-scroll')?.scrollLeft || 0, columns = deviceSheetColumns(), list = orderedDevices(), found = foundDevices();
    if (selectedDeviceId && !device(selectedDeviceId)) selectedDeviceId = '';
    const rows = list.map((d, index) => '<tr data-device-row="' + esc(d.id) + '"' + (d.id === selectedDeviceId ? ' class="hc-device-selected"' : '') + '>' + columns.map(column => deviceCell(d, column, index)).join('') + '</tr>').join('');
    const span = columns.length - 7;
    const foundRows = found.map(candidate => '<tr class="hc-device-found" data-device-found="' + esc(candidate.id) + '"><td><span class="hc-muted">+</span></td><td>' + esc(candidate.name || candidate.serial) + '</td><td></td><td><span class="hc-muted">' + esc(candidate.kind || '') + '</span></td><td><span class="hc-mono hc-muted">' + esc(candidate.serial) + '</span></td><td><span class="hc-found-tag">Found</span></td><td><span class="hc-mono hc-muted">' + esc(candidate.base || candidate.address || '') + '</span></td><td colspan="' + span + '"><button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(candidate.id) + '" aria-label="Add ' + esc(candidate.name || candidate.serial) + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button></td></tr>').join('');
    const addRow = '<tr class="hc-device-add"><td><span class="hc-muted">+</span></td><td colspan="5"><span class="hc-muted">New device</span></td><td><input class="hc-cell-input hc-mono" data-device-add placeholder="Type an IP" aria-label="IP address of a device to add" spellcheck="false" autocomplete="off"' + (deviceAddBusy ? ' disabled' : '') + '></td><td colspan="' + span + '"><span class="hc-muted" data-role="device-add-note">' + esc(deviceAddNote || 'Type or paste an IP and press Enter. Hubble finds the device and fills in the row.') + '</span></td></tr>';
    host.innerHTML = '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" data-device-sheet aria-label="Devices" style="width:' + columns.reduce((total, column) => total + column.width, 0) + 'px">' + deviceSheetHeader(columns) + '<tbody>' + rows + foundRows + addRow + '</tbody></table></div></div>';
    const scroll = host.querySelector('.hc-scroll');
    if (scroll) scroll.scrollLeft = left;
    icons();
    if (focus) {
      const element = focus.key === 'add' ? host.querySelector('[data-device-add]') : host.querySelector('[data-device-cell="' + CSS.escape(focus.key) + '"]');
      if (element && !element.disabled) {
        if (element.tagName === 'INPUT') element.value = focus.value;
        element.focus({ preventScroll: true });
        try { element.setSelectionRange?.(focus.start, focus.end); } catch { /* A select has no caret. */ }
      }
    }
    paintDeviceView();
    paintDeviceSheet();
  }
  // Status and counts change without anyone editing, so they are painted in place and typing isn't interrupted.
  function paintDeviceSheet() {
    const host = $('device-sheet');
    if (!host) return;
    // Compared with what was last painted, not with the cell, because icons are drawn in after the
    // markup lands. Redrawing a cell under a click would swallow the click.
    const set = (attribute, id, markup) => { const cell = host.querySelector('[' + attribute + '="' + CSS.escape(id) + '"]'); if (cell && (cell.dataset.painted ?? cell.innerHTML) !== markup) { cell.innerHTML = markup; cell.dataset.painted = markup; } };
    for (const d of devices) {
      set('data-device-status', d.id, status(d.online));
      set('data-device-connected', d.id, '<span class="hc-muted">' + esc(deviceConnectedOn(d)) + '</span>');
      set('data-device-cameras', d.id, deviceCamerasMarkup(d));
      set('data-device-sync', d.id, resultMark(deviceSyncText(d)));
    }
    for (const row of host.querySelectorAll('tr[data-device-row]')) row.classList.toggle('hc-device-selected', row.dataset.deviceRow === selectedDeviceId);
    icons();
    const found = foundDevices().length;
    $('found-summary').textContent = found ? found + ' found' : '';
    const addAll = action('add-all-found');
    addAll.hidden = !found;
    addAll.disabled = deviceAddBusy;
    addAll.querySelector('[data-add-all-label]').textContent = 'Add all ' + found;
    $('device-summary').textContent = devices.length + (devices.length === 1 ? ' device' : ' devices') + ' · ' + devices.filter(d => d.online).length + ' online';
    if (!deviceSheet.details) $('lan-foot').textContent = 'Click a heading to sort. Address changes wait in Pending sends until you press Send.';
  }
  function paintDeviceView() {
    for (const button of root.querySelectorAll('[data-device-view]')) button.setAttribute('aria-pressed', String((button.dataset.deviceView === 'details') === deviceSheet.details));
    $('device-sheet-group').hidden = deviceSheet.details;
    $('network-devices').hidden = !deviceSheet.details;
    action('toggle-all-network').hidden = !deviceSheet.details;
    action('add-ip').hidden = !deviceSheet.details;
    // On the sheet, finding devices is one line in its toolbar, and what it finds lists as rows. The
    // Details view keeps its card, so the controls move back into it there.
    discoveryCard.hidden = !deviceSheet.details;
    placeScanControls(deviceSheet.details);
  }
  const scanControlHomes = [];
  function placeScanControls(inCard) {
    const bar = $('scan-bar'), parts = [root.querySelector('.hc-scan-controls'), $('discovery-error'), root.querySelector('.hc-scan-status')].filter(Boolean);
    if (!bar || !parts.length) return;
    if (!scanControlHomes.length) for (const part of parts) { const home = document.createComment('scan control'); part.before(home); scanControlHomes.push([part, home]); }
    for (const [part, home] of scanControlHomes) {
      if (inCard) { if (part.parentElement === bar) home.after(part); }
      else if (part.parentElement !== bar) bar.append(part);
    }
  }
  // Every found device that isn't in the list yet is added in one go.
  async function addAllFound() {
    const found = foundDevices();
    if (!found.length || deviceAddBusy) return;
    selectedResults.clear();
    for (const candidate of found) selectedResults.add(candidate.id);
    deviceAddBusy = true;
    renderDeviceSheet();
    try {
      if (moduleBridge && !moduleBridge.preview) await addLiveResults();
      else addResults();
    } catch (error) { toast(error.message); }
    finally { deviceAddBusy = false; renderResults(); renderLans(); }
  }

  const maskOf = (value, fallback) => String(value ?? '').split('/')[1] || fallback;
  const cidr = value => { const parts = String(value).split('/'); return parts.length === 2 && ipv4(parts[0]) && /^\d{1,2}$/.test(parts[1]) && Number(parts[1]) <= 32; };
  function commitDeviceCell(id, field, raw) {
    const d = device(id);
    if (!d || deviceBusy(id)) return;
    const net = deviceNetwork(d), value = String(raw).trim(), mask = maskOf(net.lan[0]?.current, '16');
    const refuse = message => { toast(message); renderLans(); };
    if (field === 'lan1' || field === 'lan2') {
      // The second column only means something once there is a first address.
      const row = field === 'lan1' || !net.lan.length ? net.lan[0] : net.lan[1];
      if (!value) {
        if (row?.pending) cancelLanDrafts(id, row.id);
        else if (row) refuse('An address can be changed here, but not removed.');
        else renderLans();
        return;
      }
      const planned = value.includes('/') ? value : value + '/' + maskOf(row?.current, mask);
      if (!cidr(planned)) { refuse('Enter an address such as 10.20.101.212/16'); return; }
      if (lans.some(other => other !== row && plainAddress(other.planned) === plainAddress(planned) && other.device !== id)) toast(plainAddress(planned) + ' is already set on ' + (device(lans.find(other => other !== row && plainAddress(other.planned) === plainAddress(planned)).device)?.name ?? 'another device'));
      if (!row) {
        if (lans.length >= 1024) { refuse('Network row capacity reached'); return; }
        lans.push({ id: 'new-lan-' + crypto.randomUUID(), device: id, type: 'LAN', iface: lans.find(item => item.device === id && item.readOnly)?.iface || d.interfaces?.[0] || 'LAN1', current: '', planned, operation: 'Add', pending: true, result: 'Pending', dhcp: false, gateway: '', dns1: '', dns2: '', dirty: new Set(['planned']), revision: 0, jobs: 0 });
      } else if (planned === row.current && row.elementKey) { if (row.pending) { cancelLanDrafts(id, row.id); return; } }
      else if (planned !== row.planned) stageCell(row, 'planned', planned, true);
    } else {
      const wan = net.wan;
      if (!wan) return;
      if (!['gateway', 'dns1', 'dns2'].includes(field)) return;
      if (value && !ipv4(value)) { refuse('Enter a valid IP address'); return; }
      if (value !== String(wan[field] ?? '')) stageCell(wan, field, value, true);
    }
    renderLans();
    remember();
  }

  // Adding by IP reads the device at that address and adds it, the same way Find by IP then Add does.
  async function addDevicesByIp(text) {
    const addresses = [...new Set(String(text).split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];
    if (!addresses.length || deviceAddBusy) return;
    const notes = [];
    deviceAddBusy = true;
    try {
      for (const address of addresses) {
        if (!ipv4(address)) { notes.push(address + ' is not a valid IP address.'); continue; }
        const known = devices.find(d => [d.base, d.address, d.alias].includes(address) || lans.some(row => row.device === d.id && plainAddress(row.current) === address));
        if (known) { notes.push(address + ' is already in the list as ' + known.name + '.'); continue; }
        deviceAddNote = 'Looking for a device at ' + address + '…';
        renderDeviceSheet();
        try {
          if (moduleBridge && !moduleBridge.preview) {
            const candidate = (await moduleBridge.probe(address)).device, existing = devices.find(d => d.serial === candidate.serial);
            if (existing) { notes.push(address + ' is ' + existing.name + ', which is already in the list.'); continue; }
            manualDiscoveries.set(candidate.serial, candidate);
            mergeDiscoveries();
            await addFoundDevice(candidate.id);
          } else {
            const before = devices.length;
            $('manual-ip').value = address;
            probeIP();
            await addFoundDevice(results.find(candidate => [candidate.base, candidate.alias].includes(address))?.id);
            if (devices.length === before) notes.push('No device was found at ' + address + '.');
          }
        } catch (error) { notes.push(address + ': ' + (error.message || 'no Cyanview device answered')); }
      }
    } finally {
      deviceAddBusy = false;
      deviceAddNote = notes.join(' ');
      renderLans();
    }
  }
  async function addFoundDevice(id) {
    if (!id) return;
    const kept = [...selectedResults].filter(other => other !== id);
    selectedResults.clear();
    selectedResults.add(id);
    try {
      if (moduleBridge && !moduleBridge.preview) await addLiveResults();
      else addResults();
    } finally { for (const other of kept) selectedResults.add(other); renderResults(); }
  }

  // Everything on one controller goes at once, after a confirmation, over one connection. A camera
  // that lives on another controller stays there and only its copy here is removed.
  function reviewDeviceClear(id) {
    const d = device(id);
    if (!d) return;
    const rows = cameras.filter(camera => camera.device === id), copies = rows.filter(importedCamera).length;
    const shared = rows.filter(camera => !importedCamera(camera) && Object.keys(actualRoute(camera).links).length).length;
    const lines = ['<div class="hc-change-item"><div><strong>Deletes all ' + rows.length + (rows.length === 1 ? ' camera configuration' : ' camera configurations') + ' from ' + esc(d.name) + '</strong></div><small>This goes to the controller as soon as you confirm. It can’t be undone from Hubble.</small></div>'];
    if (copies) lines.push('<div class="hc-change-item"><small>' + copies + (copies === 1 ? ' is a copy' : ' are copies') + ' of a camera set up on another controller. Those cameras stay where they are, and only the ' + (copies === 1 ? 'copy' : 'copies') + ' on ' + esc(d.name) + (copies === 1 ? ' is' : ' are') + ' removed.</small></div>');
    if (shared) lines.push('<div class="hc-change-item"><small>' + shared + (shared === 1 ? ' camera' : ' cameras') + ' set up here ' + (shared === 1 ? 'is' : 'are') + ' also on other RCPs, and ' + (shared === 1 ? 'comes' : 'come') + ' off those too.</small></div>');
    if (d.online === false) lines.push('<div class="hc-change-item"><small class="hc-error-text">' + esc(d.name) + ' reads Offline, so this will probably fail and change nothing.</small></div>');
    $('modal-layer').innerHTML = '<section class="hc-modal" role="dialog" aria-modal="true" aria-label="Clear all cameras on ' + esc(d.name) + '"><div class="hc-modal-head"><div><h3>Clear all cameras on ' + esc(d.name) + '?</h3><p>' + esc(d.serial + ' · ' + (d.address || d.base)) + '</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body">' + lines.join('') + '</div><div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button><button class="hc-danger hc-danger-solid" data-clear-device-confirm="' + esc(id) + '">Delete ' + rows.length + (rows.length === 1 ? ' camera' : ' cameras') + '</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  function clearDeviceCameras(id) {
    const d = device(id);
    if (!d) return;
    return enqueueSend(async () => {
      const rows = cameras.filter(camera => camera.device === id && !movesInFlight.has(camera)), own = rows.filter(camera => !importedCamera(camera));
      // A camera that never reached the controller has nothing to delete there.
      const unsent = own.filter(camera => !camera.elementKey && !camera.createState);
      cameras = cameras.filter(camera => !unsent.includes(camera));
      for (const camera of own) { delete camera.routeDraft; delete camera.removeStaged; }
      await removeCameras(own.filter(camera => camera.elementKey));
      if (moduleBridge && !moduleBridge.preview) {
        routeTreeMemo = null;
        const copies = cameras.filter(camera => camera.device === id && importedCamera(camera) && camera.elementKey), items = [], routed = new Map();
        for (const copy of copies) {
          const source = sourceRowOf(copy);
          if (!source) continue;
          // Whatever came through this controller now comes from where it got the camera.
          const links = { ...actualRoute(source).links }, parent = links[id];
          delete links[id];
          for (const receiver of Object.keys(links)) if (links[receiver] === id) links[receiver] = parent;
          items.push({ id: source.id, camera: source.device, key: source.elementKey, tree: links, expected: actualRoute(source).links, copies: actualRoute(source).keys });
          routed.set(copy, source.id);
        }
        const report = items.length ? await requestRoutes(items) : { results: [] };
        // A copy whose camera can't be reached or traced is taken off this controller by itself.
        const left = copies.filter(copy => cameras.includes(copy) && !report.results?.find(result => result.id === routed.get(copy))?.verified);
        const entries = left.filter(copy => copy.remi), loose = left.filter(copy => !copy.remi);
        if (entries.length) {
          try {
            const removed = await moduleBridge.remiSend({ receiver: id, items: entries.map(copy => ({ id: 'remove:' + copy.elementKey, kind: 'remove', key: copy.elementKey, enable: false, selector: copy.remi.selector, connection: copy.remi.connection, label: copy.name })) });
            if (removed.snapshot) mergeOwn(removed.snapshot);
          } catch { /* What is left is counted below. */ }
        }
        if (loose.length) {
          try { await moduleBridge.send({ items: loose.map(copy => ({ kind: 'camera', deleting: true, orphan: true, item: plainRow(copy), fields: [] })) }); }
          catch { /* What is left is counted below. */ }
        }
        try { for (const snapshot of (await moduleBridge.refresh([id])).snapshots || []) mergeOwn(snapshot); } catch { /* The count below says what is still there. */ }
      }
      routeTreeMemo = null;
      renderLans();
      renderCameras();
      remember();
      const remaining = cameras.filter(camera => camera.device === id).length;
      toast(remaining ? remaining + (remaining === 1 ? ' camera is' : ' cameras are') + ' still on ' + d.name + '. Check that it is reachable, then try again.' : 'All cameras cleared from ' + d.name);
      void loadRemiJobs();
    });
  }

  function createDeviceSheet() {
    const list = $('network-devices'), toolbar = action('review-lan').closest('.hc-toolbar');
    toolbar.querySelector('.hc-toolbar-title h3').textContent = 'Devices';
    toolbar.insertAdjacentHTML('beforeend', '<div class="hc-segment hc-device-view" role="group" aria-label="Devices view"><button type="button" data-device-view="sheet" aria-pressed="true">Sheet</button><button type="button" data-device-view="details" aria-pressed="false">Details</button></div>' +
      pendingSendsToggle());
    const body = document.createElement('div'), column = document.createElement('div');
    body.className = 'hc-assignment-body';
    body.dataset.pendingHost = 'devices';
    column.className = 'hc-device-column';
    column.innerHTML = '<div class="hc-controller-list"><section class="hc-controller" data-role="device-sheet-group"><div class="hc-controller-tools">' +
      '<div class="hc-scan-bar" data-role="scan-bar"></div><span class="hc-right"></span><span class="hc-found-count" data-role="found-summary" aria-live="polite"></span>' +
      '<button class="hc-primary" data-action="add-all-found" hidden>' + icon('plus') + '<span data-add-all-label>Add all</span></button></div><div data-role="device-sheet"></div></section></div>';
    list.before(body);
    body.append(column);
    column.append(list);
    discoveryCard.addEventListener('toggle', paintDeviceView);
    if ($('scan-label').textContent === 'No scan running') $('scan-label').textContent = '';
    paintDeviceView();
  }
  const initializeDeviceCards = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() { initializeDeviceCards(); createDeviceSheet(); };
  const renderNetworkCards = renderLans;
  renderLans = function() { const drawn = renderNetworkCards(); renderDeviceSheet(); return drawn; };
  const renderDiscoveryResults = renderResults;
  renderResults = function() { renderDiscoveryResults(); paintFoundList(); renderDeviceSheet(); };
  // The Details view's list of found devices has an Add on each one and Add all, not ticks.
  function paintFoundList() {
    for (const box of root.querySelectorAll('input[data-select-found]')) {
      box.closest('td').innerHTML = box.disabled ? '' : '<button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(box.dataset.selectFound) + '" aria-label="Add ' + esc(results.find(candidate => candidate.id === box.dataset.selectFound)?.serial ?? 'device') + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button>';
    }
    const found = foundDevices().length, button = action('add-discovered');
    button.innerHTML = 'Add all <span data-role="found-selected">' + found + '</span>';
    button.disabled = !found || deviceAddBusy;
    icons();
  }
  root.addEventListener('click', event => {
    if (!event.target.closest('[data-action="add-discovered"]')) return;
    event.stopImmediatePropagation();
    void addAllFound();
  }, true);
  const syncLiveConnections = syncConnections;
  syncConnections = function() { syncLiveConnections(); paintDeviceSheet(); };
  const syncBeforeDeviceSheet = syncSummary;
  syncSummary = function() { syncBeforeDeviceSheet(); paintDeviceSheet(); };

  root.addEventListener('click', event => {
    const row = event.target.closest('tr[data-device-row]');
    if (row && row.dataset.deviceRow !== selectedDeviceId) { selectedDeviceId = row.dataset.deviceRow; paintDeviceSheet(); }
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.deviceSort) sortDevices(data.deviceSort);
    else if (data.deviceView) { deviceSheet.details = data.deviceView === 'details'; paintDeviceView(); renderLans(); remember(); }
    else if (data.action === 'toggle-device-group') { deviceSheet[data.group + 'Open'] = !deviceSheet[data.group + 'Open']; renderDeviceSheet(); root.querySelector('[data-action="toggle-device-group"][data-group="' + data.group + '"]')?.focus({ preventScroll: true }); remember(); }
    else if (data.action === 'add-all-found') void addAllFound();
    else if (data.action === 'add-found-device') { deviceAddBusy = true; renderDeviceSheet(); void addFoundDevice(data.id).catch(error => toast(error.message)).finally(() => { deviceAddBusy = false; renderLans(); }); }
    else if (data.action === 'clear-device-cameras' && device(data.id)) reviewDeviceClear(data.id);
    else if (data.clearDeviceConfirm) { $('modal-layer').hidden = true; void clearDeviceCameras(data.clearDeviceConfirm); }
  });
  root.addEventListener('focusin', event => {
    const row = event.target.closest?.('tr[data-device-row]');
    if (row && row.dataset.deviceRow !== selectedDeviceId) { selectedDeviceId = row.dataset.deviceRow; paintDeviceSheet(); }
  });
  root.addEventListener('change', event => {
    const element = event.target;
    if (!element.dataset?.deviceCell || element.dataset.deviceSetting) return;
    const [id, field] = [element.dataset.deviceCell.slice(0, element.dataset.deviceCell.lastIndexOf(':')), element.dataset.deviceCell.slice(element.dataset.deviceCell.lastIndexOf(':') + 1)];
    commitDeviceCell(id, field, element.value);
  });
  root.addEventListener('keydown', event => {
    const element = event.target;
    if (event.key === 'Enter' && element.dataset?.deviceCell && element.tagName === 'INPUT') { event.preventDefault(); element.blur(); }
    else if (event.key === 'Escape' && element.dataset?.deviceCell && element.tagName === 'INPUT') { event.stopPropagation(); renderDeviceSheet(); }
    else if (event.key === 'Enter' && element.hasAttribute?.('data-device-add')) { event.preventDefault(); void addDevicesByIp(element.value); }
  });
  root.addEventListener('paste', event => {
    const element = event.target, text = event.clipboardData?.getData('text') ?? '';
    // Several addresses pasted at once add several devices.
    if (!element.hasAttribute?.('data-device-add') || !/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    void addDevicesByIp(text);
  });

  // Every list choice on the page opens Hubble's own pop-up list instead of the system menu. The real
  // select stays underneath, out of sight, and still holds the value: picking an option sets it and
  // sends the same input and change events, so the code that reads it and the saved plan don't change.
  const dropdownChevron = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const dropdownCheck = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const selectIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openDropdown = null, dropdownSequence = 0;

  function dropdownLabel(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.textContent : '';
  }
  function paintDropdown(select) {
    const button = select.nextElementSibling;
    if (!button?.matches('.hc-dropdown')) return;
    const text = dropdownLabel(select);
    const label = button.querySelector('.hc-dropdown-value');
    if (label.textContent !== text) label.textContent = text;
    button.disabled = select.disabled;
    button.hidden = select.hidden;
    button.classList.toggle('hc-dropdown-placeholder', !select.value);
  }
  function upgradeSelect(select) {
    if (select.dataset.hcDropdown || select.multiple) return;
    select.dataset.hcDropdown = String(++dropdownSequence);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hc-dropdown' + (select.classList.contains('hc-cell-input') ? ' hc-dropdown-cell' : '');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    // The button takes the select's name, so there is one control called that, the one people use.
    button.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.querySelector('span')?.textContent || 'Choose');
    select.dataset.label = button.getAttribute('aria-label');
    select.removeAttribute('aria-label');
    button.innerHTML = '<span class="hc-dropdown-value"></span>' + dropdownChevron;
    select.classList.add('hc-native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(button);
    // Code that sets the value directly, and options rebuilt in place, show on the button at once.
    Object.defineProperty(select, 'value', { configurable: true, get() { return selectValue.get.call(this); }, set(value) { selectValue.set.call(this, value); paintDropdown(this); } });
    Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return selectIndex.get.call(this); }, set(value) { selectIndex.set.call(this, value); paintDropdown(this); } });
    new MutationObserver(() => paintDropdown(select)).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected'] });
    select.addEventListener('change', () => paintDropdown(select));
    select.addEventListener('input', () => paintDropdown(select));
    // Focus that lands on the hidden select, from a label or the sheet's arrow keys, goes to the button.
    select.addEventListener('focus', () => { if (!button.disabled) button.focus(); });
    paintDropdown(select);
  }
  function upgradeSelects(scope) {
    if (scope.matches?.('select')) upgradeSelect(scope);
    for (const select of scope.querySelectorAll?.('select') ?? []) upgradeSelect(select);
  }

  function closeDropdown(focus = false) {
    if (!openDropdown) return;
    const { menu, button, abort } = openDropdown;
    openDropdown = null;
    abort.abort();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    if (focus && button.isConnected) button.focus();
  }
  function chooseDropdown(select, value) {
    closeDropdown(true);
    if (select.value === value) return;
    selectValue.set.call(select, value);
    paintDropdown(select);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function openDropdownFor(button) {
    const select = button.previousElementSibling;
    if (!select?.matches('select') || button.disabled) return;
    if (openDropdown?.button === button) { closeDropdown(true); return; }
    closeDropdown();
    const id = 'hc-dropdown-' + select.dataset.hcDropdown, menu = document.createElement('div');
    menu.className = 'hc-dropdown-menu';
    menu.id = id;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', button.getAttribute('aria-label'));
    const entries = [];
    let markup = '';
    for (const child of select.children) {
      const options = child.matches('optgroup') ? [...child.children] : [child];
      if (child.matches('optgroup')) markup += '<div class="hc-dropdown-group" role="presentation">' + esc(child.label) + '</div>';
      for (const option of options) {
        if (!option.matches('option')) continue;
        const index = entries.push(option) - 1, chosen = option.selected && option.value !== '';
        markup += '<div class="hc-dropdown-option' + (option.value === '' ? ' hc-dropdown-placeholder' : '') + '" role="option" id="' + id + '-' + index + '" data-index="' + index + '" aria-selected="' + chosen + '"' + (option.disabled || child.disabled ? ' aria-disabled="true"' : '') + '><span>' + esc(option.textContent) + '</span>' + (chosen ? dropdownCheck : '') + '</div>';
      }
    }
    menu.innerHTML = markup;
    root.append(menu);
    // Below the button when it fits, otherwise above it, and never past the window's edge.
    const box = button.getBoundingClientRect(), height = Math.min(menu.scrollHeight, 320);
    const below = window.innerHeight - box.bottom - 8, top = below >= height || below >= box.top ? box.bottom + 4 : box.top - 4 - height;
    Object.assign(menu.style, { top: Math.max(8, top) + 'px', left: Math.max(8, Math.min(box.left, window.innerWidth - Math.max(box.width, 200) - 8)) + 'px', minWidth: Math.max(box.width, 200) + 'px', maxHeight: height + 'px' });
    const abort = new AbortController();
    openDropdown = { menu, button, select, entries, abort, active: -1 };
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', id);
    const usable = index => entries[index] && !entries[index].disabled && !entries[index].parentElement.disabled;
    const highlight = index => {
      if (!usable(index)) return;
      openDropdown.active = index;
      for (const item of menu.querySelectorAll('.hc-dropdown-option')) item.classList.toggle('hc-dropdown-active', Number(item.dataset.index) === index);
      const item = menu.querySelector('[data-index="' + index + '"]');
      item?.scrollIntoView({ block: 'nearest' });
      button.setAttribute('aria-activedescendant', item?.id ?? '');
    };
    const move = (from, step) => { for (let index = from + step; index >= 0 && index < entries.length; index += step) if (usable(index)) return index; return from; };
    highlight(Math.max(0, entries.findIndex(option => option.selected)));
    menu.addEventListener('pointermove', event => { const item = event.target.closest('.hc-dropdown-option'); if (item) highlight(Number(item.dataset.index)); }, { signal: abort.signal });
    menu.addEventListener('pointerdown', event => event.preventDefault(), { signal: abort.signal });
    menu.addEventListener('click', event => {
      const item = event.target.closest('.hc-dropdown-option');
      if (item && usable(Number(item.dataset.index))) chooseDropdown(select, entries[Number(item.dataset.index)].value);
    }, { signal: abort.signal });
    let typed = '', typedAt = 0;
    button.addEventListener('keydown', event => {
      // Keys the open list uses go no further, so the sheet or the page don't act on them too.
      if (['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeDropdown(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(move(openDropdown.active, event.key === 'ArrowDown' ? 1 : -1)); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); highlight(event.key === 'Home' ? move(-1, 1) : move(entries.length, -1)); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (usable(openDropdown.active)) chooseDropdown(select, entries[openDropdown.active].value); }
      else if (event.key === 'Tab') closeDropdown();
      else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        // Typing jumps to the first option that starts with what was typed.
        typed = (Date.now() - typedAt > 700 ? '' : typed) + event.key.toLowerCase();
        typedAt = Date.now();
        const found = entries.findIndex((option, index) => usable(index) && option.textContent.trim().toLowerCase().startsWith(typed));
        if (found >= 0) highlight(found);
      }
    }, { signal: abort.signal });
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !button.contains(event.target)) closeDropdown(); }, { signal: abort.signal, capture: true });
    window.addEventListener('resize', () => closeDropdown(), { signal: abort.signal });
    document.addEventListener('scroll', event => { if (!menu.contains(event.target)) closeDropdown(); }, { signal: abort.signal, capture: true });
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('.hc-dropdown');
    if (button) openDropdownFor(button);
  });
  root.addEventListener('keydown', event => {
    const button = event.target.closest?.('.hc-dropdown');
    if (!button || openDropdown?.button === button) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openDropdownFor(button); }
  });
  upgradeSelects(root);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) upgradeSelects(node);
    // A list whose button was redrawn away closes with it.
    if (openDropdown && !openDropdown.button.isConnected) closeDropdown();
  }).observe(root, { childList: true, subtree: true });

  // How many cameras a sheet has is a number box. Raising it adds rows at the end, numbered on from
  // the highest camera, and lowering it takes rows off the end. A row that never reached a controller
  // goes at once; one that did is only marked for delete, and waits in Pending sends like any delete.
  // Copies made on another controller aren't counted, because they're removed from where they came from.
  const cameraCountLimit = 512;
  // Cameras the count box marked for delete, so raising it again brings those back. One deleted
  // with its own bin stays deleted.
  const countMarked = new Set();
  function countedCameras(sheetId) {
    return sheetCameras(sheetId).filter(camera => !importedCamera(camera) && !camera.removeStaged && !camera.deleting);
  }
  function cameraCountControl(sheetId) {
    const count = countedCameras(sheetId).length;
    const label = sheetId === cameraSetupSheet ? 'Number of cameras' : 'Number of cameras on ' + (device(sheetId)?.name ?? sheetId);
    return '<span class="hc-count" data-camera-count="' + esc(sheetId) + '"><span class="hc-count-label" aria-hidden="true">Cameras</span><span class="hc-stepper">' +
      '<button type="button" data-count-step="-1" aria-label="One camera fewer"' + (count ? '' : ' disabled') + '>' + icon('minus') + '</button>' +
      '<input class="hc-mono" data-count-input inputmode="numeric" value="' + count + '" aria-label="' + esc(label) + '" autocomplete="off" spellcheck="false">' +
      '<button type="button" data-count-step="1" aria-label="One camera more">' + icon('plus') + '</button></span></span>';
  }
  function paintCameraCounts() {
    for (const control of root.querySelectorAll('[data-camera-count]')) {
      const count = countedCameras(control.dataset.cameraCount).length, input = control.querySelector('[data-count-input]');
      if (document.activeElement !== input && input.value !== String(count)) input.value = String(count);
      control.querySelector('[data-count-step="-1"]').disabled = !count;
      control.querySelector('[data-count-step="1"]').disabled = cameras.length >= cameraCountLimit;
    }
  }
  function setCameraCount(sheetId, wanted) {
    const own = countedCameras(sheetId), target = Math.max(0, Math.round(wanted));
    if (!Number.isFinite(target) || target === own.length) { paintCameraCounts(); return; }
    if (target > own.length) {
      // Cameras the count box marked for delete come back first, from the top, before any new row is made.
      const marked = sheetCameras(sheetId).filter(camera => countMarked.has(camera) && camera.removeStaged && !camera.jobs && !camera.deleting).sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)).slice(0, target - own.length);
      for (const camera of marked) countMarked.delete(camera);
      if (marked.length) stageRemoval(marked, false);
      const missing = target - own.length - marked.length;
      if (missing > 0) addCameraRows(sheetId === cameraSetupSheet ? '' : sheetId, missing, countedCameras(sheetId));
      else paintCameraCounts();
    } else {
      // From the end, so the cameras at the top keep their place.
      const rows = [...own].filter(camera => !camera.jobs).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0)).slice(0, own.length - target);
      for (const camera of rows) countMarked.add(camera);
      stageRemoval(rows, true);
      paintCameraCounts();
    }
  }
  function addCameraRows(deviceId, count, own) {
    const room = cameraCountLimit - cameras.length;
    if (room <= 0) { toast('Camera capacity reached'); paintCameraCounts(); return; }
    if (count > room) toast('Only ' + room + ' more ' + (room === 1 ? 'camera fits' : 'cameras fit'));
    const last = [...own].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)).at(-1);
    // A new row takes the model of the last camera, so a rig of one kind fills in without choosing each time.
    const model = last?.model && last.model !== 'Choose model…' ? last.model : 'Choose model…', usb = model === 'Alpha-USB';
    let next = Math.max(0, ...(deviceId ? cameras.filter(camera => camera.device === deviceId) : cameras).map(camera => Number(camera.number)).filter(Number.isFinite)) + 1;
    const added = Array.from({ length: Math.min(count, room) }, () => {
      const number = String(next++);
      return { id: 'new-camera-' + crypto.randomUUID(), device: deviceId, number, name: 'Camera ' + number, model, ip: '', lens: 'None', lensPort: 'None', online: null, pending: true, result: usb ? 'Pending' : 'Incomplete', port: usb ? '' : '80', login: usb ? '' : 'admin', password: '', isNew: true, dirty: new Set(['number', 'name', 'model', 'ip', 'lens', 'lensPort']), revision: 0, jobs: 0 };
    });
    cameras.push(...added);
    if (deviceId) openControllers.add(deviceId);
    renderCameras();
    if (ui.sendMode === 'Auto send' && deviceId) {
      const ready = added.filter(camera => !valid(camera, 'camera'));
      if (ready.length) sendItems(ready, 'camera');
    }
    remember();
  }
  const renderCamerasBeforeCounts = renderCameras;
  renderCameras = function(...args) { const drawn = renderCamerasBeforeCounts(...args); paintCameraCounts(); return drawn; };

  root.addEventListener('click', event => {
    const step = event.target.closest('[data-count-step]');
    if (!step || step.disabled) return;
    const sheetId = step.closest('[data-camera-count]').dataset.cameraCount;
    setCameraCount(sheetId, countedCameras(sheetId).length + Number(step.dataset.countStep));
  });
  root.addEventListener('keydown', event => {
    const input = event.target;
    if (!input.matches?.('[data-count-input]')) return;
    const sheetId = input.closest('[data-camera-count]').dataset.cameraCount;
    if (event.key === 'Enter') { event.preventDefault(); setCameraCount(sheetId, Number(input.value)); input.select(); }
    else if (event.key === 'Escape') { event.preventDefault(); input.value = String(countedCameras(sheetId).length); input.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCameraCount(sheetId, countedCameras(sheetId).length + (event.key === 'ArrowUp' ? 1 : -1));
      input.value = String(countedCameras(sheetId).length);
    }
  });
  root.addEventListener('change', event => {
    const input = event.target;
    if (!input.matches?.('[data-count-input]')) return;
    const value = input.value.trim();
    if (/^\d+$/.test(value)) setCameraCount(input.closest('[data-camera-count]').dataset.cameraCount, Number(value));
    else paintCameraCounts();
  });
  root.addEventListener('focusout', event => {
    if (event.target.matches?.('[data-count-input]')) queueMicrotask(paintCameraCounts);
  });

  // ⌘+ and ⌘− make the text on every sheet bigger or smaller, and ⌘0 puts it back to 13. It's the text
  // size each sheet already keeps, now set for all of them at once. Zooming the whole page from inside
  // it would draw the sheets' column handles in the wrong place, so the toolbars keep their size.
  const sheetTextSizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
  function paintSheetTextSize() {
    root.style.setProperty('--hc-sheet-text-size', (cameraLayout(cameraSetupSheet).textSize ?? 13) + 'px');
  }
  function nextSheetTextSize(current, direction) {
    if (!direction) return 13;
    const index = sheetTextSizes.indexOf(current), from = index >= 0 ? index : Math.max(0, sheetTextSizes.findIndex(size => size >= current));
    return sheetTextSizes[Math.max(0, Math.min(sheetTextSizes.length - 1, from + direction))];
  }
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const direction = ['=', '+'].includes(event.key) ? 1 : ['-', '_'].includes(event.key) ? -1 : event.key === '0' ? 0 : null;
    if (direction === null) return;
    event.preventDefault();
    const next = nextSheetTextSize(cameraLayout(cameraSetupSheet).textSize ?? 13, direction);
    // Not an edit to undo, so it stays out of the sheets' undo history.
    for (const { id } of sheetOwners()) if ((cameraLayout(id).textSize ?? 13) !== next) changeCameraPresentation(id, () => { cameraLayout(id).textSize = next; }, false, false);
    paintSheetTextSize();
    toast('Text size ' + next + (next === 13 ? '' : ' · ⌘0 resets'));
  }, true);
  const restoreBeforeTextSize = restore;
  restore = function(...args) { const restored = restoreBeforeTextSize(...args); paintSheetTextSize(); return restored; };

  initializeDeviceWorkflow();syncFilter();renderLans();renderCameras();setTab('devices',false);restore(window.openai?.widgetState);
  if(moduleBridge)void initializeBackend();else root.hidden=false;
  window.addEventListener('openai:set_globals',event=>{const snapshot=event.detail?.globals?.widgetState;if(snapshot&&JSON.stringify(snapshot.privateContent)!==lastSavedPrivateContent)restore(snapshot);});
  if(globalThis.Tweak){const tweak=new globalThis.Tweak({container:root,onChange:updateDesign});tweak.addSelect(ui,'density',{label:'Row density',options:['Compact','Comfortable']});tweak.addToggle(ui,'serials',{label:'Use full device serials'});}
})();
