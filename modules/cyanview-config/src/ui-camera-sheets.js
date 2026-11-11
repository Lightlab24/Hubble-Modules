  // A tab is a saved way of looking at one controller's cameras: which settings it
  // shows, their sizes, and which way round the sheet is. The tab strip is gone from the
  // page, so each sheet shows the tab it was last on, and the saved tabs are kept as they
  // were so an older version of this module still opens them.
  const cameraSheetsByDevice = {};
  const settingHeaderId = 'hc:setting';
  function cameraSheetState(id) {
    return cameraSheetsByDevice[id] ??= { activeSheetId: 'settings', sheets: [{ id: 'settings', name: 'Settings', view: 'rows' }] };
  }
  function activeCameraSheet(id) {
    const state = cameraSheetState(id);
    return state.sheets.find(sheet => sheet.id === state.activeSheetId) ?? state.sheets[0];
  }
  function cameraSheetView(id) { return activeCameraSheet(id).view; }
  function liveCameraSheet(id) {
    return { layout: cameraLayout(id), hidden: [...hiddenCameraColumns(id)], expanded: axisGroups(id) };
  }
  function cameraSheetList(id) {
    const active = activeCameraSheet(id);
    return cameraSheetState(id).sheets.map(sheet => ({ ...sheet, ...(sheet === active ? liveCameraSheet(id) : {}) }));
  }
  function showCameraSheet(id, sheet) {
    cameraSheetState(id).activeSheetId = sheet.id;
    cameraLayouts.set(id, copyPresentation(sheet.layout));
    hiddenCameraColumnsByDevice[id] = new Set(sheet.hidden);
    axisGroupsByDevice[id] = { ...sheet.expanded };
  }
  function setCameraSheetView(id, view) {
    if (cameraSheetView(id) !== view) changeCameraPresentation(id, () => { activeCameraSheet(id).view = view; });
  }
  // The tab on screen is saved in the existing layout fields, so an older version of
  // this module still opens the workspace showing that tab.
  function cameraSheetsRecord(id, sheets, activeSheetId) {
    return { activeSheetId, sheets: sheets.map(({ layout, hidden, expanded, ...sheet }) => sheet.id === activeSheetId ? sheet : { ...sheet, layout: pruneCameraLayout(id, layout), hidden, expanded }) };
  }
  function saveCameraSheets() {
    return Object.fromEntries(sheetOwners().map(d => [d.id, cameraSheetsRecord(d.id, cameraSheetList(d.id), cameraSheetState(d.id).activeSheetId)]));
  }
  function restoreCameraSheets(data) {
    for (const id of Object.keys(cameraSheetsByDevice)) delete cameraSheetsByDevice[id];
    const known = new Set(cameraSheetSections().flatMap(section => section.fields.map(field => field.id)));
    for (const d of sheetOwners()) {
      const saved = data.cameraSheetsByDevice?.[d.id];
      if (!Array.isArray(saved?.sheets)) continue;
      const sheets = [];
      for (const sheet of saved.sheets) {
        const name = typeof sheet?.name === 'string' ? sheet.name.trim() : '';
        if (typeof sheet?.id !== 'string' || !sheet.id || !name || sheets.some(item => item.id === sheet.id)) continue;
        const expanded = Object.fromEntries(cameraAxes.map(axis => [axis, sheet.expanded?.[axis] === true]));
        sheets.push({ id: sheet.id, name, view: sheet.view === 'columns' ? 'columns' : 'rows', layout: cleanCameraLayout(d.id, sheet.layout), hidden: Array.isArray(sheet.hidden) ? sheet.hidden.filter(field => known.has(field)) : [], expanded });
      }
      if (!sheets.length) continue;
      const active = sheets.find(sheet => sheet.id === saved.activeSheetId);
      cameraSheetsByDevice[d.id] = { activeSheetId: (active ?? sheets[0]).id, sheets };
      if (!active) showCameraSheet(d.id, sheets[0]);
    }
  }
  function cameraCellPosition(deviceId, cameraId, field) {
    const flipped = cameraSheetView(deviceId) === 'columns';
    return ' data-camera="' + esc(cameraId) + '" data-hubble-column="' + esc(flipped ? cameraId : field) + '" data-hubble-row="' + esc(flipped ? field : cameraId) + '"';
  }
  function cameraViewControl(id) {
    const button = (view, label) => '<button type="button" data-action="camera-view" data-id="' + esc(id) + '" data-view="' + view + '" aria-pressed="' + (cameraSheetView(id) === view) + '">' + label + '</button>';
    return '<div class="hc-segment hc-camera-view" role="group" aria-label="Sheet layout for this tab">' + button('rows', 'Cameras in rows') + button('columns', 'Cameras in columns') + '</div>';
  }
  function paintCameraView(strip, id) {
    const view = cameraSheetView(id);
    strip.querySelectorAll('[data-action="camera-view"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  }
  const cameraHeading = camera => '<strong>' + esc(camera.number) + '</strong><span>' + esc(camera.name) + '</span>';
  function cameraColumnSection(field) {
    if (field.group) return { id: field.group, label: axisName(field.group), axis: field.group };
    if (isAssignmentField(field.id)) return { id: 'route', label: 'REMI' };
    if (field.id === 'sync') return { id: 'sync', label: 'Sync' };
    if (field.id === 'lens' || field.id === 'connection') return { id: 'lens', label: 'Lens' };
    return { id: 'camera', label: 'Camera' };
  }
  function flippedCameraGrid(rows, columns, deviceId, cell) {
    const layout = cameraLayout(deviceId), width = camera => layout.cameraWidths?.[camera.id] ?? 168;
    const fields = columns.filter(column => column.id !== 'row' && !column.tool).map(({ frozen, ...field }) => ({ ...field, label: cameraSortLabels[field.id] ?? field.label }));
    const frozen = ' class="hc-camera-frozen" style="left:0"';
    const head = '<colgroup><col style="width:' + (layout.settingWidth ?? 190) + 'px">' + rows.map(camera => '<col data-hubble-column="' + esc(camera.id) + '" data-label="Camera ' + esc(camera.number) + '" style="width:' + width(camera) + 'px">').join('') + '</colgroup>' +
      '<thead><tr><th scope="col"' + frozen + ' data-setting-header>Setting</th>' + rows.map(camera => '<th scope="col" data-camera-header="' + esc(camera.id) + '" title="' + esc(camera.name) + '"><div class="hc-camera-heading" data-camera-heading="' + esc(camera.id) + '">' + cameraHeading(camera) + '</div></th>').join('') + '</tr></thead>';
    let section = null, body = '';
    for (const field of fields) {
      const band = cameraColumnSection(field);
      if (band.id !== section) {
        section = band.id;
        body += '<tr class="hc-camera-section-row"><td class="hc-camera-frozen hc-camera-section-label" style="left:0" role="rowheader">' + (band.axis ? '<div data-axis-header="' + band.axis + '"></div>' : esc(band.label)) + '</td>' + (rows.length ? '<td class="hc-camera-section-rest" colspan="' + rows.length + '"></td>' : '') + '</tr>';
      }
      if (field.placeholder) continue;
      body += '<tr data-setting="' + field.id + '"><td class="hc-camera-frozen hc-camera-setting-label" style="left:0" role="rowheader"' + cameraSortAria(field, deviceId) + '>' + cameraSortHeading(field, deviceId) + '</td>' + rows.map(camera => { initializeLensFields(camera); return cell(camera, field); }).join('') + '</tr>';
    }
    return head + '<tbody>' + body + '</tbody>';
  }
  // Cameras as columns have no row of their own, so their cells are found by camera.
  function paintCameraColumn(item) {
    const id = CSS.escape(item.id);
    root.querySelectorAll('tr[data-setting] td[data-camera="' + id + '"]').forEach(cell => {
      const control = cell.querySelector('[data-field]');
      if (control) cell.classList.toggle('hc-changed', item.dirty.has(control.dataset.field) || routeChanged(item, control.dataset.field));
      if (item.deleting) cell.querySelectorAll('[data-field],input[data-lens-axis]').forEach(element => { element.disabled = true; });
    });
    root.querySelectorAll('[data-camera-heading="' + id + '"]').forEach(heading => {
      const markup = cameraHeading(item);
      if (heading.innerHTML !== markup) heading.innerHTML = markup;
      heading.closest('th').title = item.name;
    });
  }
  function flippedResizeItems(table) {
    return [
      ...[...table.querySelectorAll('th[data-setting-header],th[data-camera-header]')].map(header => {
        const camera = header.dataset.cameraHeader;
        return { id: camera ?? settingHeaderId, header, axis: 'column', label: camera ? 'camera ' + (cameras.find(item => item.id === camera)?.number ?? '') : 'setting names', size: header.offsetWidth, min: camera ? 72 : 100, max: 640 };
      }),
      ...[...table.tBodies[0].querySelectorAll('tr[data-setting]')].map(row => ({ id: row.dataset.setting, header: row.cells[0], axis: 'row', label: cameraFieldName(row.dataset.setting) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
    ];
  }
  function resizeFlippedSheet(id, item, axis, size) {
    const layout = cameraLayout(id);
    if (axis === 'row') (layout.settingHeights ??= {})[item] = size;
    else if (item === settingHeaderId) layout.settingWidth = size;
    else (layout.cameraWidths ??= {})[item] = size;
  }
  root.querySelector('#hc-cameras .hc-panel-foot .hc-caption').textContent = 'Each tab keeps its own settings and layout';
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-action="camera-view"]');
    if (button) setCameraSheetView(button.dataset.id, button.dataset.view);
  });
