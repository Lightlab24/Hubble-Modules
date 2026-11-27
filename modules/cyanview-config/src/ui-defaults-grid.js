  // ── Defaults' two tables on Hubble's grid ───────────────────────────────────────────────────────
  // Devices (a name, LAN IP and mask pattern for each kind) and the camera models are grids like the
  // Devices sheet (Nov 27, 2026): a click selects, typing or F2 edits, Enter moves down, and Delete,
  // paste and the fill handles work on a selection. Hubble keeps undo for each table, and adding or
  // removing a camera model is a step too. The boxes outside the tables stay boxes, each with its own
  // text undo while typed in. On a Hubble without grid undo the tables work the same, without undo.
  const defaultsGrids = [];
  // A camera model row has no ID of its own, and its place changes as rows are removed.
  const cameraTypeIds = new Map();
  let nextCameraTypeId = 1, defaultsGridCommitting = false;
  const cameraTypeId = row => { if (!cameraTypeIds.has(row)) cameraTypeIds.set(row, 't' + nextCameraTypeId++); return cameraTypeIds.get(row); };
  const cameraTypeById = id => cameraTypes.find(row => cameraTypeId(row) === id);
  const defaultsGridSpecs = [
    {
      table: 'devices', columns: [{ id: 'name', label: 'Name' }, { id: 'lan', label: 'LAN IP' }, { id: 'mask', label: 'Mask' }],
      rows: () => deviceKinds.slice(), key: (rowId, columnId) => 'device:' + rowId + ':' + columnId,
      value: (rowId, columnId) => defaults.devices[rowId]?.[columnId],
    },
    {
      table: 'types', columns: [{ id: 'model', label: 'Camera model' }, { id: 'type', label: '%type%' }, { id: 'ip', label: 'Camera IP' }, { id: 'login', label: 'Username' }, { id: 'password', label: 'Password' }],
      rows: () => cameraTypes.map(cameraTypeId), key: (rowId, columnId) => { const index = cameraTypes.indexOf(cameraTypeById(rowId)); return index < 0 ? '' : 'type:' + index + ':' + columnId; },
      value: (rowId, columnId) => cameraTypeById(rowId)?.[columnId],
    },
  ];
  const defaultsBox = (spec, rowId, columnId) => { const key = spec.key(rowId, columnId); return key ? defaultsPanel?.querySelector('[data-defaults-field="' + CSS.escape(key) + '"]') : null; };
  // Each table sits in a host that outlives the panel's redraws, so the grid and its undo do too.
  function placeDefaultsGrids() {
    for (const grid of defaultsGrids) {
      const table = defaultsPanel?.querySelector('[data-defaults-table="' + grid.spec.table + '"]');
      const sheet = table?.closest('.hc-sheet');
      if (!sheet || sheet.parentElement === grid.host) continue;
      sheet.replaceWith(grid.host);
      grid.host.replaceChildren(sheet);
      const rowIds = grid.spec.rows();
      for (const tr of table.tBodies[0]?.rows ?? []) {
        const rowId = grid.spec.table === 'devices' ? tr.dataset.defaultsKind : rowIds[Number(tr.dataset.defaultsType)];
        if (!rowId || (grid.spec.table === 'types' && tr.dataset.defaultsType === undefined)) continue;
        const cells = [...tr.cells].filter(td => td.tagName === 'TD' && !td.classList.contains('hc-defaults-remove'));
        cells.forEach((td, column) => { const id = grid.spec.columns[column]?.id; if (id) { td.dataset.hubbleRow = rowId; td.dataset.hubbleColumn = id; } });
      }
    }
  }
  async function mountDefaultsGrid(spec) {
    const host = document.createElement('div');
    host.className = 'hc-defaults-grid';
    host.dataset.defaultsGrid = spec.table;
    const grid = { spec, host, controls: null };
    defaultsGrids.push(grid);
    placeDefaultsGrids();
    const options = {
      root: host, viewport: host, extendedEditing: true,
      getRows: () => spec.rows(),
      getColumns: () => spec.columns.map(column => ({ ...column, fill: column.id === 'model' || column.id === 'mask' ? 'copy' : 'series' })),
      getCell({ rowId, columnId }) {
        const value = spec.value(rowId, columnId), element = defaultsBox(spec, rowId, columnId);
        if (value === undefined || !element) return null;
        return { value: String(value ?? ''), readOnly: element.disabled };
      },
      onEdit(batch) {
        defaultsGridCommitting = true;
        try {
          for (const edit of batch.edits) {
            const element = defaultsBox(spec, edit.rowId, edit.columnId);
            if (!element || element.disabled) continue;
            element.value = edit.value;
            commitDefaultsField(element);
          }
        } finally { defaultsGridCommitting = false; }
        renderDefaults();
      },
      onError: error => toast(error.message),
    };
    try {
      grid.controls = await mountSpreadsheetControls({ ...options, history: true }).catch(error => {
        if (error instanceof Error && error.message.includes(MODULE_SPREADSHEET_HISTORY_FEATURE)) return mountSpreadsheetControls(options);
        throw error;
      });
    } catch (error) { toast(error.message); }
  }
  const defaultsGridOf = element => defaultsGrids.find(grid => grid.host.contains(element));
  const defaultsCellOf = element => { const td = element?.closest?.('td[data-hubble-row]'); return td ? { rowId: td.dataset.hubbleRow, columnId: td.dataset.hubbleColumn } : null; };

  // What is typed joins the table's undo when it goes in.
  const commitDefaultsFieldBeforeGrid = commitDefaultsField;
  commitDefaultsField = function(element) {
    const grid = !defaultsGridCommitting && element?.type !== 'checkbox' ? defaultsGridOf(element) : null, address = grid && defaultsCellOf(element);
    if (address) grid.controls?.history?.record([{ ...address, value: element.value }]);
    return commitDefaultsFieldBeforeGrid(element);
  };
  // Adding or removing a camera model is a step of the camera models table's undo.
  const typesGrid = () => defaultsGrids.find(grid => grid.spec.table === 'types')?.controls;
  function recordCameraTypeChange(row, index, added) {
    const putBack = () => { if (!cameraTypes.includes(row)) { cameraTypes.splice(Math.min(index, cameraTypes.length), 0, row); renderDefaults(); remember(); } };
    const takeAway = () => { const at = cameraTypes.indexOf(row); if (at >= 0) { cameraTypes.splice(at, 1); renderDefaults(); remember(); } };
    typesGrid()?.history?.recordChange(added ? { undo: takeAway, redo: putBack } : { undo: putBack, redo: takeAway });
  }
  // The panel's own click handler adds or removes the row, and redraws, so the button is gone by the
  // time the click reaches here. What it was for is noted on the way in; the step is kept once it ran.
  let cameraTypeClick = null;
  root.addEventListener('click', event => {
    const button = event.target.closest?.('#hc-defaults button[data-action]'), index = Number(button?.dataset.index);
    cameraTypeClick = !button || button.disabled ? null
      : button.dataset.action === 'add-camera-type' ? { added: true, rows: cameraTypes.slice() }
      : button.dataset.action === 'remove-camera-type' && cameraTypes[index] ? { added: false, row: cameraTypes[index], index } : null;
  }, { capture: true });
  root.addEventListener('click', () => {
    const click = cameraTypeClick;
    cameraTypeClick = null;
    if (!click) return;
    if (!click.added) { if (!cameraTypes.includes(click.row)) recordCameraTypeChange(click.row, click.index, false); return; }
    const row = cameraTypes.find(item => !click.rows.includes(item));
    if (row) recordCameraTypeChange(row, cameraTypes.indexOf(row), true);
  });

  // A box comes alive only to be typed in, as on the Devices sheet.
  const defaultsEditing = element => element?.matches?.('.hc-defaults-grid input[data-defaults-field].hc-cell-editing') ? element : null;
  function startDefaultsEdit(grid, td, replacement) {
    const box = td?.querySelector('input[data-defaults-field]');
    if (!box || box.disabled) return false;
    box.classList.add('hc-cell-editing');
    box.focus({ preventScroll: true });
    if (replacement === undefined) box.select();
    else { box.value = replacement; box.setSelectionRange(replacement.length, replacement.length); }
    return true;
  }
  function finishDefaultsEdit(grid, box, { cancel = false, columns = 0, rows = 0 } = {}) {
    if (cancel) { const address = defaultsCellOf(box); box.value = String(address ? grid.spec.value(address.rowId, address.columnId) ?? '' : box.defaultValue); }
    box.classList.remove('hc-cell-editing');
    // Leaving the box commits what was typed (its change event), then the table has the keyboard again.
    grid.host.focus({ preventScroll: true });
    if (columns || rows) grid.controls?.move?.(columns, rows);
  }
  root.addEventListener('keydown', event => {
    const grid = defaultsGridOf(event.target);
    if (!grid?.controls || event.isComposing) return;
    const box = defaultsEditing(event.target);
    if (box) {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      finishDefaultsEdit(grid, box, { cancel: event.key === 'Escape', columns: event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0, rows: event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0 });
      return;
    }
    if (event.target !== grid.host || event.metaKey || event.ctrlKey || event.altKey) return;
    const td = grid.host.querySelector('td[data-hubble-spreadsheet-active="true"]');
    if (!td) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); grid.controls.move?.(0, event.shiftKey ? -1 : 1); return; }
    const replacement = event.key.length === 1 ? event.key : undefined;
    if ((replacement !== undefined || event.key === 'F2') && startDefaultsEdit(grid, td, replacement)) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true });
  root.addEventListener('dblclick', event => {
    const td = event.target.closest?.('.hc-defaults-grid td[data-hubble-row]'), grid = td && defaultsGridOf(td);
    if (grid?.controls && !defaultsEditing(document.activeElement)) startDefaultsEdit(grid, td);
  });
  root.addEventListener('focusin', event => {
    const box = event.target, grid = defaultsGridOf(box);
    if (!grid?.controls || !box.matches?.('input[data-defaults-field]')) return;
    box.classList.add('hc-cell-editing');
    const address = defaultsCellOf(box);
    if (address) grid.controls.select(address, undefined, { focus: false });
  });
  root.addEventListener('focusout', event => { defaultsEditing(event.target)?.classList.remove('hc-cell-editing'); });

  // A redraw draws new tables: they go back into their hosts, the box in use keeps the keyboard, and
  // each grid paints its selection onto the new cells.
  const renderDefaultsBeforeGrid = renderDefaults;
  renderDefaults = function(...args) {
    const focused = document.activeElement, hostFocused = defaultsGrids.find(grid => grid.host === focused);
    const key = focused?.dataset?.defaultsField, caret = key && focused.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd, focused.value, focused.classList.contains('hc-cell-editing')] : null;
    const result = renderDefaultsBeforeGrid(...args);
    placeDefaultsGrids();
    if (hostFocused) hostFocused.host.focus({ preventScroll: true });
    else if (caret && document.activeElement !== focused) {
      const box = defaultsPanel?.querySelector('[data-defaults-field="' + CSS.escape(key) + '"]');
      if (box && box !== document.activeElement) {
        if (caret[3]) box.classList.add('hc-cell-editing');
        box.focus({ preventScroll: true });
        try { box.setSelectionRange(caret[0], caret[1]); } catch { /* Not a text box. */ }
      }
    }
    for (const grid of defaultsGrids) grid.controls?.refresh();
    return result;
  };
  const initializeDefaultsTabBeforeGrid = initializeDefaultsTab;
  initializeDefaultsTab = function(...args) {
    const result = initializeDefaultsTabBeforeGrid(...args);
    if (defaultsPanel && !defaultsGrids.length) for (const spec of defaultsGridSpecs) void mountDefaultsGrid(spec).then(() => { placeDefaultsGrids(); for (const grid of defaultsGrids) grid.controls?.refresh(); });
    return result;
  };
