  const presentationLedger = new PresentationLedger();
  const cameraHistories = new Map();
  const copyPresentation = value => JSON.parse(JSON.stringify(value));
  function cameraHistory(id) {
    if (!cameraHistories.has(id)) cameraHistories.set(id, { undo: [], redo: [] });
    return cameraHistories.get(id);
  }
  function cameraPresentation(id) {
    return copyPresentation({ layout: cameraLayout(id), hidden: [...hiddenCameraColumns(id)], expanded: axisGroups(id) });
  }
  function applyCameraPresentation(id, value) {
    cameraLayouts.set(id, copyPresentation(value.layout));
    hiddenCameraColumnsByDevice[id] = new Set(value.hidden);
    axisGroupsByDevice[id] = { ...value.expanded };
  }
  function recordCameraHistory(id, entry) {
    const history = cameraHistory(id);
    history.undo.push(entry); history.undo = history.undo.slice(-200); history.redo = [];
  }
  function changeCameraPresentation(id, change, redraw = true, record = true) {
    const before = cameraPresentation(id);
    change();
    const after = cameraPresentation(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const epoch = presentationLedger.change('camera:' + id, before, after);
    if (record) recordCameraHistory(id, { kind: 'layout', before, after, epoch });
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
        (data.cameraLayouts ??= {})[id] = copyPresentation(value.layout);
        (data.hiddenCameraColumnsByDevice ??= {})[id] = [...value.hidden];
        (data.axisGroupsByDevice ??= {})[id] = { ...value.expanded };
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
    const skipped = new Set(['id', 'device', 'dirty', 'pending', 'result', 'revision', 'jobs', 'online', 'deleting', 'elementKey', 'newElementKey', 'createState', 'needsInitialization']);
    return rows.map(row => ({ id: row.id, values: copyPresentation(Object.fromEntries(Object.entries(row).filter(([key]) => !skipped.has(key)))), dirty: [...row.dirty], pending: row.pending, result: row.result }));
  }
  function recordCameraDrafts(before, rows) {
    const after = cameraDraftSnapshot(rows), byDevice = new Map();
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      if (!next) continue;
      const fields = [...new Set([...Object.keys(old.values), ...Object.keys(next.values)])].filter(key => JSON.stringify(old.values[key]) !== JSON.stringify(next.values[key]));
      if (!fields.length) continue;
      const id = rows.find(row => row.id === old.id).device;
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
    if (entry.kind === 'layout') {
      if (JSON.stringify(cameraPresentation(id)) !== JSON.stringify(entry[source])) { toast('The sheet layout has changed; this history entry is no longer available'); return; }
      entry.epoch = changeCameraPresentation(id, () => applyCameraPresentation(id, entry[target]), true, false);
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
