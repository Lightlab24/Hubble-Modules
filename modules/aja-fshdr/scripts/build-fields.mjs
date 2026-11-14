// Regenerates src/fields.json from a firmware capture.
// node scripts/build-fields.mjs <simulator fixture .json.gz> <catalog-metadata.json>
// The fixture supplies each setting's name and type; the metadata says which control surface it belongs to.
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const [fixturePath, metadataPath] = process.argv.slice(2);
if (!fixturePath || !metadataPath) throw Error('Usage: build-fields.mjs <fixture.json.gz> <catalog-metadata.json>');
const fixture = JSON.parse(gunzipSync(await readFile(fixturePath)).toString('utf8'));
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const descriptors = new Map(fixture.descriptors.map(d => [d.param_id, d]));
const kinds = { enum: 'choice', integer: 'number', decimal: 'number', string: 'text' };
const usable = id => {
  const m = metadata[id], d = descriptors.get(id);
  return !!m && !!d && m.access === 'control' && !m.variant && !!kinds[d.param_type] && !d.class_names?.includes('readonly');
};
// Wide enough for the header and for the longest value the unit offers, so a row keeps to one line.
const width = (label, d) => Math.max(130, Math.min(280, Math.max(label.length * 8 + 46, ...(d?.enum_values ?? []).map(option => String(option.text).length * 7.4 + 52)) | 0));
const channelGroups = [
  { id: 'hdr', label: 'HDR', collapsed: ['Vid#ColorHDRTransform', 'Vid#DynamicRangeAndGamut', 'Vid#DynamicRangeAndGamutOut'] },
  { id: 'input', label: 'Input', collapsed: ['Vid#VideoInput'] },
  { id: 'format', label: 'Format', collapsed: ['Vid#OutputFormat'] },
  { id: 'framing', label: 'Framing', collapsed: ['Vid#CustomSizePos', 'Vid#CustomSize'] },
  { id: 'procamp', label: 'ProcAmp & color corrector', collapsed: ['Vid#YUVProcAmpEnable', 'Vid#RGBProcAmpEnable'] },
  { id: 'film', label: 'Colorfront Film', collapsed: [] },
  { id: 'tv', label: 'Colorfront TV', collapsed: [] },
  { id: 'background', label: 'Background & matte', collapsed: ['Vid#BackgroundFill'] },
  { id: 'timing', label: 'Timing', collapsed: [] },
  { id: 'anc', label: 'ANC, captions & VPID', collapsed: [] },
  { id: 'test', label: 'Test pattern & freeze', collapsed: ['Vid#VideoOutputMode', 'Vid#FreezeOutput'] },
];
const surfaceGroup = { 'Input': 'input', 'Format / conversion': 'format', 'Scale / crop / ROI': 'framing', 'Background / matte': 'background', 'Timing / synchronization': 'timing', 'ANC / captions / timecode / VPID': 'anc', 'Test generator': 'test', 'Freeze': 'test' };
const unitGroups = [
  { id: 'reference', label: 'Reference & monitor', surface: 'Global video / reference / monitor', collapsed: ['FrameRateMode', 'GenlockSource'] },
  { id: 'system', label: 'System', surface: 'System configuration', collapsed: [], only: ['ScreenSaverEnable', 'DisplayIntensity', 'FanSpeed'] },
  { id: 'remote', label: 'Remote control & GPI', surface: 'Remote control / GPI', collapsed: [], except: ['Authentication'] },
  { id: 'alarms', label: 'Alarms', surface: 'Alarm configuration', collapsed: [] },
];
const fields = [], seen = new Map();
for (const [id, m] of Object.entries(metadata)) {
  if (m.channel == null || !usable(id)) continue;
  const short = id.replace('eParamID_', ''), template = short.replace(/Vid[0-4]/, 'Vid#');
  if (!template.includes('#')) continue;
  const surface = m.surface.includes(' / ') ? m.surface.slice(m.surface.indexOf(' / ') + 3) : m.surface;
  let group = surfaceGroup[surface];
  if (surface === 'HDR / color / LUT / legalizer') group = template.startsWith('Film_') ? 'film' : template.startsWith('TV_') ? 'tv' : /Vid#(YUV|RGB)ProcAmp/.test(template) ? 'procamp' : 'hdr';
  if (!group) continue;
  const d = descriptors.get(id);
  if (!seen.has(template)) { const field = { id: template, label: d.param_name || short, group, kind: kinds[d.param_type], scope: 'channel', width: width(d.param_name || short, d) }; seen.set(template, field); fields.push(field); }
}
for (const group of unitGroups) for (const [id, m] of Object.entries(metadata)) {
  if (m.channel != null || m.surface !== group.surface || !usable(id)) continue;
  const short = id.replace('eParamID_', '');
  if (group.only && !group.only.includes(short) || group.except?.includes(short)) continue;
  const d = descriptors.get(id);
  fields.push({ id: short, label: d.param_name || short, group: group.id, kind: kinds[d.param_type], scope: 'unit', width: width(d.param_name || short, d) });
}
const groups = [
  ...channelGroups.map(g => ({ id: g.id, label: g.label, scope: 'channel', collapsed: g.collapsed.filter(id => seen.has(id)), fields: fields.filter(f => f.scope === 'channel' && f.group === g.id).map(({ group, scope, ...f }) => f) })),
  ...unitGroups.map(g => ({ id: g.id, label: g.label, scope: 'unit', collapsed: g.collapsed, fields: fields.filter(f => f.scope === 'unit' && f.group === g.id).map(({ group, scope, ...f }) => f) })),
].filter(g => g.fields.length);
await writeFile(new URL('../src/fields.json', import.meta.url), JSON.stringify({ firmware: fixture.firmware, groups }) + '\n');
console.log(groups.map(g => g.scope + ' ' + g.id + ' ' + g.fields.length).join('\n'));
