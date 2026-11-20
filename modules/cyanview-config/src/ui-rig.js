  // ── A rig that was set up outside Hubble ───────────────────────────────────
  // What is already on the controllers is read in as it is. Each controller lists the others it has
  // seen, so after a read the ones that answer are added, with their cameras and where each copy
  // comes from. Nothing is sent to a controller for any of this.
  // A controller removed here is left out of the search until it is added back by hand.
  const ignoredControllers = new Set();
  let findingRig = false;
  async function findRig() {
    if (!moduleBridge || moduleBridge.preview || findingRig) return;
    findingRig = true;
    const added = [];
    try {
      for (const serial of [...ignoredControllers]) if (devices.some(d => d.serial === serial)) ignoredControllers.delete(serial);
      const reply = await moduleBridge.findRig({ ignore: [...ignoredControllers] });
      for (const candidate of reply.found || []) {
        if (devices.some(d => d.serial === candidate.serial) || ignoredControllers.has(candidate.serial)) continue;
        if (devices.length >= 128) break;
        const snapshot = await moduleBridge.importDevice(candidate);
        if (cameras.length + snapshot.cameras.length > 512) break;
        devices.push(snapshot.device);
        cameras.push(...snapshot.cameras.map(row => ({ ...restoredRow(row), foreign: true })));
        lans.push(...snapshot.lans.map(restoredRow));
        added.push(snapshot.device);
      }
    } catch { /* A search that fails leaves the list as it was. */ }
    finally { findingRig = false; }
    if (!added.length) return;
    routeTreeMemo = null;
    try { await restoreCameraChoiceCatalogs(); } catch { /* The rows are still usable without their choice lists. */ }
    syncFilter();
    renderResults();
    renderLans();
    renderCameras();
    remember();
    toast('Added ' + added.length + (added.length === 1 ? ' controller' : ' controllers') + ' found on the network: ' + added.map(d => d.name).join(', '));
  }
  const refreshBeforeRig = refreshLive;
  refreshLive = async function() { await refreshBeforeRig(); void findRig(); };
  const addBeforeRig = addLiveResults;
  addLiveResults = async function() {
    const before = devices.length;
    await addBeforeRig();
    if (devices.length > before) void findRig();
  };
  const removeBeforeRig = removeManagedDevice;
  removeManagedDevice = function(id) {
    const removed = device(id);
    removeBeforeRig(id);
    if (removed && !device(id)) { ignoredControllers.add(removed.serial); remember(); }
  };

  // ── What Hubble didn't configure ───────────────────────────────────────────
  // A camera or REMI copy that a read turns up, and that wasn't here before, was set up outside
  // Hubble. It shows up like anything else and is asked about once: keep it as it is, or clear it.
  // What Hubble sends itself comes back through mergeOwn and is never asked about.
  let ownMerge = 0;
  function mergeOwn(snapshot) {
    ownMerge++;
    try { mergeSnapshot(snapshot); } finally { ownMerge--; }
  }
  const mergeBeforeRig = mergeSnapshot;
  mergeSnapshot = function(snapshot) {
    const known = ownMerge ? null : new Set(cameras), id = snapshot.device?.id;
    const ours = known ? cameras.filter(camera => camera.device === id && camera.elementKey && !camera.foreign) : [];
    mergeBeforeRig(snapshot);
    if (!known) return;
    // A camera of ours deleted and added back under a new key, with the same number, is still ours.
    const replaced = ours.filter(camera => !cameras.includes(camera)).map(camera => String(camera.number));
    for (const camera of cameras) if (!known.has(camera) && camera.elementKey && camera.device === id) {
      const at = replaced.indexOf(String(camera.number));
      if (at >= 0) replaced.splice(at, 1);
      else camera.foreign = true;
    }
  };
  const copyLabel = camera => (String(camera.number ?? '') + ' ' + String(camera.name ?? '')).trim() || 'Camera';
  const listed = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  // A camera and the copies of it that also weren't configured here are one thing to decide.
  function foreignItems() {
    const rows = cameras.filter(camera => camera.foreign && camera.elementKey && !camera.deleting), grouped = new Set(), items = [];
    for (const camera of rows.filter(row => !importedCamera(row))) {
      const copies = rows.filter(row => importedCamera(row) && sourceRowOf(row) === camera), on = Object.keys(actualRoute(camera).links).map(controllerName);
      for (const row of [camera, ...copies]) grouped.add(row);
      items.push({ id: camera.id, kind: 'camera', camera, rows: [camera, ...copies], title: copyLabel(camera) + ' · set up on ' + controllerName(camera.device),
        detail: on.length ? 'Also on ' + listed(on) + ' as ' + (on.length === 1 ? 'a REMI copy.' : 'REMI copies.') : 'Not REMI’d to another controller.' });
    }
    for (const copy of rows.filter(row => importedCamera(row) && !grouped.has(row))) {
      const source = sourceRowOf(copy);
      items.push({ id: copy.id, kind: 'copy', camera: copy, source, rows: [copy], title: copyLabel(copy) + ' on ' + controllerName(copy.device) + ' · REMI copy',
        detail: source ? 'A copy of ' + copyLabel(source) + ' from ' + controllerName(source.device) + '.' : 'Hubble can’t tell which camera it was made from.' });
    }
    return items;
  }
  // Listed apart from the cameras Hubble set up, with Move and Clear on each. Move makes it one of yours and
  // sends nothing. Clear marks it like a delete, and it goes from Pending sends like every other delete.
  root.querySelector('[data-role="setup-group"]').insertAdjacentHTML('afterend',
    '<div class="hc-outside" data-role="outside" hidden><div class="hc-outside-title"><div class="hc-toolbar-title"><h3>Not set up by Hubble</h3><span data-role="outside-summary"></span></div></div>' +
    '<section class="hc-controller" data-role="outside-group"><div class="hc-controller-tools"><span class="hc-outside-note">Cyanview has these, but Hubble didn’t set them up. Move one into your cameras to manage it here, or clear it from its controller.</span><span class="hc-right"></span>' +
    '<button type="button" class="hc-button" data-action="outside-move-all">' + icon('plus') + 'Move all to my cameras</button><button type="button" class="hc-danger" data-action="outside-clear-all">' + icon('trash-2') + 'Clear all</button></div>' +
    '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid hc-outside-grid" aria-label="Not set up by Hubble"></table></div></div></section></div>');
  const outsideDraft = item => remiPanels.get(item.camera.device)?.drafts.get('remove:' + item.camera.elementKey);
  // Whether Clear has marked it: a camera to delete, a copy whose circle is off, or a copy with no known source to remove.
  function outsideCleared(item) {
    if (item.kind === 'camera') return !!item.camera.removeStaged;
    return item.source && cameras.includes(item.source) ? copyRemoval(item.camera) : !!outsideDraft(item);
  }
  const outsideBusy = item => item.rows.some(row => row.jobs || row.deleting);
  function clearOutside(item, on) {
    if (outsideBusy(item) || outsideCleared(item) === on) return;
    const camera = item.camera;
    if (item.kind === 'camera') stageRemoval([camera], on);
    // A copy of a camera here comes off by clearing its circle, which waits in Pending sends.
    else if (item.source && cameras.includes(item.source)) reviewCameraDeletion(camera);
    else {
      const state = remiPanelState(camera.device), id = 'remove:' + camera.elementKey;
      if (on) state.drafts.set(id, { id, kind: 'remove', key: camera.elementKey, enable: false, ...(camera.remi ? { selector: camera.remi.selector, connection: camera.remi.connection } : {}), label: camera.name });
      else state.drafts.delete(id);
      renderCameras();
      remember();
    }
  }
  function moveOutside(items) {
    items = items.filter(item => !outsideBusy(item) && !outsideCleared(item));
    if (!items.length) return;
    for (const item of items) for (const row of item.rows) delete row.foreign;
    routeTreeMemo = null;
    renderCameras();
    remember();
    toast(items.length === 1 ? copyLabel(items[0].camera) + ' is now one of your cameras' : items.length + ' cameras moved to your cameras');
  }
  function outsideRow(item) {
    const camera = item.camera, copy = item.kind === 'copy', cleared = outsideCleared(item), busy = outsideBusy(item), id = esc(item.id), label = esc(copyLabel(camera));
    const source = copy ? 'Copy on ' + controllerName(camera.device) + (item.source ? ' · of ' + copyLabel(item.source) : '') : controllerName(camera.device);
    const address = camera.model === 'Alpha-USB' ? camera.usb : camera.ip;
    const enabled = camera.cameraEnabled === true ? 'On' : camera.cameraEnabled === false ? 'Off' : '';
    const tools = '<button type="button" class="hc-button" data-outside-move="' + id + '" aria-label="Move ' + label + ' to my cameras" title="Move to my cameras. Nothing is sent."' + (busy || cleared ? ' disabled' : '') + '>Move</button>' +
      '<button type="button" class="' + (cleared ? 'hc-button' : 'hc-danger') + '" data-outside-clear="' + id + '" aria-label="' + (cleared ? 'Keep ' : 'Clear ') + label + '" title="' + (cleared ? 'Keep it on ' + esc(controllerName(camera.device)) : 'Delete it from ' + esc(controllerName(camera.device)) + ' when you send it') + '"' + (busy ? ' disabled' : '') + '>' + (cleared ? 'Keep' : 'Clear') + '</button>';
    return '<tr data-outside-row="' + id + '"' + (cleared ? ' class="hc-remove-staged"' : '') + '><td class="hc-num">' + esc(camera.number) + '</td><td>' + esc(camera.name) + '</td><td class="hc-outside-tools">' + tools + '</td>' +
      '<td>' + esc(importedCamera(camera) ? remiModelName(camera) : camera.model) + '</td><td class="hc-mono">' + esc(address ?? '') + '</td><td class="hc-mono">' + esc(copy ? '' : camera.port ?? '') + '</td><td>' + esc(copy ? '' : camera.login ?? '') + '</td>' +
      '<td>' + esc(source) + '</td><td>' + status(camera.online) + '</td><td>' + esc(enabled) + '</td></tr>';
  }
  const outsideColumns = [['#', 42], ['Camera name', 160], ['', 132], ['Camera model', 120], ['Camera IP / interface', 150], ['Port', 60], ['Username', 110], ['Source', 200], ['Control', 110], ['Camera Enabled', 120]];
  let paintedOutside = '';
  function paintOutside() {
    const host = root.querySelector('[data-role="outside"]');
    if (!host) return;
    const items = foreignItems().sort((a, b) => (Number(a.camera.number) || 0) - (Number(b.camera.number) || 0) || String(a.camera.name).localeCompare(String(b.camera.name)));
    host.hidden = !items.length || tab !== 'setup';
    const summary = items.length + (items.length === 1 ? ' camera' : ' cameras');
    host.querySelector('[data-role="outside-summary"]').textContent = summary;
    host.querySelector('[data-action="outside-move-all"]').disabled = !items.some(item => !outsideBusy(item) && !outsideCleared(item));
    const clearAll = host.querySelector('[data-action="outside-clear-all"]');
    clearAll.disabled = !items.some(item => !outsideBusy(item) && !outsideCleared(item));
    const markup = '<colgroup>' + outsideColumns.map(([, width]) => '<col style="width:' + width + 'px">').join('') + '</colgroup><thead><tr>' + outsideColumns.map(([label]) => '<th>' + esc(label) + '</th>').join('') + '</tr></thead><tbody>' + items.map(outsideRow).join('') + '</tbody>';
    // Painting it again only when it changed keeps a pressed button under the pointer.
    if (markup === paintedOutside) return;
    paintedOutside = markup;
    host.querySelector('table').innerHTML = markup;
    icons();
  }
  const renderBeforeRig = renderCameras;
  renderCameras = function() { renderBeforeRig(); paintOutside(); };
  // A send that ends can take a row away or free its buttons.
  const paintPendingBeforeRig = paintPendingSends;
  paintPendingSends = function() { paintPendingBeforeRig(); paintOutside(); };
  const setTabBeforeRig = setTab;
  setTab = function(...args) { setTabBeforeRig(...args); paintOutside(); };
  root.addEventListener('click', event => {
    const button = event.target.closest?.('[data-outside-move], [data-outside-clear], [data-action="outside-move-all"], [data-action="outside-clear-all"]');
    if (!button || button.disabled) return;
    const items = foreignItems(), item = id => items.find(entry => entry.id === id);
    if (button.dataset.outsideMove && item(button.dataset.outsideMove)) moveOutside([item(button.dataset.outsideMove)]);
    else if (button.dataset.outsideClear && item(button.dataset.outsideClear)) { const entry = item(button.dataset.outsideClear); clearOutside(entry, !outsideCleared(entry)); }
    else if (button.dataset.action === 'outside-move-all') moveOutside(items);
    else if (button.dataset.action === 'outside-clear-all') for (const entry of items) clearOutside(entry, true);
  });
