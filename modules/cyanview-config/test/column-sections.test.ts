import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spreadsheetColumnsOnScreen } from '@hubble/module-sdk/spreadsheet-controls';
import { columnSectionItems, sectionItemId, withSectionVisibility, withShownWhenCollapsed, type ColumnSection, type ColumnSectionState } from '../src/column-sections-model.js';

// A controller's camera sheet: Camera can't collapse; Iris and Zoom can.
const sections: ColumnSection[] = [
  { id: 'camera', label: 'Camera', fields: [{ id: 'number', label: 'Camera number' }, { id: 'name', label: 'Camera name' }, { id: 'ip', label: 'Camera IP / interface' }] },
  { id: 'iris', axis: 'iris', label: 'Iris', fields: [{ id: 'irisSummary', label: 'Use Iris' }, { id: 'irisMotor', label: 'Motor ID' }, { id: 'irisMin', label: 'Open' }, { id: 'irisMax', label: 'Closed' }] },
  { id: 'zoom', axis: 'zoom', label: 'Zoom', fields: [{ id: 'zoomSummary', label: 'Use Zoom' }, { id: 'zoomMotor', label: 'Motor ID' }] },
];
const start: ColumnSectionState = { hidden: [], hiddenGroups: [], expanded: { iris: false, zoom: true }, kept: { iris: ['irisSummary'], zoom: [] } };
const items = (state: ColumnSectionState) => columnSectionItems(sections, state);
const onScreen = (state: ColumnSectionState) => spreadsheetColumnsOnScreen(items(state));
const shows = (state: ColumnSectionState, changes: { id: string; visible: boolean }[]): ColumnSectionState => ({ ...state, ...withSectionVisibility(sections, state, changes) });
const keeps = (state: ColumnSectionState, changes: { id: string; shownWhenCollapsed: boolean }[]): ColumnSectionState => ({ ...state, kept: withShownWhenCollapsed(sections, state, changes) });
const expand = (state: ColumnSectionState, axis: string, expanded: boolean): ColumnSectionState => ({ ...state, expanded: { ...state.expanded, [axis]: expanded } });

test('column sections: only Iris, Zoom and Focus report expanded and When collapsed; the page draws Show and (expanded or When collapsed)', () => {
  const list = items(start);
  assert.deepEqual(list.map(item => [item.id, item.expanded, item.visible]), [['section:camera', undefined, true], ['section:iris', false, undefined], ['section:zoom', true, undefined]]);
  assert.deepEqual(list[1]!.fields.map(field => [field.id, field.visible, field.shownWhenCollapsed]), [['irisSummary', true, true], ['irisMotor', true, false], ['irisMin', true, false], ['irisMax', true, false]]);
  assert.ok(list[0]!.fields.every(field => field.shownWhenCollapsed === undefined));
  // Collapsed Iris keeps Use Iris; expanded Zoom shows all of its settings.
  assert.deepEqual(onScreen(start), ['number', 'name', 'ip', 'irisSummary', 'zoomSummary', 'zoomMotor']);
});

test('column sections: Show is each setting’s own tick, which collapsing and expanding never change', () => {
  // Unticked while Iris is collapsed, Motor ID stays off when Iris expands.
  const hidden = shows(start, [{ id: 'irisMotor', visible: false }]);
  assert.deepEqual(hidden.hidden, ['irisMotor']);
  assert.deepEqual(onScreen(expand(hidden, 'iris', true)), ['number', 'name', 'ip', 'irisSummary', 'irisMin', 'irisMax', 'zoomSummary', 'zoomMotor']);
  assert.equal(items(expand(hidden, 'iris', true))[1]!.fields[1]!.visible, false);
  // Ticked while Iris is collapsed, Open is Collapsed: on once Iris expands, not before.
  const ticked = shows(hidden, [{ id: 'irisMotor', visible: true }]);
  assert.deepEqual(ticked.hidden, []);
  assert.deepEqual(ticked.kept, start.kept);
  assert.ok(!onScreen(ticked).includes('irisMotor'));
  assert.ok(onScreen(expand(ticked, 'iris', true)).includes('irisMotor'));
});

