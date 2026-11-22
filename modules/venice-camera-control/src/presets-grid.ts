import {
  mountSpreadsheetControls,mountSpreadsheetColumnGroup,mountSpreadsheetColumnEditor,createSpreadsheetContextMenu,mountSpreadsheetResize,mountSpreadsheetViewport,
  type SpreadsheetAddress,type SpreadsheetCell,type SpreadsheetColumnGroup,type SpreadsheetColumnGroupControls,type SpreadsheetEdit,type SpreadsheetMenuItem
} from '@hubble/module-sdk/spreadsheet-controls';
import { groups,fieldById,clone,visibleFields,withColumnVisibility,withNoColumns,type View,type Field } from './model.js';
import { nameRowId,holdsRowId,isPresetField,isBase,presetById,resolvedValues,roleFieldIds,heldCount,heldFieldIds,type PlannedSend,type PresetDocument,type PresetEdit,type PresetMutation } from './presets-model.js';
import type { Drafts } from './draft-store.js';
import type { CameraSummary,Observation,PresetSend } from './backend.js';

export const cameraColumnId='camera-now';
export interface Chosen { presetId?:string; camera?:CameraSummary; observation?:Observation; job?:PresetSend; plan?:PlannedSend }
export interface PresetGridOptions {
  table:HTMLTableElement; viewport:HTMLElement; columnEditor:HTMLElement;
  store:Drafts<PresetDocument,PresetMutation>;
  chosen:()=>Chosen;
  /** The values a setting can take: the module's own list, or what the cameras report. */
  choices:(field:Field)=>{value:string;label:string}[];
  onSelect:(address:SpreadsheetAddress|undefined)=>void;
  onZoom?:(ratio:number)=>void;
  onError:(message:string)=>void;
  onChoosePreset:(presetId:string)=>void;
  onDuplicate:(presetId:string)=>void;
  onRemove:(presetId:string)=>void;
  onRefreshCamera:()=>void;
}
const labelWidthId='setting-names',defaultLabelWidth=220,defaultPresetWidth=150,defaultCameraWidth=230,defaultRowHeight=36;
const onOff=[{value:'TRUE',label:'On'},{value:'FALSE',label:'Off'}];
const addressKey=(a:SpreadsheetAddress)=>a.rowId+'/'+a.columnId;
const recordingLabel:Record<string,string>={recording:'● REC',standby:'STBY',starting:'Starting'};

