  // ----- One part of the page in a window of its own (Nov 27, 2026) -----
  // Right-click Cyanview in Hubble's sidebar, and Open in its own window › offers each part of this page
  // (window-parts.ts). Its window gets the part as `view` and shows only that part under the page's header, with no
  // tabs. Edits there save and follow like any other copy's. Where that window is (its sorts, open controllers and
  // filter) is its own and never saved, so the whole page opens where the operator left it. A link to another part,
  // such as Defaults beside a device type, opens that part's window. The Setup tour walks the whole page, so it stays
  // in the whole page.
  const partWindow = typeof moduleBridge?.view === 'string';
  const shownPart = partWindow && windowParts.some(part => part.view === moduleBridge.view) ? moduleBridge.view : null;
  function openPartWindow(view) {
    const part = windowParts.find(item => item.view === view);
    if (!part || !moduleBridge?.canOpenWindows) return;
    moduleBridge.openWindow(part.view, part.title).catch(() => toast('Hubble could not open ' + part.title + ' in its own window.'));
  }
  if (partWindow) {
    root.classList.add('cv-part-window');
    const nav = root.querySelector('.hc-tabs');
    nav.hidden = true;
    // The tabs can't be seen, but a link may still click one, as Defaults beside a device type does.
    nav.addEventListener('click', event => {
      const button = event.target.closest?.('[data-tab]');
      if (!button) return;
      const wanted = windowPartOfTab(button.dataset.tab);
      if (shownPart && wanted === shownPart) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (wanted) openPartWindow(wanted);
    }, true);
    const gone = document.createElement('p');
    gone.className = 'cv-part-gone';
    gone.setAttribute('role', 'status');
    gone.textContent = 'This part of the page is no longer here.';
    gone.hidden = shownPart !== null;
    root.querySelector('.hc-main').insertBefore(gone, root.querySelector('.hc-global-foot'));
    // This window shows its own part whatever asks for another tab: the page's first drawing, a saved place being
    // put back, or a link. It never saves which tab it is on.
    const setTabBeforePart = setTab;
    setTab = function(next, save = true) {
      const wanted = windowPartOfTab(next);
      if (save && wanted && wanted !== shownPart) openPartWindow(wanted);
      setTabBeforePart(shownPart && wanted === shownPart ? next : windowPartTabs[shownPart ?? 'devices'][0], false);
      // Firmware and Defaults draw their own panels, which the page's tabs don't know.
      if (shownPart === 'firmware' || shownPart === 'defaults') root.querySelector('#hc-' + shownPart).hidden = false;
      if (!shownPart) for (const panel of root.querySelectorAll('.hc-panel')) panel.hidden = true;
    };
    // Where the page is belongs to the whole page.
    const savePageViewOfPage = savePageView;
    savePageView = function() {};
    // A plan last saved before 0.1.112 holds where the whole page was left, and this window's first save leaves it
    // out of the plan, so it is kept for the whole page as the whole page's own first save would keep it.
    const withPageViewBeforePart = withPageView;
    withPageView = function(uiState, view, saved = false) {
      if (saved && heldPlace(uiState)) savePageViewOfPage(splitUiState(uiState).view);
      return withPageViewBeforePart(uiState, view, saved);
    };
    // The Setup tour goes from part to part, so it starts only in the whole page, and its progress is saved there.
    setupTourToggle.hidden = true;
    showTourStop = function() {};
    saveSetupGuide = function() {};
  }
