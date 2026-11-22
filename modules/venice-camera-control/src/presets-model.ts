import { fields, fieldById, groups, clone, same, sameValue, validateValue, validateView, reelProperty, type Field, type View } from './model.js';

/**
 * Presets are camera roles. Base holds a whole camera's settings, usually captured from one.
 * Every other preset (A Cam, B Cam…) holds only what makes that role different; the rest comes from Base.
 * Sending a preset to a camera writes Base with the role's own values on top.
 */
export const baseId='base';
export const nameRowId='preset-name',holdsRowId='preset-holds';
export const maxPresets=32;
export interface Preset { id:string; name:string; values:Record<string,string> }
/** The Send box: which preset goes to which camera. Remembered, never an Undo step. */
export interface SendChoice { presetId?:string; cameraId?:string }
/**
 * `offered`: for each setting, the values the camera allowed when it was captured. The Presets dropdowns offer only these,
 * so a preset can't hold something the camera never offered. A send still checks the camera's own list at the time.
 */
export interface PresetDocument { version:1; presets:Preset[]; view:View; send?:SendChoice; offered?:Record<string,string[]> }
/** Allowed values a capture changes: a list per setting, or null where there was none before. */
export type OfferedChange=Record<string,string[]|null>;
/** rowId is a setting (or the name row) and columnId is a preset, the way the page lays them out. */
export interface PresetEdit { rowId:string; columnId:string; value:string; expected:string }
export type PresetMutation =
  | {kind:'edit';edits:PresetEdit[]}
  | {kind:'view';view:View;expected:View}
  | {kind:'add';preset:Preset;index:number;offered?:OfferedChange;offeredBefore?:OfferedChange}
  | {kind:'remove';preset:Preset;index:number;offered?:OfferedChange;offeredBefore?:OfferedChange}
  | {kind:'values';presetId:string;values:Record<string,string>;expected:Record<string,string>;offered?:OfferedChange;offeredBefore?:OfferedChange}
  | {kind:'send';send:SendChoice;expected:SendChoice};

/** Every setting a preset can hold. The reel belongs to the day's cards, not to a camera's role. */
export const presetFields:Field[]=fields.filter(f=>f.property!==reelProperty);
const presetFieldIds=new Set(presetFields.map(f=>f.id));
export const isPresetField=(id:string):boolean=>presetFieldIds.has(id);
export const cameraIdField=fields.find(f=>f.property==='P.System.Menu.ClipnamingCameraid')!;

export function defaultPresetView():View {
  // Each section starts showing its usual settings, the same ones Camera Control shows folded.
  return {expanded:{},collapsed:{},order:groups.map(g=>g.id),fields:{},hidden:[],hiddenGroups:[],textSize:13,widths:{},rowHeights:{}};
}
export function defaultPresetDocument():PresetDocument {
  return {version:1,presets:[{id:baseId,name:'Base',values:{}}],view:defaultPresetView()};
}
export const presetById=(doc:PresetDocument,id:string|undefined):Preset|undefined=>doc.presets.find(p=>p.id===id);
export const basePreset=(doc:PresetDocument):Preset=>doc.presets[0]!;
export const isBase=(preset:Preset|string):boolean=>(typeof preset==='string'?preset:preset.id)===baseId;
/** What a preset sends: Base, with the role's own values on top. */
export function resolvedValues(doc:PresetDocument,presetId:string):Record<string,string> {
  const preset=presetById(doc,presetId);if(!preset)return {};
  return isBase(preset)?{...basePreset(doc).values}:{...basePreset(doc).values,...preset.values};
}
/** The value a cell shows, and whether it is the preset's own or comes from Base. */
export function presetValue(doc:PresetDocument,presetId:string,fieldId:string):{value:string;own:boolean} {
  const preset=presetById(doc,presetId);
  const own=preset?.values[fieldId];
  if(own!==undefined)return {value:own,own:true};
  return {value:isBase(presetId)?'':basePreset(doc).values[fieldId]??'',own:false};
}
export const heldCount=(preset:Preset):number=>Object.keys(preset.values).length;
/** Every setting some preset holds. Only these show: a setting no camera reported can't be sent anyway. */
export const heldFieldIds=(doc:PresetDocument):Set<string>=>new Set(doc.presets.flatMap(p=>Object.keys(p.values)));
/** Settings any role changes from Base. They always show, so a role's differences can't hide in a folded section. */
export const roleFieldIds=(doc:PresetDocument):Set<string>=>new Set(doc.presets.filter(p=>!isBase(p)).flatMap(p=>Object.keys(p.values)));

