  // ----- Open in two places at once (Nov 25, 2026) -----
  // This page can be open in two HubDash windows, or in HubDash on two computers, all on one running module. Each
  // copy used to hold the plan it read when it opened and save its whole plan back, so a second copy silently undid
  // the first one's edits, and every tab click in one saved the plan and pulled the other along.
  // - Where the page is (its tab, sorts, open controllers, filter, the Pending sends panel and the REMI view) is
  //   this copy's own. It isn't saved in the plan; the worker keeps the last one on the computer Hubble runs on,
  //   for the next copy that opens.
  // - The worker publishes the saved plan's revision. A copy that sees one it doesn't hold reads the plan again and
  //   draws it where it is, once it has nothing of its own on the way: no save, no send, no read of a controller
  //   and no cell being typed in.
  // - A save made on an older plan than the saved one puts this copy's own changes onto it (plan-merge.ts).
  const pageViewKeys = ['tab', 'openControllers', 'cameraSortByDevice', 'deviceFilter', 'scanRange'];
  const remiViewKeys = ['panelOpen', 'byController', 'devices'];
  // What remember() would save, taken without saving anything.
  function uiStateSnapshot() {
    capturingUiState = true;
    try { return remember(); } finally { capturingUiState = false; }
  }
  /** The page's state as remember() makes it, split into what is shared with every copy and where this copy is. */
  function splitUiState(snapshot) {
    if (!snapshot?.privateContent) return { shared: snapshot ?? null, view: null };
    const { activeTab, ...modelContent } = snapshot.modelContent ?? {};
    const privateContent = { ...snapshot.privateContent }, view = {};
    for (const key of pageViewKeys) if (key in privateContent) { view[key] = privateContent[key]; delete privateContent[key]; }
    if (privateContent.remiView) {
      const remiView = { ...privateContent.remiView };
      view.remiView = {};
      for (const key of remiViewKeys) if (key in remiView) { view.remiView[key] = remiView[key]; delete remiView[key]; }
      privateContent.remiView = remiView;
    }
    return { shared: { ...snapshot, modelContent, privateContent }, view };
  }
  /**
   * A saved page state with this copy's place laid over it. A plan last saved before 0.1.112 still holds the place it
   * was left in, which is newer than any kept on this computer, so a page opening on it (`saved`) starts there. This
   * version saves the plan without it the first time anything is saved.
   */
  const heldPlace = uiState => { const data = uiState?.privateContent; return !!data && (pageViewKeys.some(key => key in data) || remiViewKeys.some(key => key in (data.remiView ?? {}))); };
  function withPageView(uiState, view, saved = false) {
    if (!view || saved && heldPlace(uiState)) return uiState;
    const data = { revision: 6, ...(uiState?.privateContent ?? {}) };
    for (const key of pageViewKeys) if (key in view) data[key] = view[key];
    data.remiView = { ...(data.remiView ?? {}), ...(view.remiView ?? {}) };
    return { ...(uiState ?? {}), privateContent: data };
  }
  /** The plan this copy would save now. */
  function currentPlan() {
    const snapshot = uiStateSnapshot();
    if (!snapshot) throw new Error('Changes could not be saved');
    return copyPresentation(snapshotPlan(splitUiState(snapshot).shared));
  }

  // Where this copy is, saved as it changes. One save is out at a time and the latest place goes next.
  let lastPageView = '', pageViewWaiting = null, pageViewWriting = false;
  function savePageView(view) {
    if (!view || !moduleBridge?.pageView) return;
    const text = JSON.stringify(view);
    if (text === lastPageView) return;
    lastPageView = text; pageViewWaiting = view;
    if (!pageViewWriting) void writePageView();
  }
  async function writePageView() {
    pageViewWriting = true;
    try {
      while (pageViewWaiting) {
        const view = pageViewWaiting; pageViewWaiting = null;
        try { await moduleBridge.pageView(view); } catch { /* The next change saves it again. */ }
      }
    } finally { pageViewWriting = false; }
  }
  async function readPageView() {
    try { const reply = await moduleBridge.pageView(null), view = reply?.view ?? null; lastPageView = JSON.stringify(view); return view; }
    catch { return null; }
  }

  // ----- Following the saved plan -----
  let savedPlanRevision, followTimer = null, followReading = false;
  function typingInPage() {
    if (root.querySelector('input.hc-cell-editing') || typedDeviceCell) return true;
    const active = document.activeElement;
    return !!active && root.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(active.type)) && active.value !== active.defaultValue;
  }
  const followWaits = () => moduleBridge.busy() || autoReadWaits() || addingDiscovered || deviceAddBusy || persistence === 'draft' || typingInPage();
  function scheduleFollow(wait) { if (followTimer === null) followTimer = setTimeout(followSavedPlan, wait); }
  async function followSavedPlan() {
    followTimer = null;
    if (savedPlanRevision === undefined || savedPlanRevision === moduleBridge.revision || followReading) return;
    if (followWaits()) { scheduleFollow(250); return; }
    followReading = true;
    const held = moduleBridge.revision;
    let again = 250;
    try {
      const fresh = await moduleBridge.latest();
      // Something of this copy's own started meanwhile, and it brings its own plan back.
      if (moduleBridge.revision !== held || followWaits()) return;
      const from = moduleBridge.base;
      moduleBridge.accept(fresh.plan, fresh.revision);
      if (fresh.plan) adoptSavedPlan(from, fresh.plan);
    } catch { again = 2000; }
    finally {
      followReading = false;
      if (savedPlanRevision !== moduleBridge.revision) scheduleFollow(again);
    }
  }
  const applyLiveStateBeforeFollow = applyLiveState;
  applyLiveState = function(values) {
    const applied = applyLiveStateBeforeFollow(values);
    if (values && 'planRevision' in values && values.planRevision !== savedPlanRevision) { savedPlanRevision = values.planRevision; scheduleFollow(0); }
    return applied;
  };

  // ----- Drawing a saved plan where the page is -----
  // Fields that are this copy's own: live reports, work in progress, and what a controller read brought in.
  const ownFields = new Set(['online', 'lastSeen', 'jobs', 'deleting', 'modelCatalog', 'models', 'lensOptions', 'snapshot']);
  const plainCopy = value => value === undefined ? undefined : copyPresentation(value);
  const unassignedIn = plan => plan?.uiState?.privateContent?.remiView?.unassigned ?? [];
  const cameraRow = row => withoutFormerLensDefaults(restoredRow(row));
  /** What changed in a row between `was` and `now`, put into `local` where this copy hasn't changed it since `was`. */
  function adoptFields(local, was, now, restored) {
    const before = was ? restored(was) : {}, after = restored(now);
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (ownFields.has(field)) continue;
      if (field === 'dirty') {
        const old = new Set(before.dirty ?? []), next = new Set(after.dirty ?? []);
        for (const name of next) if (!old.has(name)) local.dirty.add(name);
        for (const name of old) if (!next.has(name)) local.dirty.delete(name);
        continue;
      }
      if (samePlanValue(after[field], before[field]) || !samePlanValue(local[field], before[field])) continue;
      if (after[field] === undefined) delete local[field]; else local[field] = plainCopy(after[field]);
    }
  }
  /** Rows the saved plan added, changed or removed between `fromRows` and `toRows`. A row with a send running is left as it is. */
  function adoptRows(list, fromRows, toRows, restored, add) {
    const before = new Map(fromRows.map(row => [row.id, row])), after = new Set(toRows.map(row => row.id));
    for (const now of toRows) {
      const local = list().find(row => row.id === now.id);
      if (!local) add(restored(now));
      else if (!local.jobs && !local.deleting) adoptFields(local, before.get(now.id), now, restored);
    }
    return [...before.keys()].filter(id => !after.has(id) && list().some(row => row.id === id && !row.jobs && !row.deleting));
  }
  /**
   * The saved plan `to` drawn into this copy, which held `from`. Fields this copy changed since `from` keep their
   * value. The tab, sorts, open controllers, filter, scroll and the cell in use stay as they are.
   */
  function adoptSavedPlan(from, to) {
    // What this copy holds before anything is drawn in, to tell what it has changed since `from`.
    const held = uiStateSnapshot(), place = splitUiState(held).view;
    const lists = plan => ({ savedDevices: plan?.savedDevices, cameraLogins: plan?.cameraLogins, defaults: plan?.defaults });
    const heldLists = { savedDevices: savedDeviceList(), cameraLogins: savedCameraLogins(), defaults: savedDefaults() };
    const shared = uiState => { const value = splitUiState(uiState).shared; if (value?.privateContent?.remiView) delete value.privateContent.remiView.unassigned; return value; };
    for (const id of adoptRows(() => devices, from?.devices ?? [], to.devices ?? [], row => plainCopy(row), row => devices.push({ ...row, online: null }))) {
      devices.splice(devices.findIndex(d => d.id === id), 1);
    }
    const goneCameras = new Set(adoptRows(() => cameras, [...(from?.cameras ?? []), ...unassignedIn(from)], [...(to.cameras ?? []), ...unassignedIn(to)], cameraRow, row => cameras.push(row)));
    if (goneCameras.size) cameras = cameras.filter(row => !goneCameras.has(row.id));
    const goneLans = new Set(adoptRows(() => lans, from?.lans ?? [], to.lans ?? [], restoredRow, row => lans.push(row)));
    if (goneLans.size) lans = lans.filter(row => !goneLans.has(row.id));
    lans = withoutDuplicateRows(lans);
    // The Defaults tab and Saved devices, where this copy hasn't changed them.
    if (!samePlanValue(lists(from), lists(to)) && (!from || samePlanValue(heldLists, lists(from)))) restoreSavedLists(to);
    syncConnections();
    // Columns, layouts, controller order and settings are shared; where this copy is stays its own.
    if (!samePlanValue(shared(from?.uiState), shared(to.uiState)) && (!from || samePlanValue(shared(held), shared(from.uiState)))) {
      for (const state of remiPanels.values()) { state.drafts = new Map(); state.overrides = {}; }
      restore(withPageView(to.uiState, place));
    } else {
      for (const id of [...openControllers]) if (!device(id)) openControllers.delete(id);
      syncFilter(); renderLans(); renderCameras();
    }
    renderResults();
    syncSummary();
  }
  /** Who a merged save found the other copy had changed too, in the page's own words. */
  function mergeConflictName(item) {
    const row = item.row ?? {}, on = device(row.device) ? ' on ' + device(row.device).name : '';
    if (item.kind === 'devices') return row.name || row.serial || 'A controller';
    if (item.kind === 'lans') return 'The address ' + (row.planned || row.current || '') + on;
    if (item.kind === 'cameras' || item.kind === 'unassigned') return 'Camera ' + (row.number ?? '') + (row.name ? ' (' + row.name + ')' : '') + on;
    if (item.kind === 'logins') return 'The ' + (row.model || 'camera model') + ' row on Defaults';
    return 'Defaults';
  }
  function mergeConflictMessage(conflicts) {
    const kept = conflicts.filter(item => !item.removed), gone = conflicts.filter(item => item.removed);
    const names = list => list.slice(0, 3).map(mergeConflictName).join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '');
    return [
      kept.length ? names(kept) + (kept.length === 1 ? ' was' : ' were') + ' also changed in another window. What you typed is kept.' : '',
      gone.length ? names(gone) + (gone.length === 1 ? ' was' : ' were') + ' removed in another window, so your change' + (gone.length === 1 ? ' to it is' : 's to them are') + ' gone.' : '',
    ].filter(Boolean).join(' ');
  }
  if (moduleBridge?.onMerge) moduleBridge.onMerge((from, to, conflicts) => {
    adoptSavedPlan(from, to);
    if (conflicts.length) toast(mergeConflictMessage(conflicts));
  });
