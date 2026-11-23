import {
  mountSpreadsheetControls, mountSpreadsheetColumnGroup, mountSpreadsheetColumnEditor, mountSpreadsheetColumnSearch, spreadsheetColumnSectionsSupported,
  createSpreadsheetContextMenu, mountSpreadsheetReorder, mountSpreadsheetResize, mountSpreadsheetViewport,
  type SpreadsheetAddress, type SpreadsheetCell, type SpreadsheetControls, type SpreadsheetColumn, type SpreadsheetColumnGroup,
  type SpreadsheetEdit, type SpreadsheetReorderItem, type SpreadsheetColumnGroupControls, type SpreadsheetColumnEditorItem,
} from '@hubble/module-sdk/spreadsheet-controls';
import { mountSlider, type SliderControls, type SliderState } from '@hubble/module-sdk/slider-controls';
import { activeKind, activeSheetId, clone, fieldById, groupById, groupsOf, isFlipped, isSimulated, masterRowId, masterSelection, modeLabel, modes, nameField, plannedMode, scopeOf, valueOf, viewChange, visibleFields, withColumnVisibility, withNoColumns, withSectionVisibility, withShownWhenCollapsed, type CellEdit, type Field, type SheetKind, type View } from './model.js';
import { choicesOf, displayValue, isLive, labelFieldOf, masterRows, normalize, rowObservation, rowsFor, shownLabel, shownName, unitObservation, waitingLabel, type Row } from './rows.js';
import { DraftStore } from './draft-store.js';
import type { Observed } from './backend.js';
import type { Limits } from './device.js';

export interface GridOptions {
  kind: SheetKind; table: HTMLTableElement; viewport: HTMLElement; columnEditor: HTMLElement; store: DraftStore;
  /** The toolbar slot for Hubble's column search. A Hubble without it leaves the slot empty. */
  columnSearch?: HTMLElement;
  observed: () => Observed; onSelect: (address: SpreadsheetAddress | undefined) => void;
  onZoom?: (ratio: number) => void;
  onRefresh: (unitId: string) => void; onRemove: (unitId: string) => void; onError: (message: string) => void;
  onEdited?: (edits: CellEdit[]) => void;
  /** Slider values while a drag or a held − / + is still going. `final` is the release, which is also staged as usual. */
  onLive?: (writes: LiveWrite[], final: boolean) => boolean;
}
export interface LiveWrite { rowId: string; fieldId: string; value: string }
interface Meta { id: string; label: string; width: number; fill: 'series' | 'copy'; resizable: boolean }
/** Hubble's slider in one cell. `drag` is where the thumb is while the pointer is down; `last` is kept for while the cell is being taken down. */
interface SliderCell { address: SpreadsheetAddress; slot: HTMLElement; controls?: SliderControls; drag?: number; last: SliderState; gone?: boolean; steps?: HTMLButtonElement[]; sentLive?: boolean; range?: SliderRange }
type SliderRange = Limits & { min: number; max: number; step: number };
const channelMeta: Meta[] = [
  { id: 'row-unit', label: 'FS-HDR', width: 130, fill: 'copy', resizable: true }, { id: 'row-label', label: 'Input label', width: 110, fill: 'copy', resizable: true }, { id: 'row-signal', label: 'Input signal', width: 124, fill: 'copy', resizable: true },
];
const metaByKind: Record<SheetKind, Meta[]> = {
  setup: [
    { id: 'unit-name', label: 'FS-HDR name', width: 160, fill: 'series', resizable: true }, { id: 'unit-host', label: 'Host / IP', width: 140, fill: 'series', resizable: true },
    { id: 'unit-simulated', label: 'Simulated', width: 104, fill: 'copy', resizable: false }, { id: 'connection-status', label: 'Connection', width: 110, fill: 'copy', resizable: false }, { id: 'unit-mode', label: 'Mode', width: 126, fill: 'copy', resizable: false }, { id: 'unit-allow', label: 'Allow sends', width: 112, fill: 'copy', resizable: false },
  ],
  master: [{ id: 'master-tick', label: 'Edit', width: 60, fill: 'copy', resizable: false }, ...channelMeta],
  channels: channelMeta,
};
const connectionLabels: Record<string, string> = { live: 'Live', connecting: 'Connecting', offline: 'Offline', duplicate: 'Duplicate address', disabled: 'Switched off', unset: '' };
// The operating mode a unit that isn't live is planned in. A live unit's own mode can't be changed from here.
const modeChoices = async (query: string, signal: AbortSignal) => { signal.throwIfAborted(); const words = query.toLowerCase().split(/\s+/); return modes.filter(mode => words.every(word => mode.label.toLowerCase().includes(word))).map(mode => ({ value: mode.value, label: mode.label, group: 'Mode' })); };
const modeValue = (typed: string) => modes.find(mode => mode.value === typed || mode.label.toLowerCase() === typed.trim().toLowerCase())?.value;
const addressKey = (a: SpreadsheetAddress) => a.rowId + '/' + a.columnId;
const clearAllId = 'clear-all-columns', settingLabelsId = 'setting-labels', defaultLabelWidth = 240, defaultChannelWidth = 170, defaultSettingHeight = 36;

