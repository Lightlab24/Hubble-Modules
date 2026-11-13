import { setTimeout as delay } from 'node:timers/promises';
import { type Field, type Camera, valueOf, validateValue } from './model.js';
import type { RpcClient } from './camera-client.js';

// The camera ignores a Speed/Angle change sent to Camera.Shutter.Mode. Sony's page changes it through this menu setting.
const shutterModeMenu='P.System.Menu.ShutterMode';
const shutterModeLock='P.System.Menu.ShutterModeForWifiFull.MenuItem';
// The camera reports ND as a filter factor. Crew read it as density, as Sony's page does, and like that page this goes by the number alone.
const ndDensity:Record<number,string>={1:'Clear',2:'0.3',4:'0.6',8:'0.9',16:'1.2',32:'1.5',64:'1.8',128:'2.1',256:'2.4'};
const ndClearAbove=1000,ndCustom=[65529,65532],ndNoReading=[65534,65535];
export const ndChoices=Object.values(ndDensity);
function ndLabel(factor:number):string {
  if(ndNoReading.includes(factor))return '';
  if(factor>=ndCustom[0]!&&factor<=ndCustom[1]!)return 'Custom '+(factor-ndCustom[0]!+1);
  return factor>ndClearAbove?'Clear':ndDensity[factor]??'';
}
// The reel a VENICE records to is in its next clip name, such as B502C001. Its Reel Number menu setting can lag:
// on real cameras it kept the old number after the cards moved to the next reel, until each camera next recorded.
// So the clip name comes first, and the setting is only the fallback, for a camera with no clip name to report.
const reelMenu='P.System.Menu.ClipnamingReelNum';
export const clipNameProperty='Clip.Mediabox.ClipName';
function reelFromClipName(raw:Record<string,any>):string {
  const value=raw[clipNameProperty],name=typeof value==='string'?value:value?.main;
  const match=typeof name==='string'?/(\d{3})C\d{3}/.exec(name.replace(/\u0000/g,'')):null;
  return match?String(Number(match[1])):'';
}
export const fieldProperties=(field:Field):string[]=>{
  const props=field.property.split(' / ').map(p=>p.replace(/ \[[^\]]+\]$/,''));
  if(field.id==='shooting-fps'||field.id==='fps-mode')return ['Camera.SlowAndQuickMotion.Enabled','Camera.SlowAndQuickMotion.FrameRate','Camera.SlowAndQuickMotion.FrameRate.Denominator'];
  if(field.property===reelMenu)return [reelMenu,clipNameProperty];
  if(field.id.startsWith('shutter-'))return ['Camera.Shutter.Mode','Camera.Shutter.Angle.DisplayValue','Camera.Shutter.Speed.DisplayValue','Camera.Shutter.Mode.Angle.Select','Camera.Shutter.Mode.Speed.Select',shutterModeMenu];
  return props;
};
const pick=(value:any,key?:string):any=>key?value?.[key]:value?.cam??value;
export function decodeField(field:Field,raw:Record<string,any>):string {
  if(field.property===reelMenu){const fromClip=reelFromClipName(raw);if(fromClip)return fromClip;}
  const property=field.property.split(' / ')[0]!.replace(/ \[[^\]]+\]$/,'');
  let value=pick(raw[property],/\[([^\]]+)\]$/.exec(field.property)?.[1]);
  if(field.id==='shooting-fps'){value=Number(raw['Camera.SlowAndQuickMotion.FrameRate'])/(Number(raw['Camera.SlowAndQuickMotion.FrameRate.Denominator'])||1);if(!Number.isFinite(value))return '';}
  if(field.id==='fps-mode')return raw['Camera.SlowAndQuickMotion.Enabled']===true?'Variable':raw['Camera.SlowAndQuickMotion.Enabled']===false?'Fixed':'';
  if(value===undefined||value===null)return '';
  if(field.id==='nd')return ndLabel(Number(value));
  if(field.property==='P.System.Menu.ClipnamingCameraid')return String.fromCharCode(Number(value));
  if(field.id==='base-iso')return String(value).replace(/^ISO\s*/,'');
  if(field.id==='ei')return String(value).replace(/EI$/,'');
  if(field.kind==='boolean') {
    const on=field.choices.find(c=>c.label.toLowerCase()==='on');
    return String(value)===on?.wire?'TRUE':'FALSE';
  }
  return typeof value==='object'?'':String(value);
}
// A VENICE has two base ISOs, fixed by its sensor, and reports no list for them. Sony's page holds the same pairs.
const baseIsoPairs=[['500','2500'],['800','3200']];
export const baseIsoChoices=(current:string):string[]=>baseIsoPairs.find(pair=>pair.includes(current))??[];
// Sony's page takes its REC indicator from the media box status alone. On real VENICE 2s that said NoMedia as each
// camera started rolling, while each card's own recording report said Recording within a second. So a card that is
// recording means REC; the media box still gives Starting and Standby, and a camera whose cards aren't reported keeps
// Sony's mapping. Otherwise a camera with a card ready to record and none recording is Standby, unless it is playing back.
export const recordingProperty='Clip.Mediabox.Status';
const mediaRecording='Storage.Media.Recording',mediaRecordable='Storage.Media.Recordable';
export const recordingProperties=[recordingProperty,mediaRecording,mediaRecordable];
const recordingStates:Record<string,string>={Recording:'recording',Standby:'standby',PreparingToRecord:'starting'};
const slots=(value:unknown):string[]|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?Object.values(value).map(String):undefined;
export function recordingState(raw:Record<string,any>):string {
  const box=String(raw[recordingProperty]?.main),cards=slots(raw[mediaRecording]);
  if(!cards)return recordingStates[box]??'';
  if(cards.includes('Recording'))return 'recording';
  if(box==='PreparingToRecord')return 'starting';
  if(box==='Playing')return '';
  if(box==='Standby'||slots(raw[mediaRecordable])?.includes('Recordable'))return 'standby';
  return '';
}
/** The signals behind a recording state, for the log. */
export const recordingSignals=(raw:Record<string,any>):string=>'media box '+(raw[recordingProperty]?.main??'unknown')+', cards '+JSON.stringify(raw[mediaRecording]??null);
function inputWire(field:Field,value:string):unknown {
  if(field.kind==='boolean'){const label=value==='TRUE'?'on':'off';return field.choices.find(c=>c.label.toLowerCase()===label)!.wire;}
  return field.choices.find(c=>c.value===value)?.wire??value;
}
export function encodeField(field:Field,value:string,row:Camera,current:Record<string,any>):Record<string,unknown> {
  const issue=validateValue(field.id,value);if(issue)throw Error(issue);
  if(!value)throw Error('An empty draft does not send a camera change.');
  const props=fieldProperties(field);
  const property=props[0]!;
  const wire=inputWire(field,value);
  if(property.startsWith('P.System.Menu.')) {
    if(current[property]===undefined)throw Error('Read this setting from the camera before sending it.');
    const old=pick(current[property]);
    if(typeof old==='string')return {[property]:String(wire)};
    if(typeof old==='number'&&Number.isFinite(Number(wire)))return {[property]:Number(wire)};
    if(typeof old==='boolean')return {[property]:wire==='TRUE'||wire==='1'||wire===true};
    throw Error('This camera reports a value shape that still needs a specialized editor.');
  }
  if(field.id==='shooting-fps'||field.id==='fps-mode') {
    const rate=field.id==='shooting-fps'?Number(value):Number(valueOf(row,'shooting-fps')||decodeField({...field,id:'shooting-fps'},current));
    if(!Number.isFinite(rate)||rate<=0)throw Error('Read or enter a valid shooting frame rate.');
    const denominator=Number.isInteger(rate)?1:100,mode=field.id==='fps-mode'?value:valueOf(row,'fps-mode');
    return {'Camera.SlowAndQuickMotion.Enabled':mode?mode==='Variable':current['Camera.SlowAndQuickMotion.Enabled'],'Camera.SlowAndQuickMotion.FrameRate':Math.round(rate*denominator),'Camera.SlowAndQuickMotion.FrameRate.Denominator':denominator};
  }
  if(field.id==='shutter-adjust')return {'Camera.Shutter.Mode.Angle.Select':wire,'Camera.Shutter.Mode.Speed.Select':wire};
  if(field.id==='shutter-mode') {
    const old=pick(current[shutterModeMenu]),next=wire==='Angle'?1:0;
    if(old===undefined||old===null)throw Error('Read this setting from the camera before sending it.');
    return {[shutterModeMenu]:typeof old==='number'?next:String(next)};
  }
  if(field.id==='shutter-angle')return {'Camera.Shutter.Mode':'Angle','Camera.Shutter.Angle.DisplayValue':value};
  if(field.id==='shutter-speed')return {'Camera.Shutter.Mode':'Speed','Camera.Shutter.Speed.DisplayValue':value.includes('.')?value:value+'.0'};
  if(field.id==='nd'){const nd=Number(Object.entries(ndDensity).find(([,density])=>density===value)?.[0]);if(!nd)throw Error('Choose an available ND filter.');return {'Camera.NDFilter.Mode':nd===1?'PresetClear':'Preset','Camera.NDFilter.Value':nd};}
  if(field.id==='base-iso')return {[property]:'ISO '+value};
  if(field.id==='ei')return {[property]:value+'EI'};
  const selector=/\[([^\]]+)\]$/.exec(field.property)?.[1];
  if(selector)return {[property]:{[selector]:wire}};
  if(property.startsWith('LUT.'))return {[property]:{cam:field.id==='user-lut'||field.id==='art-look'?Number(wire):wire}};
  if(property.startsWith('Camera.LEDWall.'))return {[property]:value,'Camera.LEDWall.Temperature.Tint.Value':'0'};
  if(property==='Camera.Gain.dBValue'){const old=current[property];return {[property]:typeof old==='number'?Number(value):value};}
  return {[property]:wire};
}
export function subsetEqual(expected:unknown,actual:unknown):boolean {
  if(expected&&typeof expected==='object'&&!Array.isArray(expected))return actual!==null&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>subsetEqual(v,(actual as any)[k]));
  return expected===actual;
}
export async function readFields(client:RpcClient,fields:Field[],signal:AbortSignal,extra:string[]=[]):Promise<Record<string,any>> {
  const properties=[...new Set([...fields.flatMap(fieldProperties),...extra])];
  if(!properties.length)return {};
  const raw=await client.rpc('Property.GetValue',Object.fromEntries(properties.map(p=>[p,['*']])),signal);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Camera did not return setting values.');
  return raw;
}
// Sony's own page asks with a null selector and only treats an explicit 'Locked' as unavailable.
// Most menu settings have no status at all, and the readback after the write is the real proof.
async function assertNotLocked(client:RpcClient,keys:string[],signal:AbortSignal):Promise<void> {
  let status:any;
  try {status=await client.rpc('Property.GetStatus',Object.fromEntries(keys.map(p=>[p,null])),signal);}
  catch(error){if(signal.aborted)throw error;return;}
  for(const key of keys)if(pick(status?.[key])==='Locked')throw Error('This setting is locked in the camera’s current mode.');
}
// ND and Speed/Angle are judged by what the camera ends up reporting, not by the exact shape of what was sent.
const readbackConfirms=(field:Field,value:string,payload:Record<string,unknown>,after:Record<string,any>)=>field.id==='nd'||field.id==='shutter-mode'?decodeField(field,after)===value:Object.entries(payload).every(([k,v])=>subsetEqual(v,after?.[k]));
export async function writeField(client:RpcClient,field:Field,value:string,row:Camera,signal:AbortSignal):Promise<Record<string,any>> {
  const current=await readFields(client,[field],signal);
  const payload=encodeField(field,value,row,current);
  for(const [key,v]of Object.entries(payload))if(v===undefined)throw Error('Read '+key+' before sending this compound setting.');
  await assertNotLocked(client,field.id==='shutter-mode'?[shutterModeLock]:Object.keys(payload),signal);
  await client.rpc('Property.SetValue',payload,signal);
  const deadline=Date.now()+4500,keys=field.id==='shutter-mode'?[...Object.keys(payload),'Camera.Shutter.Mode']:Object.keys(payload);
  let last:unknown;
  while(Date.now()<deadline) {
    const after=await client.rpc('Property.GetValue',Object.fromEntries(keys.map(p=>[p,['*']])),signal);
    if(readbackConfirms(field,value,payload,after))return after;
    last=after;
    await delay(100,undefined,{signal});
  }
  throw Object.assign(Error('The write was acknowledged but readback did not confirm it. Refresh before retrying.'),{readback:last});
}
