# Spreadsheet styling and implementation guide

Use this guide when your module renders and implements its own spreadsheet.
The examples describe the Patch Sheet presentation and interaction states you
should match. The guide itself has no spreadsheet runtime requirement. If you
want Hubble to supply any of the controls, use the
[spreadsheet controls API](spreadsheet-controls.md) for those features. You can
use both approaches in the same view.

## Visual baseline

These are the dark theme values used by the Patch Sheet reference. Keep the
states visually distinct if your view uses a different theme.

| Element or state              | Reference presentation                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Grid                          | `#111` surface, `#dedede` text, 13 px system font, 1 px `#3b3b3b` cell dividers                                        |
| Column header                 | `#222` surface. Keep column names legible and aligned with their cells.                                                |
| Read-only or unavailable cell | `#999` text and a programmatically exposed read-only state.                                                            |
| Selected range                | Translucent `#cecece` fill at 12% with a 1 px inset outline.                                                           |
| Active cell                   | A 2 px inset outline. During text editing, use a single `#6aa9ff` editor border as the focus indicator.                |
| Invalid draft                 | Keep the typed value visible. Use `#342021` behind `#f2aaa5` text, a corner marker, and an accessible error message.   |
| Color cell                    | Paint the whole cell with the selected color. Give its hex label and selection outline contrasting colors.             |
| Fill handle and preview       | Use an 8 px square at the range corner and a dashed outline for the pending fill area.                                 |
| Columns popup                 | Use checkmarks for visibility, grip handles and arrow buttons for ordering. Labels should be legible and unselectable. |
| Horizontal scroll             | Keep a thin, dark scrollbar visible when the grid overflows.                                                           |

Use stable column widths. A collapsed column group shows its configured summary
fields and a **+** control. Expanding it reveals additional fields to the right
without shrinking or moving earlier columns. Show **−** to collapse it again.
Give resize and reorder separate targets. Show an insertion marker during a
reorder. Use a checkbox for a Boolean cell, with a disabled state if protected.

## Behavior to match

- Use accessible grid, row, header and cell semantics, stable row and column
  IDs, and a visible keyboard focus. Move with arrows, extend with Shift, and
  support Command/Ctrl-click for separate cells. Keep keyboard focus in the
  grid after an edit or menu action when appropriate.
- Type to replace an editable value, double-click or use F2 to edit its
  current value, commit with Enter or Tab, and cancel with Escape. For choice
  cells, typing searches grouped options. Up and Down navigate, Enter chooses,
  and Escape dismisses. Ignore stale live search results and store stable IDs
  independently of labels.
- Use quoted TSV for plain text clipboard data, including embedded tabs,
  quotes and newlines. Preserve the shape of a sparse selection when copying
  and pasting within your grid. Clear all selected editable cells in one edit.
- Apply copy or series fill per column. For series, use the seed values to
  continue numbers, padded names or IPv4 addresses. Keep the extended range
  selected after filling.
- Skip read-only and unavailable destinations for paste, fill and clear.
  Send one edit batch per gesture to the module for validation and saving.
  Apply the visible edit immediately, preserve newer edits when a save
  finishes, and surface a failure while keeping the grid usable.
- Make the formula bar, extra toolbar controls and multiple worksheets
  opt-in. If you implement formulas, keep source separate from the computed
  value and preserve absolute references when copying or filling.

## Own the parts you build

Your module owns the markup, input handling, validation, persistence and
device send rules for controls you implement yourself. Scope your styles to
your page. Use the [custom page bridge](custom-pages.md) for backend commands
and the [document service](documents.md) for portable data. Declare those
host capabilities when you use them. Native menu dispatch and richer
clipboard behavior require integration and testing in the installed renderer.

If you mount any shared control, use its documented options and manifest
capability. The host supplies that control's interaction and presentation.
Use module CSS for the surrounding layout and cells, without depending on
private host class names. Patch Sheet in `examples/custom-spreadsheet`
shows this combination and includes a native workbook page over the same
document.
