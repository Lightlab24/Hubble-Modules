  const cameraLayouts = new Map();
  const cameraAxes = ['iris', 'zoom', 'focus'];
  function cameraLayout(id) {
    if (!cameraLayouts.has(id)) cameraLayouts.set(id, {
      version: 2, columns: {}, rows: {}, groups: {}, hiddenGroups: [], textSize: 13,
    });
    return cameraLayouts.get(id);
  }
  function cameraSheetSections() {
    return [
      { id: 'camera', label: 'Camera', fields: [
        { id: 'number', label: 'Camera number' }, { id: 'name', label: 'Camera name' },
        { id: 'model', label: 'Camera model' }, { id: 'ip', label: 'Camera IP / interface' },
        { id: 'port', label: 'Port' }, { id: 'login', label: 'Username' }, { id: 'password', label: 'Password' },
        { id: 'controlEnabled', label: 'Camera Control Enabled' }, { id: 'control', label: 'Control status' },
        { id: 'recording', label: 'Recording' }, { id: 'cameraStatus', label: 'Recording status' }, { id: 'sync', label: 'Sync status' },
      ] },
      { id: 'lens', label: 'Lens', fields: [{ id: 'lens', label: 'Lens model' }, { id: 'connection', label: 'Lens connection' }] },
      ...cameraAxes.map(axis => ({ id: axis, axis, label: axisName(axis), fields: [
        { id: axis + 'Summary', label: 'Setup', width: 78, summary: true }, ...axisDefinitions[axis],
      ] })),
    ];
  }
  function cameraFieldVisible(id, field, ignoreGroup = false) {
    const section = cameraSheetSections().find(section => section.fields.some(column => column.id === field));
    const retained = section?.axis && !axisGroups(id)[section.axis] && cameraLayout(id).groups[section.axis]?.collapsed.includes(field);
    return (!hiddenCameraColumns(id).has(field) || retained) && (ignoreGroup || !cameraLayout(id).hiddenGroups.includes(section?.id));
  }
  function cameraAxisGroup(id, axis) {
    const fields = cameraSheetSections().find(section => section.id === axis).fields.map(field => ({ ...field, group: axis }));
    const saved = cameraLayout(id).groups[axis];
    const order = [...new Set([...(saved?.order ?? []), ...fields.map(field => field.id)])];
    return {
      id: axis, label: axisName(axis), columns: order.flatMap(id => fields.filter(field => field.id === id)),
      expanded: axisGroups(id)[axis], collapsedColumnIds: (saved?.collapsed ?? []).filter(id => fields.some(column => column.id === id)),
    };
  }
  function cameraAxisColumns(id, axis) {
    if (cameraLayout(id).hiddenGroups.includes(axis)) return [];
    const group = cameraAxisGroup(id, axis);
    const columns = group.columns.filter(column => cameraFieldVisible(id, column.id) && (group.expanded || group.collapsedColumnIds.includes(column.id)));
    return columns.length ? columns : [{ id: axis + 'Placeholder', group: axis, placeholder: true, label: '', width: Math.max(130, axisName(axis).length * 12 + 50) }];
  }
  function cameraColumnWidth(id, column) { return cameraLayouts.get(id)?.columns[column.id] ?? column.width; }
  function saveCameraLayouts() {
    return Object.fromEntries([...cameraLayouts].filter(([id]) => device(id)).map(([id, layout]) => {
      const ids = new Set(cameras.filter(camera => camera.device === id).map(camera => camera.id));
      return [id, { ...layout, rows: Object.fromEntries(Object.entries(layout.rows).filter(([rowId]) => ids.has(rowId))) }];
    }));
  }
  function restoreCameraLayouts(data) {
    cameraLayouts.clear();
    for (const d of devices) {
      const id = d.id, saved = data.cameraLayouts?.[id] ?? {}, layout = cameraLayout(id);
      const columnIds = cameraSheetSections().flatMap(section => section.fields.map(field => field.id));
      for (const [column, size] of Object.entries(saved.columns ?? {})) if (columnIds.includes(column) && Number.isInteger(size) && size >= 36 && size <= 640) layout.columns[column] = size;
      const rowIds = new Set(cameras.filter(camera => camera.device === id).map(camera => camera.id));
      for (const [rowId, size] of Object.entries(saved.rows ?? {})) if (rowIds.has(rowId) && Number.isInteger(size) && size >= 30 && size <= 240) layout.rows[rowId] = size;
      for (const axis of cameraAxes) {
        const group = saved.groups?.[axis], ids = [axis + 'Summary', ...axisDefinitions[axis].map(field => field.id)];
        const valid = values => [...new Set(values.filter(value => ids.includes(value)))];
        if (Array.isArray(group?.order) && Array.isArray(group.collapsed)) layout.groups[axis] = { order: valid(group.order), collapsed: valid(group.collapsed) };
        else if (saved.version !== 2) layout.groups[axis] = { order: ids, collapsed: [axis + 'Summary'] };
      }
      if (Array.isArray(saved.hiddenGroups)) layout.hiddenGroups = [...new Set(saved.hiddenGroups.filter(group => cameraSheetSections().some(section => section.id === group)))];
      if (Number.isInteger(saved.textSize) && saved.textSize >= 9 && saved.textSize <= 24) layout.textSize = saved.textSize;
    }
  }
  function cameraGridHeader(columns, deviceId) {
    const hasGroups = columns.some(column => column.group), top = [], fields = [];
    for (const [index, column] of columns.entries()) {
      const id = column.id;
      const attributes = column.placeholder ? ' aria-hidden="true"' : ' data-field-header="' + id + '"' + cameraSortAria(column, deviceId);
      const heading = column.placeholder ? '' : cameraSortHeading(column, deviceId);
      if (column.group) {
        if (columns[index - 1]?.group !== column.group) top.push('<th class="hc-camera-group-header" scope="colgroup" colspan="' + columns.filter(field => field.group === column.group).length + '"><div data-axis-header="' + column.group + '"></div></th>');
        fields.push('<th scope="col"' + attributes + '>' + heading + '</th>');
      } else {
        const frozen = column.frozen === undefined ? '' : ' class="hc-camera-frozen" style="left:' + column.frozen + 'px"';
        top.push('<th scope="col" rowspan="' + (hasGroups ? 2 : 1) + '"' + frozen + attributes + '>' + heading + '</th>');
      }
    }
    return '<colgroup>' + columns.map(column => '<col' + (column.placeholder ? '' : ' data-hubble-column="' + column.id + '" data-label="' + esc(column.label) + '"') + ' style="width:' + column.width + 'px">').join('') + '</colgroup><thead>' + cameraColumnBands(columns) + '<tr>' + top.join('') + '</tr>' + (fields.length ? '<tr>' + fields.join('') + '</tr>' : '') + '</thead>';
  }
  function cameraColumnItems(id) {
    return cameraSheetSections().map(section => ({
      id: 'section:' + section.id, label: section.label, visible: !cameraLayout(id).hiddenGroups.includes(section.id),
      fields: section.fields.map(field => ({ id: field.id, label: field.id.endsWith('Summary') ? section.label + ' setup' : field.label, visible: cameraFieldVisible(id, field.id, true) && (!section.axis || axisGroups(id)[section.axis] || cameraAxisGroup(id, section.axis).collapsedColumnIds.includes(field.id)) })),
    }));
  }
  function changeCameraVisibility(id, changes) {
    changeCameraPresentation(id, () => {
      const layout = cameraLayout(id), hidden = hiddenCameraColumns(id);
      for (const { id: field, visible } of changes) {
        if (field.startsWith('section:')) {
          const group = field.slice(8);
          layout.hiddenGroups = layout.hiddenGroups.filter(id => id !== group);
          if (!visible) layout.hiddenGroups.push(group);
          continue;
        }
        const section = cameraSheetSections().find(section => section.fields.some(column => column.id === field));
        if (!section) continue;
        if (visible) hidden.delete(field); else hidden.add(field);
        if (section.axis) {
          const group = cameraAxisGroup(id, section.axis);
          layout.groups[section.axis] = { order: group.columns.map(column => column.id), collapsed: group.collapsedColumnIds.filter(id => id !== field) };
          if (visible && !group.expanded) layout.groups[section.axis].collapsed.push(field);
        }
      }
    });
  }
  function mountCameraLayoutControls(table, viewport, sheet) {
    const id = table.dataset.cameraDevice, groups = new Map();
    let resize, disposed = false;
    function refresh() {
      const slots = new Map([...table.querySelectorAll('[data-axis-header]')].map(slot => [slot.dataset.axisHeader, slot]));
      for (const [axis, group] of groups) {
        const slot = slots.get(axis);
        if (slot) { if (slot !== group.slot) slot.replaceWith(group.slot); group.controls?.refresh(); slots.delete(axis); }
        else { group.controls?.dispose(); groups.delete(axis); }
      }
      for (const [axis, slot] of slots) {
        const group = { slot }; groups.set(axis, group);
        void mountSpreadsheetColumnGroup({ root: slot, getGroup: () => cameraAxisGroup(id, axis),
          onChange(next) {
            const focused = slot.contains(document.activeElement) ? document.activeElement : null;
            changeCameraPresentation(id, () => {
              axisGroups(id)[axis] = next.expanded;
              cameraLayout(id).groups[axis] = { order: next.columns.map(column => column.id), collapsed: [...next.collapsedColumnIds] };
              for (const field of next.collapsedColumnIds) hiddenCameraColumns(id).delete(field);
            });
            focused?.focus({ preventScroll: true });
          }, onError: error => toast(error.message),
        }).then(controls => { if (disposed || groups.get(axis) !== group) controls.dispose(); else group.controls = controls; }).catch(error => { if (!disposed) toast(error.message); });
      }
      resize?.refresh();
    }
    void mountSpreadsheetResize({ root: table, viewport, getScale: () => sheet.scale ?? 1,
      getItems: () => [
        ...[...table.querySelectorAll('th[data-field-header]:not([data-field-header="row"])')].map(header => ({ id: header.dataset.fieldHeader, header, axis: 'column', label: cameraSortLabels[header.dataset.fieldHeader] ?? axisName(header.dataset.fieldHeader.replace(/Summary$/, '')) + ' setup', size: header.offsetWidth, min: header.dataset.fieldHeader.endsWith('Summary') ? 72 : 36, max: 640 })),
        ...[...table.tBodies[0].rows].map(row => ({ id: row.dataset.id, header: row.cells[0], axis: 'row', label: 'camera ' + (cameras.find(item => item.id === row.dataset.id)?.number ?? row.sectionRowIndex + 1) + ' row', size: row.offsetHeight, min: 30, max: 240 })),
      ], onResize({ id: item, axis }, size) { changeCameraPresentation(id, () => { cameraLayout(id)[axis === 'row' ? 'rows' : 'columns'][item] = size; }); },
    }).then(controls => { if (disposed) controls.dispose(); else { resize = controls; resize.refresh(); } }).catch(error => { if (!disposed) toast(error.message); });
    refresh();
    return { refresh, dispose() { disposed = true; for (const group of groups.values()) group.controls?.dispose(); resize?.dispose(); } };
  }
  function cameraColumnBands(columns){
    const cameraFields=new Set(['number','name','model','ip','port','login','password','controlEnabled','control','recording','cameraStatus']);
    const bands=[
      {label:'',kind:'gutter',count:columns.filter(column=>column.id==='row').length},
      {label:'Camera',kind:'camera',count:columns.filter(column=>cameraFields.has(column.id)).length},
      {label:'Lens',kind:'lens',count:columns.filter(column=>column.id==='lens'||column.id==='connection'||column.group).length},
      {label:'Sync',kind:'sync',count:columns.filter(column=>column.id==='sync').length},
    ];
    return '<tr class="hc-camera-bands">'+bands.filter(band=>band.count).map(band=>
      '<th colspan="'+band.count+'" scope="colgroup" class="hc-camera-band hc-camera-band-'+band.kind+'">'+band.label+'</th>'
    ).join('')+'</tr>';
  }

  function cameraSelectionStrip(deviceId){
    return '<div class="hc-camera-selection" data-camera-selection="'+esc(deviceId)+'">'+
      '<span class="hc-camera-location" data-camera-location>Select a cell</span>'+
      '<span class="hc-camera-value" data-camera-value></span>'+
      '<span class="hc-camera-grid-shortcuts"><span data-camera-search-hint hidden>Type to search <span aria-hidden="true">·</span> </span>'+cameraClipboardHint()+' <span aria-hidden="true">·</span> Drag to fill</span>'+
      '<span data-camera-zoom aria-label="Sheet zoom">100%</span>'+
      '<div data-camera-text-size></div><div data-camera-columns></div>'+
      '</div>';
  }

  function cameraClipboardHint(){
    const modifier=/Mac/.test(navigator.platform)?'⌘':'Ctrl+';
    return '<kbd>'+modifier+'C</kbd> Copy <kbd>'+modifier+'V</kbd> Paste';
  }

  function paintCameraSelectionSummary(strip,cell){
    const location=strip.querySelector('[data-camera-location]'),value=strip.querySelector('[data-camera-value]');
    const search=strip.querySelector('[data-camera-search-hint]');
    search.hidden=true;
    value.textContent='';
    value.removeAttribute('title');
    if(!cell){location.textContent='Select a cell';return;}
    const input=cell.querySelector('[data-field]'),column=cell.dataset.hubbleColumn;
    const row=cameras.find(camera=>camera.id===cell.dataset.hubbleRow);
    const choice=input?.hasAttribute('data-camera-choice');
    const axisSetup=column.endsWith('Summary');
    const label=choice?choiceLabel(input.dataset.field):axisSetup?axisName(column.replace(/Summary$/,''))+' setup':cameraSortLabels[column]||column;
    location.textContent='Camera '+(row?.number||'—')+' · '+label;
    if(column==='password')value.textContent=input?.value?'••••••••':'';
    else if(axisSetup&&cell.classList.contains('hc-axis-inactive'))value.textContent='Unavailable for this camera';
    else value.textContent=input?.disabled?'':choice?input.textContent:input?.value??cell.textContent.trim();
    if(value.textContent&&column!=='password')value.title=value.textContent;
    search.hidden=!choice||input.disabled;
  }
