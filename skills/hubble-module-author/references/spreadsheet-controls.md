# Spreadsheet controls in a custom layout

This is the reference for Hubble's typed spreadsheet controls API. For
package-owned controls, use the
[spreadsheet styling and implementation guide](spreadsheet-styling.md).
You can use the guide for your layout and mount individual API controls
where you want shared behavior.

Use `@hubble/module-sdk/spreadsheet-controls` (kit 1.8.0-dev.2 or newer)
inside a [package-owned custom page](custom-pages.md). Declare API 1, minimum
Hubble `2.0.18`, and these required host features:

```json
{
  "minimumVersion": "2.0.18",
  "requiredFeatures": [
    "module-pages-v1",
    "module-custom-pages-v1",
    "module-spreadsheet-controls-v1"
  ]
}
```

Also declare `module-workspace-instances-v1` if the package registers a workspace
instance, as the example does. Check the host's actual `describe` feature list:
older builds reporting the same version can predate this capability. The
versioned runtime comes from the host; the kit bundles only the loader and
types. It runs in the existing opaque frame with no new permissions or preload.
Copy and paste use the focused browser's user-initiated clipboard events.

## Attach to a layout

The module creates and styles its own DOM. Give the root an accessible name and
use grid, row, and gridcell semantics. Mark each cell with `data-hubble-row` and
`data-hubble-column` equal to its stable IDs. Return the visible rows and columns
in display order. The controls add selection styling and render the fill handle,
dropdown button and the actual Button Matrix choice editor. Keep cell elements
and the grid root mounted during feedback, or call `refresh()` after changing
the layout or values. Call `dispose()` when removing the grid.

```ts
import { mountSpreadsheetControls } from "@hubble/module-sdk/spreadsheet-controls";

const controls = await mountSpreadsheetControls({
  root: gridElement,
  getRows: () => visibleRowIds,
  getColumns: () => [
    { id: "route", label: "Route", fill: "copy" },
    { id: "name", label: "Name", fill: "series" },
  ],
  getCell(address) {
    // Return null for an unavailable cell. value is the stored string.
    return draftCell(address);
  },
  onEdit(batch) {
    updateVisibleDraft(batch.edits);
    enqueueModuleSave(batch);
  },
  onError(error) {
    showError(error.message);
  },
});
```

A choice cell supplies `choices` as an array of `{ value, label, group? }` or a
function `(query, signal) => options | Promise<options>`. Use stable unique
`value` IDs; display labels may be duplicated or renamed. The editor groups
choices and filters by label/group first, then by stored ID. The button,
Enter, F2, Option+Down, or typing into a selected cell opens it. Up/Down move
through results, Enter chooses, and Escape dismisses. The host aborts stale
queries and ignores their results. To replace a live provider while the editor
is open, expose a new provider function through the adapter and call `refresh()`.
Keep the function identity stable during unrelated feedback. The example
uses the scoped page command bridge as its provider; it checks cancellation
before returning a result.

## Selection, clipboard, and fill

Click or drag to select; Shift+click and Shift+arrows extend the rectangle.
`controls.select(anchor, end?)` focuses a range programmatically. Embedded text
inputs, buttons and other editing controls retain their own input behavior.

- Copy produces rectangular plain text TSV with quoted tabs, newlines and
  quotes. Choice cells export their IDs. Paste preserves strings as supplied;
  the module can validate IDs without needing to query the live catalog.
  Paste starts at the anchor, or tiles the source when it fits the selected
  rectangle exactly. Unavailable source cells copy as empty TSV fields.
- Drag the selected range's bottom corner to preview and fill in one direction.
  Columns default to `copy`; `series` extends a consistent difference between
  seeds, including signed numbers, decimals, numbered names with padding, and
  IPv4 addresses with octet carry. With no consistent difference, the seed
  pattern repeats. Choice targets always copy IDs. A skipped target still
  counts toward the series distance. IPv4 values outside the address space are
  skipped. The seeds and filled cells remain selected after the drop, with the
  handle at the corner of the extended range.
- Paste and fill skip unavailable, read-only, out-of-grid and unchanged
  destinations. Edits retain their original coordinates and go to `onEdit` as
  one `{ source, edits: [{ rowId, columnId, value }] }` batch per gesture. An empty
  edit set produces no callback. Each interaction is bounded to 10,000 cells;
  the shared TSV codec limits text to 2 MiB.

Apply drafts synchronously, queue saves in order, reconcile only the batch
acknowledged, and show validation failures. The host does not write data,
convert values to domain types, send device commands, or infer undo or rollback
for these custom controls. Your backend can validate the entire batch before
writing or sending. Use a portable module document for saved workspace data.
For the full host Matrix surface with formulas, toolbar, workbook transfer and
history, compose a [native workbook](native-workbooks.md) alongside the page.

