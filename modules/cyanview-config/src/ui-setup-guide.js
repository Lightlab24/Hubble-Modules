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
      simulated: !!moduleBridge?.preview,
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
        setTab('devices'); if (discoveryCard) discoveryCard.open = true;
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
