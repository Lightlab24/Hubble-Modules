  const presentationLedger = new PresentationLedger();
  const cameraHistories = new Map();
  const copyPresentation = value => JSON.parse(JSON.stringify(value));
  function cameraHistory(id) {
    if (!cameraHistories.has(id)) cameraHistories.set(id, { undo: [], redo: [] });
    return cameraHistories.get(id);
  }
  function cameraPresentation(id) {
    return copyPresentation({ sheets: cameraSheetList(id) });
  }
  function applyCameraPresentation(id, value, preferred) {
    const state = cameraSheetState(id), sheets = copyPresentation(value.sheets);
    const find = sheetId => sheets.find(sheet => sheet.id === sheetId);
    state.sheets = sheets;
    showCameraSheet(id, find(preferred) ?? find(state.activeSheetId) ?? find(value.activeSheetId) ?? sheets[0]);
  }
  function recordCameraHistory(id, entry) {
    const history = cameraHistory(id);
    history.undo.push(entry); history.undo = history.undo.slice(-200); history.redo = [];
  }
  function changeCameraPresentation(id, change, redraw = true, record = true) {
    const before = cameraPresentation(id), activeBefore = cameraSheetState(id).activeSheetId;
    change();
    const after = cameraPresentation(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    // Which tab was open only matters if the change that opened another one fails.
    const epoch = presentationLedger.change('camera:' + id, { ...before, activeSheetId: activeBefore }, after);
    if (record) recordCameraHistory(id, { kind: 'layout', before, after, epoch, activeBefore, activeAfter: cameraSheetState(id).activeSheetId });
    if (redraw) renderCameras();
    else for (const [table, sheet] of cameraSheets) if (table.dataset.cameraDevice === id) sheet.refresh?.();
    remember();
    return epoch;
  }
  function repairPresentationPlan(plan, ticket) {
    const data = plan.uiState?.privateContent;
    if (!data) return plan;
    for (const { key, value } of presentationLedger.repairs(ticket)) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('camera:')) {
        const active = value.sheets.find(sheet => sheet.id === data.cameraSheetsByDevice?.[id]?.activeSheetId) ?? value.sheets[0];
        (data.cameraLayouts ??= {})[id] = copyPresentation(active.layout);
        (data.hiddenCameraColumnsByDevice ??= {})[id] = [...active.hidden];
        (data.axisGroupsByDevice ??= {})[id] = { ...active.expanded };
        (data.cameraSheetsByDevice ??= {})[id] = copyPresentation(cameraSheetsRecord(id, value.sheets, active.id));
      }
    }
    return plan;
  }
  function rejectPresentation(ticket) {
    const rejected = presentationLedger.failed(ticket);
    for (const { key, value, epochs } of rejected) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('camera:')) {
        applyCameraPresentation(id, value);
        const history = cameraHistory(id);
        for (const side of ['undo', 'redo']) history[side] = history[side].filter(entry => !epochs.includes(entry.epoch));
      }
    }
    if (rejected.length) renderCameras();
  }
  function cameraDraftSnapshot(rows) {
    const skipped = new Set(['id', 'dirty', 'pending', 'result', 'revision', 'jobs', 'online', 'deleting', 'elementKey', 'newElementKey', 'createState', 'needsInitialization', 'sentValues']);
    return rows.map(row => ({ id: row.id, values: copyPresentation(Object.fromEntries(Object.entries(row).filter(([key]) => !skipped.has(key)))), dirty: [...row.dirty], pending: row.pending, result: row.result }));
  }
  function recordCameraDrafts(before, rows) {
    const after = cameraDraftSnapshot(rows), byDevice = new Map();
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      if (!next) continue;
      const fields = [...new Set([...Object.keys(old.values), ...Object.keys(next.values)])].filter(key => JSON.stringify(old.values[key]) !== JSON.stringify(next.values[key]));
      if (!fields.length) continue;
      // What it was before the first edit since the last send, which is what Cancel goes back to.
      const row = rows.find(item => item.id === old.id);
      for (const field of fields) if (!['routeDraft', 'device', 'remiMaster', 'removeStaged'].includes(field) && !(field in (row.sentValues ??= {}))) row.sentValues[field] = old.values[field] ?? null;
      // Undo belongs to the sheet the edit was made on.
      const id = virtualSheet(tab) ?? row.device;
      if (!byDevice.has(id)) byDevice.set(id, []);
      byDevice.get(id).push({ before: old, after: next, fields });
    }
    for (const [id, patches] of byDevice) recordCameraHistory(id, { kind: 'cells', patches });
  }
  function cameraHistoryStep(id, direction) {
    const history = cameraHistory(id), forward = direction === 'redo';
    const from = history[forward ? 'redo' : 'undo'], to = history[forward ? 'undo' : 'redo'];
    const entry = from.at(-1);
    if (!entry) return;
    const source = forward ? 'before' : 'after', target = forward ? 'after' : 'before';
    if (entry.kind === 'cleared') setClearedRows(entry.rows, forward);
    else if (entry.kind === 'layout') {
      if (JSON.stringify(cameraPresentation(id)) !== JSON.stringify(entry[source])) { toast('The sheet layout has changed; this history entry is no longer available'); return; }
      entry.epoch = changeCameraPresentation(id, () => applyCameraPresentation(id, entry[target], forward ? entry.activeAfter : entry.activeBefore), true, false);
    } else {
      for (const patch of entry.patches) {
        const row = cameras.find(row => row.id === patch[source].id);
        if (!row || row.jobs || row.deleting || patch.fields.some(field => JSON.stringify(row[field]) !== JSON.stringify(patch[source].values[field]) || row.dirty.has(field) !== patch[source].dirty.includes(field))) {
          toast('This camera has changed since the edit; its current settings are retained'); return;
        }
      }
      for (const patch of entry.patches) {
        const row = cameras.find(row => row.id === patch[target].id);
        for (const field of patch.fields) {
          if (field in patch[target].values) row[field] = copyPresentation(patch[target].values[field]); else delete row[field];
          if (patch[target].dirty.includes(field)) row.dirty.add(field); else row.dirty.delete(field);
        }
        row.pending = row.isNew || row.dirty.size > 0;
        row.result = row.pending ? 'Pending' : patch[target].result; row.revision++;
      }
      renderCameras(); remember();
    }
    from.pop(); to.push(entry);
  }