## Optional expandable column groups

Kit 1.8.0-dev.9 adds `mountSpreadsheetColumnGroup`. Require
`module-spreadsheet-column-groups-v1` and check the installed host's feature
list. Earlier hosts can supply cell controls without this optional header API.

Create an empty slot in your group header and give the control the group's full
field list, display order, expanded state, and fields to keep visible while
collapsed. Plain columns need no group control. The host supplies **+** and **−**,
the **Expand/Collapse** context command, and the Matrix **Collapsed fields**
submenu with checkboxes and field reordering.

```ts
import {
  mountSpreadsheetColumnGroup,
  type SpreadsheetColumnGroup,
} from "@hubble/module-sdk/spreadsheet-controls";

let group: SpreadsheetColumnGroup = {
  id: "routing",
  label: "Routing",
  columns: [
    { id: "source", label: "Source" },
    { id: "destination", label: "Destination" },
    { id: "level", label: "Level" },
  ],
  expanded: false,
  collapsedColumnIds: ["source"],
};
const header = await mountSpreadsheetColumnGroup({
  root: groupHeaderSlot,
  getGroup: () => group,
  onChange(next) {
    group = next;
    const visible = group.columns.filter(
      (column) =>
        group.expanded || group.collapsedColumnIds.includes(column.id),
    );
    renderGroupColumns(visible);
    controls.refresh();
  },
});
```

Every group has a stable ID and unique fields, with at least one field visible
when collapsed. The module renders and hides its own cells and returns their
visible order to the spreadsheet adapter. Update that layout synchronously.
Use `header.refresh()` for incoming module state and `header.dispose()` when
removing the slot. The module decides whether to keep layout state transient
or save it in a portable document with its validation and save queue.

## Shared menus and row/column dragging

Kit 1.8.0-dev.11 adds `createSpreadsheetContextMenu` and
`mountSpreadsheetReorder`. Both require `module-spreadsheet-layout-v1`.
The host supplies the actual Matrix menu CSS and Radix menu behavior, including
submenus, keyboard navigation, disabled commands, separators, and danger items.
The module supplies labels and callbacks; the host adds no Copy, Select, or Move
Left/Right commands.

```ts
import {
  createSpreadsheetContextMenu,
  mountSpreadsheetReorder,
} from "@hubble/module-sdk/spreadsheet-controls";

const menu = await createSpreadsheetContextMenu({ root: gridElement });
menu.open({
  x: event.clientX,
  y: event.clientY,
  label: "Row",
  items: [
    { id: "insert", label: "Insert row above", icon: "add", run: insertRow },
    { separator: true },
    {
      id: "delete",
      label: "Delete row",
      icon: "delete",
      danger: true,
      run: deleteRow,
    },
  ],
});
const reorder = await mountSpreadsheetReorder({
  root: gridElement,
  getItems: () =>
    visibleRows.map((row) => ({
      id: row.id,
      label: row.label,
      axis: "row",
      handle: row.headerElement,
      elements: row.visibleCellElements,
    })),
  getSelectedRows: () => selectedWholeRowIds,
  onSelect(item, extend) {
    selectWholeRow(item.id, extend);
  },
  onMove(move) {
    applyVisibleMove(move);
    enqueueModuleSave(move);
  },
});
```

Hold a header for 300 ms to lift it; moving more than 8 px before that cancels.
The control reuses Matrix's hold threshold, column translation, neighbor
animation calculations, lift styling and insertion guides. DOM snapshots keep
the module's live inputs mounted. A column or group moves horizontally; selected
whole rows move vertically in their original order. Escape cancels. With a
header focused, Option/Alt+Shift+Left/Right moves a column, and Up/Down moves a row.
Scrolling, resizing or changed layout geometry cancels a gesture. Value-only
feedback refreshes keep the active drag intact.

For columns, return `axis: "column"`. Use `scope` to constrain peers (for example,
top-level columns versus fields inside one group). A group is one item whose
`elements` contain its visible headers and cells. IDs must be unique within each
axis and scope. Hidden elements are excluded from previews and drop targets.
Interactive buttons inside headers, including +/−, retain their own behavior.

One completed move calls `onMove({ axis, scope?, ids, beforeId })`. A null
`beforeId` means the end. No-op and cancelled drags emit nothing. This callback
does not save, validate, delete, or send device commands. Apply it immediately;
use stable IDs and expected row order in the module's ordered save queue.
On failure, roll back dependent moves while preserving unrelated cell edits.
The workbook session below demonstrates this with held-save tests.