test('column sections: When collapsed picks what a collapsed section keeps and never changes Show', () => {
  const kept = keeps(start, [{ id: 'irisMax', shownWhenCollapsed: true }, { id: 'irisSummary', shownWhenCollapsed: false }]);
  assert.deepEqual(kept.kept.iris, ['irisMax']);
  assert.deepEqual(kept.hidden, start.hidden);
  assert.deepEqual(onScreen(kept).filter(id => id.startsWith('iris')), ['irisMax']);
  // Expanded, it shows everything ticked Show, kept or not.
  assert.deepEqual(onScreen(expand(kept, 'iris', true)).filter(id => id.startsWith('iris')), ['irisSummary', 'irisMotor', 'irisMin', 'irisMax']);
  // A kept setting whose Show is unticked stays off, collapsed or not.
  const off = shows(kept, [{ id: 'irisMax', visible: false }]);
  assert.deepEqual(off.kept.iris, ['irisMax']);
  assert.ok(!onScreen(off).includes('irisMax'));
  assert.ok(!onScreen(expand(off, 'iris', true)).includes('irisMax'));
  // Settings in a section that can't collapse have no When collapsed.
  assert.deepEqual(withShownWhenCollapsed(sections, start, [{ id: 'name', shownWhenCollapsed: true }]), start.kept);
});

test('column sections: a section with every setting unticked is switched off; ticking one brings it back with only that one', () => {
  // The section's tick-all arrives as one batch.
  const off = shows(expand(start, 'iris', true), sections[1]!.fields.map(field => ({ id: field.id, visible: false })));
  assert.deepEqual(off.hiddenGroups, ['iris']);
  assert.deepEqual(off.hidden, []);
  assert.ok(items(off)[1]!.fields.every(field => !field.visible));
  assert.ok(!onScreen(off).some(id => id.startsWith('iris')));
  const one = shows(off, [{ id: 'irisMin', visible: true }]);
  assert.deepEqual(one.hiddenGroups, []);
  assert.deepEqual(onScreen(one).filter(id => id.startsWith('iris')), ['irisMin']);
  assert.deepEqual(items(one)[1]!.fields.filter(field => field.visible).map(field => field.id), ['irisMin']);
  // Unticking them one at a time switches it off too.
  let single = start;
  for (const field of sections[0]!.fields) single = shows(single, [{ id: field.id, visible: false }]);
  assert.deepEqual(single.hiddenGroups, ['camera']);
  assert.equal(items(single)[0]!.visible, false);
});

test('column sections: a section that can’t collapse keeps its own tick, which brings back every setting', () => {
  const off = shows(start, [{ id: sectionItemId('camera'), visible: false }]);
  assert.deepEqual(off.hiddenGroups, ['camera']);
  assert.ok(!onScreen(off).some(id => ['number', 'name', 'ip'].includes(id)));
  const hidden = shows(start, [{ id: 'ip', visible: false }]);
  const on = shows(shows(hidden, [{ id: sectionItemId('camera'), visible: false }]), [{ id: sectionItemId('camera'), visible: true }]);
  assert.deepEqual(on.hiddenGroups, []);
  assert.deepEqual(onScreen(on).slice(0, 3), ['number', 'name', 'ip']);
});

test('column sections: settings outside the sheet’s sections keep what they had', () => {
  const state = { ...start, hidden: ['password', 'remiMaster'], hiddenGroups: ['lens'] };
  const next = withSectionVisibility(sections, state, [{ id: 'irisMotor', visible: false }, { id: 'unknown', visible: false }]);
  assert.deepEqual(next.hidden, ['password', 'remiMaster', 'irisMotor']);
  assert.deepEqual(next.hiddenGroups, ['lens']);
});
