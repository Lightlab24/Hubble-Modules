import rawGroups from './control-definitions.json' with { type: 'json' };
export interface Choice { value: string; label: string; wire: string }
export interface Field { id: string; label: string; property: string; group: string; kind: 'text'|'number'|'choice'|'boolean'; choices: Choice[]; verified: boolean; note: string; source: string; encoding: string; width: number }
export interface Group { id: string; label: string; fields: Field[]; collapsed: string[] }
export const groups = rawGroups as Group[];
export const fields = groups.flatMap(g => g.fields);
export const fieldById = new Map(fields.map(f => [f.id, f]));
export const metaFields = ['camera-name', 'camera-host'] as const;
export const loginFields = ['camera-username', 'camera-password'] as const;
export const maxCameras = 24;
export interface Camera { id: string; values: Record<string,string> }
export interface View { expanded: Record<string,boolean>; collapsed: Record<string,string[]>; order: string[]; fields: Record<string,string[]>; hidden: string[]; hiddenGroups?: string[]; hiddenLogin?: string[]; textSize?: number; widths: Record<string,number>; rowHeights: Record<string,number>; cameraWidths?: Record<string,number>; settingHeights?: Record<string,number>; settingLabelWidth?: number }
export type Orientation = 'rows'|'columns';
/** A tab is a saved way of looking at the cameras. The open tab's layout is `document.view`. */
export interface CameraSheet { id: string; name: string; orientation: Orientation; view?: View }
export type FullSheet = CameraSheet & { view: View };
/** What this Mac is told when a camera stops or starts answering. Every choice starts off. */
export interface AlertChoices { offlineNotification: boolean; offlineBounce: boolean; onlineNotification: boolean }
export const noAlerts:AlertChoices={offlineNotification:false,offlineBounce:false,onlineNotification:false};
/** `live`: the worker holds a connection to every reachable camera until the operator switches Live off, whether or not the page is open.
 *  `autoSend`: a committed edit goes to its camera as soon as it saves. Both stay as set until switched back. */
