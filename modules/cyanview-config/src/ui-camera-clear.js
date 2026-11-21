  // ── Clear from workspace and Clear from RCP ──────────────────────────────────
  // Every camera row has two buttons. The eye clears the camera from this workspace only: nothing is sent,
  // so it works with every controller off, and ⌘Z puts it back. The bin clears it from its controller,
  // after a check, at once and whatever the Send mode. Clear workspace does what the eye does to every
  // camera on Camera Configuration. A camera cleared from the workspace that a later read finds on its
  // controller is listed under Not set up by Hubble (asked for Nov 21, 2026).

  // Where each camera cleared from the workspace was, as 'device\nkey'. A read that finds one again lists it
  // apart, even the read that follows one of Hubble's own sends, which would otherwise take it back in.
  const clearedFromWorkspace = new Set();
  const clearedLimit = 1024;
  const clearedId = camera => camera.device + '\n' + camera.elementKey;
  const clearBusy = camera => !!camera.jobs || !!camera.deleting || queuedSends.has(camera) || movesInFlight.has(camera);

  // A row and every copy made from it, however many copies away.
  function withCopies(rows) {
    const { children } = routeTree(), out = [], seen = new Set();
    const walk = row => { if (seen.has(row)) return; seen.add(row); out.push(row); for (const copy of children.get(row) ?? []) walk(copy); };
    for (const row of rows) walk(row);
    return out;
  }
  const cameraLabel = camera => 'camera ' + (camera.number || '') + (camera.name ? ' · ' + camera.name : '');
  function forgetRemiDrafts(camera) {
    if (!camera.elementKey) return;
    const state = remiPanels.get(camera.device);
    if (!state?.drafts) return;
    for (const [id, item] of [...state.drafts]) if (item.key === camera.elementKey) state.drafts.delete(id);
  }
  // Takes the rows, and the copies made from them, out of the workspace. Nothing is sent.
  function removeFromWorkspace(rows) {
    const gone = withCopies(rows.filter(camera => cameras.includes(camera) && !clearBusy(camera))).filter(camera => !clearBusy(camera));
    if (!gone.length) return [];
    const entries = gone.map(camera => ({ camera, index: cameras.indexOf(camera) }));
    cameras = cameras.filter(camera => !gone.includes(camera));
    for (const camera of gone) {
      countMarked.delete(camera);
      routeErrors.delete(camera.id);
      forgetRemiDrafts(camera);
      if (camera.elementKey) clearedFromWorkspace.add(clearedId(camera));
    }
    while (clearedFromWorkspace.size > clearedLimit) clearedFromWorkspace.delete(clearedFromWorkspace.values().next().value);
    routeTreeMemo = null;
    return entries;
  }
  function clearFromWorkspace(rows, sheetId) {
    const shown = rows.filter(camera => cameras.includes(camera) && !clearBusy(camera));
    const entries = removeFromWorkspace(shown);
    if (!entries.length) { if (rows.length) toast('Wait for its send to finish'); return; }
    recordCameraHistory(sheetId, { kind: 'cleared', entries });
    renderCameras();
    schedulePendingSends();
    remember();
    const where = [...new Set(shown.map(camera => camera.device))];
    toast(shown.length === 1
      ? 'Camera ' + shown[0].number + ' cleared from the workspace. Nothing on ' + (where[0] && device(where[0]) ? controllerName(where[0]) : 'the RCPs') + ' changed · ⌘Z puts it back'
      : shown.length + ' cameras cleared from the workspace. Nothing on the RCPs changed · ⌘Z puts them back');
  }
  // ⌘Z puts cleared cameras back where they were. One a read has already found again under Not set up by
  // Hubble goes back as it was before it was cleared.
  function restoreToWorkspace(entries) {
    for (const { camera, index } of [...entries].sort((a, b) => a.index - b.index)) {
      if (cameras.includes(camera)) continue;
      const found = cameras.findIndex(row => row.id === camera.id || camera.elementKey && row.device === camera.device && row.elementKey === camera.elementKey);
      if (found >= 0) cameras.splice(found, 1);
      cameras.splice(Math.min(index, cameras.length), 0, camera);
      if (camera.elementKey) clearedFromWorkspace.delete(clearedId(camera));
    }
    routeTreeMemo = null;
  }
  const historyStepBeforeClear = cameraHistoryStep;
  cameraHistoryStep = function(id, direction) {
    const history = cameraHistory(id), forward = direction === 'redo', from = history[forward ? 'redo' : 'undo'], to = history[forward ? 'undo' : 'redo'];
    const entry = from.at(-1);
    if (entry?.kind !== 'cleared') return historyStepBeforeClear(id, direction);
    if (forward) {
      const rows = entry.entries.map(item => item.camera).filter(camera => cameras.includes(camera));
      if (rows.some(clearBusy)) { toast('Wait for its send to finish'); return; }
      removeFromWorkspace(rows);
    } else restoreToWorkspace(entry.entries);
    from.pop();
    to.push(entry);
    renderCameras();
    schedulePendingSends();
    remember();
  };

  // A read that finds a cleared camera on its controller lists it under Not set up by Hubble, and one the
  // controller no longer has is forgotten.
  const mergeBeforeClear = mergeSnapshot;
  mergeSnapshot = function(snapshot) {
    mergeBeforeClear(snapshot);
    const id = snapshot?.device?.id;
    if (!clearedFromWorkspace.size || !id || !Array.isArray(snapshot.cameras)) return;
    const listed = new Set(snapshot.cameras.map(row => id + '\n' + row.elementKey));
    for (const camera of cameras) {
      if (camera.device !== id || !camera.elementKey || !clearedFromWorkspace.has(clearedId(camera))) continue;
      camera.foreign = true;
      clearedFromWorkspace.delete(clearedId(camera));
    }
    for (const value of [...clearedFromWorkspace]) if (value.startsWith(id + '\n') && !listed.has(value)) clearedFromWorkspace.delete(value);
    routeTreeMemo = null;
  };
  const saveClearedFromWorkspace = () => [...clearedFromWorkspace].slice(-clearedLimit);
  function restoreClearedFromWorkspace(values) {
    clearedFromWorkspace.clear();
    for (const value of Array.isArray(values) ? values : []) if (typeof value === 'string' && value.includes('\n') && value.length <= 400) clearedFromWorkspace.add(value);
  }

  // ── Clear from RCP ──
  // What clearing a row from its controller takes with it, and what stops it now.
  function rcpClearPlan(camera) {
    const rows = withCopies([camera]), source = importedCamera(camera) ? sourceRowOf(camera) : null;
    const involved = [...new Set([camera.device, ...rows.map(row => row.device)])];
    const offline = involved.filter(id => device(id)?.online === false);
    const unread = rows.filter(row => !row.elementKey);
    const copies = rows.filter(row => row !== camera).map(row => controllerName(row.device));
    return { rows, source, offline, unread, copies };
  }
  function reviewClearFromRcp(camera) {
    if (!camera || clearBusy(camera)) return;
    // The bin on a camera marked for delete takes that back, as it always has.
    if (removalStaged(camera)) { reviewCameraDeletion(camera); return; }
    // A camera that never reached its controller has nothing to delete there.
    if (!importedCamera(camera) && camera.isNew && !camera.elementKey && !camera.createState) { clearFromWorkspace([camera], virtualSheet(tab) ?? camera.device); return; }
    const plan = rcpClearPlan(camera), where = controllerName(camera.device), copy = importedCamera(camera);
    const title = copy ? 'Clear the REMI copy of camera ' + esc(camera.number) + ' from ' + esc(where) + '?' : 'Clear camera ' + esc(camera.number) + ' from ' + esc(where) + '?';
    const lines = [];
    if (copy) lines.push(plan.source ? 'Its camera stays on ' + esc(controllerName(plan.source.device)) + '.' : 'The camera it copies isn’t in this workspace and stays where it is.');
    if (plan.copies.length) lines.push('Its REMI ' + (plan.copies.length === 1 ? 'copy' : 'copies') + ' on ' + esc([...new Set(plan.copies)].join(' and ')) + ' come' + (plan.copies.length === 1 ? 's' : '') + ' off first.');
    const blocked = plan.offline.length ? esc(plan.offline.map(controllerName).join(' and ')) + (plan.offline.length === 1 ? ' reads' : ' read') + ' Offline, so it can’t be cleared from there now. The eye clears it from the workspace without ' + (plan.offline.length === 1 ? 'it' : 'them') + '.'
      : plan.unread.length ? 'Refresh this controller first. Hubble hasn’t read where this camera sits on it.' : '';
    const detail = [camera.model && !copy ? camera.model : '', camera.model === 'Alpha-USB' ? camera.usb : camera.ip].filter(Boolean).join(' · ');
    $('modal-layer').innerHTML = '<section class="hc-modal" role="dialog" aria-modal="true" aria-labelledby="hc-clear-rcp-title"><div class="hc-modal-head"><div><h3 id="hc-clear-rcp-title">' + title + '</h3><p>It is deleted there as soon as you press Clear. Nothing waits in Pending sends.</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body"><div class="hc-change-item"><div><strong>' + esc(where) + ' · Camera ' + esc(camera.number) + '</strong><span class="hc-caption">Delete</span></div><div>' + esc(camera.name) + '</div>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + lines.map(line => '<small>' + line + '</small>').join('') + '</div>' +
      (blocked ? '<div class="hc-change-item"><small class="hc-error-text" data-role="clear-rcp-blocked">' + blocked + '</small></div>' : '') +
      '<div class="hc-change-item"><small>This can’t be undone from Hubble.</small></div></div>' +
      '<div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button><button class="hc-danger hc-danger-solid" data-clear-rcp-confirm="' + esc(camera.id) + '"' + (blocked ? ' disabled' : '') + '>Clear from ' + esc(where) + '</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  // A copy comes off on the controller holding it. The ones made from it come off first.
  async function removeCopies(rows) {
    const errors = [];
    for (const copy of [...rows].reverse()) {
      if (!copy.elementKey) continue;
      try {
        const report = await moduleBridge.remiSend({ receiver: copy.device, items: [{ id: 'remove:' + copy.elementKey, kind: 'remove', key: copy.elementKey, enable: false, ...(copy.remi ? { selector: copy.remi.selector, connection: copy.remi.connection } : {}), label: copy.name }] });
        if (report.snapshot) mergeOwn(report.snapshot);
        const failed = (report.results || []).find(item => item.error);
        if (failed) errors.push(failed.error);
        if (report.refresh) await remiRefreshSheets();
      } catch (error) { errors.push(error.message || 'The REMI copy could not be removed'); }
      if (errors.length) break;
    }
    return errors;
  }
  function clearFromRcp(camera) {
    if (!camera || !cameras.includes(camera) || clearBusy(camera)) return;
    if (!moduleBridge || moduleBridge.preview) { toast(sampleRouteMessage); return; }
    const plan = rcpClearPlan(camera);
    if (plan.offline.length || plan.unread.length) return;
    delete camera.removeStaged;
    delete camera.routeDraft;
    queuedSends.add(camera);
    paintItem(camera);
    return enqueueSend(async () => {
      queuedSends.delete(camera);
      const where = controllerName(camera.device), name = 'Camera ' + camera.number;
      if (!importedCamera(camera)) {
        await removeCameras([camera]);
        routeTreeMemo = null;
        toast(cameras.includes(camera) ? name + ' was not cleared from ' + where + ': ' + (routeErrors.get(camera.id) || 'it could not be confirmed') : name + ' cleared from ' + where);
        return;
      }
      let errors;
      const source = plan.source;
      // Marked as deleting, not busy, so the read that confirms it takes the row away.
      for (const row of plan.rows) { row.deleting = true; paintItem(row); }
      if (source && source.elementKey) {
        // A copy of one of your cameras comes off by routing that camera without it and the copies made from it.
        const actual = actualRoute(source), drop = new Set(plan.rows.map(row => row.device)), tree = Object.fromEntries(Object.entries(actual.links).filter(([rcp]) => !drop.has(rcp)));
        const report = await requestRoutes([{ id: source.id, camera: source.device, key: source.elementKey, tree, expected: actual.links, copies: actual.keys }]);
        const result = report.results?.find(row => row.id === source.id);
        errors = result?.verified ? [] : [result?.error || 'its REMI copies could not be removed'];
      } else {
        errors = await removeCopies(plan.rows);
      }
      routeTreeMemo = null;
      for (const row of plan.rows) if (cameras.includes(row)) { delete row.deleting; paintItem(row); }
      renderCameras();
      remember();
      toast(errors.length ? 'The REMI copy of ' + name.toLowerCase() + ' was not cleared from ' + where + ': ' + errors[0] : 'The REMI copy of ' + name.toLowerCase() + ' cleared from ' + where);
    });
  }

  // The toolbar's Clear workspace is only there when there is something to clear.
  function paintClearWorkspace() {
    const button = root.querySelector('[data-action="clear-workspace"]');
    if (button) button.disabled = !assignmentRows().some(camera => !clearBusy(camera));
  }
  const renderBeforeClear = renderCameras;
  renderCameras = function(...args) { const drawn = renderBeforeClear(...args); paintClearWorkspace(); return drawn; };

  root.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (!button || button.disabled) return;
    const data = button.dataset, row = id => cameras.find(camera => camera.id === id);
    if (data.action === 'clear-workspace-row' && row(data.clearRow)) {
      const sheet = button.closest('table[data-camera-device]')?.dataset.cameraDevice ?? virtualSheet(tab) ?? row(data.clearRow).device;
      clearFromWorkspace([row(data.clearRow)], sheet);
    }
    else if (data.action === 'clear-rcp-row' && row(data.clearRow)) reviewClearFromRcp(row(data.clearRow));
    else if (data.clearRcpConfirm) { $('modal-layer').hidden = true; void clearFromRcp(row(data.clearRcpConfirm)); }
    else if (data.action === 'clear-workspace') clearFromWorkspace(assignmentRows(), cameraSetupSheet);
  });
