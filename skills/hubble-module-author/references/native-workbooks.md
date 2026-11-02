# Native module workbooks

Use a declarative `table` section for module spreadsheets. Hubble owns the grid,
editors, menus, keyboard handling and persistence. Do not implement a second
spreadsheet, HTML select, color picker, formula engine or save queue in a module.
The portable developer kit contains the same contract and a runnable
`examples/native-workbook` project. API 1 remains API 1; negotiate individual host
features returned by `service-client.mjs --url <operator-designated-origin> describe`.

## Declare the native UI

```ts
{
  type: 'table', id: 'cameras', label: 'Camera plan', source: 'settings', maxRows: 128,
  workbook: {
    stateKey: 'cameraWorkbook',
    columns: {
      label: { fill: 'series', width: 240 },
      quantity: { formula: true, fill: 'series' },
      color: { editor: 'color', formula: true },
    },
    defaults: { frozenColumns: 1, textSize: 12 },
  },
  columns: [
    { id: 'label', label: 'Label', type: 'text', default: 'Camera 1', required: true },
    { id: 'quantity', label: 'Quantity', type: 'number', default: 1, min: 1, required: true },
    { id: 'enabled', label: 'Enabled', type: 'boolean', default: true, required: true },
    { id: 'color', label: 'Color', type: 'text', default: '#287FA8', required: true },
  ],
}
```

Require `module-pages-v1` and `module-table-workbook-v1`. Only hosts advertising the
feature can open this declaration; a version number alone is insufficient. A
`stateKey` is unique across the module and must not collide with setting or table
IDs. It stores host-owned presentation data inside the instance's settings. Leave
that value intact in migrations and live settings updates. Older workspaces that
lack it receive defaults. Existing tables without `workbook` remain supported.

On Mac, Command-click adds or removes nonconsecutive cells, rows and columns.
Shift extends a continuous selection. Control-click keeps the normal Mac context
menu behavior. Copying separated rows preserves the gaps; compatible selections
must contain the same columns in each selected row.

With `module-table-duplicate-policy-v1`, a workbook input column may declare
`duplicate: 'default'` to reset its value to the field default and remove its
formula when a row is duplicated. Omitted or `'copy'` retains the original value
and normal formula translation. This applies immediately to toolbar and context
menu duplication; it does not change copy/paste or fill semantics. Computed and
read-only columns cannot declare this policy. No module-ID check is required.

Row operations are host-owned API 1 behavior for `source: 'settings'` or editable
`source: 'document'` tables,
bounded by `maxRows`; no module callback or new API version is needed. Right-click
a data cell or its numbered row header to insert, duplicate or delete rows.
Right-clicking inside a selection acts on its selected rows; outside it acts on
the clicked row. To reorder, hold the numbered row header until the drag guide
appears, then drag and release; Escape cancels. Verify both pointer entry points,
multi-row selection, drag cancellation and ordered saves in the real renderer.
Visible toolbar buttons alone do not prove these interactions work. State-backed
tables must not expose row mutations.

The following interactions are the acceptance contract. Verify each applicable
interaction in the full renderer; capability discovery alone is insufficient:

