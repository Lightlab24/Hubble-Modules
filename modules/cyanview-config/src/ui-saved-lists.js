  // Saved devices, kept with the workspace's configuration so they go into its exports. They hold every
  // controller ever added. Discover checks the ones that aren't in the list before anything else and lists
  // them straight away. Camera logins moved to the Defaults tab in 0.1.105 (ui-defaults.js).
  let savedDevices = null, savedScan = null, savedPopover = null;
  const savedKey = serial => String(serial ?? '').toUpperCase();
  const savedSerial = serial => /^CY-[A-Z0-9-]+$/i.test(String(serial ?? '')) && String(serial).length <= 64;
  const shortText = value => String(value ?? '').slice(0, 160);

  function restoreSavedLists(plan) {
    // A workspace saved before Saved devices existed starts from the devices in it.
    savedDevices = Array.isArray(plan?.savedDevices) ? plan.savedDevices.filter(item => savedSerial(item.serial)).map(item => ({ serial: item.serial, kind: item.kind, base: item.base, address: item.address })) : null;
  }
  // Every device in the list is on the saved list, by serial, with its addresses. Its name isn't
  // kept: a device is named for the job it is on, and that changes from one job to the next.
  function savedDeviceList() {
    const list = (savedDevices ?? []).filter(item => savedSerial(item.serial)).map(item => ({ ...item }));
    for (const d of devices) {
      if (!savedSerial(d.serial)) continue;
      const entry = { serial: String(d.serial), kind: String(d.kind || '').slice(0, 32), base: ipv4(d.base || '') ? d.base : '', address: ipv4(d.address || '') ? d.address : '' };
      if (!entry.base && !entry.address) continue;
      const at = list.findIndex(item => savedKey(item.serial) === savedKey(d.serial));
      if (at >= 0) list[at] = entry; else list.push(entry);
    }
    const managed = new Set(devices.map(d => savedKey(d.serial)));
    while (list.length > 256) { const oldest = list.findIndex(item => !managed.has(savedKey(item.serial))); if (oldest < 0) break; list.splice(oldest, 1); }
    savedDevices = list;
    return list.map(item => ({ serial: item.serial, kind: item.kind, base: item.base, address: item.address }));
  }
  const savedNotInList = () => savedDeviceList().filter(item => !devices.some(d => savedKey(d.serial) === savedKey(item.serial)));

  // ----- Saved devices -----
  function savedDevicesButton() {
    return '<button type="button" class="hc-button hc-saved-devices-button" data-action="toggle-saved-devices" aria-haspopup="dialog" aria-expanded="false">' + icon('bookmark') + 'Saved devices<span class="hc-list-count" data-saved-devices-count></span></button>';
  }
  function paintSavedDevicesButton() {
    const count = savedDeviceList().length;
    for (const badge of root.querySelectorAll('[data-saved-devices-count]')) { badge.textContent = count ? String(count) : ''; badge.hidden = !count; }
  }
  function savedDevicesMarkup() {
    const managed = new Set(devices.map(d => savedKey(d.serial)));
    const checks = new Map(savedSearchRows().map(row => [savedKey(row.item.serial), row]));
    const checkText = row => !row ? '' : row.candidate ? 'Found · add it on the sheet' : { checking: 'Checking…', missing: 'Didn’t answer', found: 'Found' }[row.state] ?? '';
    const rows = savedDeviceList().map(item => {
      const inList = managed.has(savedKey(item.serial)), name = item.serial, check = inList ? null : checks.get(savedKey(item.serial));
      return '<tr data-saved-device="' + esc(item.serial) + '"' + (check ? ' data-saved-state="' + esc(check.candidate ? 'found' : check.state) + '"' : '') + '><td class="hc-mono">' + esc(item.serial) + '</td><td class="hc-muted">' + esc(item.kind) + '</td><td class="hc-mono hc-muted">' + esc(item.address || item.base) + '</td>' +
        '<td class="hc-muted" data-saved-check>' + (inList ? 'In this sheet' : esc(checkText(check))) + '</td>' +
        '<td class="hc-list-remove"><button type="button" class="hc-row-remove-button" data-action="forget-saved-device" data-serial="' + esc(item.serial) + '" aria-label="Forget ' + esc(name) + '" title="' + (inList ? 'Remove ' + esc(name) + ' from the sheet first' : 'Forget ' + esc(name) + '. Nothing changes on the device.') + '"' + (inList ? ' disabled' : '') + '>' + icon('trash-2') + '</button></td></tr>';
    }).join('');
    return '<header><h3 id="hc-saved-devices-title">Saved devices</h3><button type="button" class="hc-list-close" data-action="close-list-popover" aria-label="Close">' + icon('x') + '</button></header>' +
      '<p>Every device you add is saved here by its serial. Discover checks these first, whichever network you pick. One that answers is listed on the sheet to add; one that doesn’t stays here.</p>' +
      (rows ? '<table class="hc-list-table"><thead><tr><th>Serial</th><th>Type</th><th>Address</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="hc-list-empty">No saved devices yet. Every device you add is saved here.</div>') +
      '<footer class="hc-caption">Forget removes a device from this list only. Nothing changes on the device.</footer>';
  }
  function forgetSavedDevice(serial) {
    if (devices.some(d => savedKey(d.serial) === savedKey(serial))) return;
    savedDevices = savedDeviceList().filter(item => savedKey(item.serial) !== savedKey(serial));
    renderSavedPopover();
    renderDeviceSheet();
    paintSavedDevicesButton();
    remember();
  }
  // The saved devices a search lists first, each with how its check went.
  function savedSearchRows() {
    if (!savedScan) return [];
    return savedNotInList().map(item => {
      const candidate = results.find(found => savedKey(found.serial) === savedKey(item.serial));
      const reported = savedScan.checks.get(savedKey(item.serial));
      const state = candidate ? 'found' : reported === 'missing' ? 'missing' : savedScan.state === 'scanning' ? 'checking' : reported === 'found' ? 'found' : 'unchecked';
      return { item, candidate, state };
    });
  }
  function savedSearchRowMarkup({ item, candidate, state }, span) {
    // A saved device that answers shows the name it has now.
    const name = candidate?.name || item.serial, address = candidate ? candidate.base || candidate.address : item.address || item.base;
    const status = state === 'found' ? '<span class="hc-found-tag">Found</span>' : '<span class="hc-muted">' + (state === 'checking' ? 'Checking…' : state === 'missing' ? 'Not found' : 'Not checked') + '</span>';
    const last = state === 'found' && candidate ? '<button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(candidate.id) + '" aria-label="Add ' + esc(name) + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button>'
      : state === 'missing' ? '<span class="hc-muted">Didn’t answer · stays on the saved list</span>' : '';
    return '<tr class="hc-device-found hc-device-saved" data-device-found="' + esc(candidate?.id ?? item.serial) + '" data-device-saved="' + esc(item.serial) + '" data-saved-state="' + state + '"><td><span class="hc-muted" title="Saved device">' + icon('bookmark') + '</span></td><td>' + (candidate ? esc(name) : '<span class="hc-muted">Saved device</span>') + '</td><td></td><td><span class="hc-muted">' + esc(item.kind) + '</span></td><td><span class="hc-mono hc-muted">' + esc(item.serial) + '</span></td><td>' + status + '</td><td><span class="hc-mono hc-muted">' + esc(address) + '</span></td><td colspan="' + span + '">' + last + '</td></tr>';
  }
  const startLiveScanBeforeSaved = startLiveScan;
  startLiveScan = function() {
    const range = $('scan-range').value === 'custom' ? $('custom-range').value.trim() : $('scan-range').value;
    // Saved devices says Checking at once, before the first word back from the search.
    if (range) { savedScan = { id: '', state: 'scanning', checks: new Map() }; renderSavedPopover(); }
    return startLiveScanBeforeSaved();
  };
  const applyLiveStateBeforeSaved = applyLiveState;
  applyLiveState = function(values) {
    const scan = values?.discovery;
    let changed = false;
    if (scan && Array.isArray(scan.saved)) {
      const next = { id: scan.id, state: scan.state, checks: new Map(scan.saved.map(item => [savedKey(item.serial), item.state])) };
      changed = JSON.stringify([savedScan?.id, savedScan?.state, [...(savedScan?.checks ?? [])]]) !== JSON.stringify([next.id, next.state, [...next.checks]]);
      savedScan = next;
    }
    const applied = applyLiveStateBeforeSaved(values);
    // Saved devices, open, says how each check is going.
    if (changed) renderSavedPopover();
    return applied;
  };

  // ----- The Saved devices pop-up -----
  function renderSavedPopover() {
    if (!savedPopover || savedPopover.hidden) return;
    const focused = document.activeElement, key = focused?.closest?.('.hc-list-popover') && focused.dataset.action ? focused.dataset.action : '';
    savedPopover.innerHTML = savedDevicesMarkup();
    savedPopover.setAttribute('aria-labelledby', 'hc-saved-devices-title');
    icons();
    placeSavedPopover();
    if (key) savedPopover.querySelector('[data-action="' + key + '"]')?.focus({ preventScroll: true });
  }
  function placeSavedPopover() {
    const anchor = root.querySelector('[data-action="toggle-saved-devices"]');
    if (!anchor) return;
    const box = anchor.getBoundingClientRect(), width = savedPopover.offsetWidth;
    savedPopover.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + 'px';
    savedPopover.style.top = (box.bottom + 6) + 'px';
    savedPopover.style.maxHeight = Math.max(160, window.innerHeight - box.bottom - 18) + 'px';
  }
  function openSavedPopover(kind) {
    if (!savedPopover) {
      savedPopover = document.createElement('section');
      savedPopover.className = 'hc-list-popover';
      savedPopover.setAttribute('role', 'dialog');
      root.append(savedPopover);
    }
    const reopening = !savedPopover.hidden && savedPopover.dataset.list === kind;
    closeSavedPopover();
    if (reopening) return;
    savedPopover.dataset.list = kind;
    savedPopover.dataset.role = 'saved-devices';
    savedPopover.hidden = false;
    for (const button of root.querySelectorAll('[data-action="toggle-saved-devices"]')) button.setAttribute('aria-expanded', 'true');
    renderSavedPopover();
    savedPopover.querySelector('[data-action="close-list-popover"]')?.focus({ preventScroll: true });
  }
  function closeSavedPopover(returnFocus = false) {
    if (!savedPopover || savedPopover.hidden) return;
    savedPopover.hidden = true;
    const button = root.querySelector('[data-action="toggle-saved-devices"]');
    for (const toggle of root.querySelectorAll('[data-action="toggle-saved-devices"]')) toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) button?.focus({ preventScroll: true });
  }
  const initializeBeforeSavedLists = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() {
    initializeBeforeSavedLists();
    action('stop-scan')?.insertAdjacentHTML('afterend', savedDevicesButton());
    paintSavedDevicesButton();
    icons();
  };
  const renderLansBeforeSavedLists = renderLans;
  // Live updates redraw the sheet often, so the device list follows them.
  renderLans = function(...args) { const drawn = renderLansBeforeSavedLists(...args); paintSavedDevicesButton(); if (savedPopover?.dataset.list === 'devices') renderSavedPopover(); return drawn; };

  root.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    const action = button?.dataset.action;
    if (action === 'toggle-saved-devices') { openSavedPopover('devices'); return; }
    if (action === 'close-list-popover') { closeSavedPopover(true); return; }
    if (action === 'forget-saved-device') { forgetSavedDevice(button.dataset.serial); return; }
    // A click anywhere else puts the list away. Hubble's own pop-up lists sit outside it.
    if (savedPopover && !savedPopover.hidden && !event.target.closest?.('.hc-list-popover, .hc-dropdown-menu')) closeSavedPopover();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && savedPopover && !savedPopover.hidden && !document.querySelector('.hc-dropdown-menu')) { event.preventDefault(); closeSavedPopover(true); }
  });
  window.addEventListener('resize', () => { if (savedPopover && !savedPopover.hidden) placeSavedPopover(); });
  root.addEventListener('scroll', () => { if (savedPopover && !savedPopover.hidden) placeSavedPopover(); }, true);
