  // ── Devices on Hubble's grid ─────────────────────────────────────────────────────────────────
  // The Devices sheet is a grid like the camera sheets (asked for Nov 27, 2026): click, drag or
  // Shift+arrows select, typing, F2 or a double-click edits a cell's box, Enter moves down as in the
  // Button Matrix, and Delete, paste and the fill handles work on a selection. Hubble keeps undo and
  // redo for it (module-spreadsheet-history-v1): Command+Z and Shift+Command+Z step back and forward
  // through cell edits and removed devices. An address change still waits in Pending sends, or goes
  // at once in Auto send, whether it was typed or undone. On a Hubble without grid undo the sheet
  // works the same, without undo.
  let deviceGrid = null, deviceGridReady = null, replayingDeviceStep = false;
  // Grid edits for a device that is mid-send are held, as typed ones are. Hubble's undo already holds
  // them, so they are not recorded again when they go in.
  const gridHeldDeviceEdits = new Set();
  const deviceGridHost = () => $('device-sheet');
  const deviceGridColumns = () => deviceSheetColumns().filter(column => column.id !== 'remove')
    .map(column => ({ id: column.id, label: column.label || column.id, fill: column.id === 'name' || column.id === 'row' || lanIndex(column.id) >= 0 || column.id === 'wanIp' ? 'series' : 'copy' }));
  const deviceGridRows = () => [...(deviceGridHost()?.querySelectorAll('tr[data-device-row]') ?? [])].map(row => row.dataset.deviceRow);
  function deviceGridElement({ rowId, columnId }) {
    return deviceGridHost()?.querySelector('td[data-hubble-row="' + CSS.escape(rowId) + '"][data-hubble-column="' + CSS.escape(columnId) + '"]') ?? null;
  }
  // What a cell holds, from the cell as last drawn: text still being typed isn't in it yet, and an
  // edit held back for a send is.
  function deviceGridCell(address) {
    const td = deviceGridElement(address);
    if (!td || !device(address.rowId)) return null;
    const box = td.querySelector('[data-device-cell]');
    // WAN Mode keeps Cyanview's own list, which F2 or a click opens; paste and fill still set it.
    if (box?.tagName === 'SELECT') {
      const drawn = [...box.options].find(option => option.defaultSelected) ?? box.options[box.selectedIndex];
      return { value: drawn?.value ?? box.value, readOnly: box.disabled };
    }
    if (box) return { value: box.defaultValue, readOnly: box.disabled };
    // A blank entry holds no address.
    return { value: lanIndex(address.columnId) >= 0 ? '' : td.innerText.trim(), readOnly: true };
  }
  function commitDeviceGridEdits(batch) {
    for (const edit of batch.edits) {
      const key = edit.rowId + ':' + edit.columnId;
      commitDeviceCell(edit.rowId, edit.columnId, edit.value);
      if (heldDeviceEdits.has(key)) gridHeldDeviceEdits.add(key);
    }
  }
  async function mountDeviceGrid() {
    const host = deviceGridHost();
    if (!host || deviceGrid) return;
    const options = {
      root: host, viewport: host, extendedEditing: true,
      getRows: deviceGridRows, getColumns: deviceGridColumns, getCell: deviceGridCell,
      onEdit: commitDeviceGridEdits,
      onSelection(address) { if (address && address.rowId !== selectedDeviceId) { selectedDeviceId = address.rowId; paintDeviceSheet(); } },
      onError: error => toast(error.message),
    };
    try {
      deviceGrid = await mountSpreadsheetControls({ ...options, history: true }).catch(error => {
        if (error instanceof Error && error.message.includes(MODULE_SPREADSHEET_HISTORY_FEATURE)) return mountSpreadsheetControls(options);
        throw error;
      });
    } catch (error) { toast(error.message); return; }
    deviceGrid.refresh();
  }

  // A box comes alive only to be typed in. Until then the cell around it is what a click selects.
  const editingBox = element => element?.matches?.('[data-role="device-sheet"] input[data-device-cell].hc-cell-editing') ? element : null;
  function startDeviceEdit(td, replacement) {
    const list = td?.querySelector('select[data-device-cell]:enabled + .hc-dropdown');
    // The list's keys go to its button, so the keyboard moves there first, as a click would move it.
    if (list) { if (replacement !== undefined) return false; list.focus({ preventScroll: true }); list.click(); return true; }
    const box = td?.querySelector('input[data-device-cell]');
    if (!box || box.disabled) return false;
    box.classList.add('hc-cell-editing');
    box.focus({ preventScroll: true });
    if (replacement === undefined) box.select();
    else {
      box.value = replacement;
      typedDeviceCell = box.dataset.deviceCell;
      box.setSelectionRange(replacement.length, replacement.length);
    }
    return true;
  }
  // Leaving the box commits what was typed (the sheet's own focusout), then the grid has the keyboard again.
  function finishDeviceEdit(box, { cancel = false, columns = 0, rows = 0 } = {}) {
    if (cancel) { if (typedDeviceCell === box.dataset.deviceCell) typedDeviceCell = ''; box.value = box.defaultValue; }
    box.classList.remove('hc-cell-editing');
    deviceGridHost()?.focus({ preventScroll: true });
    if (columns || rows) deviceGrid?.move?.(columns, rows);
  }
  root.addEventListener('keydown', event => {
    const host = deviceGridHost();
    if (!deviceGrid || !host || event.isComposing || !host.contains(event.target)) return;
    const box = editingBox(event.target);
    if (box) {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      finishDeviceEdit(box, { cancel: event.key === 'Escape', columns: event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0, rows: event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0 });
      return;
    }
    if (event.target !== host || event.metaKey || event.ctrlKey || event.altKey) return;
    const td = host.querySelector('td[data-hubble-spreadsheet-active="true"]');
    if (!td) return;
    // Enter moves down, as in the Button Matrix. Typing or F2 edits; a list cell opens its list (Hubble's).
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); deviceGrid.move?.(0, event.shiftKey ? -1 : 1); return; }
    const replacement = event.key.length === 1 ? event.key : undefined;
    if ((replacement !== undefined || event.key === 'F2') && startDeviceEdit(td, replacement)) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true });
  root.addEventListener('dblclick', event => {
    const td = event.target.closest?.('[data-role="device-sheet"] td[data-hubble-row]');
    if (deviceGrid && td && !editingBox(document.activeElement)) startDeviceEdit(td);
  });
  // A box reached some other way (Tab from the page, a check) is in use as if typed into.
  root.addEventListener('focusin', event => {
    const box = event.target;
    if (!deviceGrid || !box.matches?.('[data-role="device-sheet"] input[data-device-cell]')) return;
    box.classList.add('hc-cell-editing');
    const td = box.closest('td[data-hubble-row]');
    if (td) deviceGrid.select({ rowId: td.dataset.hubbleRow, columnId: td.dataset.hubbleColumn }, undefined, { focus: false });
  });
  root.addEventListener('focusout', event => { editingBox(event.target)?.classList.remove('hc-cell-editing'); });

  // What is typed joins the grid's undo when it goes in, so Undo puts back what the cell held.
  const runDeviceCommitBeforeGrid = runDeviceCommit;
  runDeviceCommit = function(key, value) {
    const id = key.slice(0, key.lastIndexOf(':')), field = key.slice(key.lastIndexOf(':') + 1);
    if (!gridHeldDeviceEdits.delete(key) && !deviceBusy(id)) deviceGrid?.history?.record([{ rowId: id, columnId: field, value: String(value) }]);
    return runDeviceCommitBeforeGrid(key, value);
  };
  // Removing a device only takes it off this list, so Undo can put it back, as Undo removal does.
  function restoreRemovedDevice(id) {
    const index = removedDevices.map(entry => entry.device.id).lastIndexOf(id);
    if (index < 0 || device(id)) return;
    removedDevices.push(...removedDevices.splice(index, 1));
    undoDeviceRemoval();
  }
  const removeManagedDeviceBeforeGrid = removeManagedDevice;
  removeManagedDevice = function(id) {
    const listed = !!device(id);
    const result = removeManagedDeviceBeforeGrid(id);
    if (listed && !device(id) && !replayingDeviceStep) {
      const replay = run => () => { replayingDeviceStep = true; try { run(); } finally { replayingDeviceStep = false; } };
      deviceGrid?.history?.recordChange({ undo: replay(() => restoreRemovedDevice(id)), redo: replay(() => removeManagedDevice(id)) });
    }
    return result;
  };
  // A redraw draws new cells: the grid paints the selection onto them.
  const renderDeviceSheetBeforeGrid = renderDeviceSheet;
  renderDeviceSheet = function(...args) { const drawn = renderDeviceSheetBeforeGrid(...args); deviceGrid?.refresh(); return drawn; };
  const initializeDeviceWorkflowBeforeGrid = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function(...args) { const result = initializeDeviceWorkflowBeforeGrid(...args); deviceGridReady = mountDeviceGrid(); return result; };
