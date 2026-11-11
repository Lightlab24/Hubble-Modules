  // The Devices tab as one sheet: a row per controller with its addresses as columns. LAN and WAN
  // settings fold away behind their own groups. A device is added by typing its IP in the last row,
  // and found devices list under the managed ones, each with its own Add. The cards this replaces
  // stay as the Details view, and every edit here goes through the same rows and sends they use.
  // The remove button sits beside the name, where it is on the camera sheets.
  const deviceSheet = { lanOpen: false, wanOpen: false, sort: null, details: false };
  let selectedDeviceId = '', deviceAddNote = '', deviceAddBusy = false;
  const deviceGroups = {
    lan: { label: 'LAN IP settings', open: [['lan1', 'LAN IP', 158], ['lan2', 'LAN IP 2', 158]], closed: [['lan1', 'LAN IP', 190]] },
    wan: { label: 'WAN settings', open: [['wanMode', 'Mode', 96], ['wanIp', 'WAN IP', 158], ['gateway', 'Gateway', 130], ['dns1', 'DNS 1', 122], ['dns2', 'DNS 2', 122]], closed: [['wan', 'WAN', 150]] },
  };
  const deviceSortable = new Set(['name', 'type', 'serial', 'status', 'base', 'lan1', 'lan2', 'wan', 'wanIp', 'connected', 'cameras']);

  function deviceNetwork(d) {
    const rows = lans.filter(row => row.device === d.id);
    return { lan: rows.filter(row => row.type !== 'WAN' && !row.readOnly), wan: rows.find(row => row.type === 'WAN' && !row.readOnly) };
  }
  const plainAddress = value => String(value ?? '').split('/')[0];
  function deviceConnectedOn(d) {
    const address = d.address || d.base;
    if (d.online === false || d.online == null) return '—';
    if (address === d.base) return 'Base';
    const index = deviceNetwork(d).lan.findIndex(row => plainAddress(row.current) === address);
    return index < 0 ? address : index ? 'LAN IP ' + (index + 1) : 'LAN IP';
  }
  function deviceSyncText(d) {
    const rows = lans.filter(row => row.device === d.id);
    if (rows.some(row => row.jobs > 0)) return 'Sending';
    const failed = rows.find(row => row.pending && !['Pending', 'In sync', 'Verified', 'Sending', 'Verifying'].includes(row.result));
    if (failed) return failed.result;
    return rows.some(row => row.pending) ? 'Pending' : d.online ? 'In sync' : '—';
  }
  const deviceCameraCount = d => cameras.filter(camera => camera.device === d.id).length;
  function deviceSortValue(d, field) {
    const net = deviceNetwork(d);
    return String({
      name: d.name, type: d.kind, serial: d.serial, status: d.online ? '1 Online' : d.online === false ? '2 Offline' : '3', base: d.base,
      lan1: plainAddress(net.lan[0]?.planned), lan2: plainAddress(net.lan[1]?.planned), wan: net.wan ? (net.wan.dhcp ? 'DHCP' : plainAddress(net.wan.planned)) : '',
      wanIp: net.wan && !net.wan.dhcp ? plainAddress(net.wan.planned) : '', connected: deviceConnectedOn(d), cameras: String(deviceCameraCount(d)),
    }[field] ?? '');
  }
  // Sorting reorders the devices themselves, so every other list of them follows.
  function sortDevices(field) {
    const previous = deviceSheet.sort, direction = previous?.field === field && previous.direction === 'asc' ? 'desc' : 'asc', sign = direction === 'desc' ? -1 : 1;
    deviceSheet.sort = { field, direction };
    setOrder(orderedDevices().map((d, index) => ({ d, index, value: deviceSortValue(d, field) })).sort((a, b) => {
      if (!a.value || !b.value) return a.value ? -1 : b.value ? 1 : a.index - b.index;
      return sign * a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }) || a.index - b.index;
    }).map(entry => entry.d.id));
  }

  function deviceSheetColumns() {
    const group = name => (deviceGroups[name][deviceSheet[name + 'Open'] ? 'open' : 'closed']).map(([id, label, width]) => ({ id, label, width, group: name }));
    const plain = list => list.map(([id, label, width]) => ({ id, label, width }));
    return [...plain([['row', '#', 36], ['name', 'Name', 170], ['remove', '', 40], ['type', 'Type', 82], ['serial', 'Serial', 172], ['status', 'Status', 104], ['base', 'Base IP', 130]]),
      ...group('lan'), ...group('wan'), ...plain([['connected', 'Connected on', 116], ['cameras', 'Cameras', 128], ['sync', 'Sync', 96]])];
  }
  function deviceSheetHeader(columns) {
    const sortHead = column => {
      if (!deviceSortable.has(column.id)) return esc(column.label);
      const active = deviceSheet.sort?.field === column.id;
      return '<button type="button" class="hc-sort-heading" data-device-sort="' + column.id + '" aria-label="Sort by ' + esc(column.label) + '">' + esc(column.label) + (active ? '<span aria-hidden="true">' + (deviceSheet.sort.direction === 'asc' ? '↑' : '↓') + '</span>' : '') + '</button>';
    };
    const top = [], fields = [];
    for (const [index, column] of columns.entries()) {
      if (!column.group) { top.push('<th scope="col" rowspan="2">' + sortHead(column) + '</th>'); continue; }
      if (columns[index - 1]?.group !== column.group) {
        const open = deviceSheet[column.group + 'Open'], label = deviceGroups[column.group].label;
        top.push('<th scope="colgroup" class="hc-device-group-head" colspan="' + columns.filter(item => item.group === column.group).length + '"><button type="button" class="hc-device-group" data-action="toggle-device-group" data-group="' + column.group + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Collapse ' : 'Expand ') + label + '"><span class="hc-device-group-box" aria-hidden="true">' + (open ? '−' : '+') + '</span>' + label + '</button></th>');
      }
      fields.push('<th scope="col">' + sortHead(column) + '</th>');
    }
    return '<colgroup>' + columns.map(column => '<col style="width:' + column.width + 'px">').join('') + '</colgroup><thead><tr>' + top.join('') + '</tr><tr>' + fields.join('') + '</tr></thead>';
  }
  function deviceCell(d, column, index) {
    const net = deviceNetwork(d), id = esc(d.id), busy = deviceBusy(d.id);
    const input = (field, value, label, disabled = false) => '<input class="hc-cell-input hc-mono" data-device-cell="' + id + ':' + field + '" value="' + esc(value ?? '') + '" aria-label="' + esc(label + ' for ' + d.name) + '"' + (disabled ? ' disabled' : '') + ' spellcheck="false" autocomplete="off">';
    const cell = (content, changed = false, extra = '') => '<td data-device-column="' + column.id + '"' + (changed ? ' class="hc-changed"' : '') + extra + '>' + content + '</td>';
    const waiting = rows => { const count = rows.filter(row => row?.pending).length; return count ? '<span class="hc-device-waiting">+' + count + ' pending</span>' : ''; };
    const quiet = text => '<span class="hc-muted">' + esc(text) + '</span>';
    switch (column.id) {
      case 'row': return cell(quiet(String(index + 1)));
      case 'name': return cell('<input class="hc-cell-input hc-device-name" data-device-cell="' + id + ':name" data-device-setting="name" data-device-id="' + id + '" value="' + esc(d.name) + '" aria-label="Device name for ' + esc(d.serial) + '" maxlength="160">');
      case 'type': return cell(quiet(d.kind));
      case 'serial': return cell('<span class="hc-mono hc-muted">' + esc(d.serial) + '</span>');
      case 'status': return cell(status(d.online), false, ' data-device-status="' + id + '"');
      case 'base': return cell('<span class="hc-mono hc-muted">' + esc(d.base || '') + '</span>');
      case 'lan1': return cell(input('lan1', net.lan[0]?.planned, 'LAN IP', busy) + (deviceSheet.lanOpen ? '' : waiting(net.lan.slice(1))), !!net.lan[0]?.pending);
      case 'lan2': return cell(input('lan2', net.lan[1]?.planned, 'LAN IP 2', busy) + waiting(net.lan.slice(2)), !!net.lan[1]?.pending);
      case 'wan': return cell(net.wan ? (net.wan.dhcp || net.wan.current ? esc(net.wan.dhcp ? 'DHCP' : net.wan.current) : quiet('Not set')) + waiting([net.wan]) : quiet('—'), !!net.wan?.pending);
      // The controllers haven't shown how a WAN address or DHCP is written, so these two are read, not set.
      case 'wanMode': return cell(net.wan ? quiet(net.wan.dhcp ? 'DHCP' : net.wan.current ? 'Static' : 'Not set') : quiet('—'), false, ' title="WAN mode can’t be set from Hubble yet. Gateway and DNS can."');
      case 'wanIp': return cell(net.wan ? '<span class="hc-mono hc-muted">' + esc(net.wan.dhcp ? '' : net.wan.current) + '</span>' : '', false, ' title="A WAN address can’t be set from Hubble yet. Gateway and DNS can."');
      case 'gateway': case 'dns1': case 'dns2': return cell(net.wan ? input(column.id, net.wan[column.id], column.label, busy || net.wan.dhcp) : '', !!net.wan?.dirty.has(column.id));
      case 'connected': return cell(quiet(deviceConnectedOn(d)), false, ' data-device-connected="' + id + '"');
      case 'cameras': return cell(deviceCamerasMarkup(d), false, ' data-device-cameras="' + id + '"');
      case 'sync': return cell(resultMark(deviceSyncText(d)), false, ' data-device-sync="' + id + '"');
      default: return cell('<button type="button" class="hc-row-remove-button" data-action="remove-device" data-id="' + id + '" aria-label="Remove ' + esc(d.name) + ' from this list" title="Remove ' + esc(d.name) + ' from this list. Nothing is deleted on the device."' + (busy ? ' disabled' : '') + '>' + icon('trash-2') + '</button>');
    }
  }
  // Clearing a controller's cameras starts from its own row, after a confirmation.
  function deviceCamerasMarkup(d) {
    const count = deviceCameraCount(d);
    if (!count) return '<span class="hc-device-camera-count">0</span>';
    return '<span class="hc-device-camera-count">' + count + '</span><button type="button" class="hc-clear-cameras" data-action="clear-device-cameras" data-id="' + esc(d.id) + '" aria-label="Clear all cameras on ' + esc(d.name) + '" title="Deletes every camera configuration on ' + esc(d.name) + ', after you confirm"' + (deviceBusy(d.id) || sendsRunning > 0 ? ' disabled' : '') + '>' + icon('eraser') + 'Clear all</button>';
  }
  const foundDevices = () => results.filter(candidate => !devices.some(d => d.serial === candidate.serial));
  function deviceSheetFocus() {
    const element = document.activeElement;
    if (!element?.closest?.('[data-role="device-sheet"]')) return null;
    const key = element.dataset.deviceCell ?? (element.hasAttribute('data-device-add') ? 'add' : '');
    return key ? { key, value: element.value, start: element.selectionStart, end: element.selectionEnd } : null;
  }
  function renderDeviceSheet() {
    const host = $('device-sheet');
    if (!host) return;
    const focus = deviceSheetFocus(), left = host.querySelector('.hc-scroll')?.scrollLeft || 0, columns = deviceSheetColumns(), list = orderedDevices(), found = foundDevices();
    if (selectedDeviceId && !device(selectedDeviceId)) selectedDeviceId = '';
    const rows = list.map((d, index) => '<tr data-device-row="' + esc(d.id) + '"' + (d.id === selectedDeviceId ? ' class="hc-device-selected"' : '') + '>' + columns.map(column => deviceCell(d, column, index)).join('') + '</tr>').join('');
    const span = columns.length - 7;
    const foundRows = found.map(candidate => '<tr class="hc-device-found" data-device-found="' + esc(candidate.id) + '"><td><span class="hc-muted">+</span></td><td>' + esc(candidate.name || candidate.serial) + '</td><td></td><td><span class="hc-muted">' + esc(candidate.kind || '') + '</span></td><td><span class="hc-mono hc-muted">' + esc(candidate.serial) + '</span></td><td><span class="hc-found-tag">Found</span></td><td><span class="hc-mono hc-muted">' + esc(candidate.base || candidate.address || '') + '</span></td><td colspan="' + span + '"><button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(candidate.id) + '" aria-label="Add ' + esc(candidate.name || candidate.serial) + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button></td></tr>').join('');
    const addRow = '<tr class="hc-device-add"><td><span class="hc-muted">+</span></td><td colspan="5"><span class="hc-muted">New device</span></td><td><input class="hc-cell-input hc-mono" data-device-add placeholder="Type an IP" aria-label="IP address of a device to add" spellcheck="false" autocomplete="off"' + (deviceAddBusy ? ' disabled' : '') + '></td><td colspan="' + span + '"><span class="hc-muted" data-role="device-add-note">' + esc(deviceAddNote || 'Type or paste an IP and press Enter. Hubble finds the device and fills in the row.') + '</span></td></tr>';
    host.innerHTML = '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" data-device-sheet aria-label="Devices" style="width:' + columns.reduce((total, column) => total + column.width, 0) + 'px">' + deviceSheetHeader(columns) + '<tbody>' + rows + foundRows + addRow + '</tbody></table></div></div>';
    const scroll = host.querySelector('.hc-scroll');
    if (scroll) scroll.scrollLeft = left;
    icons();
    if (focus) {
      const element = focus.key === 'add' ? host.querySelector('[data-device-add]') : host.querySelector('[data-device-cell="' + CSS.escape(focus.key) + '"]');
      if (element && !element.disabled) {
        if (element.tagName === 'INPUT') element.value = focus.value;
        element.focus({ preventScroll: true });
        try { element.setSelectionRange?.(focus.start, focus.end); } catch { /* A select has no caret. */ }
      }
    }
    paintDeviceView();
    paintDeviceSheet();
  }
  // Status and counts change without anyone editing, so they are painted in place and typing isn't interrupted.
  function paintDeviceSheet() {
    const host = $('device-sheet');
    if (!host) return;
    // Compared with what was last painted, not with the cell, because icons are drawn in after the
    // markup lands. Redrawing a cell under a click would swallow the click.
    const set = (attribute, id, markup) => { const cell = host.querySelector('[' + attribute + '="' + CSS.escape(id) + '"]'); if (cell && (cell.dataset.painted ?? cell.innerHTML) !== markup) { cell.innerHTML = markup; cell.dataset.painted = markup; } };
    for (const d of devices) {
      set('data-device-status', d.id, status(d.online));
      set('data-device-connected', d.id, '<span class="hc-muted">' + esc(deviceConnectedOn(d)) + '</span>');
      set('data-device-cameras', d.id, deviceCamerasMarkup(d));
      set('data-device-sync', d.id, resultMark(deviceSyncText(d)));
    }
    for (const row of host.querySelectorAll('tr[data-device-row]')) row.classList.toggle('hc-device-selected', row.dataset.deviceRow === selectedDeviceId);
    icons();
    const found = foundDevices().length;
    $('found-summary').textContent = found ? found + ' found' : '';
    const addAll = action('add-all-found');
    addAll.hidden = !found;
    addAll.disabled = deviceAddBusy;
    addAll.querySelector('[data-add-all-label]').textContent = 'Add all ' + found;
    $('device-summary').textContent = devices.length + (devices.length === 1 ? ' device' : ' devices') + ' · ' + devices.filter(d => d.online).length + ' online';
    if (!deviceSheet.details) $('lan-foot').textContent = 'Click a heading to sort. Address changes wait in Pending sends until you press Send.';
  }
  function paintDeviceView() {
    for (const button of root.querySelectorAll('[data-device-view]')) button.setAttribute('aria-pressed', String((button.dataset.deviceView === 'details') === deviceSheet.details));
    $('device-sheet-group').hidden = deviceSheet.details;
    $('network-devices').hidden = !deviceSheet.details;
    action('toggle-all-network').hidden = !deviceSheet.details;
    action('add-ip').hidden = !deviceSheet.details;
    // On the sheet, finding devices is one line in its toolbar, and what it finds lists as rows. The
    // Details view keeps its card, so the controls move back into it there.
    discoveryCard.hidden = !deviceSheet.details;
    placeScanControls(deviceSheet.details);
  }
  const scanControlHomes = [];
  function placeScanControls(inCard) {
    const bar = $('scan-bar'), parts = [root.querySelector('.hc-scan-controls'), $('discovery-error'), root.querySelector('.hc-scan-status')].filter(Boolean);
    if (!bar || !parts.length) return;
    if (!scanControlHomes.length) for (const part of parts) { const home = document.createComment('scan control'); part.before(home); scanControlHomes.push([part, home]); }
    for (const [part, home] of scanControlHomes) {
      if (inCard) { if (part.parentElement === bar) home.after(part); }
      else if (part.parentElement !== bar) bar.append(part);
    }
  }
  // Every found device that isn't in the list yet is added in one go.
  async function addAllFound() {
    const found = foundDevices();
    if (!found.length || deviceAddBusy) return;
    selectedResults.clear();
    for (const candidate of found) selectedResults.add(candidate.id);
    deviceAddBusy = true;
    renderDeviceSheet();
    try {
      if (moduleBridge && !moduleBridge.preview) await addLiveResults();
      else addResults();
    } catch (error) { toast(error.message); }
    finally { deviceAddBusy = false; renderResults(); renderLans(); }
  }

  const maskOf = (value, fallback) => String(value ?? '').split('/')[1] || fallback;
  const cidr = value => { const parts = String(value).split('/'); return parts.length === 2 && ipv4(parts[0]) && /^\d{1,2}$/.test(parts[1]) && Number(parts[1]) <= 32; };
  function commitDeviceCell(id, field, raw) {
    const d = device(id);
    if (!d || deviceBusy(id)) return;
    const net = deviceNetwork(d), value = String(raw).trim(), mask = maskOf(net.lan[0]?.current, '16');
    const refuse = message => { toast(message); renderLans(); };
    if (field === 'lan1' || field === 'lan2') {
      // The second column only means something once there is a first address.
      const row = field === 'lan1' || !net.lan.length ? net.lan[0] : net.lan[1];
      if (!value) {
        if (row?.pending) cancelLanDrafts(id, row.id);
        else if (row) refuse('An address can be changed here, but not removed.');
        else renderLans();
        return;
      }
      const planned = value.includes('/') ? value : value + '/' + maskOf(row?.current, mask);
      if (!cidr(planned)) { refuse('Enter an address such as 10.20.101.212/16'); return; }
      if (lans.some(other => other !== row && plainAddress(other.planned) === plainAddress(planned) && other.device !== id)) toast(plainAddress(planned) + ' is already set on ' + (device(lans.find(other => other !== row && plainAddress(other.planned) === plainAddress(planned)).device)?.name ?? 'another device'));
      if (!row) {
        if (lans.length >= 1024) { refuse('Network row capacity reached'); return; }
        lans.push({ id: 'new-lan-' + crypto.randomUUID(), device: id, type: 'LAN', iface: lans.find(item => item.device === id && item.readOnly)?.iface || d.interfaces?.[0] || 'LAN1', current: '', planned, operation: 'Add', pending: true, result: 'Pending', dhcp: false, gateway: '', dns1: '', dns2: '', dirty: new Set(['planned']), revision: 0, jobs: 0 });
      } else if (planned === row.current && row.elementKey) { if (row.pending) { cancelLanDrafts(id, row.id); return; } }
      else if (planned !== row.planned) stageCell(row, 'planned', planned, true);
    } else {
      const wan = net.wan;
      if (!wan) return;
      if (!['gateway', 'dns1', 'dns2'].includes(field)) return;
      if (value && !ipv4(value)) { refuse('Enter a valid IP address'); return; }
      if (value !== String(wan[field] ?? '')) stageCell(wan, field, value, true);
    }
    renderLans();
    remember();
  }

  // Adding by IP reads the device at that address and adds it, the same way Find by IP then Add does.
  async function addDevicesByIp(text) {
    const addresses = [...new Set(String(text).split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];
    if (!addresses.length || deviceAddBusy) return;
    const notes = [];
    deviceAddBusy = true;
    try {
      for (const address of addresses) {
        if (!ipv4(address)) { notes.push(address + ' is not a valid IP address.'); continue; }
        const known = devices.find(d => [d.base, d.address, d.alias].includes(address) || lans.some(row => row.device === d.id && plainAddress(row.current) === address));
        if (known) { notes.push(address + ' is already in the list as ' + known.name + '.'); continue; }
        deviceAddNote = 'Looking for a device at ' + address + '…';
        renderDeviceSheet();
        try {
          if (moduleBridge && !moduleBridge.preview) {
            const candidate = (await moduleBridge.probe(address)).device, existing = devices.find(d => d.serial === candidate.serial);
            if (existing) { notes.push(address + ' is ' + existing.name + ', which is already in the list.'); continue; }
            manualDiscoveries.set(candidate.serial, candidate);
            mergeDiscoveries();
            await addFoundDevice(candidate.id);
          } else {
            const before = devices.length;
            $('manual-ip').value = address;
            probeIP();
            await addFoundDevice(results.find(candidate => [candidate.base, candidate.alias].includes(address))?.id);
            if (devices.length === before) notes.push('No device was found at ' + address + '.');
          }
        } catch (error) { notes.push(address + ': ' + (error.message || 'no Cyanview device answered')); }
      }
    } finally {
      deviceAddBusy = false;
      deviceAddNote = notes.join(' ');
      renderLans();
    }
  }
  async function addFoundDevice(id) {
    if (!id) return;
    const kept = [...selectedResults].filter(other => other !== id);
    selectedResults.clear();
    selectedResults.add(id);
    try {
      if (moduleBridge && !moduleBridge.preview) await addLiveResults();
      else addResults();
    } finally { for (const other of kept) selectedResults.add(other); renderResults(); }
  }

  // Everything on one controller goes at once, after a confirmation, over one connection. A camera
  // that lives on another controller stays there and only its copy here is removed.
  function reviewDeviceClear(id) {
    const d = device(id);
    if (!d) return;
    const rows = cameras.filter(camera => camera.device === id), copies = rows.filter(importedCamera).length;
    const shared = rows.filter(camera => !importedCamera(camera) && Object.keys(actualRoute(camera).links).length).length;
    const lines = ['<div class="hc-change-item"><div><strong>Deletes all ' + rows.length + (rows.length === 1 ? ' camera configuration' : ' camera configurations') + ' from ' + esc(d.name) + '</strong></div><small>This goes to the controller as soon as you confirm. It can’t be undone from Hubble.</small></div>'];
    if (copies) lines.push('<div class="hc-change-item"><small>' + copies + (copies === 1 ? ' is a copy' : ' are copies') + ' of a camera set up on another controller. Those cameras stay where they are, and only the ' + (copies === 1 ? 'copy' : 'copies') + ' on ' + esc(d.name) + (copies === 1 ? ' is' : ' are') + ' removed.</small></div>');
    if (shared) lines.push('<div class="hc-change-item"><small>' + shared + (shared === 1 ? ' camera' : ' cameras') + ' set up here ' + (shared === 1 ? 'is' : 'are') + ' also on other RCPs, and ' + (shared === 1 ? 'comes' : 'come') + ' off those too.</small></div>');
    if (d.online === false) lines.push('<div class="hc-change-item"><small class="hc-error-text">' + esc(d.name) + ' reads Offline, so this will probably fail and change nothing.</small></div>');
    $('modal-layer').innerHTML = '<section class="hc-modal" role="dialog" aria-modal="true" aria-label="Clear all cameras on ' + esc(d.name) + '"><div class="hc-modal-head"><div><h3>Clear all cameras on ' + esc(d.name) + '?</h3><p>' + esc(d.serial + ' · ' + (d.address || d.base)) + '</p></div><button data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="hc-modal-body">' + lines.join('') + '</div><div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button><button class="hc-danger hc-danger-solid" data-clear-device-confirm="' + esc(id) + '">Delete ' + rows.length + (rows.length === 1 ? ' camera' : ' cameras') + '</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('.hc-modal-foot [data-action="close-modal"]').focus();
  }
  function clearDeviceCameras(id) {
    const d = device(id);
    if (!d) return;
    return enqueueSend(async () => {
      const rows = cameras.filter(camera => camera.device === id && !movesInFlight.has(camera)), own = rows.filter(camera => !importedCamera(camera));
      // A camera that never reached the controller has nothing to delete there.
      const unsent = own.filter(camera => !camera.elementKey && !camera.createState);
      cameras = cameras.filter(camera => !unsent.includes(camera));
      for (const camera of own) { delete camera.routeDraft; delete camera.removeStaged; }
      await removeCameras(own.filter(camera => camera.elementKey));
      if (moduleBridge && !moduleBridge.preview) {
        routeTreeMemo = null;
        const copies = cameras.filter(camera => camera.device === id && importedCamera(camera) && camera.elementKey), items = [], routed = new Map();
        for (const copy of copies) {
          const source = sourceRowOf(copy);
          if (!source) continue;
          // Whatever came through this controller now comes from where it got the camera.
          const links = { ...actualRoute(source).links }, parent = links[id];
          delete links[id];
          for (const receiver of Object.keys(links)) if (links[receiver] === id) links[receiver] = parent;
          items.push({ id: source.id, camera: source.device, key: source.elementKey, tree: links, expected: actualRoute(source).links, copies: actualRoute(source).keys });
          routed.set(copy, source.id);
        }
        const report = items.length ? await requestRoutes(items) : { results: [] };
        // A copy whose camera can't be reached or traced is taken off this controller by itself.
        const left = copies.filter(copy => cameras.includes(copy) && !report.results?.find(result => result.id === routed.get(copy))?.verified);
        const entries = left.filter(copy => copy.remi), loose = left.filter(copy => !copy.remi);
        if (entries.length) {
          try {
            const removed = await moduleBridge.remiSend({ receiver: id, items: entries.map(copy => ({ id: 'remove:' + copy.elementKey, kind: 'remove', key: copy.elementKey, enable: false, selector: copy.remi.selector, connection: copy.remi.connection, label: copy.name })) });
            if (removed.snapshot) mergeOwn(removed.snapshot);
          } catch { /* What is left is counted below. */ }
        }
        if (loose.length) {
          try { await moduleBridge.send({ items: loose.map(copy => ({ kind: 'camera', deleting: true, orphan: true, item: plainRow(copy), fields: [] })) }); }
          catch { /* What is left is counted below. */ }
        }
        try { for (const snapshot of (await moduleBridge.refresh([id])).snapshots || []) mergeOwn(snapshot); } catch { /* The count below says what is still there. */ }
      }
      routeTreeMemo = null;
      renderLans();
      renderCameras();
      remember();
      const remaining = cameras.filter(camera => camera.device === id).length;
      toast(remaining ? remaining + (remaining === 1 ? ' camera is' : ' cameras are') + ' still on ' + d.name + '. Check that it is reachable, then try again.' : 'All cameras cleared from ' + d.name);
      void loadRemiJobs();
    });
  }

  function createDeviceSheet() {
    const list = $('network-devices'), toolbar = action('review-lan').closest('.hc-toolbar');
    toolbar.querySelector('.hc-toolbar-title h3').textContent = 'Devices';
    toolbar.insertAdjacentHTML('beforeend', '<div class="hc-segment hc-device-view" role="group" aria-label="Devices view"><button type="button" data-device-view="sheet" aria-pressed="true">Sheet</button><button type="button" data-device-view="details" aria-pressed="false">Details</button></div>' +
      pendingSendsToggle());
    const body = document.createElement('div'), column = document.createElement('div');
    body.className = 'hc-assignment-body';
    body.dataset.pendingHost = 'devices';
    column.className = 'hc-device-column';
    column.innerHTML = '<div class="hc-controller-list"><section class="hc-controller" data-role="device-sheet-group"><div class="hc-controller-tools">' +
      '<div class="hc-scan-bar" data-role="scan-bar"></div><span class="hc-right"></span><span class="hc-found-count" data-role="found-summary" aria-live="polite"></span>' +
      '<button class="hc-primary" data-action="add-all-found" hidden>' + icon('plus') + '<span data-add-all-label>Add all</span></button></div><div data-role="device-sheet"></div></section></div>';
    list.before(body);
    body.append(column);
    column.append(list);
    discoveryCard.addEventListener('toggle', paintDeviceView);
    if ($('scan-label').textContent === 'No scan running') $('scan-label').textContent = '';
    paintDeviceView();
  }
  const initializeDeviceCards = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() { initializeDeviceCards(); createDeviceSheet(); };
  const renderNetworkCards = renderLans;
  renderLans = function() { const drawn = renderNetworkCards(); renderDeviceSheet(); return drawn; };
  const renderDiscoveryResults = renderResults;
  renderResults = function() { renderDiscoveryResults(); paintFoundList(); renderDeviceSheet(); };
  // The Details view's list of found devices has an Add on each one and Add all, not ticks.
  function paintFoundList() {
    for (const box of root.querySelectorAll('input[data-select-found]')) {
      box.closest('td').innerHTML = box.disabled ? '' : '<button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(box.dataset.selectFound) + '" aria-label="Add ' + esc(results.find(candidate => candidate.id === box.dataset.selectFound)?.serial ?? 'device') + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button>';
    }
    const found = foundDevices().length, button = action('add-discovered');
    button.innerHTML = 'Add all <span data-role="found-selected">' + found + '</span>';
    button.disabled = !found || deviceAddBusy;
    icons();
  }
  root.addEventListener('click', event => {
    if (!event.target.closest('[data-action="add-discovered"]')) return;
    event.stopImmediatePropagation();
    void addAllFound();
  }, true);
  const syncLiveConnections = syncConnections;
  syncConnections = function() { syncLiveConnections(); paintDeviceSheet(); };
  const syncBeforeDeviceSheet = syncSummary;
  syncSummary = function() { syncBeforeDeviceSheet(); paintDeviceSheet(); };

  root.addEventListener('click', event => {
    const row = event.target.closest('tr[data-device-row]');
    if (row && row.dataset.deviceRow !== selectedDeviceId) { selectedDeviceId = row.dataset.deviceRow; paintDeviceSheet(); }
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.deviceSort) sortDevices(data.deviceSort);
    else if (data.deviceView) { deviceSheet.details = data.deviceView === 'details'; paintDeviceView(); renderLans(); remember(); }
    else if (data.action === 'toggle-device-group') { deviceSheet[data.group + 'Open'] = !deviceSheet[data.group + 'Open']; renderDeviceSheet(); root.querySelector('[data-action="toggle-device-group"][data-group="' + data.group + '"]')?.focus({ preventScroll: true }); remember(); }
    else if (data.action === 'add-all-found') void addAllFound();
    else if (data.action === 'add-found-device') { deviceAddBusy = true; renderDeviceSheet(); void addFoundDevice(data.id).catch(error => toast(error.message)).finally(() => { deviceAddBusy = false; renderLans(); }); }
    else if (data.action === 'clear-device-cameras' && device(data.id)) reviewDeviceClear(data.id);
    else if (data.clearDeviceConfirm) { $('modal-layer').hidden = true; void clearDeviceCameras(data.clearDeviceConfirm); }
  });
  root.addEventListener('focusin', event => {
    const row = event.target.closest?.('tr[data-device-row]');
    if (row && row.dataset.deviceRow !== selectedDeviceId) { selectedDeviceId = row.dataset.deviceRow; paintDeviceSheet(); }
  });
  root.addEventListener('change', event => {
    const element = event.target;
    if (!element.dataset?.deviceCell || element.dataset.deviceSetting) return;
    const [id, field] = [element.dataset.deviceCell.slice(0, element.dataset.deviceCell.lastIndexOf(':')), element.dataset.deviceCell.slice(element.dataset.deviceCell.lastIndexOf(':') + 1)];
    commitDeviceCell(id, field, element.value);
  });
  root.addEventListener('keydown', event => {
    const element = event.target;
    if (event.key === 'Enter' && element.dataset?.deviceCell && element.tagName === 'INPUT') { event.preventDefault(); element.blur(); }
    else if (event.key === 'Escape' && element.dataset?.deviceCell && element.tagName === 'INPUT') { event.stopPropagation(); renderDeviceSheet(); }
    else if (event.key === 'Enter' && element.hasAttribute?.('data-device-add')) { event.preventDefault(); void addDevicesByIp(element.value); }
  });
  root.addEventListener('paste', event => {
    const element = event.target, text = event.clipboardData?.getData('text') ?? '';
    // Several addresses pasted at once add several devices.
    if (!element.hasAttribute?.('data-device-add') || !/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    void addDevicesByIp(text);
  });
