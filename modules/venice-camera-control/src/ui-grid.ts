import {
  mountSpreadsheetControls,mountSpreadsheetColumnGroup,mountSpreadsheetColumnEditor,
  createSpreadsheetContextMenu,mountSpreadsheetReorder,mountSpreadsheetResize,mountSpreadsheetViewport,
  type SpreadsheetAddress,type SpreadsheetCell,type SpreadsheetControls,type SpreadsheetColumn,type SpreadsheetColumnGroup,
  type SpreadsheetEdit,type SpreadsheetReorderItem,type SpreadsheetColumnGroupControls
} from '@hubble/module-sdk/spreadsheet-controls';
import { groups,fields,fieldById,valueOf,clone,visibleFields,withColumnVisibility,withNoColumns,activeSheetId,isFlipped,viewChange,isLoginField,loginVisible,type View,type Camera,type CellEdit,type Field } from './model.js';
import { DraftStore } from './draft-store.js';
import type { Observations } from './backend.js';

export interface GridOptions {
  table:HTMLTableElement; viewport:HTMLElement; columnEditor:HTMLElement; store:DraftStore;
  observations:()=>Observations; onSelect:(address:SpreadsheetAddress|undefined)=>void;
  onZoom?:(ratio:number)=>void;
  onRefresh:(rowId:string)=>void; onRemove:(rowId:string)=>void; onError:(message:string)=>void;
  onEdited?:(edits:CellEdit[])=>void;
}
const meta=[
  {id:'camera-name',label:'Camera',width:190,fill:'series' as const,frozen:true},{id:'camera-host',label:'Host / IP',width:150,fill:'series' as const,frozen:true},{id:'recording-status',label:'Recording',width:100,fill:'copy' as const,frozen:true},{id:'connection-status',label:'Connection',width:110,fill:'copy' as const,frozen:true},
  {id:'camera-username',label:'Username',width:120,fill:'copy' as const,frozen:false},{id:'camera-password',label:'Password',width:120,fill:'copy' as const,frozen:false}
];
const frozenMeta=meta.filter(m=>m.frozen),loginMeta=meta.filter(m=>!m.frozen);
const addressKey=(a:SpreadsheetAddress)=>a.rowId+'/'+a.columnId;
const clearAllId='clear-all-columns',settingLabelsId='setting-labels',defaultLabelWidth=240,defaultCameraWidth=170,defaultSettingHeight=36;
const recordingLabels:Record<string,string>={recording:'\u25CF REC',standby:'STBY',starting:'Starting'};
const settingLabel=(id:string)=>fieldById.get(id)?.label??meta.find(m=>m.id===id)?.label;
// Every address the grid keeps or hands out is {rowId: camera, columnId: setting}.
// Only the shared controls and the cell attributes see the flipped positions.
export async function createCameraGrid(options:GridOptions){
  const {table,viewport,store}=options;
  const tracks=table.createTHead().parentElement!.querySelector('colgroup')!;
  const head=table.tHead!,groupRow=head.insertRow(),fieldRow=head.insertRow(),body=table.createTBody();
  const cells=new Map<string,HTMLTableCellElement>(),rows=new Map<string,HTMLTableRowElement>(),fieldHeaders=new Map<string,HTMLTableCellElement>(),trackMap=new Map<string,HTMLTableColElement>();
  const groupHeaders=new Map<string,HTMLTableCellElement>(),groupControls=new Map<string,SpreadsheetColumnGroupControls>(),providerCache=new Map<string,{signature:string;provider:(query:string,signal:AbortSignal)=>Promise<{value:string;label:string;group?:string}[]>}>();
  const placeholders=new Map<string,{track:HTMLTableColElement;header:HTMLTableCellElement;cells:Map<string,HTMLTableCellElement>}>();
  const labelTrack=document.createElement('col'),cameraTracks=new Map<string,HTMLTableColElement>(),labelHeads=new Map<string,HTMLTableCellElement>();
  const numberRow=document.createElement('tr'),numberCorner=document.createElement('th'),numberHeads=new Map<string,HTMLTableCellElement>();
  numberCorner.scope='col';numberCorner.className='setting-label number-corner';numberCorner.setAttribute('aria-label','Setting names');
  const identityRows=new Map<string,HTMLTableRowElement>(),settingRows=new Map<string,HTMLTableRowElement>();
  const sectionRows=new Map<string,{row:HTMLTableRowElement;filler:HTMLTableCellElement}>();
  const controlsToDispose:{dispose():void;refresh?():void}[]=[];
  let active:SpreadsheetAddress|undefined,controls:SpreadsheetControls,editor:{address:SpreadsheetAddress;cell:HTMLTableCellElement;input:HTMLInputElement;expected:string}|undefined,disposed=false,shownLayout='';
  let resize:Awaited<ReturnType<typeof mountSpreadsheetResize>>|undefined;
  let reorder:Awaited<ReturnType<typeof mountSpreadsheetReorder>>|undefined;
  let zoomRatio=1;
  let viewportControls:Awaited<ReturnType<typeof mountSpreadsheetViewport>>|undefined;
  const allColumnIds=[...meta.map(c=>c.id),...fields.map(f=>f.id)];
  const view=()=>store.document.view;
  const flipped=()=>isFlipped(store.document);
  const shownLogin=()=>loginMeta.filter(m=>loginVisible(view(),m.id));
  const position=<T extends SpreadsheetAddress>(address:T):T=>flipped()?{...address,rowId:address.columnId,columnId:address.rowId}:address;
  const orderedGroups=()=>[...view().order,...groups.map(g=>g.id).filter(id=>!view().order.includes(id))];
  const orderedFields=()=>orderedGroups().flatMap(id=>{
    const group=groups.find(g=>g.id===id)!;
    return [...(view().fields[id]??[]),...group.fields.map(f=>f.id).filter(f=>!view().fields[id]?.includes(f))].map(id=>fieldById.get(id)!);
  });
  const currentRow=(id:string)=>store.document.cameras.find(r=>r.id===id);
  const observation=(row:Camera)=>{const o=options.observations()[row.id];return o?.host===valueOf(row,'camera-host')?o:undefined;};
  const isOnline=(row:Camera)=>observation(row)?.state==='online';
  const shown=(row:Camera,id:string)=>row.values[id]||observation(row)?.values[id]||'';
  const getChoices=(row:Camera,field:Field)=>{
    const observed=observation(row)?.choices[field.id];
    return field.choices.length?field.choices.map(c=>({value:c.value,label:c.label})):observed??[];
  };
  function cellValue(address:SpreadsheetAddress):SpreadsheetCell|null{
    const row=currentRow(address.rowId);if(!row)return null;
    if(address.columnId==='recording-status')return {value:isOnline(row)?recordingLabels[observation(row)?.recording??'']??'':'',readOnly:true};
    if(address.columnId==='connection-status')return {value:observation(row)?.state==='online'?(observation(row)?.live?'Live':'Ready'):observation(row)?.state==='error'?'Read failed':'Offline',readOnly:true};
    if(meta.some(m=>m.id===address.columnId))return {value:valueOf(row,address.columnId)};
    const field=fieldById.get(address.columnId);if(!field)return null;
    // A camera that isn't online shows nothing, and an edit there would be invisible, so its settings are locked.
    // Anything already staged stays in the Pending sends list.
    if(!isOnline(row))return {value:'',readOnly:true};
    const base={value:shown(row,field.id)};
    if(field.kind==='boolean')return {...base,kind:'boolean'};
    const choices=getChoices(row,field);
    if(!choices.length)return base;
    const key=addressKey(address),signature=JSON.stringify(choices);
    if(providerCache.get(key)?.signature!==signature)providerCache.set(key,{signature,provider:async(query,signal)=>{
      signal.throwIfAborted();const words=query.toLowerCase().split(/\s+/);
      return choices.filter(c=>words.every(w=>(c.label+' '+c.value).toLowerCase().includes(w))).map(c=>({...c,group:groups.find(g=>g.id===field.group)!.label}));
    }});
    return {...base,choices:providerCache.get(key)!.provider};
  }
  function layout(next:View){store.submit(viewChange(store.document,next));}
  function groupDescriptor(id:string):SpreadsheetColumnGroup{
    const group=groups.find(g=>g.id===id)!;
    return {id,label:group.label,columns:orderedFields().filter(f=>f.group===id).map(f=>({id:f.id,label:f.label,fill:'copy'})),expanded:!!view().expanded[id],collapsedColumnIds:view().collapsed[id]??group.collapsed};
  }
  const hasOptionalColumns=()=>shownLogin().length>0||groups.some(g=>!view().hiddenGroups?.includes(g.id));
  function setVisibility(changes:readonly {id:string;visible:boolean}[]){
    const clearing=changes.find(change=>change.id===clearAllId);
    if(clearing){if(clearing.visible){columnEditor.refresh();return;}layout(withNoColumns(view()));}
    else layout(withColumnVisibility(view(),changes));
    followSelection();
  }
  function setVisible(id:string,visible:boolean){setVisibility([{id,visible}]);}
  function move(ids:readonly string[],beforeId:string|null,scope?:string){
    const next=clone(view()),current=scope&&scope!=='groups'?(next.fields[scope]??orderedFields().filter(f=>f.group===scope).map(f=>f.id)):next.order;
    const moved=current.filter(id=>ids.includes(id)),remaining=current.filter(id=>!ids.includes(id)),index=beforeId?remaining.indexOf(beforeId):-1;
    remaining.splice(index<0?remaining.length:index,0,...moved);
    if(scope&&scope!=='groups')next.fields[scope]=remaining;else next.order=remaining;
    layout(next);
  }
  function orderNodes(parent:HTMLElement,nodes:HTMLElement[]){for(let i=0;i<nodes.length;i++)if(parent.children[i]!==nodes[i])parent.insertBefore(nodes[i]!,parent.children[i]??null);}
  function place(parent:HTMLElement,nodes:HTMLElement[]){orderNodes(parent,nodes);while(parent.children.length>nodes.length)parent.lastElementChild!.remove();}
  const corner=document.createElement('th');corner.rowSpan=2;corner.className='row-number corner';corner.setAttribute('aria-label','Camera rows');groupRow.append(corner);
  const metaHeads=meta.map(m=>{const th=document.createElement('th');th.textContent=m.label;th.rowSpan=2;th.scope='col';th.dataset.columnId=m.id;th.tabIndex=0;th.className=m.frozen?'identity-column':'login-column';groupRow.append(th);return th;});
  for(const id of allColumnIds){const col=document.createElement('col');trackMap.set(id,col);tracks.append(col);}
  const gutter=document.createElement('col');gutter.style.width='34px';tracks.prepend(gutter);
  for(const field of fields){const th=document.createElement('th');th.scope='col';th.textContent=field.label;th.dataset.columnId=field.id;th.tabIndex=0;th.title=field.note;fieldHeaders.set(field.id,th);fieldRow.append(th);}
  for(const group of groups){
    const th=document.createElement('th');th.scope='colgroup';th.className='setting-group';th.dataset.groupId=group.id;th.tabIndex=0;const slot=document.createElement('div');th.append(slot);groupHeaders.set(group.id,th);groupRow.append(th);
    const track=document.createElement('col'),header=document.createElement('th');header.className='empty-group-header';header.setAttribute('aria-hidden','true');
    tracks.append(track);fieldRow.append(header);placeholders.set(group.id,{track,header,cells:new Map()});
    const row=document.createElement('tr'),filler=document.createElement('td');row.className='setting-section';filler.className='section-filler';filler.setAttribute('aria-hidden','true');sectionRows.set(group.id,{row,filler});
  }
  for(const item of [...meta,...fields]){const th=document.createElement('th');th.scope='row';th.className='setting-label';th.tabIndex=0;th.textContent=item.label;th.dataset.settingLabel=item.id;if('note' in item)th.title=item.note;labelHeads.set(item.id,th);}
  for(const m of frozenMeta){const row=document.createElement('tr');row.dataset.settingId=m.id;identityRows.set(m.id,row);}
  const loginSection=document.createElement('tr'),loginHeader=document.createElement('th'),loginFiller=document.createElement('td');
  loginSection.className='setting-section';loginHeader.scope='rowgroup';loginHeader.className='setting-group';loginHeader.textContent='Login';loginFiller.className='section-filler';loginFiller.setAttribute('aria-hidden','true');
  function settingRow(id:string){let row=settingRows.get(id);if(!row){row=document.createElement('tr');row.dataset.settingId=id;settingRows.set(id,row);}return row;}

  function submit(edits:readonly SpreadsheetEdit[],expected?:string):boolean{
    const changes=edits.flatMap(edit=>{
      // An edit already open when its camera drops offline still saves. Only an open editor passes `expected`.
      const row=currentRow(edit.rowId),cell=cellValue(edit);if(!row||!cell||(cell.readOnly&&expected===undefined))return [];
      return [{rowId:edit.rowId,columnId:edit.columnId,value:edit.value,expected:expected??valueOf(row,edit.columnId)}];
    }).filter(edit=>edit.value!==edit.expected);
    if(!changes.length)return true;
    const accepted=store.submit({kind:'edit',edits:changes});
    if(accepted)options.onEdited?.(changes);
    return accepted;
  }
  // The shared controls take a column's fill and name, but across cameras it's the setting that decides them.
  function cameraColumns():SpreadsheetColumn[]{
    const selected=[...table.querySelectorAll<HTMLElement>('[data-hubble-spreadsheet-selected]')];
    const fill=selected.length&&selected.every(cell=>meta.find(m=>m.id===cell.dataset.settingId)?.fill==='series')?'series' as const:'copy' as const;
    const open=active&&settingLabel(active.columnId);
    return store.document.cameras.map(row=>({id:row.id,label:row.id===active?.rowId&&open?open:valueOf(row,'camera-name'),fill}));
  }
  controls=await mountSpreadsheetControls({
    root:table,viewport,extendedEditing:true,workbookEditing:true,
    getRows:()=>flipped()?[...frozenMeta,...shownLogin()].map(m=>m.id).concat(visibleFields(view()).map(f=>f.id)):store.document.cameras.map(r=>r.id),
    getColumns:()=>flipped()?cameraColumns():[...frozenMeta,...shownLogin(),...visibleFields(view()).map(f=>({id:f.id,label:f.label,fill:'copy' as const}))],
    getCell:address=>cellValue(position(address)),onEdit:batch=>submit(batch.edits.map(position)),
    onSelection(address){active=address&&position(address);options.onSelect(active);if(flipped())controls.refresh();},
    onHistory(direction){if(active&&store.invalid.has(addressKey(active))){store.discard(active.rowId,active.columnId);return;}store.history(direction==='redo');},
    onError:error=>options.onError(error.message)
  });
  controlsToDispose.push(controls);
  for(const group of groups){
    const header=await mountSpreadsheetColumnGroup({
      root:groupHeaders.get(group.id)!.firstElementChild as HTMLElement,
      getGroup:()=>groupDescriptor(group.id),
      onChange(next){const v=clone(view());v.expanded[group.id]=next.expanded;v.collapsed[group.id]=[...next.collapsedColumnIds];v.fields[group.id]=next.columns.map(c=>c.id);layout(v);},
      onError:error=>options.onError(error.message)
    });groupControls.set(group.id,header);controlsToDispose.push(header);
  }
  const columnEditor=await mountSpreadsheetColumnEditor({
    root:options.columnEditor,
    getItems:()=>[{id:clearAllId,label:'Clear all columns',visible:hasOptionalColumns()},{id:'login',label:'Login',visible:!view().hiddenLogin?.includes('login'),fields:loginMeta.map(m=>({id:m.id,label:m.label,visible:!view().hiddenLogin?.includes(m.id)}))},...view().order.map(id=>{const g=groups.find(g=>g.id===id)!;const visible=new Set(visibleFields({...view(),hiddenGroups:[]}).map(f=>f.id));return {id,label:g.label,visible:!view().hiddenGroups?.includes(id),fields:orderedFields().filter(f=>f.group===id).map(f=>({id:f.id,label:f.label,visible:visible.has(f.id)}))};})],
    onVisibilityChange:setVisible,
    onVisibilityChanges:setVisibility,
    onMove(id,beforeId){if(id===clearAllId||id==='login'||isLoginField(id))return;move([id],beforeId===clearAllId||beforeId==='login'?view().order[0]!:beforeId,fieldById.get(id)?.group??'groups');}
  });controlsToDispose.push(columnEditor);
  const menu=await createSpreadsheetContextMenu({root:table,onError:error=>options.onError(error.message)});controlsToDispose.push(menu);
  table.addEventListener('contextmenu',event=>{
    const target=(event.target as Element).closest<HTMLTableCellElement>('td,th');if(!target)return;
    const rowId=target.dataset.cameraId??target.dataset.rowId;
    const columnId=target.dataset.settingId;
    const hideId=columnId??target.dataset.settingLabel??target.dataset.columnId;
    const hideable=!!hideId&&(fieldById.has(hideId)||isLoginField(hideId));
    if(!rowId&&!hideable)return;
    event.preventDefault();
    const hide=hideable?[{id:'hide',label:'Hide '+settingLabel(hideId)!,run:()=>setVisible(hideId,false)}]:[];
    menu.open({x:event.clientX,y:event.clientY,label:rowId?'Camera':settingLabel(hideId!)!,items:rowId?[
      {id:'refresh',label:'Refresh camera',run:()=>options.onRefresh(rowId)},
      ...(columnId?[{id:'edit',label:'Edit cell',disabled:!!cellValue({rowId,columnId})?.readOnly,run:()=>startEdit(target as HTMLTableCellElement)},{id:'discard',label:'Discard invalid draft',disabled:!store.invalid.has(rowId+'/'+columnId),run:()=>store.discard(rowId,columnId)}]:[]),
      ...(hide.length?[{separator:true as const},...hide]:[]),
      {separator:true},{id:'remove',label:'Remove camera from plan',danger:true,run:()=>options.onRemove(rowId)}
    ]:hide});
  });
  render();
  // The host draws these handles on a layer above the sheet and knows nothing of frozen cells,
  // so one whose edge has scrolled underneath them has to drop out.
  function handleIsExposed({axis,header}:{axis:'row'|'column';header:HTMLElement}){
    if(header===numberCorner||metaHeads.some((head,index)=>head===header&&meta[index]!.frozen)||frozenMeta.some(m=>labelHeads.get(m.id)===header))return true;
    const box=header.getBoundingClientRect();
    if(axis==='column')return box.right>(flipped()?numberCorner:metaHeads[meta.findIndex(m=>m.id==='connection-status')]!).getBoundingClientRect().right+1;
    return box.bottom>(flipped()?labelHeads.get('connection-status')!:corner).getBoundingClientRect().bottom+1;
  }
  resize=await mountSpreadsheetResize({
    root:table,viewport,getScale:()=>zoomRatio,
    getItems:()=>(flipped()?[
      {id:settingLabelsId,label:'setting names',axis:'column' as const,header:numberCorner,size:view().settingLabelWidth??defaultLabelWidth,min:120,max:800},
      ...store.document.cameras.map(row=>({id:row.id,label:valueOf(row,'camera-name'),axis:'column' as const,header:numberHeads.get(row.id)!,size:view().cameraWidths?.[row.id]??defaultCameraWidth,min:96,max:800})),
      ...[...frozenMeta,...shownLogin()].map(m=>m.id).concat(visibleFields(view()).map(f=>f.id)).filter(id=>id!=='recording-status').map(id=>({id,label:settingLabel(id)!,axis:'row' as const,header:labelHeads.get(id)!,size:view().settingHeights?.[id]??defaultSettingHeight,min:28,max:200}))
    ]:[
      ...[...frozenMeta,...shownLogin()].filter(m=>m.id!=='connection-status'&&m.id!=='recording-status').map(m=>({id:m.id,label:m.label,axis:'column' as const,header:metaHeads[meta.indexOf(m)]!,size:view().widths[m.id]??m.width,min:96,max:800})),
      ...visibleFields(view()).map(f=>({id:f.id,label:f.label,axis:'column' as const,header:fieldHeaders.get(f.id)!,size:view().widths[f.id]??f.width,min:96,max:800})),
      ...store.document.cameras.map(row=>({id:row.id,label:valueOf(row,'camera-name'),axis:'row' as const,header:rows.get(row.id)!.cells[0] as HTMLElement,size:view().rowHeights[row.id]??36,min:28,max:200}))
    ]).filter(handleIsExposed),
    onResize(item,size){
      const next=clone(view());
      if(flipped()){if(item.axis==='row')(next.settingHeights??={})[item.id]=size;else if(item.id===settingLabelsId)next.settingLabelWidth=size;else (next.cameraWidths??={})[item.id]=size;}
      else if(item.axis==='column')next.widths[item.id]=size;else next.rowHeights[item.id]=size;
      layout(next);
    }
  });controlsToDispose.push(resize);
  reorder=await mountSpreadsheetReorder({
    root:table,getItems:()=>{
      const result:SpreadsheetReorderItem[]=[],isFlippedNow=flipped(),cameras=store.document.cameras;
      const axis=isFlippedNow?'row' as const:'column' as const;
      const settingCells=(f:Field)=>cameras.map(row=>cells.get(row.id+'/'+f.id)!);
      const handleOf=(f:Field)=>isFlippedNow?labelHeads.get(f.id)!:fieldHeaders.get(f.id)!;
      for(const id of orderedGroups().filter(id=>!view().hiddenGroups?.includes(id))){const group=groups.find(g=>g.id===id)!;const list=visibleFields(view()).filter(f=>f.group===id);
        result.push({id,label:group.label,axis,scope:'groups',handle:groupHeaders.get(id)!,elements:[groupHeaders.get(id)!,...list.flatMap(f=>[handleOf(f),...settingCells(f)])]});
        for(const f of list)result.push({id:f.id,label:f.label,axis,scope:id,handle:handleOf(f),elements:[handleOf(f),...settingCells(f)]});
      }
      return result;
    },onMove:request=>move(request.ids,request.beforeId,request.scope),onError:error=>options.onError(error.message)
  });controlsToDispose.push(reorder);
  viewportControls=await mountSpreadsheetViewport({root:table,viewport,onZoom(ratio){zoomRatio=ratio;controls.refresh();resize?.refresh();reorder?.refresh();options.onZoom?.(ratio);}});
  controlsToDispose.push(viewportControls);
  function startEdit(cell:HTMLTableCellElement,initial?:string){
    const rowId=cell.dataset.cameraId,columnId=cell.dataset.settingId;if(!rowId||!columnId)return false;
    const address={rowId,columnId},field=cellValue(address),row=currentRow(rowId)!;
    if(!field||field.readOnly||field.choices||field.kind==='boolean')return false;
    const input=document.createElement('input');input.className='cell-input';input.setAttribute('aria-label','Edit '+(settingLabel(columnId)??'cell'));
    input.value=initial??store.invalid.get(addressKey(address))?.edit.value??field.value;
    const current={address,cell,input,expected:valueOf(row,columnId)};editor=current;
    const startedWith=field.value,retrying=store.invalid.has(addressKey(address));
    const finish=(commit:boolean,focus:boolean)=>{
      if(editor!==current)return;editor=undefined;
      // Leaving a cell unchanged isn't an edit, even if the camera has moved on since it opened.
      if(commit&&(retrying||input.value!==startedWith))submit([{...address,value:input.value}],current.expected);
      render();if(focus)controls.select(position(address));
    };
    input.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(['Escape','Tab','Enter'].includes(event.key)){event.preventDefault();event.stopPropagation();finish(event.key!=='Escape',true);if(event.key==='Tab')controls.move?.(event.shiftKey?-1:1,0);else if(event.key==='Enter')controls.move?.(0,1);}
    });
    input.addEventListener('blur',()=>finish(true,false),{once:true});
    delete cell.dataset.empty;cell.replaceChildren(input);input.focus();input.setSelectionRange(input.value.length,input.value.length);return true;
  }
  table.addEventListener('keydown',event=>{
    if(event.target!==table||event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
    const cell=table.querySelector<HTMLTableCellElement>('[data-hubble-spreadsheet-active="true"]');
    if(cell&&(event.key==='F2'||event.key==='Enter'||event.key.length===1)&&startEdit(cell,event.key.length===1?event.key:undefined)){event.preventDefault();event.stopImmediatePropagation();}
  },{capture:true});
  table.addEventListener('dblclick',event=>{const cell=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLTableCellElement>('td');if(cell&&table.contains(cell)&&!editor)startEdit(cell);});
  function ensureCamera(row:Camera){
    if(rows.has(row.id))return;
    const visible=new Set(visibleFields(view()).map(f=>f.id));
    const tr=document.createElement('tr');tr.dataset.cameraId=row.id;rows.set(row.id,tr);const number=document.createElement('th');number.scope='row';number.className='row-number';number.dataset.rowId=row.id;tr.append(number);
    for(const id of allColumnIds){const cell=tr.insertCell();cell.dataset.cameraId=row.id;cell.dataset.settingId=id;cell.setAttribute('role','gridcell');if(frozenMeta.some(m=>m.id===id))cell.className='identity-column';cells.set(row.id+'/'+id,cell);}
    for(const group of groups){const cell=tr.insertCell();cell.className='empty-group-cell';cell.setAttribute('aria-hidden','true');cell.hidden=!!view().hiddenGroups?.includes(group.id)||group.fields.some(f=>visible.has(f.id));placeholders.get(group.id)!.cells.set(row.id,cell);}
    cameraTracks.set(row.id,document.createElement('col'));
    const head=document.createElement('th');head.scope='col';head.className='column-number';head.dataset.rowId=row.id;numberHeads.set(row.id,head);
  }
  function layoutRows(){
    const visible=new Set(visibleFields(view()).map(f=>f.id)),order=orderedFields(),groupOrder=orderedGroups();
    place(tracks,[gutter,...meta.map(m=>trackMap.get(m.id)!),...groupOrder.flatMap(id=>[...order.filter(f=>f.group===id).map(f=>trackMap.get(f.id)!),placeholders.get(id)!.track])]);
    place(head,[groupRow,fieldRow]);
    place(groupRow,[corner,...metaHeads,...groupOrder.map(id=>groupHeaders.get(id)!)]);
    place(fieldRow,groupOrder.flatMap(id=>[...order.filter(f=>f.group===id).map(f=>fieldHeaders.get(f.id)!),placeholders.get(id)!.header]));
    let width=34,offset=34;corner.style.left='0px';
    for(const [i,m]of meta.entries()){
      const w=view().widths[m.id]??m.width,show=m.frozen||loginVisible(view(),m.id);
      trackMap.get(m.id)!.style.width=w+'px';trackMap.get(m.id)!.style.display=show?'':'none';metaHeads[i]!.hidden=!show;metaHeads[i]!.style.left=m.frozen?offset+'px':'';metaHeads[i]!.style.minWidth=w+'px';
      if(m.frozen)offset+=w;if(show)width+=w;
    }
    for(const field of order){const show=visible.has(field.id);trackMap.get(field.id)!.style.display=show?'':'none';trackMap.get(field.id)!.style.width=(view().widths[field.id]??field.width)+'px';fieldHeaders.get(field.id)!.hidden=!show;if(show)width+=view().widths[field.id]??field.width;}
    for(const group of groups){
      const th=groupHeaders.get(group.id)!,placeholder=placeholders.get(group.id)!,hidden=!!view().hiddenGroups?.includes(group.id);
      const count=group.fields.filter(f=>visible.has(f.id)).length,empty=!hidden&&count===0;
      th.scope='colgroup';th.hidden=hidden;th.colSpan=Math.max(1,count);placeholder.header.hidden=!empty;placeholder.track.style.display=empty?'':'none';
      const w=Math.max(180,group.label.length*8+50);placeholder.track.style.width=w+'px';if(empty)width+=w;
      for(const cell of placeholder.cells.values())cell.hidden=!empty;
      groupControls.get(group.id)?.refresh();
    }
    table.style.width=width+'px';
    place(body,store.document.cameras.map(row=>rows.get(row.id)!));
    for(const [index,row]of store.document.cameras.entries()){
      const tr=rows.get(row.id)!;
      tr.style.height=(view().rowHeights[row.id]??36)+'px';tr.cells[0]!.textContent=String(index+1);
      tr.cells[0]!.setAttribute('aria-label',valueOf(row,'camera-name'));orderNodes(tr,[tr.cells[0] as HTMLElement,...meta.map(m=>cells.get(row.id+'/'+m.id)!),...groupOrder.flatMap(id=>[...order.filter(f=>f.group===id).map(f=>cells.get(row.id+'/'+f.id)!),placeholders.get(id)!.cells.get(row.id)!])]);
      let left=34;
      for(const m of frozenMeta){const cell=cells.get(row.id+'/'+m.id)!;cell.style.left=left+'px';cell.style.top='';left+=view().widths[m.id]??m.width;}
      for(const m of loginMeta){const cell=cells.get(row.id+'/'+m.id)!;cell.style.left='';cell.style.top='';}
    }
  }
  function layoutColumns(){
    const v=view(),cameras=store.document.cameras,labelWidth=v.settingLabelWidth??defaultLabelWidth;
    const cameraCells=(id:string)=>cameras.map(row=>cells.get(row.id+'/'+id)!);
    place(tracks,[labelTrack,...cameras.map(row=>cameraTracks.get(row.id)!)]);
    labelTrack.style.width=labelWidth+'px';
    let width=labelWidth;
    for(const row of cameras){const w=v.cameraWidths?.[row.id]??defaultCameraWidth;cameraTracks.get(row.id)!.style.width=w+'px';width+=w;}
    table.style.width=width+'px';
    const heightOf=(id:string)=>(v.settingHeights?.[id]??defaultSettingHeight)+'px';
    place(head,[numberRow,...frozenMeta.map(m=>identityRows.get(m.id)!)]);
    place(numberRow,[numberCorner,...cameras.map(row=>numberHeads.get(row.id)!)]);
    for(const [index,row]of cameras.entries()){const number=numberHeads.get(row.id)!;number.textContent=String(index+1);number.setAttribute('aria-label',valueOf(row,'camera-name'));}
    for(const m of frozenMeta){const row=identityRows.get(m.id)!;place(row,[labelHeads.get(m.id)!,...cameraCells(m.id)]);row.style.height=heightOf(m.id);}
    const list=visibleFields(v),bodyRows:HTMLElement[]=[];
    if(shownLogin().length){
      loginFiller.colSpan=Math.max(1,cameras.length);place(loginSection,cameras.length?[loginHeader,loginFiller]:[loginHeader]);bodyRows.push(loginSection);
      for(const m of shownLogin()){const row=settingRow(m.id);place(row,[labelHeads.get(m.id)!,...cameraCells(m.id)]);row.style.height=heightOf(m.id);bodyRows.push(row);for(const cell of cameraCells(m.id)){cell.style.left='';cell.style.top='';}}
    }
    for(const id of orderedGroups().filter(id=>!v.hiddenGroups?.includes(id))){
      const section=sectionRows.get(id)!,th=groupHeaders.get(id)!;
      th.scope='rowgroup';th.hidden=false;th.colSpan=1;section.filler.colSpan=Math.max(1,cameras.length);
      place(section.row,cameras.length?[th,section.filler]:[th]);bodyRows.push(section.row);groupControls.get(id)?.refresh();
      for(const field of list.filter(f=>f.group===id)){
        const row=settingRow(field.id);place(row,[labelHeads.get(field.id)!,...cameraCells(field.id)]);row.style.height=heightOf(field.id);bodyRows.push(row);
      }
    }
    place(body,bodyRows);
    // The names and addresses stay on screen the way their columns do with cameras in rows.
    let top=0;
    for(const row of [numberRow,...frozenMeta.map(m=>identityRows.get(m.id)!)]){
      for(const cell of row.cells){cell.style.top=top+'px';cell.style.left=cell.classList.contains('setting-label')?'0px':'';}
      top+=row.offsetHeight;
    }
  }
  function followSelection(){
    if(!active||!currentRow(active.rowId))return;
    const shownOnTab=[...frozenMeta,...shownLogin()].some(m=>m.id===active!.columnId)||visibleFields(view()).some(f=>f.id===active!.columnId);
    controls.select(position(shownOnTab?active:{rowId:active.rowId,columnId:'camera-name'}),undefined,{focus:false});
  }
  function render(){
    if(disposed)return;
    table.style.setProperty('--camera-text-size',(view().textSize??13)+'px');
    const flip=flipped();
    table.dataset.orientation=flip?'columns':'rows';
    const ids=new Set(store.document.cameras.map(row=>row.id));
    for(const [id,element]of rows)if(!ids.has(id)){element.remove();rows.delete(id);for(const columnId of allColumnIds){cells.get(id+'/'+columnId)?.remove();cells.delete(id+'/'+columnId);}for(const placeholder of placeholders.values())placeholder.cells.delete(id);cameraTracks.get(id)?.remove();cameraTracks.delete(id);numberHeads.get(id)?.remove();numberHeads.delete(id);}
    for(const row of store.document.cameras)ensureCamera(row);
    if(flip)layoutColumns();else layoutRows();
    const visible=new Set(visibleFields(view()).map(f=>f.id)),orderedIds=[...meta.map(m=>m.id),...orderedFields().map(f=>f.id)];
    for(const row of store.document.cameras){
      for(const id of orderedIds){
        const cell=cells.get(row.id+'/'+id)!,address={rowId:row.id,columnId:id};
        cell.dataset.hubbleRow=flip?id:row.id;cell.dataset.hubbleColumn=flip?row.id:id;
        cell.hidden=fieldById.has(id)?!visible.has(id):isLoginField(id)&&!loginVisible(view(),id);if(cell===editor?.cell)continue;
        const field=cellValue(address),invalid=store.invalid.get(addressKey(address)),definition=fieldById.get(id),obs=observation(row);
        cell.setAttribute('aria-readonly',String(!field||!!field.readOnly));
        cell.toggleAttribute('aria-invalid',!!invalid);if(invalid)cell.setAttribute('aria-invalid','true');
        cell.title=invalid?.message??obs?.errors[id]??(definition?definition.note:'');
        cell.setAttribute('aria-label',(settingLabel(id)??id)+(flip?' for '+valueOf(row,'camera-name'):'')+(invalid?': '+invalid.message:''));
        const pending=!!definition&&isOnline(row)&&!!row.values[id]&&row.values[id]!==obs?.values[id];
        cell.dataset.pending=String(pending);cell.dataset.sending=String(obs?.sending.includes(id)??false);cell.dataset.failed=String(pending&&!!obs?.errors[id]);
        if(field?.kind==='boolean'&&!invalid){delete cell.dataset.empty;if(!cell.firstElementChild?.hasAttribute('data-hubble-boolean')){const slot=document.createElement('span');slot.setAttribute('data-hubble-boolean','');cell.replaceChildren(slot);}continue;}
        const labels=definition?getChoices(row,definition):[];
        cell.textContent=invalid?.edit.value??labels.find(c=>c.value===field?.value)?.label??field?.value??'';
        if(!cell.textContent&&!field?.readOnly)cell.dataset.empty='true';else delete cell.dataset.empty;
        if(id==='connection-status')cell.dataset.connection=obs?.live?'live':obs?.state??'offline';
        if(id==='recording-status')cell.dataset.recording=isOnline(row)?obs?.recording??'':'';
      }
    }
    controls.refresh();resize?.refresh();reorder?.refresh();columnEditor.refresh();
    const nowShowing=activeSheetId(store.document)+'/'+table.dataset.orientation;
    if(nowShowing!==shownLayout){shownLayout=nowShowing;followSelection();}
  }
  const unsubscribe=store.subscribe(render);
  render();
  return {refresh:render,select:(address:SpreadsheetAddress)=>controls.select(position(address)),get active(){return active;},get editing(){return editor?.address;},getValue:(address:SpreadsheetAddress)=>cellValue(address),dispose(){disposed=true;unsubscribe();for(const control of controlsToDispose.reverse())control.dispose();}};
}