// Every address is {rowId: setting (or the name and holds rows), columnId: preset, or the camera column}.
export async function createPresetGrid(options:PresetGridOptions){
  const {table,viewport,store}=options;
  const tracks=table.querySelector('colgroup')!,head=table.createTHead(),body=table.createTBody();
  const labelTrack=document.createElement('col'),columnTracks=new Map<string,HTMLTableColElement>();
  const numberRow=document.createElement('tr'),numberCorner=document.createElement('th'),numberHeads=new Map<string,HTMLTableCellElement>();
  numberCorner.scope='col';numberCorner.className='setting-label number-corner';numberCorner.setAttribute('aria-label','Setting names');
  const rows=new Map<string,HTMLTableRowElement>(),labels=new Map<string,HTMLTableCellElement>(),cells=new Map<string,HTMLTableCellElement>();
  const sections=new Map<string,{row:HTMLTableRowElement;header:HTMLTableCellElement;filler:HTMLTableCellElement;controls?:SpreadsheetColumnGroupControls}>();
  const providers=new Map<string,{signature:string;provider:(query:string,signal:AbortSignal)=>Promise<{value:string;label:string;group?:string}[]>}>();
  const disposers:{dispose():void}[]=[];
  let active:SpreadsheetAddress|undefined,editor:{address:SpreadsheetAddress;cell:HTMLTableCellElement;input:HTMLInputElement;expected:string}|undefined,disposed=false,zoomRatio=1;
  const doc=()=>store.document,view=()=>doc().view;
  const columnIds=()=>[...doc().presets.map(p=>p.id),cameraColumnId];
  // Only settings some preset holds exist here: what a camera reported when it was captured, and what a role sets.
  // A setting no camera reported can't be sent, so it has no row, no section and no place in Columns.
  const allGroups=()=>[...view().order,...groups.map(g=>g.id).filter(id=>!view().order.includes(id))];
  const orderedFields=(groupId:string)=>{const group=groups.find(g=>g.id===groupId)!,held=heldFieldIds(doc());return [...(view().fields[groupId]??[]),...group.fields.map(f=>f.id).filter(id=>!view().fields[groupId]?.includes(id))].map(id=>fieldById.get(id)!).filter(f=>isPresetField(f.id)&&held.has(f.id));};
  const orderedGroups=()=>allGroups().filter(id=>!view().hiddenGroups?.includes(id)&&orderedFields(id).length>0);
  /** Folded sections show their chosen settings, plus anything a role changes, so a role's differences never hide. */
  function shownFields(groupId:string):Field[]{
    const visible=new Set(visibleFields(view()).map(f=>f.id)),roles=roleFieldIds(doc());
    return orderedFields(groupId).filter(f=>visible.has(f.id)||(roles.has(f.id)&&!view().hidden.includes(f.id)));
  }
  const shownRows=()=>orderedGroups().flatMap(id=>shownFields(id).map(f=>f.id));
  /** The values a setting can take: what the camera allowed when it was captured, else the module's own list or what cameras report now. */
  function choicesOf(field:Field):{value:string;label:string}[]{
    if(field.kind==='boolean'){const offered=doc().offered?.[field.id];return offered?onOff.filter(c=>offered.includes(c.value)):onOff;}
    const offered=doc().offered?.[field.id];
    if(offered?.length)return offered.map(value=>({value,label:field.choices.find(c=>c.value===value)?.label??value}));
    return options.choices(field);
  }
  const label=(field:Field,value:string)=>field.kind==='boolean'?(value==='TRUE'?'On':value==='FALSE'?'Off':value):field.choices.find(c=>c.value===value)?.label??choicesOf(field).find(c=>c.value===value)?.label??value;
  const widthOf=(id:string)=>view().cameraWidths?.[id]??(id===cameraColumnId?defaultCameraWidth:defaultPresetWidth);
  const holdsText=(id:string)=>{const preset=presetById(doc(),id)!,count=heldCount(preset);return isBase(preset)?(count?count+' setting'+(count===1?'':'s'):'Empty'):count+' own';};

  function cameraCell(rowId:string):{text:string;html?:string;marks:Record<string,string>;title:string}{
    const {camera,observation:obs,presetId,job,plan}=options.chosen(),marks:Record<string,string>={};
    if(rowId===nameRowId)return {text:camera?camera.name+' now':'No camera chosen',marks,title:camera?.host??''};
    const online=obs?.state==='online';
    if(rowId===holdsRowId){
      if(!camera)return {text:'',marks,title:''};
      marks.connection=obs?.live?'live':obs?.state??'offline';if(online&&obs?.recording)marks.recording=obs.recording;
      const text=!obs?'Not read':online?(obs.recording==='recording'?recordingLabel.recording!:obs.live?'Live':'Ready'):obs.state==='error'?'Read failed':'Offline';
      return {text,marks,title:obs?.errors['connection-status']??''};
    }
    const field=fieldById.get(rowId);
    if(!field||!camera||!online)return {text:'',marks,title:''};
    const now=obs!.values[rowId]??'',target=presetId?resolvedValues(doc(),presetId)[rowId]??'':'';
    const failed=job?.presetId===presetId?job?.failed.find(f=>f.fieldId===rowId):undefined,skipped=plan?.skipped.find(s=>s.id===rowId);
    if(obs!.sending.includes(rowId))marks.sending='true';
    if(failed){marks.pending='true';marks.failed='true';return {text:label(field,now)+' → '+label(field,target),marks,title:failed.message};}
    if(plan?.send.some(s=>s.id===rowId)){
      marks.pending='true';
      const html='<span class="was"></span><span class="arrow">→</span><span class="to"></span>';
      return {text:label(field,now)+' → '+label(field,target),html,marks,title:'Sending '+(presetById(doc(),presetId!)?.name??'')+' changes this'};
    }
    if(skipped&&now){marks.skip='true';return {text:label(field,now)+' · '+label(field,target)+' not offered',marks,title:skipped.reason};}
    if(target&&now)marks.match='true';
    return {text:now?label(field,now):'',marks,title:skipped?.reason??''};
  }
  function cellValue(address:SpreadsheetAddress):SpreadsheetCell|null{
    if(address.columnId===cameraColumnId)return {value:cameraCell(address.rowId).text,readOnly:true};
    const preset=presetById(doc(),address.columnId);if(!preset)return null;
    if(address.rowId===nameRowId)return isBase(preset)?{value:preset.name,readOnly:true}:{value:preset.name};
    if(address.rowId===holdsRowId)return {value:holdsText(preset.id),readOnly:true};
    const field=fieldById.get(address.rowId);if(!field||!isPresetField(field.id))return null;
    const value=preset.values[field.id]??'',list=choicesOf(field);
    if(!list.length)return {value};
    const key=addressKey(address),signature=JSON.stringify(list);
    if(providers.get(key)?.signature!==signature)providers.set(key,{signature,provider:async(query,signal)=>{
      signal.throwIfAborted();const words=query.toLowerCase().split(/\s+/);
      return list.filter(c=>words.every(w=>(c.label+' '+c.value).toLowerCase().includes(w))).map(c=>({...c,group:groups.find(g=>g.id===field.group)!.label}));
    }});
    return {value,choices:providers.get(key)!.provider};
  }
  function submit(edits:readonly SpreadsheetEdit[],expected?:string):boolean{
    const changes:PresetEdit[]=edits.flatMap(edit=>{
      const preset=presetById(doc(),edit.columnId),cell=cellValue(edit);
      if(!preset||!cell||cell.readOnly||edit.rowId===holdsRowId)return [];
      // Delete on a name means nothing: a preset always has one.
      if(edit.rowId===nameRowId){const value=edit.value.trim();return value?[{rowId:edit.rowId,columnId:edit.columnId,value,expected:expected??preset.name}]:[];}
      return [{rowId:edit.rowId,columnId:edit.columnId,value:edit.value,expected:expected??preset.values[edit.rowId]??''}];
    }).filter(edit=>edit.value!==edit.expected);
    if(!changes.length)return true;
    return store.submit({kind:'edit',edits:changes});
  }
  const controls=await mountSpreadsheetControls({
    root:table,viewport,extendedEditing:true,workbookEditing:true,
    getRows:()=>[nameRowId,holdsRowId,...shownRows()],
    getColumns:()=>[...doc().presets.map(p=>({id:p.id,label:p.name,fill:'copy' as const})),{id:cameraColumnId,label:'Camera now',fill:'copy' as const}],
    getCell:address=>cellValue(address),onEdit:batch=>{submit(batch.edits);},
    onSelection(address){active=address;options.onSelect(address);},
    onHistory(direction){if(active&&store.invalid.has(addressKey(active))){store.discard(active.rowId,active.columnId);return;}store.history(direction==='redo');},
    onError:error=>options.onError(error.message)
  });disposers.push(controls);
  function layout(next:View){store.submit({kind:'view',view:next,expected:clone(view())});}
  function groupDescriptor(id:string):SpreadsheetColumnGroup{
    const group=groups.find(g=>g.id===id)!;
    // The host needs at least one field per section. A section nothing holds isn't drawn, so its header keeps the whole list.
    const fields=orderedFields(id).length?orderedFields(id):group.fields.filter(f=>isPresetField(f.id)),ids=new Set(fields.map(f=>f.id));
    return {id,label:group.label,columns:fields.map(f=>({id:f.id,label:f.label,fill:'copy'})),expanded:!!view().expanded[id],collapsedColumnIds:(view().collapsed[id]??group.collapsed).filter(fieldId=>ids.has(fieldId))};
  }
  for(const group of groups){
    const row=document.createElement('tr'),header=document.createElement('th'),filler=document.createElement('td'),slot=document.createElement('div');
    row.className='setting-section';header.scope='rowgroup';header.className='setting-group';header.dataset.groupId=group.id;header.append(slot);filler.className='section-filler';filler.setAttribute('aria-hidden','true');
    row.append(header,filler);
    const entry:{row:HTMLTableRowElement;header:HTMLTableCellElement;filler:HTMLTableCellElement;controls?:SpreadsheetColumnGroupControls}={row,header,filler};sections.set(group.id,entry);
    entry.controls=await mountSpreadsheetColumnGroup({root:slot,getGroup:()=>groupDescriptor(group.id),onChange(next){
      const v=clone(view());v.expanded[group.id]=next.expanded;v.collapsed[group.id]=[...next.collapsedColumnIds];v.fields[group.id]=next.columns.map(c=>c.id);layout(v);
    },onError:error=>options.onError(error.message)});disposers.push(entry.controls);
  }
  const hideAllId='hide-all-settings';
  const columnEditor=await mountSpreadsheetColumnEditor({
    root:options.columnEditor,
    getItems:()=>[{id:hideAllId,label:'Hide all settings',visible:groups.some(g=>!view().hiddenGroups?.includes(g.id))},...allGroups().filter(id=>orderedFields(id).length>0).map(id=>{
      const group=groups.find(g=>g.id===id)!,visible=new Set(visibleFields({...view(),hiddenGroups:[]}).map(f=>f.id));
      return {id,label:group.label,visible:!view().hiddenGroups?.includes(id),fields:orderedFields(id).map(f=>({id:f.id,label:f.label,visible:visible.has(f.id)}))};
    })],
    onVisibilityChange:(id,visible)=>setVisibility([{id,visible}]),
    onVisibilityChanges:setVisibility
  });disposers.push(columnEditor);
  function setVisibility(changes:readonly {id:string;visible:boolean}[]){
    const all=changes.find(change=>change.id===hideAllId);
    if(all){if(all.visible){columnEditor.refresh();return;}layout(withNoColumns(view()));return;}
    layout(withColumnVisibility(view(),changes));
  }
  const menu=await createSpreadsheetContextMenu({root:table,onError:error=>options.onError(error.message)});disposers.push(menu);
  table.addEventListener('contextmenu',event=>{
    const target=(event.target as Element).closest<HTMLTableCellElement>('td,th');if(!target)return;
    const columnId=target.dataset.columnId,rowId=target.dataset.rowId??target.dataset.settingLabel;
    let items:SpreadsheetMenuItem[]=[],title='';
    if(columnId===cameraColumnId){title=options.chosen().camera?.name??'Camera';items=[{id:'refresh',label:'Refresh camera',disabled:!options.chosen().camera,run:options.onRefreshCamera}];}
    else if(columnId){
      const preset=presetById(doc(),columnId);if(!preset)return;title=preset.name;
      const field=rowId?fieldById.get(rowId):undefined,own=field?preset.values[field.id]:undefined;
      items=[
        {id:'choose',label:'Send this preset',run:()=>options.onChoosePreset(preset.id)},
        ...(field&&!isBase(preset)?[{id:'inherit',label:'Use Base for '+field.label,disabled:own===undefined,run:()=>{store.submit({kind:'edit',edits:[{rowId:field.id,columnId:preset.id,value:'',expected:own!}]});}}]:[]),
        {id:'duplicate',label:'Duplicate preset',icon:'add',run:()=>options.onDuplicate(preset.id)},
        {separator:true},
        {id:'remove',label:isBase(preset)?'Base can’t be removed':'Remove '+preset.name,icon:'delete',danger:true,disabled:isBase(preset),run:()=>options.onRemove(preset.id)}
      ];
    } else if(rowId&&fieldById.has(rowId)){
      const field=fieldById.get(rowId)!;title=field.label;items=[{id:'hide',label:'Hide '+field.label,run:()=>setVisibility([{id:field.id,visible:false}])}];
    }
    if(!items.length)return;
    event.preventDefault();menu.open({x:event.clientX,y:event.clientY,label:title,items});
  });
  const resize=await mountSpreadsheetResize({
    root:table,viewport,getScale:()=>zoomRatio,
    getItems:()=>[
      {id:labelWidthId,label:'setting names',axis:'column' as const,header:numberCorner,size:view().settingLabelWidth??defaultLabelWidth,min:120,max:800},
      ...columnIds().filter(id=>numberHeads.has(id)).map(id=>({id,label:id===cameraColumnId?'camera':presetById(doc(),id)?.name??id,axis:'column' as const,header:numberHeads.get(id)!,size:widthOf(id),min:96,max:800}))
    ],
    onResize(item,size){const next=clone(view());if(item.id===labelWidthId)next.settingLabelWidth=size;else (next.cameraWidths??={})[item.id]=size;layout(next);}
  });disposers.push(resize);
  const viewportControls=await mountSpreadsheetViewport({root:table,viewport,onZoom(ratio){zoomRatio=ratio;controls.refresh();resize.refresh();options.onZoom?.(ratio);}});disposers.push(viewportControls);

  function startEdit(cell:HTMLTableCellElement,initial?:string){
    const rowId=cell.dataset.rowId,columnId=cell.dataset.columnId;if(!rowId||!columnId)return false;
    const address={rowId,columnId},value=cellValue(address);
    if(!value||value.readOnly||value.choices)return false;
    const input=document.createElement('input');input.className='cell-input';input.setAttribute('aria-label','Edit '+(rowId===nameRowId?'preset name':fieldById.get(rowId)?.label??'cell'));
    input.value=initial??store.invalid.get(addressKey(address))?.edit.value??value.value;
    const current={address,cell,input,expected:value.value};editor=current;
    const startedWith=value.value,retrying=store.invalid.has(addressKey(address));
    const finish=(commit:boolean,focus:boolean)=>{
      if(editor!==current)return;editor=undefined;
      if(commit&&(retrying||input.value!==startedWith))submit([{...address,value:input.value}],current.expected);
      render();if(focus)controls.select(address);
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

  function place(parent:HTMLElement,nodes:HTMLElement[]){for(let i=0;i<nodes.length;i++)if(parent.children[i]!==nodes[i])parent.insertBefore(nodes[i]!,parent.children[i]??null);while(parent.children.length>nodes.length)parent.lastElementChild!.remove();}
  function rowFor(id:string){let row=rows.get(id);if(!row){row=document.createElement('tr');row.dataset.settingId=id;rows.set(id,row);}return row;}
  function labelFor(id:string,text:string){let th=labels.get(id);if(!th){th=document.createElement('th');th.scope='row';th.className='setting-label';th.tabIndex=0;th.dataset.settingLabel=id;labels.set(id,th);}if(th.textContent!==text)th.textContent=text;return th;}
  function cellFor(rowId:string,columnId:string){
    const key=rowId+'/'+columnId;let cell=cells.get(key);
    if(!cell){cell=document.createElement('td');cell.setAttribute('role','gridcell');cell.dataset.rowId=rowId;cell.dataset.columnId=columnId;cell.dataset.hubbleRow=rowId;cell.dataset.hubbleColumn=columnId;cells.set(key,cell);}
    return cell;
  }
  function paint(cell:HTMLTableCellElement,address:SpreadsheetAddress){
    if(cell===editor?.cell)return;
    const {presetId}=options.chosen(),chosen=address.columnId===presetId;
    const invalid=store.invalid.get(addressKey(address)),value=cellValue(address);
    cell.dataset.chosen=String(chosen);cell.dataset.cameraColumn=String(address.columnId===cameraColumnId);
    cell.setAttribute('aria-readonly',String(!value||!!value.readOnly));
    cell.toggleAttribute('aria-invalid',!!invalid);if(invalid)cell.setAttribute('aria-invalid','true');
    for(const mark of ['pending','sending','failed','skip','match','connection','recording','held','presetName'])delete cell.dataset[mark];
    if(address.columnId===cameraColumnId){
      const shown=cameraCell(address.rowId);
      Object.assign(cell.dataset,shown.marks);cell.title=shown.title;
      if(shown.html){cell.innerHTML=shown.html;const [now,target]=shown.text.split(' → ');cell.querySelector('.was')!.textContent=now!;cell.querySelector('.to')!.textContent=target!;}
      else cell.textContent=shown.text;
      if(!shown.text)cell.dataset.empty='true';else delete cell.dataset.empty;
      return;
    }
    const preset=presetById(doc(),address.columnId)!;
    if(address.rowId===nameRowId){cell.dataset.presetName=preset.id;cell.textContent=invalid?.edit.value??preset.name;cell.title=invalid?.message??(isBase(preset)?'Base holds a whole camera. Every other preset starts from it.':'');delete cell.dataset.empty;return;}
    if(address.rowId===holdsRowId){cell.textContent=holdsText(preset.id);cell.title='';delete cell.dataset.empty;return;}
    const field=fieldById.get(address.rowId)!,own=preset.values[field.id],inherited=isBase(preset)?undefined:doc().presets[0]!.values[field.id];
    const shown=invalid?.edit.value??own??inherited??'';
    cell.dataset.held=invalid||own!==undefined?(isBase(preset)?'base':'own'):inherited!==undefined?'inherited':'';
    cell.textContent=shown?label(field,shown):'';
    cell.title=invalid?.message??(own===undefined&&inherited!==undefined?'From Base. Type a value to give '+preset.name+' its own.':field.note);
    if(!cell.textContent)cell.dataset.empty='true';else delete cell.dataset.empty;
  }
  function render(){
    if(disposed)return;
    table.style.setProperty('--camera-text-size',(view().textSize??13)+'px');
    const columns=columnIds(),presets=doc().presets;
    // Tracks and the number row.
    for(const id of [...columnTracks.keys()])if(!columns.includes(id)){columnTracks.get(id)!.remove();columnTracks.delete(id);numberHeads.get(id)?.remove();numberHeads.delete(id);for(const [key,cell]of cells)if(key.endsWith('/'+id)){cell.remove();cells.delete(key);}}
    for(const id of columns){
      if(!columnTracks.has(id))columnTracks.set(id,document.createElement('col'));
      if(!numberHeads.has(id)){const th=document.createElement('th');th.scope='col';th.className='column-number';th.dataset.columnId=id;numberHeads.set(id,th);}
    }
    const labelWidth=view().settingLabelWidth??defaultLabelWidth;
    place(tracks,[labelTrack,...columns.map(id=>columnTracks.get(id)!)]);
    labelTrack.style.width=labelWidth+'px';let width=labelWidth;
    for(const id of columns){const w=widthOf(id);columnTracks.get(id)!.style.width=w+'px';width+=w;}
    table.style.width=width+'px';
    place(numberRow,[numberCorner,...columns.map(id=>numberHeads.get(id)!)]);
    columns.forEach((id,index)=>{const th=numberHeads.get(id)!;th.textContent=id===cameraColumnId?'Camera':String(index+1);th.dataset.chosen=String(id===options.chosen().presetId);th.dataset.cameraColumn=String(id===cameraColumnId);th.setAttribute('aria-label',id===cameraColumnId?'Camera now':presets[index]!.name);});
    // Names and what each holds stay at the top as the sheet scrolls.
    // The name and holds rows stay pinned like Camera Control's camera names, so their cells are sticky too.
    const headRows=[nameRowId,holdsRowId].map(id=>{const row=rowFor(id);const rowCells=columns.map(c=>cellFor(id,c));for(const cell of rowCells)cell.classList.add('identity-column');place(row,[labelFor(id,id===nameRowId?'Preset':'Holds'),...rowCells]);return row;});
    place(head,[numberRow,...headRows]);
    const bodyRows:HTMLElement[]=[];
    for(const id of orderedGroups()){
      const section=sections.get(id)!;section.filler.colSpan=columns.length;bodyRows.push(section.row);section.controls?.refresh();
      for(const field of shownFields(id)){const row=rowFor(field.id);place(row,[labelFor(field.id,field.label),...columns.map(c=>cellFor(field.id,c))]);row.style.height=(view().settingHeights?.[field.id]??defaultRowHeight)+'px';bodyRows.push(row);}
    }
    place(body,bodyRows);
    for(const row of [...headRows,...bodyRows])for(const cell of (row as HTMLTableRowElement).cells)if(cell.tagName==='TD'&&cell.dataset.rowId)paint(cell as HTMLTableCellElement,{rowId:cell.dataset.rowId,columnId:cell.dataset.columnId!});
    let top=0;
    for(const row of [numberRow,...headRows]){for(const cell of row.cells){cell.style.top=top+'px';cell.style.left=cell.classList.contains('setting-label')?'0px':'';}top+=row.offsetHeight;}
    for(const row of bodyRows)for(const cell of (row as HTMLTableRowElement).cells){cell.style.top='';}
    controls.refresh();resize.refresh();columnEditor.refresh();
  }
  const unsubscribe=store.subscribe(render);
  render();
  return {
    refresh:render,
    select:(address:SpreadsheetAddress)=>controls.select(address),
    get active(){return active;},
    get editing(){return editor?.address;},
    dispose(){disposed=true;unsubscribe();for(const item of disposers.reverse())item.dispose();}
  };
}