const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A new role takes the first camera letter no other role has, and is named after it. Base's own letter doesn't count. */
export function newRole(doc:PresetDocument,id:string):Preset {
  const used=new Set(doc.presets.filter(p=>!isBase(p)).map(p=>p.values[cameraIdField.id]).filter(Boolean));
  const names=new Set(doc.presets.map(p=>p.name.toLowerCase()));
  const letter=[...letters].find(l=>!used.has(l)&&!names.has((l+' Cam').toLowerCase()));
  if(letter)return {id,name:letter+' Cam',values:{[cameraIdField.id]:letter}};
  let n=doc.presets.length;while(names.has(('Preset '+n).toLowerCase()))n++;
  return {id,name:'Preset '+n,values:{}};
}
export function uniqueName(doc:PresetDocument,wanted:string):string {
  const names=new Set(doc.presets.map(p=>p.name.toLowerCase()));
  const base=wanted.trim().slice(0,40)||'Preset';
  if(!names.has(base.toLowerCase()))return base;
  for(let n=2;;n++){const name=(base.slice(0,36)+' '+n);if(!names.has(name.toLowerCase()))return name;}
}
/** A capture keeps only what a preset can hold and the page could show: valid, non-empty settings, never the reel. */
export function capturedValues(values:Record<string,string>):{values:Record<string,string>;dropped:string[]} {
  const kept:Record<string,string>={},dropped:string[]=[];
  for(const field of presetFields){
    const value=values[field.id];
    if(!value)continue;
    if(validateValue(field.id,value))dropped.push(field.id);else kept[field.id]=value;
  }
  return {values:kept,dropped};
}

const maxOffered=400,offeredBudget=120000;
/**
 * The allowed values a camera reported for the settings a capture keeps, limited to values a preset can hold.
 * The longest lists go first if they would make the saved presets too large.
 */
export function capturedOffers(choices:Record<string,{value:string}[]|undefined>,values:Record<string,string>):Record<string,string[]> {
  const kept:Record<string,string[]>={};
  for(const id of Object.keys(values)){
    const list=[...new Set((choices[id]??[]).map(choice=>choice.value).filter(value=>value&&!validateValue(id,value)))];
    if(list.length&&list.length<=maxOffered)kept[id]=list;
  }
  while(JSON.stringify(kept).length>offeredBudget){
    const longest=Object.entries(kept).sort((a,b)=>b[1].length-a[1].length)[0];if(!longest)break;delete kept[longest[0]];
  }
  return kept;
}
/** What a capture changes in the allowed values, and what was there before, so Undo puts it back. */
export function offeredChange(doc:PresetDocument,offered:Record<string,string[]>):{offered:OfferedChange;offeredBefore:OfferedChange} {
  const before:OfferedChange={};
  for(const id of Object.keys(offered))before[id]=doc.offered?.[id]?clone(doc.offered[id]!):null;
  return {offered:clone(offered),offeredBefore:before};
}
function applyOffered(next:PresetDocument,change:OfferedChange|undefined,before:OfferedChange|undefined):void {
  if(!change)return;
  if(!before||typeof change!=='object'||typeof before!=='object')throw Error('Invalid allowed values.');
  const offered={...next.offered};
  for(const [id,list]of Object.entries(change)){
    if(!same(offered[id]??null,before[id]??null))throw Error('The allowed values changed in another editor.');
    if(list===null)delete offered[id];else offered[id]=clone(list);
  }
  if(Object.keys(offered).length)next.offered=offered;else delete next.offered;
}

