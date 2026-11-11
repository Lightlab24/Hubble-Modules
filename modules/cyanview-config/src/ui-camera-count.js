  // How many cameras a sheet has is a number box. Raising it adds rows at the end, numbered on from
  // the highest camera, and lowering it takes rows off the end. A row that never reached a controller
  // goes at once; one that did is only marked for delete, and waits in Pending sends like any delete.
  // Copies made on another controller aren't counted, because they're removed from where they came from.
  const cameraCountLimit = 512;
  // Cameras the count box marked for delete, so raising it again brings those back. One deleted
  // with its own bin stays deleted.
  const countMarked = new Set();
  function countedCameras(sheetId) {
    return sheetCameras(sheetId).filter(camera => !importedCamera(camera) && !camera.removeStaged && !camera.deleting);
  }
  function cameraCountControl(sheetId) {
    const count = countedCameras(sheetId).length;
    const label = sheetId === cameraSetupSheet ? 'Number of cameras' : 'Number of cameras on ' + (device(sheetId)?.name ?? sheetId);
    return '<span class="hc-count" data-camera-count="' + esc(sheetId) + '"><span class="hc-count-label" aria-hidden="true">Cameras</span><span class="hc-stepper">' +
      '<button type="button" data-count-step="-1" aria-label="One camera fewer"' + (count ? '' : ' disabled') + '>' + icon('minus') + '</button>' +
      '<input class="hc-mono" data-count-input inputmode="numeric" value="' + count + '" aria-label="' + esc(label) + '" autocomplete="off" spellcheck="false">' +
      '<button type="button" data-count-step="1" aria-label="One camera more">' + icon('plus') + '</button></span></span>';
  }
  function paintCameraCounts() {
    for (const control of root.querySelectorAll('[data-camera-count]')) {
      const count = countedCameras(control.dataset.cameraCount).length, input = control.querySelector('[data-count-input]');
      if (document.activeElement !== input && input.value !== String(count)) input.value = String(count);
      control.querySelector('[data-count-step="-1"]').disabled = !count;
      control.querySelector('[data-count-step="1"]').disabled = cameras.length >= cameraCountLimit;
    }
  }
  function setCameraCount(sheetId, wanted) {
    const own = countedCameras(sheetId), target = Math.max(0, Math.round(wanted));
    if (!Number.isFinite(target) || target === own.length) { paintCameraCounts(); return; }
    if (target > own.length) {
      // Cameras the count box marked for delete come back first, from the top, before any new row is made.
      const marked = sheetCameras(sheetId).filter(camera => countMarked.has(camera) && camera.removeStaged && !camera.jobs && !camera.deleting).sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)).slice(0, target - own.length);
      for (const camera of marked) countMarked.delete(camera);
      if (marked.length) stageRemoval(marked, false);
      const missing = target - own.length - marked.length;
      if (missing > 0) addCameraRows(sheetId === cameraSetupSheet ? '' : sheetId, missing, countedCameras(sheetId));
      else paintCameraCounts();
    } else {
      // From the end, so the cameras at the top keep their place.
      const rows = [...own].filter(camera => !camera.jobs).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0)).slice(0, own.length - target);
      for (const camera of rows) countMarked.add(camera);
      stageRemoval(rows, true);
      paintCameraCounts();
    }
  }
  function addCameraRows(deviceId, count, own) {
    const room = cameraCountLimit - cameras.length;
    if (room <= 0) { toast('Camera capacity reached'); paintCameraCounts(); return; }
    if (count > room) toast('Only ' + room + ' more ' + (room === 1 ? 'camera fits' : 'cameras fit'));
    const last = [...own].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)).at(-1);
    // A new row takes the model of the last camera, so a rig of one kind fills in without choosing each time.
    const model = last?.model && last.model !== 'Choose model…' ? last.model : 'Choose model…', usb = model === 'Alpha-USB';
    let next = Math.max(0, ...(deviceId ? cameras.filter(camera => camera.device === deviceId) : cameras).map(camera => Number(camera.number)).filter(Number.isFinite)) + 1;
    const added = Array.from({ length: Math.min(count, room) }, () => {
      const number = String(next++);
      return { id: 'new-camera-' + crypto.randomUUID(), device: deviceId, number, name: 'Camera ' + number, model, ip: '', lens: 'None', lensPort: 'None', online: null, pending: true, result: usb ? 'Pending' : 'Incomplete', port: usb ? '' : '80', login: usb ? '' : 'admin', password: '', isNew: true, dirty: new Set(['number', 'name', 'model', 'ip', 'lens', 'lensPort']), revision: 0, jobs: 0 };
    });
    cameras.push(...added);
    if (deviceId) openControllers.add(deviceId);
    renderCameras();
    if (ui.sendMode === 'Auto send' && deviceId) {
      const ready = added.filter(camera => !valid(camera, 'camera'));
      if (ready.length) sendItems(ready, 'camera');
    }
    remember();
  }
  const renderCamerasBeforeCounts = renderCameras;
  renderCameras = function(...args) { const drawn = renderCamerasBeforeCounts(...args); paintCameraCounts(); return drawn; };

  root.addEventListener('click', event => {
    const step = event.target.closest('[data-count-step]');
    if (!step || step.disabled) return;
    const sheetId = step.closest('[data-camera-count]').dataset.cameraCount;
    setCameraCount(sheetId, countedCameras(sheetId).length + Number(step.dataset.countStep));
  });
  root.addEventListener('keydown', event => {
    const input = event.target;
    if (!input.matches?.('[data-count-input]')) return;
    const sheetId = input.closest('[data-camera-count]').dataset.cameraCount;
    if (event.key === 'Enter') { event.preventDefault(); setCameraCount(sheetId, Number(input.value)); input.select(); }
    else if (event.key === 'Escape') { event.preventDefault(); input.value = String(countedCameras(sheetId).length); input.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCameraCount(sheetId, countedCameras(sheetId).length + (event.key === 'ArrowUp' ? 1 : -1));
      input.value = String(countedCameras(sheetId).length);
    }
  });
  root.addEventListener('change', event => {
    const input = event.target;
    if (!input.matches?.('[data-count-input]')) return;
    const value = input.value.trim();
    if (/^\d+$/.test(value)) setCameraCount(input.closest('[data-camera-count]').dataset.cameraCount, Number(value));
    else paintCameraCounts();
  });
  root.addEventListener('focusout', event => {
    if (event.target.matches?.('[data-count-input]')) queueMicrotask(paintCameraCounts);
  });
