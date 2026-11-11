import type { ModuleJsonValue } from '@hubble/module-sdk';
export type RecordValue = Record<string, any>;
export type Plan = { formatVersion: 1; devices: RecordValue[]; cameras: RecordValue[]; lans: RecordValue[]; uiState: RecordValue | null };
export const emptyPlan = (): Plan => ({ formatVersion: 1, devices: [], cameras: [], lans: [], uiState: null });
export const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const json = (value: unknown): ModuleJsonValue => JSON.parse(JSON.stringify(value));
/** Each of these runs its own MQTT broker, which is watched and takes camera commands. A Gateway works like an RCP. */
export const controlDevice = (device: RecordValue) => ['RCP', 'RIO', 'Gateway'].includes(device.kind);
/** Select camera changes the active camera on an RCP panel, which an RCP or a Gateway reports. */
export const selectsCamera = (device: RecordValue) => ['RCP', 'Gateway'].includes(device.kind);
/** A controller's name and serial, or the serial alone while the name is still the serial it was added with. */
export const controllerLabel = (device: RecordValue) => {
  const serial = String(device.serial ?? ''), name = String(device.name ?? '').trim();
  return name && name !== serial ? `${name} · ${serial}` : serial;
};
export const validIp = (address: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && address.split('.').every(part => Number(part) <= 255);
export function addressParts(value: string) {
  const parts = value.split('/'), [ip, prefix] = parts;
  if (parts.length !== 2 || !validIp(ip ?? '') || !/^\d{1,2}$/.test(prefix ?? '') || Number(prefix) > 32) throw new Error('Enter a valid address and prefix, such as 10.20.101.200/16');
  return { ip: ip!, mask: String(Number(prefix)) };
}
export function validatePlan(value: unknown): Plan {
  const data = object(value);
  if (data.formatVersion !== 1 || !Array.isArray(data.devices) || !Array.isArray(data.cameras) || !Array.isArray(data.lans)) throw new Error('Invalid configuration format');
  if (data.devices.length > 128 || data.cameras.length > 512 || data.lans.length > 1024) throw new Error('Configuration capacity exceeded');
  const unique = (rows: RecordValue[], label: string) => {
    if (rows.some(row => !row || typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.id)) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`Invalid ${label} identities`);
  };
  unique(data.devices, 'controller'); unique(data.cameras, 'camera'); unique(data.lans, 'network row');
  const ids = new Set(data.devices.map((device: RecordValue) => device.id));
  if ([...data.cameras, ...data.lans].some(row => !ids.has(row.device))) throw new Error('A row refers to an unknown controller');
  for (const device of data.devices) if (!validIp(device.address || device.base || '')) throw new Error('A controller has an invalid address');
  if (JSON.stringify(data).length > 2_000_000) throw new Error('Configuration exceeds the module storage budget');
  return json({ ...data, uiState: data.uiState ?? null }) as unknown as Plan;
}
export function stripEphemeral(row: RecordValue): RecordValue {
  const { jobs, ...saved } = row;
  return json(saved) as RecordValue;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as RecordValue)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const normalizedLabel = (label: unknown) => String(label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lensAxes = ['iris', 'zoom', 'focus'] as const;
type LensAxis = typeof lensAxes[number];
const tiltaCodes = { iris: 'I', zoom: 'Z', focus: 'F' };
const positiveMotorId = (value: unknown) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
// Open is below Closed. A Tilta motor has no direction setting, so its iris is reversed by entering
// them the other way round, and for it either order is a range.
const validIrisRange = (values: RecordValue, eitherWay = false) => {
  const open = Number(values.irisMin), closed = Number(values.irisMax);
  if (!(open > 0) || !Number.isFinite(open) || !Number.isFinite(closed)) return false;
  return eitherWay ? closed > 0 && closed !== open : closed > open;
};
const validMotorSettings = (axis: LensAxis, values: RecordValue) =>
  ['1', '2', '3', '4'].includes(String(values[axis + 'Torque'])) && ['left', 'right'].includes(values[axis + 'Direction']);
export const supportsLensParameters = (lens: string) => lens === 'Tilta - Nucleus-M' || lens === 'ARRI - cforce';

function parseLensParameters(lens: string, parameters: string) {
  const blocks = new Map<LensAxis, { text: string; values: RecordValue }>();
  const tilta = lens === 'Tilta - Nucleus-M';
  for (const text of parameters ? parameters.split(',') : []) {
    const parts = text.split(':');
    const axis = lensAxes.find(axis => tilta ? parts[1] === tiltaCodes[axis] : parts[axis === 'iris' ? 2 : 0] === axis);
    if (!axis || blocks.has(axis)) return null;
    const iris = axis === 'iris', values: RecordValue = {};
    if (tilta) {
      if (!positiveMotorId(parts[0]) || !(parts.length === 2 || iris && parts.length === 4)) return null;
      values[axis + 'Motor'] = parts[0];
      if (iris) [values.irisMin, values.irisMax] = parts.length === 2 ? ['1.6', '32'] : parts.slice(2);
    } else {
      if (parts.length !== (iris ? 5 : 3)) return null;
      [values[axis + 'Torque'], values[axis + 'Direction']] = parts.slice(iris ? 3 : 1);
      if (!validMotorSettings(axis, values)) return null;
      if (iris) [values.irisMin, values.irisMax] = parts;
    }
    if (iris && !validIrisRange(values, tilta)) return null;
    blocks.set(axis, { text, values });
  }
  return blocks;
}

export function decodeLensParameters(lens: string, parameters: string): RecordValue {
  if (!supportsLensParameters(lens)) return {};
  const blocks = parseLensParameters(lens, parameters);
  if (!blocks) return { lensParamsEditable: false };
  return Object.assign({ lensParamsEditable: true }, ...Array.from(blocks.values(), block => block.values));
}

export function lensParameters(camera: RecordValue, fields: readonly string[], current: string): string | undefined {
  if (!supportsLensParameters(camera.lens)) return undefined;
  const tilta = camera.lens === 'Tilta - Nucleus-M';
  const edits = lensAxes.map(axis => ({
    axis,
    settings: [...(tilta ? [axis + 'Motor'] : [axis + 'Torque', axis + 'Direction']), ...(axis === 'iris' ? ['irisMin', 'irisMax'] : [])],
  })).filter(({ settings }) => settings.some(field => fields.includes(field)));
  if (!edits.length) return undefined;
  const blocks = parseLensParameters(camera.lens, current);
  if (!blocks) throw new Error('Existing advanced lens parameters need a separate capture before editing');
  for (const { axis, settings } of edits) {
    // The controller can't hold part of an entry, so a deleted setting takes the entry with it.
    // A Tilta iris is the exception: its limits are optional, so it can keep the motor.
    if (settings.some(field => fields.includes(field) && !camera[field])) {
      if (tilta && axis === 'iris' && positiveMotorId(camera.irisMotor)) blocks.set(axis, { text: `${camera.irisMotor}:${tiltaCodes.iris}`, values: { irisMotor: camera.irisMotor } });
      else blocks.delete(axis);
      continue;
    }
    const observed = blocks.get(axis)?.values;
    const values = Object.fromEntries(settings.map(field => [field, !observed || fields.includes(field) ? camera[field] : observed[field]]));
    if (axis === 'iris' && !validIrisRange(values, tilta)) throw new Error('Enter valid iris limits');
    const range = axis === 'iris' ? `${values.irisMin}:${values.irisMax}` : '';
    let text;
    if (tilta) {
      if (!positiveMotorId(values[axis + 'Motor'])) throw new Error('Use a positive motor ID');
      text = `${values[axis + 'Motor']}:${tiltaCodes[axis]}${range ? ':' + range : ''}`;
    } else {
      if (!validMotorSettings(axis, values)) throw new Error('Choose valid torque and direction values');
      text = `${range ? range + ':' : ''}${axis}:${values[axis + 'Torque']}:${values[axis + 'Direction']}`;
    }
    blocks.set(axis, { text, values });
  }
  if (tilta && new Set(Array.from(blocks, ([axis, block]) => Number(block.values[axis + 'Motor']))).size !== blocks.size) throw new Error('Use distinct motor IDs for the configured axes');
  return Array.from(blocks.values(), block => block.text).join(',');
}