After DOM/layout changes call `reorder.refresh()` and `controls.refresh()`.
Call `menu.dispose()` and `reorder.dispose()` when removing the custom view.
The APIs run inside the existing sandbox and require no extra frame permissions.
Persistent row order belongs in the portable document; custom view-only column
order may stay transient when it must not change the separate native workbook.

## Extended editing and resize handles

Kit 1.8.0-dev.12 adds `module-spreadsheet-extended-editing-v1`. Require this
feature for the following controls. Set `extendedEditing: true` on the grid
adapter to enable clear and separate selections.

- Delete and Backspace clear all selected editable cells in one `clear` batch.
  A menu command can call `controls.clear()` for the same behavior. The empty
  value lets the module decide how to clear a field and discard rejected drafts.
- Hold Command on Mac or Ctrl elsewhere while clicking or dragging to add
  another selection. Copy writes quoted TSV with blank gaps and a Hubble
  clipboard format that preserves which cells were selected. With that format,
  paste at a cell keeps the copied offsets and skips the gaps. When pasting into
  a separate selection, one value broadcasts or an equal number of values maps
  in row-major order. Other counts are rejected. Plain TSV is the interchange
  format for apps that discard the Hubble format. Fill requires one rectangle.
- Return `kind: "boolean"` with canonical `TRUE` or `FALSE` values and provide
  an empty `data-hubble-boolean` slot inside the cell. The runtime supplies the
  styled checkbox and its accessible checked state. Click it or press Space on
  the selected cell to emit one `toggle` edit. Read-only checkboxes are disabled.
  Persist native booleans in the module document and translate the clipboard
  wire values at the adapter boundary.

Use `mountSpreadsheetResize({ root, viewport, getItems, onResize })` for the
Matrix column-edge handles, row gutter edges, and resize guide. Each visible
item supplies `id`, `label`, `axis`, `header`, `size`, `min`, and `max`.
Sizes are pixels. Drag an edge or focus it and use the corresponding arrow keys.
The callback receives the item and final size once per completed drag. Escape
cancels. Call `refresh()` after layout changes and `dispose()` on removal.

Give each column its own width and let the scroll viewport contain a wider
table. Expanding a group adds width to the grid, preserving earlier column
positions and widths. The example styles its viewport's native scrollbar
with a thin thumb and the dark grid palette. Patch Sheet's custom column widths and row heights are
view state for the current page. Its native workbook has separate saved layout.

## Workbook tools for custom layouts

Kit 1.8.0-dev.16 adds `mountSpreadsheetColumnEditor`. Require
`module-spreadsheet-column-editor-v1` to mount the shared Matrix **Columns**
button in a module-chosen slot. The module supplies an ordered list through
`getItems`. Include every field the operator may restore, even when
`visible` is false. A group supplies its own `id`, `label`, and ordered
`fields` with stable IDs. The menu stays open after a visibility change.
Handle `onVisibilityChange` immediately and call `refresh()` with the updated
items. Provide `onMove(id, beforeId)` for drag and arrow reordering within
each sibling list. A null destination means the end of that list.
If a toggle hides the active cell, `select(next, undefined, { focus: false })`
lets the grid update its selection without closing the picker. Save layout
through the module's existing preferences. This button can mount by itself.

Kit 1.8.0-dev.14 includes `module-spreadsheet-workbook-tools-v1`. Add it to the
manifest when using the workbook tools. The module selects the tools to mount
and owns the data, validation, layout, save receipts, and device rules.

