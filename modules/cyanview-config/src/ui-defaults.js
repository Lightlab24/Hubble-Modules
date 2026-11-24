  // ── Defaults ───────────────────────────────────────────────────────────────
  // One tab for what a new device or camera is called and where it is (asked for Nov 21, 2026): a name
  // and LAN IP pattern for RCPs, RIOs and Gateways, a camera name and IP pattern, and a row per camera
  // model with the type %type% puts in its name, its own IP pattern if it needs one, and its login.
  // It replaced the Camera logins pop-up. RCPs, RIOs and Gateways are numbered separately, so there can
  // be an RCP 1 and a RIO 1, and numbers can have gaps. A device's number is saved on the device.
  // Patterns are read by defaults-model.ts, which the worker shares. A name or address only changes
  // while it still matches what its pattern made, so anything typed over by hand stays.
  let defaults = initialDefaults();
  // One row per camera model: { model, type, ip, login, password }, saved as the plan's cameraLogins.
  let cameraTypes = [];
  let defaultsPanel = null, lastDevicePattern = '';
  // Cameras whose number was typed. Choosing a RIO as their Source leaves that number alone.
  const typedCameraNumbers = new Set();
  const defaultsText = value => String(value ?? '').slice(0, 160);
  const kindSingular = { RCP: 'RCP', RIO: 'RIO', Gateway: 'Gateway' };
  const kindPlural = { RCP: 'RCPs', RIO: 'RIOs', Gateway: 'Gateways' };
  // A device's kind as Defaults groups it. One Hubble can't place has its own numbers and no defaults.
  const kindOf = d => deviceKinds.includes(d?.kind) ? d.kind : String(d?.kind || 'Other');
  const kindRank = kind => { const index = deviceKinds.indexOf(kind); return index < 0 ? deviceKinds.length : index; };
  const kindDefaults = d => defaults.devices[kindOf(d)] ?? null;

  function restoreDefaults(plan) {
    try { defaults = validateDefaults(plan?.defaults) ?? initialDefaults(); } catch { defaults = initialDefaults(); }
    cameraTypes = Array.isArray(plan?.cameraLogins) ? plan.cameraLogins.slice(0, 128).map(item => ({ model: defaultsText(item.model), type: defaultsText(item.type), ip: defaultsText(item.ip), login: defaultsText(item.login), password: defaultsText(item.password) })) : [];
    renderDefaults();
  }
  const restoreSavedListsBeforeDefaults = restoreSavedLists;
  restoreSavedLists = function(plan) { restoreSavedListsBeforeDefaults(plan); restoreDefaults(plan); };
  function savedDefaults() { return JSON.parse(JSON.stringify(defaults)); }
  function savedCameraLogins() {
    return cameraTypes.slice(0, 128).map(item => ({ model: item.model, login: item.login, password: item.password, ...(item.type ? { type: item.type } : {}), ...(item.ip ? { ip: item.ip } : {}) }));
  }

  // ----- Device numbers -----
  function numberTaken(d, number, kind = kindOf(d)) { return devices.find(other => other !== d && kindOf(other) === kind && deviceNumber(other.number) === number) ?? null; }
  // Kinds in their own order, then by number, so every list of devices follows the Devices sheet.
  function numberOrder() {
    return orderedDevices().map((d, index) => ({ d, index })).sort((a, b) => kindRank(kindOf(a.d)) - kindRank(kindOf(b.d)) || kindOf(a.d).localeCompare(kindOf(b.d)) ||
      (deviceNumber(a.d.number) ?? highestNumber + 1) - (deviceNumber(b.d.number) ?? highestNumber + 1) || a.index - b.index).map(entry => entry.d.id);
  }
  // Every device has a number. One saved before numbers existed keeps the number in its name when that is
  // free ("Cam 12" is RIO 12, "Cam 6 Tally" RIO 6), and one with none, like a device just added, takes the
  // next number after the highest of its kind. A number two devices share stays with the first.
  function ensureDeviceNumbers() {
    const list = orderedDevices(), used = new Map(), key = (kind, number) => kind + ':' + number;
    let changed = false;
    for (const d of list) {
      const number = deviceNumber(d.number);
      if (number !== null && !used.has(key(kindOf(d), number))) used.set(key(kindOf(d), number), d);
      if (number !== null && d.number !== number) d.number = number;
    }
    const waiting = list.filter(d => used.get(key(kindOf(d), deviceNumber(d.number))) !== d);
    for (const d of waiting) {
      const kind = kindOf(d), named = d.name && d.name !== d.serial ? numberFromName(kindDefaults(d)?.name, d.name) ?? firstNumberIn(d.name) : null;
      if (named !== null && !used.has(key(kind, named))) { d.number = named; used.set(key(kind, named), d); changed = true; }
    }
    for (const d of waiting) {
      const kind = kindOf(d);
      if (used.get(key(kind, deviceNumber(d.number))) === d) continue;
      let number = Math.max(0, ...[...used.values()].filter(other => kindOf(other) === kind).map(other => deviceNumber(other.number) ?? 0)) + 1;
      while (used.has(key(kind, number)) && number < highestNumber) number++;
      d.number = number;
      used.set(key(kind, number), d);
      changed = true;
    }
    return changed;
  }
  // Number order is the list's own order, shown as a sort on #.
  function orderByNumber() { deviceOrder = numberOrder(); deviceSheet.sort = { field: 'row', direction: 'asc' }; }
  let orderByNumberAfterRestore = false;
  const renderLansBeforeDefaults = renderLans;
  renderLans = function(...args) {
    // A device that has just come in, or a workspace saved before numbers, is put in its place by number.
    if (ensureDeviceNumbers()) { orderByNumber(); orderByNumberAfterRestore = true; }
    return renderLansBeforeDefaults(...args);
  };
  // A workspace saved before numbers brings back its old order and sort after its devices are read, so the
  // numbers given out then put the list in number order again.
  const restoreBeforeDefaults = restore;
  restore = function(...args) {
    const restored = restoreBeforeDefaults(...args);
    if (orderByNumberAfterRestore) { orderByNumberAfterRestore = false; orderByNumber(); renderLans(); }
    return restored;
  };

  // ----- Device names and LAN IPs -----
  function deviceDefaultName(d, number = deviceNumber(d.number)) {
    const pattern = kindDefaults(d)?.name;
    return pattern && number !== null ? fillName(pattern, { number }) : '';
  }
  function deviceDefaultAddress(d, number = deviceNumber(d.number)) {
    const pattern = kindDefaults(d)?.lan;
    return pattern && number !== null ? fillAddress(pattern, number) : { address: '', problem: '' };
  }
  // A name or LAN IP follows the defaults while it is still what its pattern made from the old number.
  const deviceNameFollows = (d, number) => d.name === d.serial || (!!deviceDefaultName(d, number) && d.name === deviceDefaultName(d, number));
  function deviceLanFollows(d, number) {
    const row = deviceNetwork(d).lan[0];
    if (!row) return true;
    const { address } = deviceDefaultAddress(d, number);
    return !!address && plainAddress(row.planned) === address;
  }
  // The LAN IP the device's number makes goes in as an address change, which waits in Pending sends.
  function stageDefaultLan(d) {
    const { address, problem } = deviceDefaultAddress(d);
    if (problem) { toast(d.name + ': ' + problem + '. Its LAN IP is left as it is.'); return; }
    if (!address) return;
    const row = deviceNetwork(d).lan[0];
    if (row && plainAddress(row.planned) === address) return;
    commitDeviceCell(d.id, 'lan1', address + '/' + (kindDefaults(d)?.mask || maskOf(row?.current, '16')));
  }
  function renumberDevice(d, number, keepName = false) {
    const previous = deviceNumber(d.number), nameFollows = !keepName && deviceNameFollows(d, previous), lanFollows = deviceLanFollows(d, previous);
    d.number = number;
    if (nameFollows) d.name = deviceDefaultName(d) || d.name;
    if (lanFollows) stageDefaultLan(d);
    orderByNumber();
    syncFilter();
    renderLans();
    renderCameras();
    remember();
  }
  // # takes a number now, not a place in the list. A name that fits its pattern ("Cam 20") renumbers too.
  const commitDeviceCellBeforeDefaults = commitDeviceCell;
  commitDeviceCell = function(id, field, raw) {
    const d = device(id);
    if (!d || (field !== 'row' && field !== 'name')) return commitDeviceCellBeforeDefaults(id, field, raw);
    const kind = kindOf(d), label = kindSingular[kind] ?? kind;
    if (field === 'row') {
      const value = String(raw).trim(), number = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(number) || number < 1) { toast('Enter a number from 1 to ' + highestNumber); renderLans(); return; }
      if (number === deviceNumber(d.number)) { renderLans(); return; }
      const other = numberTaken(d, number);
      if (other) { toast(label + ' ' + number + ' is already ' + other.name); renderLans(); return; }
      renumberDevice(d, number);
      return;
    }
    const before = d.name;
    commitDeviceCellBeforeDefaults(id, field, raw);
    if (d.name === before) return;
    const number = numberFromName(kindDefaults(d)?.name, d.name);
    if (number === null || number === deviceNumber(d.number)) return;
    const other = numberTaken(d, number);
    if (other) { toast(label + ' ' + number + ' is already ' + other.name + ', so ' + d.name + ' stays ' + label + ' ' + d.number); return; }
    renumberDevice(d, number, true);
  };
  // A device added by hand takes the next number of its kind, the name it makes and its LAN IP. One the rig
  // search finds was set up already, so it keeps its own, and so does the Simulated rig, which stands in for
  // a rig already set up (its tour counts its cameras as yours too). This runs after Setup mode has cleared an RCP.
  const addBeforeDefaults = addLiveResults;
  addLiveResults = async function() {
    const before = new Set(devices.map(d => d.id));
    await addBeforeDefaults();
    const added = devices.filter(d => !before.has(d.id));
    if (!added.length) return;
    ensureDeviceNumbers();
    if (!moduleBridge?.simulated) for (const d of added) {
      const name = deviceDefaultName(d);
      if (name && d.name === d.serial) d.name = name;
      stageDefaultLan(d);
    }
    orderByNumber();
    syncFilter();
    renderLans();
    renderCameras();
    remember();
  };
  // What the Devices sheet says above each kind's rows.
  function deviceSectionNote(kind) {
    const row = defaults.devices[kind];
    if (!row) return 'No defaults';
    const parts = [row.name ? 'Name ' + row.name : '', row.lan ? 'LAN IP ' + row.lan : 'no default LAN IP'].filter(Boolean);
    return parts.join(' · ');
  }

  // ----- Cameras -----
  const usbCamera = model => model === 'Alpha-USB';
  const cameraTypeRow = model => { const key = String(model ?? ''); return key && key !== 'Choose model…' ? cameraTypes.find(item => item.model === key) ?? null : null; };
  // What %type% puts in a camera's name: its model's type, otherwise the model itself.
  function cameraTypeLabel(model) {
    const row = cameraTypeRow(model), key = String(model ?? '');
    return row?.type || (key && key !== 'Choose model…' ? key : 'Camera');
  }
  function cameraDefaultName(model, number) {
    const pattern = defaults.camera.name;
    return pattern ? fillName(pattern, { number, type: cameraTypeLabel(model) }) : 'Camera ' + number;
  }
  // None in a model's Camera IP means its cameras have no address, such as a virtual camera (Nov 24, 2026).
  const noCameraIp = value => /^none$/i.test(String(value ?? '').trim());
  const modelHasNoIp = model => noCameraIp(cameraTypeRow(model)?.ip);
  function cameraDefaultIp(model, number) {
    if (usbCamera(model) || modelHasNoIp(model)) return '';
    const pattern = cameraTypeRow(model)?.ip || defaults.camera.ip, value = Number(number);
    return pattern && Number.isInteger(value) ? fillAddress(pattern, value).address : '';
  }
  // "Camera 7" is what new cameras were called before Defaults, so it counts as following them too.
  const cameraNameFollows = camera => !camera.name || camera.name === cameraDefaultName(camera.model, camera.number) || camera.name === 'Camera ' + camera.number;
  const cameraIpFollows = camera => !camera.ip || camera.ip === cameraDefaultIp(camera.model, camera.number);
  /** Fills a camera's Username and Password from its model's row. A USB camera has neither. */
  function applyCameraLogin(camera, fields) {
    if (!camera || usbCamera(camera.model)) return false;
    const row = cameraTypeRow(camera.model);
    if (!row) return false;
    // None in a model's Username means its cameras have none, where an empty box takes the Username above.
    const values = { login: noCameraIp(row.login) ? '' : row.login || defaults.camera.login, password: row.password };
    for (const field of ['login', 'password']) {
      camera[field] = values[field];
      camera.dirty?.add(field);
      if (fields && !fields.includes(field)) fields.push(field);
    }
    return true;
  }
  // The number a camera added to this RIO takes: the RIO's own, if nothing on the RIO has it yet.
  function rioCameraNumber(deviceId, except = null) {
    const d = device(deviceId);
    if (!d || kindOf(d) !== 'RIO' || !defaults.camera.rioNumber) return null;
    const number = deviceNumber(d.number);
    return number !== null && !cameras.some(camera => camera !== except && camera.device === deviceId && Number(camera.number) === number) ? number : null;
  }
  /** A new camera row's name, address and login. Its number is already set. */
  function applyCameraDefaults(row) {
    row.name = cameraDefaultName(row.model, row.number);
    if (!usbCamera(row.model)) {
      row.ip = cameraDefaultIp(row.model, row.number) || row.ip;
      if (defaults.camera.login) row.login = defaults.camera.login;
    }
    applyCameraLogin(row);
  }
  // A model or number change carries the name and address along while they still follow the defaults.
  const stageCellBeforeDefaults = stageCell;
  stageCell = function(item, field, value, isLan) {
    if (isLan || (field !== 'model' && field !== 'number') || importedCamera(item) || item.foreign) return stageCellBeforeDefaults(item, field, value, isLan);
    const nameFollows = cameraNameFollows(item), ipFollows = cameraIpFollows(item);
    const fields = stageCellBeforeDefaults(item, field, value, isLan);
    if (!fields.length) return fields;
    if (field === 'number') typedCameraNumbers.add(item.id);
    if (field === 'model') applyCameraLogin(item, fields);
    const put = (key, next) => { if (!next || next === item[key]) return; item[key] = next; item.dirty?.add(key); if (!fields.includes(key)) fields.push(key); };
    if (nameFollows) put('name', cameraDefaultName(item.model, item.number));
    if (ipFollows) put('ip', cameraDefaultIp(item.model, item.number));
    // A model with no address takes away the one that came from Defaults.
    if (ipFollows && field === 'model' && modelHasNoIp(item.model) && item.ip) { item.ip = ''; item.dirty?.add('ip'); if (!fields.includes('ip')) fields.push('ip'); }
    return fields;
  };
  // A camera made on Camera Configuration has no controller until its Source is chosen. Choosing a RIO
  // gives it the RIO's number, unless its number, name or address was typed.
  const applyWantedRouteBeforeDefaults = applyWantedRoute;
  applyWantedRoute = function(camera, wanted) {
    const from = camera.device, nameFollows = cameraNameFollows(camera), ipFollows = cameraIpFollows(camera);
    applyWantedRouteBeforeDefaults(camera, wanted);
    if (camera.device === from || camera.elementKey || importedCamera(camera) || camera.foreign || typedCameraNumbers.has(camera.id) || !nameFollows || !ipFollows) return;
    const number = rioCameraNumber(camera.device, camera);
    if (number === null || String(number) === String(camera.number)) return;
    camera.number = String(number);
    camera.dirty?.add('number');
    camera.name = cameraDefaultName(camera.model, camera.number);
    camera.dirty?.add('name');
    const ip = cameraDefaultIp(camera.model, camera.number);
    if (ip) { camera.ip = ip; camera.dirty?.add('ip'); }
  };

  // ----- The Defaults tab -----
  const code = value => '<code class="hc-defaults-code">' + esc(value) + '</code>';
  const chip = (token, target = '') => '<button type="button" class="hc-defaults-chip" data-action="insert-wildcard" data-insert="' + esc(token) + '"' + (target ? ' data-target="' + esc(target) + '"' : '') + ' aria-label="Insert ' + esc(token) + '">+ ' + esc(token) + '</button>';
  function defaultsInput(key, value, label, { placeholder = '', mono = true, pattern = false, problem = '', width = '', disabled = false } = {}) {
    return '<input class="hc-cell-input' + (mono ? ' hc-mono' : '') + (problem ? ' hc-defaults-invalid' : '') + '" data-defaults-field="' + esc(key) + '"' + (pattern ? ' data-pattern' : '') + ' value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" aria-label="' + esc(label) + '"' +
      (problem ? ' aria-invalid="true" title="' + esc(problem) + '"' : '') + (width ? ' style="width:' + width + '"' : '') + (disabled ? ' disabled' : '') + ' maxlength="160" spellcheck="false" autocomplete="off">';
  }
  function typeModelOptions(current) {
    const taken = new Set(cameraTypes.map(item => item.model).filter(model => model && model !== current));
    const groups = new Map();
    for (const option of everyModelChoice()) {
      if (taken.has(option.value)) continue;
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
  // What is wrong with each pattern, said under its table. The line keeps its height so nothing moves.
  function defaultsProblems() {
    const devicesFound = [], camerasFound = [];
    for (const kind of deviceKinds) {
      const row = defaults.devices[kind], problem = addressPatternProblem(row.lan);
      if (problem) devicesFound.push({ key: 'device:' + kind + ':lan', text: kindPlural[kind] + ' LAN IP: ' + problem });
      if (row.name && !/%number%/i.test(row.name)) devicesFound.push({ key: 'device:' + kind + ':name', text: kindPlural[kind] + ' name has no %number%, so every one gets the same name', warning: true });
    }
    const ip = addressPatternProblem(defaults.camera.ip);
    if (ip) camerasFound.push({ key: 'camera:ip', text: 'Camera IP: ' + ip });
    if (defaults.camera.name && !/%number%/i.test(defaults.camera.name)) camerasFound.push({ key: 'camera:name', text: 'Camera name has no %number%, so cameras get the same name', warning: true });
    cameraTypes.forEach((row, index) => { const problem = noCameraIp(row.ip) || usbCamera(row.model) ? '' : addressPatternProblem(row.ip); if (problem) camerasFound.push({ key: 'type:' + index + ':ip', text: (row.model || 'Row ' + (index + 1)) + ' camera IP: ' + problem }); });
    return { devices: devicesFound, cameras: camerasFound };
  }
  const problemFor = (list, key) => list.find(item => item.key === key && !item.warning)?.text ?? '';
  const problemLine = (list, role) => '<p class="hc-defaults-problem" data-role="' + role + '" aria-live="polite">' + list.map(item => '<span class="' + (item.warning ? 'hc-defaults-warning' : 'hc-error-text') + '">' + esc(item.text) + '</span>').join('') + '</p>';
  function defaultsMarkup() {
    const problems = defaultsProblems();
    const deviceRows = deviceKinds.map(kind => {
      const row = defaults.devices[kind], key = field => 'device:' + kind + ':' + field;
      return '<tr data-defaults-kind="' + kind + '"><th scope="row">' + kindPlural[kind] + '</th>' +
        '<td>' + defaultsInput(key('name'), row.name, 'Name for ' + kindPlural[kind], { placeholder: 'Keeps its serial', pattern: true }) + '</td>' +
        '<td>' + defaultsInput(key('lan'), row.lan, 'LAN IP for ' + kindPlural[kind], { placeholder: 'No default', pattern: true, problem: problemFor(problems.devices, key('lan')) }) + '</td>' +
        '<td>' + defaultsInput(key('mask'), row.mask, 'Mask for ' + kindPlural[kind], { placeholder: '16' }) + '</td></tr>';
    }).join('');
    const typeRows = cameraTypes.map((row, index) => {
      const key = field => 'type:' + index + ':' + field, named = row.model || 'row ' + (index + 1);
      // A camera on USB has no address or login, so its row only gives it a type for its name.
      const usb = usbCamera(row.model);
      return '<tr data-defaults-type="' + index + '">' +
        '<td><select class="hc-cell-input" data-defaults-field="' + key('model') + '" aria-label="Camera model ' + (index + 1) + '">' + typeModelOptions(row.model) + '</select></td>' +
        '<td>' + defaultsInput(key('type'), row.type, '%type% for ' + named, { placeholder: row.model || '' }) + '</td>' +
        '<td>' + defaultsInput(key('ip'), row.ip, 'Camera IP for ' + named, usb ? { disabled: true } : { placeholder: defaults.camera.ip || 'No default', pattern: true, problem: problemFor(problems.cameras, key('ip')) }) + '</td>' +
        '<td>' + defaultsInput(key('login'), row.login, 'Username for ' + named, usb ? { disabled: true, mono: false } : { placeholder: defaults.camera.login, mono: false }) + '</td>' +
        '<td>' + defaultsInput(key('password'), row.password, 'Password for ' + named, { mono: false, disabled: usb }) + '</td>' +
        '<td class="hc-defaults-remove"><button type="button" class="hc-row-remove-button" data-action="remove-camera-type" data-index="' + index + '" aria-label="Remove the row for ' + esc(named) + '" title="Remove this row. Cameras already set up keep their names, addresses and logins.">' + icon('trash-2') + '</button></td></tr>';
    }).join('');
    const field = (key, value, label, under, options = {}) => '<label class="hc-defaults-field"><span>' + esc(label) + '</span>' + defaultsInput(key, value, label, options) + '<span class="hc-defaults-under">' + under + '</span></label>';
    return '<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>Defaults</h3><span>Names and addresses for new devices and cameras</span></div></div>' +
      '<div class="hc-defaults">' +
      '<p class="hc-defaults-intro">Type a wildcard between % signs, or click a <b>+</b> button to put one where the cursor is. ' + code('%number%') + ' is the device or camera number, and ' + code('%type%') + ' is the camera type. ' +
      'In an address, ' + code('%number%') + ' and the digits next to it always make three digits: ' + code('10.20.101.1%number%') + ' gives RIO 5 the address 10.20.101.105 and RIO 21 the address 10.20.101.121, and ' + code('10.20.101.%number%') + ' gives RIO 21 10.20.101.21. ' +
      'A name or address that came from here follows its device or camera to a new number. One you typed yourself is never replaced.</p>' +
      '<section class="hc-defaults-section" aria-labelledby="hc-defaults-devices"><div class="hc-defaults-heading"><h4 id="hc-defaults-devices">Devices</h4><span>RCPs, RIOs and Gateways are numbered separately, so RCP 1 and RIO 1 can both exist.</span></div>' +
      '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid hc-defaults-table" data-defaults-table="devices"><colgroup><col style="width:120px"><col><col><col style="width:90px"></colgroup><thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">LAN IP</th><th scope="col">Mask</th></tr></thead><tbody>' + deviceRows + '</tbody></table></div></div>' +
      '<div class="hc-defaults-chips"><span>Insert into the box you’re in:</span>' + chip('%number%') + '</div>' + problemLine(problems.devices, 'defaults-device-problems') + '</section>' +
      '<section class="hc-defaults-section" aria-labelledby="hc-defaults-cameras"><div class="hc-defaults-heading"><h4 id="hc-defaults-cameras">Cameras</h4><span>A model without a row below uses its own model name for %type%. Type None in a model’s Camera IP or Username when its cameras have none.</span></div>' +
      '<div class="hc-defaults-fields">' +
      field('camera:name', defaults.camera.name, 'Camera name', chip('%number%', 'camera:name') + chip('%type%', 'camera:name'), { placeholder: 'Camera %number%', pattern: true }) +
      field('camera:ip', defaults.camera.ip, 'Camera IP', chip('%number%', 'camera:ip'), { placeholder: 'No default', pattern: true, problem: problemFor(problems.cameras, 'camera:ip') }) +
      field('camera:login', defaults.camera.login, 'Username', 'Used when a model’s row has none', { mono: false }) +
      '<label class="hc-defaults-check"><input type="checkbox" data-defaults-field="camera:rioNumber"' + (defaults.camera.rioNumber ? ' checked' : '') + '>A camera added to a RIO takes the RIO’s number</label></div>' +
      '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid hc-defaults-table" data-defaults-table="types"><colgroup><col style="width:220px"><col style="width:150px"><col><col style="width:160px"><col style="width:160px"><col style="width:44px"></colgroup><thead><tr><th scope="col">Camera model</th><th scope="col">%type%</th><th scope="col">Camera IP</th><th scope="col">Username</th><th scope="col">Password</th><th scope="col"><span class="hc-visually-hidden">Remove</span></th></tr></thead><tbody>' +
      (typeRows || '<tr><td colspan="6" class="hc-muted hc-defaults-empty">No camera models yet. Add one to give it a type, an address or a login.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="hc-defaults-actions"><button type="button" class="hc-button" data-action="add-camera-type"' + (cameraTypes.length >= 128 ? ' disabled' : '') + '>' + icon('plus') + 'Add a camera model</button><span class="hc-muted">Usernames and passwords show as typed.</span></div>' +
      problemLine(problems.cameras, 'defaults-camera-problems') + '</section></div>' +
      '<div class="hc-panel-foot"><span>Saved and exported with the workspace</span><span class="hc-caption">Changing a default leaves the devices and cameras you already have as they are</span></div>';
  }
  function renderDefaults() {
    if (!defaultsPanel) return;
    // A list's button stands for the select under it.
    const focused = document.activeElement, source = focused?.matches?.('.hc-dropdown') ? focused.previousElementSibling : focused;
    const key = defaultsPanel.contains(focused) ? source?.dataset?.defaultsField || (focused.dataset.action ? 'action:' + focused.dataset.action : '') : '';
    const caret = key && focused.tagName === 'INPUT' && focused.setSelectionRange ? [focused.selectionStart, focused.selectionEnd] : null;
    defaultsPanel.innerHTML = defaultsMarkup();
    upgradeSelects(defaultsPanel);
    icons();
    if (!key) return;
    const element = key.startsWith('action:') ? defaultsPanel.querySelector('[data-action="' + key.slice(7) + '"]') : defaultsPanel.querySelector('[data-defaults-field="' + CSS.escape(key) + '"]');
    const target = element?.tagName === 'SELECT' ? defaultsDropdown(element) : element;
    target?.focus?.({ preventScroll: true });
    if (caret) try { element.setSelectionRange(caret[0], caret[1]); } catch { /* Not a text box. */ }
  }
  const defaultsDropdown = select => select?.nextElementSibling?.matches?.('.hc-dropdown') ? select.nextElementSibling : select;
  // Only the problem lines and markings change while typing, so the box in use is never redrawn.
  function paintDefaultsProblems() {
    if (!defaultsPanel) return;
    const problems = defaultsProblems();
    for (const [list, role] of [[problems.devices, 'defaults-device-problems'], [problems.cameras, 'defaults-camera-problems']]) {
      const line = defaultsPanel.querySelector('[data-role="' + role + '"]');
      if (line) line.outerHTML = problemLine(list, role);
    }
    for (const input of defaultsPanel.querySelectorAll('[data-pattern]')) {
      const problem = problemFor([...problems.devices, ...problems.cameras], input.dataset.defaultsField);
      input.classList.toggle('hc-defaults-invalid', !!problem);
      if (problem) { input.setAttribute('aria-invalid', 'true'); input.title = problem; } else { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); }
    }
  }
  function commitDefaultsField(element) {
    const key = element.dataset.defaultsField;
    if (!key) return;
    const [scope, first, second] = key.split(':'), value = element.type === 'checkbox' ? element.checked : defaultsText(element.value).trim();
    if (scope === 'device') {
      const row = defaults.devices[first];
      if (!row || !(second in row)) return;
      if (second === 'mask' && value !== '' && (!/^\d{1,2}$/.test(value) || Number(value) > 32)) { toast('A mask is a number from 0 to 32, such as 16'); element.value = row.mask; return; }
      if (row[second] === value) return;
      row[second] = value;
      renderLans();
    } else if (scope === 'camera') {
      if (!(first in defaults.camera) || defaults.camera[first] === value) return;
      defaults.camera[first] = value;
      // The model rows show the camera IP and username as their placeholders.
      if (first === 'ip' || first === 'login') for (const input of defaultsPanel.querySelectorAll('[data-defaults-field$=":' + first + '"]')) if (input.dataset.defaultsField.startsWith('type:') && !input.disabled) input.placeholder = first === 'ip' ? value || 'No default' : value;
    } else if (scope === 'type') {
      const row = cameraTypes[Number(first)];
      if (!row || !(second in row)) return;
      const next = (second === 'ip' || second === 'login') && noCameraIp(value) ? 'None' : value;
      if (next !== value) element.value = next;
      if (row[second] === next) return;
      row[second] = next;
      // What was typed for another model doesn't stay behind boxes that are now off.
      if (second === 'model' && usbCamera(next)) row.ip = row.login = row.password = '';
      if (second === 'model') renderDefaults();
    } else return;
    paintDefaultsProblems();
    remember();
  }
  // A wildcard goes in where the cursor is, in the box last used in that part of the page.
  function insertWildcard(button) {
    const target = button.dataset.target || lastDevicePattern || 'device:RCP:name';
    const input = defaultsPanel.querySelector('[data-defaults-field="' + CSS.escape(target) + '"]');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start, token = button.dataset.insert;
    input.value = input.value.slice(0, start) + token + input.value.slice(end);
    input.focus({ preventScroll: true });
    input.setSelectionRange(start + token.length, start + token.length);
    commitDefaultsField(input);
  }
  function showDefaults() { root.querySelector('.hc-tabs [data-tab="defaults"]')?.click(); }
  function initializeDefaultsTab() {
    const nav = root.querySelector('.hc-tabs'), main = root.querySelector('.hc-main');
    if (!nav || !main || defaultsPanel) return;
    const tab = document.createElement('button');
    tab.className = 'hc-tab'; tab.setAttribute('role', 'tab'); tab.id = 'hc-tab-defaults'; tab.setAttribute('aria-controls', 'hc-defaults'); tab.setAttribute('aria-selected', 'false'); tab.dataset.tab = 'defaults'; tab.textContent = 'Defaults';
    nav.appendChild(tab);
    const panel = document.createElement('section');
    panel.id = 'hc-defaults'; panel.className = 'hc-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'hc-tab-defaults'); panel.hidden = true;
    main.insertBefore(panel, main.querySelector('.hc-global-foot'));
    defaultsPanel = panel;
    // The same switching as the Firmware tab: the page's own tabs don't know this one.
    const setSelected = (element, value) => { if (element.getAttribute('aria-selected') !== value) element.setAttribute('aria-selected', value); };
    const show = on => {
      if (!on && panel.hidden) return;
      panel.hidden = !on;
      setSelected(tab, String(on));
      if (on) {
        nav.querySelectorAll('[data-tab]').forEach(element => { if (element !== tab) setSelected(element, 'false'); });
        root.querySelectorAll('.hc-panel').forEach(element => { if (element !== panel && !element.hidden) element.hidden = true; });
      }
    };
    tab.addEventListener('click', () => show(true));
    nav.addEventListener('click', event => { const other = event.target.closest('[data-tab]'); if (other && other !== tab) show(false); });
    new MutationObserver(() => { if (!panel.hidden && nav.querySelector('[data-tab]:not([data-tab="defaults"])[aria-selected="true"]')) show(false); }).observe(nav, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
    panel.addEventListener('focusin', event => { const key = event.target.dataset?.defaultsField; if (key?.startsWith('device:') && event.target.hasAttribute('data-pattern')) lastDevicePattern = key; });
    // A + button never takes the keyboard from the box it writes into.
    panel.addEventListener('mousedown', event => { if (event.target.closest('[data-action="insert-wildcard"]')) event.preventDefault(); });
    panel.addEventListener('change', event => { if (event.target.dataset?.defaultsField) commitDefaultsField(event.target); });
    panel.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.dataset?.defaultsField) { event.preventDefault(); commitDefaultsField(event.target); } });
    panel.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      if (button.dataset.action === 'insert-wildcard') insertWildcard(button);
      else if (button.dataset.action === 'add-camera-type') {
        if (cameraTypes.length >= 128) return;
        cameraTypes.push({ model: '', type: '', ip: '', login: '', password: '' });
        renderDefaults();
        const select = defaultsPanel.querySelector('[data-defaults-field="type:' + (cameraTypes.length - 1) + ':model"]');
        defaultsDropdown(select)?.focus({ preventScroll: true });
        remember();
      } else if (button.dataset.action === 'remove-camera-type') {
        cameraTypes.splice(Number(button.dataset.index), 1);
        renderDefaults();
        remember();
      }
    });
    renderDefaults();
  }
  root.addEventListener('click', event => { if (event.target.closest?.('[data-action="open-defaults"]')) showDefaults(); });
  // The tab goes after Firmware.
  const initializeFirmwareBeforeDefaults = initializeFirmwareTab;
  initializeFirmwareTab = function() { initializeFirmwareBeforeDefaults(); initializeDefaultsTab(); };
