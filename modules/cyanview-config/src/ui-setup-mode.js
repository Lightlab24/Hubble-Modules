  // ── Setup mode ─────────────────────────────────────────────────────────────
  // While it is on, every RCP added to the list is cleared so it can be set up again: its LAN addresses
  // deleted, its WAN left Static with no address, and its cameras deleted, as the band's ticks say. RIOs
  // are left alone, since a RIO reaches its IP cameras through its LAN address, and so is every RCP's own
  // base address, which the clear goes over. RCPs already in the list are cleared from a review.
  // It starts off each time the page opens and is never saved, so a workspace opened or imported later
  // can't clear anything by itself (asked for Nov 21, 2026).
  let setupMode = false;
  const setupChoices = { lans: true, wan: true, cameras: true };
  // Each RCP cleared or being cleared while this page is open: { phase: 'cameras' | 'network' | 'cleared' | 'failed', error }.
  const setupClears = new Map();
  // What the worker says of each network clear under way: { done, total }.
  let networkClears = {};
  const isRcp = d => d?.kind === 'RCP' || /^CY-RCP-/i.test(String(d?.serial ?? ''));
  const setupClearRunning = id => ['cameras', 'network'].includes(setupClears.get(id)?.phase);
  const anySetupChoice = () => setupChoices.lans || setupChoices.wan || setupChoices.cameras;
  const insideFactoryNetwork = value => plainAddress(value).startsWith('10.192.');

  function initializeSetupMode() {
    root.querySelector('.hc-send-control')?.insertAdjacentHTML('beforebegin', '<div class="hc-send-control hc-setup-mode-control"><span class="hc-muted">Setup mode</span><div class="hc-segment" role="group" aria-label="Setup mode">' +
      '<button data-action="setup-mode" data-mode="off" aria-pressed="true">Off</button><button data-action="setup-mode" data-mode="on" aria-pressed="false">On</button></div></div>');
    const choice = (key, label) => '<label class="hc-setup-choice"><input type="checkbox" data-setup-choice="' + key + '" checked>' + esc(label) + '</label>';
    root.querySelector('#hc-devices')?.insertAdjacentHTML('afterbegin', '<div class="hc-setup-band" data-role="setup-band" role="region" aria-label="Setup mode" hidden>' +
      '<strong>Setup mode</strong><span data-role="setup-band-text">Every RCP you add is cleared as soon as Hubble reaches it:</span>' +
      choice('lans', 'Delete its LAN addresses') + choice('wan', 'WAN to Static, no address') + choice('cameras', 'Delete every camera') +
      '<span class="hc-setup-note">RIOs, and each RCP’s 10.192 address, are never touched. Nothing joins the list by itself while this is on.</span><span class="hc-right"></span>' +
      '<button class="hc-button" data-action="review-setup-clear">Clear the RCPs already here…</button></div>');
    syncSetupMode();
  }
  function syncSetupMode() {
    for (const button of root.querySelectorAll('[data-action="setup-mode"]')) button.setAttribute('aria-pressed', String((button.dataset.mode === 'on') === setupMode));
    const band = $('setup-band');
    if (!band) return;
    band.hidden = !setupMode;
    $('setup-band-text').textContent = anySetupChoice() ? 'Every RCP you add is cleared as soon as Hubble reaches it:' : 'Nothing is ticked, so RCPs you add are left as they are:';
    action('review-setup-clear').disabled = !anySetupChoice();
  }

  // A clear runs the camera part the way Clear all does, then the network part in the worker.
  async function clearForSetup(id, choices = { ...setupChoices }) {
    const d = device(id);
    if (!d || !isRcp(d) || setupClearRunning(id)) return;
    if (!moduleBridge || moduleBridge.preview) { toast('Setup mode clears RCPs only when Hubble is connected to them'); return; }
    if (!choices.lans && !choices.wan && !choices.cameras) return;
    const step = phase => { setupClears.set(id, { phase }); renderLans(); };
    // Each tick is its own job. Cameras that couldn't be deleted used to stop the addresses from being
    // cleared at all (Nov 23, 2026), so what goes wrong with one part is kept and the next still runs.
    const problems = [];
    try {
      if (choices.cameras && cameras.some(camera => camera.device === id)) {
        step('cameras');
        try { await clearDeviceCameras(id); } catch (error) { problems.push(error?.message || 'its cameras could not be deleted'); }
        const left = cameras.filter(camera => camera.device === id).length;
        if (left && !problems.length) problems.push(left + (left === 1 ? ' camera is' : ' cameras are') + ' still on it');
      }
      if (choices.lans || choices.wan) {
        // Unsent address changes are about addresses that are going, so they go too.
        for (const row of lans.filter(row => row.device === id && row.pending && !row.jobs && (row.type === 'WAN' ? choices.wan : choices.lans))) cancelLanDrafts(id, row.id);
        step('network');
        try {
          const result = await moduleBridge.clearNetwork(id, choices.lans, choices.wan);
          if (result.snapshot && device(id)) mergeOwn(result.snapshot);
          // Said with whatever went wrong before it, so "Not cleared" doesn't read as nothing done.
          if (problems.length) problems.push('its addresses were cleared');
        } catch (error) { problems.push(error?.message || 'its addresses could not be cleared'); }
      }
      if (problems.length) throw new Error(problems.join('; '));
      setupClears.set(id, { phase: 'cleared' });
      toast((device(id)?.name || d.name) + ' cleared for setup');
    } catch (error) {
      const reason = error?.message || 'it could not be cleared';
      setupClears.set(id, { phase: 'failed', error: reason });
      toast((device(id)?.name || d.name) + ': ' + reason);
    } finally {
      delete networkClears[id];
      routeTreeMemo = null;
      renderLans();
      renderCameras();
      syncSetupMode();
      remember();
    }
  }

  // RCPs added while Setup mode is on are cleared once they are in the list. Nothing else is added meanwhile:
  // the search for the rest of a rig used to bring the other RCPs in by itself right after the first was added,
  // and those were never cleared, though to whoever was adding them they had been added in Setup mode (Nov 23, 2026).
  // It looks again after the next Refresh all or add once Setup mode is off.
  const findRigBeforeSetup = findRig;
  findRig = async function() { if (!setupMode) return findRigBeforeSetup(); };
  const addBeforeSetup = addLiveResults;
  addLiveResults = async function() {
    const before = new Set(devices.map(d => d.id));
    await addBeforeSetup();
    syncSetupMode();
    if (!setupMode || !anySetupChoice()) return;
    const added = devices.filter(d => !before.has(d.id) && isRcp(d)).map(d => d.id);
    await Promise.all(added.map(id => clearForSetup(id)));
  };

  // The review for RCPs already in the list: each one, and what it will lose.
  function setupReviewLines(d) {
    const net = deviceNetwork(d), lines = [];
    if (setupChoices.lans) {
      const blanks = net.lan.filter(row => row.elementKey && row.blank).length;
      const addresses = [...net.lan.filter(row => row.elementKey && row.current).map(row => row.current), ...(blanks ? [blanks + (blanks === 1 ? ' blank entry' : ' blank entries')] : [])];
      lines.push('LAN: ' + (addresses.length ? 'deletes ' + esc(addresses.length === 1 ? addresses[0] : addresses.slice(0, -1).join(', ') + ' and ' + addresses.at(-1)) : 'none to delete'));
    }
    if (setupChoices.wan) {
      const wan = net.wan;
      const now = !wan ? '' : wan.current === 'DHCP' || wan.dhcp && !wan.current ? 'DHCP' : wan.current;
      const blank = wan && !now && !wan.gateway && !wan.dns1 && !wan.dns2;
      lines.push('WAN: ' + (!wan ? 'none on this RCP' : blank ? 'already Static with no address' :
        (insideFactoryNetwork(now) ? '<span class="hc-setup-inside">' + esc(now) + '</span> (inside the factory network)' : esc(now || 'Static')) + ' → Static, no address'));
    }
    if (setupChoices.cameras) {
      const rows = cameras.filter(camera => camera.device === d.id), copies = rows.filter(importedCamera).length;
      lines.push('Cameras: ' + (!rows.length ? 'none' : 'deletes ' + rows.length + (copies === rows.length ? (copies === 1 ? ' REMI copy' : ' REMI copies') + '. The cameras they copy stay where they are.' : copies ? ', ' + copies + (copies === 1 ? ' of them a REMI copy' : ' of them REMI copies') : '')));
    }
    if (d.online === false) lines.push('<span class="hc-error-text">' + esc(d.name) + ' reads Offline, so it will probably be skipped.</span>');
    return lines;
  }
  function reviewSetupClear() {
    const rcps = orderedDevices().filter(isRcp), cleared = rcps.filter(d => setupClears.get(d.id)?.phase === 'cleared'), listed = rcps.filter(d => !cleared.includes(d));
    const others = devices.filter(d => !isRcp(d));
    const names = list => list.length === 1 ? list[0].name : list.slice(0, -1).map(d => d.name).join(', ') + ' and ' + list.at(-1).name;
    const items = listed.map(d => {
      const busy = deviceBusy(d.id);
      return '<div class="hc-change-item hc-setup-review-item"><input type="checkbox" data-setup-review="' + esc(d.id) + '" aria-label="' + esc('Clear ' + d.name) + '"' + (busy ? ' disabled' : ' checked') + '>' +
        '<div class="hc-setup-review-lines"><div><strong>' + esc(d.name) + '</strong> <span class="hc-mono hc-muted">' + esc(d.serial + ' · ' + d.base) + '</span></div>' +
        setupReviewLines(d).map(line => '<small>' + line + '</small>').join('') + (busy ? '<small class="hc-muted">Busy with a send, so it is left out.</small>' : '') + '</div></div>';
    });
    const notes = [];
    if (cleared.length) notes.push(esc(names(cleared)) + (cleared.length === 1 ? ' is' : ' are') + ' already cleared.');
    if (others.length) notes.push('RIOs and Gateways aren’t cleared, so ' + (others.length === 1 ? esc(others[0].name) + ' isn’t' : 'they aren’t') + ' listed.');
    if (notes.length) items.push('<div class="hc-change-item"><small>' + notes.join(' ') + '</small></div>');
    if (listed.length) items.push('<div class="hc-change-item"><small>An RCP that doesn’t answer on its 10.192 address is skipped, and nothing on it changes. This can’t be undone from Hubble.</small></div>');
    else items.unshift('<div class="hc-change-item"><strong>There are no RCPs left to clear</strong></div>');
    $('modal-layer').innerHTML = '<section class="hc-modal hc-setup-review" role="dialog" aria-modal="true" aria-label="Clear the RCPs already here"><div class="hc-modal-head"><div><h3>Clear the RCPs already here?</h3><p>Each one is cleared over its 10.192 address, which stays.</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body">' + items.join('') + '</div><div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button>' +
      (listed.length ? '<button class="hc-danger hc-danger-solid" data-action="confirm-setup-clear"></button>' : '') + '</div></section>';
    $('modal-layer').hidden = false;
    icons();
    syncSetupReview();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  function syncSetupReview() {
    const confirm = $('modal-layer').querySelector('[data-action="confirm-setup-clear"]');
    if (!confirm) return;
    const count = $('modal-layer').querySelectorAll('[data-setup-review]:checked').length;
    confirm.textContent = 'Clear ' + count + (count === 1 ? ' RCP' : ' RCPs');
    confirm.disabled = !count;
  }
  function confirmSetupClear() {
    const ids = [...$('modal-layer').querySelectorAll('[data-setup-review]:checked')].map(box => box.dataset.setupReview);
    $('modal-layer').hidden = true;
    void Promise.all(ids.map(id => clearForSetup(id)));
  }

  // The Sync column says where a clear is, and that it is done until something else is sent.
  const syncMarkupBeforeSetup = deviceSyncMarkup;
  deviceSyncMarkup = function(d) {
    const clear = setupClears.get(d.id);
    if (!clear) return syncMarkupBeforeSetup(d);
    const mark = (kind, text, title) => '<span class="hc-status hc-setup-' + kind + '" title="' + esc(title) + '">' + esc(text) + '</span>';
    if (clear.phase === 'cameras') return mark('running', 'Clearing…', 'Deleting its cameras');
    if (clear.phase === 'network') {
      const progress = networkClears[d.id];
      return progress?.total ? mark('running', 'Clearing ' + Math.min(progress.done + 1, progress.total) + '/' + progress.total, 'Clearing its addresses: ' + progress.done + ' of ' + progress.total + ' done') : mark('running', 'Clearing…', 'Clearing its addresses');
    }
    if (clear.phase === 'failed') return mark('failed', 'Not cleared', clear.error || 'It could not be cleared');
    return deviceSyncText(d) === 'In sync' ? mark('done', 'Cleared', 'Cleared for setup') : syncMarkupBeforeSetup(d);
  };
  const busyBeforeSetup = deviceBusy;
  deviceBusy = function(id) { return busyBeforeSetup(id) || setupClearRunning(id); };
  const liveStateBeforeSetup = applyLiveState;
  applyLiveState = function(values) {
    if (values?.networkClears && typeof values.networkClears === 'object') { networkClears = values.networkClears; paintDeviceSheet(); }
    return liveStateBeforeSetup(values);
  };
  // A device taken out of the list forgets how its clear went.
  const removeBeforeSetup = removeManagedDevice;
  removeManagedDevice = function(id) { removeBeforeSetup(id); if (!device(id)) setupClears.delete(id); syncSetupMode(); };
  const initializeBeforeSetup = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() { initializeBeforeSetup(); initializeSetupMode(); };

  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.action === 'setup-mode') {
      const on = data.mode === 'on';
      if (on === setupMode) return;
      setupMode = on;
      syncSetupMode();
      toast(on ? 'Setup mode on · RCPs you add are cleared' : 'Setup mode off');
    }
    else if (data.action === 'review-setup-clear') reviewSetupClear();
    else if (data.action === 'confirm-setup-clear') confirmSetupClear();
  });
  root.addEventListener('change', event => {
    const element = event.target;
    if (element.dataset?.setupChoice) { setupChoices[element.dataset.setupChoice] = element.checked; syncSetupMode(); }
    else if (element.dataset?.setupReview) syncSetupReview();
  });
