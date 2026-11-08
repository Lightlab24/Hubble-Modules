import { decodeLensParameters, object, validIp, type RecordValue } from './model.js';
import { isRemiModel, remiEntries, type RemiCameraInfo } from './remi-model.js';

const flag = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
export const deviceId = (serial: string) => serial.replace(/[^A-Za-z0-9_.:-]/g, '-');
export function normalizeSnapshot(config: RecordValue, address: string) {
  const product = object(config.Product), serial = String(product.Serial ?? '').trim();
  if (!serial || serial.length > 160) throw new Error('The endpoint did not identify a Cyanview controller');
  const id = deviceId(serial), ips = Object.entries(object(config.IP)).map(([key, raw]) => ({ key, ...object(raw) } as RecordValue));
  const primary = ips.find(row => (flag(row.ReadOnly)||flag(row.NoDelete)) && validIp(String(row.IP)) && String(row.IP).startsWith('10.192.')) ?? ips.find(row=>validIp(String(row.IP))&&String(row.IP).startsWith('10.192.'));
  const secondary = ips.find(row => !flag(row.ReadOnly) && String(row.Type).toUpperCase().includes('LAN') && validIp(String(row.IP)));
  const productName=String(product.Name).toUpperCase();
  const device: RecordValue = { id, serial, name: serial, kind: productName.includes('RIO') ? 'RIO' : productName.includes('GATEWAY')||productName.includes('GWY')?'Gateway':'RCP', base: primary?.IP ?? address, address, alias: secondary?.IP ?? '', interfaces:[...new Set(ips.map(row=>String(row.Interface??'')).filter(Boolean))],online: true, lastSeen: new Date().toISOString(), capacity: product.MaxCam ?? null };
  const imports = new Map(remiEntries(config).filter(entry => entry.enabled && entry.localKey).map(entry => [entry.localKey, entry]));
  const cameras = Object.entries(object(config.Camera)).map(([key, raw]) => {
    const row = object(raw), model = String(row.Model ?? ''), lens = String(row.LensModel ?? ''), lensInterface = object(row.LensInterface), connection = lensInterface.device && lensInterface.port ? `${lensInterface.device} : ${lensInterface.port}` : 'None';
    const name = model.replace(/^Sony\s*-\s*/, '');
    const assignment = imports.get(key);
    const remi: RemiCameraInfo | undefined = assignment && {
      peer: assignment.peer, selector: assignment.selector, connection: assignment.connection, label: assignment.label,
    };
    const remiPeer = isRemiModel(model) ? /^\(D\)(cy-[a-z0-9-]+)$/i.exec(String(object(row.Interface).device ?? ''))?.[1] : undefined;
    return { id: `${id}:camera:${key}`, device: id, elementKey: key, number: String(row.Number ?? ''), name: String(row.Name ?? ''), model: name, modelLabel: model, ip: String(row.IP ?? ''), port: String(row.Port ?? ''), login: String(row.Login ?? ''), password: String(row.Password ?? ''), usb: object(row.Interface).port && object(row.Interface).port !== '*' ? String(object(row.Interface).port) : 'USB · Automatic', lens: lens || 'None', lensPort: connection, lensParams: String(row.LensParams ?? ''), ...decodeLensParameters(lens, String(row.LensParams ?? '')), online: null, pending: false, dirty: [], result: 'In sync', revision: 0, isNew: false,
      ...(remi ? { remi } : {}), ...(remiPeer ? { remiPeer } : {}) };
  });
  const lans = ips.map(row => {
    const ip = String(row.IP ?? ''), mask = String(row.mask ?? '16'), dhcp = flag(row.DHCP), current = validIp(ip) ? `${ip}/${mask}` : dhcp ? 'DHCP' : '';
    return { id: `${id}:lan:${row.key}`, device: id, elementKey: row.key, type: String(row.Type ?? 'LAN').toUpperCase().includes('WAN') ? 'WAN' : 'LAN', iface: String(row.Interface ?? 'LAN1'), current, planned: current, operation: 'Keep', result: 'In sync', dhcp, gateway: String(row.Gateway ?? ''), dns1: String(row.DNS1 ?? ''), dns2: String(row.DNS2 ?? ''), readOnly: flag(row.ReadOnly), noDelete: flag(row.NoDelete), pending: false, dirty: [], revision: 0 };
  });
  return { device, cameras, lans };
}
export function optionEntries(value: unknown): { label: string; request: RecordValue | any[]; description?: RecordValue }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!Array.isArray(entry) || entry.length < 2 || !entry[1] || typeof entry[1] !== 'object') return [];
    const description = typeof entry[0] === 'object' ? object(entry[0]) : undefined;
    const label = description ? description.device && description.port ? `${description.device} : ${description.port}` : String(description.name ?? description.label ?? '') : String(entry[0]);
    return [{ label, request: entry[1], ...(description ? { description } : {}) }];
  });
}
