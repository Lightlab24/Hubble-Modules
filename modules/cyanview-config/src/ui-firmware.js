  // Firmware: one SWU file goes to the RIOs chosen with it, and they all install at the same time.
  // A device that the file can't be for is never offered a checkbox; the backend refuses it again.
  const firmwareChunkBytes=45000;
  const firmware={file:null,pkg:null,targets:[],selected:new Set(),error:'',summary:'',sending:false,job:null,timer:null,confirming:false,confirmTimer:null};
  const firmwareApi={begin:()=>moduleBridge.firmwareBegin(),part:value=>moduleBridge.firmwarePart(value),commit:value=>moduleBridge.firmwareCommit(value),install:value=>moduleBridge.firmwareInstall(value),status:value=>moduleBridge.firmwareStatus(value)};
  const firmwareCount=n=>n+(n===1?' RIO':' RIOs');
  function firmwareBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(binary);}
  async function firmwareSend(file){
    const begun=await firmwareApi.begin();
    for(let offset=0,index=0;offset<file.size;offset+=firmwareChunkBytes,index++){
      const bytes=new Uint8Array(await file.slice(offset,offset+firmwareChunkBytes).arrayBuffer());
      await firmwareApi.part({id:begun.id,index,text:firmwareBase64(bytes)});
      firmware.summary='Sending file, '+Math.floor(offset/file.size*100)+'%';renderFirmware();
    }
    return begun.id;
  }
  async function firmwareChoose(file){
    if(!file)return;
    firmware.file=file;firmware.pkg=null;firmware.targets=[];firmware.selected=new Set();firmware.error='';firmware.confirming=false;firmware.sending=true;
    firmware.summary='Sending file, 0%';renderFirmware();
    try{
      const id=await firmwareSend(file);
      const result=await firmwareApi.commit({id,fileName:file.name});
      firmware.job=null;firmware.pkg=result.package;firmware.targets=result.targets;
      firmware.selected=new Set(result.targets.filter(target=>target.selectable&&target.checked).map(target=>target.deviceId));
      firmware.summary=result.package.problems.length?'This file can’t be sent':'Choose the RIOs to update';
    }catch(error){firmware.error=String(error&&error.message||error);firmware.summary='';}
    firmware.sending=false;renderFirmware();
  }
  function firmwareSelect(deviceId,checked){
    const target=firmware.targets.find(item=>item.deviceId===deviceId);
    if(!target||!target.selectable||firmware.job)return;
    if(checked)firmware.selected.add(deviceId);else firmware.selected.delete(deviceId);
    firmware.confirming=false;renderFirmware();
  }
  async function firmwarePoll(){
    if(!firmware.job)return;
    const status=await firmwareApi.status({jobId:firmware.job.id});
    if(!status)return;
    firmware.job=status;
    if(status.state==='done'){clearInterval(firmware.timer);firmware.timer=null;firmware.summary='Updates finished';}
    renderFirmware();
  }
  async function firmwareInstall(){
    const ids=[...firmware.selected];
    if(!ids.length||firmware.job||firmware.sending)return;
    if(!firmware.confirming){
      firmware.confirming=true;renderFirmware();
      clearTimeout(firmware.confirmTimer);firmware.confirmTimer=setTimeout(()=>{firmware.confirming=false;renderFirmware();},6000);
      return;
    }
    firmware.confirming=false;clearTimeout(firmware.confirmTimer);
    try{
      const started=await firmwareApi.install({packageId:firmware.pkg.id,deviceIds:ids});
      firmware.job={id:started.jobId,state:'running',targets:[]};
      firmware.summary='Installing on '+firmwareCount(ids.length);
      clearInterval(firmware.timer);firmware.timer=setInterval(firmwarePoll,1000);
      await firmwarePoll();
    }catch(error){firmware.error=String(error&&error.message||error);}
    renderFirmware();
  }
  // Installing or finished: the file was used, so nothing else can be chosen until a new file is sent.
  const firmwareLocked=()=>Boolean(firmware.job)||firmware.sending;
  function firmwareRow(target){
    const job=firmware.job, progress=job?job.targets.find(item=>item.deviceId===target.deviceId):null;
    const checked=firmware.selected.has(target.deviceId);
    const disabled=!target.selectable||firmwareLocked();
    const current=target.current?(esc(target.current.osVersion||'Unknown')+' · '+esc(target.current.rootfs||'')):'Not read';
    let status=target.selectable?(target.reason?'<span class="hc-pending-text">'+esc(target.reason)+'</span>':'Ready'):esc(target.reason||'Not available');
    let result='<span class="hc-muted">'+(target.selectable?'Not started':'Not sent')+'</span>';
    if(progress){
      status=esc(progress.step||'');
      const percent=progress.percent==null?0:Math.max(0,Math.min(100,progress.percent));
      result=progress.phase==='failed'?'<span class="hc-error-text">'+esc(progress.error||progress.result||'Failed')+'</span>'
        :progress.phase==='done'?'<span class="hc-status hc-online"><span class="hc-dot"></span>'+esc(progress.result||'Installed')+'</span>'
        :'<div class="hc-progress" role="progressbar" aria-label="Install progress for '+esc(target.name)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+percent+'"><span style="width:'+percent+'%"></span></div>';
    }
    return '<tr data-device="'+esc(target.deviceId)+'"><td><input type="checkbox" data-fw-select="'+esc(target.deviceId)+'" aria-label="Install on '+esc(target.name)+'"'+(checked?' checked':'')+(disabled?' disabled':'')+'></td>'
      +'<td>'+esc(target.name)+'</td><td>'+esc(target.kind)+'</td><td class="hc-mono">'+esc(target.address)+'</td><td>'+current+'</td><td>'+status+'</td><td>'+result+'</td></tr>';
  }
  function renderFirmware(){
    const panel=root.querySelector('#hc-firmware');
    if(!panel)return;
    const pkg=firmware.pkg, job=firmware.job, n=firmware.selected.size, running=Boolean(job&&job.state!=='done');
    const warnings=pkg?pkg.warnings.map(text=>'<div class="hc-pending-text">'+esc(text)+'</div>').join(''):'';
    const problems=pkg?pkg.problems.map(text=>'<div class="hc-error-text">'+esc(text)+'</div>').join(''):'';
    const error=firmware.error?'<div class="hc-error" role="alert">'+esc(firmware.error)+'</div>':'';
    const label=firmware.confirming?'Confirm install on '+firmwareCount(n):'Install on '+firmwareCount(n);
    panel.querySelector('[data-role="fw-summary"]').textContent=firmware.summary||(pkg?'':'Choose a file to start');
    panel.querySelector('[data-role="fw-file-name"]').textContent=pkg?pkg.fileName+' · '+(pkg.version||'version unknown')+(pkg.family?' · '+pkg.family:''):(firmware.file?firmware.file.name:'No file chosen');
    panel.querySelector('[data-role="fw-messages"]').innerHTML=error+problems+warnings;
    const install=panel.querySelector('[data-action="fw-install"]');
    install.textContent=running?'Installing':label;
    install.disabled=!n||firmwareLocked()||!pkg||pkg.problems.length>0;
    panel.querySelector('[data-action="fw-choose"]').disabled=running||firmware.sending;
    const body=panel.querySelector('[data-role="fw-rows"]');
    body.innerHTML=firmware.targets.length?firmware.targets.map(firmwareRow).join(''):'<tr><td colspan="7" class="hc-muted">Choose a file to see which devices it can be sent to.</td></tr>';
    const foot=panel.querySelector('[data-role="fw-foot"]');
    const selectable=firmware.targets.filter(target=>target.selectable).length;
    foot.textContent=pkg?(n+' selected · '+selectable+' can take this file · '+firmware.targets.length+' managed devices'):'Files are checked against each device before anything is sent';
  }
  function initializeFirmwareTab(){
    const nav=root.querySelector('.hc-tabs'), main=root.querySelector('.hc-main');
    if(!nav||!main||!moduleBridge||typeof moduleBridge.firmwareBegin!=='function')return;
    const tab=document.createElement('button');
    tab.className='hc-tab';tab.setAttribute('role','tab');tab.id='hc-tab-firmware';tab.setAttribute('aria-controls','hc-firmware');tab.setAttribute('aria-selected','false');tab.dataset.tab='firmware';tab.textContent='Firmware';
    nav.appendChild(tab);
    const panel=document.createElement('section');
    panel.id='hc-firmware';panel.className='hc-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','hc-tab-firmware');panel.hidden=true;
    panel.innerHTML='<div class="hc-toolbar"><div class="hc-toolbar-title"><h3>Firmware update</h3><span data-role="fw-summary">Choose a file to start</span></div>'
      +'<button class="hc-button" data-action="fw-choose">Choose file</button><input type="file" accept=".swu" hidden data-role="fw-input" aria-label="Firmware file">'
      +'<button class="hc-primary" data-action="fw-install" disabled>Install on 0 RIOs</button></div>'
      +'<div class="hc-scan-status"><div><span data-role="fw-file-name">No file chosen</span></div></div>'
      +'<div data-role="fw-messages"></div>'
      +'<div class="hc-scroll"><table class="hc-results-table" aria-label="Devices for firmware update"><thead><tr><th></th><th>Device</th><th>Type</th><th>Address</th><th>Running now</th><th>Status</th><th>Result</th></tr></thead><tbody data-role="fw-rows"></tbody></table></div>'
      +'<div class="hc-panel-foot"><span data-role="fw-foot">Files are checked against each device before anything is sent</span><span class="hc-caption">Devices that can’t take this file are greyed out</span></div>';
    main.insertBefore(panel,main.querySelector('.hc-global-foot'));
    const input=panel.querySelector('[data-role="fw-input"]');
    // Only real changes are written: a write that repeats a value would send this observer round again forever.
    const setSelected=(el,value)=>{if(el.getAttribute('aria-selected')!==value)el.setAttribute('aria-selected',value);};
    const show=on=>{
      if(!on&&panel.hidden)return;
      panel.hidden=!on;setSelected(tab,String(on));
      if(on){
        nav.querySelectorAll('[data-tab]').forEach(el=>{if(el!==tab)setSelected(el,'false');});
        root.querySelectorAll('.hc-panel').forEach(el=>{if(el!==panel&&!el.hidden)el.hidden=true;});
      }
    };
    tab.addEventListener('click',()=>show(true));
    nav.addEventListener('click',event=>{const other=event.target.closest('[data-tab]');if(other&&other!==tab)show(false);});
    new MutationObserver(()=>{if(!panel.hidden&&nav.querySelector('[data-tab]:not([data-tab="firmware"])[aria-selected="true"]'))show(false);}).observe(nav,{attributes:true,subtree:true,attributeFilter:['aria-selected']});
    panel.addEventListener('click',event=>{
      if(event.target.closest('[data-action="fw-choose"]'))input.click();
      if(event.target.closest('[data-action="fw-install"]'))void firmwareInstall();
    });
    input.addEventListener('change',()=>{const file=input.files&&input.files[0];input.value='';void firmwareChoose(file);});
    panel.addEventListener('change',event=>{const box=event.target.closest('[data-fw-select]');if(box)firmwareSelect(box.dataset.fwSelect,box.checked);});
    renderFirmware();
  }