export interface CameraDocument { version: 1; cameras: Camera[]; view: View; sheets?: CameraSheet[]; activeSheetId?: string; alerts?: AlertChoices; live?: boolean; autoSend?: boolean }
export interface CellEdit { rowId: string; columnId: string; value: string; expected: string }
export type Mutation = { kind:'edit'; edits:CellEdit[] } | {kind:'view'; view:View; expected:View; sheetId?:string} | {kind:'select-sheet'; sheetId:string} | {kind:'sheets'; sheets:FullSheet[]; expected:FullSheet[]; activeSheetId?:string} | {kind:'cameras'; add:Camera[]; remove:Camera[]} | {kind:'add'; camera:Camera} | {kind:'remove'; camera:Camera} | {kind:'alerts'; alerts:AlertChoices; expected:AlertChoices} | {kind:'live'; live:boolean; expected:boolean} | {kind:'auto-send'; autoSend:boolean; expected:boolean};
export const clone = <T>(value:T):T => structuredClone(value);
const sortedKeys = (value:unknown):unknown => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,sortedKeys(item)])) : value;
export const same = (a:unknown,b:unknown):boolean => JSON.stringify(sortedKeys(a))===JSON.stringify(sortedKeys(b));
export const valueOf = (row:Camera,columnId:string):string => row.values[columnId] ?? '';
export function validHost(value:string):boolean {
  const match=/^([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if(!match || (match[2] && (+match[2]<1 || +match[2]>65535)))return false;
  const host=match[1]!;
  if(host.length>253 || host.includes('..') || host.startsWith('.') || host.endsWith('.'))return false;
  if(/^[0-9.]+$/.test(host))return host.split('.').length===4 && host.split('.').every(n=>/^\d{1,3}$/.test(n)&&+n<=255);
  return host.split('.').every(n=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(n));
}
export function validateValue(columnId:string,value:string):string|undefined {
  if(typeof value!=='string'||value.length>512)return 'Enter up to 512 characters.';
  if(columnId==='camera-name')return value.trim() && value.length<=96 ? undefined : 'Enter a camera name.';
  if(columnId==='camera-host')return !value||validHost(value) ? undefined : 'Enter a valid hostname or IPv4 address.';
  if(columnId==='camera-username')return value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value) ? undefined : 'Enter a username of up to 256 characters.';
  if(columnId==='camera-password')return /[\u0000-\u001f\u007f]/.test(value) ? 'A password cannot contain control characters.' : undefined;
  const field=fieldById.get(columnId);
  if(!field)return 'This field is not editable.';
  if(!value)return undefined;
  if(field.kind==='boolean')return ['TRUE','FALSE'].includes(value)?undefined:'Choose On or Off.';
  if(field.choices.length && !field.choices.some(c=>c.value===value))return 'Choose a value from the camera setting list.';
  if(field.kind==='number' && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value))))return 'Enter a finite number.';
  if(field.property==='P.System.Menu.ClipnamingReelNum' && (!/^\d+$/.test(value)||+value<1||+value>999))return 'Use a reel number from 1 to 999 for this initial profile.';
  return undefined;
}
export function defaultDocument():CameraDocument {
  return {version:1,cameras:[{id:'venice-tested-body',values:{'camera-name':'VENICE 2 test','camera-host':'192.0.2.109'}}],view:{expanded:{},collapsed:Object.fromEntries(groups.map(g=>[g.id,[]])),order:groups.map(g=>g.id),fields:{},hidden:[],hiddenGroups:[],textSize:13,widths:{},rowHeights:{}}};
}
export const isLoginField=(id:string):boolean=>(loginFields as readonly string[]).includes(id);
export const loginVisible=(view:View,id:string):boolean=>!view.hiddenLogin?.includes('login')&&!view.hiddenLogin?.includes(id);
/** Adds blank rows or takes them off the end, as one undo step. */
export function setCameraCount(doc:CameraDocument,count:number,newId:()=>string):Extract<Mutation,{kind:'cameras'}>|null {
  if(!Number.isInteger(count)||count<0||count>maxCameras)throw Error('Use from 0 to '+maxCameras+' cameras.');
  const have=doc.cameras.length;
  if(count===have)return null;
  if(count<have)return {kind:'cameras',add:[],remove:clone(doc.cameras.slice(count))};
  return {kind:'cameras',remove:[],add:Array.from({length:count-have},(_,index)=>({id:newId(),values:{'camera-name':'Camera '+(have+index+1),'camera-host':''}}))};
}
/** A row someone has only counted, not filled in, can go without asking. */
export const cameraHasData=(camera:Camera):boolean=>Object.entries(camera.values).some(([id,value])=>!!value&&(id!=='camera-name'||!/^Camera \d+$/.test(value)));
export function validateView(view:View):void {
  if(!view || !Array.isArray(view.order) || !Array.isArray(view.hidden))throw Error('Invalid column layout.');
  if(view.textSize!==undefined&&(!Number.isInteger(view.textSize)||view.textSize<9||view.textSize>24))throw Error('Use a text size from 9 to 24.');
  const groupIds=new Set(groups.map(g=>g.id));
  if(view.hiddenGroups!==undefined&&(!Array.isArray(view.hiddenGroups)||new Set(view.hiddenGroups).size!==view.hiddenGroups.length||view.hiddenGroups.some(id=>!groupIds.has(id))))throw Error('Unknown hidden column group.');
  if(new Set(view.order).size!==view.order.length||view.order.some(id=>!groupIds.has(id)))throw Error('Unknown column group.');
  for(const id of view.hidden)if(!fieldById.has(id))throw Error('Unknown hidden column.');
  if(view.hiddenLogin!==undefined&&(!Array.isArray(view.hiddenLogin)||new Set(view.hiddenLogin).size!==view.hiddenLogin.length||view.hiddenLogin.some(id=>id!=='login'&&!isLoginField(id))))throw Error('Unknown hidden login column.');
  for(const [id,width]of Object.entries(view.widths))if(!fieldById.has(id)&&!metaFields.includes(id as typeof metaFields[number])&&!isLoginField(id)||!Number.isFinite(width)||width<72||width>800)throw Error('Invalid column width.');
  const size=(value:unknown,least:number,most:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=least&&value<=most;
  for(const width of Object.values(view.cameraWidths??{}))if(!size(width,72,800))throw Error('Invalid camera width.');
  for(const [id,height]of Object.entries(view.settingHeights??{}))if(!fieldById.has(id)&&!metaFields.includes(id as typeof metaFields[number])&&id!=='connection-status'&&!isLoginField(id)||!size(height,28,200))throw Error('Invalid setting height.');
  if(view.settingLabelWidth!==undefined&&!size(view.settingLabelWidth,120,800))throw Error('Invalid setting name width.');
  for(const group of groups) {
    const ids=group.fields.map(f=>f.id), compact=view.collapsed[group.id]??group.collapsed, order=view.fields[group.id]??ids;
    if(new Set(compact).size!==compact.length || compact.some(id=>!ids.includes(id)))throw Error('Invalid collapsed fields.');
    if(new Set(order).size!==order.length||order.some(id=>!ids.includes(id)))throw Error('Invalid field order.');
  }
}
const firstSheet:CameraSheet={id:'settings',name:'Settings',orientation:'rows'};
const maxSheets=32;
const storedSheets=(doc:CameraDocument)=>doc.sheets?.length?doc.sheets:[firstSheet];
export function activeSheetId(doc:CameraDocument):string {
  const list=storedSheets(doc);
  return list.some(sheet=>sheet.id===doc.activeSheetId)?doc.activeSheetId!:list[0]!.id;
}
/** Every tab with its layout, whichever one happens to be open. */
export function sheetList(doc:CameraDocument):FullSheet[] {
  const open=activeSheetId(doc);
  return storedSheets(doc).map(sheet=>sheet.id===open?{...sheet,view:doc.view}:sheet as FullSheet);
}
export const isFlipped=(doc:CameraDocument):boolean=>storedSheets(doc).find(sheet=>sheet.id===activeSheetId(doc))?.orientation==='columns';
/** The host calls every tab count "rows", so a tab counts the rows it actually has. */
export const sheetRowCount=(doc:CameraDocument,sheet:FullSheet):number=>sheet.orientation==='columns'?metaFields.length+2+loginFields.filter(id=>loginVisible(sheet.view,id)).length+visibleFields(sheet.view).length:doc.cameras.length;
function putSheets(doc:CameraDocument,sheets:FullSheet[],open:string):void {
  const active=sheets.find(sheet=>sheet.id===open)??sheets.find(sheet=>sheet.id===activeSheetId(doc))??sheets[0]!;
  doc.view=clone(active.view);doc.activeSheetId=active.id;
  doc.sheets=sheets.map(({view,...sheet})=>sheet.id===active.id?sheet:{...sheet,view});
}
function openSheet(doc:CameraDocument,sheetId:string):void {
  if(!storedSheets(doc).some(sheet=>sheet.id===sheetId))throw Error('This tab was removed before the change saved.');
  if(sheetId!==activeSheetId(doc))putSheets(doc,sheetList(doc),sheetId);
}
export const viewChange=(doc:CameraDocument,view:View):Mutation=>({kind:'view',sheetId:activeSheetId(doc),view,expected:clone(doc.view)});
type SheetsChange=Extract<Mutation,{kind:'sheets'}>;
const sheetsChange=(doc:CameraDocument,sheets:FullSheet[],open=activeSheetId(doc)):SheetsChange=>({kind:'sheets',sheets,expected:clone(sheetList(doc)),activeSheetId:open});
/** A new tab starts as a copy of the one you're on. */
export function addSheet(doc:CameraDocument,id:string,name:string):SheetsChange {
  const list=clone(sheetList(doc)),open=list.find(sheet=>sheet.id===activeSheetId(doc))!;
  return sheetsChange(doc,[...list,{id,name:name.trim(),orientation:open.orientation,view:clone(open.view)}],id);
}
export const renameSheet=(doc:CameraDocument,sheetId:string,name:string):SheetsChange=>sheetsChange(doc,clone(sheetList(doc)).map(sheet=>sheet.id===sheetId?{...sheet,name:name.trim()}:sheet));
export const setOrientation=(doc:CameraDocument,sheetId:string,orientation:Orientation):SheetsChange=>sheetsChange(doc,clone(sheetList(doc)).map(sheet=>sheet.id===sheetId?{...sheet,orientation}:sheet));
export function removeSheet(doc:CameraDocument,sheetId:string):SheetsChange|null {
  const list=clone(sheetList(doc)),index=list.findIndex(sheet=>sheet.id===sheetId);
  if(index<0||list.length<2)return null;
  const open=activeSheetId(doc);
  return sheetsChange(doc,list.filter(sheet=>sheet.id!==sheetId),open===sheetId?(list[index+1]??list[index-1])!.id:open);
}
export function moveSheet(doc:CameraDocument,sheetId:string,beforeId:string|null):SheetsChange|null {
  const list=clone(sheetList(doc)),sheet=list.find(item=>item.id===sheetId);
  if(!sheet||sheetId===beforeId)return null;
  const rest=list.filter(item=>item!==sheet),index=beforeId?rest.findIndex(item=>item.id===beforeId):-1;
  rest.splice(index<0?rest.length:index,0,sheet);
  return same(rest.map(item=>item.id),list.map(item=>item.id))?null:sheetsChange(doc,rest);
}
function validateSheets(doc:CameraDocument):void {
  if(doc.sheets===undefined&&doc.activeSheetId===undefined)return;
  if(!Array.isArray(doc.sheets)||!doc.sheets.length||doc.sheets.length>maxSheets)throw Error('Use from 1 to '+maxSheets+' tabs.');
  const ids=new Set<string>(),names=new Set<string>();
  for(const sheet of doc.sheets){
    if(!sheet||typeof sheet.id!=='string'||!sheet.id||ids.has(sheet.id))throw Error('Invalid tab identity.');
    const name=typeof sheet.name==='string'?sheet.name.trim():'';
    if(!name||name.length>64||names.has(name.toLowerCase()))throw Error('Each tab needs its own name of up to 64 characters.');
    if(!['rows','columns'].includes(sheet.orientation))throw Error('Invalid tab layout.');
    ids.add(sheet.id);names.add(name.toLowerCase());
  }
  if(!ids.has(doc.activeSheetId!))throw Error('The open tab is missing.');
  for(const sheet of doc.sheets)if(sheet.id!==doc.activeSheetId)validateView(sheet.view!);
}
export const alertChoices=(doc?:{alerts?:AlertChoices}):AlertChoices=>({...noAlerts,...doc?.alerts});
export const alertsOn=(choices:AlertChoices):boolean=>choices.offlineNotification||choices.offlineBounce||choices.onlineNotification;
export const liveOn=(doc?:{live?:boolean}):boolean=>doc?.live===true;
export const autoSendOn=(doc?:{autoSend?:boolean}):boolean=>doc?.autoSend===true;
/** The sections on the open tab, whole, so expanding one needs no further read. Hidden sections and settings aren't asked for. */
export const readFieldIds=(view:View):string[]=>visibleFields({...view,expanded:Object.fromEntries(groups.map(g=>[g.id,true]))}).map(f=>f.id);
function validateAlerts(alerts:AlertChoices):void {
  const keys=Object.keys(noAlerts);
  if(!alerts||typeof alerts!=='object'||Object.keys(alerts).some(key=>!keys.includes(key))||keys.some(key=>typeof (alerts as unknown as Record<string,unknown>)[key]!=='boolean'))throw Error('Invalid alert choices.');
}
export function validateDocument(value:unknown):CameraDocument {
  const doc=value as CameraDocument;
  if(!doc||doc.version!==1||!Array.isArray(doc.cameras)||doc.cameras.length>24)throw Error('Use up to 24 cameras.');
  const ids=new Set<string>();
  for(const row of doc.cameras) {
    if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||!row.values||typeof row.values!=='object')throw Error('Invalid camera identity.');
    ids.add(row.id);
    for(const [id,value]of Object.entries(row.values)){const issue=validateValue(id,value);if(issue)throw Error(issue);}
    for(const id of metaFields){const issue=validateValue(id,valueOf(row,id));if(issue)throw Error(issue);}
  }
  validateView(doc.view);
  validateSheets(doc);
  if(doc.alerts!==undefined)validateAlerts(doc.alerts);
  if(doc.live!==undefined&&typeof doc.live!=='boolean')throw Error('Invalid Live choice.');
  if(doc.autoSend!==undefined&&typeof doc.autoSend!=='boolean')throw Error('Invalid send mode.');
  if(JSON.stringify(doc).length>220000)throw Error('This camera plan exceeds the workspace document limit.');
  return doc;
}
export function applyMutation(before:CameraDocument,operation:Mutation):CameraDocument {
  const next=clone(before);
  if(operation.kind==='edit') {
    if(!Array.isArray(operation.edits)||!operation.edits.length||operation.edits.length>10000)throw Error('Invalid edit batch.');
    const addresses=new Set<string>();
    for(const edit of operation.edits) {
      const row=next.cameras.find(r=>r.id===edit.rowId);
      if(!row)throw Error('The camera was removed before this edit saved.');
      const key=edit.rowId+'/'+edit.columnId;
      if(addresses.has(key))throw Error('A batch contains the same cell twice.');
      addresses.add(key);
      if(valueOf(row,edit.columnId)!==edit.expected)throw Error('This cell changed in another editor. Your draft is retained.');
      const issue=validateValue(edit.columnId,edit.value);if(issue)throw Error(issue);
      row.values[edit.columnId]=edit.value;
    }
  } else if(operation.kind==='view') {
    openSheet(next,operation.sheetId??activeSheetId(next));
    if(!same(next.view,operation.expected))throw Error('The column layout changed in another editor.');
    next.view=clone(operation.view);
  } else if(operation.kind==='select-sheet') {
    openSheet(next,operation.sheetId);
  } else if(operation.kind==='sheets') {
    if(!same(sheetList(next),operation.expected))throw Error('The tabs changed in another editor.');
    putSheets(next,clone(operation.sheets),operation.activeSheetId??activeSheetId(next));
  } else if(operation.kind==='cameras') {
    for(const camera of operation.remove){const row=next.cameras.find(r=>r.id===camera.id);if(!row||!same(row,camera))throw Error('A camera changed before it could be removed.');}
    const gone=new Set(operation.remove.map(camera=>camera.id));
    next.cameras=next.cameras.filter(row=>!gone.has(row.id));
    for(const camera of operation.add){if(next.cameras.some(row=>row.id===camera.id))throw Error('This camera is already in the plan.');next.cameras.push(clone(camera));}
  } else if(operation.kind==='add') {
    if(next.cameras.some(r=>r.id===operation.camera.id))throw Error('This camera is already in the plan.');
    next.cameras.push(clone(operation.camera));
  } else if(operation.kind==='alerts') {
    if(!same(alertChoices(next),operation.expected))throw Error('The alert choices changed in another editor.');
    validateAlerts(operation.alerts);
    next.alerts=clone(operation.alerts);
  } else if(operation.kind==='live') {
    if(typeof operation.live!=='boolean'||typeof operation.expected!=='boolean')throw Error('Invalid Live choice.');
    if(liveOn(next)!==operation.expected)throw Error('Live was switched in another editor.');
    next.live=operation.live;
  } else if(operation.kind==='auto-send') {
    if(typeof operation.autoSend!=='boolean'||typeof operation.expected!=='boolean')throw Error('Invalid send mode.');
    if(autoSendOn(next)!==operation.expected)throw Error('The send mode was changed in another editor.');
    next.autoSend=operation.autoSend;
  } else if(operation.kind==='remove') {
    const row=next.cameras.find(r=>r.id===operation.camera.id);
    if(!row||!same(row,operation.camera))throw Error('The camera changed before removal.');
    next.cameras=next.cameras.filter(r=>r.id!==row.id);
  } else throw Error('Unknown edit operation.');
  return validateDocument(next);
}
export function visibleFields(view:View):Field[] {
  return [...view.order,...groups.map(g=>g.id).filter(id=>!view.order.includes(id))].filter(id=>!view.hiddenGroups?.includes(id)).flatMap(id=>{
    const group=groups.find(g=>g.id===id)!;
    const order=[...(view.fields[id]??[]),...group.fields.map(f=>f.id).filter(f=>!view.fields[id]?.includes(f))];
    return order.filter(f=>!view.hidden.includes(f)&&(view.expanded[id]||(view.collapsed[id]??group.collapsed).includes(f))).map(f=>fieldById.get(f)!);
  });
}
/** One pointer gesture changes only its field/section preferences, in one layout transaction. */
export function withColumnVisibility(view:View,changes:readonly {id:string;visible:boolean}[]):View {
  const next=clone(view);
  for(const {id,visible}of changes){
    if(id==='login'||isLoginField(id)){
      const hidden=new Set(next.hiddenLogin??[]);
      if(visible){hidden.delete(id);if(id!=='login')hidden.delete('login');}else hidden.add(id);
      next.hiddenLogin=[...hidden];
      continue;
    }
    if(groups.some(group=>group.id===id)){
      next.hiddenGroups=(next.hiddenGroups??[]).filter(group=>group!==id);
      if(!visible)next.hiddenGroups.push(id);
      continue;
    }
    const field=fieldById.get(id);if(!field)throw Error('Unknown column.');
    const group=groups.find(group=>group.id===field.group)!;
    next.hidden=next.hidden.filter(field=>field!==id);
    if(!next.expanded[group.id]){
      const compact=next.collapsed[group.id]??group.collapsed;
      next.collapsed[group.id]=visible?[...new Set([...compact,id])]:compact.filter(field=>field!==id);
    }else if(!visible)next.hidden.push(id);
    if(visible)next.hiddenGroups=next.hiddenGroups?.filter(id=>id!==group.id);
  }
  return next;
}
/** Takes every optional column off a tab. Anything ticked afterwards shows on its own. */
export function withNoColumns(view:View):View {
  const next=clone(view);
  next.hiddenGroups=groups.map(group=>group.id);
  next.collapsed=Object.fromEntries(groups.map(group=>[group.id,[]]));
  next.expanded=Object.fromEntries(groups.map(group=>[group.id,false]));
  next.hiddenLogin=[...new Set([...(next.hiddenLogin??[]),'login'])];
  return next;
}
export function inverse(before:CameraDocument,operation:Mutation):Mutation {
  if(operation.kind==='edit')return {kind:'edit',edits:operation.edits.map(e=>({...e,expected:e.value,value:valueOf(before.cameras.find(r=>r.id===e.rowId)!,e.columnId)}))};
  if(operation.kind==='view')return {kind:'view',sheetId:operation.sheetId??activeSheetId(before),view:clone(operation.expected),expected:clone(operation.view)};
  if(operation.kind==='select-sheet')return {kind:'select-sheet',sheetId:activeSheetId(before)};
  if(operation.kind==='sheets')return {kind:'sheets',sheets:clone(operation.expected),expected:clone(operation.sheets),activeSheetId:activeSheetId(before)};
  if(operation.kind==='cameras')return {kind:'cameras',add:clone(operation.remove),remove:clone(operation.add)};
  if(operation.kind==='add')return {kind:'remove',camera:clone(operation.camera)};
  if(operation.kind==='alerts')return {kind:'alerts',alerts:clone(operation.expected),expected:clone(operation.alerts)};
  if(operation.kind==='live')return {kind:'live',live:operation.expected,expected:operation.live};
  if(operation.kind==='auto-send')return {kind:'auto-send',autoSend:operation.expected,expected:operation.autoSend};
  return {kind:'add',camera:clone(operation.camera)};
}
