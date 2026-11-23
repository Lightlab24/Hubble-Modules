import { baseFromSerial, decodeLensParameters, object, validIp, type RecordValue } from './model.js';
import { isRemiModel, remiEntries, type RemiCameraInfo } from './remi-model.js';

const flag = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
export const deviceId = (serial: string) => serial.replace(/[^A-Za-z0-9_.:-]/g, '-');
/**
 * An address element with nothing on it: no interface and no address, and nothing stopping its deletion. A controller
 * reports one as a WAN (a real RCP held one beside its real WAN on Nov 23, 2026: Type WAN, Interface blank, Locked
 * and NoDelete false). What made it isn't known. It does nothing, so it is listed after the LAN addresses, where it
 * can be removed, and it is never taken for the controller's WAN or written to.
 */
export const blankAddress = (row: RecordValue) => !flag(row.ReadOnly) && !flag(row.NoDelete) && !String(row.Interface ?? '').trim() && !String(row.IP ?? '').trim();
/** The controller's WAN setting. A blank address element reads as a WAN too, and isn't one. */
export const wanRow = (row: RecordValue) => String(row.Type ?? '').toUpperCase().includes('WAN') && !blankAddress(row);
/**
 * Which of a controller's address rows is its own base address. A WAN or a LAN address can be set inside 10.192 too
 * (Nov 21, 2026: an RCP's WAN was), and the controller lists its rows in no fixed order, so being in 10.192 says
 * nothing. The serial does: CY-RCP-46-197 is always 10.192.46.197. The controller also marks that row, and only that
 * row, ReadOnly; a WAN is NoDelete without being ReadOnly. A WAN is never the base.
 */
export function baseRow(ips: RecordValue[], serial: string): RecordValue | undefined {
  const factory = baseFromSerial(serial), usable = ips.filter(row => !wanRow(row) && validIp(String(row.IP)));
  return usable.find(row => factory && row.IP === factory)
    ?? usable.find(row => flag(row.ReadOnly) && String(row.IP).startsWith('10.192.'))
    ?? usable.find(row => flag(row.ReadOnly));
}
export function normalizeSnapshot(config: RecordValue, address: string) {
  const product = object(config.Product), serial = String(product.Serial ?? '').trim();
  if (!serial || serial.length > 160) throw new Error('The endpoint did not identify a Cyanview controller');
  const id = deviceId(serial), ips = Object.entries(object(config.IP)).map(([key, raw]) => ({ key, ...object(raw) } as RecordValue));
  const primary = baseRow(ips, serial);
  const secondary = ips.find(row => row !== primary && !flag(row.ReadOnly) && !wanRow(row) && validIp(String(row.IP)));
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
    return { id: `${id}:camera:${key}`, device: id, elementKey: key, number: String(row.Number ?? ''), name: String(row.Name ?? ''), model: name, modelLabel: model, ip: String(row.IP ?? ''), port: String(row.Port ?? ''), login: String(row.Login ?? ''), password: String(row.Password ?? ''), usb: object(row.Interface).port && object(row.Interface).port !== '*' ? String(object(row.Interface).port) : 'USB · Automatic', lens: lens || 'None', lensPort: connection, lensParams: String(row.LensParams ?? ''),
      // Cyanview's own Enabled, separate from Hubble's Camera Control Enabled checkmark. Null when the controller doesn't say.
      cameraEnabled: row.Enabled === undefined || row.Enabled === '' ? null : flag(row.Enabled), ...decodeLensParameters(lens, String(row.LensParams ?? '')), online: null, pending: false, dirty: [], result: 'In sync', revision: 0, isNew: false,
      ...(remi ? { remi } : {}), ...(remiPeer ? { remiPeer } : {}) };
  });
  const lans = ips.map(row => {
    // A WAN on DHCP reads as DHCP whatever address it was given. An address whose mask is still blank shows on its own.
    const ip = String(row.IP ?? ''), mask = String(row.mask ?? '16'), blank = blankAddress(row), type = wanRow(row) ? 'WAN' : 'LAN', dhcp = !blank && flag(row.DHCP);
    const current = type === 'WAN' && dhcp ? 'DHCP' : validIp(ip) ? (mask ? `${ip}/${mask}` : ip) : dhcp ? 'DHCP' : '';
    return { id: `${id}:lan:${row.key}`, device: id, elementKey: row.key, type, iface: String(row.Interface ?? 'LAN1'), current, planned: current, operation: 'Keep', result: 'In sync', dhcp, gateway: String(row.Gateway ?? ''), dns1: String(row.DNS1 ?? ''), dns2: String(row.DNS2 ?? ''), readOnly: flag(row.ReadOnly) || row === primary, noDelete: flag(row.NoDelete), blank, pending: false, dirty: [], revision: 0 };
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