function validatePresetValue(fieldId:string,value:string):void {
  if(!isPresetField(fieldId))throw Error(fieldById.has(fieldId)?'The reel number is set per camera, not in a preset.':'Unknown camera setting.');
  if(typeof value!=='string'||!value)throw Error('A preset holds only settings with a value.');
  const issue=validateValue(fieldId,value);if(issue)throw Error(issue);
}
function validateName(name:unknown):string {
  const trimmed=typeof name==='string'?name.trim():'';
  if(!trimmed||trimmed.length>40)throw Error('Give each preset a name of up to 40 characters.');
  return trimmed;
}
export function validatePresetDocument(value:unknown):PresetDocument {
  const doc=value as PresetDocument;
  if(!doc||doc.version!==1||!Array.isArray(doc.presets)||!doc.presets.length||doc.presets.length>maxPresets)throw Error('Use up to '+maxPresets+' presets.');
  if(doc.presets[0]!.id!==baseId)throw Error('Base comes first.');
  const ids=new Set<string>(),names=new Set<string>();
  for(const preset of doc.presets){
    if(!preset||typeof preset.id!=='string'||!preset.id||preset.id.length>64||ids.has(preset.id))throw Error('Invalid preset identity.');
    if(preset.id===baseId&&preset!==doc.presets[0])throw Error('There is only one Base.');
    const name=validateName(preset.name);
    if(names.has(name.toLowerCase()))throw Error('Each preset needs its own name.');
    ids.add(preset.id);names.add(name.toLowerCase());
    if(!preset.values||typeof preset.values!=='object'||Array.isArray(preset.values))throw Error('Invalid preset values.');
    for(const [id,v]of Object.entries(preset.values))validatePresetValue(id,v);
  }
  validateView(doc.view);
  if(doc.send!==undefined&&(typeof doc.send!=='object'||Object.entries(doc.send).some(([k,v])=>!['presetId','cameraId'].includes(k)||typeof v!=='string')))throw Error('Invalid send choice.');
  if(doc.offered!==undefined){
    if(!doc.offered||typeof doc.offered!=='object'||Array.isArray(doc.offered))throw Error('Invalid allowed values.');
    for(const [id,list]of Object.entries(doc.offered)){
      if(!isPresetField(id)||!Array.isArray(list)||!list.length||list.length>maxOffered||new Set(list).size!==list.length)throw Error('Invalid allowed values.');
      for(const value of list)if(typeof value!=='string'||!value||validateValue(id,value))throw Error('Invalid allowed values.');
    }
  }
  if(JSON.stringify(doc).length>220000)throw Error('These presets exceed the workspace document limit.');
  return doc;
}
export function applyPresetMutation(before:PresetDocument,operation:PresetMutation):PresetDocument {
  const next=clone(before);
  if(operation.kind==='edit'){
    if(!Array.isArray(operation.edits)||!operation.edits.length||operation.edits.length>20000)throw Error('Invalid edit batch.');
    const seen=new Set<string>();
    for(const edit of operation.edits){
      const preset=presetById(next,edit.columnId);if(!preset)throw Error('This preset was removed before the edit saved.');
      const key=edit.rowId+'/'+edit.columnId;if(seen.has(key))throw Error('A batch contains the same cell twice.');seen.add(key);
      if(edit.rowId===nameRowId){
        if(isBase(preset))throw Error('Base keeps its name.');
        if(preset.name!==edit.expected)throw Error('This name changed in another editor.');
        preset.name=validateName(edit.value);continue;
      }
      if((preset.values[edit.rowId]??'')!==edit.expected)throw Error('This cell changed in another editor. Your draft is retained.');
      if(!edit.value){if(!isPresetField(edit.rowId))throw Error('Unknown camera setting.');delete preset.values[edit.rowId];continue;}
      validatePresetValue(edit.rowId,edit.value);preset.values[edit.rowId]=edit.value;
    }
  } else if(operation.kind==='view'){
    if(!same(next.view,operation.expected))throw Error('The layout changed in another editor.');
    next.view=clone(operation.view);
  } else if(operation.kind==='add'){
    if(next.presets.length>=maxPresets)throw Error('Use up to '+maxPresets+' presets.');
    if(presetById(next,operation.preset.id))throw Error('This preset is already here.');
    if(!Number.isInteger(operation.index)||operation.index<1||operation.index>next.presets.length)throw Error('A preset goes after Base.');
    next.presets.splice(operation.index,0,clone(operation.preset));
    applyOffered(next,operation.offered,operation.offeredBefore);
  } else if(operation.kind==='remove'){
    const index=next.presets.findIndex(p=>p.id===operation.preset.id);
    if(isBase(operation.preset.id))throw Error('Base can’t be removed.');
    if(index<0||!same(next.presets[index],operation.preset))throw Error('This preset changed before it could be removed.');
    next.presets.splice(index,1);
    if(next.send?.presetId===operation.preset.id)delete next.send.presetId;
    applyOffered(next,operation.offered,operation.offeredBefore);
  } else if(operation.kind==='values'){
    const preset=presetById(next,operation.presetId);if(!preset)throw Error('This preset was removed before the capture saved.');
    if(!same(preset.values,operation.expected))throw Error('This preset changed in another editor.');
    preset.values=clone(operation.values);
    applyOffered(next,operation.offered,operation.offeredBefore);
  } else if(operation.kind==='send'){
    if(!same(next.send??{},operation.expected))throw Error('The send choice changed in another editor.');
    next.send=clone(operation.send);
  } else throw Error('Unknown preset change.');
  return validatePresetDocument(next);
}
export function inversePreset(before:PresetDocument,operation:PresetMutation):PresetMutation {
  if(operation.kind==='edit')return {kind:'edit',edits:operation.edits.map(e=>({...e,expected:e.rowId===nameRowId?e.value.trim():e.value,value:e.expected}))};
  if(operation.kind==='view')return {kind:'view',view:clone(operation.expected),expected:clone(operation.view)};
  const offered=(op:{offered?:OfferedChange;offeredBefore?:OfferedChange})=>op.offered?{offered:clone(op.offeredBefore!),offeredBefore:clone(op.offered)}:{};
  if(operation.kind==='add')return {kind:'remove',preset:clone(operation.preset),index:operation.index,...offered(operation)};
  if(operation.kind==='remove')return {kind:'add',preset:clone(operation.preset),index:Math.max(1,before.presets.findIndex(p=>p.id===operation.preset.id)),...offered(operation)};
  if(operation.kind==='values')return {kind:'values',presetId:operation.presetId,values:clone(operation.expected),expected:clone(operation.values),...offered(operation)};
  return {kind:'send',send:clone(operation.expected),expected:clone(operation.send)};
}

