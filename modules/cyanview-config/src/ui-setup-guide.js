  // The setup tour: Next and Back walk through this page in the order Cyanview is set up. Each stop
  // rings one part of the page and points at it with a short arrow and its name; a panel fixed at the
  // bottom says what that part is for and what to do there, and keeps Exit tour, Back and Next in the
  // same place on every stop so the mouse never has to follow them. Nothing has to be done to go on.
  // It starts by itself once on a new setup, and Setup tour in the header starts it again.
  // Progress belongs to this Mac, not the workspace. The page's frame has no storage, so the worker keeps it.
  let setupGuideProgress = parseSetupGuideProgress(null), setupGuideSaving = Promise.resolve();
  let setupGuideLoaded = false, setupGuideKeys = 0, setupGuidePressed = false, setupGuideQueued = false;
  function saveSetupGuide(progress) {
    // Nothing is saved before the saved progress has been read, so an early update can't overwrite it.
    if (!setupGuideLoaded || !moduleBridge?.setupGuide) return;
    setupGuideSaving = setupGuideSaving.then(() => moduleBridge.setupGuide(progress)).catch(() => undefined);
  }
  const setupTourSvg = {
    check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    route: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="hc-icon" aria-hidden="true"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>',
  };
  const setupTourToggle = document.createElement('button');
  setupTourToggle.type = 'button';
  setupTourToggle.className = 'hc-button cv-setup-tour-toggle';
  setupTourToggle.setAttribute('aria-pressed', 'false');
  setupTourToggle.title = 'Walk through setting up Cyanview, one part of the page at a time';
  setupTourToggle.innerHTML = setupTourSvg.route + 'Setup tour';
  root.querySelector('.hc-module-header').append(setupTourToggle);
  // A simulated rig says so in the header, beside Live, wherever the page is.
  const simulatedPill = document.createElement('span');
  simulatedPill.className = 'cv-simulated-pill';
  simulatedPill.innerHTML = '<span aria-hidden="true"></span>Simulated';
  simulatedPill.hidden = true;
  root.querySelector('.hc-live').before(simulatedPill);

  const setupGuideNamed = d => { const name = String(d.name ?? '').trim(); return !!name && name.toLowerCase() !== String(d.serial ?? '').trim().toLowerCase(); };
  function setupGuideFacts() {
    const counts = pendingSendCounts();
    return {
      loaded: setupGuideLoaded,
      controllers: devices.length,
      online: devices.filter(d => d.online).length,
      unnamed: devices.filter(d => !setupGuideNamed(d)).length,
      // As Camera Configuration counts them: a REMI copy on another RCP is the same camera.
      cameras: matrixRows().length,
      pending: counts.total,
      ready: counts.ready,
      remiCopies: cameras.filter(c => c.remi).length,
      keys: setupGuideKeys,
      pressed: setupGuidePressed,
      simulated: !!moduleBridge?.simulated,
    };
  }
  const plural = (count, one, many = one + 's') => count + ' ' + (count === 1 ? one : many);

  // What each stop rings. Headings are found by the column they name, never by what they say, since
  // a sort arrow or an open group changes the words. A sheet heading rings its whole column down to the
  // last row that can be seen; in a sheet turned on its side the heading starts a row, and the row is
  // rung instead.
  const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const openPanel = () => root.querySelector('.hc-panel:not([hidden])');
  const tabButton = id => root.querySelector('.hc-tabs [data-tab="' + id + '"]');
  const inPanel = selector => openPanel()?.querySelector(selector) ?? null;
  const dropdownFor = select => select?.nextElementSibling?.matches('.hc-dropdown') ? select.nextElementSibling : select;
  const deviceHead = id => root.querySelector('[data-role="device-sheet"] th[data-device-header="' + id + '"]');
  const deviceGroupHead = id => root.querySelector('[data-role="device-sheet"] th[data-device-group-header="' + id + '"]');
  const fieldHead = (sheet, field) => root.querySelector('[data-controller="' + sheet + '"] th[data-field-header="' + field + '"]');
  function sheetLine(...heads) {
    return heads.filter(shown).map(head => ({
      el: head,
      rect() {
        const a = head.getBoundingClientRect(), table = head.closest('table'), box = (head.closest('[data-role$="-sheet"]') ?? table).getBoundingClientRect();
        if (head.scope === 'row' || head.closest('tbody')) { const row = head.closest('tr').getBoundingClientRect(); return { left: a.left, top: row.top, right: Math.min(row.right, box.right), bottom: row.bottom }; }
        return { left: a.left, top: a.top, right: a.right, bottom: Math.min(table.getBoundingClientRect().bottom, box.bottom) };
      },
    }));
  }
  const remiTab = () => tab === 'assignment' || tab === 'cameras';
  const ticksHead = () => fieldHead(cameraSetupSheet, 'controlEnabled'), ticksShown = () => shown(ticksHead());

  // The stops, in the order Cyanview is set up and, within a tab, the order the page reads. Each has
  // its setup step, the tab it is on, what it rings, its title (and the ring's tag, when that differs),
  // what that part is for, and what to do there. Moving to another tab is a stop of its own: it stays
  // on the tab just finished and rings the next one, so the change of tab is never a surprise. A stop
  // with nothing to ring is about something that happens in HubDash.
  const setupTourStops = [
    { step: 'find', tab: 'devices', at: () => [dropdownFor($('scan-range')), dropdownFor($('discovery-method')), action('scan')].filter(Boolean), title: 'Discover',
      what: f => 'Pick the network your controllers are on and press Discover. It only reads them, so nothing on them changes.' + (f.simulated ? ' This is Simulated: it finds a simulated RIO and two RCPs on any network.' : '') + ' Know a controller’s address? Type it in the New device row at the bottom of the list instead.',
      todo: 'Pick your network, press Discover, then Add them to Devices.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('name')), title: 'Name', what: 'The name your crew uses. Keys, lists and the REMI Matrix all show it.', todo: 'Click a name and type over it.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('status'), deviceHead('base')), title: 'Status and Base IP', what: 'Online or Offline, read from the controller. Click an IP to open the controller’s own page in Safari. Refresh all, top right, reads every controller again.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceGroupHead('lan'), deviceGroupHead('wan')), title: 'LAN and WAN', what: 'The controller’s network addresses. A change waits in Pending sends until you send it.' },
    { step: 'cameras', tab: 'devices', at: () => tabButton('setup'), title: 'On to Camera Configuration', tag: 'Camera Configuration',
      what: 'That’s your controllers. Your cameras come next, on the Camera Configuration tab: one row for each camera, with the controller it’s plugged into.', todo: 'Press Next to go to Camera Configuration.' },
    { step: 'cameras', tab: 'setup', at: () => inPanel('input[aria-label="Number of cameras"]')?.parentElement, title: 'Number of cameras', what: 'Adds or removes camera rows. New rows join the end.', todo: 'Set how many cameras you have.' },
    { step: 'cameras', tab: 'setup', at: () => sheetLine(...['name', 'model', 'ip', 'port', 'login', 'password'].map(field => fieldHead(cameraSetupSheet, field))), title: 'Camera details',
      what: 'Each camera’s name, model, address and login, so the controller can reach it. The Defaults tab fills in a new camera’s name, address and login.', todo: 'Fill these in for each camera.' },
    { step: 'cameras', tab: 'setup', at: () => sheetLine(fieldHead(cameraSetupSheet, 'source')), title: 'Source', what: 'The RIO or RCP the camera is plugged into. A camera needs one before it can be sent.', todo: 'Pick the controller for each camera.' },
    // A sheet can hide this column; then the tour rings Columns, where it is turned back on.
    { step: 'cameras', tab: 'setup', at: () => ticksShown() ? sheetLine(ticksHead()) : inPanel('[aria-label="Choose visible columns"]'), title: 'Camera Control Enabled', tag: () => ticksShown() ? 'Camera Control Enabled' : 'Columns',
      what: () => 'The cameras a key for a group acts on. Start, Stop and Toggle Recording, ND, ISO, Base Gain, White Balance and Add preset go to the ticked cameras on their controller. A tick is saved at once and sends nothing to the camera.' + (ticksShown() ? '' : ' This sheet hides the column: show it from Columns.'),
      todo: 'Tick the cameras your group keys should act on.' },
    { step: 'send', tab: 'setup', at: () => inPanel('[data-action="toggle-pending-sends"]'), title: 'Pending sends', what: 'Every change waits here, and nothing reaches a controller until it is sent. The bottom right says All changes verified once the controllers have it.', todo: 'Open Pending sends and press Send.' },
    { step: 'send', tab: 'setup', at: () => root.querySelector('[aria-label="Spreadsheet send mode"]'), title: 'Send mode', what: 'Manual waits for you to press Send. Auto send sends each edit as you make it.' },
    { step: 'remi', tab: 'setup', at: () => tabButton('assignment'), title: 'On to REMI Matrix', tag: 'REMI Matrix',
      what: 'That’s your cameras. REMI Matrix, the next tab, shares a camera with other RCPs. You only need it if a camera goes on to more than one RCP.', todo: 'Press Next to go to REMI Matrix.' },
    { step: 'remi', tab: 'assignment', at: () => sheetLine(fieldHead(allCamerasSheet, 'remiMaster')), title: 'Master RCP', what: 'The RCP that controls the camera first.' },
    { step: 'remi', tab: 'assignment', at: () => sheetLine(root.querySelector('[data-controller="' + allCamerasSheet + '"] th.hc-camera-band-remi')), title: 'REMI to', what: 'One column per RCP. Fill a circle to put the camera on that RCP too, and empty it to take it off.', todo: 'Optional. Skip it if each camera stays on one RCP.' },
    // The actions are set up in HubDash's Button Matrix, which this page can't show, so these stops draw an
    // example of it here (the stage) and ring its parts: + Action, then the Action, Cyanview Controller and
    // Camera columns, then each group of the Action list with rows that use it and what each Action does.
    { step: 'actions', stage: { group: false, rows: () => [['CAM 1'], ['CAM 2'], ['REC']] }, at: () => stagePart('add-action'), prefer: 'right', title: 'On to the Button Matrix', tag: '+ Action',
      what: 'Keys get their Cyanview actions in HubDash’s Button Matrix. This is an example of it. + Action adds an action column: pick Cyanview · Module actions and press Add action.', todo: 'In the Button Matrix, press + Action and add Cyanview.' },
    { step: 'actions', stage: { group: true, list: true, rows: () => [['CAM 1', '', '', ''], ['CAM 2', '', '', ''], ['REC', '', '', '']] }, at: () => [stageColumn('action'), { el: stagePart('list'), rect: () => stagePart('list').getBoundingClientRect() }], title: 'Action',
      what: 'What the key does. The list has two headings: RCP set active camera, which has Select camera, and Cyanview, which has the rest. The next stops say what each one does.', todo: 'Pick an Action on each row.' },
    { step: 'actions', stage: { group: true, rows: n => [['CAM 1', 'Select camera', n.rcp, n.cam1], ['CAM 2', 'Select camera', n.rcp, n.cam2], ['REC', 'Start Recording', n.rio, '']] },
      at: () => [stageColumn('controller'), stageColumn('camera')], title: 'Cyanview Controller and Camera', tag: 'Controller and Camera',
      what: 'Cyanview Controller is the controller the key talks to, by the name it has on Devices; Select camera lists RCPs and Gateways. Camera is the camera’s number, for Select camera, Record camera and Enable / Disable Camera. Feedback, further right, lights the key from what Cyanview reports.',
      todo: 'Pick the controller, and the camera where the Action needs one.' },
    { step: 'actions', stage: { group: true, rows: n => [['CAM 1', 'Select camera', n.rcp, n.cam1], ['REC 1', 'Record camera (Toggle)', n.rio, n.cam1]] }, at: () => stageColumn('action'), tag: 'Action', title: 'One camera',
      what: 'Select camera is under RCP set active camera in the Action list; Record camera is under Cyanview.', items: [
      ['Select camera', 'Switches an RCP to that camera, so its panel controls it. Pick the RCP or Gateway and the camera. The key lights Selected while that camera is up.'],
      ['Record camera (Toggle)', 'A tap starts that camera recording. A 2-second hold stops it, so a stray tap can’t cut a take. The key’s outline rings while it records.'],
    ] },
    { step: 'actions', stage: { group: true, rows: n => [['CAM 1 ON', 'Enable / Disable Camera', n.rio, n.cam1], ['ALL ON', 'Enable / Disable All Cameras', n.rio, ''], ['SINGLE', 'Single switch', '', '']] }, at: () => stageColumn('action'), tag: 'Action', title: 'Which cameras a group key uses',
      what: 'These change the Camera Control Enabled ticks and send nothing to the cameras. Leave Cyanview Controller blank to cover every controller.', items: [
      ['Enable / Disable Camera', 'Ticks or clears one camera.'],
      ['Enable / Disable All Cameras', 'Ticks or clears every camera on the controller.'],
      ['Single switch', 'Keeps one camera ticked at a time. Enable / Disable All Cameras ends it.'],
    ] },
    { step: 'actions', stage: { group: true, rows: n => [['REC', 'Start Recording', n.rio, ''], ['STOP', 'Stop Recording', n.rio, ''], ['REC / STOP', 'Toggle Recording', n.rio, '']] }, at: () => stageColumn('action'), tag: 'Action', title: 'Recording',
      what: 'Each goes to the ticked cameras on the controller. A camera that isn’t connected is sent nothing, and the press says so.', items: [
      ['Start Recording', 'Starts every ticked camera recording.'],
      ['Stop Recording', 'Stops every ticked camera.'],
      ['Toggle Recording', 'Stops each ticked camera that is recording and starts each one that isn’t.'],
    ] },
    { step: 'actions', stage: { group: true, rows: n => [['ND +', 'ND Up', n.rio, ''], ['ND −', 'ND Down', n.rio, ''], ['ND IN', 'ND In', n.rio, ''], ['ND OUT', 'ND Out (Clear)', n.rio, ''], ['ND IN / OUT', 'ND In / Out (Toggle)', n.rio, '']] }, at: () => stageColumn('action'), tag: 'Action', title: 'ND',
      what: 'Each goes to the ticked cameras on the controller.', items: [
      ['ND Up / ND Down', 'Steps the ND filter one step up or down.'],
      ['ND In', 'Puts the ND in, on cameras that have an ND in/out switch.'],
      ['ND Out (Clear)', 'Takes the ND out.'],
      ['ND In / Out (Toggle)', 'Takes it out when every such camera has it in, and puts it in otherwise.'],
    ] },
    { step: 'actions', stage: { group: true, rows: n => [['ISO +', 'ISO Up', n.rio, ''], ['ISO −', 'ISO Down', n.rio, ''], ['BASE +', 'Base Gain Up', n.rio, ''], ['BASE −', 'Base Gain Down', n.rio, '']] }, at: () => stageColumn('action'), tag: 'Action', title: 'ISO and Base Gain',
      what: 'Each goes to the ticked cameras on the controller.', items: [
      ['ISO Up / ISO Down', 'Steps the ISO one step up or down.'],
      ['Base Gain Up / Base Gain Down', 'Steps the base gain of cameras that report one. On a two-base camera such as the Burano, Up is High and Down is Low.'],
    ] },
    { step: 'actions', stage: { group: true, rows: n => [['WB', 'White Balance', n.rio, ''], ['PRESET', 'Add preset (Sony VENICE)', n.rio, '']] }, at: () => stageColumn('action'), tag: 'Action', title: 'White Balance and presets',
      what: 'Each goes to the ticked cameras on the controller.', items: [
      ['White Balance', 'Opens a box in HubDash to type a colour temperature (2,000 to 15,000 K) and tint (−99 to +99) for them.'],
      ['Add preset (Sony VENICE)', 'Stores each VENICE’s current white balance as a preset. It doesn’t pick a preset or run auto white balance.'],
    ] },
    { step: 'press', title: 'Press a key', what: f => 'Press a Select camera key on your deck. The ' + (f.simulated ? 'simulated ' : '') + 'RCP switches to that camera, and the key’s bar turns blue while the camera is online.' },
  ];
  // What the page can already see about a step, said on the step's first stop.
  function setupTourStatus(id, facts, done) {
    switch (id) {
      case 'find': return facts.controllers ? 'You have ' + plural(facts.controllers, 'controller') + '. ' + facts.online + ' ' + (facts.online === 1 ? 'is' : 'are') + ' online.' : '';
      case 'name': return !facts.controllers ? '' : facts.unnamed ? plural(facts.unnamed, 'controller is', 'controllers are') + ' still named by serial number.' : facts.controllers === 1 ? 'Your controller has a name.' : 'All ' + facts.controllers + ' controllers have names.';
      case 'cameras': return facts.cameras ? 'You have ' + plural(facts.cameras, 'camera') + '.' : '';
      case 'send': return facts.pending ? plural(facts.pending, 'change is', 'changes are') + ' waiting to send.' : facts.cameras ? 'Everything has been sent and confirmed.' : '';
      case 'remi': return facts.remiCopies ? plural(facts.remiCopies, 'REMI copy', 'REMI copies') + ' on other RCPs.' : '';
      case 'actions': return facts.keys ? plural(facts.keys, 'key uses', 'keys use') + ' Cyanview.' : '';
      case 'press': return done ? 'A Cyanview key has been pressed.' : '';
    }
    return '';
  }

  const setupTour = document.createElement('div');
  setupTour.className = 'cv-tour';
  setupTour.hidden = true;
  setupTour.innerHTML = '<div class="cv-tour-dim" aria-hidden="true"></div><div class="cv-tour-stage" aria-hidden="true" hidden></div><div class="cv-tour-spot" aria-hidden="true"></div>' +
    '<svg class="cv-tour-lines" aria-hidden="true"><defs><marker id="cv-tour-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' +
    '<g class="cv-tour-lead"><path marker-end="url(#cv-tour-tip)"/></g></svg><div class="cv-tour-tag" aria-hidden="true"></div>' +
    '<section class="cv-tour-panel" role="dialog" aria-modal="false" aria-labelledby="cv-tour-title" aria-describedby="cv-tour-what">' +
    '<div class="cv-tour-progress" aria-hidden="true"><span></span></div>' +
    '<div class="cv-tour-step"><b class="cv-tour-marker"></b><span class="cv-tour-step-title"></span><span class="cv-tour-count"></span></div>' +
    '<h3 id="cv-tour-title"></h3><p id="cv-tour-what" class="cv-tour-what"></p><dl class="cv-tour-defs"></dl><p class="cv-tour-status"></p>' +
    '<footer><p class="cv-tour-todo"><strong>What to do:</strong> <span></span></p><span class="cv-tour-buttons"><button type="button" class="cv-tour-exit" data-tour="exit">Exit tour</button>' +
    '<button type="button" class="cv-tour-back" data-tour="back">Back</button><button type="button" class="cv-tour-next" data-tour="next">Next</button></span></footer>' +
    '</section>';
  document.body.append(setupTour);
  const tourDim = setupTour.querySelector('.cv-tour-dim'), tourSpot = setupTour.querySelector('.cv-tour-spot'), tourLines = setupTour.querySelector('.cv-tour-lines');
  const tourLead = setupTour.querySelector('.cv-tour-lead'), tourLine = setupTour.querySelector('.cv-tour-lead path'), tourTag = setupTour.querySelector('.cv-tour-tag');
  const tourPanel = setupTour.querySelector('.cv-tour-panel'), tourStage = setupTour.querySelector('.cv-tour-stage');
  const tourPart = selector => tourPanel.querySelector(selector);
  let setupTourAt = 0, setupTourTimer = null, setupTourPlaced = '';
  // The example Button Matrix: names from this setup where it has them, so the example reads like the user's own.
  const stagePart = name => tourStage.querySelector('[data-stage="' + name + '"]');
  const stageColumn = name => sheetLine(tourStage.querySelector('th[data-stage="' + name + '"]'))[0] ?? null;
  function stageNames() {
    const kind = (d, re) => re.test(String(d.kind ?? d.type ?? ''));
    const rcp = devices.find(d => kind(d, /rcp/i)), rio = devices.find(d => kind(d, /rio/i)) ?? devices.find(d => !kind(d, /rcp/i));
    const numbers = matrixRows().map(row => Number(row.number)).filter(Number.isFinite).sort((a, b) => a - b);
    return { rcp: String(rcp?.name || 'RCP 1'), rio: String(rio?.name || 'RIO 1'), cam1: String(numbers[0] ?? 1), cam2: String(numbers[1] ?? 2) };
  }
  const stageCheck = '<span class="cv-stage-check">' + setupTourSvg.check + '</span>';
  const stageList = '<div class="cv-stage-list" data-stage="list"><span class="cv-stage-search">Type to search</span><b>RCP set active camera</b><span class="cv-stage-on">Select camera</span><b>Cyanview</b>' +
    ['Record camera (Toggle)', 'Enable / Disable Camera', 'Enable / Disable All Cameras', 'Single switch', 'Start Recording', 'Stop Recording'].map(item => '<span>' + item + '</span>').join('') + '<em>Clear</em></div>';
  function paintTourStage(stop) {
    tourStage.hidden = !stop.stage;
    if (!stop.stage) return;
    const { group, list } = stop.stage, rows = stop.stage.rows(stageNames());
    const head = '<tr class="cv-stage-groups"><th></th><th colspan="3">BUTTON DEFINITION</th>' + (group ? '<th colspan="4" data-stage="group"><span class="cv-stage-collapse">−</span>Cyanview — Cyanview</th>' : '') + '<th class="cv-stage-fill"></th></tr>' +
      '<tr><th></th><th>Button ID</th><th>Button Text</th><th>Enabled</th>' + (group ? '<th class="cv-stage-first">Enabled</th><th data-stage="action">Action</th><th data-stage="controller">Cyanview Controller</th><th data-stage="camera">Camera</th>' : '') + '<th class="cv-stage-fill"></th></tr>';
    const body = rows.map((row, index) => '<tr><td class="cv-stage-row">' + (index + 1) + '</td><td>' + (index + 1) + '</td><td class="cv-stage-text">' + esc(row[0]) + '</td><td>' + stageCheck + '</td>' +
      (group ? '<td class="cv-stage-first">' + stageCheck + '</td><td class="cv-stage-action">' + esc(row[1] ?? '') + (list && index === 0 ? stageList : '') + '</td><td>' + esc(row[2] ?? '') + '</td><td>' + esc(row[3] ?? '') + '</td>' : '') + '<td class="cv-stage-fill"></td></tr>').join('');
    tourStage.innerHTML = '<div class="cv-stage-head"><b>Button Matrix</b><span>In HubDash · an example</span></div>' +
      '<div class="cv-stage-toolbar"><span data-stage="add-button">+ Button</span><span data-stage="add-action">+ Action</span></div>' +
      '<table class="cv-stage-grid"><colgroup>' + [34, 84, 118, 76, ...(group ? [76, 230, 190, 90] : [])].map(width => '<col style="width:' + width + 'px">').join('') + '<col></colgroup><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  // Scroll positions the tour changed, put back when it ends.
  const setupTourScrolled = new Map();

  const tourParts = stop => {
    const found = stop.at?.();
    const list = Array.isArray(found) ? found : found ? [found] : [];
    return list.map(part => part instanceof Element ? { el: part, rect: () => part.getBoundingClientRect() } : part).filter(part => shown(part.el));
  };
  // The panel sits just above the page's status line, so that line stays readable, and the tab gets as
  // much room at its end as the panel covers, so its last rows can still be scrolled into view.
  function placeTourPanel() {
    const status = $('saved-label')?.parentElement, bar = status && shown(status) ? status.getBoundingClientRect() : null;
    tourPanel.style.bottom = (bar && bar.top > innerHeight / 2 ? innerHeight - bar.top + 8 : 12) + 'px';
    const scroller = openPanel()?.getBoundingClientRect(), top = tourPanel.getBoundingClientRect().top;
    const tabs = root.querySelector('.hc-tabs')?.getBoundingClientRect();
    Object.assign(tourStage.style, { top: Math.round((tabs?.bottom ?? 60) + 14) + 'px', bottom: Math.round(innerHeight - top + 14) + 'px' });
    root.style.setProperty('--cv-tour-room', Math.max(0, Math.round((scroller?.bottom ?? innerHeight) - top + 12)) + 'px');
  }
  // Brings a stop into view: past a sheet's frozen columns sideways, and wholly above the panel when it
  // fits there, or else from its top down.
  function bringTourPartIntoView(part) {
    const target = part.el, scrollers = [];
    for (let el = target.parentElement; el && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) scrollers.push(el);
    }
    const remember = el => { if (!setupTourScrolled.has(el)) setupTourScrolled.set(el, { left: el.scrollLeft, top: el.scrollTop }); };
    for (const scroller of scrollers) {
      const box = scroller.getBoundingClientRect(), r = target.getBoundingClientRect();
      if (scroller.scrollWidth > scroller.clientWidth) {
        const frozen = [...(target.closest('table')?.querySelectorAll('th[data-hubble-frozen]') ?? [])].filter(shown).map(th => th.getBoundingClientRect().right);
        const left = Math.max(box.left, target.matches('[data-hubble-frozen]') ? box.left : Math.max(box.left, ...frozen)) + 8, right = box.right - 8;
        const shift = r.left < left ? r.left - left : r.right > right ? Math.min(r.right - right, r.left - left) : 0;
        if (shift) { remember(scroller); scroller.scrollLeft += shift; }
      }
      if (scroller.scrollHeight > scroller.clientHeight) {
        const lit = part.rect(), panelTop = tourPanel.getBoundingClientRect().top - 16, top = box.top + 8, bottom = Math.min(box.bottom, panelTop) - 8;
        const shift = lit.top < top || lit.bottom - lit.top > bottom - top ? lit.top - top : lit.bottom > bottom ? lit.bottom - bottom : 0;
        if (shift) { remember(scroller); scroller.scrollTop += shift; }
      }
    }
  }
  function paintTourPanel(facts = setupGuideFacts()) {
    const stop = setupTourStops[setupTourAt], steps = setupGuideSteps(facts, setupGuideProgress);
    const index = steps.findIndex(step => step.id === stop.step), done = steps[index]?.status === 'done';
    const first = setupTourStops.findIndex(item => item.step === stop.step) === setupTourAt, last = setupTourAt === setupTourStops.length - 1;
    const status = first ? setupTourStatus(stop.step, facts, done) : '';
    tourPart('.cv-tour-progress span').style.width = (setupTourAt + 1) / setupTourStops.length * 100 + '%';
    tourPanel.dataset.done = String(done);
    tourPart('.cv-tour-marker').innerHTML = done ? setupTourSvg.check : String(index + 1);
    tourPart('.cv-tour-marker').setAttribute('aria-label', done ? 'Done' : 'Step ' + (index + 1));
    tourPart('.cv-tour-step-title').textContent = steps[index]?.title ?? '';
    tourPart('.cv-tour-count').textContent = (setupTourAt + 1) + ' of ' + setupTourStops.length;
    tourPart('#cv-tour-title').textContent = stop.title;
    tourPart('.cv-tour-what').textContent = typeof stop.what === 'function' ? stop.what(facts) : stop.what;
    const defs = tourPart('.cv-tour-defs');
    defs.replaceChildren(...(stop.items ?? []).map(([name, meaning]) => {
      const row = document.createElement('div'), term = document.createElement('dt'), text = document.createElement('dd');
      term.textContent = name; text.textContent = meaning; row.append(term, text); return row;
    }));
    defs.hidden = !stop.items;
    tourPart('.cv-tour-status').textContent = status;
    tourPart('.cv-tour-status').hidden = !status;
    tourPart('.cv-tour-todo span').textContent = stop.todo ?? '';
    tourPart('.cv-tour-todo').style.visibility = stop.todo ? '' : 'hidden';
    tourPart('.cv-tour-back').disabled = setupTourAt === 0;
    tourPart('.cv-tour-next').textContent = last ? 'Done' : 'Next';
    tourTag.textContent = (typeof stop.tag === 'function' ? stop.tag() : stop.tag) ?? stop.title;
  }
  // The ring goes round what can be seen of the stop, above the panel. Its arrow and name tag sit below
  // it when there is room, then above, then beside it, and never on the panel.
  function placeTour() {
    if (setupTour.hidden) return;
    placeTourPanel();
    const parts = tourParts(setupTourStops[setupTourAt]);
    const vw = innerWidth, vh = innerHeight, floor = tourPanel.getBoundingClientRect().top - 10, pad = 5, gap = 34, edge = 10;
    const rects = parts.map(part => part.rect());
    let r = rects.length ? { left: Math.min(...rects.map(x => x.left)), top: Math.min(...rects.map(x => x.top)), right: Math.max(...rects.map(x => x.right)), bottom: Math.max(...rects.map(x => x.bottom)) } : null;
    if (r) r = { left: Math.max(r.left, 2), top: Math.max(r.top, 2), right: Math.min(r.right, vw - 2), bottom: Math.min(r.bottom, floor - pad) };
    const onScreen = r && r.right - r.left > 4 && r.bottom - r.top > 4;
    const tw = tourTag.offsetWidth, th = tourTag.offsetHeight;
    const key = onScreen ? [r.left, r.top, r.right, r.bottom, tw, th, vw, vh, floor].map(Math.round).join(',') : 'none,' + vw + ',' + vh;
    if (key === setupTourPlaced) return;
    setupTourPlaced = key;
    tourSpot.hidden = tourTag.hidden = !onScreen;
    tourLines.toggleAttribute('hidden', !onScreen);
    if (!onScreen) { tourDim.style.clipPath = 'none'; return; }
    const hx = r.left - pad, hy = r.top - pad, hw = r.right - r.left + pad * 2, hh = r.bottom - r.top + pad * 2, k = Math.min(9, hw / 2, hh / 2);
    Object.assign(tourSpot.style, { left: hx + 'px', top: hy + 'px', width: hw + 'px', height: hh + 'px' });
    tourDim.style.clipPath = 'path(evenodd, "M0 0 H' + vw + ' V' + vh + ' H0 Z M' + (hx + k) + ' ' + hy + ' H' + (hx + hw - k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + hw) + ' ' + (hy + k) +
      ' V' + (hy + hh - k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + hw - k) + ' ' + (hy + hh) + ' H' + (hx + k) + ' A' + k + ' ' + k + ' 0 0 1 ' + hx + ' ' + (hy + hh - k) + ' V' + (hy + k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + k) + ' ' + hy + ' Z")';
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    const cx = (r.left + r.right) / 2, cy = r.top + Math.min((r.bottom - r.top) / 2, 18);
    const places = [
      { fits: r.bottom + pad + gap + th <= floor, x: clamp(cx - tw / 2, edge, vw - tw - edge), y: r.bottom + pad + gap, from: y => [cx, y - 2], to: [cx, r.bottom + pad + 6], nudge: '--cv-tour-ny: -4px' },
      { fits: r.top - pad - gap - th >= edge, x: clamp(cx - tw / 2, edge, vw - tw - edge), y: r.top - pad - gap - th, from: y => [cx, y + th + 2], to: [cx, r.top - pad - 6], nudge: '--cv-tour-ny: 4px' },
      { fits: r.right + pad + gap + tw <= vw - edge, x: r.right + pad + gap, y: clamp(cy - th / 2, edge, floor - th), from: () => [r.right + pad + gap - 2, cy], to: [r.right + pad + 6, cy], nudge: '--cv-tour-nx: -4px' },
      { fits: true, x: Math.max(edge, r.left - pad - gap - tw), y: clamp(cy - th / 2, edge, floor - th), from: () => [r.left - pad - gap + 2, cy], to: [r.left - pad - 6, cy], nudge: '--cv-tour-nx: 4px' },
    ];
    // A stop can ask for a side, as a toolbar button with room beside it does, when the tag fits there.
    const preferred = { below: 0, above: 1, right: 2, left: 3 }[setupTourStops[setupTourAt].prefer];
    const place = (preferred !== undefined && places[preferred].fits ? places[preferred] : null) ?? places.find(item => item.fits);
    Object.assign(tourTag.style, { left: place.x + 'px', top: place.y + 'px' });
    const from = place.from(place.y);
    tourLine.setAttribute('d', 'M ' + from[0] + ' ' + from[1] + ' L ' + place.to[0] + ' ' + place.to[1]);
    tourLead.style.cssText = place.nudge;
  }
  function showTourStop(at) {
    setupTourAt = Math.max(0, Math.min(setupTourStops.length - 1, at));
    const stop = setupTourStops[setupTourAt];
    // The tour opens a stop's tab itself, as a click on the tab would. REMI Matrix shown by controller is the same tab.
    if (stop.tab && tab !== stop.tab && !(stop.tab === 'assignment' && remiTab())) tabButton(stop.tab)?.click();
    const wasOpen = !setupTour.hidden;
    setupTour.hidden = false;
    root.classList.add('cv-touring');
    setupTourToggle.setAttribute('aria-pressed', 'true');
    paintTourPanel();
    paintTourStage(stop);
    placeTourPanel();
    const parts = tourParts(stop);
    if (parts[0]) bringTourPartIntoView(parts[0]);
    tourTag.classList.remove('cv-tour-fresh'); void tourTag.offsetWidth; tourTag.classList.add('cv-tour-fresh');
    setupTourPlaced = '';
    placeTour();
    if (setupTourTimer === null) setupTourTimer = setInterval(placeTour, 150);
    if (!wasOpen || tourPanel.contains(document.activeElement)) tourPart('.cv-tour-next').focus({ preventScroll: true });
  }
  function endTour() {
    if (setupTour.hidden) return;
    const hadFocus = tourPanel.contains(document.activeElement);
    setupTour.hidden = true;
    root.classList.remove('cv-touring');
    root.style.removeProperty('--cv-tour-room');
    setupTourToggle.setAttribute('aria-pressed', 'false');
    if (setupTourTimer !== null) { clearInterval(setupTourTimer); setupTourTimer = null; }
    setupTourPlaced = '';
    for (const [scroller, at] of setupTourScrolled) { scroller.scrollLeft = at.left; scroller.scrollTop = at.top; }
    setupTourScrolled.clear();
    if (hadFocus) setupTourToggle.focus();
  }
  tourPanel.addEventListener('click', event => {
    switch (event.target.closest('[data-tour]')?.dataset.tour) {
      case 'next': if (setupTourAt === setupTourStops.length - 1) endTour(); else showTourStop(setupTourAt + 1); break;
      case 'back': showTourStop(setupTourAt - 1); break;
      case 'exit': endTour(); break;
    }
  });
  tourPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); endTour(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (setupTourAt < setupTourStops.length - 1) showTourStop(setupTourAt + 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (setupTourAt > 0) showTourStop(setupTourAt - 1); }
  });
  setupTourToggle.addEventListener('click', () => { if (setupTour.hidden) showTourStop(0); else endTour(); });
  addEventListener('resize', () => { setupTourPlaced = ''; placeTour(); });

  function paintSetupGuide() {
    const facts = setupGuideFacts();
    const next = nextSetupGuideProgress(setupGuideProgress, facts);
    const startsItself = !setupGuideProgress.offered && next.offered;
    if (next !== setupGuideProgress) { setupGuideProgress = next; saveSetupGuide(next); }
    simulatedPill.hidden = !facts.simulated;
    if (!setupTour.hidden) paintTourPanel(facts);
    if (startsItself && setupTour.hidden) showTourStop(0);
  }
  function scheduleSetupGuide() {
    if (setupGuideQueued) return;
    setupGuideQueued = true;
    queueMicrotask(() => { setupGuideQueued = false; paintSetupGuide(); });
  }
  async function setupGuideLoadedNow() {
    try { if (moduleBridge?.setupGuide) setupGuideProgress = parseSetupGuideProgress(await moduleBridge.setupGuide(null)); }
    catch { /* An older worker or a failed read starts afresh for this visit. */ }
    setupGuideLoaded = true; scheduleSetupGuide();
  }
  // Keys and presses are only known to the worker, which reports them with the camera control state.
  moduleBridge?.subscribe(values => {
    const control = values?.cameraControl;
    if (!control || typeof control !== 'object') return;
    const keys = Number(control.keys) || 0, pressed = control.pressed === true;
    if (keys === setupGuideKeys && pressed === setupGuidePressed) return;
    setupGuideKeys = keys; setupGuidePressed = pressed; scheduleSetupGuide();
  });
