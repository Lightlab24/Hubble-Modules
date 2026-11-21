  // The setup tour: Next and Back walk through this page in the order Cyanview is set up. Each stop
  // lights up one part of the page, points at it, and says what it is for and what to do there.
  // Nothing has to be done to go on, and Exit tour leaves at any stop. It starts by itself once on a
  // new setup, and Setup tour in the header starts it again from the beginning.
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

  // Where each stop points. A sheet heading lights its whole column, heading to last row, so the
  // arrow never crosses the rows under it; in a sheet turned on its side the heading starts a row,
  // and the row is lit instead.
  const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const openPanel = () => root.querySelector('.hc-panel:not([hidden])');
  const tabButton = id => root.querySelector('.hc-tabs [data-tab="' + id + '"]');
  const inPanel = selector => openPanel()?.querySelector(selector) ?? null;
  const dropdownFor = select => select?.nextElementSibling?.matches('.hc-dropdown') ? select.nextElementSibling : select;
  const deviceHead = text => [...(root.querySelectorAll('[data-role="device-sheet"] thead th'))].find(h => h.textContent.replace(/^\+/, '').trim() === text) ?? null;
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

  // Each stop: its setup step, the tab it is on, what it lights, its title, what that part is for and
  // what to do there. A stop with nothing to light is about something that happens in HubDash.
  const setupTourStops = [
    { step: 'find', tab: 'devices', at: () => tabButton('devices'), title: 'Devices', what: 'Every RIO, RCP and Gateway this workspace uses. The number is how many there are.', todo: 'Start here. Finding your controllers happens on this tab.' },
    { step: 'find', tab: 'devices', at: () => dropdownFor($('scan-range')), title: 'Network range', what: 'The network your Cyanview gear is on. Hubble only looks inside this range.', todo: 'Pick your network, or Custom range to type one.' },
    { step: 'find', tab: 'devices', at: () => dropdownFor($('discovery-method')), title: 'Discovery method', what: 'Fast IP discovery asks every address in the range. Broadcast asks the whole network and waits for answers.', todo: 'Leave it on Fast IP discovery unless a controller is missing.' },
    { step: 'find', tab: 'devices', at: () => action('scan'), title: 'Discover', what: f => 'Looks for controllers in the range. It only reads, so nothing on them changes.' + (f.simulated ? ' This is Simulated: it finds a simulated RIO and two RCPs on any network.' : ''), todo: 'Press Discover, then Add them to Devices.' },
    { step: 'find', tab: 'devices', at: () => action('toggle-saved-devices'), title: 'Saved devices', what: 'Controllers this Mac has found before, ready to add back without searching again.' },
    { step: 'find', tab: 'devices', at: () => action('refresh-all'), title: 'Refresh all', what: 'Reads every controller again, to catch changes made on the controllers themselves. It sends nothing.' },
    { step: 'find', tab: 'devices', at: () => root.querySelector('[data-role="device-sheet"] input[aria-label="IP address of a device to add"]'), title: 'Add by address', what: 'Know a controller’s IP? Type it in the New device row and press Enter, and Hubble reads it in.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('Name')), title: 'Name', what: 'The name your crew uses. Keys, lists and the REMI Matrix all show it.', todo: 'Click a name and type over it.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('Status'), deviceHead('Base IP')), title: 'Status and Base IP', what: 'Online or Offline, read from the controller. Click the IP to open the controller’s own page in Safari.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('LAN IP settings'), deviceHead('WAN settings')), title: 'LAN and WAN settings', what: 'The controller’s network addresses. A change waits in Pending sends until you send it.' },
    { step: 'name', tab: 'devices', at: () => sheetLine(deviceHead('Cameras')), title: 'Cameras on each controller', what: 'How many cameras the controller holds. Clear all takes them off when you send.' },
    { step: 'cameras', tab: 'setup', at: () => tabButton('setup'), title: 'Camera Configuration', what: 'One row for every camera: what it is, how it’s reached and where it’s plugged in.' },
    { step: 'cameras', tab: 'setup', at: () => inPanel('input[aria-label="Number of cameras"]')?.parentElement, title: 'Number of cameras', what: 'Adds or removes camera rows. New rows join the end.', todo: 'Set how many cameras you have.' },
    { step: 'cameras', tab: 'setup', at: () => sheetLine(...['model', 'ip', 'port', 'login', 'password'].map(field => fieldHead(cameraSetupSheet, field))), title: 'Model, address and login', what: 'How the controller reaches the camera.', todo: 'Fill these in for each camera.' },
    { step: 'cameras', tab: 'setup', at: () => sheetLine(fieldHead(cameraSetupSheet, 'source')), title: 'Source', what: 'The RIO or RCP the camera is plugged into. A camera needs one before it can be sent.', todo: 'Pick the controller for each camera.' },
    { step: 'cameras', tab: 'setup', at: () => inPanel('[data-action="toggle-camera-logins"]'), title: 'Camera logins', what: 'One login for every camera of a model, so you don’t type it on each row.' },
    { step: 'cameras', tab: 'setup', at: () => inPanel('[aria-label="Sheet layout for this tab"]')?.parentElement, title: 'Sheet layout', what: 'Turns the sheet on its side or hides columns. It only changes what you see.' },
    { step: 'send', tab: 'setup', at: () => inPanel('[data-action="toggle-pending-sends"]'), title: 'Pending sends', what: 'Every change waits here. Nothing reaches a controller until it is sent.', todo: 'Open it and press Send.' },
    { step: 'send', tab: 'setup', at: () => root.querySelector('[aria-label="Spreadsheet send mode"]'), title: 'Send mode', what: 'Manual waits for you to press Send. Auto send sends each edit as you make it.' },
    { step: 'send', tab: 'setup', at: () => $('pending-summary'), title: 'Send status', what: 'Says when everything is on the controllers: All changes verified.' },
    { step: 'remi', tab: 'assignment', at: () => tabButton('assignment'), title: 'REMI Matrix', what: 'Which RCPs can control each camera. You only need it if cameras go on to other RCPs.' },
    { step: 'remi', tab: 'assignment', at: () => sheetLine(fieldHead(allCamerasSheet, 'remiMaster')), title: 'Master RCP', what: 'The RCP that controls the camera first.' },
    { step: 'remi', tab: 'assignment', at: () => sheetLine(root.querySelector('[data-controller="' + allCamerasSheet + '"] th.hc-camera-band-remi')), title: 'REMI to', what: 'One column per RCP. Fill a circle to put the camera on that RCP too, and empty it to take it off.', todo: 'Optional. Skip it if each camera stays on one RCP.' },
    { step: 'actions', title: 'Add Cyanview actions', what: 'Keys get their Cyanview actions in HubDash’s Button Matrix, not on this page.', todo: 'In the Button Matrix, choose + Action, then Cyanview. Pick an Action, the Cyanview Controller and the camera.' },
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
  setupTour.innerHTML = '<div class="cv-tour-dim" aria-hidden="true"></div><div class="cv-tour-spot" aria-hidden="true"></div>' +
    '<svg class="cv-tour-lines" aria-hidden="true"><defs><marker id="cv-tour-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' +
    '<g class="cv-tour-lead"><path marker-end="url(#cv-tour-tip)"/></g></svg>' +
    '<section class="cv-tour-card" role="dialog" aria-modal="false" aria-labelledby="cv-tour-title" aria-describedby="cv-tour-what">' +
    '<div class="cv-tour-progress" aria-hidden="true"><span></span></div>' +
    '<div class="cv-tour-step"><b class="cv-tour-marker"></b><span class="cv-tour-step-title"></span><span class="cv-tour-done">Done</span><span class="cv-tour-count"></span></div>' +
    '<h3 id="cv-tour-title"></h3><p id="cv-tour-what" class="cv-tour-what"></p><p class="cv-tour-status"></p>' +
    '<p class="cv-tour-todo"><strong>What to do:</strong> <span></span></p>' +
    '<footer><button type="button" class="cv-tour-exit" data-tour="exit">Exit tour</button><button type="button" class="cv-tour-back" data-tour="back">Back</button><button type="button" class="cv-tour-next" data-tour="next">Next</button></footer>' +
    '</section>';
  document.body.append(setupTour);
  const tourDim = setupTour.querySelector('.cv-tour-dim'), tourSpot = setupTour.querySelector('.cv-tour-spot'), tourLines = setupTour.querySelector('.cv-tour-lines');
  const tourLead = setupTour.querySelector('.cv-tour-lead'), tourLine = setupTour.querySelector('.cv-tour-lead path'), tourCard = setupTour.querySelector('.cv-tour-card');
  const tourPart = selector => tourCard.querySelector(selector);
  let setupTourAt = 0, setupTourTimer = null, setupTourPlaced = '';

  const tourParts = stop => {
    const found = stop.at?.();
    const list = Array.isArray(found) ? found : found ? [found] : [];
    return list.map(part => part instanceof Element ? { el: part, rect: () => part.getBoundingClientRect() } : part).filter(part => shown(part.el));
  };
  function paintTourCard(facts = setupGuideFacts()) {
    const stop = setupTourStops[setupTourAt], steps = setupGuideSteps(facts, setupGuideProgress);
    const index = steps.findIndex(step => step.id === stop.step), done = steps[index]?.status === 'done';
    const first = setupTourStops.findIndex(item => item.step === stop.step) === setupTourAt, last = setupTourAt === setupTourStops.length - 1;
    const status = first ? setupTourStatus(stop.step, facts, done) : '';
    tourPart('.cv-tour-progress span').style.width = (setupTourAt + 1) / setupTourStops.length * 100 + '%';
    tourCard.dataset.done = String(done);
    tourPart('.cv-tour-marker').innerHTML = done ? setupTourSvg.check : String(index + 1);
    tourPart('.cv-tour-step-title').textContent = steps[index]?.title ?? '';
    tourPart('.cv-tour-count').textContent = (setupTourAt + 1) + ' of ' + setupTourStops.length;
    tourPart('#cv-tour-title').textContent = stop.title;
    tourPart('.cv-tour-what').textContent = typeof stop.what === 'function' ? stop.what(facts) : stop.what;
    tourPart('.cv-tour-status').textContent = status;
    tourPart('.cv-tour-status').hidden = !status;
    tourPart('.cv-tour-todo span').textContent = stop.todo ?? '';
    tourPart('.cv-tour-todo').hidden = !stop.todo;
    tourPart('.cv-tour-back').disabled = setupTourAt === 0;
    tourPart('.cv-tour-next').textContent = last ? 'Done' : 'Next';
  }
  // Below the lit part if the card fits, then above it, then beside it. With nothing to light (a step
  // that happens in HubDash, or a part this setup doesn't have yet), the card waits in the middle.
  function placeTour() {
    if (setupTour.hidden) return;
    const parts = tourParts(setupTourStops[setupTourAt]);
    const rects = parts.map(part => part.rect());
    const vw = innerWidth, vh = innerHeight, cw = tourCard.offsetWidth, ch = tourCard.offsetHeight, pad = 5, gap = 50, edge = 12;
    const r = rects.length ? { left: Math.min(...rects.map(x => x.left)), top: Math.min(...rects.map(x => x.top)), right: Math.max(...rects.map(x => x.right)), bottom: Math.max(...rects.map(x => x.bottom)) } : null;
    const onScreen = r && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    const key = onScreen ? [r.left, r.top, r.right, r.bottom, cw, ch, vw, vh].map(Math.round).join(',') : 'none,' + cw + ',' + ch + ',' + vw + ',' + vh;
    if (key === setupTourPlaced) return;
    setupTourPlaced = key;
    tourSpot.hidden = !onScreen;
    tourLines.toggleAttribute('hidden', !onScreen);
    if (!onScreen) {
      tourDim.style.clipPath = 'none';
      Object.assign(tourCard.style, { left: Math.max(edge, (vw - cw) / 2) + 'px', top: Math.max(edge, (vh - ch) / 2) + 'px' });
      return;
    }
    const hx = r.left - pad, hy = r.top - pad, hw = r.right - r.left + pad * 2, hh = r.bottom - r.top + pad * 2, k = Math.min(9, hw / 2, hh / 2);
    Object.assign(tourSpot.style, { left: hx + 'px', top: hy + 'px', width: hw + 'px', height: hh + 'px' });
    tourDim.style.clipPath = 'path(evenodd, "M0 0 H' + vw + ' V' + vh + ' H0 Z M' + (hx + k) + ' ' + hy + ' H' + (hx + hw - k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + hw) + ' ' + (hy + k) +
      ' V' + (hy + hh - k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + hw - k) + ' ' + (hy + hh) + ' H' + (hx + k) + ' A' + k + ' ' + k + ' 0 0 1 ' + hx + ' ' + (hy + hh - k) + ' V' + (hy + k) + ' A' + k + ' ' + k + ' 0 0 1 ' + (hx + k) + ' ' + hy + ' Z")';
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    const clampX = value => clamp(value, edge, vw - cw - edge), clampY = value => clamp(value, edge, vh - ch - edge);
    let x, y, from, to, nudge;
    if (r.bottom + pad + gap + ch <= vh - edge || r.top - pad - gap - ch >= edge) {
      const below = r.bottom + pad + gap + ch <= vh - edge;
      x = clampX(r.left); y = below ? r.bottom + pad + gap : r.top - pad - gap - ch;
      const tx = r.right - r.left < 24 ? (r.left + r.right) / 2 : clamp(x + 40, r.left + 12, r.right - 12);
      from = [clamp(tx, x + 24, x + cw - 24), below ? y - 2 : y + ch + 2]; to = [tx, below ? r.bottom + pad + 6 : r.top - pad - 6];
      nudge = below ? '--cv-tour-ny: -5px' : '--cv-tour-ny: 5px';
    } else {
      const right = r.right + pad + gap + cw <= vw - edge;
      x = right ? r.right + pad + gap : clampX(r.left - pad - gap - cw); y = clampY(r.top);
      const ty = r.bottom - r.top < 24 ? (r.top + r.bottom) / 2 : clamp(y + 30, r.top + 10, r.bottom - 10);
      from = [right ? x - 2 : x + cw + 2, clamp(ty, y + 20, y + ch - 20)]; to = [right ? r.right + pad + 6 : r.left - pad - 6, ty];
      nudge = right ? '--cv-tour-nx: -5px' : '--cv-tour-nx: 5px';
    }
    Object.assign(tourCard.style, { left: x + 'px', top: y + 'px' });
    tourLine.setAttribute('d', 'M ' + from[0] + ' ' + from[1] + ' L ' + to[0] + ' ' + to[1]);
    tourLead.style.cssText = nudge;
  }
  function showTourStop(at) {
    setupTourAt = Math.max(0, Math.min(setupTourStops.length - 1, at));
    const stop = setupTourStops[setupTourAt];
    // The tour opens a stop's tab itself, as a click on the tab would. REMI Matrix shown by controller is the same tab.
    if (stop.tab && tab !== stop.tab && !(stop.tab === 'assignment' && remiTab())) tabButton(stop.tab)?.click();
    const wasOpen = !setupTour.hidden;
    setupTour.hidden = false;
    setupTourToggle.setAttribute('aria-pressed', 'true');
    paintTourCard();
    tourParts(stop)[0]?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    tourCard.classList.remove('cv-tour-fresh'); void tourCard.offsetWidth; tourCard.classList.add('cv-tour-fresh');
    setupTourPlaced = '';
    placeTour();
    if (setupTourTimer === null) setupTourTimer = setInterval(placeTour, 150);
    if (!wasOpen || tourCard.contains(document.activeElement)) tourPart('.cv-tour-next').focus({ preventScroll: true });
  }
  function endTour() {
    if (setupTour.hidden) return;
    const hadFocus = tourCard.contains(document.activeElement);
    setupTour.hidden = true;
    setupTourToggle.setAttribute('aria-pressed', 'false');
    if (setupTourTimer !== null) { clearInterval(setupTourTimer); setupTourTimer = null; }
    setupTourPlaced = '';
    if (hadFocus) setupTourToggle.focus();
  }
  tourCard.addEventListener('click', event => {
    switch (event.target.closest('[data-tour]')?.dataset.tour) {
      case 'next': if (setupTourAt === setupTourStops.length - 1) endTour(); else showTourStop(setupTourAt + 1); break;
      case 'back': showTourStop(setupTourAt - 1); break;
      case 'exit': endTour(); break;
    }
  });
  tourCard.addEventListener('keydown', event => {
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
    if (!setupTour.hidden) paintTourCard(facts);
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