| Interaction                                                        | Module declaration / behavior                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dark grid, coordinate headers, keyboard selection and cell editing | Native for every table; `selectionHighlight: 'cell'` or `'row'` requires `module-table-selection-v1`                                             |
| Text and numeric fields, YES/NO checkboxes                         | `text`, `number`, `boolean` fields, with normal field validation                                                                                 |
| Searchable, grouped choice editors                                 | `choice` fields, static choices or a `choiceProvider`; the selected-cell arrow and keyboard activation open the shared editor                    |
| Contextual and dependent choices                                   | `choiceDependencies` plus `module-table-spreadsheet-v1`; providers use the row draft; explicit pasted choices win over resets                    |
| Color editor, palettes and favorites                               | `workbook.columns[id].editor: 'color'` on a text field; double-click a cell; same editor as Button Matrix                                        |
| Formula source and resolved value                                  | Enable `formula: true` on editable text/number/boolean columns; the formula bar edits the source                                                 |
| Copy, cut and paste                                                | Native shortcuts and commands; internal clipboard retains typed choice IDs and formulas; external text uses quoted TSV                           |
| Repeated rectangular paste                                         | The destination must be an exact multiple of the copied rectangle; computed fields are skipped                                                   |
| Fill handle and series                                             | Default copies values and IDs; `fill: 'series'` uses Hubble's numeric/text series rules; formulas translate relative references and preserve `$` |
| Automatic row numbers                                              | `autoNumber` names an editable text or numeric field; other identifiers never become an accidental series                                        |
| Add, duplicate, delete, reorder rows                               | Toolbar, row context menu, multi-row selection and hold-to-drag; stable row IDs                                                                  |
| Columns, hide/show, order and drag                                 | Shared Columns menu, header context menu and hold-to-drag; keyed by field ID                                                                     |
| Column width, row height, text size, freeze                        | Native resizing and shared controls; saved by stable field/row ID                                                                                |
| Trackpad pinch / Ctrl-wheel zoom                                   | Same anchored zoom curve as Button Matrix; zoom and viewport are transient                                                                       |
| Sheets                                                             | Add, name, rename, reorder, remove and move selected rows; removing a sheet moves its rows into the first remaining sheet                        |
| Undo/redo                                                          | Cell edits, rows, formulas, layout and sheets; up to 200 changes per document during the application session; page navigation retains history    |
| Full workbook clipboard                                            | Copies rows, formula sources, sheets, assignments and layout; pasting requires matching column IDs/types and remaps row/sheet identities         |
| Immediate edits with ordered background saves                      | Host-owned; controls stay usable while saves are unresolved; failed changes reconcile through the existing fading failure toast                  |
| Validation and calculated output                                   | Invalid drafts stay editable; validated values enter settings; `computed` columns stay read only and are excluded from row inputs                |

State-backed tables expose observations rather than editable rows. Layout is saved
in their separate `stateKey`; row edits, formulas and full-workbook paste remain
unavailable. Host commands and device-specific controls belong in module `actions`
and declarative page `controls`, with their own capability contracts. A table does
not grant permission to execute hardware actions.

Declare `workbook.columns[fieldId].fill` explicitly for every editable input
column. Use `copy` for shared settings and identifiers, and `series` for fields
whose values should progress. Exclude state-backed and computed columns from this
audit: they are read-only. Do not rely on a host module-name rule or infer series
from numeric type.

Keep editors attached to stable row and field IDs while feedback changes row
order. Test choosing an item with the popup still open during an update; a
selection-only check cannot detect writing to the wrong row. Apply this to color
editors as well. Invalid values must remain visible in the cell and source bar
through navigation until corrected, without entering saved settings or transfer.
Apply the same draft rule to page settings: an empty required numeric field must
not reset mid-edit or block an unrelated valid setting from saving.

For actions edited through Matrix, retain untouched formula sources when saving
other fields in the action/feedback editor. Explicitly editing a formula-backed
field may replace its formula. Merely opening and saving the editor must not.

## Formulas and calculations

Supported functions are the same bounded set as Button Matrix: `SUM`, `MIN`,
`MAX`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `ABS`, `MOD`, `IF`, `AND`, `OR`, plus normal
operators and cell/range references. Formulas run off the input thread through the
shared evaluator. No module JavaScript runs inside the grid.

Row data separates typed values and formula sources:

```ts
{ id: 'camera-a', values: { quantity: 4 }, formulas: { quantity: '=B3*2' } }
```

Modules consume the validated value in `row.values`; preserve `row.formulas` as
host metadata. The header is row 1, so the first data row is row 2. References
follow stable row/field identities when layout changes. Deleted or disjoint
references become `#REF!`; they must not silently point to another input. Invalid
results remain local drafts and do not replace valid module settings.

Use `computed: { source, columns, preview? }` for domain calculations such as
DataQ rates. Published results are displayed only when their input snapshot
matches the current rows and settings. A read-only `preview: { id, version }`
query requires `module-table-preview-v1`. `settingsUpdate: 'live'` requires
`module-live-settings-v1` and an observational module; implement `updateSettings`
so edits do not restart a worker. Keep preview queries separate from persistence.

## Portability, limits and qualification