// Settings that change what a VENICE offers for others go first, and the ones that depend on them after:
// frame rate and imager mode before shooting speed, base ISO before EI, shutter mode before angle or speed, look category before the look.
const sendFirst=['L3_SYSTEM_FRAME_RATE','L3_IMAGER_MODE','L3_AXS_MAIN_REC_FORMAT','L3_INPUT_COLOR_SPACE','fps-mode','shooting-fps','base-iso','ei','gain','shutter-mode','shutter-adjust','shutter-angle','shutter-speed','nd','look-category'];
/** After one of these is written the camera may offer other values, so what is left is read again. */
export const modeFieldIds=new Set(['L3_SYSTEM_FRAME_RATE','L3_IMAGER_MODE','L3_AXS_MAIN_REC_FORMAT','L3_INPUT_COLOR_SPACE','fps-mode','base-iso','shutter-mode','look-category']);
const rank=new Map([...sendFirst,...fields.map(f=>f.id).filter(id=>!sendFirst.includes(id))].map((id,index)=>[id,index]));
export const sendOrder=(ids:readonly string[]):string[]=>[...ids].sort((a,b)=>(rank.get(a)??1e9)-(rank.get(b)??1e9));
export interface PlannedSend { send:{id:string;value:string}[]; skipped:{id:string;reason:string}[]; same:number }
/**
 * What a preset changes on a camera, given what the camera reports now and the values it offers.
 * Only one of shutter angle or speed is sent: the one the preset's shutter mode uses.
 */
export function planSend(resolved:Record<string,string>,current:Record<string,string>,offered:Record<string,{value:string}[]|undefined>):PlannedSend {
  const plan:PlannedSend={send:[],skipped:[],same:0};
  const mode=resolved['shutter-mode'];
  for(const field of presetFields){
    const value=resolved[field.id];if(!value)continue;
    if(field.id==='shutter-speed'&&(mode==='Angle'||(!mode&&resolved['shutter-angle'])))continue;
    if(field.id==='shutter-angle'&&mode==='Speed')continue;
    const now=current[field.id];
    if(!now){plan.skipped.push({id:field.id,reason:'The camera doesn’t report this setting.'});continue;}
    if(sameValue(field,value,now)){plan.same++;continue;}
    const list=offered[field.id];
    if(list?.length&&!list.some(choice=>choice.value===value)){plan.skipped.push({id:field.id,reason:'The camera doesn’t offer '+value+' right now.'});continue;}
    plan.send.push({id:field.id,value});
  }
  const order=sendOrder(plan.send.map(entry=>entry.id));
  plan.send.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  return plan;
}
