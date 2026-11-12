  // Camera Enabled is Cyanview's own Enabled setting on each camera, not Hubble's Camera Control Enabled
  // checkmark. A REMI copy follows the camera it comes from, so its switch is locked. Refresh switches a
  // camera off and on again, then each copy made from it, which brings back a copy its RCP stopped selecting.
  let cameraEnabledJobs = [];
  const cameraEnabledSent = new Set();
  const cameraEnabledJob = camera => cameraEnabledJobs.find(job => job.device === camera.device && job.key === camera.elementKey);
  function cameraEnabledCell(camera) {
    if (!camera.elementKey || !camera.device) return '<span class="hc-caption">—</span>';
    const copy = importedCamera(camera), job = cameraEnabledJob(camera);
    const busy = !!job || cameraEnabledSent.has(camera.id) || !!camera.deleting || !!camera.jobs;
    const where = 'camera ' + camera.number + ' on ' + (device(camera.device)?.name || camera.device);
    const source = copy ? remiDeviceName(camera.remi?.peer || camera.remiPeer) : '';
    const choice = on => '<button type="button" data-action="camera-enabled" data-camera-enabled="' + (on ? 'on' : 'off') + '" data-enabled-row="' + esc(camera.id) +
      '" aria-pressed="' + String(camera.cameraEnabled === on) + '"' + (copy || busy ? ' disabled' : '') + '>' + (on ? 'On' : 'Off') + '</button>';
    const segment = '<span class="hc-segment hc-camera-enabled-switch' + (copy ? ' hc-locked' : '') + '" role="group" aria-label="Camera Enabled for ' + esc(where) + '"' +
      (copy ? ' title="Follows ' + esc(source) + '"' : '') + '>' + choice(true) + choice(false) + '</span>';
    const refresh = '<button type="button" class="hc-row-refresh-button' + (job ? ' hc-busy' : '') + '" data-action="refresh-camera" data-refresh-row="' + esc(camera.id) +
      '" aria-label="Refresh ' + esc(where) + '" title="' + esc(copy ? 'Off and on again on this RCP, then any copies made from it' : 'Off and on again, then its REMI copies') + '"' + (busy ? ' disabled' : '') + '>' + icon('refresh-cw') + '</button>';
    const note = job ? job.text : copy ? 'follows ' + source : '';
    return '<span class="hc-camera-enabled">' + segment + refresh + (note ? '<span class="hc-caption" data-camera-enabled-note>' + esc(note) + '</span>' : '') + '</span>';
  }
  function paintCameraEnabled(rows = cameras) {
    let painted = false;
    for (const camera of rows) for (const cell of root.querySelectorAll('td[data-column="cameraEnabled"][data-camera="' + CSS.escape(camera.id) + '"]')) {
      const markup = cameraEnabledCell(camera);
      if (cell.innerHTML !== markup) { cell.innerHTML = markup; painted = true; }
    }
    if (painted) icons();
  }
  function applyCameraEnabledJobs(jobs) {
    if (!Array.isArray(jobs)) return;
    const text = JSON.stringify(jobs);
    if (text === JSON.stringify(cameraEnabledJobs)) return;
    cameraEnabledJobs = jobs;
    paintCameraEnabled();
  }
  async function runCameraEnabled(camera, mode) {
    if (!moduleBridge || moduleBridge.preview) { toast('Sample data does not send commands to equipment'); return; }
    if (!camera?.elementKey || cameraEnabledSent.has(camera.id)) return;
    const before = camera.cameraEnabled, where = 'Camera ' + camera.number + ' on ' + (device(camera.device)?.name || camera.device);
    cameraEnabledSent.add(camera.id);
    // The switch moves at once. The controller's own report then confirms it, and a failure puts it back.
    if (mode !== 'refresh') camera.cameraEnabled = mode;
    paintCameraEnabled([camera]);
    try {
      const reply = mode === 'refresh' ? await moduleBridge.cameraRefresh(camera.device, camera.elementKey) : await moduleBridge.cameraEnabled(camera.device, camera.elementKey, mode);
      const copies = Number(reply?.copies) || 0, unread = (reply?.unread || []).map(id => device(id)?.name || id);
      const done = mode === 'refresh' ? where + ' refreshed' : where + ' switched ' + (mode ? 'on' : 'off');
      toast(done + (copies ? ' with ' + copies + (copies === 1 ? ' copy' : ' copies') : '') + (unread.length ? ' · could not reach ' + unread.join(', ') : ''));
    } catch (error) {
      if (mode !== 'refresh') camera.cameraEnabled = before;
      toast(error.message || 'Camera Enabled could not be changed');
    } finally {
      cameraEnabledSent.delete(camera.id);
      paintCameraEnabled([camera]);
    }
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-action="camera-enabled"],button[data-action="refresh-camera"]');
    if (!button || button.disabled) return;
    const camera = cameras.find(row => row.id === (button.dataset.enabledRow || button.dataset.refreshRow));
    if (!camera) return;
    if (button.dataset.action === 'refresh-camera') { void runCameraEnabled(camera, 'refresh'); return; }
    const on = button.dataset.cameraEnabled === 'on';
    if (camera.cameraEnabled !== on) void runCameraEnabled(camera, on);
  });
