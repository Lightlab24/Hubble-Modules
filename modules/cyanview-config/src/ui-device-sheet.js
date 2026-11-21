  // The Devices tab as one sheet: a row per controller with its addresses as columns. LAN and WAN
  // settings fold away behind their own groups. A device is added by typing its IP in the last row,
  // and found devices list under the managed ones, each with its own Add. It replaced a card per
  // device, and its edits still go through the same LAN rows and sends those cards used.
  // The remove button sits beside the name, where it is on the camera sheets.
  const deviceSheet = { lanOpen: false, wanOpen: false, sort: null };
  let selectedDeviceId = '', deviceAddNote = '', deviceAddBusy = false, committingDeviceCell = '';
  // The cell that has been typed in since the keyboard came to it. Only that cell has something to
  // commit when it is left, and only that cell keeps its own text through a redraw.
  let typedDeviceCell = '';
  // Text committed while its device was mid-send waits here, and goes in when the send finishes.
  const heldDeviceEdits = new Map();
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
  // A controller's own web page, opened in Safari from its address. A module page can't open a window
  // itself, so it asks the module to. An address that isn't one yet stays plain text.
  const openableAddress = value => { const address = plainAddress(value).trim(); return moduleBridge?.openDevicePage && ipv4(address) ? address : ''; };
  // An address that is only shown is the link.
  function pageLink(value, name) {
    const address = openableAddress(value);
    if (!address) return '<span class="hc-mono hc-muted">' + esc(value || '') + '</span>';
    return '<button type="button" class="hc-ip-link hc-mono" data-action="open-device-page" data-address="' + esc(address) + '" aria-label="' + esc('Open ' + name + ' at ' + address + ' in Safari') + '" title="' + esc('Open ' + address + ' in Safari') + '">' + esc(address) + '</button>';
  }
  // An address that can be typed over keeps its box. A small button beside it opens the address the device has now.
  // The button never takes the keyboard: Tab still goes from one box to the next, and a box being typed in keeps its caret.
  function pageOpener(row, name) {
    const address = openableAddress(row?.current);
    return address ? '<button type="button" class="hc-ip-open" tabindex="-1" data-action="open-device-page" data-address="' + esc(address) + '" aria-label="' + esc('Open ' + name + ' at ' + address + ' in Safari') + '" title="' + esc('Open ' + address + ' in Safari') + '">' + icon('external-link') + '</button>' : '';
  }
  root.addEventListener('mousedown', event => { if (event.target.closest?.('.hc-ip-open')) event.preventDefault(); });
  const pagesOpening = new Set();
  async function openDevicePage(address) {
    // A second click while Safari is still coming up would open the page twice.
    if (!openableAddress(address) || pagesOpening.has(address)) return;
    pagesOpening.add(address);
    try { await moduleBridge.openDevicePage(address); }
    catch (error) { toast(error.message || 'Could not open ' + address); }
    finally { pagesOpening.delete(address); }
  }
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
    const held = field => heldDeviceEdits.get(d.id + ':' + field);
    const input = (field, value, label, disabled = false) => '<input class="hc-cell-input hc-mono" data-device-cell="' + id + ':' + field + '" value="' + esc(held(field) ?? value ?? '') + '" aria-label="' + esc(label + ' for ' + d.name) + '"' + (disabled ? ' disabled' : '') + ' spellcheck="false" autocomplete="off">';
    const cell = (content, changed = false, extra = '') => '<td data-device-column="' + column.id + '"' + (changed || held(column.id) !== undefined ? ' class="hc-changed"' : '') + extra + '>' + content + '</td>';
    const waiting = rows => { const count = rows.filter(row => row?.pending).length; return count ? '<span class="hc-device-waiting">+' + count + ' pending</span>' : ''; };
    const quiet = text => '<span class="hc-muted">' + esc(text) + '</span>';
    switch (column.id) {
      case 'row': return cell(quiet(String(index + 1)));
      case 'name': return cell('<input class="hc-cell-input hc-device-name" data-device-cell="' + id + ':name" value="' + esc(d.name) + '" aria-label="Device name for ' + esc(d.serial) + '" maxlength="160">');
      case 'type': return cell(quiet(d.kind));
      case 'serial': return cell('<span class="hc-mono hc-muted">' + esc(d.serial) + '</span>');
      case 'status': return cell(status(d.online), false, ' data-device-status="' + id + '"');
      case 'base': return cell(pageLink(d.base, d.name));
      case 'lan1': return cell(input('lan1', net.lan[0]?.planned, 'LAN IP', busy) + pageOpener(net.lan[0], d.name) + (deviceSheet.lanOpen ? '' : waiting(net.lan.slice(1))), !!net.lan[0]?.pending);
      case 'lan2': return cell(input('lan2', net.lan[1]?.planned, 'LAN IP 2', busy) + pageOpener(net.lan[1], d.name) + waiting(net.lan.slice(2)), !!net.lan[1]?.pending);
      // Folded away, the WAN shows what it will be once sent.
      case 'wan': return cell(net.wan ? (net.wan.dhcp || net.wan.planned ? esc(net.wan.dhcp ? 'DHCP' : net.wan.planned) : quiet('Not set')) + waiting([net.wan]) : quiet('—'), !!net.wan?.pending);
      case 'wanMode': return cell(net.wan ? '<select class="hc-cell-input" data-device-cell="' + id + ':wanMode" aria-label="' + esc('WAN mode for ' + d.name) + '"' + (busy ? ' disabled' : '') + '>' + options(['DHCP', 'Static'], held('wanMode') ?? (net.wan.dhcp ? 'DHCP' : 'Static')) + '</select>' : quiet('—'), !!net.wan?.dirty.has('dhcp'));
      case 'wanIp': return cell(net.wan ? input('wanIp', net.wan.dhcp ? '' : net.wan.planned, 'WAN IP', busy || net.wan.dhcp) + pageOpener(net.wan, d.name) : '', !!net.wan && !net.wan.dhcp && net.wan.dirty.has('planned'));
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
  // What a redraw leaves in place: the box in use, or the cell around a list or button that is in use.
  function deviceSheetKept(host) {
    const active = document.activeElement;
    if (!active || !host.contains(active)) return null;
    if (active.dataset.deviceCell) return { kept: active, find: next => next.querySelector('[data-device-cell="' + CSS.escape(active.dataset.deviceCell) + '"]') };
    // The New device box is put away while a lookup runs, as it always has been.
    if (active.hasAttribute('data-device-add')) return { kept: active, find: next => next.querySelector('[data-device-add]:not([disabled])') };
    const cell = active.closest('td[data-device-column]'), row = cell?.closest('tr[data-device-row]');
    if (!row) return null;
    return { kept: cell, find: next => next.querySelector('tr[data-device-row="' + CSS.escape(row.dataset.deviceRow) + '"] td[data-device-column="' + CSS.escape(cell.dataset.deviceColumn) + '"]') };
  }
  function renderDeviceSheet() {
    const host = $('device-sheet');
    if (!host) return;
    const focus = deviceSheetFocus(), left = host.querySelector('.hc-scroll')?.scrollLeft || 0, columns = deviceSheetColumns(), list = orderedDevices(), found = foundDevices();
    if (selectedDeviceId && !device(selectedDeviceId)) selectedDeviceId = '';
    const rows = list.map((d, index) => '<tr data-device-row="' + esc(d.id) + '"' + (d.id === selectedDeviceId ? ' class="hc-device-selected"' : '') + '>' + columns.map(column => deviceCell(d, column, index)).join('') + '</tr>').join('');
    const span = columns.length - 7;
    // Saved devices a search is checking come first, in the order they were saved.
    const saved = savedSearchRows(), savedSerials = new Set(saved.map(row => savedKey(row.item.serial)));
    const foundRows = saved.map(row => savedSearchRowMarkup(row, span)).join('') + found.filter(candidate => !savedSerials.has(savedKey(candidate.serial))).map(candidate => '<tr class="hc-device-found" data-device-found="' + esc(candidate.id) + '"><td><span class="hc-muted">+</span></td><td>' + esc(candidate.name || candidate.serial) + '</td><td></td><td><span class="hc-muted">' + esc(candidate.kind || '') + '</span></td><td><span class="hc-mono hc-muted">' + esc(candidate.serial) + '</span></td><td><span class="hc-found-tag">Found</span></td><td>' + pageLink(candidate.base || candidate.address, candidate.name || candidate.serial) + '</td><td colspan="' + span + '"><button type="button" class="hc-primary hc-add-found" data-action="add-found-device" data-id="' + esc(candidate.id) + '" aria-label="Add ' + esc(candidate.name || candidate.serial) + '"' + (deviceAddBusy ? ' disabled' : '') + '>' + icon('plus') + 'Add</button></td></tr>').join('');
    const addRow = '<tr class="hc-device-add"><td><span class="hc-muted">+</span></td><td colspan="5"><span class="hc-muted">New device</span></td><td><input class="hc-cell-input hc-mono" data-device-add placeholder="Type an IP" aria-label="IP address of a device to add" spellcheck="false" autocomplete="off"' + (deviceAddBusy ? ' disabled' : '') + '></td><td colspan="' + span + '"><span class="hc-muted" data-role="device-add-note">' + esc(deviceAddNote || 'Type or paste an IP and press Enter. Hubble finds the device and fills in the row.') + '</span></td></tr>';
    const markup = '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" data-device-sheet aria-label="Devices" style="width:' + columns.reduce((total, column) => total + column.width, 0) + 'px">' + deviceSheetHeader(columns) + '<tbody>' + rows + foundRows + addRow + '</tbody></table></div></div>';
    const keeping = deviceSheetKept(host), twin = redrawAround(host, markup, keeping?.kept, keeping?.find ?? (() => null));
    const scroll = host.querySelector('.hc-scroll');
    if (scroll && scroll.scrollLeft !== left) scroll.scrollLeft = left;
    icons();
    if (twin) {
      const kept = keeping.kept, key = kept.dataset.deviceCell ?? '';
      if (kept.tagName === 'TD') {
        // A list or button in this cell has the keyboard. The cell stays and shows what the device has.
        copyAttributes(kept, twin, ['data-painted']);
        const select = kept.querySelector('select'), other = twin.querySelector('select');
        if (select && other && select.value !== other.value) select.value = other.value;
        for (const button of kept.querySelectorAll('button[data-action]')) {
          const match = twin.querySelector('button[data-action="' + button.dataset.action + '"]');
          if (match && button.disabled !== match.disabled) button.disabled = match.disabled;
        }
      } else {
        // A cell being worked in is never greyed out under the keyboard. What is typed in it during a send waits for the send.
        copyAttributes(kept, twin, ['disabled']);
        const committed = key && key === committingDeviceCell;
        // Text typed here stays exactly as typed. A cell nobody has typed in follows what the device has.
        if (key && (committed || typedDeviceCell !== key) && kept.value !== twin.value) kept.value = twin.value;
        if (committed) kept.select?.();
      }
    } else if (focus) {
      // The sheet changed shape under the keyboard (a column group folded, a device left the list).
      const element = focus.key === 'add' ? host.querySelector('[data-device-add]') : host.querySelector('[data-device-cell="' + CSS.escape(focus.key) + '"]');
      if (element && !element.disabled) {
        const committed = focus.key === committingDeviceCell;
        if (element.tagName === 'INPUT' && !committed && (focus.key === 'add' || typedDeviceCell === focus.key)) element.value = focus.value;
        element.focus({ preventScroll: true });
        try { if (committed) element.select?.(); else element.setSelectionRange?.(focus.start, focus.end); } catch { /* A select has no caret. */ }
      } else if (focus.key === typedDeviceCell) typedDeviceCell = '';
    }
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
    $('lan-foot').textContent = 'Click a heading to sort. Address changes wait in Pending sends until you press Send.';
    releaseHeldDeviceEdits();
  }
  function releaseHeldDeviceEdits() {
    for (const [key, value] of heldDeviceEdits) {
      const id = key.slice(0, key.lastIndexOf(':'));
      if (device(id) && deviceBusy(id)) continue;
      heldDeviceEdits.delete(key);
      setTimeout(() => runDeviceCommit(key, value), 0);
    }
  }
  // Finding devices is one line in the sheet's toolbar, and what it finds lists as rows.
  function placeScanControls() {
    const bar = $('scan-bar');
    for (const part of [root.querySelector('.hc-scan-controls'), $('discovery-error'), root.querySelector('.hc-scan-status')]) if (part) bar.append(part);
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
    if (!d) return;
    const value = String(raw).trim(), refuse = message => { toast(message); renderLans(); };
    if (field === 'name') {
      if (!value || value.length > 160) { refuse('Enter a device name'); return; }
      if (value !== d.name) { d.name = value; syncFilter(); renderLans(); renderCameras(); remember(); }
      else renderLans();
      return;
    }
    // An address typed while this device is mid-send is kept, and goes in when the send finishes.
    if (deviceBusy(id)) { heldDeviceEdits.set(id + ':' + field, String(raw)); renderLans(); return; }
    const net = deviceNetwork(d), mask = maskOf(net.lan[0]?.current, '16');
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
      const onlyAddress = () => [...wan.dirty].every(dirty => dirty === 'planned' || dirty === 'dhcp');
      if (field === 'wanMode') {
        const dhcp = value === 'DHCP';
        if (dhcp === wan.dhcp) return;
        // Choosing the mode the device already has puts the WAN back the way the device has it. Its
        // gateway and DNS go back too, since DHCP blanks them and they can't be edited under it.
        if (dhcp === (wan.current === 'DHCP') && wan.pending) { cancelLanDrafts(id, wan.id); return; }
        stageCell(wan, 'dhcp', dhcp, true);
      } else if (field === 'wanIp') {
        if (wan.dhcp) return;
        // A WAN on Static can be left with no address, as the RIO's own page allows.
        if (!value) {
          if (!wan.planned) return;
          if (!wan.current && wan.pending && !wan.dirty.has('dhcp') && onlyAddress()) { cancelLanDrafts(id, wan.id); return; }
          stageCell(wan, 'planned', '', true);
        } else {
          const planned = value.includes('/') ? value : value + '/' + maskOf(wan.current, mask);
          if (!cidr(planned)) { refuse('Enter an address such as 10.20.101.212/16'); return; }
          if (planned === wan.current && wan.pending && !wan.dirty.has('dhcp') && onlyAddress()) { cancelLanDrafts(id, wan.id); return; }
          if (planned !== wan.planned) stageCell(wan, 'planned', planned, true);
        }
      } else {
        if (!['gateway', 'dns1', 'dns2'].includes(field)) return;
        if (value && !ipv4(value)) { refuse('Enter a valid IP address'); return; }
        if (value !== String(wan[field] ?? '')) stageCell(wan, field, value, true);
      }
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
    const panel = root.querySelector('#hc-devices'), toolbar = action('review-lan').closest('.hc-toolbar');
    toolbar.querySelector('.hc-toolbar-title h3').textContent = 'Devices';
    toolbar.insertAdjacentHTML('beforeend', pendingSendsToggle());
    const body = document.createElement('div'), column = document.createElement('div');
    body.className = 'hc-assignment-body';
    body.dataset.pendingHost = 'devices';
    column.className = 'hc-device-column';
    column.innerHTML = '<div class="hc-controller-list"><section class="hc-controller" data-role="device-sheet-group"><div class="hc-controller-tools">' +
      '<div class="hc-scan-bar" data-role="scan-bar"></div><span class="hc-right"></span><span class="hc-found-count" data-role="found-summary" aria-live="polite"></span>' +
      '<button class="hc-primary" data-action="add-all-found" hidden>' + icon('plus') + '<span data-add-all-label>Add all</span></button></div><div data-role="device-sheet"></div></section></div>';
    panel.querySelector(':scope > .hc-sheet').replaceWith(body);
    body.append(column);
    if ($('scan-label').textContent === 'No scan running') $('scan-label').textContent = '';
    placeScanControls();
  }
  const initializeDevicePanel = initializeDeviceWorkflow;
  initializeDeviceWorkflow = function() { initializeDevicePanel(); createDeviceSheet(); };
  // Found devices are rows in the sheet. The old finder's own table, with a tick on each, is never drawn.
  renderResults = function() { renderDeviceSheet(); };
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
    else if (data.action === 'toggle-device-group') { deviceSheet[data.group + 'Open'] = !deviceSheet[data.group + 'Open']; renderDeviceSheet(); root.querySelector('[data-action="toggle-device-group"][data-group="' + data.group + '"]')?.focus({ preventScroll: true }); remember(); }
    else if (data.action === 'add-all-found') void addAllFound();
    else if (data.action === 'add-found-device') { deviceAddBusy = true; renderDeviceSheet(); void addFoundDevice(data.id).catch(error => toast(error.message)).finally(() => { deviceAddBusy = false; renderLans(); }); }
    else if (data.action === 'clear-device-cameras' && device(data.id)) reviewDeviceClear(data.id);
    else if (data.action === 'open-device-page') void openDevicePage(data.address);
    else if (data.clearDeviceConfirm) { $('modal-layer').hidden = true; void clearDeviceCameras(data.clearDeviceConfirm); }
  });
  root.addEventListener('focusin', event => {
    const row = event.target.closest?.('tr[data-device-row]');
    if (row && row.dataset.deviceRow !== selectedDeviceId) { selectedDeviceId = row.dataset.deviceRow; paintDeviceSheet(); }
  });
  // A cell is committed once the focus has landed on the next one (Tab, a click, Enter), so the
  // redraw that follows finds the new cell in use and leaves it alone. Committing while the focus was
  // still moving left nothing focused, and typing after Tab went nowhere (Nov 17, 2026).
  function runDeviceCommit(key, value) {
    const id = key.slice(0, key.lastIndexOf(':')), field = key.slice(key.lastIndexOf(':') + 1);
    committingDeviceCell = key;
    try { commitDeviceCell(id, field, value); } finally { committingDeviceCell = ''; }
  }
  function scheduleDeviceCommit(element) {
    const key = element.dataset.deviceCell, value = element.value;
    if (typedDeviceCell === key) typedDeviceCell = '';
    setTimeout(() => runDeviceCommit(key, value), 0);
  }
  root.addEventListener('input', event => {
    const element = event.target;
    if (element.dataset?.deviceCell && element.tagName === 'INPUT') typedDeviceCell = element.dataset.deviceCell;
  });
  // Only leaving a cell that was typed in commits it. A redraw never does.
  root.addEventListener('focusout', event => {
    const element = event.target;
    if (redrawing || element.tagName !== 'INPUT' || !element.dataset?.deviceCell || typedDeviceCell !== element.dataset.deviceCell) return;
    scheduleDeviceCommit(element);
  });
  root.addEventListener('change', event => {
    const element = event.target;
    if (redrawing || element.tagName !== 'SELECT' || !element.dataset?.deviceCell) return;
    scheduleDeviceCommit(element);
  });
  // Enter commits and moves down to the same column on the next device, as in the Button Matrix.
  function deviceCellBelow(element) {
    const key = element.dataset.deviceCell, field = key.slice(key.lastIndexOf(':') + 1);
    const rows = [...root.querySelectorAll('[data-role="device-sheet"] tr[data-device-row]')];
    const index = rows.indexOf(element.closest('tr[data-device-row]'));
    for (const row of rows.slice(index + 1)) {
      const below = row.querySelector('[data-device-cell="' + CSS.escape(row.dataset.deviceRow + ':' + field) + '"]');
      if (below && !below.disabled) return below;
    }
    return null;
  }
  root.addEventListener('keydown', event => {
    const element = event.target;
    if (event.key === 'Enter' && element.dataset?.deviceCell && element.tagName === 'INPUT') {
      event.preventDefault();
      const below = deviceCellBelow(element);
      if (below) { below.focus({ preventScroll: false }); below.select?.(); }
      else if (typedDeviceCell === element.dataset.deviceCell) scheduleDeviceCommit(element);
      else element.select();
    }
    // Escape puts back what the cell held.
    else if (event.key === 'Escape' && element.dataset?.deviceCell && element.tagName === 'INPUT') {
      event.stopPropagation();
      if (typedDeviceCell === element.dataset.deviceCell) typedDeviceCell = '';
      element.value = element.defaultValue;
      element.select();
    }
    else if (event.key === 'Enter' && element.hasAttribute?.('data-device-add')) { event.preventDefault(); void addDevicesByIp(element.value); }
  });
  root.addEventListener('paste', event => {
    const element = event.target, text = event.clipboardData?.getData('text') ?? '';
    // Several addresses pasted at once add several devices.
    if (!element.hasAttribute?.('data-device-add') || !/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    void addDevicesByIp(text);
  });
