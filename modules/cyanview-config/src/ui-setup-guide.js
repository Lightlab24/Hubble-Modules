  // The setup guide: a side panel beside whichever tab is open, drawn like HubDash's Guided setup.
  // Each step ticks itself from what this page and the worker can see. The panel takes its own
  // column, so it never sits on top of a control it asks you to use.
  // Progress belongs to this Mac, not the workspace. The page's frame has no storage, so the worker keeps it.
  let setupGuideProgress = parseSetupGuideProgress(null), setupGuideSaving = Promise.resolve();
  let setupGuideLoaded = false, setupGuideKeys = 0, setupGuidePressed = false;
  function saveSetupGuide(progress) {
    // Nothing is saved before the saved progress has been read, so an early update can't overwrite it.
    if (!setupGuideLoaded || !moduleBridge?.setupGuide) return;
    setupGuideSaving = setupGuideSaving.then(() => moduleBridge.setupGuide(progress)).catch(() => undefined);
  }
  let setupGuideExpanded = { forCurrent: null, id: null }, setupGuidePainted = '', setupGuideQueued = false;
  const setupGuideSvg = {
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevron: expanded => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="guided-setup-chevron" data-expanded="' + expanded + '" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    list: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="hc-icon" aria-hidden="true"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  };
  const setupGuidePanel = document.createElement('aside');
  setupGuidePanel.className = 'guided-setup cv-setup-guide';
  setupGuidePanel.setAttribute('aria-label', 'Cyanview setup guide');
  setupGuidePanel.hidden = true;
  root.querySelector('.hc-window').append(setupGuidePanel);
  const setupGuideToggle = document.createElement('button');
  setupGuideToggle.type = 'button';
  setupGuideToggle.className = 'hc-button cv-setup-guide-toggle';
  setupGuideToggle.dataset.guideAction = 'toggle';
  setupGuideToggle.setAttribute('aria-pressed', 'false');
  setupGuideToggle.innerHTML = setupGuideSvg.list + 'Setup guide';
  root.querySelector('.hc-module-header').append(setupGuideToggle);
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
      cameras: cameras.filter(c => c.device && !c.deleting).length,
      pending: counts.total,
      ready: counts.ready,
      remiCopies: cameras.filter(c => c.remi).length,
      keys: setupGuideKeys,
      pressed: setupGuidePressed,
      simulated: !!moduleBridge?.simulated,
    };
  }
  const plural = (count, one, many = one + 's') => count + ' ' + (count === 1 ? one : many);
  const guidePrimary = (action, label) => '<button class="guided-setup-primary" type="button" data-guide-action="' + action + '">' + esc(label) + '</button>';
  const guideSecondary = (action, label) => '<button class="guided-setup-secondary" type="button" data-guide-action="' + action + '">' + esc(label) + '</button>';
  const guideActions = (...buttons) => '<div class="guided-setup-actions">' + buttons.join('') + '</div>';
  const guideHint = text => '<p class="guided-setup-hint">' + esc(text) + '</p>';
  const guideText = text => '<p>' + esc(text) + '</p>';
  function setupGuideBody(step, facts) {
    switch (step.id) {
      case 'find':
        return facts.controllers
          ? guideText('You have ' + plural(facts.controllers, 'controller') + '. ' + facts.online + ' ' + (facts.online === 1 ? 'is' : 'are') + ' online.') + guideActions(guideSecondary('devices', 'Open Devices'))
          : guideText("Hubble finds RCPs, RIOs and Gateways on your network. On Devices, pick the network they're on and choose Discover.") +
            guideActions(guidePrimary('discover', 'Open Devices')) +
            guideHint("Know a controller's address? Type it in the New device row instead.") +
            guideHint(facts.simulated
              ? 'This is Simulated: Discover finds a simulated RIO and two RCPs on any network.'
              : 'No Cyanview gear here? Turn on Simulated for Cyanview in Module Connections to practise on a simulated RIO and two RCPs.');
      case 'name':
        if (!facts.controllers) return guideText('Find your controllers first. Then name them here.');
        return (facts.unnamed
          ? guideText('Give each controller the name your crew uses, like RCP 1 or RIO A. Buttons and keys show these names. ' + plural(facts.unnamed, 'controller is', 'controllers are') + ' still named by serial number.')
          : guideText('All ' + plural(facts.controllers, 'controller') + ' have names.')) +
          guideActions((facts.unnamed ? guidePrimary : guideSecondary)('devices', 'Open Devices'));
      case 'cameras':
        return (facts.cameras
          ? guideText('You have ' + plural(facts.cameras, 'camera') + '.')
          : guideText("In Camera Configuration, add a camera and fill in Number, Name, Model, IP and Source. Source is the controller it's plugged into.")) +
          guideActions((facts.cameras ? guideSecondary : guidePrimary)('cameras', 'Open Camera Configuration'));
      case 'send':
        if (!facts.cameras) return guideText('Add a camera first. Then send it here.');
        if (!facts.pending) return guideText('Everything has been sent and confirmed.');
        return guideText(plural(facts.pending, 'change is', 'changes are') + ' waiting. Nothing reaches a controller until you send it.') +
          guideActions(...(facts.ready ? [guidePrimary('send', 'Send ' + facts.ready)] : []), guideSecondary('pending', 'Show pending sends')) +
          guideHint('Amber cells go back to normal once the controller confirms them.');
      case 'remi':
        return (facts.remiCopies
          ? guideText(plural(facts.remiCopies, 'REMI copy', 'REMI copies') + ' on other RCPs.')
          : guideText('Send a camera on to other RCPs. In REMI Matrix, pick a Master RCP and fill a circle for each RCP that should also get it.')) +
          guideActions((facts.remiCopies ? guideSecondary : guidePrimary)('remi', 'Open REMI Matrix'));
      case 'actions':
        return facts.keys
          ? guideText(plural(facts.keys, 'key uses', 'keys use') + ' Cyanview.')
          : guideText('In the Button Matrix, choose + Action, then Cyanview. Pick an Action, the Cyanview Controller and the camera.') +
            guideHint('This ticks once a key uses Cyanview.');
      case 'press':
        return step.status === 'done'
          ? guideText('A Cyanview key has been pressed.')
          : guideText('Press a Select camera key on your deck. The ' + (facts.simulated ? 'simulated ' : '') + "RCP switches to that camera, and the key's bar turns blue while the camera is online.");
    }
    return '';
  }
  function paintSetupGuide() {
    const facts = setupGuideFacts();
    const next = nextSetupGuideProgress(setupGuideProgress, facts);
    if (next !== setupGuideProgress) { setupGuideProgress = next; saveSetupGuide(next); }
    const open = setupGuideProgress.open;
    simulatedPill.hidden = !facts.simulated;
    setupGuideToggle.setAttribute('aria-pressed', String(open));
    setupGuidePanel.hidden = !open;
    queueMicrotask(followPointer);
    if (!open) { setupGuidePainted = ''; return; }
    const steps = setupGuideSteps(facts, setupGuideProgress);
    const finished = setupGuideFinished(steps), current = steps.find(step => step.status === 'current')?.id ?? null;
    // Like HubDash, the current step opens by itself, and opening another one holds until the current step changes.
    if (setupGuideExpanded.forCurrent !== current) setupGuideExpanded = { forCurrent: current, id: current };
    const markup =
      '<header class="guided-setup-header"><div><h2>Cyanview setup</h2><p>' + finished + ' of ' + steps.length + ' done</p></div>' +
      '<button class="guided-setup-close" type="button" data-guide-action="close" aria-label="Close setup guide" title="Close. Reopen it with Setup guide anytime.">' + setupGuideSvg.close + '</button></header>' +
      '<div class="guided-setup-progress" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="' + steps.length + '" aria-valuenow="' + finished + '"><span style="width:' + (finished / steps.length * 100) + '%"></span></div>' +
      (facts.simulated ? '<p class="guided-setup-note"><b>Simulated.</b> You’re working on a simulated RIO and RCPs, and nothing goes on the network. Your real Cyanview setup comes back when you turn Simulated off in Module Connections.</p>' : '') +
      '<div class="guided-setup-scroll">' +
      (finished === steps.length ? '<section class="guided-setup-finished"><h3>You’re set up</h3><p>' + esc(facts.simulated ? 'Press a key to try it. Keys send to the simulated controllers.' : 'Press a key to try it. Keys send real commands to your cameras.') + '</p></section>' : '') +
      '<ol class="guided-setup-steps">' + steps.map((step, index) => {
        const expanded = setupGuideExpanded.id === step.id, label = step.status === 'done' ? 'Done' : step.status === 'skipped' ? 'Skipped' : step.optional ? 'Optional' : '';
        return '<li data-status="' + step.status + '" data-step="' + step.id + '">' +
          '<button class="guided-setup-step-heading" type="button" data-guide-step="' + step.id + '" aria-expanded="' + expanded + '" aria-controls="cv-setup-guide-' + step.id + '">' +
          '<span class="guided-setup-marker" aria-hidden="true">' + (step.status === 'done' ? setupGuideSvg.check : index + 1) + '</span>' +
          '<span class="guided-setup-step-title">' + esc(step.title) + '</span>' + (label ? '<small>' + label + '</small>' : '') + setupGuideSvg.chevron(expanded) + '</button>' +
          (expanded ? '<div class="guided-setup-step-body" id="cv-setup-guide-' + step.id + '">' + setupGuideBody(step, facts) +
            (step.status === 'skipped' ? '<button class="guided-setup-text-action" type="button" data-guide-action="unskip" data-guide-target="' + step.id + '">Go back to this step</button>'
              : step.status === 'done' ? '' : '<button class="guided-setup-text-action" type="button" data-guide-action="skip" data-guide-target="' + step.id + '">Skip for now</button>') + '</div>' : '') +
          '</li>';
      }).join('') + '</ol></div>' +
      '<footer class="guided-setup-footer"><p class="guided-setup-hint">More about Cyanview is in Hubble’s Setup Guide.</p></footer>';
    if (markup === setupGuidePainted) return;
    // A repaint keeps keyboard focus on the same control, so an update never takes it away.
    const focused = setupGuidePanel.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.guideStep ? '[data-guide-step="' + focused.dataset.guideStep + '"]' : focused?.dataset.guideAction ? '[data-guide-action="' + focused.dataset.guideAction + '"]' : null;
    const scroll = setupGuidePanel.querySelector('.guided-setup-scroll')?.scrollTop ?? 0;
    setupGuidePanel.innerHTML = markup; setupGuidePainted = markup;
    setupGuidePanel.querySelector('.guided-setup-scroll').scrollTop = scroll;
    if (focusKey) setupGuidePanel.querySelector(focusKey)?.focus();
  }
  function scheduleSetupGuide() {
    if (setupGuideQueued) return;
    setupGuideQueued = true;
    queueMicrotask(() => { setupGuideQueued = false; paintSetupGuide(); });
  }
  function setSetupGuideProgress(change) {
    // The panel changes at once; the save follows behind it.
    setupGuideProgress = { ...setupGuideProgress, ...change };
    saveSetupGuide(setupGuideProgress);
    paintSetupGuide();
  }
  async function setupGuideLoadedNow() {
    try { if (moduleBridge?.setupGuide) setupGuideProgress = parseSetupGuideProgress(await moduleBridge.setupGuide(null)); }
    catch { /* An older worker or a failed read starts the guide afresh for this visit. */ }
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
  function onSetupGuideClick(event) {
    const heading = event.target.closest('[data-guide-step]');
    if (heading) {
      const id = heading.dataset.guideStep;
      setupGuideExpanded = { forCurrent: setupGuideExpanded.forCurrent, id: setupGuideExpanded.id === id ? null : id };
      paintSetupGuide();
      return;
    }
    const button = event.target.closest('[data-guide-action]');
    if (!button) return;
    const target = button.dataset.guideTarget;
    switch (button.dataset.guideAction) {
      case 'toggle': setSetupGuideProgress({ open: !setupGuideProgress.open }); break;
      case 'close': setSetupGuideProgress({ open: false }); setupGuideToggle.focus(); break;
      case 'skip': if (target) setSetupGuideProgress({ skipped: [...new Set([...setupGuideProgress.skipped, target])] }); break;
      case 'unskip': if (target) { setupGuideExpanded = { forCurrent: setupGuideExpanded.forCurrent, id: target }; setSetupGuideProgress({ skipped: setupGuideProgress.skipped.filter(id => id !== target) }); } break;
      case 'discover': {
        setTab('devices');
        // The network list is Hubble's own dropdown, drawn beside the hidden select it stands for.
        const range = $('scan-range'), shown = range?.nextElementSibling?.matches('.hc-dropdown') ? range.nextElementSibling : range;
        shown?.focus();
        break;
      }
      case 'devices': setTab('devices'); break;
      case 'cameras': setTab('setup'); break;
      case 'remi': setTab('assignment'); break;
      case 'send': void sendAllPending(); break;
      case 'pending': if (!['devices', 'setup', 'cameras', 'assignment'].includes(tab)) setTab('setup'); setPendingSendsOpen(true); break;
    }
  }
  setupGuidePanel.addEventListener('click', onSetupGuideClick);
  setupGuideToggle.addEventListener('click', onSetupGuideClick);

  // Pointers: a pulsing ring on the control the open step needs next, an arrow and a label, in the
  // Setup Guide's own blue. They follow the step that is open in the panel (or the current one) and
  // glide to the next control as each part is done. They show only while the panel is open, never
  // take a click, and keep still for anyone who asked macOS for reduced motion.
  const pointer = document.createElement('div');
  pointer.className = 'cv-coach';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.hidden = true;
  pointer.innerHTML = '<div class="cv-coach-ring"></div>' +
    '<svg class="cv-coach-lines"><defs><marker id="cv-coach-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' +
    '<g class="cv-coach-lead"><path marker-end="url(#cv-coach-tip)"/></g></svg><div class="cv-coach-bubble"></div>';
  document.body.append(pointer);
  const pointerRing = pointer.querySelector('.cv-coach-ring'), pointerLine = pointer.querySelector('.cv-coach-lead path'), pointerLead = pointer.querySelector('.cv-coach-lead'), pointerBubble = pointer.querySelector('.cv-coach-bubble');
  let pointerKey = '', pointerTimer = null;
  const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const openPanel = () => root.querySelector('.hc-panel:not([hidden])');
  const tabButton = id => root.querySelector('.hc-tabs [data-tab="' + id + '"]');
  // Where the open step happens next, in the words of the step.
  function pointerTarget(step) {
    switch (step.id) {
      case 'find': {
        if (tab !== 'devices') return { el: tabButton('devices'), text: 'Open Devices' };
        if (shown(root.querySelector('[data-action="stop-scan"]'))) return null;
        const add = root.querySelector('[data-action="add-all-found"]');
        if (shown(add)) return { el: add, text: 'Add them to Devices' };
        const range = $('scan-range');
        if (range?.value) return { el: action('scan'), text: 'Press Discover' };
        return { el: range?.nextElementSibling?.matches('.hc-dropdown') ? range.nextElementSibling : range, text: 'Pick the network they’re on' };
      }
      case 'name': {
        const d = devices.find(item => !setupGuideNamed(item));
        if (!d) return null;
        if (tab !== 'devices') return { el: tabButton('devices'), text: 'Open Devices' };
        return { el: root.querySelector('[data-device-cell="' + CSS.escape(d.id + ':name') + '"]')?.closest('td'), text: 'Type the name your crew uses' };
      }
      case 'cameras': {
        if (tab !== 'setup') return { el: tabButton('setup'), text: 'Open Camera Configuration' };
        const sheet = root.querySelector('[data-controller="' + cameraSetupSheet + '"]');
        const loose = cameras.find(c => c.device === '' && !c.deleting);
        if (loose) return { el: sheet?.querySelector('tr[data-id="' + CSS.escape(loose.id) + '"] [data-column="source"]'), text: 'Pick the controller it’s plugged into' };
        if (!cameras.some(c => c.device)) return { el: sheet?.querySelector('[data-count-step="1"]'), text: 'Add a camera' };
        return null;
      }
      case 'send': {
        if (!pendingSendCounts().total) return null;
        const panel = openPanel();
        const quick = panel?.querySelector('[data-action="send-all-pending-quick"]');
        if (shown(quick)) return { el: quick, text: 'Send them to the controllers' };
        return { el: panel?.querySelector('.hc-toolbar [data-action="toggle-pending-sends"]') ?? tabButton('setup'), text: 'Open Pending sends' };
      }
      case 'remi': {
        if (tab !== 'assignment' && tab !== 'cameras') return { el: tabButton('assignment'), text: 'Open REMI Matrix' };
        if (remiByController) return { el: openPanel()?.querySelector('[data-remi-view="matrix"]'), text: 'Show the Matrix' };
        const box = root.querySelector('[data-controller="' + allCamerasSheet + '"] tbody tr[data-id] [data-column^="remi:"] [role="checkbox"][aria-checked="false"]');
        return box ? { el: box.closest('[data-column]'), text: 'Fill a circle to send it to that RCP' } : null;
      }
    }
    return null;
  }
  // A control that is scrolled away or under something else gets no pointer until it can be clicked.
  function reachable(el) {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  }
  function paintPointer(steps) {
    const open = steps.find(step => step.id === setupGuideExpanded.id && step.status !== 'done');
    const step = open ?? steps.find(item => item.status === 'current');
    const found = setupGuideProgress.open && step ? pointerTarget(step) : null;
    if (!found || !reachable(found.el)) { pointer.hidden = true; pointerKey = ''; return; }
    pointer.hidden = false;
    const r = found.el.getBoundingClientRect(), number = steps.indexOf(step) + 1;
    Object.assign(pointerRing.style, { left: r.left - 5 + 'px', top: r.top - 5 + 'px', width: r.width + 10 + 'px', height: r.height + 10 + 'px' });
    const key = number + found.text;
    if (key !== pointerKey) {
      pointerBubble.innerHTML = '<b>' + number + '</b>' + esc(found.text);
      pointerBubble.classList.remove('cv-coach-fresh'); void pointerBubble.offsetWidth; pointerBubble.classList.add('cv-coach-fresh');
      pointerKey = key;
    }
    const w = pointerBubble.offsetWidth, h = pointerBubble.offsetHeight, mid = r.left + r.width / 2;
    let left, top, from, to, route = '';
    if (found.el.matches('.hc-tab')) {
      // A tab: the label waits in the empty end of the tab row, and its arrow runs just under the
      // row and up into the tab, so it crosses no other tab's name.
      const tabs = found.el.closest('.hc-tabs').getBoundingClientRect(), last = [...found.el.parentElement.querySelectorAll('.hc-tab')].pop().getBoundingClientRect();
      left = Math.min(last.right + 48, innerWidth - w - 12); top = tabs.top + tabs.height / 2 - h / 2;
      const under = tabs.bottom + 12, start = left + 18;
      route = 'M ' + start + ' ' + (top + h + 2) + ' V ' + under + ' H ' + mid + ' V ' + (r.bottom + 9);
      from = [start, top + h]; to = [mid, r.bottom + 9];
    } else {
      // Otherwise under the sheet it points into, so it covers no row; above the control when that won't fit.
      const sheet = [...(found.el.closest('.hc-panel')?.querySelectorAll('table') ?? [])].find(shown);
      const sheetBottom = sheet?.getBoundingClientRect().bottom ?? 0;
      const candidates = [sheetBottom > r.top ? sheetBottom + 58 : r.bottom + 44, r.bottom + 44];
      top = candidates.find(y => y + h < innerHeight - 8);
      left = Math.min(Math.max(12, mid - w / 2), innerWidth - w - 12);
      if (top === undefined) { top = r.top - 44 - h; from = [Math.min(Math.max(mid, left + 16), left + w - 16), top + h + 2]; to = [mid, r.top - 9]; }
      else { from = [Math.min(Math.max(mid, left + 16), left + w - 16), top - 2]; to = [mid, r.bottom + 9]; }
    }
    Object.assign(pointerBubble.style, { left: left + 'px', top: top + 'px' });
    pointerLine.setAttribute('d', route || 'M ' + from[0] + ' ' + from[1] + ' L ' + to[0] + ' ' + to[1]);
    pointerLead.dataset.direction = to[1] < from[1] ? 'up' : 'down';
  }
  function pointerSteps() { return setupGuideSteps(setupGuideFacts(), setupGuideProgress); }
  // Layout moves under the pointer as sheets scroll and rows change, so it is redrawn a few times a second while the panel is open.
  function followPointer() {
    const open = setupGuideProgress.open && setupGuideLoaded;
    if (open && pointerTimer === null) pointerTimer = setInterval(() => paintPointer(pointerSteps()), 150);
    if (!open && pointerTimer !== null) { clearInterval(pointerTimer); pointerTimer = null; }
    if (!open) { pointer.hidden = true; pointerKey = ''; }
    else paintPointer(pointerSteps());
  }
