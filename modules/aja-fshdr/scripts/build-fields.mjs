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
  // A Framing setting the unit gives in % is a slider with its number, so it needs room for both.
  const slider = group === 'framing' && kinds[d.param_type] === 'number' && d.units === '%' && d.min_value != null && d.max_value != null;
  if (!seen.has(template)) { const field = { id: template, label: d.param_name || short, group, kind: kinds[d.param_type], scope: 'channel', width: Math.max(slider ? 200 : 0, width(d.param_name || short, d)), ...(slider ? { slider: true } : {}) }; seen.set(template, field); fields.push(field); }
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

// src/catalog.json: what the worker needs to offer a unit's choices and ranges before it is reached, and to run a simulated
// unit. Every setting a sheet can show, the settings they map onto or depend on, and the bench values from the capture.
// A channel setting that is the same on every channel is stored once, with `Vid#` for the channel.
const forwardMaps = fixture.maps.forward_maps ?? {};
const snapshot = fixture.values ?? {};
const wanted = new Set(['eParamID_FS4Mode', 'eParamID_RemoteControl', 'eParamID_SystemName', ...[0, 1, 2, 3, 4].flatMap(n => ['eParamID_Vid' + n + '_ChannelName', 'eParamID_Vid' + n + 'DetectedInputFormat'])]);
for (const field of fields) if (field.scope === 'channel') for (const n of [0, 1, 2, 3, 4]) wanted.add('eParamID_' + field.id.replace('Vid#', 'Vid' + n)); else wanted.add('eParamID_' + field.id);
for (let size = -1; size !== wanted.size;) {
  size = wanted.size;
  for (const id of [...wanted]) {
    const map = forwardMaps[id];
    if (map) for (const other of [...(map.depends_on ?? []), ...(map.param_maps ?? [])]) if (typeof other === 'string') wanted.add(other);
    for (const list of Object.values(descriptors.get(id)?.relations ?? {})) for (const condition of list ?? []) wanted.add(condition.paramid);
  }
}
const kept = ['param_id', 'param_name', 'param_type', 'enum_values', 'class_names', 'min_value', 'max_value', 'adjust_by', 'scale_by', 'display_precision', 'units', 'min_length', 'max_length', 'relations'];
function trim(d) {
  const out = {};
  for (const key of kept) if (d[key] !== undefined) out[key] = d[key];
  if (out.enum_values) out.enum_values = out.enum_values.map(option => ({ value: option.value, text: option.text }));
  if (out.class_names) { out.class_names = out.class_names.filter(name => name === 'readonly'); if (!out.class_names.length) delete out.class_names; }
  if (out.relations) out.relations = Object.fromEntries(Object.entries(out.relations).filter(([key]) => key === 'enabled_by' || key === 'disabled_by').map(([key, list]) => [key, list.map(({ paramid, value }) => ({ paramid, value }))]));
  return out;
}
const channelOf = id => { const match = /^eParamID_Vid([0-4])(?!\d)/.exec(id); return match ? Number(match[1]) : null; };
const template = (value, n) => JSON.parse(JSON.stringify(value).replaceAll('eParamID_Vid' + n, 'eParamID_Vid#'));
const present = [...wanted].filter(id => descriptors.has(id)).sort();
const catalog = { firmware: fixture.firmware, descriptors: [], maps: {}, values: {} };
const byTemplate = new Map();
for (const id of present) {
  const n = channelOf(id);
  if (n === null) { catalog.descriptors.push(trim(descriptors.get(id))); continue; }
  const key = id.replace('eParamID_Vid' + n, 'eParamID_Vid#');
  if (!byTemplate.has(key)) byTemplate.set(key, []);
  byTemplate.get(key).push(n);
}
const rawValue = id => String(snapshot[id] ?? descriptors.get(id).default_value ?? '');
for (const id of present) if (channelOf(id) === null) { catalog.values[id] = rawValue(id); if (forwardMaps[id]) catalog.maps[id] = forwardMaps[id]; }
for (const [key, channels] of byTemplate) {
  const ids = channels.map(n => key.replace('eParamID_Vid#', 'eParamID_Vid' + n));
  const shapes = channels.map((n, i) => JSON.stringify(template(trim(descriptors.get(ids[i])), n)));
  const mapShapes = channels.map((n, i) => JSON.stringify(forwardMaps[ids[i]] ? template(forwardMaps[ids[i]], n) : null));
  if (new Set(shapes).size === 1 && new Set(mapShapes).size === 1) {
    catalog.descriptors.push({ ...JSON.parse(shapes[0]), channels });
    if (mapShapes[0] !== 'null') catalog.maps[key] = JSON.parse(mapShapes[0]);
  } else ids.forEach((id, i) => { catalog.descriptors.push(trim(descriptors.get(id))); if (forwardMaps[id]) catalog.maps[id] = forwardMaps[id]; });
  const values = ids.map(rawValue);
  catalog.values[key] = new Set(values).size === 1 ? values[0] : Object.fromEntries(channels.map((n, i) => [n, values[i]]));
}
await writeFile(new URL('../src/catalog.json', import.meta.url), JSON.stringify(catalog) + '\n');
console.log('catalog ' + present.length + ' settings in ' + catalog.descriptors.length + ' entries');
