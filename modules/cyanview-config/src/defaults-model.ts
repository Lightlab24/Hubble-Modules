// Defaults: what a device or camera is named and addressed when it is added or given a new number.
// Names and addresses are patterns with wildcards between % signs: %number% is the device's or
// camera's number and %type% a camera's type. In an address the number fills its part of the
// address out to three digits with the digits beside it, so 10.20.101.1%number% makes 5 into
// 10.20.101.105 and 21 into 10.20.101.121, and 10.20.101.%number% makes 21 into 10.20.101.21
// (asked for Nov 21, 2026). The page and the worker share these, so both read a pattern the same way.

export const deviceKinds = ['RCP', 'RIO', 'Gateway'] as const;
export type DeviceKind = typeof deviceKinds[number];
export type DeviceKindDefaults = { name: string; lan: string; mask: string };
export type CameraDefaults = { name: string; ip: string; login: string; rioNumber: boolean };
export type CyanviewDefaults = { devices: Record<DeviceKind, DeviceKindDefaults>; camera: CameraDefaults };

/** The highest number a device or camera can be given. An address can't hold more than three digits of it. */
export const highestNumber = 999;
const numberToken = /%number%/gi, typeToken = /%type%/gi;
const patternLimit = 160;

/** What a workspace starts with: the naming and addresses used on the user's own rigs. */
export const initialDefaults = (): CyanviewDefaults => ({
  devices: {
    RCP: { name: 'RCP %number%', lan: '10.20.101.2%number%', mask: '16' },
    RIO: { name: 'Cam %number%', lan: '10.20.101.1%number%', mask: '16' },
    Gateway: { name: 'Gateway %number%', lan: '', mask: '16' },
  },
  camera: { name: '%type% %number%', ip: '10.20.100.1%number%', login: 'admin', rioNumber: true },
});

const text = (value: unknown) => typeof value === 'string' && value.length <= patternLimit;
const mask = (value: unknown) => typeof value === 'string' && (value === '' || /^\d{1,2}$/.test(value) && Number(value) <= 32);

/** Reads saved defaults. Missing means a workspace saved before Defaults existed; anything else malformed is refused. */
export function validateDefaults(value: unknown): CyanviewDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  const fail = () => { throw new Error('Invalid defaults'); };
  if (typeof value !== 'object' || Array.isArray(value)) fail();
  const data = value as Record<string, any>, devices = data.devices, camera = data.camera;
  if (!devices || typeof devices !== 'object' || !camera || typeof camera !== 'object') fail();
  const result = initialDefaults();
  for (const kind of deviceKinds) {
    const row = devices[kind];
    if (!row || typeof row !== 'object' || !text(row.name) || !text(row.lan) || !mask(row.mask)) fail();
    result.devices[kind] = { name: row.name, lan: row.lan, mask: row.mask };
  }
  if (!text(camera.name) || !text(camera.ip) || !text(camera.login) || typeof camera.rioNumber !== 'boolean') fail();
  result.camera = { name: camera.name, ip: camera.ip, login: camera.login, rioNumber: camera.rioNumber };
  return result;
}

/** A name from its pattern. Spaces left by an empty wildcard are tidied away. */
export function fillName(pattern: string, values: { number: number | string; type?: string }): string {
  return String(pattern ?? '').replace(numberToken, String(values.number)).replace(typeToken, values.type ?? '').replace(/\s+/g, ' ').trim();
}

export type FilledAddress = { address: string; problem: string };
/**
 * An address from its pattern. A pattern with no %number% is one fixed address. The part holding
 * %number% is three digits: the digits beside the wildcard stay, and the number fills the rest,
 * padded with zeros. A number with more digits than that, or a part over 255, gives no address and
 * says why. Leading zeros are dropped from what is sent, because some devices read 021 as octal.
 */
export function fillAddress(pattern: string, number: number): FilledAddress {
  const source = String(pattern ?? '').trim();
  if (!source) return { address: '', problem: '' };
  if ((source.match(numberToken) ?? []).length > 1) return { address: '', problem: 'Use %number% once in an address' };
  const parts = source.split('.');
  if (parts.length !== 4) return { address: '', problem: 'An address has four parts, such as 10.20.101.1%number%' };
  const filled: number[] = [];
  for (const part of parts) {
    if (!/%number%/i.test(part)) {
      if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return { address: '', problem: 'Each part of an address is a number from 0 to 255' };
      filled.push(Number(part));
      continue;
    }
    const [before = '', after = ''] = part.split(/%number%/i);
    if (!/^\d*$/.test(before) || !/^\d*$/.test(after) || before.length + after.length > 2) return { address: '', problem: 'Put at most two digits beside %number% in an address' };
    const room = 3 - before.length - after.length, digits = String(Math.trunc(number));
    if (!Number.isInteger(number) || number < 0 || digits.length > room) return { address: '', problem: number + ' doesn’t fit in ' + part };
    const value = Number(before + digits.padStart(room, '0') + after);
    if (value > 255) return { address: '', problem: number + ' makes ' + value + ', past 255' };
    filled.push(value);
  }
  return { address: filled.join('.'), problem: '' };
}

/** What is wrong with an address pattern itself, whatever number goes into it. Number 1 always fits a good one. */
export function addressPatternProblem(pattern: string): string {
  return fillAddress(pattern, 1).problem;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The number in a name made by this pattern, such as 14 in "Cam 14" for "Cam %number%". Anything else gives null. */
export function numberFromName(pattern: string, name: string): number | null {
  const source = String(pattern ?? '').trim();
  if ((source.match(numberToken) ?? []).length !== 1) return null;
  const expression = source.split(/(%number%|%type%)/i).map(piece => /^%number%$/i.test(piece) ? '(\\d{1,3})' : /^%type%$/i.test(piece) ? '.*?' : escapeRegExp(piece).replace(/\s+/g, '\\s+')).join('');
  const match = new RegExp('^\\s*' + expression + '\\s*$', 'i').exec(String(name ?? ''));
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= highestNumber ? value : null;
}

/** The first number in a name, for a device named before it had one: "Cam 6 Tally" is 6. */
export function firstNumberIn(name: string): number | null {
  const match = /(\d{1,3})/.exec(String(name ?? ''));
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= highestNumber ? value : null;
}

/** A device's number, if it has a usable one. */
export function deviceNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= highestNumber ? number : null;
}
