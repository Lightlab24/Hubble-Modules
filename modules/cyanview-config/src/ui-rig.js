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
    const known = ownMerge ? null : new Set(cameras);
    mergeBeforeRig(snapshot);
    if (known) for (const camera of cameras) if (!known.has(camera) && camera.elementKey && camera.device === snapshot.device?.id) camera.foreign = true;
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
  function paintForeignReview() {
    const tools = root.querySelector('[data-role="setup-group"] .hc-controller-tools');
    if (!tools) return;
    let button = tools.querySelector('[data-action="review-foreign"]'), note = tools.querySelector('[data-role="foreign-note"]');
    if (!button) {
      (tools.querySelector('.hc-count-hint') ?? tools.querySelector('[data-camera-count]')).insertAdjacentHTML('afterend', '<button type="button" class="hc-primary hc-foreign-review" data-action="review-foreign" hidden></button><span class="hc-caption hc-foreign-note" data-role="foreign-note" hidden></span>');
      button = tools.querySelector('[data-action="review-foreign"]');
      note = tools.querySelector('[data-role="foreign-note"]');
    }
    const count = foreignItems().length;
    button.hidden = note.hidden = !count;
    button.disabled = sendsRunning > 0;
    button.textContent = 'Review ' + count + (count === 1 ? ' item' : ' items');
    note.textContent = count + (count === 1 ? ' thing on this rig wasn’t' : ' things on this rig weren’t') + ' configured by Hubble';
  }
  const renderBeforeRig = renderCameras;
  renderCameras = function() { renderBeforeRig(); paintForeignReview(); };
  // The button waits for a send that is running, so it is painted again when one ends.
  const paintPendingBeforeRig = paintPendingSends;
  paintPendingSends = function() { paintPendingBeforeRig(); paintForeignReview(); };
  function reviewForeign() {
    const items = foreignItems();
    if (!items.length) return;
    const rows = items.map(item => '<div class="hc-change-item hc-review-item"><div class="hc-review-text"><div><strong>' + esc(item.title) + '</strong></div><small>' + esc(item.detail) + '</small></div>' +
      '<div class="hc-segment" role="group" aria-label="' + esc(item.title) + '" data-review-item="' + esc(item.id) + '"><button type="button" data-review-choice="keep" aria-pressed="true">Keep as is</button><button type="button" data-review-choice="clear" aria-pressed="false">Clear</button></div></div>');
    $('modal-layer').innerHTML = '<section class="hc-modal hc-review-modal" role="dialog" aria-modal="true" aria-label="Not configured by Hubble"><div class="hc-modal-head"><div><h3>' + (items.length === 1 ? 'This wasn’t' : 'These weren’t') + ' configured by Hubble</h3><p>' + (items.length === 1 ? 'It is' : 'They are') + ' already on your controllers, so ' + (items.length === 1 ? 'it shows' : 'they show') + ' up here. Nothing has been changed.</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body">' + rows.join('') +
      '<div class="hc-change-item"><small><strong>Keep as is</strong> leaves it exactly as it is and stops asking about it.<br><strong>Clear</strong> deletes it from its controller, along with any REMI copies of it. That can’t be undone from Hubble.</small></div></div>' +
      '<div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Not now</button><button class="hc-primary" data-review-apply>Apply</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  function applyForeignReview(choices) {
    const items = foreignItems().filter(item => choices.has(item.id));
    const kept = items.filter(item => choices.get(item.id) !== 'clear'), clearing = items.filter(item => choices.get(item.id) === 'clear');
    for (const item of kept) for (const row of item.rows) delete row.foreign;
    const said = (cleared, problems) => {
      const parts = [];
      if (kept.length) parts.push('Kept ' + kept.length + (kept.length === 1 ? ' as it is' : ' as they are'));
      if (cleared) parts.push('Cleared ' + cleared);
      toast(problems.length ? problems[0] : parts.join(' · '));
    };
    if (!clearing.length) { renderCameras(); remember(); said(0, []); return; }
    if (!moduleBridge || moduleBridge.preview) { renderCameras(); remember(); toast(sampleRouteMessage); return; }
    return enqueueSend(async () => {
      let cleared = 0;
      const problems = [];
      // A camera goes with its copies, which come off first.
      const own = clearing.filter(item => item.kind === 'camera').map(item => item.camera).filter(camera => cameras.includes(camera));
      if (own.length) {
        try { await removeCameras(own); } catch (error) { problems.push(error.message || 'A camera could not be cleared'); }
        for (const camera of own) {
          if (!cameras.includes(camera)) cleared++;
          else problems.push(routeErrors.get(camera.id) || copyLabel(camera) + ' could not be cleared from ' + controllerName(camera.device) + '.');
        }
      }
      for (const item of clearing.filter(item => item.kind === 'copy')) {
        const copy = item.camera, where = controllerName(copy.device), label = copyLabel(copy);
        if (!cameras.includes(copy)) continue;
        try {
          if (item.source && cameras.includes(item.source)) {
            // The copy comes off, with anything that was made from it.
            const actual = actualRoute(item.source), tree = { ...actual.links }, gone = new Set([copy.device]);
            for (let grew = true; grew;) { grew = false; for (const [receiver, parent] of Object.entries(tree)) if (!gone.has(receiver) && gone.has(parent)) { gone.add(receiver); grew = true; } }
            for (const receiver of gone) delete tree[receiver];
            const result = (await requestRoutes([{ id: item.source.id, camera: item.source.device, key: item.source.elementKey, tree, expected: actual.links, copies: actual.keys }])).results?.[0];
            if (!result?.verified) throw new Error(label + ' could not be cleared from ' + where + ': ' + (result?.error || 'no answer'));
          } else {
            let removed;
            if (copy.remi) removed = await moduleBridge.remiSend({ receiver: copy.device, items: [{ id: 'remove:' + copy.elementKey, kind: 'remove', key: copy.elementKey, enable: false, selector: copy.remi.selector, connection: copy.remi.connection, label: copy.name }] });
            else removed = await moduleBridge.send({ items: [{ kind: 'camera', deleting: true, orphan: true, item: plainRow(copy), fields: [] }] });
            const result = removed.results?.[0];
            if (!result || result.error) throw new Error(label + ' could not be cleared from ' + where + ': ' + (result?.error || 'no answer'));
            cameras = cameras.filter(camera => camera !== copy);
            if (removed.snapshot) mergeOwn(removed.snapshot);
          }
          cleared++;
        } catch (error) { problems.push(error.message || label + ' could not be cleared'); }
      }
      routeTreeMemo = null;
      renderCameras();
      remember();
      said(cleared, problems);
    }).finally(paintForeignReview);
  }
  root.addEventListener('click', event => {
    const target = event.target.closest?.('[data-action="review-foreign"], [data-review-choice], [data-review-apply]');
    if (!target) return;
    if (target.dataset.action === 'review-foreign') { reviewForeign(); return; }
    if (target.dataset.reviewChoice) {
      for (const button of target.parentElement.querySelectorAll('[data-review-choice]')) button.setAttribute('aria-pressed', String(button === target));
      return;
    }
    const choices = new Map([...$('modal-layer').querySelectorAll('[data-review-item]')].map(group => [group.dataset.reviewItem, group.querySelector('[aria-pressed="true"]')?.dataset.reviewChoice || 'keep']));
    $('modal-layer').hidden = true;
    void applyForeignReview(choices);
  });