// Every address the grid keeps or hands out is {rowId: unit or channel, columnId: setting}.
// Only the shared controls and the cell attributes see the flipped positions.
export async function createGrid(options: GridOptions) {
  const { table, viewport, store, kind } = options, scope = scopeOf(kind), meta = metaByKind[kind], groups = groupsOf(scope);
  const tracks = table.createTHead().parentElement!.querySelector('colgroup')!;
  const head = table.tHead!, groupRow = head.insertRow(), fieldRow = head.insertRow(), body = table.createTBody();
  const cells = new Map<string, HTMLTableCellElement>(), rowNodes = new Map<string, HTMLTableRowElement>(), fieldHeaders = new Map<string, HTMLTableCellElement>(), trackMap = new Map<string, HTMLTableColElement>();
  const groupHeaders = new Map<string, HTMLTableCellElement>(), groupControls = new Map<string, SpreadsheetColumnGroupControls>(), providerCache = new Map<string, { signature: string; provider: (query: string, signal: AbortSignal) => Promise<{ value: string; label: string; group?: string }[]> }>();
  const placeholders = new Map<string, { track: HTMLTableColElement; header: HTMLTableCellElement; cells: Map<string, HTMLTableCellElement> }>();
  const labelTrack = document.createElement('col'), channelTracks = new Map<string, HTMLTableColElement>(), labelHeads = new Map<string, HTMLTableCellElement>();
  const numberRow = document.createElement('tr'), numberCorner = document.createElement('th'), numberHeads = new Map<string, HTMLTableCellElement>();
  numberCorner.scope = 'col'; numberCorner.className = 'setting-label number-corner'; numberCorner.setAttribute('aria-label', 'Setting names');
  const identityRows = new Map<string, HTMLTableRowElement>(), settingRows = new Map<string, HTMLTableRowElement>();
  const sectionRows = new Map<string, { row: HTMLTableRowElement; filler: HTMLTableCellElement }>();
  const controlsToDispose: { dispose(): void; refresh?(): void }[] = [];
  const sliders = new Map<string, SliderCell>();
  let active: SpreadsheetAddress | undefined, controls: SpreadsheetControls, editor: { address: SpreadsheetAddress; cell: HTMLTableCellElement; input: HTMLInputElement; expected: string } | undefined, disposed = false, shownLayout = '', wasShowing = false;
  let resize: Awaited<ReturnType<typeof mountSpreadsheetResize>> | undefined;
  let reorder: Awaited<ReturnType<typeof mountSpreadsheetReorder>> | undefined;
  let zoomRatio = 1, rows: Row[] = [], rowById = new Map<string, Row>();
  // Each kind of tab keeps its own grid. Only the one whose tab is open draws or answers.
  const showing = () => activeKind(store.document) === kind;
  // The layout this grid drew last. While another kind of tab is open, the plan's `view` belongs to that tab.
  let lastView: View | undefined;
  const view = (): View => showing() ? (lastView = store.document.view) : lastView ?? store.document.view;
  const flipped = () => kind === 'channels' && isFlipped(store.document);
  const position = <T extends SpreadsheetAddress>(address: T): T => flipped() ? { ...address, rowId: address.columnId, columnId: address.rowId } : address;
  const settingLabel = (id: string) => fieldById.get(id)?.label ?? meta.find(m => m.id === id)?.label;
  const orderedGroups = () => [...view().order, ...groups.map(g => g.id).filter(id => !view().order.includes(id))];
  const fieldsOfGroup = (id: string) => { const group = groupById.get(id)!; return [...(view().fields[id] ?? []), ...group.fields.map(f => f.id).filter(f => !view().fields[id]?.includes(f))].map(fieldId => fieldById.get(fieldId)!); };
  // The column search in the toolbar: only the settings it matches are drawn, until it is cleared. It is never saved.
  // It looks inside collapsed sections too. Sections and settings that are switched off aren't read from the units, so they stay off.
  let searchIds: ReadonlySet<string> | null = null;
  const shownFields = () => searchIds ? visibleFields({ ...view(), expanded: Object.fromEntries(groups.map(g => [g.id, true])) }, scope).filter(f => searchIds!.has(f.id)) : visibleFields(view(), scope);
  /** Sections on screen: not hidden, and while searching, holding a match. */
  const shownGroups = () => { const list = shownFields(); return orderedGroups().filter(id => !view().hiddenGroups?.includes(id) && (!searchIds || list.some(f => f.group === id))); };
  const observed = () => options.observed();
  const seen = (row: Row) => rowObservation(observed(), row.unit, row.id);
  const live = (row: Row) => !!row.unit && row.kind !== 'placeholder' && isLive(observed(), row.unit);
  const staged = (row: Row, fieldId: string) => valueOf(store.document, row.id, fieldId);
  const shown = (row: Row, fieldId: string) => staged(row, fieldId) || seen(row)?.values[fieldId] || '';
  const ticked = () => new Set(masterSelection(store.document));
  const editedRows = () => masterRows(store.document, observed());
  const tickable = () => rows.filter(row => row.kind === 'channel');

  function fieldCell(row: Row, field: Field): SpreadsheetCell {
    // A unit that isn't live takes presets: the cell shows what is staged, with the choices and ranges the unit will offer.
    // They wait in Pending sends until the unit connects and Send is pressed.
    const current = seen(row);
    if (!current || (!live(row) && !current.planned)) return { value: '', readOnly: true };
    if (current.locked[field.id]) return { value: live(row) ? current.values[field.id] ?? '' : staged(row, field.id), readOnly: true };
    const base = { value: shown(row, field.id) }, choices = choicesOf(observed(), current, field.id);
    if (field.kind !== 'choice' || !choices.length) return base;
    const key = row.id + '/' + field.id, signature = String(current?.choices[field.id]);
    if (providerCache.get(key)?.signature !== signature) providerCache.set(key, { signature, provider: async (query, signal) => {
      signal.throwIfAborted(); const words = query.toLowerCase().split(/\s+/);
      return choices.filter(c => words.every(w => c.label.toLowerCase().includes(w))).map(c => ({ ...c, group: field.label }));
    } });
    return { ...base, choices: providerCache.get(key)!.provider };
  }
  /** The Master row shows what the ticked channels share. Where they differ it is blank and the cell reads Mixed. */
  function masterCell(field: Field): SpreadsheetCell & { mixed?: boolean } {
    const editable = editedRows().map(row => ({ row, cell: fieldCell(row, field) })).filter(item => !item.cell.readOnly);
    if (!editable.length) return { value: '', readOnly: true };
    const values = new Set(editable.map(item => item.cell.value)), first = editable[0]!.cell;
    return values.size === 1 ? first : { ...first, value: '', mixed: true };
  }
  function cellValue(address: SpreadsheetAddress): (SpreadsheetCell & { mixed?: boolean }) | null {
    const row = rowById.get(address.rowId); if (!row) return null;
    const field = fieldById.get(address.columnId), id = address.columnId;
    if (row.kind === 'master') {
      if (id === 'master-tick') return { value: String(tickable().length > 0 && tickable().every(item => ticked().has(item.id))).toUpperCase(), kind: 'boolean', readOnly: !tickable().length };
      if (id === 'row-unit') return { value: 'Master', readOnly: true };
      if (id === 'row-label') return { value: editedRows().length + ' of ' + tickable().length, readOnly: true };
      return field && field.scope === scope ? masterCell(field) : { value: '', readOnly: true };
    }
    const unit = row.unit!, about = unitObservation(observed(), unit);
    if (id === 'unit-name') return { value: shownName(observed(), unit) };
    if (id === 'unit-host' || id === 'unit-allow') return id === 'unit-allow' ? { value: unit.values[id] === 'TRUE' ? 'TRUE' : 'FALSE', kind: 'boolean' } : { value: unit.values[id] ?? '' };
    if (id === 'unit-simulated') return { value: isSimulated(unit) ? 'TRUE' : 'FALSE', kind: 'boolean' };
    if (id === 'connection-status') return { value: about?.simulated && about.state === 'live' ? 'Simulated' : connectionLabels[about?.state ?? 'connecting'] ?? '', readOnly: true };
    if (id === 'unit-mode') return isLive(observed(), unit) && !isSimulated(unit) ? { value: about?.mode ?? '', readOnly: true } : { value: plannedMode(unit), choices: modeChoices };
    if (id === 'master-tick') return row.kind === 'channel' ? { value: String(ticked().has(row.id)).toUpperCase(), kind: 'boolean' } : { value: 'FALSE', kind: 'boolean', readOnly: true };
    if (id === 'row-unit') return { value: shownName(observed(), unit), readOnly: true };
    if (id === 'row-label') return { value: row.channel === null ? '' : shownLabel(observed(), unit, row.channel), readOnly: true };
    if (id === 'row-signal') return { value: live(row) ? about?.simulated ? 'Simulated' : seen(row)?.signal ?? '' : waitingLabel(observed(), unit), readOnly: true };
    return field && field.scope === scope ? fieldCell(row, field) : null;
  }
  /** The unit's range for a setting. The Master row takes it from the first ticked channel that can take the setting, as its value does. */
  function limitsOf(row: Row, field: Field): Limits | undefined {
    const from = row.kind === 'master' ? editedRows().find(target => !fieldCell(target, field).readOnly) : row;
    return from && seen(from)?.limits[field.id];
  }
  /**
   * A slider needs a number to show and a range from the unit. A blank, Mixed or offline cell stays text, except while its slider
   * is being dragged or held: on a Master row the channels disagree for a moment as values land, and the slider must not
   * vanish under the pointer, which lost the release.
   */
  function sliderRange(address: SpreadsheetAddress): SliderRange | undefined {
    const row = rowById.get(address.rowId), field = fieldById.get(address.columnId);
    if (!row || !field?.slider || field.scope !== scope) return undefined;
    const held = sliders.get(addressKey(address)), range = currentRange(row, field, address);
    if (range && held) held.range = range;
    return range ?? (held?.drag !== undefined ? held.range : undefined);
  }
  function currentRange(row: Row, field: Field, address: SpreadsheetAddress): SliderRange | undefined {
    const cell = cellValue(address), limits = limitsOf(row, field);
    if (!cell || cell.mixed || !cell.value || !Number.isFinite(Number(cell.value)) || !limits) return undefined;
    const { min, max, step } = limits;
    return min !== undefined && max !== undefined && step !== undefined && min < max && step > 0 ? { ...limits, min, max, step } : undefined;
  }
  function sliderState(slider: SliderCell): SliderState {
    const { address } = slider, row = rowById.get(address.rowId), field = fieldById.get(address.columnId), range = sliderRange(address);
    if (!row || !field || !range) return slider.drag === undefined ? slider.last : slider.last = { ...slider.last, value: slider.drag };
    const cell = cellValue(address)!, current = row.kind === 'master' ? undefined : seen(row), reported = current?.values[field.id] ?? '';
    const waiting = (target: Row) => { const value = staged(target, field.id); return !!value && value !== seen(target)?.values[field.id]; };
    const pending = row.kind === 'master' ? editedRows().some(waiting) : waiting(row);
    // While a value waits to be sent, the number's tooltip says what the unit still has.
    return slider.last = {
      value: slider.drag ?? Number(cell.value), min: range.min, max: range.max, step: range.step, unit: range.units ? ' ' + range.units : undefined,
      disabled: !!cell.readOnly, pending: current?.sending.includes(field.id) ?? false,
      confirmedValue: pending && reported && Number.isFinite(Number(reported)) ? Number(reported) : undefined,
      error: pending ? current?.errors[field.id] ?? null : null,
    };
  }
  function dropSlider(key: string) {
    const slider = sliders.get(key); if (!slider) return;
    sliders.delete(key); slider.gone = true; slider.controls?.dispose(); slider.slot.remove();
  }
  function showSlider(cell: HTMLTableCellElement, address: SpreadsheetAddress) {
    const key = addressKey(address), existing = sliders.get(key);
    if (existing?.slot.parentElement === cell) { existing.controls?.refresh(); refreshSteps(existing); return; }
    if (existing) dropSlider(key);
    const slot = document.createElement('div'), track = document.createElement('div'), slider: SliderCell = { address, slot, last: { value: 0, min: 0, max: 1, step: 1 } };
    slot.className = 'cell-slider'; track.className = 'cell-slider-track'; slider.last = sliderState(slider); sliders.set(key, slider);
    const row = rowById.get(address.rowId), label = (settingLabel(address.columnId) ?? 'Setting') + (row ? ' for ' + rowName(row) : '');
    // One step down or up per press, the unit's own step. Held, it keeps going and speeds up, and sends as it goes like a drag.
    const steps = ([-1, 1] as const).map(direction => {
      const node = document.createElement('button');
      node.type = 'button'; node.className = 'slider-step'; node.tabIndex = -1; node.textContent = direction < 0 ? '−' : '+';
      node.setAttribute('aria-label', (direction < 0 ? 'Decrease ' : 'Increase ') + label); node.title = (direction < 0 ? 'Down' : 'Up') + ' one step. Hold to keep going, Shift for ten steps.';
      node.addEventListener('pointerdown', event => {
        if (event.button !== 0 || node.disabled) return;
        event.preventDefault(); event.stopPropagation();
        controls.select(position(address));
        holdStep(slider, node, direction * (event.shiftKey ? 10 : 1), event.pointerId);
      });
      return node;
    });
    slider.steps = steps;
    slot.append(steps[0]!, track, steps[1]!); cell.replaceChildren(slot); refreshSteps(slider);
    // A slider only moves once its cell is the active one. The first press on another cell's slider or − / + just selects that cell.
    slot.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !(event.target as Element).closest('.hubble-slider-root, .slider-step')) return;
      if (active && addressKey(active) === key) return;
      event.preventDefault(); event.stopPropagation();
      controls.select(position(address));
    }, { capture: true });
    // The sheet takes the pointer for a range selection on any press in a cell, so a press on the track is kept for the slider. It still selects the cell.
    slot.addEventListener('pointerdown', event => {
      if (!(event.target as Element).closest('.hubble-slider-root')) return;
      event.stopPropagation();
      if (event.button === 0) controls.select(position(address), undefined, { focus: false });
    });
    // The slider takes keyboard focus on a press. Afterwards the arrow keys move around the sheet again, and typing edits the number.
    const giveBack = () => { if (!slider.gone && slot.contains(document.activeElement)) controls.select(position(address)); };
    slot.addEventListener('pointerup', giveBack); slot.addEventListener('lostpointercapture', giveBack);
    void mountSlider({
      root: track, layout: 'cell', label,
      getState: () => sliderState(slider),
      // With Auto send on, the value goes to the unit as the thumb moves.
      onValueChange(value) { slider.drag = value; refreshSteps(slider); sendLive(slider, value, false); },
      // One release stages one value, the same as typing it. With Auto send on, it goes to the unit.
      onValueCommit(value) { release(slider, value); },
      onError: error => options.onError(error.message),
    }).then(mounted => { if (slider.gone) mounted.dispose(); else slider.controls = mounted; }, (error: unknown) => { if (!slider.gone) options.onError(error instanceof Error ? error.message : 'The slider could not be shown.'); });
  }
  /** What a slider value means for each unit: the row itself, or every ticked channel for the Master row. Only live rows take it. */
  function liveWrites(address: SpreadsheetAddress, value: number): LiveWrite[] {
    const row = rowById.get(address.rowId), field = fieldById.get(address.columnId);
    if (!row || !field) return [];
    const targets = row.kind === 'master' ? editedRows().filter(target => !fieldCell(target, field).readOnly) : [row];
    return targets.filter(live).flatMap(target => { const checked = normalize(seen(target), field, String(value)); return 'error' in checked || !checked.value ? [] : [{ rowId: target.id, fieldId: field.id, value: checked.value }]; });
  }
  function sendLive(slider: SliderCell, value: number, final: boolean) { const writes = liveWrites(slider.address, value); if (writes.length && options.onLive?.(writes, final)) slider.sentLive = true; }
  /**
   * The release stages its value and, with Auto send on, sends it through each row's Send queue. After a live drag the unit
   * usually has it already, but it is still sent that way, so a Send left over from an earlier step can't land after it.
   */
  function release(slider: SliderCell, value: number) {
    slider.drag = undefined;
    sendLive(slider, value, true);
    const sent = !!slider.sentLive; slider.sentLive = false;
    submit([{ ...slider.address, value: String(value) }], undefined, sent);
  }
  /** The value one or more steps from where the thumb is now, kept on the unit's grid and inside its range. */
  function stepFrom(slider: SliderCell, steps: number): number | undefined {
    const range = sliderRange(slider.address); if (!range) return undefined;
    const from = slider.drag ?? sliderState(slider).value, count = Math.round((from - range.min) / range.step) + steps;
    return Math.min(range.max, Math.max(range.min, Number((range.min + count * range.step).toFixed(10))));
  }
  function refreshSteps(slider: SliderCell) {
    const state = sliderState(slider), range = sliderRange(slider.address), value = slider.drag ?? state.value;
    const [down, up] = slider.steps ?? [];
    if (down) down.disabled = !range || !!state.disabled || value <= state.min;
    if (up) up.disabled = !range || !!state.disabled || value >= state.max;
  }
  /** A press steps once. Held, it repeats after a moment, faster the longer it is held, until the pointer lets go. */
  function holdStep(slider: SliderCell, node: HTMLButtonElement, steps: number, pointerId: number) {
    let timer: ReturnType<typeof setTimeout> | undefined, repeats = 0, moved = false;
    // After about two seconds held it moves five steps at a time, so a long way doesn't take a long time.
    const move = () => {
      const next = stepFrom(slider, repeats < 40 ? steps : steps * 5); if (next === undefined || next === (slider.drag ?? sliderState(slider).value)) return false;
      slider.drag = next; moved = true; slider.controls?.refresh(); refreshSteps(slider);
      return true;
    };
    const tick = () => {
      if (slider.gone || !move()) return;
      sendLive(slider, slider.drag!, false); repeats++;
      timer = setTimeout(tick, repeats < 6 ? 120 : repeats < 20 ? 50 : 35);
    };
    const stop = () => {
      clearTimeout(timer);
      node.removeEventListener('pointerup', stop); node.removeEventListener('pointercancel', stop); node.removeEventListener('lostpointercapture', stop);
      if (moved && !slider.gone && slider.drag !== undefined) release(slider, slider.drag);
      else slider.drag = undefined;
      if (!slider.gone) { slider.controls?.refresh(); refreshSteps(slider); }
    };
    try { node.setPointerCapture(pointerId); } catch { /* The pointer has already gone. */ }
    node.addEventListener('pointerup', stop); node.addEventListener('pointercancel', stop); node.addEventListener('lostpointercapture', stop);
    if (!move()) { stop(); return; }
    timer = setTimeout(tick, 400);
  }
  function layout(next: View) { store.submit(viewChange(store.document, next)); }
  function groupDescriptor(id: string): SpreadsheetColumnGroup {
    const group = groupById.get(id)!;
    return { id, label: group.label, columns: fieldsOfGroup(id).map(f => ({ id: f.id, label: f.label, fill: 'copy' })), expanded: !!view().expanded[id], collapsedColumnIds: view().collapsed[id] ?? group.collapsed };
  }
  const hasOptionalColumns = () => groups.some(g => !view().hiddenGroups?.includes(g.id));
  function setVisibility(changes: readonly { id: string; visible: boolean }[]) {
    const clearing = changes.find(change => change.id === clearAllId);
    if (clearing) { if (clearing.visible) { columnEditor.refresh(); return; } layout(withNoColumns(view(), scope)); }
    else layout(sections ? withSectionVisibility(view(), changes) : withColumnVisibility(view(), changes));
    followSelection();
  }
  function setVisible(id: string, visible: boolean) { setVisibility([{ id, visible }]); }
  function move(ids: readonly string[], beforeId: string | null, moveScope?: string) {
    const next = clone(view()), current = moveScope && moveScope !== 'groups' ? (next.fields[moveScope] ?? fieldsOfGroup(moveScope).map(f => f.id)) : orderedGroups();
    const moved = current.filter(id => ids.includes(id)), remaining = current.filter(id => !ids.includes(id)), index = beforeId ? remaining.indexOf(beforeId) : -1;
    remaining.splice(index < 0 ? remaining.length : index, 0, ...moved);
    if (moveScope && moveScope !== 'groups') next.fields[moveScope] = remaining; else next.order = remaining;
    layout(next);
  }
  function orderNodes(parent: HTMLElement, nodes: HTMLElement[]) { for (let i = 0; i < nodes.length; i++) if (parent.children[i] !== nodes[i]) parent.insertBefore(nodes[i]!, parent.children[i] ?? null); }
  function place(parent: HTMLElement, nodes: HTMLElement[]) { orderNodes(parent, nodes); while (parent.children.length > nodes.length) parent.lastElementChild!.remove(); }
  const corner = document.createElement('th'); corner.rowSpan = 2; corner.className = 'row-number corner'; corner.setAttribute('aria-label', 'Rows'); groupRow.append(corner);
  const metaHeads = meta.map(m => { const th = document.createElement('th'); th.textContent = m.label; th.rowSpan = 2; th.scope = 'col'; th.dataset.columnId = m.id; th.tabIndex = 0; th.className = 'identity-column'; groupRow.append(th); return th; });
  const gutter = document.createElement('col'); gutter.style.width = '34px'; tracks.prepend(gutter);
  // Columns, headers and cells for a setting are only made once that setting is shown, so hundreds of unused ones cost nothing.
  const trackFor = (id: string) => { let col = trackMap.get(id); if (!col) trackMap.set(id, col = document.createElement('col')); return col; };
  const fieldHeader = (field: Field) => { let th = fieldHeaders.get(field.id); if (!th) { th = document.createElement('th'); th.scope = 'col'; th.textContent = field.label; th.dataset.columnId = field.id; th.tabIndex = 0; fieldHeaders.set(field.id, th); } return th; };
  const labelHead = (id: string) => { let th = labelHeads.get(id); if (!th) { th = document.createElement('th'); th.scope = 'row'; th.className = 'setting-label'; th.tabIndex = 0; th.textContent = settingLabel(id) ?? id; th.dataset.settingLabel = id; labelHeads.set(id, th); } return th; };
  function cellFor(rowId: string, columnId: string) {
    let cell = cells.get(rowId + '/' + columnId);
    if (!cell) { cell = document.createElement('td'); cell.dataset.rowId = rowId; cell.dataset.settingId = columnId; cell.setAttribute('role', 'gridcell'); if (meta.some(m => m.id === columnId)) cell.className = 'identity-column'; cells.set(rowId + '/' + columnId, cell); }
    return cell;
  }
  for (const group of groups) {
    const th = document.createElement('th'); th.scope = 'colgroup'; th.className = 'setting-group'; th.dataset.groupId = group.id; th.tabIndex = 0; const slot = document.createElement('div'); th.append(slot); groupHeaders.set(group.id, th); groupRow.append(th);
    const track = document.createElement('col'), header = document.createElement('th'); header.className = 'empty-group-header'; header.setAttribute('aria-hidden', 'true');
    placeholders.set(group.id, { track, header, cells: new Map() });
    const row = document.createElement('tr'), filler = document.createElement('td'); row.className = 'setting-section'; filler.className = 'section-filler'; filler.setAttribute('aria-hidden', 'true'); sectionRows.set(group.id, { row, filler });
  }
  for (const m of meta) { const row = document.createElement('tr'); row.dataset.settingId = m.id; identityRows.set(m.id, row); }
  function settingRow(id: string) { let row = settingRows.get(id); if (!row) { row = document.createElement('tr'); row.dataset.settingId = id; settingRows.set(id, row); } return row; }

  /** Turns what the shared controls hand over into plan edits: the Master row fans out, a name is also staged for the unit, numbers are checked. */
  function submit(edits: readonly SpreadsheetEdit[], expected?: string, keepSame = false): boolean {
    const changes: CellEdit[] = [], claimed = new Set<string>();
    let selection: Set<string> | undefined, refused = false;
    const add = (rowId: string, columnId: string, value: string, from?: string) => {
      const key = rowId + '/' + columnId, before = from ?? valueOf(store.document, rowId, columnId);
      if (claimed.has(key) || value === before) return;
      claimed.add(key); changes.push({ rowId, columnId, value, expected: before });
    };
    const stage = (row: Row, field: Field, typed: string, from?: string) => {
      const checked = normalize(seen(row), field, typed);
      if ('error' in checked) { refused = true; store.refuse({ rowId: row.id, columnId: field.id, value: typed, expected: from ?? staged(row, field.id) }, checked.error); return; }
      // Putting back what the unit already has is not a change to send.
      add(row.id, field.id, !keepSame && checked.value === seen(row)?.values[field.id] ? '' : checked.value, from);
    };
    for (const edit of edits) {
      // An edit already open when its unit drops offline still saves. Only an open editor passes `expected`.
      const row = rowById.get(edit.rowId), cell = cellValue(edit); if (!row || !cell || (cell.readOnly && expected === undefined)) continue;
      const field = fieldById.get(edit.columnId);
      if (edit.columnId === 'master-tick') {
        selection ??= ticked();
        const on = edit.value === 'TRUE';
        for (const target of row.kind === 'master' ? tickable() : [row]) if (on) selection.add(target.id); else selection.delete(target.id);
      } else if (row.kind === 'master') {
        if (field) for (const target of editedRows()) if (!fieldCell(target, field).readOnly) stage(target, field, edit.value);
      } else if (edit.columnId === 'unit-simulated' && row.unit) {
        const on = edit.value === 'TRUE', unit = row.unit;
        add(row.id, 'unit-simulated', on ? 'TRUE' : 'FALSE');
        // Turning a simulated unit back into a real one keeps what was set on it, as presets for the real unit.
        if (!on && isSimulated(unit)) for (const [rowId, values] of Object.entries(unitObservation(observed(), unit)?.changes ?? {})) for (const [fieldId, value] of Object.entries(values)) if (!valueOf(store.document, rowId, fieldId)) add(rowId, fieldId, value);
      } else if (edit.columnId === 'unit-mode' && row.unit) {
        const mode = modeValue(edit.value);
        if (!mode) { refused = true; store.refuse({ rowId: row.id, columnId: 'unit-mode', value: edit.value, expected: row.unit.values['unit-mode'] ?? '' }, 'Choose HD/SD 4 Ch or 4K/UHD 1 Ch.'); continue; }
        add(row.id, 'unit-mode', mode);
      } else if (edit.columnId === 'unit-name') {
        const checked = normalize(seen(row), nameField, edit.value);
        if ('error' in checked) { refused = true; store.refuse({ rowId: row.id, columnId: 'unit-name', value: edit.value, expected: row.unit!.values['unit-name'] ?? '' }, checked.error); continue; }
        add(row.id, 'unit-name', edit.value);
        add(row.id, nameField.id, live(row) && edit.value === unitObservation(observed(), row.unit!)?.name ? '' : edit.value);
      } else if (field) stage(row, field, edit.value, expected);
      else add(row.id, edit.columnId, edit.value, expected);
    }
    if (selection) { const before = masterSelection(store.document), next = [...selection]; if (next.length !== before.length || next.some(id => !before.includes(id))) store.submit({ kind: 'master', selected: next, expected: before }, false); }
    if (!changes.length) return !refused;
    const accepted = store.submit({ kind: 'edit', edits: changes });
    if (accepted) options.onEdited?.(changes);
    return accepted && !refused;
  }
  // The shared controls take a column's fill and name, but across channels it's the setting that decides them.
  function channelColumns(): SpreadsheetColumn[] {
    const open = active && settingLabel(active.columnId);
    return rows.map(row => ({ id: row.id, label: row.id === active?.rowId && open ? open : rowName(row), fill: 'copy' as const }));
  }
  const rowName = (row: Row) => row.kind === 'master' ? 'Master' : row.channel === null || kind === 'setup' ? shownName(observed(), row.unit!) || 'FS-HDR' : shownName(observed(), row.unit!) + ' · ' + (shownLabel(observed(), row.unit!, row.channel) || 'Video ' + row.channel);
  const columnsNow = (): SpreadsheetColumn[] => [...meta.map(m => ({ id: m.id, label: m.label, fill: m.fill })), ...shownFields().map(f => ({ id: f.id, label: f.label, fill: 'copy' as const }))];
  controls = await mountSpreadsheetControls({
    root: table, viewport, extendedEditing: true, workbookEditing: true,
    getRows: () => flipped() ? columnsNow().map(c => c.id) : rows.map(r => r.id),
    getColumns: () => flipped() ? channelColumns() : columnsNow(),
    getCell: address => showing() ? cellValue(position(address)) : null, onEdit: batch => submit(batch.edits.map(position)),
    onSelection(address) { active = address && position(address); options.onSelect(active); if (flipped()) controls.refresh(); },
    onHistory(direction) { if (active && store.invalid.has(addressKey(active))) { store.discard(active.rowId, active.columnId); return; } store.history(direction === 'redo'); },
    onError: error => options.onError(error.message),
  });
  controlsToDispose.push(controls);
  for (const group of groups) {
    const header = await mountSpreadsheetColumnGroup({
      root: groupHeaders.get(group.id)!.firstElementChild as HTMLElement,
      getGroup: () => groupDescriptor(group.id),
      onChange(next) { const v = clone(view()); v.expanded[group.id] = next.expanded; v.collapsed[group.id] = [...next.collapsedColumnIds]; v.fields[group.id] = next.columns.map(c => c.id); layout(v); },
      onError: error => options.onError(error.message),
    }); groupControls.set(group.id, header); controlsToDispose.push(header);
  }
  // A Hubble with column sections gives each setting its own Show and When collapsed ticks,
  // and lists the ones a collapsed section tucks away. Older Hubbles get the plain menu.
  const sections = await spreadsheetColumnSectionsSupported().catch(() => false);
  const sectionItems = (): SpreadsheetColumnEditorItem[] => [
    { id: clearAllId, label: 'Clear all columns', visible: hasOptionalColumns() },
    ...orderedGroups().map(id => {
      const group = groupById.get(id)!, off = !!view().hiddenGroups?.includes(id), kept = view().collapsed[id] ?? group.collapsed;
      return { id, label: group.label, expanded: !!view().expanded[id], fields: fieldsOfGroup(id).map(f => ({ id: f.id, label: f.label, visible: !off && !view().hidden.includes(f.id), shownWhenCollapsed: kept.includes(f.id) })) };
    }),
  ];
  // Every setting this tab can show, for the Columns menu and the column search alike.
  const columnItems = (): SpreadsheetColumnEditorItem[] => sections ? sectionItems() : legacyColumnItems();
  const legacyColumnItems = (): SpreadsheetColumnEditorItem[] => { const visible = new Set(visibleFields({ ...view(), hiddenGroups: [] }, scope).map(f => f.id)); return [{ id: clearAllId, label: 'Clear all columns', visible: hasOptionalColumns() }, ...orderedGroups().map(id => ({ id, label: groupById.get(id)!.label, visible: !view().hiddenGroups?.includes(id), fields: fieldsOfGroup(id).map(f => ({ id: f.id, label: f.label, visible: !view().hiddenGroups?.includes(id) && visible.has(f.id) })) }))]; };
  const columnEditor = await mountSpreadsheetColumnEditor({
    root: options.columnEditor,
    getItems: columnItems,
    onVisibilityChange: setVisible,
    onVisibilityChanges: setVisibility,
    onMove(id, beforeId) { if (id === clearAllId) return; move([id], beforeId === clearAllId ? orderedGroups()[0]! : beforeId, fieldById.get(id)?.group ?? 'groups'); },
    ...(sections ? {
      onExpandedChange(groupId: string, expanded: boolean) { const next = clone(view()); next.expanded[groupId] = expanded; layout(next); followSelection(); },
      onShownWhenCollapsedChanges(changes: readonly { id: string; shownWhenCollapsed: boolean }[]) { layout(withShownWhenCollapsed(view(), changes)); followSelection(); },
    } : {}),
  }); controlsToDispose.push(columnEditor);
  // A Hubble without the column search leaves its slot empty and the page works as before.
  if (options.columnSearch) {
    try {
      const search = await mountSpreadsheetColumnSearch({
        root: options.columnSearch, getItems: columnItems,
        onSearch(found) { searchIds = found && new Set(found.fieldIds); render(); followSelection(); },
        onFocusGrid() {
          const rowId = active?.rowId ?? rows[0]?.id;
          if (!rowId) { table.focus(); return; }
          const keep = active && (meta.some(m => m.id === active!.columnId) || shownFields().some(f => f.id === active!.columnId));
          controls.select(position(keep ? active! : { rowId, columnId: shownFields()[0]?.id ?? meta[0]!.id }));
        },
      }); controlsToDispose.push(search);
    } catch { options.columnSearch.hidden = true; }
  }
  const menu = await createSpreadsheetContextMenu({ root: table, onError: error => options.onError(error.message) }); controlsToDispose.push(menu);
  table.addEventListener('contextmenu', event => {
    const target = (event.target as Element).closest<HTMLTableCellElement>('td,th'); if (!target) return;
    const row = rowById.get(target.dataset.rowId ?? ''), columnId = target.dataset.settingId;
    const hideId = columnId ?? target.dataset.settingLabel ?? target.dataset.columnId, hideable = !!hideId && fieldById.get(hideId)?.scope === scope && hideId !== nameField.id;
    const unit = row?.unit;
    if (!unit && !hideable) return;
    event.preventDefault();
    const hide = hideable ? [{ id: 'hide', label: 'Hide ' + settingLabel(hideId!)!, run: () => setVisible(hideId!, false) }] : [];
    menu.open({ x: event.clientX, y: event.clientY, label: unit ? rowName(row!) : settingLabel(hideId!)!, items: unit ? [
      { id: 'refresh', label: 'Refresh this FS-HDR', run: () => options.onRefresh(unit.id) },
      ...(columnId ? [{ id: 'edit', label: 'Edit cell', disabled: !!cellValue({ rowId: row!.id, columnId })?.readOnly, run: () => startEdit(target as HTMLTableCellElement) }, { id: 'discard', label: 'Discard invalid draft', disabled: !store.invalid.has(row!.id + '/' + columnId), run: () => store.discard(row!.id, columnId) }] : []),
      ...(hide.length ? [{ separator: true as const }, ...hide] : []),
      ...(kind === 'setup' ? [{ separator: true as const }, { id: 'remove', label: 'Remove this FS-HDR from the plan', danger: true, run: () => options.onRemove(unit.id) }] : []),
    ] : hide });
  });
  // Headers have to be in the sheet before the resize and reorder handles are attached to them.
  render();
  // The host draws these handles on a layer above the sheet and knows nothing of frozen cells,
  // so one whose edge has scrolled underneath them has to drop out.
  function handleIsExposed({ axis, header }: { axis: 'row' | 'column'; header: HTMLElement }) {
    if (header === numberCorner || metaHeads.includes(header as HTMLTableCellElement) || meta.some(m => labelHeads.get(m.id) === header)) return true;
    const box = header.getBoundingClientRect(), lastMeta = meta[meta.length - 1]!;
    if (axis === 'column') return box.right > (flipped() ? numberCorner : metaHeads[meta.length - 1]!).getBoundingClientRect().right + 1;
    return box.bottom > (flipped() ? labelHead(lastMeta.id) : corner).getBoundingClientRect().bottom + 1;
  }
  resize = await mountSpreadsheetResize({
    root: table, viewport, getScale: () => zoomRatio,
    getItems: () => !showing() ? [] : (flipped() ? [
      { id: settingLabelsId, label: 'setting names', axis: 'column' as const, header: numberCorner, size: view().settingLabelWidth ?? defaultLabelWidth, min: 120, max: 800 },
      ...rows.map(row => ({ id: row.id, label: rowName(row), axis: 'column' as const, header: numberHeads.get(row.id)!, size: view().cameraWidths?.[row.id] ?? defaultChannelWidth, min: 96, max: 800 })),
      ...columnsNow().map(c => ({ id: c.id, label: c.label, axis: 'row' as const, header: labelHead(c.id), size: view().settingHeights?.[c.id] ?? defaultSettingHeight, min: 28, max: 200 })),
    ] : [
      ...meta.filter(m => m.resizable).map(m => ({ id: m.id, label: m.label, axis: 'column' as const, header: metaHeads[meta.indexOf(m)]!, size: view().widths[m.id] ?? m.width, min: 96, max: 800 })),
      ...shownFields().map(f => ({ id: f.id, label: f.label, axis: 'column' as const, header: fieldHeader(f), size: view().widths[f.id] ?? f.width, min: 96, max: 800 })),
      ...rows.filter(row => row.kind !== 'master').map(row => ({ id: row.id, label: rowName(row), axis: 'row' as const, header: rowNodes.get(row.id)!.cells[0] as HTMLElement, size: view().rowHeights[row.id] ?? 36, min: 28, max: 200 })),
    ]).filter(handleIsExposed),
    onResize(item, size) {
      const next = clone(view());
      if (flipped()) { if (item.axis === 'row') (next.settingHeights ??= {})[item.id] = size; else if (item.id === settingLabelsId) next.settingLabelWidth = size; else (next.cameraWidths ??= {})[item.id] = size; }
      else if (item.axis === 'column') next.widths[item.id] = size; else next.rowHeights[item.id] = size;
      layout(next);
    },
  }); controlsToDispose.push(resize);
  reorder = await mountSpreadsheetReorder({
    root: table, getItems: () => {
      const result: SpreadsheetReorderItem[] = [];
      if (!showing()) return result;
      const isFlippedNow = flipped(), axis = isFlippedNow ? 'row' as const : 'column' as const;
      const settingCells = (f: Field) => rows.map(row => cellFor(row.id, f.id));
      const handleOf = (f: Field) => isFlippedNow ? labelHead(f.id) : fieldHeader(f);
      const visible = shownFields();
      for (const id of shownGroups()) {
        const group = groupById.get(id)!, list = visible.filter(f => f.group === id);
        result.push({ id, label: group.label, axis, scope: 'groups', handle: groupHeaders.get(id)!, elements: [groupHeaders.get(id)!, ...list.flatMap(f => [handleOf(f), ...settingCells(f)])] });
        for (const f of list) result.push({ id: f.id, label: f.label, axis, scope: id, handle: handleOf(f), elements: [handleOf(f), ...settingCells(f)] });
      }
      return result;
    }, onMove: request => move(request.ids, request.beforeId, request.scope), onError: error => options.onError(error.message),
  }); controlsToDispose.push(reorder);
  const viewportControls = await mountSpreadsheetViewport({ root: table, viewport, onZoom(ratio) { zoomRatio = ratio; controls.refresh(); resize?.refresh(); reorder?.refresh(); options.onZoom?.(ratio); } });
  controlsToDispose.push(viewportControls);
  function startEdit(cell: HTMLTableCellElement, initial?: string) {
    const rowId = cell.dataset.rowId, columnId = cell.dataset.settingId; if (!rowId || !columnId) return false;
    const address = { rowId, columnId }, field = cellValue(address);
    if (!field || field.readOnly || field.choices || field.kind === 'boolean') return false;
    const input = document.createElement('input'); input.className = 'cell-input'; input.setAttribute('aria-label', 'Edit ' + (settingLabel(columnId) ?? 'cell'));
    input.value = initial ?? store.invalid.get(addressKey(address))?.edit.value ?? field.value;
    const current = { address, cell, input, expected: valueOf(store.document, rowId, columnId) }; editor = current;
    const startedWith = field.value, retrying = store.invalid.has(addressKey(address));
    const finish = (commit: boolean, focus: boolean) => {
      if (editor !== current) return; editor = undefined;
      // Leaving a cell unchanged isn't an edit, even if the unit has moved on since it opened.
      if (commit && (retrying || input.value !== startedWith)) { if (retrying) store.discard(rowId, columnId); submit([{ ...address, value: input.value }], rowById.get(rowId)?.kind === 'master' || columnId === 'unit-name' ? undefined : current.expected); }
      render(); if (focus) controls.select(position(address));
    };
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (['Escape', 'Tab', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); finish(event.key !== 'Escape', true); if (event.key === 'Tab') controls.move?.(event.shiftKey ? -1 : 1, 0); else if (event.key === 'Enter') controls.move?.(0, 1); }
    });
    input.addEventListener('blur', () => finish(true, false), { once: true });
    dropSlider(addressKey(address)); delete cell.dataset.empty; cell.replaceChildren(input); input.focus(); input.setSelectionRange(input.value.length, input.value.length); return true;
  }
  table.addEventListener('keydown', event => {
    if (event.target !== table || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const cell = table.querySelector<HTMLTableCellElement>('[data-hubble-spreadsheet-active="true"]');
    if (cell && (event.key === 'F2' || event.key === 'Enter' || event.key.length === 1) && startEdit(cell, event.key.length === 1 ? event.key : undefined)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  // Two quick presses on a slider move it twice. A double-click on its number opens the number for typing.
  table.addEventListener('dblclick', event => { const target = document.elementFromPoint(event.clientX, event.clientY); if (target?.closest('.hubble-slider-root, .slider-step')) return; const cell = target?.closest<HTMLTableCellElement>('td'); if (cell && table.contains(cell) && !editor) startEdit(cell); });
  function ensureRow(row: Row) {
    if (rowNodes.has(row.id)) return;
    const tr = document.createElement('tr'); tr.dataset.rowId = row.id; if (row.kind === 'master') tr.className = 'master-row'; rowNodes.set(row.id, tr);
    const number = document.createElement('th'); number.scope = 'row'; number.className = 'row-number'; number.dataset.rowId = row.id; tr.append(number);
    for (const group of groups) { const cell = document.createElement('td'); cell.className = 'empty-group-cell'; cell.setAttribute('aria-hidden', 'true'); placeholders.get(group.id)!.cells.set(row.id, cell); }
    channelTracks.set(row.id, document.createElement('col'));
    const numberHead = document.createElement('th'); numberHead.scope = 'col'; numberHead.className = 'column-number'; numberHead.dataset.rowId = row.id; numberHeads.set(row.id, numberHead);
  }
  function layoutRows() {
    const visible = shownFields(), groupOrder = shownGroups();
    const inGroup = (id: string) => visible.filter(f => f.group === id), isEmpty = (id: string) => !inGroup(id).length;
    place(tracks, [gutter, ...meta.map(m => trackFor(m.id)), ...groupOrder.flatMap(id => isEmpty(id) ? [placeholders.get(id)!.track] : inGroup(id).map(f => trackFor(f.id)))]);
    place(head, [groupRow, fieldRow]);
    place(groupRow, [corner, ...metaHeads, ...groupOrder.map(id => groupHeaders.get(id)!)]);
    place(fieldRow, groupOrder.flatMap(id => isEmpty(id) ? [placeholders.get(id)!.header] : inGroup(id).map(f => fieldHeader(f))));
    let width = 34, offset = 34; corner.style.left = '0px';
    const lefts = new Map<string, number>();
    for (const [i, m] of meta.entries()) {
      const w = view().widths[m.id] ?? m.width;
      trackFor(m.id).style.width = w + 'px'; metaHeads[i]!.style.left = offset + 'px'; metaHeads[i]!.style.minWidth = w + 'px';
      lefts.set(m.id, offset); offset += w; width += w;
    }
    for (const field of visible) { const w = view().widths[field.id] ?? field.width; trackFor(field.id).style.width = w + 'px'; width += w; }
    for (const id of groupOrder) {
      const th = groupHeaders.get(id)!, placeholder = placeholders.get(id)!, group = groupById.get(id)!;
      th.scope = 'colgroup'; th.hidden = false; th.colSpan = Math.max(1, inGroup(id).length);
      if (isEmpty(id)) { const w = Math.max(180, group.label.length * 8 + 50); placeholder.track.style.width = w + 'px'; width += w; }
      groupControls.get(id)?.refresh();
    }
    table.style.width = width + 'px';
    place(body, rows.map(row => rowNodes.get(row.id)!));
    let number = 0;
    const headHeight = rows[0]?.kind === 'master' ? head.offsetHeight : 0;
    for (const row of rows) {
      const tr = rowNodes.get(row.id)!, first = tr.cells[0] as HTMLTableCellElement;
      tr.style.height = (view().rowHeights[row.id] ?? 36) + 'px'; first.textContent = row.kind === 'master' ? 'All' : String(++number);
      first.setAttribute('aria-label', rowName(row));
      place(tr, [first, ...meta.map(m => cellFor(row.id, m.id)), ...groupOrder.flatMap(id => isEmpty(id) ? [placeholders.get(id)!.cells.get(row.id)!] : inGroup(id).map(f => cellFor(row.id, f.id)))]);
      for (const m of meta) { const cell = cellFor(row.id, m.id); cell.style.left = lefts.get(m.id) + 'px'; }
      // The Master row stays under the headers while the channels scroll beneath it.
      if (row.kind === 'master') for (const cell of tr.cells) cell.style.top = headHeight + 'px';
    }
  }
  function layoutColumns() {
    const v = view(), labelWidth = v.settingLabelWidth ?? defaultLabelWidth;
    const acrossRows = (id: string) => rows.map(row => cellFor(row.id, id));
    place(tracks, [labelTrack, ...rows.map(row => channelTracks.get(row.id)!)]);
    labelTrack.style.width = labelWidth + 'px';
    let width = labelWidth;
    for (const row of rows) { const w = v.cameraWidths?.[row.id] ?? defaultChannelWidth; channelTracks.get(row.id)!.style.width = w + 'px'; width += w; }
    table.style.width = width + 'px';
    const heightOf = (id: string) => (v.settingHeights?.[id] ?? defaultSettingHeight) + 'px';
    place(head, [numberRow, ...meta.map(m => identityRows.get(m.id)!)]);
    place(numberRow, [numberCorner, ...rows.map(row => numberHeads.get(row.id)!)]);
    for (const [index, row] of rows.entries()) { const number = numberHeads.get(row.id)!; number.textContent = String(index + 1); number.setAttribute('aria-label', rowName(row)); }
    for (const m of meta) { const row = identityRows.get(m.id)!; place(row, [labelHead(m.id), ...acrossRows(m.id)]); row.style.height = heightOf(m.id); }
    const list = shownFields(), bodyRows: HTMLElement[] = [];
    for (const id of shownGroups()) {
      const section = sectionRows.get(id)!, th = groupHeaders.get(id)!;
      th.scope = 'rowgroup'; th.hidden = false; th.colSpan = 1; section.filler.colSpan = Math.max(1, rows.length);
      place(section.row, rows.length ? [th, section.filler] : [th]); bodyRows.push(section.row); groupControls.get(id)?.refresh();
      for (const field of list.filter(f => f.group === id)) { const row = settingRow(field.id); place(row, [labelHead(field.id), ...acrossRows(field.id)]); row.style.height = heightOf(field.id); bodyRows.push(row); for (const cell of row.cells) { (cell as HTMLElement).style.left = ''; (cell as HTMLElement).style.top = ''; } }
    }
    place(body, bodyRows);
    // The names and labels stay on screen the way their columns do with channels in rows.
    let top = 0;
    for (const row of [numberRow, ...meta.map(m => identityRows.get(m.id)!)]) {
      for (const cell of row.cells) { cell.style.top = top + 'px'; cell.style.left = cell.classList.contains('setting-label') ? '0px' : ''; }
      top += row.offsetHeight;
    }
  }
  function followSelection() {
    if (!active || !rowById.has(active.rowId)) return;
    const shownOnTab = meta.some(m => m.id === active!.columnId) || shownFields().some(f => f.id === active!.columnId);
    controls.select(position(shownOnTab ? active : { rowId: active.rowId, columnId: meta[0]!.id }), undefined, { focus: false });
  }
  function render() {
    if (disposed) return;
    if (!showing()) { if (wasShowing) { wasShowing = false; resize?.refresh(); reorder?.refresh(); } return; }
    wasShowing = true;
    table.style.setProperty('--camera-text-size', (view().textSize ?? 13) + 'px');
    const flip = flipped();
    table.dataset.orientation = flip ? 'columns' : 'rows';
    rows = rowsFor(store.document, observed(), kind); rowById = new Map(rows.map(row => [row.id, row]));
    for (const [id, element] of rowNodes) if (!rowById.has(id)) {
      element.remove(); rowNodes.delete(id);
      for (const [key, cell] of cells) if (cell.dataset.rowId === id) { dropSlider(key); cell.remove(); cells.delete(key); }
      for (const placeholder of placeholders.values()) placeholder.cells.delete(id);
      channelTracks.get(id)?.remove(); channelTracks.delete(id); numberHeads.get(id)?.remove(); numberHeads.delete(id);
    }
    for (const row of rows) ensureRow(row);
    if (flip) layoutColumns(); else layoutRows();
    const visible = shownFields(), columnIds = [...meta.map(m => m.id), ...visible.map(f => f.id)], selection = ticked();
    for (const row of rows) {
      const current = seen(row), about = row.unit && unitObservation(observed(), row.unit), online = live(row);
      rowNodes.get(row.id)!.dataset.selected = String(row.kind === 'channel' && selection.has(row.id));
      for (const id of columnIds) {
        const cell = cellFor(row.id, id), address = { rowId: row.id, columnId: id };
        cell.dataset.hubbleRow = flip ? id : row.id; cell.dataset.hubbleColumn = flip ? row.id : id;
        if (cell === editor?.cell) continue;
        const field = cellValue(address), invalid = store.invalid.get(addressKey(address)), definition = id === 'unit-name' ? nameField : fieldById.get(id);
        cell.setAttribute('aria-readonly', String(!field || !!field.readOnly));
        cell.toggleAttribute('aria-invalid', !!invalid); if (invalid) cell.setAttribute('aria-invalid', 'true');
        const failure = definition ? current?.errors[definition.id] : undefined;
        cell.title = invalid?.message ?? failure ?? (definition && (online || current?.planned) ? current?.locked[definition.id] ?? '' : '');
        cell.setAttribute('aria-label', (settingLabel(id) ?? id) + (flip ? ' for ' + rowName(row) : '') + (invalid ? ': ' + invalid.message : ''));
        let pending = false, sending = false;
        const known = online || !!current?.planned;
        if (row.kind === 'master') pending = !!definition && id !== 'unit-name' && editedRows().some(target => { const value = staged(target, definition.id); return !!value && value !== seen(target)?.values[definition.id]; });
        else if (definition) { const value = staged(row, definition.id); pending = known && !!value && value !== current?.values[definition.id]; sending = current?.sending.includes(definition.id) ?? false; }
        cell.dataset.pending = String(pending); cell.dataset.sending = String(sending); cell.dataset.failed = String(pending && !!failure);
        cell.classList.toggle('mixed', !!field?.mixed && !invalid);
        if (field?.kind === 'boolean' && !invalid) { delete cell.dataset.empty; if (!cell.firstElementChild?.hasAttribute('data-hubble-boolean')) { const slot = document.createElement('span'); slot.setAttribute('data-hubble-boolean', ''); cell.replaceChildren(slot); } continue; }
        const slider = !invalid && !!sliderRange(address);
        cell.classList.toggle('slider-cell', slider);
        if (slider) { delete cell.dataset.empty; showSlider(cell, address); continue; }
        dropSlider(addressKey(address));
        const from = row.kind === 'master' && definition ? seen(editedRows().find(target => !fieldCell(target, definition).readOnly) ?? row) : current;
        cell.textContent = invalid?.edit.value ?? (field?.mixed ? 'Mixed' : id === 'unit-mode' && field && !field.readOnly ? modeLabel(field.value) : definition && id !== 'unit-name' ? displayValue(observed(), from, definition, field?.value ?? '') : field?.value ?? '');
        if (!cell.textContent && !field?.readOnly) cell.dataset.empty = 'true'; else delete cell.dataset.empty;
        if (id === 'connection-status' || id === 'row-signal') cell.dataset.connection = about?.state === 'live' ? about.simulated ? 'simulated' : id === 'connection-status' ? 'live' : '' : about?.state ?? (row.unit && (row.unit.values['unit-host'] || isSimulated(row.unit)) ? 'connecting' : 'unset');
      }
    }
    controls.refresh(); resize?.refresh(); reorder?.refresh(); columnEditor.refresh();
    const nowShowing = activeSheetId(store.document) + '/' + table.dataset.orientation;
    if (nowShowing !== shownLayout) { shownLayout = nowShowing; followSelection(); }
  }
  const unsubscribe = store.subscribe(render);
  render();
  return { kind, refresh: render, select: (address: SpreadsheetAddress) => controls.select(position(address)), get active() { return active; }, get editing() { return editor?.address; }, getValue: (address: SpreadsheetAddress) => cellValue(address), dispose() { disposed = true; unsubscribe(); for (const key of [...sliders.keys()]) dropSlider(key); for (const control of controlsToDispose.reverse()) control.dispose(); } };
}
