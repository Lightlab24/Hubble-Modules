import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
export async function buildUiAdapter() {
  let source = await readFile(path.join(root, 'src/approved-ui.js'), 'utf8');
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Approved UI adapter no longer matches: ' + before.slice(0, 70));
    source = source.replace(before, after);
  };
  const replaceBetween = (start, end, after) => {
    const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
    if(first<0||last<0||source.indexOf(start,first+start.length)>=0)throw new Error('UI workflow anchor no longer matches: '+start);
    source=source.slice(0,first)+after+source.slice(last);
  };
  replace("const status=online=>'<span class=\"hc-status '+(online?'hc-online':'hc-offline')+'\"><span class=\"hc-dot\"></span>'+(online?'Online':'Offline')+'</span>';", "// Null means nothing has answered yet, which isn't the same as Offline.\n  const connectionText=online=>online==null?'Not checked':online?'Online':'Offline';\n  const status=online=>'<span class=\"hc-status '+(online==null?'hc-unchecked':online?'hc-online':'hc-offline')+'\"'+(online==null?' title=\"Nothing has reported this yet.\"':'')+'><span class=\"hc-dot\"></span>'+connectionText(online)+'</span>';");
  replace("devices.filter(d=>!d.online).length+' offline';", "devices.filter(d=>d.online===false).length+' offline'+uncheckedCount(devices,' / ');");
  replace("cameras.filter(c=>!c.online).length+' cameras offline';", "cameras.filter(c=>c.online===false).length+' cameras offline'+uncheckedCount(cameras,' · ');");
  replace("lensPort:'None',online:false,pending:true,result:model==='Alpha-USB'", "lensPort:'None',online:null,pending:true,result:model==='Alpha-USB'");
  replace("toast('Status refreshed · edits retained');},500);", "toast('Settings refreshed · edits retained');},500);");
  replace("  const $=role=>", "  const moduleBridge=globalThis.cyanviewModuleBridge;\n  if(moduleBridge)root.hidden=true;\n  let persistence='saved',saveSequence=0;\n  const $=role=>");
  replace("const p=window.openai?.setWidgetState?.(snapshot);", "if(moduleBridge){return persistPlan(snapshot);}const p=window.openai?.setWidgetState?.(snapshot);");
  replace("$('saved-label').textContent='Workspace saved · '+ui.sendMode;", "$('saved-label').textContent=(moduleBridge?.preview||!moduleBridge?'Sample data · ':persistence==='saving'?'Saving… · ':persistence==='failed'?'Changes not saved · ':persistence==='draft'?'Unsaved edits · ':'Workspace saved · ')+ui.sendMode;action('add-lan').disabled=!devices.length;");
  replace("    button.setAttribute('aria-label'", "    button.disabled=!ordered.length;\n    button.setAttribute('aria-label'");
  replace("    const nums=cameras.filter(c=>c.device===id)", "    if(cameras.length>=512){toast('Camera capacity reached');return;}\n    const nums=(id?cameras.filter(c=>c.device===id):cameras)");
  replace("toast('Camera row added to '+device(id).name);remember();", "toast(id?'Camera row added to '+device(id).name:'Camera added · choose its Source');remember();");
  replace("const pendingCameras=id=>cameras.filter(c=>c.pending&&(!id||c.device===id));", "const pendingCameras=id=>cameras.filter(c=>c.pending&&c.device!==''&&(!id||c.device===id));");
  replace("==='all'?'rio1':", "==='all'?(orderedDevices()[0]?.id||''):");
  replace("selectedCameras=new Set(),selectedResults=new Set(),deviceQueues=new Map()", "selectedResults=new Set()");
  replaceBetween("  function sendItems(", "  function showReview(", await readFile(path.join(root, 'src/ui-send-workflows.js'), 'utf8'));
  replace("group.querySelector('[data-action=\"delete-controller\"]').disabled=!cameras.some(c=>c.device===d.id&&selectedCameras.has(c.id));", "syncCameraDeleteButton(group);");
  replace("    syncSummary();icons();\n  }\n  function inputCell", "    if(item.deleting&&row)row.querySelectorAll('[data-field],input[data-lens-axis]').forEach(el=>el.disabled=true);\n    paintCameraColumn(item);\n    paintIrisSwap(item);\n    syncSummary();icons();\n  }\n  function inputCell");
  replace("row.querySelectorAll('input[data-field],select[data-field]')", "row.querySelectorAll('[data-field]')");
  replace("+' for '+(device(row.device)?.name||'new row'))+'\"'+(disabled?' disabled':'')", "+' for '+(device(row.device)?.name||'new row'))+'\"'+(disabled||row.deleting?' disabled':'')");
  replace("if(!item)return;\n    if(!isLan&&isLensSetting", "if(!item||item.deleting)return;\n    if(!isLan&&isLensSetting");
  replace("    if(!device(item.device)?.online)return 'Offline · unsent';\n", "");
  replace("b.disabled=!pending||!d.online||", "b.disabled=!pending||");
  replace("<span>'+esc(d.online?'Connected at '+d.base:'Offline · edits stay pending')+'</span>", "<span data-connection-note>'+esc(connectionNote(d))+'</span>");
  replace("'Manual · edit, then Send changes.'", "'Manual · edit, then Send settings.'");
  replace("    syncOrganization();\n  }\n  function paintItem", "    syncOrganization();syncNetworkControls();\n  }\n  function paintItem");
  replace("openControllers:[...openControllers],", "openControllers:[...openControllers],openNetworkDevices:[...openNetworkDevices],hiddenNetworkColumnsByDevice:Object.fromEntries(Object.entries(hiddenNetworkColumnsByDevice).map(([id,fields])=>[id,[...fields]])),discoveryOpen:discoveryCard?.open,");
  replace("restoreColumnVisibility(data);", "restoreColumnVisibility(data);restoreDeviceWorkflow(data);");
  replace("restoreDeviceWorkflow(data);", "restoreDeviceWorkflow(data);restoreCameraSorting(data);restoreCameraLayouts(data);restoreRemiDrafts(data);restoreRemiView(data);");
  replace("discoveryOpen:discoveryCard?.open,", "discoveryOpen:discoveryCard?.open,remiDrafts:saveRemiDrafts(),remiView:saveRemiView(),");
  replace("remiSharing:'Deferred until a later capture'", "remiSharing:'Managed camera sources'");
  replace("openNetworkDevices:[...openNetworkDevices],", "openNetworkDevices:[...openNetworkDevices],cameraSortByDevice:JSON.parse(JSON.stringify(cameraSortByDevice)),cameraLayouts:saveCameraLayouts(),cameraSheetsByDevice:saveCameraSheets(),");
  replace("  function cameraGrid(rows,deviceId){", "  function cameraGrid(rows,deviceId){rows=sortCameraRows(rows,deviceId);");
  replace("    const groups=axisGroups(deviceId);\n", "");
  replaceBetween("{id:'selected',label:", "{id:'number',", "");
  replaceBetween("    for(const axis of ['iris','zoom','focus']){\n", "    function cell(camera,", `    for (const axis of ['iris', 'zoom', 'focus']) {
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
`);
  replaceBetween("      case 'toggle-axis':", "      case 'toggle-controller':", "");
  replaceBetween("      case 'delete-controller':", "      case 'review-lan':", "      case 'delete-controller':reviewCameraDeletion(activeCamera(b.closest('[data-controller]').querySelector('table[data-camera-device]')));break;\n");
  replace("sendItems(items,kind,b.dataset.delete==='true');", "if(kind==='camera'&&b.dataset.delete==='true')deleteReviewedCamera(items[0]);else sendItems(items,kind);");
  replace("    const title=deleting?'Delete cameras from device'", "    const remiRemoval=deleting&&importedCamera(items[0]);\n    const title=deleting?(remiRemoval?'Remove REMI camera':'Delete camera from device')");
  replace("deleting?'Delete selected cameras'", "deleting?(remiRemoval&&ui.sendMode==='Manual'?'Stage removal':remiRemoval?'Remove camera':'Delete camera')");
  replace("Delete selected</button>", "<span data-camera-delete-label>Delete camera</span></button>'+cameraControlTools(d)+'");
  replace("'</span>'+status(d.online)+'<span class=\"hc-controller-pending\" data-controller-pending></span>", "'</span>'+cameraControlCount(d)+status(d.online)+'<span class=\"hc-controller-pending\" data-controller-pending></span>");
  replaceBetween("if(el.dataset.selectCamera){", "if(el.dataset.selectFound){", "");
  replaceBetween("      if(field==='row'){classes.push('hc-num');", "      else if(field==='number'", "      if(field==='row')classes.push('hc-camera-row-gutter');\n");
  replace("{id:'number',label:'Camera number'}", "{id:'controlEnabled',label:'Camera Control Enabled'},{id:'number',label:'Camera number'}");
  replace("    columns.push({id:'control'", "    columns.push({id:'controlEnabled',label:'Camera Control Enabled',width:175});\n    columns.push({id:'control'");
  replace("columns.push({id:'control',label:'Control',width:72});", "columns.push({id:'control',label:'Control',width:104},{id:'recording',label:'Recording',width:96},{id:'cameraStatus',label:'Status',width:200});");
  replace("else if(field==='control')content=status(camera.online);", "else if(field==='control')content=status(camera.online);\n      else if(field==='recording')content=cameraRecordingCell(camera.id);\n      else if(field==='cameraStatus')content=cameraStatusCell(camera.id);");
  replace("      else if(field==='number'||field==='name')", "      else if(field==='controlEnabled'){classes.push('hc-check');content=cameraControlCell(camera);}\n      else if(isAssignmentField(field)){if(field.startsWith('remi:'))classes.push('hc-check');content=assignmentCell(camera,field,deviceId);}\n      else if(field==='number'||field==='name')");
  replace("    function cell(camera,column,index){", "    function cell(camera,column){\n      if(column.placeholder)return '<td class=\"hc-empty-axis\" aria-hidden=\"true\"></td>';\n      if(column.tool)return removeCell(camera,column);");
  replaceBetween("    return header+'<tbody>'+rows.map((camera,index)=>{", "\n  }\n  function renderCameras", `    if(cameraSheetView(deviceId)==='columns')return flippedCameraGrid(rows,columns,deviceId,cell);
    return header+'<tbody>'+rows.map(camera=>{
      initializeLensFields(camera);
      return '<tr data-id="'+esc(camera.id)+'"'+(removalStaged(camera)?' class="hc-remove-staged"':'')+'>'+columns.map(column=>cell(camera,column)).join('')+'</tr>';
    }).join('')+'</tbody>';`);
  replace('<table class="hc-grid" data-camera-device=', '<table class="hc-grid" role="grid" data-camera-device=');
  replace("changed=camera.dirty.has(field)", "changed=camera.dirty.has(cameraField(camera,field))||routeChanged(camera,field)");
  replace("attrs=' data-column=\"'+field+'\"'", "attrs=' data-column=\"'+field+'\"'+(field==='row'?' role=\"rowheader\" aria-label=\"Camera '+esc(camera.number)+'\"':' role=\"gridcell\"'+cameraCellPosition(deviceId,camera.id,field))");
  replace("id:'number',label:'#',width:28", "id:'number',label:'#',width:42");
  replace("id:'name',label:'Camera name',width:100", "id:'name',label:'Camera name',width:160");
  replace("id:'connection',label:'Lens connection',width:100", "id:'connection',label:'Lens connection',width:116");
  replace("id:'login',label:'Username',width:96", "id:'login',label:'Username',width:88");
  replace("id:'password',label:'Password',width:114", "id:'password',label:'Password',width:96");
  replace("    if(ui.sendMode==='Auto send')sendItems([item],isLan?'lan':'camera',false,item.isNew?[...item.dirty]:fields);", "    if(ui.sendMode==='Auto send')sendItems([item],isLan?'lan':'camera',false,item.isNew?[...item.dirty]:fields);\n    if(!isLan&&cameraSort(item.device).field===field)renderCameras();");
  replace("  function renderLans(){", "  function renderLans(){return renderManagedDevices();}\n  function renderLegacyLans(){");
  replace("  function emptyRows(cols,start,count=2){return", "  function emptyRows(){return '';}\n  function legacyEmptyRows(cols,start,count=2){return");
  replaceBetween('<div class="hc-formula">', '<div class="hc-scroll">', '');
  replace("<button data-action=\"camera-columns\"", "<button class=\"hc-danger\" data-action=\"clear-device-cameras\" data-id=\"'+d.id+'\"'+(rows.length?'':' disabled')+'>'+icon('eraser')+'Clear all cameras</button><button class=\"hc-danger\" data-action=\"remove-device\" data-id=\"'+d.id+'\" aria-label=\"Remove '+esc(d.name)+' from managed list\">'+icon('trash-2')+'Remove device</button><button data-action=\"camera-columns\"");
  replace("<button data-action=\"camera-columns\" data-id=\"'+d.id+'\">'+icon('columns-3')+'Columns</button>", "");
  replace("<div class=\"hc-column-menu\" data-columns-for=\"'+d.id+'\" hidden>'+cameraColumnMenu(d.id)+'</div></div><div class=\"hc-sheet\">", "'+cameraSelectionStrip(d.id)+'</div><div class=\"hc-sheet\">");
  replace("function setTab(next,save=true){tab=next;", "function setTab(next,save=true){if(next==='discovery'){next='devices';if(discoveryCard)discoveryCard.open=true;}tab=next;");
  replace("for(const id of ['devices','discovery','cameras'])", "for(const id of ['devices','setup','cameras','assignment'])");
  replace("if(['devices','discovery','cameras'].includes(data.tab))", "if(['devices','discovery','setup','cameras','assignment'].includes(data.tab))");
  replace("if(!device(id)||!groups||typeof groups!=='object')continue;", "if(!sheetOwner(id)||!groups||typeof groups!=='object')continue;");
  replace("if(device(id)&&Array.isArray(fields))", "if(sheetOwner(id)&&Array.isArray(fields))");
  replace("content=resultMark(camera.result);", "content=resultMark(syncResult(camera));");
  replace("el.innerHTML=resultMark(item.result));", "el.innerHTML=resultMark(syncResult(item)));");
  replace("classList.toggle('hc-changed',item.dirty.has(el.dataset.field)));", "classList.toggle('hc-changed',item.dirty.has(el.dataset.field)||routeChanged(item,el.dataset.field)));");
  replace("if(focusId)root.querySelector('[data-reorder-handle=\"'+focusId+'\"]')?.focus();", "if(focusId)root.querySelector('#hc-'+tab+' [data-reorder-handle=\"'+focusId+'\"]')?.focus();");
  source=source.replaceAll("el.closest('table')===$('lan-grid')", "!!el.closest('table[data-lan-device]')");
  source=source.replaceAll("$('lan-value').textContent=el.value;", "if($('lan-value'))$('lan-value').textContent=el.value;");
  replace("else{const id=item.device;root.querySelector('[data-formula-value=\"'+id+'\"]').textContent=el.value;}", "");
  replace("handle.closest('[data-controller]').dataset.dragging", "handle.closest('[data-controller],[data-network-controller]').dataset.dragging");
  source=source.replaceAll("event.target.closest('[data-controller]')", "event.target.closest('[data-controller],[data-network-controller]')");
  source=source.replaceAll("group.dataset.controller", "(group.dataset.controller||group.dataset.networkController)");
  replace("  function startScan(){\n", "  function startScan(){\n    if(moduleBridge&&!moduleBridge.preview){startLiveScan();return;}\n");
  replace("  function addResults(){", "  function addResults(){if(moduleBridge&&!moduleBridge.preview){void addLiveResults();return;}");
  replace("  function probeIP(){", "  function probeIP(){if(moduleBridge&&!moduleBridge.preview){void probeLiveIP();return;}");
  replace("action('add-discovered').disabled=!selected;", "action('add-discovered').disabled=!selected||addingDiscovered;");
  replace("case 'stop-scan':if(scanTimer)", "case 'stop-scan':if(moduleBridge&&!moduleBridge.preview)void moduleBridge.stopScan().catch(error=>toast(error.message));if(scanTimer)");
  replace("case 'refresh-all':action('refresh-all').disabled=true;", "case 'refresh-all':if(moduleBridge&&!moduleBridge.preview){void refreshLive();break;}action('refresh-all').disabled=true;");
  replace("const isLan=!!el.closest('table[data-lan-device]'),item=(isLan?lans:cameras).find", "persistence='draft';saveSequence++;const isLan=!!el.closest('table[data-lan-device]'),item=(isLan?lans:cameras).find");
  replace("content=inputCell(l,'planned',l.planned,'hc-mono',wan&&l.dhcp)", "content=inputCell(l,'planned',l.planned,'hc-mono',l.readOnly||wan&&l.dhcp)");
  replace("options(wan?['Keep','Edit']:['Keep','Add','Replace'],l.operation)", "options(l.readOnly?['']:wan?['Keep','Edit']:['Keep','Add','Replace'],l.readOnly?'':l.operation)");
  replace("data-field=\"operation\" aria-label=", "data-field=\"operation\"'+(l.readOnly?' disabled':'')+' aria-label=");
  replace("else if(field==='model')content=selectCell(camera,field,['Choose model…','Venice-IP','Alpha-USB','Alpha-IP','Sony FX6','Sony FX9','Sony FR7']);", "else if(field==='model')content=cameraChoiceCell(camera,field);");
  replace("else if(field==='lens')content=selectCell(camera,field,lensModels);", "else if(field==='lens')content=cameraChoiceCell(camera,field);");
  replace("function lensCapabilities(camera){const torque=camera.lens==='ARRI - cforce'||camera.lens==='cmotion cGate',motor=camera.lens==='Tilta - Nucleus-M';", "function lensCapabilities(camera){const editable=camera.lensParamsEditable!==false,torque=editable&&(camera.lens==='ARRI - cforce'||camera.lens==='cmotion cGate'),motor=editable&&camera.lens==='Tilta - Nucleus-M';");
  replace("    if(field.endsWith('Motor'))return p.motor;", "    const axis=lensAxisForField(field);if(axis&&!lensAxisEnabled(camera,axis))return false;\n    if(field.endsWith('Motor'))return p.motor;");
  replaceBetween("  function lensParameters(camera){", "  function cameraGrid(", "");
  replace("      else if(column.summary){classes.push('hc-axis-summary');if(!p.iris)classes.push('hc-axis-inactive');content=esc(axisSummary(camera,column.group));}", "      else if(column.summary){classes.push('hc-axis-summary');if(!lensAxisAvailable(camera))classes.push('hc-axis-inactive');content=lensAxisControl(camera,column.group,!axisGroups(deviceId)[column.group]);}");
  replace("Expand Iris, Zoom or Focus in the sheet headers to edit each axis.", "Expand Iris, Zoom or Focus, then tick Use Iris, Use Zoom or Use Focus for a camera to configure that axis.");
  replace("    const defaults={irisMotor:'3',zoomMotor:'5',focusMotor:'2',irisMin:'1.6',irisMax:'32',irisTorque:'2',zoomTorque:'2',focusTorque:'2',irisDirection:'left',zoomDirection:'left',focusDirection:'left',lensIp:''};\n    for(const [field,value] of Object.entries(defaults))if(camera[field]===undefined)camera[field]=value;", "    // Blank until someone enters a value or the controller reports one.\n    for(const field of ['irisMotor','zoomMotor','focusMotor','irisMin','irisMax','irisTorque','zoomTorque','focusTorque','irisDirection','zoomDirection','focusDirection','lensIp'])if(camera[field]===undefined)camera[field]='';");
  replace("if(axis==='iris'&&p.iris)return camera.irisMin+'–'+camera.irisMax;", "if(axis==='iris'&&p.iris)return camera.irisMin&&camera.irisMax?camera.irisMin+'–'+camera.irisMax:'';");
  replace("if(p.motor)return 'Motor '+camera[axis+'Motor'];", "if(p.motor)return camera[axis+'Motor']?'Motor '+camera[axis+'Motor']:'';");
  replace("if(p.torque)return 'T'+camera[axis+'Torque']+' '+(camera[axis+'Direction']==='left'?'Left':'Right');", "if(p.torque)return camera[axis+'Torque']&&camera[axis+'Direction']?'T'+camera[axis+'Torque']+' '+(camera[axis+'Direction']==='left'?'Left':'Right'):'';");
  // Room for "Swapped" beside the list arrow.
  replace("{id:'irisDirection',label:'Direction',width:85}", "{id:'irisDirection',label:'Direction',width:100}");
  // A Tilta iris has no direction of its own, so its Direction cell stays live and swaps Open and Closed.
  replace("inactive=isLensSetting(field)&&!lensFieldUsed(camera,field);", "inactive=isLensSetting(field)&&!lensFieldUsed(camera,field)&&!irisSwapCell(camera,field);");
  replace("  function valid(item,kind){", "  function valid(item,kind,fields=[]){");
  replace("    if(p.iris&&(!(Number(item.irisMin)>0)||!(Number(item.irisMax)>Number(item.irisMin))))return 'Incomplete';", "    const filled=fields.filter(field=>!lensAxisBeingCleared(item,field));\n    if(filled.some(field=>field==='irisMin'||field==='irisMax')&&!irisRangeValid(item))return 'Incomplete';");
  replace("    if(p.motor){const ids=[item.irisMotor,item.zoomMotor,item.focusMotor];if(ids.some(id=>!/^\\d+$/.test(id)||Number(id)<1)||new Set(ids.map(Number)).size!==3)return 'Incomplete';}", "    const ids=filled.filter(field=>lensAxisForField(field)&&field.endsWith('Motor')).map(field=>item[field]);\n    if(ids.some(id=>!/^\\d+$/.test(id)||Number(id)<1)||new Set(ids.map(Number)).size!==ids.length)return 'Incomplete';\n    for(const axis of new Set(filled.map(lensAxisForField).filter(Boolean)))if(axisDefinitions[axis].some(definition=>lensFieldUsed(item,definition.id)&&!item[definition.id]))return 'Incomplete';");
  replace("if(!isLan&&field==='lens'){initializeLensFields(item);", "if(!isLan&&field==='lens'){delete item.lensParamsEditable;initializeLensFields(item);for(const setting of [...Object.values(axisDefinitions).flatMap(definitions=>definitions.map(definition=>definition.id)),'lensIp','lensPort'])if(lensFieldUsed(item,setting)&&(setting!=='lensPort'||item.lensPort&&item.lensPort!=='None')){item.dirty.add(setting);fields.push(setting);}");
  replace("else if(field==='lens'&&item.lens==='None'){item.lensPort='None';item.dirty.add('lensPort');fields.push('lensPort');}", "else if(field==='lens'&&item.lens==='None'){item.lensPort='None';}");
  replace("selectCell(camera,'usb',['USB · Automatic','USB · FX3A 00421'])", "cameraChoiceCell(camera,'usb')");
  replace("selectCell(camera,'lensPort',camera.lens==='ARRI - cforce'?['None','USB · CAN adapter']:['None','RIO 01 : 1','RIO 01 : 2','RIO 02 : 1','RIO 02 : 2','USB · Serial converter'],!p.port)", "cameraChoiceCell(camera,'lensPort',!p.port)");
  replace("selectCell(camera,field,['1','2','3','4'],inactive)", "cameraChoiceCell(camera,field,inactive)");
  replace("selectCell(camera,field,[{id:'left',label:'Left'},{id:'right',label:'Right'}],inactive)", "cameraChoiceCell(camera,field,inactive)");
  replaceBetween("  root.addEventListener('focusin',event=>{", "  root.addEventListener('input',event=>{", "");
  replace("action('scan').disabled=!$('scan-range').value;syncFilter();renderLans();renderCameras();}", "action('scan').disabled=!$('scan-range').value;syncFilter();if(data.deviceFilter==='all'||devices.some(item=>item.id===data.deviceFilter))$('device-filter').value=data.deviceFilter;renderLans();renderCameras();}");
  replaceBetween("  function commitCell(el){", "  function updateDesign(){", await readFile(path.join(root, 'src/ui-sheet-edits.js'), 'utf8'));
  replace("$('drawer').hidden=true;if(save)remember();}", "$('drawer').hidden=true;refreshCameraSheets();if(save)remember();}");
  replace("if(!el.dataset?.row||el.type==='checkbox')return;", "if(!el.dataset?.row||el.type==='checkbox'||el.closest('table[data-camera-device]'))return;");
  replace("if(el.dataset.row&&el.dataset.field)commitCell(el);", "if(el.dataset.row&&el.dataset.field&&!el.closest('table[data-camera-device]'))commitCell(el);");
  replaceBetween("  function cameraColumnSections(){", "  function hiddenCameraColumns", "  function cameraColumnSections(){return cameraSheetSections();}\n");
  replace("function cameraColumnVisible(id,field){return !hiddenCameraColumns(id).has(field);}", "function cameraColumnVisible(id,field){return cameraFieldVisible(id,field);}");
  replace("<div class=\"hc-sheet-tabs\"><span class=\"hc-sheet-tab\">'+esc(d.name)+' cameras</span><span class=\"hc-sheet-caption\">'+esc(d.alias||d.base)+'</span></div>", "");
  replace("<div class=\"hc-controller-bottom\"><span>Camera &amp; lens settings</span><span data-connection-note>'+esc(connectionNote(d))+'</span></div>", "<span class=\"hc-visually-hidden\" data-connection-note>'+esc(connectionNote(d))+'</span>");
  // A controller's camera count is set with a number box rather than added one row at a time.
  replace("<select data-new-camera=\"'+d.id+'\" aria-label=\"Add camera to '+esc(d.name)+'\"><option value=\"\">+ Add camera…</option><option value=\"Venice-IP\">Sony · Venice-IP</option><option value=\"Alpha-USB\">Sony · Alpha-USB</option><option value=\"Alpha-IP\">Sony · Alpha-IP</option><option value=\"Choose model…\">Blank camera row</option></select>", "'+cameraCountControl(d.id)+'");
  replace("if(Array.isArray(data.deviceOrder))", "restoreCameraSheets(data);if(Array.isArray(data.deviceOrder))");
  const hooks = (await Promise.all(['src/ui-camera-control.js','src/ui-device-workflows.js','src/ui-camera-grid-layout.js','src/ui-camera-sheets.js','src/ui-camera-sorting.js','src/ui-backend-hooks.js','src/ui-remi-workflows.js','src/ui-lens-axes.js','src/ui-camera-choices.js','src/ui-sheet-history.js','src/ui-camera-workbook.js','src/ui-camera-assignment.js','src/ui-rig.js','src/ui-device-sheet.js','src/ui-dropdowns.js','src/ui-camera-count.js','src/ui-text-size.js'].map(file=>readFile(path.join(root,file),'utf8')))).join('\n');
  replace("  syncFilter();renderLans();renderCameras();setTab('cameras',false);restore(window.openai?.widgetState);", hooks + "\n  initializeDeviceWorkflow();syncFilter();renderLans();renderCameras();setTab('devices',false);restore(window.openai?.widgetState);\n  if(moduleBridge)void initializeBackend();else root.hidden=false;");
  const imports = [
    "import { createSpreadsheetContextMenu, mountSpreadsheetControls, mountSpreadsheetColumnGroup, mountSpreadsheetResize, mountSpreadsheetColumnEditor, mountSpreadsheetViewport } from '@hubble/module-sdk/spreadsheet-controls';",
    "import { cameraChoiceKey } from './choice-context.js';",
    "import { PresentationLedger } from './presentation-ledger.js';",
  ].join('\n');
  await writeFile(path.join(root, 'src/ui-controller.js'), imports + '\n' + source);
}
