
  // ── A camera number a controller has twice ─────────────────────────────────
  // A controller can list a number twice: its own camera and a copy of another controller's camera
  // under the same number, or two cameras of its own. Keys still work, because the controller's own
  // camera wins over a copy and its own cameras go together (`numberedCameras` in the control
  // service). This only says so: a mark in the row's gutter on Camera Configuration, a chip beside
  // Pending sends and a list that floats over the sheet. None of it moves anything on the page.
  const conflictCount = count => count === 2 ? 'two' : count === 3 ? 'three' : String(count);
  const conflictNames = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
  function numberConflicts() {
    const groups = new Map();
    for (const camera of cameras) {
      const number = Number(camera.number);
      if (!camera.device || !device(camera.device) || !Number.isInteger(number) || number < 1) continue;
      const key = camera.device + '\n' + number;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(camera);
    }
    const order = orderedDevices().map(item => item.id);
    return [...groups.values()].filter(rows => rows.length > 1).map(rows => {
      const controller = device(rows[0].device), number = Number(rows[0].number);
      const name = row => String(row.name || '').trim() || 'Camera ' + number;
      const own = rows.filter(row => !importedCamera(row)), used = own.length ? own : rows;
      const parts = rows.map(row => ({ name: name(row), own: !importedCamera(row), from: importedCamera(row) ? remiDeviceName(row.remi?.peer ?? row.remi?.origin?.serial) : '' }));
      const what = part => part.own ? 'its own' : 'copied from ' + part.from;
      const listed = parts.length === 2
        ? parts[0].name + ', ' + what(parts[0]) + ', and ' + parts[1].name + ', ' + what(parts[1])
        : conflictNames(parts.map(part => part.name + ' (' + what(part) + ')'));
      const where = 'Keys for camera ' + number + ' on ' + controller.name;
      const usedNames = used.map(name);
      return {
        controller, number, rows, parts, used, usedNames, where,
        tip: controller.name + ' has ' + conflictCount(rows.length) + ' cameras numbered ' + number + ': ' + listed + '. ' + where + (used.length === 1 ? ' use ' + usedNames[0] + '.' : ' act on ' + conflictNames(usedNames) + ' together.'),
      };
    }).sort((a, b) => order.indexOf(a.controller.id) - order.indexOf(b.controller.id) || a.number - b.number);
  }
  // A copy is folded into its camera's row on Camera Configuration, so that row carries the mark for it.
  function conflictTips(conflicts) {
    const tips = new Map(), { parents } = routeTree();
    for (const conflict of conflicts) for (let row of conflict.rows) {
      for (let hops = 0; parents.has(row) && hops < 8; hops++) row = parents.get(row);
      const lines = tips.get(row.id) ?? [];
      if (!lines.includes(conflict.tip)) lines.push(conflict.tip);
      tips.set(row.id, lines);
    }
    return tips;
  }
  let conflictListOpen = false, paintedConflicts = null;
  const conflictChip = document.createElement('button'), conflictList = document.createElement('section');
  (() => {
    Object.assign(conflictChip, { type: 'button', className: 'hc-button hc-conflict-chip', hidden: true });
    conflictChip.dataset.action = 'toggle-number-conflicts';
    conflictChip.setAttribute('aria-expanded', 'false');
    conflictChip.setAttribute('aria-controls', 'hc-number-conflicts');
    conflictChip.innerHTML = icon('triangle-alert') + '<span data-role="number-conflict-count"></span>';
    // It comes and goes, so it sits left of the fixed controls, where nothing is beside it to push.
    root.querySelector('#hc-setup .hc-toolbar-title').after(conflictChip);
    Object.assign(conflictList, { id: 'hc-number-conflicts', className: 'hc-conflict-list', hidden: true });
    conflictList.setAttribute('aria-label', 'Numbers used twice');
    conflictList.innerHTML = '<header><h3>Numbers used twice</h3><button type="button" data-action="toggle-number-conflicts" aria-label="Close numbers used twice">' + icon('x') + '</button></header><div data-role="number-conflict-items"></div>';
    root.querySelector('[data-pending-host="setup"]').append(conflictList);
  })();
  function conflictItemMarkup(conflict) {
    const used = conflict.usedNames.map(name => '<b>' + esc(name) + '</b>');
    return '<div class="hc-conflict-item"><strong>' + esc('Camera ' + conflict.number + ' on ' + conflict.controller.name) + '</strong><ul>' +
      conflict.parts.map(part => '<li><span>' + esc(part.name) + '</span><span>' + esc(part.own ? 'its own camera' : 'copied from ' + part.from) + '</span></li>').join('') + '</ul>' +
      '<p>' + esc(conflict.where) + (used.length === 1 ? ' use ' + used[0] : ' act on ' + conflictNames(used) + ' together') + '. Renumber or remove one to clear this.</p></div>';
  }
  function placeConflictList() {
    const host = conflictList.parentElement.getBoundingClientRect(), chip = conflictChip.getBoundingClientRect();
    conflictList.style.top = Math.round(chip.bottom + 6 - host.top) + 'px';
    conflictList.style.right = Math.max(0, Math.round(host.right - chip.right)) + 'px';
  }
  function paintNumberConflicts() {
    const conflicts = numberConflicts(), tips = conflictTips(conflicts);
    const sheet = $('setup-sheet');
    for (const mark of sheet.querySelectorAll('.hc-conflict-mark')) if (!tips.has(mark.closest('tr')?.dataset.id)) mark.remove();
    let drawn = false;
    for (const [id, lines] of tips) {
      const gutter = [...sheet.querySelectorAll('tr[data-id]')].find(row => row.dataset.id === id)?.querySelector('td.hc-camera-row-gutter');
      if (!gutter) continue;
      const tip = lines.join(' '), mark = gutter.querySelector('.hc-conflict-mark');
      if (mark?.dataset.tip === tip) continue;
      gutter.innerHTML = '<span class="hc-conflict-mark" data-tip="' + esc(tip) + '" aria-label="' + esc(tip) + '">' + icon('triangle-alert') + '</span>';
      drawn = true;
    }
    conflictChip.hidden = !conflicts.length;
    conflictChip.querySelector('[data-role="number-conflict-count"]').textContent = conflicts.length + (conflicts.length === 1 ? ' number used twice' : ' numbers used twice');
    if (!conflicts.length || tab !== 'setup') conflictListOpen = false;
    conflictChip.setAttribute('aria-expanded', String(conflictListOpen));
    conflictList.hidden = !conflictListOpen;
    if (conflictListOpen) {
      const markup = conflicts.map(conflictItemMarkup).join('');
      if (markup !== paintedConflicts) { conflictList.querySelector('[data-role="number-conflict-items"]').innerHTML = markup; paintedConflicts = markup; }
      placeConflictList();
    }
    if (drawn) icons();
  }
  function setConflictListOpen(open) {
    if (conflictListOpen === open) return;
    // Both lists float over the same corner of the sheet, so one opening puts the other away.
    if (open) setPendingSendsOpen(false);
    conflictListOpen = open;
    paintNumberConflicts();
  }
  const renderBeforeConflicts = renderCameras;
  renderCameras = function(...args) { const drawn = renderBeforeConflicts(...args); paintNumberConflicts(); return drawn; };
  // Every edit and every send ends here, so a number typed over, a camera moved or a copy taken off updates the marks.
  const paintPendingBeforeConflicts = paintPendingSends;
  paintPendingSends = function() { paintPendingBeforeConflicts(); paintNumberConflicts(); };
  const setPendingOpenBeforeConflicts = setPendingSendsOpen;
  setPendingSendsOpen = function(open) { if (open) conflictListOpen = false; setPendingOpenBeforeConflicts(open); paintNumberConflicts(); };
  const setTabBeforeConflicts = setTab;
  setTab = function(...args) { setTabBeforeConflicts(...args); paintNumberConflicts(); };
  root.addEventListener('click', event => {
    if (event.target.closest?.('[data-action="toggle-number-conflicts"]')) setConflictListOpen(!conflictListOpen);
  });
  // The list floats over the sheet, so a click anywhere else, or Escape from it, puts it away.
  root.addEventListener('pointerdown', event => {
    if (conflictListOpen && !event.target.closest?.('.hc-conflict-list, [data-action="toggle-number-conflicts"]')) setConflictListOpen(false);
  }, true);
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !conflictListOpen || !event.target.closest?.('.hc-conflict-list, [data-action="toggle-number-conflicts"]')) return;
    event.preventDefault();
    setConflictListOpen(false);
    conflictChip.focus();
  });
