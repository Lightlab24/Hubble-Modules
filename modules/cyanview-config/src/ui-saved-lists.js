  // Camera logins and Saved devices. Both are kept with the workspace's configuration, so they go into
  // its exports. Camera logins fill a camera's Username and Password when it is added or its model
  // changes; anything typed afterwards wins. Saved devices hold every controller ever added. Discover
  // checks the ones that aren't in the list before anything else and lists them straight away.
  let cameraLogins = [], savedDevices = null, savedScan = null, savedPopover = null;
  const savedKey = serial => String(serial ?? '').toUpperCase();
  const savedSerial = serial => /^CY-[A-Z0-9-]+$/i.test(String(serial ?? '')) && String(serial).length <= 64;
  const shortText = value => String(value ?? '').slice(0, 160);

  function restoreSavedLists(plan) {
    cameraLogins = Array.isArray(plan?.cameraLogins) ? plan.cameraLogins.map(item => ({ model: shortText(item.model), login: shortText(item.login), password: shortText(item.password) })) : [];
    // A workspace saved before Saved devices existed starts from the devices in it.
    savedDevices = Array.isArray(plan?.savedDevices) ? plan.savedDevices.filter(item => savedSerial(item.serial)).map(item => ({ serial: item.serial, kind: item.kind, base: item.base, address: item.address })) : null;
    // The buttons are drawn before the workspace is read; Saved devices repaints once its devices are in.
    paintCameraLoginsButton();
  }
  function savedCameraLogins() { return cameraLogins.slice(0, 128).map(item => ({ model: item.model, login: item.login, password: item.password })); }
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

  // ----- Camera logins -----
  function cameraLoginFor(model) {
    const key = String(model ?? '');
    return key && key !== 'Choose model…' ? cameraLogins.find(item => item.model === key) ?? null : null;
  }
  /** Fills a camera's Username and Password from Camera logins. A USB camera has neither. */
  function applyCameraLogin(camera, fields) {
    if (!camera || camera.model === 'Alpha-USB') return false;
    const login = cameraLoginFor(camera.model);
    if (!login) return false;
    for (const field of ['login', 'password']) {
      camera[field] = login[field];
      camera.dirty?.add(field);
      if (fields && !fields.includes(field)) fields.push(field);
    }
    return true;
  }
  // Typing, picking from the list, paste and fill all stage a model through here.
  const stageCellBeforeLogins = stageCell;
  stageCell = function(item, field, value, isLan) {
    const fields = stageCellBeforeLogins(item, field, value, isLan);
    if (!isLan && field === 'model' && fields.length) applyCameraLogin(item, fields);
    return fields;
  };
  function cameraLoginsButton() {
    return '<button type="button" class="hc-button hc-logins-button" data-action="toggle-camera-logins" aria-haspopup="dialog" aria-expanded="false">' + icon('key-round') + 'Camera logins<span class="hc-list-count" data-camera-logins-count></span></button>';
  }
  function paintCameraLoginsButton() {
    const count = cameraLogins.filter(item => item.model).length;
    for (const badge of root.querySelectorAll('[data-camera-logins-count]')) { badge.textContent = count ? String(count) : ''; badge.hidden = !count; }
  }
  function cameraLoginModelOptions(current) {
    const taken = new Set(cameraLogins.map(item => item.model).filter(model => model && model !== current));
    const groups = new Map();
    for (const option of everyModelChoice()) {
      if (option.value === 'Alpha-USB' || taken.has(option.value)) continue;
      const group = option.group ?? '';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    }
    if (current && ![...groups.values()].flat().some(option => option.value === current)) groups.set('', [{ value: current, label: current }, ...(groups.get('') ?? [])]);
    let markup = '<option value=""' + (current ? '' : ' selected') + '>Choose a model…</option>';
    for (const [group, options] of groups) {
      const items = options.map(option => '<option value="' + esc(option.value) + '"' + (option.value === current ? ' selected' : '') + '>' + esc(option.label) + '</option>').join('');
      markup += group ? '<optgroup label="' + esc(group) + '">' + items + '</optgroup>' : items;
    }
    return markup;
  }
  function cameraLoginsMarkup() {
    const rows = cameraLogins.map((item, index) => '<tr data-login-row="' + index + '">' +
      '<td><select class="hc-cell-input" data-login-field="model" data-login-index="' + index + '" aria-label="Camera model for login ' + (index + 1) + '">' + cameraLoginModelOptions(item.model) + '</select></td>' +
      '<td><input class="hc-cell-input" data-login-field="login" data-login-index="' + index + '" value="' + esc(item.login) + '" maxlength="160" aria-label="Username for ' + esc(item.model || 'login ' + (index + 1)) + '" spellcheck="false" autocomplete="off"></td>' +
      '<td><input class="hc-cell-input" data-login-field="password" data-login-index="' + index + '" value="' + esc(item.password) + '" maxlength="160" aria-label="Password for ' + esc(item.model || 'login ' + (index + 1)) + '" spellcheck="false" autocomplete="off"></td>' +
      '<td class="hc-list-remove"><button type="button" class="hc-row-remove-button" data-action="remove-camera-login" data-login-index="' + index + '" aria-label="Remove the login for ' + esc(item.model || 'login ' + (index + 1)) + '" title="Remove this login. Cameras already set up keep theirs.">' + icon('trash-2') + '</button></td></tr>').join('');
    return '<header><h3 id="hc-camera-logins-title">Camera logins</h3><button type="button" class="hc-list-close" data-action="close-list-popover" aria-label="Close">' + icon('x') + '</button></header>' +
      '<p>Filled into Username and Password when you add a camera or change its model. You can still type over them on any camera.</p>' +
      (rows ? '<table class="hc-list-table"><thead><tr><th style="width:44%">Camera model</th><th>Username</th><th>Password</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="hc-list-empty">No logins yet. Add a camera model to fill its Username and Password in.</div>') +
      '<footer><button type="button" class="hc-button" data-action="add-camera-login"' + (cameraLogins.length >= 128 ? ' disabled' : '') + '>' + icon('plus') + 'Add a camera model</button></footer>';
  }

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
    const rows = savedDeviceList().map(item => {
      const inList = managed.has(savedKey(item.serial)), name = item.serial;
      return '<tr data-saved-device="' + esc(item.serial) + '"><td class="hc-mono">' + esc(item.serial) + '</td><td class="hc-muted">' + esc(item.kind) + '</td><td class="hc-mono hc-muted">' + esc(item.address || item.base) + '</td>' +
        '<td class="hc-muted">' + (inList ? 'In this sheet' : '') + '</td>' +
        '<td class="hc-list-remove"><button type="button" class="hc-row-remove-button" data-action="forget-saved-device" data-serial="' + esc(item.serial) + '" aria-label="Forget ' + esc(name) + '" title="' + (inList ? 'Remove ' + esc(name) + ' from the sheet first' : 'Forget ' + esc(name) + '. Nothing changes on the device.') + '"' + (inList ? ' disabled' : '') + '>' + icon('trash-2') + '</button></td></tr>';
    }).join('');
    return '<header><h3 id="hc-saved-devices-title">Saved devices</h3><button type="button" class="hc-list-close" data-action="close-list-popover" aria-label="Close">' + icon('x') + '</button></header>' +
      '<p>Every device you add is saved here by its serial. Discover checks these first, whichever network you pick, and lists the ones that aren’t in the sheet straight away.</p>' +
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
    // The saved devices show at once, before the first word back from the search.
    if (range) savedScan = { id: '', state: 'scanning', checks: new Map() };
    return startLiveScanBeforeSaved();
  };
  const applyLiveStateBeforeSaved = applyLiveState;
  applyLiveState = function(values) {
    const scan = values?.discovery;
    if (scan && Array.isArray(scan.saved)) savedScan = { id: scan.id, state: scan.state, checks: new Map(scan.saved.map(item => [savedKey(item.serial), item.state])) };
    return applyLiveStateBeforeSaved(values);
  };

  // ----- The pop-up the two lists share -----
  function renderSavedPopover() {
    if (!savedPopover || savedPopover.hidden) return;
    const kind = savedPopover.dataset.list, focused = document.activeElement, key = focused?.closest?.('.hc-list-popover') ? (focused.dataset.loginField ? focused.dataset.loginField + ':' + focused.dataset.loginIndex : focused.dataset.action ? 'action:' + focused.dataset.action : '') : '';
    savedPopover.innerHTML = kind === 'logins' ? cameraLoginsMarkup() : savedDevicesMarkup();
    upgradeSelects(savedPopover);
    savedPopover.setAttribute('aria-labelledby', kind === 'logins' ? 'hc-camera-logins-title' : 'hc-saved-devices-title');
    icons();
    placeSavedPopover();
    if (key) {
      const [kindOf, value] = key.split(':');
      const element = kindOf === 'action' ? savedPopover.querySelector('[data-action="' + value + '"]') : savedPopover.querySelector('[data-login-field="' + kindOf + '"][data-login-index="' + value + '"]');
      element?.focus({ preventScroll: true });
    }
  }
  function placeSavedPopover() {
    const anchor = root.querySelector(savedPopover.dataset.list === 'logins' ? '[data-action="toggle-camera-logins"]:not([hidden])' : '[data-action="toggle-saved-devices"]');
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
    savedPopover.dataset.role = kind === 'logins' ? 'camera-logins' : 'saved-devices';
    savedPopover.hidden = false;
    for (const button of root.querySelectorAll(kind === 'logins' ? '[data-action="toggle-camera-logins"]' : '[data-action="toggle-saved-devices"]')) button.setAttribute('aria-expanded', 'true');
    renderSavedPopover();
    savedPopover.querySelector(kind === 'logins' ? 'select, input, [data-action="add-camera-login"]' : '[data-action="close-list-popover"]')?.focus({ preventScroll: true });
  }
  function closeSavedPopover(returnFocus = false) {
    if (!savedPopover || savedPopover.hidden) return;
    const kind = savedPopover.dataset.list;
    savedPopover.hidden = true;
    const button = root.querySelector(kind === 'logins' ? '[data-action="toggle-camera-logins"]' : '[data-action="toggle-saved-devices"]');
    for (const toggle of root.querySelectorAll('[data-action="toggle-camera-logins"],[data-action="toggle-saved-devices"]')) toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) button?.focus({ preventScroll: true });
  }
  function commitCameraLogin(element) {
    const item = cameraLogins[Number(element.dataset.loginIndex)];
    if (!item) return;
    const field = element.dataset.loginField, value = shortText(element.value);
    if (item[field] === value) return;
    item[field] = value;
    if (field === 'model') renderSavedPopover();
    paintCameraLoginsButton();
    remember();
  }

  const initializeBeforeSavedLists = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() {
    initializeBeforeSavedLists();
    action('stop-scan')?.insertAdjacentHTML('afterend', savedDevicesButton());
    root.querySelector('[data-role="setup-group"] .hc-count-hint')?.insertAdjacentHTML('afterend', cameraLoginsButton());
    paintSavedDevicesButton();
    paintCameraLoginsButton();
    icons();
  };
  const renderLansBeforeSavedLists = renderLans;
  // Live updates redraw the sheet often, so only the device list follows them; a login being typed is left alone.
  renderLans = function(...args) { const drawn = renderLansBeforeSavedLists(...args); paintSavedDevicesButton(); if (savedPopover?.dataset.list === 'devices') renderSavedPopover(); return drawn; };

  root.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    const action = button?.dataset.action;
    if (action === 'toggle-camera-logins') { openSavedPopover('logins'); return; }
    if (action === 'toggle-saved-devices') { openSavedPopover('devices'); return; }
    if (action === 'close-list-popover') { closeSavedPopover(true); return; }
    if (action === 'add-camera-login') {
      if (cameraLogins.length >= 128) return;
      cameraLogins.push({ model: '', login: 'admin', password: '' });
      renderSavedPopover();
      savedPopover.querySelector('[data-login-field="model"][data-login-index="' + (cameraLogins.length - 1) + '"]')?.focus({ preventScroll: true });
      paintCameraLoginsButton();
      remember();
      return;
    }
    if (action === 'remove-camera-login') {
      cameraLogins.splice(Number(button.dataset.loginIndex), 1);
      renderSavedPopover();
      paintCameraLoginsButton();
      remember();
      return;
    }
    if (action === 'forget-saved-device') { forgetSavedDevice(button.dataset.serial); return; }
    // A click anywhere else puts the list away. Hubble's own pop-up lists sit outside it.
    if (savedPopover && !savedPopover.hidden && !event.target.closest?.('.hc-list-popover, .hc-dropdown-menu')) closeSavedPopover();
  });
  root.addEventListener('change', event => {
    if (event.target.dataset?.loginField) commitCameraLogin(event.target);
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && savedPopover && !savedPopover.hidden && !document.querySelector('.hc-dropdown-menu')) { event.preventDefault(); closeSavedPopover(true); }
    if (event.key === 'Enter' && event.target.dataset?.loginField && event.target.tagName === 'INPUT') { event.preventDefault(); commitCameraLogin(event.target); }
  });
  window.addEventListener('resize', () => { if (savedPopover && !savedPopover.hidden) placeSavedPopover(); });
  root.addEventListener('scroll', () => { if (savedPopover && !savedPopover.hidden) placeSavedPopover(); }, true);
