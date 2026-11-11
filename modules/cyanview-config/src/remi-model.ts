import { object, validIp, type RecordValue } from './model.js';

export type RemiCamera = { key: string; number: string; name: string };
export type RemiEntry = {
  importer: string; connection: string; address: string; manual: boolean;
  peer: string; connected: boolean; selector: string; label: string; localKey: string | null; enabled: boolean;
};
export type RemiSelector = { connection: string; deviceId: string };
export type RemiOrigin = { serial: string; model: string };
export type RemiCameraInfo = {
  peer: string; selector: string; connection: string; label?: string; sourceKey?: string; origin?: RemiOrigin;
};
export type RemiLink = {
  source: string; sourceKey: string; receiver: string; entry: RemiEntry;
};
export type RemiStep = RemiLink & { parent: number; phase: 'attached' | 'removing' | 'removed' | 'adding' | 'done'; next?: RemiEntry };
export type RemiRefresh = { source: string; camera: RemiCamera; before: RemiCamera; steps: RemiStep[] | null };
export type RemiData = {
  links: RemiLink[];
  refreshes: RemiRefresh[];
  creates: { receiver: string; address: string; key?: string }[];
};

export const remiOn = (value: unknown) => value === '1' || value === 1 || value === true;
export const isRemiModel = (value: unknown) => typeof value === 'string' && /^cyan\s*-\s*imported$/i.test(value.trim());
export function remiCamera(key: string, config: RecordValue): RemiCamera {
  const row = config.Camera?.[key];
  if (!row) throw new Error('Camera is no longer on the source controller');
  return { key, number: String(row.Number ?? ''), name: String(row.Name ?? '') };
}
export const remiLabel = (camera: RemiCamera) => (camera.number + ' ' + camera.name).trim();
export const samePeer = (name: string, device: RecordValue) => name.toLowerCase() === String(device.serial).toLowerCase();
export function remiAddresses(device: RecordValue, config: RecordValue = {}): string[] {
  return [...new Set([device.address, device.base, device.alias, ...(Array.isArray(device.addresses) ? device.addresses : []),
    ...Object.values(object(config.IP)).map(row => object(row).IP)]
    .filter((address): address is string => typeof address === 'string' && validIp(address)))];
}
export function remiEntries(config: RecordValue): RemiEntry[] {
  const entries: RemiEntry[] = [];
  for (const [importer, raw] of Object.entries(object(config.Remi))) {
    const row = object(raw);
    for (const [connection, rawConnection] of Object.entries(object(row.Connections))) {
      const peer = object(rawConnection);
      for (const camera of Array.isArray(peer.cameras) ? peer.cameras : []) {
        if (!Array.isArray(camera) || typeof camera[3] !== 'string' || !camera[3]) continue;
        entries.push({
          importer, connection, address: String(row.IP ?? ''), manual: row.Type === 'LAN_manual',
          peer: String(peer.name ?? ''), connected: remiOn(peer.connected),
          selector: camera[3], label: String(camera[0] ?? ''),
          localKey: typeof camera[1] === 'string' && camera[1] ? camera[1] : null, enabled: remiOn(camera[2]),
        });
      }
    }
  }
  return entries;
}
export function remiTagRelay(config: RecordValue) {
  const relays = Object.entries(object(config.Remi)).map(([key, value]) => [key, object(value)] as const)
    .filter(([, row]) => row.Type === 'Relay' && Array.isArray(row.Tags));
  if (relays.length !== 1) return null;
  const [key, row] = relays[0]!;
  if (!row.Tags.every((tag: unknown) => typeof tag === 'string' && !tag.includes(','))) return null;
  return { key, tags: row.Tags as string[] };
}

export function describeRemiOrigins(rows: RecordValue[], available: RecordValue[], saved: RecordValue[],
  devices: RecordValue[], links: RemiLink[]) {
  const key = (device: string, camera: string) => JSON.stringify([device, camera]);
  const byCamera = new Map(available.filter(row => row.elementKey).map(row => [key(row.device, row.elementKey), row]));
  const savedByCamera = new Map(saved.filter(row => row.elementKey).map(row => [key(row.device, row.elementKey), row]));
  const byAssignment = new Map(links.filter(link => link.entry.localKey)
    .map(link => [key(link.receiver, link.entry.localKey!), link]));
  const bySerial = new Map(devices.map(device => [String(device.serial).toLowerCase(), device]));
  const byDevice = new Map(devices.map(device => [device.id, device]));

  function originOf(row: RecordValue, visited: Set<string>): RemiOrigin | undefined {
    const rowKey = key(row.device, row.elementKey);
    if (visited.has(rowKey)) return;
    visited.add(rowKey);
    const info = row.remi as RemiCameraInfo | undefined;
    if (!info) {
      const model = String(row.modelLabel || row.model || '').replace(/^Sony\s*-\s*/, '');
      const serial = byDevice.get(row.device)?.serial;
      if (serial && model && !isRemiModel(model) && !isRemiModel(row.modelLabel)) return { serial, model };
      return;
    }
    const peer = bySerial.get(String(info.peer ?? '').toLowerCase());
    const receipt = byAssignment.get(rowKey);
    const verified = receipt && receipt.source === peer?.id && receipt.entry.peer === info.peer &&
      receipt.entry.selector === info.selector && receipt.entry.connection === info.connection;
    const sourceKey = verified ? receipt.sourceKey : info.sourceKey;
    // The All Cameras view folds each copy into the camera it came from, so it needs the source's key.
    if (verified) info.sourceKey = receipt.sourceKey;
    if (peer && sourceKey) {
      const source = byCamera.get(key(peer.id, sourceKey));
      const origin = source && originOf(source, visited);
      if (origin) return origin;
    } else if (peer && info.label) {
      const candidates = available.filter(source => source.device === peer.id && source.elementKey &&
        remiLabel({ key: source.elementKey, number: String(source.number), name: String(source.name) }) === info.label);
      if (candidates.length === 1) info.sourceKey = candidates[0]!.elementKey;
      const origin = candidates.length === 1 && originOf(candidates[0]!, visited);
      if (origin) return origin;
    }
    const cached = savedByCamera.get(rowKey)?.remi as RemiCameraInfo | undefined;
    if (cached?.peer === info.peer && cached.selector === info.selector && cached.connection === info.connection &&
      (!info.sourceKey || !cached.sourceKey || cached.sourceKey === info.sourceKey) &&
      cached.origin?.model && !isRemiModel(cached.origin.model)) return cached.origin;
    return undefined;
  }

  const origins = rows.filter(row => row.remi).map(row => ({ row, origin: originOf(row, new Set()) }));
  for (const { row, origin } of origins) {
    if (origin) row.remi.origin = origin;
    else delete row.remi.origin;
  }
}
