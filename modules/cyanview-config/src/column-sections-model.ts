// Column sections in the Columns dropdown, on a Hubble that has them
// (module-spreadsheet-column-sections-v1). Each camera setting has its own Show tick, which
// collapsing never changes, and the Iris, Zoom and Focus sections each say which settings stay on
// screen while they are collapsed (When collapsed). The page draws a setting when its Show is
// ticked and its section is expanded or keeps it When collapsed. Sections that can't collapse
// (Source, REMI, Camera, Lens) keep a tick of their own.
// Shared by the page and the tests; nothing here reads the page.

export interface ColumnSectionField { readonly id: string; readonly label: string }
export interface ColumnSection {
  readonly id: string;
  readonly label: string;
  /** Iris, Zoom or Focus: a section that collapses on the page. */
  readonly axis?: string;
  /** In the order the page draws them. */
  readonly fields: readonly ColumnSectionField[];
}
export interface ColumnSectionState {
  /** Settings whose Show is unticked. */
  readonly hidden: readonly string[];
  /** Sections switched off: none of their settings are drawn, and their settings all show unticked. */
  readonly hiddenGroups: readonly string[];
  /** Iris, Zoom and Focus: expanded on the page. */
  readonly expanded: Readonly<Record<string, boolean>>;
  /** Iris, Zoom and Focus: the settings kept on screen while collapsed. */
  readonly kept: Readonly<Record<string, readonly string[]>>;
}
export interface ColumnSectionItemField { id: string; label: string; visible: boolean; shownWhenCollapsed?: boolean }
export interface ColumnSectionItem { id: string; label: string; visible?: boolean; expanded?: boolean; fields: ColumnSectionItemField[] }

export const sectionItemId = (sectionId: string) => 'section:' + sectionId;
const sectionOf = (sections: readonly ColumnSection[], fieldId: string) => sections.find(section => section.fields.some(field => field.id === fieldId));

/** A setting's own Show tick: it is ticked and its section is on. Collapse never changes it. */
export function columnShown(sections: readonly ColumnSection[], state: ColumnSectionState, fieldId: string): boolean {
  const section = sectionOf(sections, fieldId);
  return !!section && !state.hiddenGroups.includes(section.id) && !state.hidden.includes(fieldId);
}

/**
 * The Columns dropdown's items for one sheet. What the page draws is the kit's
 * spreadsheetColumnsOnScreen of these: Show ticked, and its section expanded or keeping it When collapsed.
 */
export function columnSectionItems(sections: readonly ColumnSection[], state: ColumnSectionState): ColumnSectionItem[] {
  return sections.map(section => {
    const fields = section.fields.map(field => ({ id: field.id, label: field.label, visible: columnShown(sections, state, field.id) }));
    if (!section.axis) return { id: sectionItemId(section.id), label: section.label, visible: !state.hiddenGroups.includes(section.id), fields };
    const kept = state.kept[section.axis] ?? [];
    return {
      id: sectionItemId(section.id), label: section.label, expanded: state.expanded[section.axis] === true,
      fields: fields.map(field => ({ ...field, shownWhenCollapsed: kept.includes(field.id) })),
    };
  });
}

/**
 * Show ticks, each a setting's own, whatever its section's collapse. A section with every setting
 * unticked is switched off; ticking one of its settings brings it back with only that one. A
 * section's own tick (Source, REMI, Camera, Lens) switches it off, or back on with every setting.
 * Settings outside these sections keep what they had.
 */
export function withSectionVisibility(sections: readonly ColumnSection[], state: ColumnSectionState, changes: readonly { id: string; visible: boolean }[]): Pick<ColumnSectionState, 'hidden' | 'hiddenGroups'> {
  let hidden = [...state.hidden], off = [...state.hiddenGroups];
  const touched = new Set<string>();
  const fieldsOf = (section: ColumnSection) => section.fields.map(field => field.id);
  for (const { id, visible } of changes) {
    const whole = sections.find(section => sectionItemId(section.id) === id);
    if (whole) {
      const ids = fieldsOf(whole);
      hidden = hidden.filter(field => !ids.includes(field));
      off = off.filter(section => section !== whole.id);
      if (!visible) off.push(whole.id);
      continue;
    }
    const section = sectionOf(sections, id);
    if (!section) continue;
    touched.add(section.id);
    if (off.includes(section.id)) {
      if (!visible) continue;
      off = off.filter(item => item !== section.id);
      hidden = [...new Set([...hidden.filter(field => field !== id), ...fieldsOf(section).filter(field => field !== id)])];
      continue;
    }
    hidden = hidden.filter(field => field !== id);
    if (!visible) hidden.push(id);
  }
  for (const id of touched) {
    const section = sections.find(item => item.id === id)!, ids = fieldsOf(section);
    if (off.includes(id) || !ids.every(field => hidden.includes(field))) continue;
    off.push(id);
    hidden = hidden.filter(field => !ids.includes(field));
  }
  return { hidden, hiddenGroups: off };
}

/** When collapsed ticks: which settings a collapsed Iris, Zoom or Focus section keeps on screen. */
export function withShownWhenCollapsed(sections: readonly ColumnSection[], state: ColumnSectionState, changes: readonly { id: string; shownWhenCollapsed: boolean }[]): Record<string, string[]> {
  const kept: Record<string, string[]> = Object.fromEntries(Object.entries(state.kept).map(([axis, ids]) => [axis, [...ids]]));
  for (const { id, shownWhenCollapsed } of changes) {
    const axis = sectionOf(sections, id)?.axis;
    if (!axis) continue;
    const list = kept[axis] ?? [];
    kept[axis] = shownWhenCollapsed ? [...new Set([...list, id])] : list.filter(field => field !== id);
  }
  return kept;
}
