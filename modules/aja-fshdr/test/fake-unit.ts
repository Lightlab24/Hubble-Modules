import http from 'node:http';
import { once } from 'node:events';

// A small stand-in for an FS-HDR: the same REST calls, a handful of settings, and no video.
const enumOf = (...texts: string[]) => texts.map((text, value) => ({ value, text }));
const transforms = [{ value: 0, text: 'Colorfront Engine-Live' }, { value: 1, text: 'BBC HLG LUT' }, { value: 3, text: 'Dynamic LUT' }, { value: 4, text: 'Off' }, { value: 8, text: 'Colorfront Engine-TV' }];
export interface FakeUnit { host: string; values: Record<string, string>; writes: { id: string; value: string }[]; ignoreWrites: boolean; change(id: string, value: string): void; close(): Promise<void> }
export async function fakeUnit(options: { name?: string; mode?: '1' | '2' } = {}): Promise<FakeUnit> {
  const mode = options.mode ?? '1', channels = mode === '1' ? [1, 2, 3, 4] : [0];
  const descriptors: Record<string, unknown>[] = [
    { param_id: 'eParamID_SystemName', param_name: 'System Name', param_type: 'string', min_length: 1, max_length: 20, class_names: ['network_config'] },
    { param_id: 'eParamID_FS4Mode', param_name: 'Operating Mode', param_type: 'enum', enum_values: [{ value: 1, text: 'HD/SD 4 Ch' }, { value: 2, text: '4K/UHD 1 Ch' }] },
    { param_id: 'eParamID_RemoteControl', param_name: 'Remote Control', param_type: 'enum', enum_values: enumOf('Local and Remote', 'Local Only', 'Remote Only') },
    { param_id: 'eParamID_FrameRateMode', param_name: 'Output Frame Rate', param_type: 'enum', enum_values: enumOf('59/29/23', '50/25', '60/30/24') },
    { param_id: 'eParamID_GenlockSource', param_name: 'Genlock source', param_type: 'enum', enum_values: enumOf('Reference', 'Free Run') },
  ];
  const values: Record<string, string> = { eParamID_SystemName: options.name ?? 'Bench', eParamID_FS4Mode: mode, eParamID_RemoteControl: '0', eParamID_FrameRateMode: '0', eParamID_GenlockSource: '0' };
  const maps: Record<string, unknown> = {};
  for (const n of channels) {
    const id = (suffix: string) => 'eParamID_Vid' + n + suffix;
    descriptors.push(
      { param_id: id('_ChannelName'), param_name: 'Channel Name', param_type: 'string', min_length: 1, max_length: 9 },
      { param_id: id('ColorHDRTransform'), param_name: 'Transform', param_type: 'enum', enum_values: transforms },
      { param_id: id('DetectedInputFormat'), param_name: 'Detected Input Format', param_type: 'enum', class_names: ['readonly'], enum_values: enumOf('No Input', '1080p 23.98') },
      { param_id: id('CustomSizePos'), param_name: 'Custom Size/Pos', param_type: 'enum', enum_values: enumOf('Off', 'On') },
      { param_id: id('CustomSize'), param_name: 'Custom Size', param_type: 'decimal', min_value: 100, max_value: 2000, adjust_by: 1, scale_by: 10, display_precision: 1, units: '%', relations: { enabled_by: [{ paramid: id('CustomSizePos'), value: 1 }] } },
      // Output Format is stored once per frame-rate family; the logical ID maps onto the one in use.
      { param_id: id('OutputFormat'), param_name: 'Output Format', param_type: 'enum', enum_values: enumOf('Follow INPUT', '1080p2398') },
      { param_id: id('OutputFormat_5923'), param_name: 'Output Format', param_type: 'enum', enum_values: enumOf('Follow INPUT', '1080p2398') },
      { param_id: id('OutputFormat_5025'), param_name: 'Output Format', param_type: 'enum', enum_values: enumOf('Follow INPUT', '1080p25') },
      { param_id: id('OutputFormat_6024'), param_name: 'Output Format', param_type: 'enum', enum_values: enumOf('Follow INPUT', '1080p24') },
    );
    maps[id('OutputFormat')] = { map_scheme: 1, depends_on: ['eParamID_FrameRateMode'], param_maps: [id('OutputFormat_5923'), id('OutputFormat_5025'), id('OutputFormat_6024')] };
    Object.assign(values, { [id('_ChannelName')]: n === 0 ? 'UHD' : 'Video ' + n, [id('ColorHDRTransform')]: '3', [id('DetectedInputFormat')]: '1', [id('CustomSizePos')]: '0', [id('CustomSize')]: '1000', [id('OutputFormat_5923')]: '1', [id('OutputFormat_5025')]: '0', [id('OutputFormat_6024')]: '0' });
  }
  const strings = new Set(descriptors.filter(d => d.param_type === 'string').map(d => d.param_id as string));
  const queue: Record<string, string>[] = [], waiting = new Set<() => void>();
  const fake = { host: '', values, writes: [] as { id: string; value: string }[], ignoreWrites: false,
    change(id: string, value: string) { values[id] = value; queue.push({ param_id: id, param_type: strings.has(id) ? '12' : '4', int_value: strings.has(id) ? '0' : value, str_value: value }); for (const wake of [...waiting]) wake(); },
    async close() { for (const wake of [...waiting]) wake(); server.closeAllConnections(); server.close(); await once(server, 'close'); } };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1'), json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/desc.json') return json(descriptors);
    if (url.pathname === '/map.json') return json({ forward_maps: maps, reverse_maps: {} });
    if (url.pathname !== '/config') return json({}, 404);
    const action = url.searchParams.get('action'), id = url.searchParams.get('paramid') ?? '';
    if (action === 'connect') { queue.length = 0; return json({ connectionid: 1, configevents: [{ ...values }] }); }
    if (action === 'wait_for_config_events') {
      if (!queue.length) await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); waiting.delete(finish); resolve(); }; const timer = setTimeout(finish, 250); waiting.add(finish); });
      return json(queue.splice(0));
    }
    if (action === 'get') return id in values ? json({ name: id, value: values[id] }) : json({}, 404);
    if (action === 'set') { const value = url.searchParams.get('value') ?? ''; fake.writes.push({ id, value }); if (!fake.ignoreWrites) fake.change(id, value); return json({ name: id, value }); }
    return json({}, 400);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fake.host = '127.0.0.1:' + (server.address() as { port: number }).port;
  return fake;
}