| Tool                                    | Adapter behavior                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSpreadsheetWorkbookTools(table)` | Reuse the native workbook's optimistic history session, row builders, dependent-choice resets, formula calculation and reference remapping, and portable workbook codec.                                          |
| `mountSpreadsheetToolbar`               | Opt in to a toolbar with any combination of the source editor, history buttons, and freeze and text-size controls. Expose the selected source using stable IDs and pass reference clicks through `pickReference`. |
| `mountSpreadsheetViewport`              | Apply the Matrix pinch and Ctrl-wheel zoom curve and freeze module-supplied cells at their logical offsets. Zoom is transient. Call resize refresh on zoom and pass the ratio to resize through `getScale`.       |
| `createSpreadsheetWorkbookTransfer`     | Open a focused copy or paste dialog for native clipboard events. The module supplies the encoded workbook and handles validated replacement.                                                                      |
| `mountSpreadsheetSheets`                | Mount sheet tabs only when the module opts in. The module supplies sheets, selected ID, row counts and callbacks for add, rename, reorder, remove, and optional moves between sheets.                             |

The grid mounts without a toolbar. To compose individual sections with Kit
1.8.0-dev.15, require `module-spreadsheet-toolbar-sections-v1` in addition to
the workbook tools feature. Pass `getSource` and `onSource` for the formula
bar, `getHistory` and `onHistory` for the history buttons, or `layout` for
freeze and text size. Omit the mount entirely for a grid-only layout. Inline
formulas and grid history shortcuts work independently of the toolbar.

Turn on `workbookEditing` in `mountSpreadsheetControls` for Cut, formula
clipboard metadata, and Tab navigation. Provide `onHistory` for Undo and
Redo shortcuts. Cell editors can call `move(columns, rows)` after committing
on Tab or Enter. Cut holds a source snapshot until a compatible paste into
the same grid. A successful move emits one batch. A changed or protected
source, or an incompatible destination, leaves the source intact. A different
grid receives a copy. Paste and fill translate relative formula references
from `formulaPoint` using `translateFormula` from the workbook tools. Absolute
references stay fixed. Return `formula` and
`acceptsFormula` from the cell adapter and persist source and result separately.

For formulas, use `calculate({ rows, view })` before saving the projected
document. The runtime sends a bounded snapshot to the existing formula worker
through the current sandbox frame. Use the same formula coordinate view in both
custom and native layouts when sharing a document. Keep formula sources and
reference mapping independent of presentation-only reordering. The module can
keep a rejected formula visible as a local draft and show its calculation error.
In an inline formula editor, consume the grid's `onReferencePick` callback
while the input is focused. Use the workbook tools' `reference` method to
insert the clicked cell's address at the caret. Patch Sheet demonstrates this
in Number and Name without mounting the formula bar.
The example uses `workbook.formulaChoiceValues: "label"` in both layouts so
a reference to Route or Area evaluates to its visible label.

Return `kind: "color"` on a color cell to open the Matrix picker. Provide
`colorFavorites` to save favorites in module-owned preferences. Patch Sheet
uses the hex value as the full cell background and gives the label and
selection outline a contrasting color. For related
choices, declare `choiceDependencies` and use `resetChoices` after projecting
a batch. Explicit batch values take precedence and the module validates them
against the resulting context. Supply a live choices provider keyed by context.

Store a custom view separately from the native workbook layout if the same
document has both views. Call the shared session's `edit` with the next
snapshot, a revision-checked save callback, and an error handler. The session
projects edits and history immediately and preserves independent observations
during ordered saves. Use stable row IDs for layout and transfer. The workbook
codec verifies column compatibility and remaps copied row and sheet IDs. Persist
module-owned layout fields in the portable document and include them in a
transfer round trip. One custom sheet is sufficient and creates no sheet UI.

## Runnable example

From the extracted kit, build and pack the example:

```sh
node module-tool.mjs build examples/custom-spreadsheet
node module-tool.mjs test examples/custom-spreadsheet
node module-tool.mjs pack examples/custom-spreadsheet example-custom-spreadsheet.hubble-module
```

Import and select it in a test workspace. The **Patch Sheet** custom page and **Patch Workbook** native page use the same
[portable document](documents.md). The example manifest lists the extra
capabilities required by that composition.

- In **Patch Sheet**, type to replace an editable text or number cell.
  Double-click or press F2 to edit the current value. Enter commits and
  Escape cancels. In a Route cell, typing searches the live choice provider.
  Drag the corner of the first two rows to exercise copy and series fill.
  Enabled demonstrates checkboxes, including a disabled checkbox on the locked
  row. Use the column edges or the bottom edges of row numbers to resize.
- The package-owned input feeds the same ordered edit queue as choice,
  paste, and fill gestures. Each edit carries the expected value so a
  delayed batch cannot overwrite a newer edit to the same cell. Submit
  `10.0.0.999` in Address to see the rejected text stay visible with its
  error. It stays local and can be corrected in place. Right-click a cell
  for edit, clear, or discard commands. The module declares a **Patch
  details** group containing Name, Address, and Note. Its shared **+** header
  reveals all three fields, and **−** returns to the configured collapsed
  fields. Right-click the group header to choose those fields or reorder them.
  Route and Number are ordinary columns. The example saves group layout in
  the document's custom view. Navigation, clipboard, and fill use its visible
  field order.
  Hold and drag the column headers, group header, or row numbers to reorder.
  Row moves save to the shared document. The row menu inserts and deletes rows;
  the column menu hides columns. Click **Columns** above the grid to restore
  unchecked fields and reorder them with grips or arrows. Checking a field
  in a collapsed group adds that field to the compact view. Keyboard and
  native clipboard commands still work.
- In **Patch Workbook**, use the host's editing and sheet tools on the same
  data. Try `=8+4` in Number. In **Patch Sheet**, type `=` in Number or Name,
  click a source cell, and press Enter. Both pages use the same field
  restrictions and document validation. The custom example opens without a
  toolbar. Its `toolbarSections` declaration in `src/frontend.ts` can enable
  each section separately.

See the example's README for the source map. The example stores workspace data
and demonstrates local editing only.
