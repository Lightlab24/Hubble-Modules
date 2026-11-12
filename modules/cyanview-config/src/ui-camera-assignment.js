  // Camera Configuration is one list of every camera and where each one is set up. The REMI Matrix
  // is where a camera is attached to other RCPs, and it can also show the sheets of each controller.
  // A REMI copy is the same camera on another controller, so it shows in its source's row.
  //
  // A camera's copies go from its Source device to its Master RCP, then from the master to each
  // filled circle. With no master they go straight from the source. Nothing changes a controller
  // until it is sent from Pending sends, which every view shares.
  const controllerName = id => device(id)?.name || id;
  const sampleRouteMessage = 'REMI is available for managed devices.';
  let movedCameraSequence = 0;
  // The new copy of a camera being moved. The row on screen stays the original until the move is done.
  const movesInFlight = new Set();
  let routeTreeMemo = null;
  let pendingSendsOpen = false;
  let remiByController = false;
  const queuedSends = new Set();
  const routeErrors = new Map();
  // A camera with no Source yet isn't on any controller, so it is only ever saved with the page.
  const unassigned = camera => camera.device === '';

  const pendingAside = document.createElement('aside');
  (function createCameraTabs() {
    const configTab = root.querySelector('#hc-tab-cameras');
    configTab.dataset.tab = 'setup';
    configTab.setAttribute('aria-controls', 'hc-setup');
    const button = document.createElement('button');
    Object.assign(button, { className: 'hc-tab', id: 'hc-tab-assignment', innerHTML: 'REMI Matrix <span class="hc-tab-count" data-role="all-camera-count">0</span>' });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'hc-assignment');
    button.setAttribute('aria-selected', 'false');
    button.dataset.tab = 'assignment';
    configTab.after(button);
    const toggle = pendingSendsToggle();
    const viewSwitch = '<div class="hc-segment hc-remi-view" role="group" aria-label="REMI Matrix view"><button type="button" data-remi-view="matrix" aria-pressed="true">Matrix</button><button type="button" data-remi-view="controllers" aria-pressed="false">By controller</button></div>';
    const deleteButton = id => '<button class="hc-button" data-action="clear-selected" disabled title="Forget the selected cameras here. Nothing is sent to a controller.">' + icon('eye-off') + '<span data-camera-clear-label>Clear from view</span></button><button class="hc-danger" data-action="delete-controller" data-id="' + id + '" disabled>' + icon('trash-2') + '<span data-camera-delete-label>Delete camera</span></button>';
    const setup = document.createElement('section');
    Object.assign(setup, { id: 'hc-setup', className: 'hc-panel', hidden: true });
    setup.setAttribute('role', 'tabpanel');
    setup.setAttribute('aria-labelledby', 'hc-tab-cameras');
    setup.innerHTML =
      '<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>Cameras</h3><span data-role="setup-summary"></span></div>' + toggle + '</div>' +
      '<div class="hc-mode-note" data-role="setup-note"></div>' +
      '<div class="hc-assignment-body" data-pending-host="setup"><div class="hc-controller-list"><section class="hc-controller" data-role="setup-group">' +
        '<div class="hc-controller-tools">' +
          cameraCountControl(cameraSetupSheet) + '<span class="hc-caption hc-count-hint">New rows join the end</span>' +
          '<span class="hc-right"></span>' + deleteButton(cameraSetupSheet) +
        '</div>' +
        '<div data-role="setup-sheet"></div>' +
      '</section></div></div>' +
      '<div class="hc-panel-foot"><span data-role="setup-foot"></span></div>';
    const panel = document.createElement('section');
    Object.assign(panel, { id: 'hc-assignment', className: 'hc-panel', hidden: true });
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'hc-tab-assignment');
    panel.innerHTML =
      '<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>REMI matrix</h3><span data-role="assignment-summary"></span></div>' + viewSwitch + toggle + '</div>' +
      '<div class="hc-mode-note" data-role="assignment-note"></div>' +
      '<div class="hc-assignment-body" data-pending-host="assignment"><div class="hc-controller-list"><section class="hc-controller" data-role="assignment-group">' +
        '<div class="hc-controller-tools">' +
          '<span class="hc-right"></span>' + deleteButton(allCamerasSheet) +
        '</div>' +
        '<div data-role="assignment-sheet"></div>' +
      '</section></div></div>' +
      '<div class="hc-panel-foot"><span data-role="assignment-foot"></span></div>';
    const cameraPanel = root.querySelector('#hc-cameras');
    cameraPanel.before(setup);
    cameraPanel.after(panel);
    cameraPanel.setAttribute('aria-labelledby', 'hc-tab-assignment');
    // The sheets of each controller are another view of the matrix, beside the same list.
    const controllers = $('controllers'), body = document.createElement('div');
    body.className = 'hc-assignment-body';
    body.dataset.pendingHost = 'cameras';
    controllers.before(body);
    body.append(controllers);
    cameraPanel.querySelector('.hc-toolbar').insertAdjacentHTML('beforeend', viewSwitch + toggle);
    Object.assign(pendingAside, { className: 'hc-pending-sends', id: 'hc-pending-sends', hidden: true });
    pendingAside.dataset.role = 'pending-sends';
    pendingAside.setAttribute('aria-label', 'Pending sends');
    pendingAside.innerHTML =
      '<header><h3>Pending sends</h3><button type="button" data-action="toggle-pending-sends" aria-label="Close pending sends">' + icon('x') + '</button></header>' +
      '<p data-role="pending-sends-summary"></p>' +
      '<div class="hc-pending-actions"><button type="button" class="hc-primary" data-action="send-all-pending">Send all</button><button type="button" data-action="cancel-all-pending">Cancel all</button></div>' +
      '<div class="hc-pending-list" data-role="pending-sends-list"></div>';
    body.append(pendingAside);
  })();
  function pendingSendsToggle() {
    return '<button class="hc-button hc-pending-toggle" data-action="toggle-pending-sends" data-pending="false" aria-expanded="false" aria-controls="hc-pending-sends" aria-label="Pending sends"><span class="hc-pending-dot" aria-hidden="true"></span><span class="hc-pending-count" data-pending-sends-count hidden>0</span><span data-pending-sends-word>All sent</span>' + icon('chevron-down') + '</button>' +
      '<button class="hc-primary hc-pending-quick" data-action="send-all-pending-quick" hidden>' + icon('send') + '<span data-pending-quick-label>Send</span></button>';
  }
  function placePendingSends() {
    const host = root.querySelector('[data-pending-host="' + tab + '"]');
    if (host && pendingAside.parentElement !== host) host.append(pendingAside);
    // The list floats over the sheet just under its toolbar, so the toolbar's buttons stay in reach.
    const tools = host?.querySelector('.hc-controller-tools');
    pendingAside.style.top = tools ? Math.max(0, tools.getBoundingClientRect().bottom - host.getBoundingClientRect().top) + 'px' : '';
  }

  // Number and name stay frozen, then where the camera starts and its master, then a circle per RCP.
  function arrangeAllCameraColumns(columns) {
    const frozen = columns.filter(column => column.frozen !== undefined), sync = columns.filter(column => column.id === 'sync');
    return [...frozen, { id: 'source', label: 'Source', width: 140 }, { id: 'remiMaster', label: 'Master RCP', width: 140 },
      ...routeReceivers().map(d => ({ id: 'remi:' + d.id, label: d.name, width: Math.max(84, Math.min(150, d.name.length * 8 + 24)) })), ...sync];
  }

  // Which row each copy came from. Reading a copy's source is a search of every row, and a
  // redraw asks for each row's route several times, so one pass answers a whole draw.
  function routeTree() {
    if (routeTreeMemo) return routeTreeMemo;
    const owners = new Map(devices.map(d => [String(d.serial).toLowerCase(), d]));
    const byKey = new Map(cameras.filter(row => row.elementKey).map(row => [row.device + '\n' + row.elementKey, row]));
    const parents = new Map(), children = new Map();
    for (const row of cameras) {
      const info = row.remi, owner = info && owners.get(String(info.peer ?? '').toLowerCase());
      if (!owner) continue;
      let parent = info.sourceKey ? byKey.get(owner.id + '\n' + info.sourceKey) : undefined;
      if (!info.sourceKey && info.label) {
        const named = cameras.filter(camera => camera.device === owner.id && camera.elementKey && (camera.number + ' ' + camera.name).trim() === info.label);
        if (named.length === 1) parent = named[0];
      }
      if (!parent || parent === row) continue;
      parents.set(row, parent);
      children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    routeTreeMemo = { parents, children };
    queueMicrotask(() => { routeTreeMemo = null; });
    return routeTreeMemo;
  }
  // A copy whose source isn't in this workspace keeps its own row, since nothing else can show it.
  function assignmentRows() {
    const { parents } = routeTree();
    return cameras.filter(camera => !movesInFlight.has(camera) && (!importedCamera(camera) || !parents.has(camera)));
  }
  function sheetCameras(id) {
    return id === cameraSetupSheet ? assignmentRows() : id === allCamerasSheet ? matrixRows() : cameras.filter(camera => camera.device === id);
  }
  function matrixRows() { return assignmentRows().filter(camera => !unassigned(camera)); }
  // The camera a copy was made from, however many copies away.
  function sourceRowOf(copy) {
    const { parents } = routeTree();
    let row = copy;
    for (let hops = 0; parents.has(row) && hops < 8; hops++) row = parents.get(row);
    return row === copy || importedCamera(row) ? null : row;
  }

  // Where the camera really is: the controller it is set up on, and every copy and where that comes from.
  function actualRoute(camera) {
    const { children } = routeTree(), kids = row => children.get(row) ?? [];
    const links = {}, keys = {}, copies = [], seen = new Set([camera]);
    (function walk(row) {
      for (const copy of kids(row)) {
        if (seen.has(copy)) continue;
        seen.add(copy);
        copies.push(copy);
        links[copy.device] = row.device;
        // Where the copy sits on its controller, so a send can go straight to it.
        if (copy.elementKey) keys[copy.device] = copy.elementKey;
        walk(copy);
      }
    })(camera);
    const fixed = copies.length !== Object.keys(links).length || copies.some(copy => !canBeMaster(device(copy.device)));
    return { source: camera.device, links, fixed, keys };
  }
  function wantedRoute(camera) {
    const actual = actualRoute(camera), draft = camera.routeDraft ?? {};
    return { source: draft.source ?? actual.source, links: draft.links ?? actual.links };
  }
  // The one RCP everything goes through. A camera with a single copy only has a master if one was chosen.
  function masterOf(route, chosen) {
    const receivers = Object.keys(route.links), first = receivers.filter(rcp => route.links[rcp] === route.source);
    return first.length === 1 && (receivers.length > 1 || chosen === first[0]) ? first[0] : '';
  }
  const wantedMaster = camera => masterOf(wantedRoute(camera), camera.remiMaster);
  const actualMaster = camera => masterOf(actualRoute(camera), camera.remiMaster);
  const routeCircles = (route, chosen) => { const master = masterOf(route, chosen); return Object.keys(route.links).filter(rcp => rcp !== master); };
  function routeFromSource(source, master, circles) {
    const links = {}, hub = master || source;
    if (master && master !== source) links[master] = source;
    for (const rcp of circles) if (rcp !== source && rcp !== master) links[rcp] = hub;
    return links;
  }
  const routeText = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const sameRoute = (a, b) => routeText(a) === routeText(b);
  const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));
  const routeHasChanges = camera => !!camera.routeDraft;
  const isMove = camera => !!camera.elementKey && !!camera.routeDraft?.source;
  const masterChanged = camera => routeHasChanges(camera) && wantedMaster(camera) !== actualMaster(camera);
  // These delete a camera or re-route all of its copies, so Auto send leaves them in Pending sends.
  const waitsForSend = camera => isMove(camera) || masterChanged(camera) || !!camera.removeStaged;
  function copyRemoval(copy) {
    if (!importedCamera(copy)) return false;
    const source = sourceRowOf(copy);
    return !!source && (!!source.removeStaged || routeHasChanges(source) && !(copy.device in wantedRoute(source).links));
  }
  function removalStaged(camera) { return !!camera.removeStaged || copyRemoval(camera); }
  function routeChanged(camera, field) {
    if (!isAssignmentField(field) || !routeHasChanges(camera) || camera.removeStaged) return false;
    const actual = actualRoute(camera), wanted = wantedRoute(camera);
    if (field === 'source') return wanted.source !== actual.source;
    const before = masterOf(actual, camera.remiMaster), after = masterOf(wanted, camera.remiMaster);
    if (field === 'remiMaster') return before !== after;
    const rcp = field.slice(5);
    // A move or a new master re-routes every copy, and the cell that changed already says so.
    return wanted.source !== actual.source || before !== after ? rcp in wanted.links !== rcp in actual.links : (wanted.links[rcp] ?? '') !== (actual.links[rcp] ?? '');
  }
  function syncResult(camera) {
    if (unassigned(camera)) return 'Not assigned';
    if (removalStaged(camera) && !camera.jobs && !camera.deleting) return 'Delete';
    if (queuedSends.has(camera) && !camera.jobs) return 'Queued';
    return !camera.jobs && routeHasChanges(camera) && ['In sync', 'Verified'].includes(camera.result) ? 'Pending' : camera.result;
  }
  function setRouteDraft(camera, wanted) {
    const actual = actualRoute(camera), draft = {};
    if (wanted.source !== actual.source) draft.source = wanted.source;
    if (!sameRoute(wanted.links, actual.links)) draft.links = wanted.links;
    if (Object.keys(draft).length) camera.routeDraft = draft;
    else delete camera.routeDraft;
  }
  function settleRouteDraft(camera) {
    if (camera.routeDraft) setRouteDraft(camera, wantedRoute(camera));
  }
  // A camera that isn't on any controller yet has nothing to move, only somewhere to be created.
  function applyWantedRoute(camera, wanted) {
    if (!camera.elementKey && !camera.createState && wanted.source !== camera.device) {
      camera.device = wanted.source;
      routeTreeMemo = null;
    }
    setRouteDraft(camera, wanted);
  }

  function assignmentDisplay(camera, field, sheetId = allCamerasSheet) {
    if (importedCamera(camera)) {
      const peer = camera.remi?.origin?.serial || camera.remi?.peer || camera.remiPeer;
      const label = field !== 'source' ? '' : peer ? remiDeviceName(peer) : 'Copy on ' + controllerName(camera.device);
      return { value: '', label, locked: peer ? 'Its source controller is not in this workspace.' : 'This is a REMI copy and its source is not known yet. Press Refresh all while this controller is reachable.' };
    }
    const wanted = wantedRoute(camera), noSource = 'Choose a Source on Camera Configuration first.';
    const locked = camera.removeStaged ? 'This camera is waiting to be deleted. Cancel that in Pending sends to change it.' : camera.deleting ? 'This camera is being deleted.' : actualRoute(camera).fixed ? 'This camera’s REMI copies don’t fit this table. Use the REMI panel in Camera Configuration.' : '';
    if (field === 'source') return { value: wanted.source, label: wanted.source ? controllerName(wanted.source) : 'Choose source', none: !wanted.source, locked, readOnly: sheetId === cameraSetupSheet ? '' : 'Change the Source on Camera Configuration.' };
    const master = masterOf(wanted, camera.remiMaster);
    if (field === 'remiMaster') return { value: master, label: master ? controllerName(master) : 'None', none: !master, locked: locked || (wanted.source ? '' : noSource) };
    const rcp = field.slice(5);
    if (rcp === wanted.source) return { label: 'Source', locked: 'This is the camera’s Source device.' };
    if (rcp === master) return { label: 'Master', master: true, locked: 'This is the camera’s Master RCP. Change it in the Master RCP column.' };
    return { circle: true, on: rcp in wanted.links, locked: locked || (wanted.source ? '' : noSource) };
  }
  function assignmentCell(camera, field, sheetId = allCamerasSheet) {
    const shown = assignmentDisplay(camera, field, sheetId), why = shown.locked || shown.readOnly, title = why ? ' title="' + esc(why) + '"' : '';
    if (shown.circle) return '<span data-hubble-boolean data-field="' + esc(field) + '" data-row="' + esc(camera.id) + '"' + title + '></span>';
    if (shown.master) return '<span class="hc-route-master"' + title + '>Master</span>';
    if ((field === 'remiMaster' || field === 'source') && !shown.locked && !shown.readOnly) return '<button type="button" tabindex="-1" class="hc-cell-input hc-choice-cell' + (shown.none ? ' hc-route-none' : '') + '" data-row="' + esc(camera.id) + '" data-field="' + field + '" data-camera-choice value="' + esc(shown.value) + '" aria-label="' + esc(assignmentLabel(field) + ' for camera ' + camera.number + ' · ' + shown.label) + '">' + esc(shown.label) + '</button>';
    return shown.label ? '<span class="hc-route-text' + (shown.none || shown.label === 'Source' ? ' hc-route-none' : '') + '"' + title + '>' + esc(shown.label) + '</span>' : '';
  }
  function assignmentSheetCell(camera, field, sheetId = allCamerasSheet) {
    const shown = assignmentDisplay(camera, field, sheetId);
    if (shown.circle) return { kind: 'boolean', value: shown.on ? 'TRUE' : 'FALSE', readOnly: !!shown.locked };
    if ((field === 'remiMaster' || field === 'source') && !shown.locked && !shown.readOnly) return { value: shown.value || 'None', choices: field === 'source' ? sourceChoices(camera) : masterChoices(camera) };
    return { value: shown.label, readOnly: true };
  }
  const assignmentSortValue = (camera, field) => assignmentDisplay(camera, field).label ?? '';
  function controllerChoice(d) {
    const twin = devices.some(other => other !== d && other.name === d.name);
    return { value: d.id, label: d.name + (twin ? ' · ' + d.serial : ''), group: d.kind };
  }
  // Once a camera is on a controller it can move, but it can't go back to being nowhere.
  const sourceChoices = camera => [...(camera.elementKey || camera.createState ? [] : [{ value: 'None', label: 'Not assigned' }]), ...orderedDevices().map(controllerChoice)];
  const masterChoices = camera => [{ value: 'None', label: 'None' }, ...remiControllers().filter(d => d.id !== wantedRoute(camera).source).map(controllerChoice)];
  function assignmentTarget(field, value) {
    const text = String(value).trim().toLocaleLowerCase(), match = list => list.map(controllerChoice).find(choice => choice.value.toLocaleLowerCase() === text || choice.label.toLocaleLowerCase() === text)?.value;
    if (field === 'source') return !text || text === 'none' || text === 'not assigned' ? '' : match(orderedDevices());
    if (field === 'remiMaster') return !text || text === 'none' ? '' : match(remiControllers());
    return ['true', '1', 'yes', 'on', '✓', '●'].includes(text) ? true : ['false', '0', 'no', 'off', ''].includes(text) ? false : undefined;
  }
  // Returns whether anything changed. Back where the controllers already are, their chain of copies
  // is kept as it is, so clicking one RCP doesn't re-route the others.
  function stageRoute(camera, field, next) {
    const before = JSON.stringify([camera.routeDraft ?? null, camera.remiMaster ?? null, camera.device]);
    const wanted = wantedRoute(camera), actual = actualRoute(camera), master = masterOf(wanted, camera.remiMaster);
    if (field === 'source' || field === 'remiMaster') {
      const source = field === 'source' ? next : wanted.source;
      if (field === 'source' && (next === wanted.source || !next && (camera.elementKey || camera.createState))) return false;
      const chosen = field === 'remiMaster' ? (next === source ? '' : next) : master === source ? '' : master;
      const circles = routeCircles(wanted, camera.remiMaster).filter(rcp => rcp !== source && rcp !== chosen);
      const unchanged = source === actual.source && chosen === masterOf(actual, chosen) && sameSet(circles, routeCircles(actual, chosen));
      camera.remiMaster = chosen;
      applyWantedRoute(camera, { source, links: unchanged ? actual.links : routeFromSource(source, chosen, circles) });
    } else {
      const rcp = field.slice(5), links = { ...wanted.links }, hub = master || wanted.source;
      // Clicking a circle shouldn't undo a master that was only known from how the copies are chained.
      if (master) camera.remiMaster = master;
      if (next) {
        const parent = actual.links[rcp];
        links[rcp] = parent && (parent === wanted.source || parent in links) ? parent : hub;
      } else {
        delete links[rcp];
        for (const [child, parent] of Object.entries(links)) if (parent === rcp) links[child] = hub;
      }
      applyWantedRoute(camera, { source: wanted.source, links });
    }
    return before !== JSON.stringify([camera.routeDraft ?? null, camera.remiMaster ?? null, camera.device]);
  }
  function paintRoute(camera) {
    for (const field of ['source', 'remiMaster', ...routeReceivers().map(d => 'remi:' + d.id)]) {
      for (const cell of root.querySelectorAll('table[data-camera-device] td[data-camera="' + CSS.escape(camera.id) + '"][data-column="' + CSS.escape(field) + '"]')) {
        const markup = assignmentCell(camera, field, cell.closest('table').dataset.cameraDevice);
        // The host draws the circle inside this slot, so a slot that stays a slot is left for it to update.
        if (!markup.includes('data-hubble-boolean') || !cell.querySelector('[data-hubble-boolean]')) cell.innerHTML = markup;
        if (cell.querySelector('[data-field]:enabled,[data-hubble-boolean]')) cell.removeAttribute('aria-readonly');
        else cell.setAttribute('aria-readonly', 'true');
        cell.classList.toggle('hc-changed', routeChanged(camera, field));
      }
    }
    paintItem(camera);
  }
  function editCameraRoutes(edits, cameraById, hold = false) {
    const rows = [...new Set(edits.map(edit => cameraById.get(edit.rowId)).filter(Boolean))];
    const before = cameraDraftSnapshot(rows), changed = new Set();
    // Where it starts and its master decide what the circles mean, so they go first.
    const order = ({ columnId }) => columnId === 'source' ? 0 : columnId === 'remiMaster' ? 1 : 2;
    let invalid = 0;
    for (const edit of [...edits].sort((a, b) => order(a) - order(b))) {
      const camera = cameraById.get(edit.rowId);
      if (!camera || assignmentDisplay(camera, edit.columnId).locked) continue;
      const next = assignmentTarget(edit.columnId, edit.value);
      if (next === undefined) { invalid++; continue; }
      if (stageRoute(camera, edit.columnId, next)) { changed.add(camera); routeErrors.delete(camera.id); }
    }
    if (invalid) toast(invalid + ' ' + (invalid === 1 ? 'choice is' : 'choices are') + ' unavailable for that camera');
    if (!changed.size) return;
    recordCameraDrafts(before, rows);
    // A circle only changes its own row, so it needn't redraw the sheet. The rest can change which columns say what.
    if (hold || !edits.every(edit => edit.columnId.startsWith('remi:')) || isAssignmentField(cameraSort(virtualSheet(tab) ?? allCamerasSheet).field)) renderCameras();
    else {
      for (const camera of changed) paintRoute(camera);
      for (const sheet of cameraSheets.values()) sheet.refresh?.();
    }
    remember();
    const waiting = [...changed].filter(camera => hold || waitsForSend(camera)), rest = [...changed].filter(camera => !waiting.includes(camera));
    if (ui.sendMode === 'Auto send' && rest.length) void sendRoutes(rest);
  }

  // Delete only marks the camera. It goes to the controller from Pending sends, like everything else.
  function stageRemoval(rows, on) {
    rows = rows.filter(camera => !camera.jobs && !camera.deleting && !importedCamera(camera) && !!camera.removeStaged !== on);
    if (!rows.length) return;
    const before = cameraDraftSnapshot(rows);
    for (const camera of rows) {
      routeErrors.delete(camera.id);
      // A camera that never reached a controller has nothing to delete there.
      if (on && camera.isNew && !camera.elementKey && !camera.createState) { cameras = cameras.filter(row => row !== camera); queuedSends.delete(camera); continue; }
      if (on) camera.removeStaged = true;
      else delete camera.removeStaged;
    }
    recordCameraDrafts(before, rows.filter(camera => cameras.includes(camera)));
    renderCameras();
    remember();
  }
  // Clearing only forgets a camera here. Nothing goes to a controller, so the next read of one that
  // still has it brings it back. Its copies live in its row, so they go with it.
  function clearFromView(rows) {
    const { children } = routeTree(), gone = new Set();
    const add = row => { if (gone.has(row)) return; gone.add(row); for (const copy of children.get(row) ?? []) if (importedCamera(copy)) add(copy); };
    for (const camera of rows) if (!camera.jobs && !camera.deleting) add(camera);
    if (!gone.size) return;
    const saved = [...gone].map(row => copyPresentation(plainRow(row)));
    cameras = cameras.filter(row => !gone.has(row));
    for (const row of gone) { queuedSends.delete(row); routeErrors.delete(row.id); }
    recordCameraHistory(virtualSheet(tab) ?? [...gone][0].device, { kind: 'cleared', rows: saved });
    routeTreeMemo = null;
    renderCameras();
    remember();
    toast((rows.length === 1 ? 'Camera ' + rows[0].number : rows.length + ' cameras') + ' cleared from view. Anything still on a controller comes back on the next read.');
  }
  function setClearedRows(rows, gone) {
    const ids = new Set(rows.map(row => row.id));
    if (gone) cameras = cameras.filter(row => !ids.has(row.id));
    // A read may have brought it back already.
    else for (const saved of rows) if (!cameras.some(row => row.id === saved.id || row.elementKey && row.device === saved.device && row.elementKey === saved.elementKey)) cameras.push(restoredRow(copyPresentation(saved)));
    routeTreeMemo = null;
    renderCameras();
    remember();
  }
  function cameraMenuItems(camera, cameraById) {
    const staged = removalStaged(camera);
    return [{ id: 'clear-camera', label: 'Clear from view', disabled: !!camera.deleting || !!camera.jobs, run: () => clearFromView([cameraById.get(camera.id) ?? camera]) }, { id: 'delete-camera', label: staged ? 'Keep camera' : importedCamera(camera) ? 'Remove REMI copy' : 'Delete camera', icon: staged ? undefined : 'delete', danger: !staged, disabled: !!camera.deleting || !!camera.jobs, run: () => reviewCameraDeletion(cameraById.get(camera.id) ?? camera) }];
  }
  function removeCell(camera, column) {
    const staged = removalStaged(camera), label = (staged ? 'Keep camera ' : importedCamera(camera) ? 'Remove the REMI copy of camera ' : 'Delete camera ') + camera.number;
    const busy = camera.deleting || camera.jobs ? ' disabled' : '', clearLabel = 'Clear camera ' + camera.number + ' from view';
    const clear = camera.elementKey || importedCamera(camera) ? '<button type="button" class="hc-row-remove-button" data-action="clear-from-view" data-clear-row="' + esc(camera.id) + '" aria-label="' + esc(clearLabel) + '" title="' + esc(clearLabel) + '. Nothing is sent to a controller."' + busy + '>' + icon('eye-off') + '</button>' : '';
    return '<td class="hc-camera-frozen hc-row-remove" style="left:' + column.frozen + 'px">' + clear + '<button type="button" class="hc-row-remove-button" data-action="stage-remove" data-remove-row="' + esc(camera.id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (camera.deleting || camera.jobs ? ' disabled' : '') + '>' + icon(staged ? 'undo-2' : 'trash-2') + '</button></td>';
  }

  const requestFailure = (items, error) => ({ results: items.map(item => ({ id: item.id, error: error.message || 'REMI changes could not be confirmed' })), refresh: true });
  async function requestRoutes(items) {
    let report;
    try { report = await moduleBridge.remiRoute({ items }); }
    catch (error) { report = requestFailure(items, error); }
    for (const snapshot of report.snapshots || []) mergeOwn(snapshot);
    if (report.refresh) {
      try { await remiRefreshSheets(); }
      catch (error) { toast(error.message || 'Camera sheets could not be refreshed'); }
    }
    return report;
  }
  async function runRoutes(rows) {
    if (!moduleBridge || moduleBridge.preview) { toast(sampleRouteMessage); return; }
    const jobs = [];
    for (const camera of rows) {
      if (!cameras.includes(camera) || !camera.elementKey || !routeHasChanges(camera) || isMove(camera)) continue;
      const actual = actualRoute(camera), tree = wantedRoute(camera).links;
      if (sameRoute(tree, actual.links)) { delete camera.routeDraft; continue; }
      jobs.push({ camera, draft: camera.routeDraft, item: { id: camera.id, camera: camera.device, key: camera.elementKey, tree, expected: actual.links, copies: actual.keys } });
      camera.jobs++;
      camera.result = 'Sending';
      routeErrors.delete(camera.id);
      paintItem(camera);
    }
    if (!jobs.length) { renderCameras(); remember(); return; }
    const report = await requestRoutes(jobs.map(job => job.item));
    const errors = [];
    for (const { camera, draft } of jobs) {
      camera.jobs = Math.max(0, camera.jobs - 1);
      queuedSends.delete(camera);
      const result = report.results?.find(row => row.id === camera.id) ?? { error: 'REMI changes could not be confirmed' };
      if (result.error) {
        camera.result = 'Error';
        routeErrors.set(camera.id, result.error);
        errors.push(result.error);
        settleRouteDraft(camera);
        continue;
      }
      if (camera.routeDraft === draft) delete camera.routeDraft;
      else settleRouteDraft(camera);
      camera.result = camera.pending ? 'Pending' : 'Verified';
    }
    renderCameras();
    remember();
    toast(errors.length ? errors.length + ' ' + (errors.length === 1 ? 'assignment' : 'assignments') + ' could not be confirmed: ' + errors[0] : 'Camera assignments verified');
  }
  // One at a time, so each send starts from what the last one left on the controllers.
  let routeQueue = Promise.resolve();
  let sendsRunning = 0;
  function enqueueSend(run) {
    sendsRunning++;
    routeQueue = routeQueue.catch(() => undefined).then(run).finally(() => { sendsRunning--; schedulePendingSends(); });
    return routeQueue;
  }
  function sendRoutes(rows) {
    const ready = rows.filter(camera => !camera.jobs && camera.elementKey && !isMove(camera));
    for (const camera of ready) { queuedSends.add(camera); paintItem(camera); }
    return enqueueSend(async () => {
      try { await runRoutes(ready.filter(camera => queuedSends.has(camera))); }
      finally { for (const camera of ready) { queuedSends.delete(camera); if (cameras.includes(camera)) paintItem(camera); } }
    });
  }
  // What Pending sends sends: deletions first, then settings, since a new camera can't be REMI'd
  // until it exists, then copies, then moves. Cancel takes a queued camera out at any point here.
  function sendPending(rows) {
    const ready = rows.filter(camera => !camera.jobs && !queuedSends.has(camera) && !pendingState(camera).blocked);
    if (!ready.length) return;
    for (const camera of ready) { queuedSends.add(camera); routeErrors.delete(camera.id); paintItem(camera); }
    return enqueueSend(async () => {
      const waiting = () => ready.filter(camera => queuedSends.has(camera) && cameras.includes(camera));
      try {
        const removals = waiting().filter(row => row.removeStaged);
        if (removals.length) await removeCameras(removals);
        const settings = waiting().filter(camera => camera.pending && !isMove(camera));
        if (settings.length) {
          await sendItems(settings, 'camera');
          for (const camera of settings) if (camera.pending || !routeHasChanges(camera)) queuedSends.delete(camera);
        }
        const routes = waiting().filter(camera => routeHasChanges(camera) && !isMove(camera));
        if (routes.length) await runRoutes(routes);
        for (const camera of waiting()) {
          queuedSends.delete(camera);
          if (isMove(camera)) await moveCamera(camera);
        }
      } finally {
        for (const camera of ready) { queuedSends.delete(camera); if (cameras.includes(camera)) paintItem(camera); }
        renderCameras();
        schedulePendingSends();
        void loadRemiJobs();
      }
    });
  }
  // One request for all the copies and one for all the deletes, so each controller sees one socket
  // however many cameras go. The copies come off first, or they'd be left pointing at nothing.
  async function removeCameras(rows) {
    for (const camera of rows) queuedSends.delete(camera);
    const chained = rows.map(camera => ({ camera, ...actualRoute(camera) })).filter(item => Object.keys(item.links).length), stuck = new Set();
    if (chained.length && moduleBridge && !moduleBridge.preview) {
      for (const { camera } of chained) { camera.jobs++; paintItem(camera); }
      const report = await requestRoutes(chained.map(({ camera, links, keys }) => ({ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: links, copies: keys })));
      for (const { camera } of chained) {
        camera.jobs = Math.max(0, camera.jobs - 1);
        const result = report.results?.find(row => row.id === camera.id);
        if (result?.verified) continue;
        stuck.add(camera);
        camera.result = 'Error';
        routeErrors.set(camera.id, 'Not deleted: ' + (result?.error || 'its REMI copies could not be removed'));
        paintItem(camera);
      }
    }
    const ready = rows.filter(camera => !stuck.has(camera) && cameras.includes(camera));
    if (!ready.length) return;
    await sendItems(ready, 'camera', true);
    for (const camera of ready) if (cameras.includes(camera)) routeErrors.set(camera.id, 'Not deleted from ' + controllerName(camera.device) + '.');
  }

  // Everything the sheet shows travels with the camera. A lens connection is a physical port on the
  // old controller, so it only comes along if the new controller offers the same one.
  async function restoreLensConnection(moved, port) {
    try {
      const { key, entries, saved } = await moduleBridge.options({ device: moved.device, rowId: moved.id, field: 'LensInterface' });
      if (key && entries.length) cameraChoiceCatalogs.set(key, { entries, saved });
      if (!entries.some(entry => entry.label === port)) return false;
      moved.lensPort = port;
      moved.dirty.add('lensPort');
      await sendItems([moved], 'camera', false, ['lensPort']);
      return moved.result === 'Verified';
    } catch { return false; }
  }
  async function moveCamera(camera) {
    if (!moduleBridge || moduleBridge.preview) { toast(sampleRouteMessage); return; }
    camera.jobs++;
    routeErrors.delete(camera.id);
    try { await carryCameraToController(camera); }
    finally { camera.jobs = Math.max(0, camera.jobs - 1); paintItem(camera); }
  }
  async function carryCameraToController(camera) {
    const wanted = wantedRoute(camera), actual = actualRoute(camera), target = device(wanted.source);
    const fail = message => { camera.result = 'Error'; routeErrors.set(camera.id, message); paintItem(camera); toast(message); };
    if (!target) { fail('Choose a Source device for this camera'); return; }
    if (camera.lensParams && !camera.lensParamsEditable) { fail('Camera ' + camera.number + '’s lens parameters can’t be carried over. Set it up on ' + target.name + ' by hand.'); return; }
    const hasCopies = Object.keys(actual.links).length > 0, holdsCopy = target.id in actual.links, oldName = controllerName(camera.device);
    const takeCopiesOff = async () => {
      const result = (await requestRoutes([{ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: actual.links, copies: actual.keys }])).results?.[0];
      if (!result?.verified) fail('Camera ' + camera.number + ' was not fully moved: ' + (result?.error || 'its REMI copies could not be removed'));
      return !!result?.verified;
    };
    camera.result = 'Sending';
    paintItem(camera);
    // A controller already holding a copy would refuse a second camera with the same number.
    if (holdsCopy && !await takeCopiesOff()) { renderCameras(); remember(); return; }
    initializeLensFields(camera);
    const { id, elementKey, newElementKey, createState, needsInitialization, remi, remiPeer, routeDraft, sentValues, jobs, deleting, dirty, ...settings } = camera;
    const moved = { ...settings, id: 'moved-camera-' + Date.now() + '-' + (++movedCameraSequence), device: target.id, enabledLensAxes: [...(camera.enabledLensAxes ?? [])], usb: 'USB · Automatic', lensPort: 'None', online: null, isNew: true, pending: true, result: 'Sending', revision: 0, jobs: 0, dirty: new Set() };
    const lensFields = [...Object.values(axisDefinitions).flat().map(definition => definition.id), 'lensIp'].filter(field => lensFieldUsed(moved, field) && moved[field]);
    const fields = ['number', 'name', 'model', 'ip', 'port', 'login', 'password', 'usb', 'lens', ...lensFields];
    moved.dirty = new Set(fields);
    const controlWasOn = cameraControlEnabled(camera);
    movesInFlight.add(moved);
    cameras.push(moved);
    await sendItems([moved], 'camera', false, fields);
    if (!moved.elementKey || moved.result !== 'Verified') {
      movesInFlight.delete(moved);
      // Nothing reached the new controller, so the row has nothing to stand for. The original is untouched.
      if (!moved.elementKey && !moved.createState) cameras = cameras.filter(row => row !== moved);
      if (holdsCopy) setRouteDraft(camera, wanted);
      fail('Camera ' + camera.number + ' was not moved to ' + target.name + '. It is still on ' + oldName + (holdsCopy ? ', with its REMI copies removed.' : '.'));
      renderCameras();
      remember();
      return;
    }
    const lensKept = !lensCapabilities(moved).port || !camera.lensPort || camera.lensPort === 'None' || await restoreLensConnection(moved, camera.lensPort);
    if (hasCopies && !holdsCopy && !await takeCopiesOff()) {
      movesInFlight.delete(moved);
      toast('Camera ' + camera.number + ' is now on both ' + target.name + ' and ' + oldName + '.');
      renderCameras();
      remember();
      return;
    }
    delete camera.routeDraft;
    await sendItems([camera], 'camera', true);
    movesInFlight.delete(moved);
    if (cameras.includes(camera)) {
      fail('Camera ' + camera.number + ' is now on both ' + target.name + ' and ' + oldName + ': it could not be deleted from the old controller.');
      renderCameras();
      return;
    }
    if (controlWasOn && cameraControlDevice(target)) submitCameraControl([{ kind: 'camera', controllerId: target.id, cameraId: moved.id, enabled: true }]);
    routeTreeMemo = null;
    setRouteDraft(moved, wanted);
    if (routeHasChanges(moved)) await runRoutes([moved]);
    renderCameras();
    remember();
    toast(lensKept ? 'Camera moved to ' + target.name : 'Camera moved to ' + target.name + ' · choose its lens connection there');
  }

  function describeRoute({ source, links }) {
    const stops = [controllerName(source)];
    for (let level = [source]; level.length;) {
      level = Object.keys(links).filter(rcp => level.includes(links[rcp]));
      if (level.length) stops.push(level.map(controllerName).join(', '));
    }
    return stops.join(' → ');
  }
  function settingLabel(field) {
    const axis = lensAxisForField(field);
    if (axis) return axisName(axis) + ' · ' + (axisDefinitions[axis].find(definition => definition.id === field)?.label ?? field);
    return { usb: 'Camera interface', lensPort: 'Lens connection', lensIp: 'Lens IP' }[field] ?? cameraSortLabels[field] ?? field;
  }
  function settingText(field, value) {
    if (value === null || value === undefined || value === '') return 'Blank';
    return field === 'password' ? '••••••••' : String(value);
  }
  function routeLines(camera) {
    if (!routeHasChanges(camera)) return [];
    const actual = actualRoute(camera), wanted = wantedRoute(camera), lines = [], moving = wanted.source !== actual.source;
    const before = masterOf(actual, camera.remiMaster), after = masterOf(wanted, camera.remiMaster);
    if (moving) lines.push({ id: 'source', label: 'Source device', change: controllerName(actual.source) + ' → ' + controllerName(wanted.source),
      note: !camera.elementKey ? '' : 'Moves the camera. Created on ' + controllerName(wanted.source) + ' with all its settings, then deleted from ' + controllerName(actual.source) + (Object.keys(actual.links).length ? '. It drops off the other RCPs until their REMIs are rebuilt.' : '.') });
    if (before !== after) lines.push({ id: 'master', label: 'Master RCP', change: (before ? controllerName(before) : 'None') + ' → ' + (after ? controllerName(after) : 'None') });
    for (const rcp of new Set([...Object.keys(actual.links), ...Object.keys(wanted.links)])) {
      if (rcp === wanted.source || before !== after && (rcp === before || rcp === after) || rcp in actual.links === rcp in wanted.links) continue;
      lines.push({ id: 'remi:' + rcp, label: 'REMI to ' + controllerName(rcp), change: rcp in actual.links ? 'On → Off' : 'Off → On' });
    }
    const repathed = Object.keys(wanted.links).some(rcp => rcp in actual.links && wanted.links[rcp] !== actual.links[rcp]);
    if (!moving && before === after && repathed) lines.push({ id: 'route', label: 'Route', change: describeRoute(wanted), note: 'Currently ' + describeRoute(actual) });
    if (!moving && lines.length) lines[lines.length - 1].note ??= 'Goes ' + describeRoute(wanted);
    return lines;
  }
  function settingLines(camera) {
    if (camera.isNew) return camera.pending ? [{ id: 'new', label: 'New camera', change: 'Created on ' + controllerName(camera.device), cancellable: !camera.createState }] : [];
    return [...camera.dirty].map(field => {
      const known = camera.sentValues && field in camera.sentValues;
      return { id: 'setting:' + field, label: settingLabel(field), change: (known ? settingText(field, camera.sentValues[field]) + ' → ' : 'Now ') + settingText(field, camera[field]) };
    });
  }
  function pendingLines(camera) {
    if (importedCamera(camera) || unassigned(camera)) return [];
    if (camera.removeStaged) {
      const copies = Object.keys(actualRoute(camera).links).map(controllerName);
      return [{ id: 'delete', label: 'Delete camera', change: 'Deleted from ' + controllerName(camera.device), note: copies.length ? 'Its REMI copies on ' + copies.join(' and ') + ' come off first.' : '' }];
    }
    return [...routeLines(camera), ...settingLines(camera)];
  }
  function pendingState(camera) {
    if (camera.deleting || camera.jobs) return { text: 'Sending…', kind: 'active', blocked: true };
    if (queuedSends.has(camera)) return { text: 'Queued', kind: 'active', blocked: true };
    const wanted = wantedRoute(camera), actual = actualRoute(camera);
    const offline = [...new Set([camera.device, wanted.source, ...Object.keys(actual.links), ...Object.keys(wanted.links)])].filter(id => device(id)?.online === false);
    const error = routeErrors.get(camera.id) ?? (['Pending', 'Verified', 'In sync', 'Queued', 'Sending', 'Verifying', 'Error'].includes(camera.result) ? '' : camera.result);
    if (error) return { text: error, kind: 'failed', blocked: !!offline.length };
    if (offline.length) return { text: 'Won’t send while ' + offline.map(controllerName).join(' and ') + (offline.length === 1 ? ' is' : ' are') + ' offline', kind: 'offline', blocked: true };
    return { text: camera.result === 'Error' ? 'Could not be confirmed' : '', kind: camera.result === 'Error' ? 'failed' : '', blocked: false };
  }
  const pendingRows = () => sortCameraRows(assignmentRows(), allCamerasSheet).flatMap(camera => { const lines = pendingLines(camera); return lines.length ? [{ camera, lines }] : []; });
  // REMI changes staged per controller have no camera row to sit on, but they still wait to be sent.
  const remiDraftGroups = () => [...remiPanels].filter(([id, state]) => device(id) && state.drafts.size).map(([id, state]) => ({ id, state, items: [...state.drafts.values()] }));
  const remiDraftLabel = item => item.kind === 'tag' ? (item.enable ? 'Add REMI tag' : 'Remove REMI tag') : item.enable ? 'Import REMI camera' : 'Remove REMI copy';
  const remiGroupBlocked = ({ id, state }) => state.busy || device(id)?.online === false;
  function remiGroupMarkup(group) {
    const { id, state, items } = group, name = esc(controllerName(id));
    return '<div class="hc-pending-camera" data-pending-remi="' + esc(id) + '"><div><strong>' + name + '</strong><small>REMI copies</small></div>' +
      pendingButton('Send', 'data-pending-remi-send="' + esc(id) + '" aria-label="Send REMI changes on ' + name + '"', remiGroupBlocked(group)) +
      pendingButton('Cancel', 'data-pending-remi-cancel="' + esc(id) + '" aria-label="Cancel REMI changes on ' + name + '"', state.busy) + '</div>' +
      items.map((item, index) => '<div class="hc-pending-item" data-pending-remi-line="' + esc(item.id) + '"><div class="hc-pending-setting">' + esc(remiDraftLabel(item)) + '</div><div class="hc-pending-change">' + esc(item.label ?? item.tag ?? '') + '</div>' +
        (index === 0 && device(id)?.online === false ? '<div class="hc-pending-status" data-kind="offline">Won’t send while ' + name + ' is offline</div>' : '') +
        pendingButton('Cancel', 'data-pending-remi-item="' + esc(item.id) + '" data-pending-remi-device="' + esc(id) + '" aria-label="Cancel ' + esc(remiDraftLabel(item)) + ' on ' + name + '"', state.busy) + '</div>').join('');
  }
  // Any change to a camera with copies is finished on each controller that has one. If one
  // of them can't be reached it stays unfinished, and that camera's copies can't change until it is
  // retried or dismissed.
  let remiJobs = [];
  async function loadRemiJobs() {
    if (!moduleBridge || moduleBridge.preview) return;
    try {
      const reply = await moduleBridge.remiSend({ operation: 'jobs' });
      const next = Array.isArray(reply.jobs) ? reply.jobs : [];
      if (JSON.stringify(next) === JSON.stringify(remiJobs)) return;
      remiJobs = next;
      schedulePendingSends();
    } catch { /* The list is read again after the next send or refresh. */ }
  }
  let remiJobBusy = false;
  function remiJobMarkup(job) {
    const where = job.receivers.map(controllerName), id = esc(job.source + '\n' + job.key), name = 'camera ' + esc(job.number);
    return '<div class="hc-pending-camera" data-pending-job="' + esc(job.key) + '"><div><strong>' + esc(job.number + ' · ' + job.name) + '</strong><small>Unfinished REMI refresh · ' + esc(controllerName(job.source)) + '</small></div>' +
      pendingButton('Retry', 'data-pending-job-retry="' + id + '" aria-label="Retry the REMI refresh for ' + name + '"', remiJobBusy) +
      pendingButton('Dismiss', 'data-pending-job-dismiss="' + id + '" aria-label="Dismiss the REMI refresh for ' + name + '"', remiJobBusy) + '</div>' +
      '<div class="hc-pending-item"><div class="hc-pending-setting">A change to this camera wasn’t finished' + (where.length ? ' on ' + esc(where.join(' and ')) : '') + '</div>' +
      '<div class="hc-pending-note">Until then this camera’s copies can’t be changed. Retry needs ' + esc([controllerName(job.source), ...where].join(', ')) + ' to be reachable. Dismiss it if those copies already look right.</div></div>';
  }
  async function settleRemiJob(value, operation) {
    const [source, key] = value.split('\n');
    if (remiJobBusy || !device(source)) return;
    remiJobBusy = true;
    paintPendingSends();
    try {
      const reply = await moduleBridge.remiSend({ receiver: source, operation, source, key });
      const failed = (reply.results || []).find(result => result.error);
      toast(failed ? failed.error : operation === 'retry' ? 'REMI refresh complete' : 'REMI refresh dismissed');
      if (operation === 'retry') { try { await remiRefreshSheets(); } catch { /* Refresh all reads them again. */ } }
    } catch (error) { toast(error.message || 'The REMI refresh could not be settled'); }
    remiJobBusy = false;
    await loadRemiJobs();
    renderCameras();
    schedulePendingSends();
  }
  // Network changes made on the Devices sheet wait here too, one group per device.
  function lanColumnLabel(row) {
    if (row.type === 'WAN') return 'WAN';
    const index = lans.filter(item => item.device === row.device && item.type !== 'WAN' && !item.readOnly).indexOf(row);
    return index <= 0 ? 'LAN IP' : 'LAN IP ' + (index + 1);
  }
  const lanDraftGroups = () => orderedDevices().map(d => ({ id: d.id, rows: lans.filter(row => row.device === d.id && row.pending) })).filter(group => group.rows.length);
  const lanGroupBlocked = group => group.rows.some(row => row.jobs > 0) || device(group.id)?.online === false;
  function lanChangeText(row) {
    const extras = [['gateway', 'gateway'], ['dns1', 'DNS 1'], ['dns2', 'DNS 2']].filter(([field]) => row.dirty.has(field)).map(([field, label]) => label + ' ' + (row[field] || 'blank'));
    return (row.current || 'Blank') + ' → ' + (row.type === 'WAN' && row.dhcp ? 'DHCP' : row.planned || 'Blank') + (extras.length ? ' · ' + extras.join(' · ') : '');
  }
  function lanGroupMarkup(group) {
    const { id, rows } = group, name = esc(controllerName(id)), busy = rows.some(row => row.jobs > 0);
    return '<div class="hc-pending-camera" data-pending-lan="' + esc(id) + '"><div><strong>' + name + '</strong><small>Network settings</small></div>' +
      pendingButton('Send', 'data-pending-lan-send="' + esc(id) + '" aria-label="Send network changes to ' + name + '"', lanGroupBlocked(group)) +
      pendingButton('Cancel', 'data-pending-lan-cancel="' + esc(id) + '" aria-label="Cancel network changes for ' + name + '"', busy) + '</div>' +
      rows.map((row, index) => {
        const failed = !row.jobs && !['Pending', 'In sync', 'Verified', 'Sending', 'Verifying'].includes(row.result) ? row.result : '';
        const state = row.jobs ? ['Sending…', 'active'] : failed ? [failed === 'Error' ? 'Could not be confirmed' : failed, 'failed'] : index === 0 && device(id)?.online === false ? ['Won’t send while ' + controllerName(id) + ' is offline', 'offline'] : null;
        return '<div class="hc-pending-item" data-pending-lan-line="' + esc(row.id) + '"><div class="hc-pending-setting">' + esc(lanColumnLabel(row)) + '</div><div class="hc-pending-change">' + esc(lanChangeText(row)) + '</div>' +
          (state ? '<div class="hc-pending-status" data-kind="' + state[1] + '">' + esc(state[0]) + '</div>' : '') +
          pendingButton('Cancel', 'data-pending-lan-item="' + esc(row.id) + '" data-pending-lan-device="' + esc(id) + '" aria-label="Cancel ' + esc(lanColumnLabel(row)) + ' for ' + name + '"', row.jobs > 0) + '</div>';
      }).join('');
  }
  function cancelLanDrafts(id, rowId) {
    const rows = lans.filter(row => row.device === id && row.pending && !row.jobs && (!rowId || row.id === rowId));
    if (!rows.length) return;
    lans = lans.filter(row => !rows.includes(row) || row.elementKey);
    for (const row of rows) {
      if (!row.elementKey) continue;
      row.planned = row.current;
      row.operation = 'Keep';
      row.dirty.clear();
      row.pending = false;
      row.result = 'In sync';
      if (row.type === 'WAN') row.dhcp = row.current === 'DHCP';
    }
    renderLans();
    remember();
    // A WAN's gateway and DNS have no earlier value kept here, so the controller says what they were.
    if (rows.some(row => row.elementKey && row.type === 'WAN') && moduleBridge && !moduleBridge.preview) { autoReads.add(id); scheduleAutoRead(50); }
  }
  const sendLanGroup = group => sendItems(group.rows.filter(row => !row.jobs), 'lan').then(() => { renderLans(); });
  const pendingButton = (label, attributes, disabled) => '<button type="button" ' + attributes + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  function pendingGroupMarkup({ camera, lines }) {
    const state = pendingState(camera), id = esc(camera.id), name = 'camera ' + esc(camera.number), busy = !!camera.jobs || !!camera.deleting;
    return '<div class="hc-pending-camera" data-pending-camera="' + id + '"><div><strong>' + esc(camera.number) + ' · ' + esc(camera.name) + '</strong><small>' + esc(controllerName(camera.device)) + '</small></div>' +
      pendingButton('Send', 'data-pending-send="' + id + '" aria-label="Send all changes to ' + name + '"', state.blocked) +
      pendingButton('Cancel', 'data-pending-cancel="' + id + '" aria-label="Cancel all changes for ' + name + '"', busy) + '</div>' +
      lines.map((line, index) => '<div class="hc-pending-item" data-pending-line="' + esc(line.id) + '"><div class="hc-pending-setting">' + esc(line.label) + '</div><div class="hc-pending-change">' + esc(line.change) + '</div>' +
        (line.note ? '<div class="hc-pending-note">' + esc(line.note) + '</div>' : '') + (index === 0 && state.text ? '<div class="hc-pending-status" data-kind="' + state.kind + '">' + esc(state.text) + '</div>' : '') +
        pendingButton('Cancel', 'data-pending-cancel-line="' + esc(line.id) + '" data-pending-camera-id="' + id + '" aria-label="Cancel ' + esc(line.label) + ' for ' + name + '"', busy || line.cancellable === false) + '</div>').join('');
  }
  let paintedPending = null, pendingPaintQueued = false;
  function schedulePendingSends() {
    if (pendingPaintQueued) return;
    pendingPaintQueued = true;
    queueMicrotask(() => { pendingPaintQueued = false; paintPendingSends(); });
  }
  function paintPendingSends() {
    const rows = pendingRows(), groups = remiDraftGroups(), networks = lanDraftGroups();
    const total = rows.reduce((count, row) => count + row.lines.length, 0) + groups.reduce((count, group) => count + group.items.length, 0) + networks.reduce((count, group) => count + group.rows.length, 0) + remiJobs.length;
    for (const count of root.querySelectorAll('[data-pending-sends-count]')) { count.textContent = total; count.hidden = !total; }
    for (const word of root.querySelectorAll('[data-pending-sends-word]')) word.textContent = total ? ' pending' : 'All sent';
    for (const toggle of root.querySelectorAll('.hc-toolbar [data-action="toggle-pending-sends"]')) { toggle.dataset.pending = String(total > 0); toggle.setAttribute('aria-expanded', String(pendingSendsOpen)); }
    const cameraRows = assignmentRows();
    const foot = total + ' pending · ' + cameraRows.filter(camera => camera.online === false).length + ' cameras offline' + uncheckedCount(cameraRows, ' · ');
    $('assignment-foot').textContent = foot;
    $('setup-foot').textContent = foot;
    if (total && !cameras.some(camera => camera.jobs > 0) && !lans.some(lan => lan.jobs > 0)) {
      const everything = total;
      $('pending-summary').textContent = everything + (everything === 1 ? ' change pending' : ' changes pending');
      $('pending-summary').classList.add('hc-changes-label');
    }
    const ready = rows.filter(row => !pendingState(row.camera).blocked), readyCount = ready.reduce((sum, row) => sum + row.lines.length, 0) + groups.filter(group => !remiGroupBlocked(group)).reduce((sum, group) => sum + group.items.length, 0) + networks.filter(group => !lanGroupBlocked(group)).reduce((sum, group) => sum + group.rows.length, 0);
    for (const quick of root.querySelectorAll('[data-action="send-all-pending-quick"]')) {
      quick.hidden = !readyCount;
      quick.querySelector('[data-pending-quick-label]').textContent = 'Send ' + readyCount;
      quick.setAttribute('aria-label', 'Send ' + readyCount + (readyCount === 1 ? ' pending change' : ' pending changes'));
    }
    placePendingSends();
    pendingAside.hidden = !pendingSendsOpen || !['devices', 'setup', 'cameras', 'assignment'].includes(tab);
    if (pendingAside.hidden) { paintedPending = null; return; }
    pendingAside.querySelector('h3').textContent = total ? total + ' pending' : 'Pending sends';
    const markup = remiJobs.map(remiJobMarkup).join('') + networks.map(lanGroupMarkup).join('') + rows.map(pendingGroupMarkup).join('') + groups.map(remiGroupMarkup).join('');
    if (markup !== paintedPending) { $('pending-sends-list').innerHTML = markup; paintedPending = markup; }
    $('pending-sends-summary').textContent = !total ? (sendsRunning ? 'Sending…' : 'Nothing is waiting to send.') : total + (groups.length + networks.length + remiJobs.length ? (total === 1 ? ' item. ' : ' items. ') : total === 1 ? ' change on ' : ' changes on ') + (groups.length + networks.length + remiJobs.length ? '' : rows.length + (rows.length === 1 ? ' camera. ' : ' cameras. ')) + (ui.sendMode === 'Auto send' ? 'New edits send as you make them. Deletes, moves and Master RCP changes stay here until you press Send.' : 'Nothing goes to a controller until you press Send.');
    const all = action('send-all-pending');
    all.textContent = readyCount ? 'Send all (' + readyCount + ')' : 'Send all';
    all.disabled = !readyCount;
    action('cancel-all-pending').disabled = total === remiJobs.length || !groups.length && !networks.length && rows.every(row => row.camera.jobs || row.camera.deleting);
  }
  function setPendingSendsOpen(open) {
    if (pendingSendsOpen === open) return;
    pendingSendsOpen = open;
    paintPendingSends();
    remember();
  }
  // The list floats over the sheet, so Escape from inside it puts it away.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingSendsOpen || !event.target.closest?.('.hc-pending-sends, [data-action="toggle-pending-sends"]')) return;
    event.preventDefault();
    setPendingSendsOpen(false);
    root.querySelector('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]')?.focus();
  });

  const lensBlock = field => field === 'lens' || field === 'enabledLensAxes' || field === 'lensParamsEditable' || isLensSetting(field);
  function pruneSentValues(camera) {
    if (!camera.sentValues) return;
    if (!camera.dirty.size) { delete camera.sentValues; return; }
    if (camera.dirty.has('model')) return;
    const lensWaiting = [...camera.dirty].some(lensBlock);
    for (const field of Object.keys(camera.sentValues)) if (!camera.dirty.has(field) && !(lensWaiting && lensBlock(field))) delete camera.sentValues[field];
  }
  // A model or lens decides what the settings around it mean, so those go back together. An edit
  // saved by an older version has no earlier value here, so only the controller can say what it was.
  function cancelSetting(camera, field) {
    const saved = camera.sentValues ?? {}, all = [...new Set([...camera.dirty, ...Object.keys(saved)])];
    let unknown = false;
    for (const name of field === 'model' ? all : lensBlock(field) ? all.filter(lensBlock) : [field]) {
      if (!(name in saved)) { unknown ||= camera.dirty.has(name); camera.dirty.delete(name); continue; }
      if (saved[name] === null) delete camera[name];
      else camera[name] = saved[name];
      delete saved[name];
      camera.dirty.delete(name);
    }
    return unknown;
  }
  function cancelRouteLine(camera, line) {
    const wanted = wantedRoute(camera), actual = actualRoute(camera);
    if (line === 'source') { stageRoute(camera, 'source', actual.source); return; }
    if (line === 'master') { stageRoute(camera, 'remiMaster', masterOf(actual, camera.remiMaster)); return; }
    const hub = masterOf(wanted, camera.remiMaster) || wanted.source, links = { ...wanted.links };
    if (line === 'route') {
      for (const rcp of Object.keys(links)) { const parent = actual.links[rcp]; links[rcp] = parent && (parent === wanted.source || parent in links) ? parent : hub; }
    } else {
      const rcp = line.slice(5);
      if (rcp in actual.links) { const parent = actual.links[rcp]; links[rcp] = parent === wanted.source || parent in links ? parent : hub; }
      else { delete links[rcp]; for (const [child, parent] of Object.entries(links)) if (parent === rcp) links[child] = hub; }
    }
    setRouteDraft(camera, { source: wanted.source, links });
  }
  function cancelLine(camera, line) {
    if (line === 'new') { cameras = cameras.filter(row => row !== camera); queuedSends.delete(camera); return false; }
    if (line === 'delete') { delete camera.removeStaged; routeErrors.delete(camera.id); if (camera.result === 'Error') camera.result = camera.pending ? 'Pending' : 'In sync'; return false; }
    const unknown = line.startsWith('setting:') && cancelSetting(camera, line.slice(8));
    if (!line.startsWith('setting:')) cancelRouteLine(camera, line);
    camera.pending = !!camera.isNew || camera.dirty.size > 0;
    camera.revision++;
    camera.result = camera.pending ? 'Pending' : 'In sync';
    routeErrors.delete(camera.id);
    if (!pendingLines(camera).length) queuedSends.delete(camera);
    return unknown;
  }
  // Cancel clears a staged change as one Undo step. Whatever is being sent right now has already gone.
  function cancelPending(targets) {
    const open = targets.filter(({ camera }) => !camera.jobs && !camera.deleting);
    if (!open.length) return;
    const rows = [...new Set(open.map(target => target.camera))], before = cameraDraftSnapshot(rows);
    let reread = false;
    for (const { camera, line } of open) if (cameras.includes(camera) && cancelLine(camera, line)) reread = true;
    recordCameraDrafts(before, rows.filter(camera => cameras.includes(camera)));
    routeTreeMemo = null;
    renderCameras();
    remember();
    if (reread && moduleBridge && !moduleBridge.preview) void refreshLive();
  }
  // A camera's lines are worked out again after each one, since cancelling a move changes the others.
  function cancelCamera(camera) {
    const lines = pendingLines(camera).filter(line => line.cancellable !== false);
    if (lines.some(line => line.id === 'delete' || line.id === 'new')) { cancelPending(lines.filter(line => line.id === 'delete' || line.id === 'new').map(line => ({ camera, line: line.id }))); return; }
    const rows = [camera], before = cameraDraftSnapshot(rows);
    let reread = false;
    if (camera.routeDraft) { setRouteDraft(camera, actualRoute(camera)); }
    for (const line of settingLines(camera)) if (cancelLine(camera, line.id)) reread = true;
    camera.pending = !!camera.isNew || camera.dirty.size > 0;
    camera.result = camera.pending ? 'Pending' : 'In sync';
    routeErrors.delete(camera.id);
    queuedSends.delete(camera);
    recordCameraDrafts(before, rows);
    routeTreeMemo = null;
    renderCameras();
    remember();
    if (reread && moduleBridge && !moduleBridge.preview) void refreshLive();
  }
  function cancelRemiDrafts(id, itemId) {
    const state = remiPanels.get(id);
    if (!state || state.busy) return;
    if (itemId) state.drafts.delete(itemId);
    else state.drafts.clear();
    renderCameras();
    remember();
  }
  function cancelAllPending() {
    for (const { camera } of pendingRows()) if (!camera.jobs && !camera.deleting) cancelCamera(camera);
    for (const { id } of remiDraftGroups()) cancelRemiDrafts(id);
    for (const { id } of lanDraftGroups()) cancelLanDrafts(id);
  }
  async function sendAllPending() {
    for (const group of lanDraftGroups()) if (!lanGroupBlocked(group)) await sendLanGroup(group);
    await sendPending(pendingRows().map(item => item.camera));
    for (const group of remiDraftGroups()) if (!remiGroupBlocked(group)) await remiSend(group.id, group.items);
  }
  // Refresh all starts again from what the controllers say, so nothing is left waiting to be sent.
  function clearPendingSends() {
    const cleared = pendingRows().reduce((count, row) => count + row.lines.length, 0) + pendingLans().length + [...remiPanels.values()].reduce((count, state) => count + state.drafts.size, 0);
    queuedSends.clear();
    routeErrors.clear();
    routeQueue = Promise.resolve();
    for (const camera of [...cameras]) {
      camera.jobs = 0;
      camera.deleting = false;
      if (unassigned(camera)) continue;
      // A create with an unknown outcome: the read shows whether it happened.
      if (camera.createState) { cameras = cameras.filter(row => row !== camera); continue; }
      delete camera.routeDraft;
      delete camera.removeStaged;
      // A camera that never reached a controller keeps what was typed, and goes back to having no Source.
      if (camera.isNew && !camera.elementKey) { camera.device = ''; continue; }
      for (const [field, value] of Object.entries(camera.sentValues ?? {})) {
        if (value === null) delete camera[field];
        else camera[field] = value;
      }
      delete camera.sentValues;
      camera.dirty.clear();
      camera.pending = false;
      camera.result = 'In sync';
    }
    lans = lans.filter(lan => lan.elementKey || !lan.pending);
    for (const lan of lans) {
      lan.jobs = 0;
      if (!lan.pending && !lan.dirty.size) continue;
      lan.dirty.clear();
      lan.pending = false;
      lan.planned = lan.current;
      lan.operation = 'Keep';
      lan.result = 'In sync';
    }
    for (const state of remiPanels.values()) { state.drafts.clear(); state.picks.clear(); }
    routeTreeMemo = null;
    void loadRemiJobs();
    return cleared;
  }

  const virtualHosts = { [allCamerasSheet]: 'assignment', [cameraSetupSheet]: 'setup' };
  function drawVirtualSheet(sheetId) {
    const setup = sheetId === cameraSetupSheet, host = $(virtualHosts[sheetId] + '-sheet'), left = host.querySelector('.hc-scroll')?.scrollLeft || 0, rows = sheetCameras(sheetId);
    const tools = host.closest('.hc-controller').querySelector('.hc-controller-tools');
    if (!tools.querySelector('[data-camera-selection]')) tools.insertAdjacentHTML('beforeend', cameraSelectionStrip(sheetId));
    host.innerHTML = '<div class="hc-sheet"><div class="hc-scroll"><table class="hc-grid" role="grid" data-camera-device="' + sheetId + '" aria-label="' + (setup ? 'Cameras' : 'REMI matrix') + '">' + cameraGrid(rows, sheetId) + '</table></div></div>';
    const scroll = host.querySelector('.hc-scroll');
    if (scroll) scroll.scrollLeft = left;
    if (!setup) return;
    // A copy with no source here can't be edited, and it says which controller it came from.
    for (const row of rows.filter(importedCamera)) {
      const selector = 'td[data-camera="' + CSS.escape(row.id) + '"]';
      for (const field of host.querySelectorAll(selector + ' [data-field]:not([data-field="controlEnabled"])')) field.disabled = true;
      const model = host.querySelector(selector + '[data-column="model"]');
      if (model) model.textContent = remiModelName(row);
    }
  }
  const renderControllerSheets = renderCameras;
  renderCameras = function() {
    routeTreeMemo = null;
    // A read may have found the controllers already match what was waiting to be sent.
    for (const camera of cameras) if (!camera.jobs) settleRouteDraft(camera);
    const current = virtualSheet(tab);
    // A sheet only counts as being on the page while its tab has one drawn.
    for (const [sheet, name] of Object.entries(virtualHosts)) {
      if (sheet === current) continue;
      $(name + '-sheet').innerHTML = '';
      delete $(name + '-group').dataset.controller;
    }
    if (!current) { renderControllerSheets(); return; }
    $(virtualHosts[current] + '-group').dataset.controller = current;
    const focus = cameraSheetFocus();
    $('controllers').innerHTML = '';
    drawVirtualSheet(current);
    syncSummary();
    icons();
    refreshCameraSheets(focus);
  };
  function paintRemiView() {
    for (const button of root.querySelectorAll('[data-remi-view]')) button.setAttribute('aria-pressed', String((button.dataset.remiView === 'controllers') === remiByController));
  }
  const showTab = setTab;
  setTab = function(next, save = true) {
    // The REMI Matrix tab comes back to whichever view was last open.
    if (next === 'assignment' && remiByController) next = 'cameras';
    if (next === 'cameras') remiByController = true;
    const crossing = virtualSheet(tab) !== virtualSheet(next);
    showTab(next, false);
    if (next === 'cameras') root.querySelector('#hc-tab-assignment').setAttribute('aria-selected', 'true');
    paintRemiView();
    if (crossing) renderCameras();
    placePendingSends();
    paintPendingSends();
    if (save) remember();
  };
  const saveRemiView = () => ({ panelOpen: pendingSendsOpen, byController: remiByController, unassigned: cameras.filter(unassigned).map(plainRow), devices: { ...deviceSheet },
    ignored: [...ignoredControllers].filter(serial => !devices.some(d => d.serial === serial)).slice(0, 256) });
  function restoreRemiView(data) {
    const view = data.remiView, saved = Array.isArray(view?.unassigned) ? view.unassigned.filter(row => typeof row?.id === 'string' && row.device === '') : [];
    pendingSendsOpen = view?.panelOpen === true;
    remiByController = view?.byController === true;
    ignoredControllers.clear();
    for (const serial of Array.isArray(view?.ignored) ? view.ignored : []) if (typeof serial === 'string' && serial && serial.length <= 160) ignoredControllers.add(serial);
    const sheet = view?.devices ?? {};
    Object.assign(deviceSheet, { lanOpen: sheet.lanOpen === true, wanOpen: sheet.wanOpen === true, details: sheet.details === true,
      sort: deviceSortable.has(sheet.sort?.field) && ['asc', 'desc'].includes(sheet.sort.direction) ? { field: sheet.sort.field, direction: sheet.sort.direction } : null });
    paintDeviceView();
    // Saved before Camera Configuration was one list, this tab meant that page and not the view under REMI Matrix.
    if (data.tab === 'cameras' && view?.byController === undefined) data.tab = 'setup';
    cameras = [...cameras.filter(camera => !unassigned(camera)), ...saved.map(restoredRow)];
  }
  const syncBeforeAssignment = syncSummary;
  syncSummary = function() {
    syncBeforeAssignment();
    const rows = assignmentRows(), matrix = matrixRows(), waiting = rows.length - matrix.length;
    $('all-camera-count').textContent = matrix.length;
    $('camera-count').textContent = rows.length;
    $('assignment-summary').textContent = devices.length + ' controllers · ' + matrix.length + ' cameras';
    $('setup-summary').textContent = rows.length + (rows.length === 1 ? ' camera' : ' cameras') + (waiting ? ' · ' + waiting + ' not assigned' : '');
    $('assignment-note').textContent = ui.sendMode === 'Manual' ? 'Manual · click a circle to send a camera on to that RCP, then send it from Pending sends.' : 'Auto send · circles send as you click them. Deletes, moves and Master RCP changes wait in Pending sends.';
    $('setup-note').textContent = 'Set up each camera, then choose its Source. ' + (ui.sendMode === 'Manual' ? 'Nothing goes to a controller until you press Send in Pending sends.' : 'Settings send as you make them. Deletes and moves wait in Pending sends.');
    for (const name of Object.values(virtualHosts)) {
      const group = $(name + '-group');
      if (group.querySelector('table[data-camera-device]')) syncCameraDeleteButton(group);
    }
    if (['devices', 'setup', 'cameras', 'assignment'].includes(tab)) schedulePendingSends();
  };
  const sendCameraItems = sendItems;
  sendItems = async function(items, kind, deleting = false, fields = null) {
    if (kind === 'camera') items = items.filter(item => !unassigned(item));
    if (!items.length) return;
    await sendCameraItems(items, kind, deleting, fields);
    if (kind !== 'camera' || deleting) return;
    for (const item of items) pruneSentValues(item);
    // A new camera can't be REMI'd until it exists on its controller.
    if (ui.sendMode !== 'Auto send') return;
    const ready = items.filter(item => item.elementKey && !item.jobs && !queuedSends.has(item) && routeHasChanges(item) && !waitsForSend(item));
    if (ready.length) void sendRoutes(ready);
  };
  const mergeControllerSnapshot = mergeSnapshot;
  mergeSnapshot = function(snapshot) {
    const id = snapshot.device.id, before = cameras.filter(row => row.device === id && row.elementKey), flags = cameraControlFlags();
    mergeControllerSnapshot(snapshot);
    routeTreeMemo = null;
    // A camera deleted and added back under a new identity is still that camera, matched by its number
    // on that controller, so it keeps its tick and its chosen master.
    const carried = [];
    for (const old of before) {
      if (cameras.includes(old)) continue;
      const replacement = cameras.find(row => row.device === id && row.elementKey && row.number === old.number && !before.includes(row));
      if (!replacement) continue;
      if (old.remiMaster !== undefined && replacement.remiMaster === undefined) replacement.remiMaster = old.remiMaster;
      if (flags[old.id] === true && flags[replacement.id] !== true) carried.push({ kind: 'camera', controllerId: id, cameraId: replacement.id, enabled: true });
    }
    // The tick is saved against the camera's row, so the row is saved first.
    if (carried.length) queueMicrotask(() => { remember(); submitCameraControl(carried); });
  };
  // A LAN address can be set on two controllers by mistake and a base address can't, so a controller
  // saved on a LAN address is read over its base as soon as the page opens.
  function preferBaseAddresses() {
    if (!moduleBridge || moduleBridge.preview) return;
    void loadRemiJobs();
    for (const d of devices) if (d.base && (d.address || d.base) !== d.base) autoReads.add(d.id);
    if (autoReads.size) scheduleAutoRead(1200);
  }
  // MQTT reports a camera added, deleted or renumbered on a controller, so read that controller again
  // and the lists catch up with no Refresh all. Unlike Refresh all, this leaves pending changes alone.
  const seenCameraChanges = new Map(), autoReads = new Set();
  let autoReadTimer = null;
  function noticeCameraChanges(changes) {
    if (!moduleBridge || moduleBridge.preview || !changes) return;
    for (const [id, count] of Object.entries(changes)) {
      if ((seenCameraChanges.get(id) ?? 0) !== count && device(id)) autoReads.add(id);
      seenCameraChanges.set(id, count);
    }
    if (autoReads.size) scheduleAutoRead(200);
  }
  function scheduleAutoRead(wait) { autoReadTimer ??= setTimeout(runAutoRead, wait); }
  async function runAutoRead() {
    autoReadTimer = null;
    if (!autoReads.size) return;
    // A send reports its own results, and a read partway through one would show half a change.
    if (sendsRunning || cameras.some(camera => camera.jobs > 0 || camera.deleting) || [...remiPanels.values()].some(state => state.busy)) { scheduleAutoRead(500); return; }
    const ids = [...autoReads];
    autoReads.clear();
    try {
      const reply = await moduleBridge.refresh(ids);
      for (const snapshot of reply.snapshots || []) mergeSnapshot(snapshot);
      renderLans();
      renderCameras();
      remember();
    } catch { /* The next change or Refresh all reads it again. */ }
  }
  // Delete marks the camera for Pending sends. A copy comes off by clearing its circle on the camera
  // it was made from, and one whose source isn't here still asks first, as it always has.
  const reviewDeletion = reviewCameraDeletion;
  reviewCameraDeletion = function(camera) {
    if (!camera || camera.deleting) return;
    if (!importedCamera(camera)) { stageRemoval([camera], !camera.removeStaged); return; }
    const source = sourceRowOf(camera);
    if (!source || assignmentDisplay(source, 'remi:' + camera.device).locked && wantedMaster(source) !== camera.device) { reviewDeletion(camera); return; }
    if (source.removeStaged) { stageRemoval([source], false); return; }
    const on = camera.device in wantedRoute(source).links, edit = wantedMaster(source) === camera.device
      ? { rowId: source.id, columnId: 'remiMaster', value: on ? 'None' : camera.device }
      : { rowId: source.id, columnId: 'remi:' + camera.device, value: on ? 'FALSE' : 'TRUE' };
    editCameraRoutes([edit], new Map([[source.id, source]]), true);
  };
  const deleteCameraRow = deleteReviewedCamera;
  deleteReviewedCamera = async function(camera) {
    const { links, keys } = camera && !importedCamera(camera) ? actualRoute(camera) : { links: {}, keys: {} };
    if (Object.keys(links).length) {
      const result = (await requestRoutes([{ id: camera.id, camera: camera.device, key: camera.elementKey, tree: {}, expected: links, copies: keys }])).results?.[0];
      if (!result?.verified) {
        camera.result = 'Error';
        paintItem(camera);
        toast('Camera ' + camera.number + ' was not deleted: ' + (result?.error || 'its REMI copies could not be removed'));
        return;
      }
    }
    deleteCameraRow(camera);
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset, row = id => cameras.find(camera => camera.id === id);
    if (data.remiView) { remiByController = data.remiView === 'controllers'; setTab(remiByController ? 'cameras' : 'assignment'); }
    else if (data.action === 'toggle-pending-sends') setPendingSendsOpen(!pendingSendsOpen);
    else if (data.action === 'stage-remove' && row(data.removeRow)) reviewCameraDeletion(row(data.removeRow));
    else if (data.action === 'clear-from-view' && row(data.clearRow)) clearFromView([row(data.clearRow)]);
    else if (data.action === 'clear-selected') clearFromView(selectedCameras(button.closest('[data-controller]').querySelector('table[data-camera-device]')));
    else if (data.action === 'send-all-pending' || data.action === 'send-all-pending-quick') void sendAllPending();
    else if (data.pendingJobRetry) void settleRemiJob(data.pendingJobRetry, 'retry');
    else if (data.pendingJobDismiss) void settleRemiJob(data.pendingJobDismiss, 'dismiss');
    else if (data.pendingLanSend) { const group = lanDraftGroups().find(item => item.id === data.pendingLanSend); if (group) void sendLanGroup(group); }
    else if (data.pendingLanCancel) cancelLanDrafts(data.pendingLanCancel);
    else if (data.pendingLanItem) cancelLanDrafts(data.pendingLanDevice, data.pendingLanItem);
    else if (data.pendingRemiSend) { const group = remiDraftGroups().find(item => item.id === data.pendingRemiSend); if (group) void remiSend(group.id, group.items); }
    else if (data.pendingRemiCancel) cancelRemiDrafts(data.pendingRemiCancel);
    else if (data.pendingRemiItem) cancelRemiDrafts(data.pendingRemiDevice, data.pendingRemiItem);
    else if (data.action === 'cancel-all-pending') cancelAllPending();
    else if (data.pendingSend && row(data.pendingSend)) void sendPending([row(data.pendingSend)]);
    else if (data.pendingCancel && row(data.pendingCancel)) cancelCamera(row(data.pendingCancel));
    else if (data.pendingCancelLine && row(data.pendingCameraId)) cancelPending([{ camera: row(data.pendingCameraId), line: data.pendingCancelLine }]);
  });
