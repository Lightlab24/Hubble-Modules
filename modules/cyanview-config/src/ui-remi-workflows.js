  const remiPanels = new Map();
  let remiReview = '';
  const remiGroup = id => root.querySelector('[data-controller="'+id+'"]');
  const importedCamera = row => !!row.remi || [row.modelLabel,row.model].some(label => /^cyan\s*-\s*imported$/i.test(String(label||'').trim()));
  const remiModelName = row => row.remi?.origin?.model || row.name || 'Remote camera';
  const remiPeers = id => orderedDevices().filter(item => item.id !== id);
  const remiDeviceName = peer => devices.find(item => item.serial.toLowerCase() === String(peer || '').toLowerCase())?.name || peer || 'Remote source';
  function remiPanelState(id) {
    if (!remiPanels.has(id)) remiPanels.set(id, {
      source: remiPeers(id)[0]?.id || '', drafts: new Map(), overrides: {}, picks: new Set(),
      data: null, open: false, settings: false, busy: false, loading: false, error: '', retry: false,
    });
    return remiPanels.get(id);
  }
  function saveRemiDrafts() {
    return Object.fromEntries([...remiPanels].filter(([id,state]) => device(id) &&
      (state.drafts.size || Object.keys(state.overrides).length)).map(([id,state]) =>
      [id,{ drafts:[...state.drafts.values()], overrides:state.overrides }]));
  }
  function restoreRemiDrafts(data) {
    for (const [id,value] of Object.entries(data.remiDrafts || {})) {
      if (!device(id) || !value || !Array.isArray(value.drafts)) continue;
      const state = remiPanelState(id);
      state.drafts = new Map(value.drafts.filter(item => item?.id && ['camera','remove','tag'].includes(item.kind)).map(item => [item.id,item]));
      state.overrides = Object.fromEntries(Object.entries(value.overrides || {}).filter(([source,address]) => device(source) && typeof address === 'string' && ipv4(address)));
    }
  }
  function remiButton(name,label,disabled=false,extra='') {
    return '<button type="button" class="hc-button" data-remi-action="'+name+'"'+(disabled?' disabled':'')+extra+'>'+label+'</button>';
  }
  function remiDraw(id, panel) {
    if (!panel) return;
    const state = remiPanelState(id), source = device(state.source), data = state.data;
    state.settings = panel.querySelector('details')?.open ?? state.settings;
    const unavailable = state.busy || state.loading || !data || !!data.refreshes.length || state.retry;
    const rows = data?.cameras || [], tags = data?.tags;
    const peers = remiPeers(id).map(item => {
      const duplicate = devices.some(other => other.id !== item.id && other.id !== id && other.kind === item.kind && other.name === item.name);
      return {id:item.id,label:item.name+' · '+item.kind+(duplicate?' · '+item.serial:'')};
    });
    const cameraChange = row => state.drafts.get('camera:'+state.source+':'+row.key) ||
      (row.localKey && state.drafts.get('remove:'+row.localKey));
    const wanted = row => cameraChange(row)?.enable ?? row.assigned;
    const can = (enable, selected) => rows.some(row => !row.ambiguous && (!selected || state.picks.has(row.key)) && wanted(row) !== enable);
    const tagNames = new Set([...(tags || []), ...[...state.drafts.values()].filter(item => item.kind === 'tag').map(item => item.tag)]);
    panel.innerHTML =
      '<div class="hc-remi-row"><strong>REMI cameras</strong><span class="hc-caption">Receiving on '+esc(device(id).name)+'</span><span class="hc-right"></span>'+
        remiButton('refresh','Refresh source',state.loading||state.busy)+remiButton('close','Close',state.busy)+'</div>'+
      '<div class="hc-remi-row"><label>Source <select data-remi-source aria-label="REMI source"'+(state.busy?' disabled':'')+'>'+
        (peers.length?options(peers,state.source):'<option>Add a source in Devices</option>')+'</select></label>'+
        '<span class="hc-caption">'+esc(state.loading?'Loading cameras…':data?rows.length+' cameras on source':'')+'</span></div>'+
      (state.error?'<div class="hc-remi-row"><span class="hc-error" role="alert">'+esc(state.error)+'</span>'+
        (data?.addresses.length?remiButton('source-ip','Change source IP',state.busy):'')+'</div>':'')+
      (data?.refreshes.length||state.retry?'<div class="hc-remi-row"><span class="hc-pending-text">REMI refresh pending</span>'+
        remiButton('retry','Retry REMI refresh',state.busy)+'</div>':'')+
      (rows.length?'<div class="hc-remi-catalog"><table class="hc-grid" aria-label="Remote cameras">'+
        '<colgroup><col style="width:28px"><col style="width:38px"><col><col style="width:112px"><col style="width:72px"></colgroup>'+
        '<thead><tr><th></th><th>#</th><th>Camera name</th><th>On receiver</th><th></th></tr></thead><tbody>'+
        rows.map(row => {
          const draft = cameraChange(row), label = row.ambiguous?'Ambiguous':draft?(draft.enable?'Pending add':'Pending removal'):row.assigned?'Added':'Available';
          return '<tr><td class="hc-check"><input type="checkbox" data-remi-pick="'+esc(row.key)+'" aria-label="Select camera '+esc(row.number+' '+row.name)+'"'+
            (state.picks.has(row.key)?' checked':'')+(unavailable||row.ambiguous?' disabled':'')+'></td><td>'+esc(row.number)+'</td><td>'+esc(row.name)+
            '</td><td class="'+(draft?'hc-pending-text':row.assigned?'hc-online':'hc-muted')+'">'+label+'</td><td>'+
            remiButton('camera',draft?'Undo':row.assigned?'Remove':'Add',unavailable||row.ambiguous,' data-key="'+esc(row.key)+'"')+'</td></tr>';
        }).join('')+'</tbody></table></div><div class="hc-remi-row">'+remiButton('add-selected','Add selected',unavailable||!can(true,true))+
        remiButton('add-all','Add all',unavailable||!can(true,false))+remiButton('remove-selected','Remove selected',unavailable||!can(false,true))+
        remiButton('remove-all','Remove all',unavailable||!can(false,false))+'</div>':'')+
      '<details class="hc-remi-settings"'+(state.settings?' open':'')+'><summary>REMI settings</summary>'+
        (source?'<div class="hc-remi-row"><label>Source IP <select data-remi-address aria-label="Source IP"'+(state.busy?' disabled':'')+'><option value="">Automatic</option>'+
          options((data?.addresses||[]).map(address => ({id:address,label:address+(address===source.base?' · Factory':'')})),state.overrides[source.id])+'</select></label></div>':'')+
        '<div class="hc-remi-row"><span class="hc-caption">REMI tags</span>'+
        [...tagNames].map(tag => '<span class="hc-remi-chip">'+esc(tag)+
          remiButton('tag-remove','×',state.busy,' data-tag="'+esc(tag)+'" aria-label="Remove or undo tag '+esc(tag)+'"')+'</span>').join('')+
        (Array.isArray(tags)?'<input class="hc-input" data-remi-tag aria-label="New REMI tag" placeholder="New tag" maxlength="160">'+
          remiButton('tag-add','Add tag',state.busy):'<span class="hc-caption">Tags unavailable</span>')+'</div></details>';
    icons();
  }
  async function remiLoad(id) {
    const state = remiPanelState(id);
    if (!moduleBridge || moduleBridge.preview) {
      state.error = 'REMI is available for managed devices.';
      remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
      return;
    }
    if (!device(state.source)) state.source = remiPeers(id)[0]?.id || '';
    const source = state.source, request = Symbol();
    state.request = request;
    state.loading = true;
    state.error = '';
    state.data = null;
    remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
    try {
      const data = await moduleBridge.remiState({receiver:id,source});
      if (state.request !== request) return;
      state.data = data;
      state.retry = !!data.refreshes.length;
    } catch (error) {
      if (state.request === request) state.error = error.message || 'REMI cameras could not be read';
    } finally {
      if (state.request === request) {
        state.loading = false;
        remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
      }
    }
  }
  function remiOpen(id) {
    const state = remiPanelState(id);
    state.open = true;
    renderCameras();
    void remiLoad(id);
  }
  async function remiRefreshSheets() {
    const result = await moduleBridge.refresh();
    for (const snapshot of result.snapshots || []) mergeOwn(snapshot);
    applyLiveState({observations:result.observations});
    renderLans();
    renderCameras();
    remember();
    await Promise.all([...remiPanels].filter(([id,state]) => state.open && device(id)).map(([id]) => remiLoad(id)));
  }
  async function remiSend(id, items, retry = false) {
    const state = remiPanelState(id);
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    syncSummary();
    remiDraw(id,remiGroup(id)?.querySelector('[data-remi-panel]'));
    try {
      const report = await moduleBridge.remiSend({receiver:id,items,...(retry?{operation:'retry'}:{})});
      for (const result of report.results || []) {
        const sent = items.find(item => item.id === result.id);
        if (sent && result.verified && state.drafts.get(sent.id) === sent) state.drafts.delete(sent.id);
      }
      if (report.snapshot) mergeOwn(report.snapshot);
      if (report.refresh) await remiRefreshSheets();
      if (state.open) await remiLoad(id);
      const failed = report.results?.filter(item => item.error) || [];
      state.error = failed.length ? failed[0].error : '';
      toast(failed.length ? state.error : retry ? 'REMI refresh complete' : 'REMI changes verified');
    } catch (error) {
      state.error = error.message || 'REMI changes could not be confirmed';
      toast(state.error);
    } finally {
      state.busy = false;
      renderCameras();
      remember();
    }
  }
  function remiStage(id, items) {
    const state = remiPanelState(id);
    for (const item of items) {
      if (item.kind === 'camera' && item.enable === item.assigned) state.drafts.delete(item.id);
      else state.drafts.set(item.id,item);
    }
    renderCameras();
    remember();
    if (ui.sendMode === 'Auto send') {
      const pending = items.filter(item => state.drafts.get(item.id) === item);
      if (pending.length) void remiSend(id,pending);
    }
  }
  function remiShowReview(id) {
    remiReview = id;
    const drafts = [...remiPanelState(id).drafts.values()];
    const local = pendingCameras(id);
    const changes = [...drafts.map(item => {
      if (item.kind === 'tag') return item.enable?'Add REMI tag':'Remove REMI tag';
      return (item.enable?'Import ':'Remove ')+item.label+(item.source&&device(item.source)?' · '+device(item.source).name:'');
    }), ...local.map(row => 'Update camera '+row.number+' · '+row.name)];
    $('modal-layer').innerHTML = '<section class="hc-modal" role="dialog" aria-modal="true" aria-label="Send camera changes">'+
      '<div class="hc-modal-head"><div><h3>Send camera changes</h3><p>'+esc(device(id).name)+'</p></div>'+
      '<button data-action="close-modal" aria-label="Close">'+icon('x')+'</button></div>'+
      '<div class="hc-modal-body">'+changes.map(label => '<div class="hc-change-item">'+esc(label)+'</div>').join('')+'</div>'+
      '<div class="hc-modal-foot"><button class="hc-button" data-action="close-modal">Cancel</button>'+
      '<button class="hc-primary" data-remi-apply>Send '+changes.length+(changes.length===1?' change':' changes')+'</button></div></section>';
    $('modal-layer').hidden = false;
    icons();
    $('modal-layer').querySelector('[data-remi-apply]').focus();
  }
  const syncCameraSummary = syncSummary;
  syncSummary = function() {
    syncCameraSummary();
    let total = 0;
    for (const [id,state] of remiPanels) {
      const group = remiGroup(id);
      if (!group) continue;
      const pending = state.drafts.size+pendingCameras(id).length;
      total += state.drafts.size;
      if (state.drafts.size || state.busy || state.retry) {
        group.querySelector('[data-controller-pending]').textContent = state.retry?'REMI refresh pending':state.busy?'Sending REMI changes':pending+' pending';
        const send = group.querySelector('[data-action="send-controller"]');
        send.disabled = !pending || state.busy || cameras.some(row => row.device===id&&row.jobs);
        send.querySelector('span').textContent = pending;
      }
    }
    if (total) {
      $('pending-summary').textContent = (total+pendingCameras().length+pendingLans().length)+' changes pending';
      $('pending-summary').classList.add('hc-changes-label');
    }
  };
  const renderCameraSheets = renderCameras;
  renderCameras = function() {
    const focus = cameraSheetFocus();
    for (const panel of root.querySelectorAll('[data-remi-panel]')) {
      const state = remiPanelState(panel.dataset.remiPanel);
      state.settings = panel.querySelector('details')?.open ?? state.settings;
    }
    renderCameraSheets();
    for (const item of devices) {
      const group = remiGroup(item.id);
      if (!group) continue;
      group.querySelector('[data-camera-count]')?.insertAdjacentHTML('afterend', '<button type="button" class="hc-button" data-action="open-remi-panel" data-id="' + esc(item.id) + '" aria-expanded="' + !!remiPanels.get(item.id)?.open + '">REMI cameras</button>');
      const state = remiPanels.get(item.id);
      if (state?.open) {
        const panel = document.createElement('section');
        panel.className = 'hc-remi-panel';
        panel.dataset.remiPanel = item.id;
        panel.setAttribute('aria-label','REMI on '+item.name);
        group.querySelector('.hc-controller-tools').after(panel);
        remiDraw(item.id,panel);
      }
      for (const row of cameras.filter(row => row.device===item.id&&importedCamera(row))) {
        const selector = 'td[data-camera="'+CSS.escape(row.id)+'"]';
        for (const field of group.querySelectorAll(selector+' [data-field]:not([data-field="controlEnabled"])')) field.disabled = true;
        const model = group.querySelector(selector+'[data-column="model"]');
        if (model) {
          const origin = row.remi?.origin, camera = remiModelName(row);
          const source = remiDeviceName(origin?.serial || row.remi?.peer || row.remiPeer);
          model.innerHTML = '<span class="hc-remi-model" title="'+esc(camera+' · '+source)+'">'+
            '<span data-remi-model>'+esc(camera)+'</span><span class="hc-caption" data-remi-model-source>'+esc(source)+'</span></span>';
        }
      }
    }
    icons();
    refreshCameraSheets(focus);
  };
  root.addEventListener('change',event => {
    const input = event.target;
    const panel = input.closest('[data-remi-panel]');
    if (!panel) return;
    const id = panel.dataset.remiPanel, state = remiPanelState(id);
    if (input.hasAttribute('data-remi-source')) {
      state.source = input.value;
      state.picks.clear();
      void remiLoad(id);
    } else if (input.hasAttribute('data-remi-address')) {
      if (input.value) state.overrides[state.source] = input.value;
      else delete state.overrides[state.source];
      for (const item of state.drafts.values()) if (item.kind==='camera' && item.source===state.source && item.enable) {
        item.address = input.value || '';
      }
      remember();
    } else if (input.dataset.remiPick) {
      const key = input.dataset.remiPick;
      if (input.checked) state.picks.add(key); else state.picks.delete(key);
      remiDraw(id,panel);
      [...panel.querySelectorAll('[data-remi-pick]')].find(input=>input.dataset.remiPick===key)?.focus();
    }
  },true);
  root.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'open-remi-panel' && device(button.dataset.id)) {
      const id = button.dataset.id;
      if (remiPanelState(id).open) { remiPanelState(id).open = false; renderCameras(); return; }
      remiOpen(id);
      remiGroup(id)?.querySelector('[data-remi-source]')?.focus();
      return;
    }
    if (button.hasAttribute('data-remi-apply')) {
      const id = remiReview;
      $('modal-layer').hidden = true;
      const local = pendingCameras(id);
      void remiSend(id,[...remiPanelState(id).drafts.values()]).then(() => {
        if (local.length) void sendItems(local,'camera');
      });
      return;
    }
    const id = button.dataset.id;
    if (button.dataset.action==='send-controller' && remiPanels.get(id)?.drafts.size) {
      event.stopImmediatePropagation();
      remiShowReview(id);
      return;
    }
    const panel = button.closest('[data-remi-panel]'), command = button.dataset.remiAction;
    if (!panel || !command) return;
    const receiver = panel.dataset.remiPanel, state = remiPanelState(receiver);
    if (command==='close') {
      state.open = false;
      renderCameras();
      remiGroup(receiver)?.querySelector('[data-action="open-remi-panel"]')?.focus();
    } else if (command==='refresh') void remiLoad(receiver);
    else if (command==='retry') void remiSend(receiver,[],true);
    else if (command==='source-ip') {
      panel.querySelector('details').open=true;
      panel.querySelector('[data-remi-address]')?.focus();
    }
    else if (command==='tag-add'||command==='tag-remove') {
      const enable = command==='tag-add', tag = enable?panel.querySelector('[data-remi-tag]').value.trim():button.dataset.tag;
      if (!tag || tag.includes(',')) { toast('Enter a tag without commas'); return; }
      const key = 'tag:'+tag;
      if (!enable && state.drafts.delete(key)) { renderCameras(); remember(); }
      else remiStage(receiver,[{id:key,kind:'tag',tag,enable}]);
    } else {
      const rows = state.data?.cameras || [];
      const make = (row,enable) => ({id:'camera:'+state.source+':'+row.key,kind:'camera',source:state.source,key:row.key,
        enable,assigned:row.assigned,address:state.overrides[state.source]||'',label:row.number+' · '+row.name});
      if (command==='camera') {
        const row = rows.find(row=>row.key===button.dataset.key);
        if (!row) return;
        const key = 'camera:'+state.source+':'+row.key;
        if (state.drafts.delete(key) || (row.localKey && state.drafts.delete('remove:'+row.localKey))) { renderCameras(); remember(); }
        else remiStage(receiver,[make(row,!row.assigned)]);
      } else {
        const enable = command.startsWith('add');
        const items = rows.filter(row => !row.ambiguous && (command.endsWith('all')||state.picks.has(row.key)) &&
          (state.drafts.get('camera:'+state.source+':'+row.key)?.enable??row.assigned)!==enable).map(row=>make(row,enable));
        remiStage(receiver,items);
      }
    }
  },true);
