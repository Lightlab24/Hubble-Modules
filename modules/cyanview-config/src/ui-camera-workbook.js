  const cameraSheets = new Map();
  const cameraAddresses = new Map();
  let spreadsheetUnavailable = false;
  const cameraAddress = cell => ({ rowId: cell.dataset.hubbleRow, columnId: cell.dataset.hubbleColumn });
  const cameraCellSelector = '[data-hubble-row][data-hubble-column]';
  const activeCameraCell = cameraCellSelector + '[data-hubble-spreadsheet-active="true"]';
  const cameraCellKey = ({ rowId, columnId }) => JSON.stringify([rowId, columnId]);

  function activeCamera(table) {
    const cell = table?.querySelector(activeCameraCell);
    return cell && cameras.find(camera => camera.device === table.dataset.cameraDevice && camera.id === cell.dataset.hubbleRow);
  }

  function syncCameraDeleteButton(group) {
    const button = group.querySelector('[data-action="delete-controller"]');
    const camera = activeCamera(group.querySelector('table[data-camera-device]'));
    const label = button.querySelector('[data-camera-delete-label]');
    const text = camera?.number ? 'Delete camera ' + camera.number : 'Delete camera';
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
        replacement.closest('.hc-sheet').querySelector('[data-camera-selection]').replaceWith(sheet.strip);
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
    for (const id of cameraAddresses.keys()) if (!device(id)) cameraAddresses.delete(id);
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
    const sheet = { listeners, controls: null, viewport: table.closest('.hc-scroll'), strip: table.closest('.hc-sheet').querySelector('[data-camera-selection]'), presentation: [], scale: 1 };
    cameraSheets.set(table, sheet);

    function indexSheet() {
      const visibleRows = [...table.tBodies[0].rows];
      const visibleColumns = [...table.querySelectorAll('col[data-hubble-column]')];
      rows = visibleRows.map(row => row.dataset.id);
      columns = visibleColumns.filter(col => col.dataset.hubbleColumn !== 'row').map(col => ({
        id: col.dataset.hubbleColumn,
        label: col.dataset.label,
        fill: ['number', 'name', 'ip'].includes(col.dataset.hubbleColumn) ? 'series' : 'copy',
      }));
      table.style.width = [...table.querySelectorAll('col')].reduce((width, col) => width + Number.parseInt(col.style.width, 10), 0) + 'px';
      const heights = cameraLayouts.get(deviceId)?.rows;
      for (const row of visibleRows) {
        const height = heights?.[row.dataset.id];
        if (height) row.style.setProperty('--hc-camera-row-height', height + 'px');
      }
      cells = new Map([...table.querySelectorAll(cameraCellSelector)].map(cell => [cameraCellKey(cameraAddress(cell)), cell]));
      cameraById = new Map(cameras.filter(camera => camera.device === deviceId).map(camera => [camera.id, camera]));
      for (const cell of cells.values()) {
        const input = cell.querySelector('input[data-field]');
        if (input) input.tabIndex = -1;
        if (!cell.querySelector('[data-field]:enabled')) cell.setAttribute('aria-readonly', 'true');
      }
      providers.clear();
    }
    indexSheet();

    function showSelection(address) {
      const strip = table.closest('.hc-sheet').querySelector('[data-camera-selection]');
      paintCameraSelectionSummary(strip, address && cells.get(cameraCellKey(address)));
      syncCameraDeleteButton(table.closest('[data-controller]'));
    }

    function getCell(address) {
      const key = cameraCellKey(address);
      const cell = cells.get(key);
      const camera = cameraById.get(address.rowId);
      if (!cell || !camera || cell.classList.contains('hc-axis-inactive')) return null;
      const control = cell.querySelector('[data-field]');
      if (!control) {
        return ['control', 'recording', 'cameraStatus', 'sync'].includes(address.columnId)
          ? { value: cell.textContent.trim(), readOnly: true }
          : null;
      }
      if (control.disabled) return null;
      const field = control.dataset.field;
      if (field === 'controlEnabled') return { value: cameraControlEnabled(camera) ? 'TRUE' : 'FALSE' };
      const value = String(camera[field] ?? (field === 'usb' ? 'USB · Automatic' : ''));
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
        getRows: () => rows,
        getColumns: () => columns,
        getCell,
        onHistory(direction) { cameraHistoryStep(deviceId, direction); },
        onSelection(address) {
          if (address) cameraAddresses.set(deviceId, address);
          else cameraAddresses.delete(deviceId);
          showSelection(address);
        },
        onEdit({ edits }) { applyCameraGridEdits(edits, cameraById); },
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
      controls.refresh();
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
      mountSpreadsheetToolbar({ root: sheet.strip.querySelector('[data-camera-text-size]'), textSize: { get: () => cameraLayout(deviceId).textSize ?? 13, onChange: size => changeCameraPresentation(deviceId, () => { cameraLayout(deviceId).textSize = size; }, false) } }),
      mountSpreadsheetViewport({ root: table, viewport: sheet.viewport, getFrozen: () => [...table.querySelectorAll('.hc-camera-frozen')].map(element => ({ element, left: Number.parseFloat(element.style.left) || 0 })), onZoom(ratio) { sheet.scale = ratio; sheet.strip.querySelector('[data-camera-zoom]').textContent = Math.round(ratio * 100) + '%'; controls.refresh(); sheet.layout?.refresh(); } }),
    ]);
    if (listeners.signal.aborted) { presentation.forEach(control => control.dispose()); return; }
    sheet.presentation = presentation;

    let menuReady;
    function openCameraMenu(row, cell, x, y) {
      const rowId = row?.dataset.id;
      const camera = cameraById.get(rowId);
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
          items: [{
            id: 'delete-camera', label: 'Delete camera', icon: 'delete', danger: true, disabled: !!camera.deleting,
            run: () => reviewCameraDeletion(cameraById.get(rowId)),
          }],
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
      else if (input.value !== value) applyCameraGridEdits([{ ...address, value: input.value }], cameraById);
    }

    table.addEventListener('dblclick', event => {
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(cameraCellSelector);
      if (cell && table.contains(cell)) editText(cell);
    }, options);
    table.addEventListener('contextmenu', event => {
      const row = event.target.closest('tbody tr[data-id]');
      if (!row) return;
      event.preventDefault();
      const cell = event.target.closest(cameraCellSelector) ?? row.querySelector(cameraCellSelector);
      openCameraMenu(row, cell, event.clientX, event.clientY);
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
        openCameraMenu(cell.closest('tr'), cell, left, bottom);
        return;
      }
      const address = cameraAddresses.get(deviceId);
      if (!address) return;
      if (address.columnId === 'controlEnabled' && [' ', 'Enter'].includes(event.key)) {
        event.preventDefault();event.stopPropagation();
        const camera=cameraById.get(address.rowId);
        if(camera)editCameraControl([{rowId:camera.id,value:!cameraControlEnabled(camera)}]);
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

  function applyCameraGridEdits(edits, cameraById) {
    const controlEdits=edits.filter(edit=>edit.columnId==='controlEnabled');
    if(controlEdits.length)editCameraControl(controlEdits);
    edits=edits.filter(edit=>edit.columnId!=='controlEnabled');
    const historyRows = [...new Set(edits.map(edit => cameraById.get(edit.rowId)).filter(Boolean))];
    const historyBefore = cameraDraftSnapshot(historyRows);
    const changed = new Map();
    const priority = { model: 0, lens: 1 };
    let invalid = 0;
    let redraw = false;
    // Model and lens changes can change the meaning of other columns in the batch.
    for (const { rowId, columnId, value } of [...edits].sort((a, b) =>
      (priority[a.columnId] ?? 2) - (priority[b.columnId] ?? 2))) {
      const camera = cameraById.get(rowId);
      if (!camera || camera.deleting || importedCamera(camera)) continue;
      const field = cameraField(camera, columnId);
      if (isLensSetting(field) && !lensFieldUsed(camera, field)) continue;
      if (camera.model === 'Alpha-USB' && ['port', 'login', 'password'].includes(field)) continue;
      let next = value;
      if (cameraChoiceSources[field] || field.endsWith('Torque') || field.endsWith('Direction')) {
        const choices = cameraCellChoices(camera, field);
        const text = value.trim().toLocaleLowerCase();
        const choice = choices.find(option => option.value === value) ??
          choices.find(option => option.value.toLocaleLowerCase() === text || option.label.toLocaleLowerCase() === text);
        if (!choice) { if (value) invalid++; continue; }
        next = choice.value;
      }
      if (String(camera[field] ?? '') === next) continue;
      const fields = changed.get(camera) ?? new Set();
      for (const edited of stageCell(camera, field, next, false)) fields.add(edited);
      changed.set(camera, fields);
      redraw ||= field === 'model' || field === 'lens' || cameraSort(camera.device).field === field;
    }
    if (changed.size) {
      recordCameraDrafts(historyBefore, historyRows);
      if (redraw) renderCameras();
      else {
        for (const [camera, fields] of changed) {
          const row = root.querySelector('table[data-camera-device] tr[data-id="' + CSS.escape(camera.id) + '"]');
          for (const field of fields) {
            const control = row?.querySelector('[data-field="' + field + '"]');
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
        const jobs = [...changed.keys()];
        const fields = new Map(jobs.map(camera => [camera.id, [...(camera.isNew ? camera.dirty : changed.get(camera))]]));
        void sendItems(jobs, 'camera', false, fields);
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