`ModuleTableViewStateSchema` describes versioned presentation data: `columnOrder`,
`hiddenColumns`, `columnWidths`, `rowHeights`, `textSize`, `frozenColumns`, `sheets`
and `sheetByRowId`. Selection, scroll, zoom and open popovers are intentionally
session-only. Settings, formula sources and layout travel with workspace
export/import and restart; no private app-local layout store is needed.

Bounds: 32 columns, 512 total rows across sheets, 32 sheets, widths 48–800 pixels,
row heights 28–400 pixels, text size 9–24, and 4,096 characters per formula. Module
settings remain bounded by the host's JSON limit. A calculation accepts at most
10,000 formulas across its sheets. Increasing `maxRows` cannot
exceed these bounds.

Before handing off a module, use an authorized test target or an offline full-renderer
fixture and test an unresolved save plus a second edit and failure recovery; clipboard/fill; keyboard and choice
navigation; formula errors; sheet and column moves; undo/redo; and export/import
with non-default names, order, assignments and layout. Build, test, validate,
pack and inspect the example with the extracted kit, outside the private Hubble
checkout. Do not claim a source build updates an installed kit or running module.

## Page composition

A page may declare `navigation.replaces` (`tally-switch`, `ccc`, or `router`)
and `navigation.relatedCapabilities` (capability names). Require
`module-page-navigation-v1` for either declaration. A replacement is shown only
while its selected package provides the page; the saved sidebar layout remains
unchanged. Matching related pages keep their own workspace/module scope and appear
under expandable Related setup. Do not embed pages that themselves compose other
pages. Verify each nested table after opening, navigation, and feedback refresh.

Native-menu simulation checks dispatch only. Actual macOS menu behavior, package
contents, installed startup, and device observations need the later live handoff.

## Document-backed workbooks

With `module-table-live-v1` (candidate kit 1.7.0-dev.4, Hubble 2.0.15 plus
the advertised feature), document tables may declare
`live: { source: 'selection', columns: ['enabled'] }`. Publish that named state
value as `{ revision: document.revision, rows: [{ id, values: { enabled: true } }] }`.
The revision is the host document's opaque UUID, not a domain revision counter.
Only existing row IDs and declared editable columns participate. Unknown, invalid,
stale or replaced-generation observations cannot overwrite document cells.

This projects local module state while ordered persistence is pending. The shared
host grid remains editable; its own pending edits take precedence. A user can
reverse a projected value before the earlier save completes. Failed edits roll
back without losing unrelated feedback or later edits. A newer durable receipt
wins over an observation based on an older document. Live observations do not
create undo entries or enter an unrelated cell save, workspace export or full
workbook clipboard as saved data; those use the document and explicit user edits. Test those boundaries
with the first save held unresolved and a second edit before releasing it.

The host obtains scoped runtime observations and current durable documents without
reloading all module manifests on each refresh. Module page and Matrix controls
may write documents without holding the host's save gate while awaiting completion.
This is generic host support; selection rules and which columns follow live state
remain package-owned. A host upgrade is required before installing packages that
require this feature. It does not make durable saves instantaneous.

The candidate `module-documents-v1` capability adds `source: 'document'` plus a
`documentId` declared in the manifest. Rows and layout live in that document,
shared with the package frontend/backend. See [portable documents](documents.md)
for versioning, conflict behavior, limits and transfer rules. Keep `source: 'state'`
read-only and retain existing settings-backed descriptors for older hosts.

## Live table presentation

Hosts advertising `module-table-presentation-v1` support `computed.dependencies`
and `rowHighlight`. Declare this feature explicitly. Computed dependencies contain
`rowFields` and `settingsFields`; only changes to these inputs invalidate a result
for the same stable row ID. For camera observations use the target address/number,
not a selection checkbox or workbook view. Omit dependencies to retain full-draft
invalidation. Empty arrays explicitly declare independence from that input set.
Computed results still require matching original row IDs and never bind by position.

A table can declare `rowHighlight: { field: "program", values: ["ON AIR"],
color: "#602A2A" }`. The shared workbook applies the row background when the resolved
input or computed field matches; missing/stale computed values clear the highlight.
Selection preserves this feedback fill and active editors remain usable. These
rules belong in the module descriptor; the host has no device-specific colour rules.
