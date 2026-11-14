import { channelRowId, fieldById, masterRowId, masterSelection, nameField, parseRowId, rowValues, type Field, type FsDocument, type SheetKind, type Unit } from './model.js';
import type { Observed, RowObservation, UnitObservation } from './backend.js';
import type { Choice } from './device.js';

/** What a sheet row stands for. A unit that hasn't been read yet has no channels, so it gets one blank `placeholder` row. */
export interface Row { id: string; unit?: Unit; channel: number | null; kind: 'unit' | 'channel' | 'placeholder' | 'master' }
export const hostOf = (unit: Unit): string => unit.values['unit-host'] ?? '';
/** What the worker last saw of this unit, unless the address has been edited since. */
export const unitObservation = (observed: Observed, unit: Unit): UnitObservation | undefined => { const seen = observed.units[unit.id]; return seen?.host === hostOf(unit) ? seen : undefined; };
export const isLive = (observed: Observed, unit: Unit): boolean => unitObservation(observed, unit)?.state === 'live';
export const rowObservation = (observed: Observed, unit: Unit | undefined, rowId: string): RowObservation | undefined => unit && isLive(observed, unit) ? observed.rows[rowId] : undefined;
/** The name to show: one waiting to be sent, else the unit's own, else the one kept in the plan for when it is offline. */
export const shownName = (observed: Observed, unit: Unit): string => unit.values[nameField.id] || (isLive(observed, unit) && unitObservation(observed, unit)!.name) || unit.values['unit-name'] || '';
/** The 4K/UHD channel uses the first input label. */
export const labelFieldOf = (channel: number): string => 'ChannelName' + (channel === 0 ? 1 : channel);
export const shownLabel = (observed: Observed, unit: Unit, channel: number): string => unit.values[labelFieldOf(channel)] || rowObservation(observed, unit, unit.id)?.values[labelFieldOf(channel)] || '';
export function rowsFor(doc: FsDocument, observed: Observed, kind: SheetKind): Row[] {
  if (kind === 'setup') return doc.units.map(unit => ({ id: unit.id, unit, channel: null, kind: 'unit' as const }));
  const rows = doc.units.flatMap((unit): Row[] => {
    const channels = unitObservation(observed, unit)?.channels ?? [];
    return channels.length ? channels.map(channel => ({ id: channelRowId(unit.id, channel), unit, channel, kind: 'channel' as const })) : [{ id: unit.id + '#-', unit, channel: null, kind: 'placeholder' as const }];
  });
  return kind === 'master' ? [{ id: masterRowId, channel: null, kind: 'master' }, ...rows] : rows;
}
/** The channel rows the Master tab is editing: ticked, and on a unit that is live now. */
export const masterRows = (doc: FsDocument, observed: Observed): Row[] => { const ticked = new Set(masterSelection(doc)); return rowsFor(doc, observed, 'channels').filter(row => row.kind === 'channel' && ticked.has(row.id)); };
export const stagedFields = (doc: FsDocument, rowId: string): Field[] => Object.entries(rowValues(doc, rowId) ?? {}).flatMap(([id, value]) => value && fieldById.has(id) ? [fieldById.get(id)!] : []);
/** Staged settings the unit doesn't already have. */
export function pendingFields(doc: FsDocument, observed: Observed, rowId: string): Field[] {
  const unit = doc.units.find(item => item.id === parseRowId(rowId).unitId), values = rowValues(doc, rowId) ?? {}, seen = rowObservation(observed, unit, rowId);
  return stagedFields(doc, rowId).filter(field => values[field.id] !== seen?.values[field.id]);
}
/** Every row that can hold staged settings, units first within each FS-HDR. */
export const stagedRowIds = (doc: FsDocument): string[] => doc.units.flatMap(unit => [unit.id, ...Object.keys(unit.channels ?? {}).sort().map(channel => channelRowId(unit.id, Number(channel)))]);
export function rowTitle(doc: FsDocument, observed: Observed, rowId: string): string {
  const { unitId, channel } = parseRowId(rowId), unit = doc.units.find(item => item.id === unitId);
  if (!unit) return 'FS-HDR';
  const name = shownName(observed, unit) || 'FS-HDR';
  return channel === null ? name : name + ' · ' + (shownLabel(observed, unit, channel) || (channel === 0 ? '4K/UHD' : 'Video ' + channel));
}
export const choicesOf = (observed: Observed, seen: RowObservation | undefined, fieldId: string): Choice[] => { const index = seen?.choices[fieldId]; return index === undefined ? [] : observed.choiceSets[index] ?? []; };
/** A value as the sheet shows it: the choice's name, or a number with its unit. */
export function displayValue(observed: Observed, seen: RowObservation | undefined, field: Field, value: string): string {
  if (!value) return '';
  if (field.kind === 'choice') return choicesOf(observed, seen, field.id).find(choice => choice.value === value)?.label ?? value;
  const units = field.kind === 'number' ? seen?.limits[field.id]?.units : undefined;
  return units ? value + ' ' + units : value;
}
/** Checks a typed value against what the unit allows, and writes numbers the way the unit shows them. */
export function normalize(seen: RowObservation | undefined, field: Field, value: string): { value: string } | { error: string } {
  const limits = seen?.limits[field.id];
  if (!value || !limits) return { value };
  if (field.kind === 'number') {
    const typed = value.trim().replace(/\s*[%a-zA-Z°]+$/, '');
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(typed)) return { error: 'Enter a number.' };
    const number = Number(typed);
    if (limits.min !== undefined && number < limits.min || limits.max !== undefined && number > limits.max) return { error: 'Use a value from ' + limits.min + ' to ' + limits.max + (limits.units ? ' ' + limits.units : '') + '.' };
    if (limits.step) { const count = (number - (limits.min ?? 0)) / limits.step; if (Math.abs(count - Math.round(count)) > 1e-6) return { error: 'Use steps of ' + limits.step + '.' }; }
    return { value: number.toFixed(limits.precision ?? 0) };
  }
  if (field.kind === 'text') { const length = [...value].length; if (length < (limits.minLength ?? 0) || length > (limits.maxLength ?? 1024)) return { error: 'Use ' + (limits.minLength ?? 0) + ' to ' + (limits.maxLength ?? 1024) + ' characters.' }; }
  return { value };
}
