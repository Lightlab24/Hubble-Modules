# Patch Sheet

Patch Sheet is the reference for a custom module spreadsheet in the Hubble Developer Kit. It pairs a package-owned layout with a native Hubble workbook. Both views edit one portable workspace document.

In **Patch Sheet**, select a Number, Name, Address, or Note cell and type to replace the value. Double-click or press F2 to edit the existing value. Enter saves and Escape cancels. In Route, type to search the live catalog. Select a rectangle to copy, paste, or fill. The seeded rows include a locked Number and an unavailable Name. Type `10.0.0.999` into an Address to see a rejected draft stay visible with its error. Right-click the cell to edit or clear cells, or discard the draft.

The module declares an optional **Patch details** group with Name, Address, and Note. Its shared **+** control reveals the fields hidden in the compact view, and **−** collapses it. Right-click the group header and use **Collapsed fields** to choose which fields stay visible or drag them into a new order. Route and Number are ordinary columns. Copy, paste, fill and navigation follow the visible order. These layout choices save in the document’s custom view.

In **Patch Workbook**, edit the same rows with Hubble's built-in grid. Try `=8+4` in the Number column to see formulas and undo. The custom formula bar also edits Number formulas over the same rows. The native tab also supplies the Matrix row and column context menus, sheet management, layout controls, and workbook transfer.

Hold a column header, group header or row number for 300 ms, then drag it. The shared host control supplies the Matrix lift preview, neighbor animation and insertion marker. Fields move within their group; top-level columns and groups move together. Selected whole rows move as one batch and save to the document. Press Escape to cancel, or focus a header and use Option/Alt+Shift+arrow keys to move it. The custom and native views save separate column layouts.

Click **Columns** above the grid to show or hide fields with checkmarks. Drag
the grips or use the arrows to reorder fields and groups. Right-click a
column for **Hide column** and **Hidden columns**. Right-click a row number
for Insert row above/below, Add row at bottom, and Delete row. Command/Control+C
and V, plus the native Edit menu, are available for clipboard operations.

- `src/manifest.ts` declares both tabs, the host capabilities, and the portable document.
- `src/table.ts` defines the native workbook, typed columns, fill rules, and cell restrictions. The custom adapter reads those same rules.
- `src/frontend.ts` attaches the kit controls, declares the optional column group, adds direct editing, and submits immediate drafts to one ordered queue.
- `src/index.ts` uses the document service and the same validation for both views. Revision checks protect other edits, formulas, and layout. Its document watch retries with bounded backoff and shows only a failure that lasts.
- `src/workbook-state.ts` defines the portable custom view. The shared workbook session applies edits immediately, queues saves, and supports undo/redo.

The custom view requires `module-spreadsheet-controls-v1`,
`module-spreadsheet-column-groups-v1`, `module-spreadsheet-column-editor-v1`,
`module-spreadsheet-layout-v1`, `module-spreadsheet-extended-editing-v1`,
`module-spreadsheet-workbook-tools-v1`, and
`module-spreadsheet-toolbar-sections-v1`.
Check the installed host's features, not just its version. No extra sandbox
permissions are needed.

From the extracted kit, run:

```sh
node module-tool.mjs build examples/custom-spreadsheet
node module-tool.mjs test examples/custom-spreadsheet
node module-tool.mjs pack examples/custom-spreadsheet example-custom-spreadsheet.hubble-module
```

Import and select the package in a test workspace. Its manifest lists the required features. The example stores patch rows, formulas, and native workbook layout in the workspace document. It has no hardware actions.

Enabled uses the shared checkbox control. Use Space or click the check mark.
Fill leaves the extended range selected. Delete clears every editable selected
cell. Command-click or Ctrl-click adds separate cells for clipboard operations.
Drag column edges or row-number bottom edges to resize. Expansion adds columns
on the right without reducing existing widths. Both views save their sizes independently.

In Number or Name, type `=`, click another cell to insert its reference, and
press Enter to calculate. You can also type the reference directly. Copy or fill
the formula to see relative references update. References to Route or Area use
their visible choice labels. Area
filters Route and resets it when the area changes. Color uses the shared picker
and favorites. Right-click a row for bulk insertion and duplication. Use the
top-left menu to copy or paste a full workbook. Cut uses Command+X followed by
Paste. History covers cell, row and custom layout edits.

The standalone **Columns** button opens independently of the toolbar. Set `formula`, `history`, or
`layout` in `toolbarSections` in `src/frontend.ts` to mount the source bar,
Undo and Redo buttons, or freeze and text-size controls. Inline formula
editing and history shortcuts are available in the grid.

The example has one custom sheet. To opt in to multiple sheets, set
`multipleSheets` in `src/workbook-state.ts`. The module then mounts the optional
sheet bar and owns row assignments. The standalone Patch Workbook page is the
host's complete workbook surface.
