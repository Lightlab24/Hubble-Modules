  const cameraSheets = new Map();
  const cameraAddresses = new Map();
  let spreadsheetUnavailable = false;
  const cameraAddress = cell => ({ rowId: cell.dataset.hubbleRow, columnId: cell.dataset.hubbleColumn });
  const cameraCellSelector = '[data-hubble-row][data-hubble-column]';
  const activeCameraCell = cameraCellSelector + '[data-hubble-spreadsheet-active="true"]';
  const cameraCellKey = ({ rowId, columnId }) => JSON.stringify([rowId, columnId]);
  const seriesFields = ['number', 'name', 'ip'];

  function activeCamera(table) {
    const cell = table?.querySelector(activeCameraCell);
    return cell && sheetCameras(table.dataset.cameraDevice).find(camera => camera.id === cell.dataset.camera);
  }

  function selectedCameras(table) {
    const ids = new Set([...(table?.querySelectorAll('[data-hubble-spreadsheet-selected]') ?? [])].map(cell => cell.dataset.camera));
    return table ? sheetCameras(table.dataset.cameraDevice).filter(camera => ids.has(camera.id) && !camera.jobs && !camera.deleting) : [];
  }

  function syncCameraDeleteButton(group) {
    const clear = group.querySelector('[data-action="clear-selected"]');
    if (clear) {
      const count = selectedCameras(group.querySelector('table[data-camera-device]')).length, text = count > 1 ? 'Clear ' + count + ' from view' : 'Clear from view', label = clear.querySelector('[data-camera-clear-label]');
      if (label.textContent !== text) label.textContent = text;
      clear.disabled = !count;
    }
    const button = group.querySelector('[data-action="delete-controller"]');
    const camera = activeCamera(group.querySelector('table[data-camera-device]'));
    const label = button.querySelector('[data-camera-delete-label]');
    const text = !camera?.number ? 'Delete camera' : (removalStaged(camera) ? 'Keep camera ' : 'Delete camera ') + camera.number;
    if (label.textContent !== text) label.textContent = text;
    button.disabled = !camera || !!camera.deleting;
    button.title = camera ? camera.name : 'Select a camera cell to delete';
  }

  function reviewCameraDeletion(camera) {
    if (!camera || camera.deleting) return;
    if (importedCamera(camera) && !camera.remi) {
      toast('Refresh the REMI assignment before removing this camera');
      return;
    }
    showReview([camera], 'camera', true);
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }

  function deleteReviewedCamera(camera) {
    if (!camera || camera.deleting) return;
    if (!importedCamera(camera)) {
      void sendItems([camera], 'camera', true);
    } else if (camera.remi) {
      remiStage(camera.device, [{
        id: 'remove:' + camera.elementKey, kind: 'remove', key: camera.elementKey, enable: false,
        selector: camera.remi.selector, connection: camera.remi.connection, label: camera.name,
      }]);
    }
  }

  function cameraField(camera, column) {
    if (column === 'ip') return camera.model === 'Alpha-USB' ? 'usb' : 'ip';
    if (column === 'connection') return lensCapabilities(camera).ip ? 'lensIp' : 'lensPort';
    return column;
  }

  function cameraSheetFocus() {
    const element = document.activeElement;
    // Tabs and view buttons survive a redraw, but moving them drops their focus.
    if (element?.closest('[data-camera-selection]')) return { chrome: element };
    const table = element?.closest('table[data-camera-device]');
    if (!table) return null;
    const cell = element.closest(cameraCellSelector);
    const editor = element.matches('input[data-field].hc-cell-editing');
    if (editor) element.classList.remove('hc-cell-editing');
    return {
      deviceId: table.dataset.cameraDevice,
      address: cell ? cameraAddress(cell) : cameraAddresses.get(table.dataset.cameraDevice),
      editor: editor ? { value: element.value, start: element.selectionStart, end: element.selectionEnd } : null,
    };
  }

  function refreshCameraSheets(focus) {
    const tables = new Map([...root.querySelectorAll('table[data-camera-device]')].map(table => [table.dataset.cameraDevice, table]));
    for (const [table, sheet] of cameraSheets) {
      if (table.isConnected) { sheet.refresh?.(); continue; }
      const replacement = tables.get(table.dataset.cameraDevice);
      if (replacement && sheet.refresh) {
        // Keep the mounted grid and viewport so the host retains the range.
        const viewport = replacement.closest('.hc-scroll');
        const scrollLeft = viewport.scrollLeft;
        // The view controls live in the sheet's toolbar, which a redraw may or may not have replaced.
        const strip = replacement.closest('.hc-controller').querySelector('[data-camera-selection]');
        if (strip && strip !== sheet.strip) strip.replaceWith(sheet.strip);
        table.setAttribute('aria-label', replacement.getAttribute('aria-label'));
        table.replaceChildren(...replacement.childNodes);
        viewport.replaceWith(sheet.viewport);
        sheet.refresh(true);
        sheet.viewport.scrollLeft = scrollLeft;
        sheet.restoreFocus(focus);
        tables.set(table.dataset.cameraDevice, table);
        continue;
      }
      sheet.listeners.abort();
      sheet.menu?.dispose();
      sheet.layout?.dispose();
      sheet.presentation?.forEach(control => control.dispose());
      sheet.controls?.dispose();
      cameraSheets.delete(table);
    }
    for (const id of cameraAddresses.keys()) if (!sheetOwner(id)) cameraAddresses.delete(id);
    if (focus?.chrome?.isConnected) focus.chrome.focus({ preventScroll: true });
    if (spreadsheetUnavailable) return;
    for (const table of tables.values()) {
      if (!cameraSheets.has(table)) void mountCameraSheet(table, focus);
    }
  }

  async function mountCameraSheet(table, focus) {
    const deviceId = table.dataset.cameraDevice;
    let rows, columns, cells, cameraById;
    const providers = new Map();
    const listeners = new AbortController();
    const sheet = { listeners, controls: null, viewport: table.closest('.hc-scroll'), strip: table.closest('.hc-controller').querySelector('[data-camera-selection]'), presentation: [], scale: 1 };
    cameraSheets.set(table, sheet);

    function indexSheet() {
      const flipped = cameraSheetView(deviceId) === 'columns';
      const visibleRows = [...table.tBodies[0].rows].filter(row => flipped ? row.dataset.setting : row.dataset.id);
      const visibleColumns = [...table.querySelectorAll('col[data-hubble-column]')];
      rows = visibleRows.map(row => flipped ? row.dataset.setting : row.dataset.id);
      columns = visibleColumns.filter(col => col.dataset.hubbleColumn !== 'row').map(col => ({
        id: col.dataset.hubbleColumn,
        label: col.dataset.label,
        fill: seriesFields.includes(col.dataset.hubbleColumn) ? 'series' : 'copy',
      }));
      table.style.width = [...table.querySelectorAll('col')].reduce((width, col) => width + Number.parseInt(col.style.width, 10), 0) + 'px';
      const heights = flipped ? cameraLayouts.get(deviceId)?.settingHeights : cameraLayouts.get(deviceId)?.rows;
      for (const row of visibleRows) {
        const height = heights?.[flipped ? row.dataset.setting : row.dataset.id];
        if (height) row.style.setProperty('--hc-camera-row-height', height + 'px');
      }
      cells = new Map([...table.querySelectorAll(cameraCellSelector)].map(cell => [cameraCellKey(cameraAddress(cell)), cell]));
      cameraById = new Map(sheetCameras(deviceId).map(camera => [camera.id, camera]));
      for (const cell of cells.values()) {
        const input = cell.querySelector('input[data-field]');
        if (input) input.tabIndex = -1;
        if (!cell.querySelector('[data-field]:enabled,[data-hubble-boolean]')) cell.setAttribute('aria-readonly', 'true');
      }
      providers.clear();
    }
    indexSheet();

    function showSelection(address) {
      const strip = table.closest('.hc-controller').querySelector('[data-camera-selection]');
      paintCameraSelectionSummary(strip, address && cells.get(cameraCellKey(address)));
      syncCameraDeleteButton(table.closest('[data-controller]'));
    }

    // Across cameras the host fills per column, but here it's the setting that decides.
    function selectedFill() {
      const selected = [...table.querySelectorAll('[data-hubble-spreadsheet-selected]')];
      return selected.length && selected.every(cell => seriesFields.includes(cell.dataset.column)) ? 'series' : 'copy';
    }
    // The host names a dropdown after its column, but across cameras that should be the setting.
    function flippedColumns() {
      const fill = selectedFill(), open = sheet.selected && cameraSortLabels[sheet.selected.field];
      return columns.map(column => ({ ...column, fill, label: open && column.id === sheet.selected.camera ? open : column.label }));
    }
    function logicalEdits(edits) {
      return cameraSheetView(deviceId) === 'columns' ? edits.map(({ rowId, columnId, ...edit }) => ({ ...edit, rowId: columnId, columnId: rowId })) : edits;
    }
    // Keep the same camera and setting selected when the sheet flips or changes tab.
    function followSelection() {
      if (!sheet.selected) return;
      const cell = table.querySelector('td[data-camera="' + CSS.escape(sheet.selected.camera) + '"][data-column="' + sheet.selected.field + '"]');
      const address = cell && cameraAddress(cell), current = cameraAddresses.get(deviceId);
      if (address && (!current || cameraCellKey(address) !== cameraCellKey(current))) sheet.controls.select(address, address, { focus: false });
    }

    // A camera waiting to be deleted can't be edited until that is cancelled.
    function getCell(address) {
      const shown = cellFor(address), camera = shown && cameraById.get(cells.get(cameraCellKey(address))?.dataset.camera);
      return shown && camera?.removeStaged ? { ...shown, readOnly: true, choices: undefined } : shown;
    }
    function cellFor(address) {
      const key = cameraCellKey(address);
      const cell = cells.get(key);
      const camera = cell && cameraById.get(cell.dataset.camera);
      if (!cell || !camera || cell.classList.contains('hc-axis-inactive')) return null;
      if (isAssignmentField(cell.dataset.column)) return assignmentSheetCell(camera, cell.dataset.column, deviceId);
      const axis = lensAxisForUseColumn(cell.dataset.column);
      if (axis) return { kind: 'boolean', value: lensAxisEnabled(camera, axis) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting };
      const control = cell.querySelector('[data-field]');
      if (!control) {
        return ['control', 'cameraEnabled', 'recording', 'cameraStatus', 'sync'].includes(cell.dataset.column)
          ? { value: cell.textContent.trim(), readOnly: true }
          : null;
      }
      if (control.disabled) return null;
      const field = control.dataset.field;
      if (field === 'controlEnabled') return { kind: 'boolean', value: cameraControlEnabled(camera) ? 'TRUE' : 'FALSE', readOnly: !!camera.deleting || !cameraControlDevice(device(camera.device)) };
      const value = irisSwapCell(camera, field) ? irisSwapValue(camera) : String(camera[field] ?? (field === 'usb' ? 'USB · Automatic' : ''));
      if (camera.deleting || importedCamera(camera)) return { value, readOnly: true };
      if (!control.hasAttribute('data-camera-choice')) return { value };
      const context = choiceContext(camera, field);
      if (!context || !moduleBridge || moduleBridge.preview || !camera.elementKey) {
        return { value, choices: cameraCellChoices(camera, field) };
      }
      let provider = providers.get(key);
      if (provider?.context !== context) {
        provider = { context, choices: cameraChoiceProvider(camera, field, context) };
        providers.set(key, provider);
      }
      return { value, choices: provider.choices };
    }

    try {
      sheet.controls = await mountSpreadsheetControls({
        root: table,
        viewport: sheet.viewport,
        extendedEditing: true,
        getRows: () => rows,
        getColumns: () => cameraSheetView(deviceId) === 'columns' ? flippedColumns() : columns,
        getCell,
        onHistory(direction) { cameraHistoryStep(deviceId, direction); },
        onSelection(address) {
          const cell = address && cells.get(cameraCellKey(address));
          if (address) cameraAddresses.set(deviceId, address);
          else cameraAddresses.delete(deviceId);
          if (cell) sheet.selected = { camera: cell.dataset.camera, field: cell.dataset.column };
          else if (!address) sheet.selected = null;
          if (cameraSheetView(deviceId) === 'columns') sheet.controls?.refresh();
          showSelection(address);
        },
        onEdit({ edits }) { applyCameraGridEdits(logicalEdits(edits), cameraById); },
        onError(error) { toast(error.message); },
      });
    } catch (error) {
      if (table.isConnected && !spreadsheetUnavailable) {
        spreadsheetUnavailable = true;
        toast(error.message);
      }
      return;
    }
    const controls = sheet.controls;
    if (!table.isConnected || listeners.signal.aborted) { controls.dispose(); return; }
    const activeCellObserver = new MutationObserver(() => {
      const group = table.closest('[data-controller]');
      if (group) syncCameraDeleteButton(group);
    });
    // The shared fill handle can move the active cell without a selection callback.
    activeCellObserver.observe(table, { subtree: true, attributeFilter: ['data-hubble-spreadsheet-active'] });
    listeners.signal.addEventListener('abort', () => activeCellObserver.disconnect(), { once: true });
    sheet.refresh = (reindex = false) => {
      if (reindex) indexSheet();
      table.style.setProperty('--hc-camera-text-size', (cameraLayout(deviceId).textSize ?? 13) + 'px');
      paintCameraView(sheet.strip, deviceId);
      controls.refresh();
      if (reindex) followSelection();
      for (const control of sheet.presentation) control.refresh?.();
      if (table.closest('.hc-panel[hidden], [id^="hc-controller-"][hidden]')) {
        sheet.layout?.dispose();
        sheet.layout = null;
      } else if (sheet.layout) sheet.layout.refresh();
      else sheet.layout = mountCameraLayoutControls(table, sheet.viewport, sheet);
      showSelection(cameraAddresses.get(deviceId));
    };
    sheet.refresh();
    const presentation = await Promise.all([
      mountSpreadsheetColumnEditor({ root: sheet.strip.querySelector('[data-camera-columns]'), getItems: () => cameraColumnItems(deviceId), onVisibilityChange: (id, visible) => changeCameraVisibility(deviceId, [{ id, visible }]), onVisibilityChanges: changes => changeCameraVisibility(deviceId, changes) }),
      mountSpreadsheetViewport({ root: table, viewport: sheet.viewport, getFrozen: () => [...table.querySelectorAll('.hc-camera-frozen')].map(element => ({ element, left: Number.parseFloat(element.style.left) || 0 })), onZoom(ratio) { sheet.scale = ratio; sheet.strip.querySelector('[data-camera-zoom]').textContent = Math.round(ratio * 100) + '%'; controls.refresh(); sheet.layout?.refresh(); } }),
    ]);
    if (listeners.signal.aborted) { presentation.forEach(control => control.dispose()); return; }
    sheet.presentation = presentation;

    let menuReady;
    function openCameraMenu(camera, cell, x, y) {
      if (!camera) return;
      if (cell) {
        const address = cameraAddress(cell);
        controls.select(address, address, { focus: false });
      }
      menuReady ??= createSpreadsheetContextMenu({ root: table, onError: error => toast(error.message) })
        .then(menu => {
          if (listeners.signal.aborted) { menu.dispose(); return; }
          sheet.menu = menu;
          return menu;
        }).catch(error => {
          if (!listeners.signal.aborted) toast(error.message);
          menuReady = null;
        });
      void menuReady.then(menu => {
        if (!menu || !table.isConnected || table.closest('[hidden]')) return;
        menu.open({
          x, y, label: 'Camera ' + camera.number + ' · ' + camera.name,
          items: cameraMenuItems(camera, cameraById),
        });
      });
    }

    const options = { signal: listeners.signal };
    function editText(cell, replacement) {
      const input = cell?.querySelector('input[data-field]:enabled');
      if (!input || input.type === 'checkbox') return false;
      const address = cameraAddress(cell);
      const field = getCell(address);
      if (!field || field.readOnly) return false;
      controls.select(address, address, { focus: false });
      input.focus({ preventScroll: true });
      if (replacement === undefined) input.select();
      else {
        input.value = replacement;
        input.setSelectionRange(replacement.length, replacement.length);
      }
      return true;
    }
    function finishText(input, cancel) {
      input.classList.remove('hc-cell-editing');
      const address = cameraAddress(input.closest(cameraCellSelector));
      const value = getCell(address)?.value ?? '';
      if (cancel) input.value = value;
      else if (input.value !== value) applyCameraGridEdits(logicalEdits([{ ...address, value: input.value }]), cameraById);
    }

    table.addEventListener('dblclick', event => {
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(cameraCellSelector);
      if (cell && table.contains(cell)) editText(cell);
    }, options);
    table.addEventListener('contextmenu', event => {
      const cell = event.target.closest(cameraCellSelector) ?? event.target.closest('tbody tr[data-id]')?.querySelector(cameraCellSelector);
      const camera = cameraById.get(cell?.dataset.camera ?? event.target.closest('th[data-camera-header]')?.dataset.cameraHeader);
      if (!camera) return;
      event.preventDefault();
      openCameraMenu(camera, cell, event.clientX, event.clientY);
    }, options);
    table.addEventListener('focusin', event => {
      const input = event.target;
      if (!input.matches('input[data-field]:enabled') || input.type === 'checkbox') return;
      input.classList.add('hc-cell-editing');
      const address = cameraAddress(input.closest(cameraCellSelector));
      controls.select(address, address, { focus: false });
    }, options);
    table.addEventListener('focusout', event => {
      if (event.target.matches('input.hc-cell-editing')) finishText(event.target, false);
    }, options);
    table.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target.matches('input.hc-cell-editing')) {
        if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const input = event.target;
        input.classList.remove('hc-cell-editing');
        table.focus({ preventScroll: true });
        if (event.key === 'Tab') controls.move?.(event.shiftKey ? -1 : 1, 0);
        finishText(input, event.key === 'Escape');
        return;
      }
      if (event.target !== table || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        const cell = table.querySelector(activeCameraCell);
        if (!cell) return;
        const { left, bottom } = cell.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        openCameraMenu(cameraById.get(cell.dataset.camera), cell, left, bottom);
        return;
      }
      const address = cameraAddresses.get(deviceId);
      if (!address) return;
      const selected = getCell(address);
      if (selected?.kind === 'boolean' && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (!selected.readOnly) applyCameraGridEdits(logicalEdits([{ ...address, value: selected.value === 'TRUE' ? 'FALSE' : 'TRUE' }]), cameraById);
        return;
      }
      const replacement = event.key.length === 1 ? event.key : undefined;
      if ((replacement !== undefined || ['Enter', 'F2'].includes(event.key)) && editText(cells.get(cameraCellKey(address)), replacement)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, options);
    sheet.restoreFocus = focus => {
      if (focus?.deviceId !== deviceId || document.activeElement !== document.body || table.closest('[hidden]')) return;
      table.focus({ preventScroll: true });
      if (focus.editor && focus.address) {
        const input = cells.get(cameraCellKey(focus.address))?.querySelector('input[data-field]:enabled');
        if (input) {
          input.value = focus.editor.value;
          input.focus({ preventScroll: true });
          input.setSelectionRange(focus.editor.start, focus.editor.end);
        }
      }
    };
    const selected = cameraAddresses.get(deviceId);
    if (selected && cells.has(cameraCellKey(selected))) controls.select(selected, selected, { focus: false });
    sheet.restoreFocus(focus);
  }

  // What pressing Delete leaves behind in a choice cell that always holds something.
  const clearedCameraChoices = { model: 'Choose model…', usb: 'USB · Automatic', lens: 'None', lensPort: 'None' };

  function applyCameraGridEdits(edits, cameraById) {
    const controlEdits=edits.filter(edit=>edit.columnId==='controlEnabled');
    if(controlEdits.length)editCameraControl(controlEdits);
    const routeEdits=edits.filter(edit=>isAssignmentField(edit.columnId));
    if(routeEdits.length)editCameraRoutes(routeEdits,cameraById);
    edits=edits.filter(edit=>edit.columnId!=='controlEnabled'&&!isAssignmentField(edit.columnId));
    const historyRows = [...new Set(edits.map(edit => cameraById.get(edit.rowId)).filter(Boolean))];
    const historyBefore = cameraDraftSnapshot(historyRows);
    const changed = new Map();
    // Model and lens change what the other columns mean. A Use box going on has to land before its
    // settings, and one going off after them, so a Delete across both still empties the settings.
    const order = ({ columnId, value }) => ({ model: 0, lens: 1 })[columnId] ??
      (!lensAxisForUseColumn(columnId) ? 3 : value.trim().toUpperCase() === 'TRUE' ? 2 : 4);
    let invalid = 0;
    let redraw = false;
    for (const { rowId, columnId, value } of [...edits].sort((a, b) => order(a) - order(b))) {
      const camera = cameraById.get(rowId);
      if (!camera || camera.deleting || importedCamera(camera)) continue;
      const axis = lensAxisForUseColumn(columnId);
      if (axis) {
        if (!lensAxisAvailable(camera)) continue;
        const text = value.trim().toUpperCase();
        if (!['', 'TRUE', 'FALSE'].includes(text)) { invalid++; continue; }
        const staged = setLensAxis(camera, axis, text === 'TRUE');
        if (!staged) continue;
        const fields = changed.get(camera) ?? new Set();
        for (const edited of staged) fields.add(edited);
        changed.set(camera, fields);
        redraw = true;
        continue;
      }
      const field = cameraField(camera, columnId);
      if (irisSwapCell(camera, field)) {
        // Picking the other direction swaps Open and Closed, which is all a Tilta has for it.
        const text = value.trim().toLocaleLowerCase(), current = irisSwapValue(camera);
        const wanted = irisSwapChoices.find(option => option.value === text || option.label.toLocaleLowerCase() === text)?.value;
        // Left and Right belong to another lens, so a row pasted from one leaves this cell alone.
        if (text && !wanted && !['left', 'right'].includes(text)) invalid++;
        if (!wanted || !current || wanted === current) continue;
        const fields = changed.get(camera) ?? new Set(), open = camera.irisMin, closed = camera.irisMax;
        for (const edited of [...stageCell(camera, 'irisMin', closed, false), ...stageCell(camera, 'irisMax', open, false)]) fields.add(edited);
        changed.set(camera, fields);
        continue;
      }
      if (isLensSetting(field) && !lensFieldUsed(camera, field)) continue;
      if (camera.model === 'Alpha-USB' && ['port', 'login', 'password'].includes(field)) continue;
      let next = value;
      if (cameraChoiceSources[field] || field.endsWith('Torque') || field.endsWith('Direction')) {
        const text = value.trim().toLocaleLowerCase();
        if (!text) next = clearedCameraChoices[field] ?? '';
        else {
          const choices = cameraCellChoices(camera, field);
          const choice = choices.find(option => option.value === value) ??
            choices.find(option => option.value.toLocaleLowerCase() === text || option.label.toLocaleLowerCase() === text);
          if (!choice) { invalid++; continue; }
          next = choice.value;
        }
      }
      if (String(camera[field] ?? '') === next) continue;
      const fields = changed.get(camera) ?? new Set();
      for (const edited of stageCell(camera, field, next, false)) fields.add(edited);
      changed.set(camera, fields);
      redraw ||= field === 'model' || field === 'lens' || cameraSort(virtualSheet(tab) ?? camera.device).field === field;
    }
    if (changed.size) {
      recordCameraDrafts(historyBefore, historyRows);
      if (redraw) renderCameras();
      else {
        for (const [camera, fields] of changed) {
          for (const field of fields) {
            const control = root.querySelector('table[data-camera-device] [data-row="' + CSS.escape(camera.id) + '"][data-field="' + field + '"]');
            if (!control) continue;
            if (control.hasAttribute('data-camera-choice')) {
              control.closest('td').innerHTML = cameraChoiceCell(camera, field);
            } else control.value = camera[field];
          }
          paintItem(camera);
        }
        for (const sheet of cameraSheets.values()) sheet.refresh?.();
      }
      remember();
      if (ui.sendMode === 'Auto send') {
        const jobs = [...changed.keys()].filter(camera => changed.get(camera).size);
        const fields = new Map(jobs.map(camera => [camera.id, [...(camera.isNew ? camera.dirty : changed.get(camera))]]));
        if (jobs.length) void sendItems(jobs, 'camera', false, fields);
      }
    }
    if (invalid) toast(invalid + ' ' + (invalid === 1 ? 'choice is' : 'choices are') + ' unavailable for the destination');
  }

  window.addEventListener('pagehide', () => {
    for (const sheet of cameraSheets.values()) {
      sheet.listeners.abort();
      sheet.menu?.dispose();
      sheet.layout?.dispose();
      sheet.presentation?.forEach(control => control.dispose());
      sheet.controls?.dispose();
    }
    cameraSheets.clear();
  }, { once: true });
