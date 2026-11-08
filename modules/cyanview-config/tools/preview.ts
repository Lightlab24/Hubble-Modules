// Module-owned SDK fixture. Every device connection is redirected to a loopback simulator.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { FakeController, FakeRemiFleet, fixture } from '../test/helpers.js';
import { broker, closeBrokers } from '../test/control-broker.js';
import { CyanviewClient } from '../src/transport.js';
import { RcpSession } from '../src/control/rcp-session.js';

let controller: FakeController, session: ReturnType<typeof fixture>, pingDelayMs = 0;
let controllers: FakeController[] = [];
let mqtt: Awaited<ReturnType<typeof broker>>;
let releaseControlWrites: (() => void) | undefined;
let releasePlanWrites: (() => void) | undefined;
let planSaves = 0, planSavePending = 0;
let sampleSetting = true, sessionOptions: Parameters<typeof fixture>[1], statePaused = false;
const rendererState = () => session.states.at(-1) as Parameters<typeof session.context.publishState>[0];
async function reset(sample: boolean, remi = false, gateway = false) {
  statePaused = false;
  pingDelayMs = 0;
  releaseControlWrites?.(); releaseControlWrites = undefined;
  releasePlanWrites?.(); releasePlanWrites = undefined;
  planSaves = 0; planSavePending = 0;
  if (session) await session.instance.dispose();
  await Promise.all(controllers.map(device => device.close()));
  await closeBrokers();
  mqtt = await broker();
  controller = new FakeController();
  controllers = [controller];
  if (gateway) {
    controller.config.Product = { Serial:'CY-GWY-1-10',Name:'GATEWAY',MaxCam:'unlimited' };
    controller.config.Camera.wide = { Number:'1',Name:'Wide',Model:'Sony - Venice-IP',IP:'10.20.20.1',Port:'80' };
  }
  if (remi) {
    controller.config.Camera.wide = { Number:'1',Name:'Wide',Model:'Sony - Venice-IP',IP:'10.20.20.1',Port:'80' };
    for (const suffix of [20,30]) {
      const rcp = new FakeController();
      rcp.config.Product = { Serial:'CY-RCP-1-'+suffix,Name:'RCP',MaxCam:'unlimited' };
      rcp.config.IP.protected.IP = '10.192.1.'+suffix;
      rcp.config.IP.old.IP = '10.20.101.'+(199+suffix/10);
      controllers.push(rcp);
    }
  }
  const fleet = remi ? new FakeRemiFleet(controllers) : null;
  await Promise.all(controllers.map(device => device.start()));
  const socket = (url: string, options: Parameters<typeof controller.socket>[1]) => {
    const address = new URL(url).hostname;
    const target = fleet ? fleet.deviceAt(address) : controller;
    if (!target) throw new Error('Unknown simulated address');
    return target.socket(url,options);
  };
  sampleSetting = sample;
  sessionOptions = {
    client: address => new CyanviewClient(address, { socket, timeout: 2000 }),
    control: { session: (definition, changed) => new RcpSession(definition, changed, true, () => createConnection({ host: '127.0.0.1', port: mqtt.port })) },
    reachable: async address => ['10.192.1.10', '10.20.101.200'].includes(address),
    discovery: { durationMs: 100,
      ping: async (range, receive, progress, signal) => {
        receive(['10.192.1.10','10.20.101.200'].filter(range.contains));
        if(pingDelayMs)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,pingDelayMs);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
        signal.throwIfAborted();progress(range.count);
      },
      announcements: async (receive, signal) => { receive({role:'rio',serialHint:'CY-RIO-1-10',addresses:['10.192.1.10','10.20.101.200']});await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});}); } },
  };
  session = fixture({ sampleData: sample }, sessionOptions);
  await session.instance.start();
  if (remi) {
    const snapshots = controllers.map(device=>device.snapshot(device.config.IP.protected.IP));
    const names = ['Stage RIO','Master RCP','Downstream RCP'];
    await session.call('save-plan',{revision:null,plan:{
      formatVersion:1,devices:snapshots.map((snapshot,index)=>({...snapshot.device,name:names[index]})),
      cameras:snapshots.flatMap(snapshot=>snapshot.cameras),lans:[],uiState:null,
    }});
  }
}
await reset(true);
const manifest = JSON.parse(await readFile(path.resolve('dist/hubble-module.json'), 'utf8'));
const frameHeight = manifest.pages[0].layout === 'full-page' ? '100dvh' : (manifest.pages[0].sections[0].height || 560)+'px';
const pagePath = '/api/module-pages/' + 'a'.repeat(43);
const runtimePath = '/api/module-controls/spreadsheet-v1.js';
const runtimeOrigin = process.env.CYANVIEW_SPREADSHEET_HOST || 'http://127.0.0.1:42841';
const spreadsheetRuntime = await (async () => {
  if (process.env.CYANVIEW_RENDERER_ASSETS) return readFile(path.join(process.env.CYANVIEW_RENDERER_ASSETS, 'module-spreadsheet-v1.js'), 'utf8');
  const reply = await fetch(new URL(runtimePath, runtimeOrigin), { signal: AbortSignal.timeout(5000) });
  if (!reply.ok || !reply.headers.get('content-type')?.includes('javascript')) throw new Error('CYANVIEW_SPREADSHEET_HOST must serve the Hubble spreadsheet controls runtime');
  return reply.text();
})();
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cyanview module preview</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#141414}iframe{display:block;width:100%;height:${frameHeight};border:0}</style><iframe title="Cyanview module" sandbox="allow-scripts" src="${pagePath}/ui/index.html"></iframe><script>
let port; window.addEventListener('message', event => {
  const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow||event.data?.type!=='hubble.module.frontend.ready.v1')return;
  port?.close();const channel=new MessageChannel();port=channel.port1;
  port.onmessage=async event=>{const message=event.data;try{const response=await fetch('/__rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});const value=await response.json();port.postMessage(value.error?{type:'error',id:message.id,message:value.error}:{type:'result',id:message.id,value:value.result});}catch{port.postMessage({type:'error',id:message.id,message:'Preview bridge disconnected'});}};
  port.start();frame.contentWindow.postMessage({type:'hubble.module.frontend.connect.v1',id:event.data.id},'*',[channel.port2]);
});
setInterval(async()=>{if(!port)return;try{const response=await fetch('/__state');port.postMessage({type:'state',value:await response.json()});}catch{}},200);
</script></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://127.0.0.1');
  const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (url.pathname === '/__reset') { await reset(input.sample !== false, input.remi === true, input.gateway === true); send({ reset: true }); return; }
      if (url.pathname === '/__restart') {
        // The equipment and saved documents stay, as they do when Hubble restarts a module's worker.
        const { records } = session;
        await session.instance.dispose();
        session = fixture({ sampleData: sampleSetting }, sessionOptions, records);
        await session.instance.start();
        send({ restarted: true }); return;
      }
      if (url.pathname === '/__simulate') {
        controller.replyDelayProperty = input.delayProperty || ''; controller.replyDelayMs = Math.min(1000, Math.max(0, Number(input.delayMs) || 0));
        if (['new', 'update', 'delete', ''].includes(input.holdAction)) controller.holdAction = input.holdAction;
        if (input.releaseReplies) controller.releaseActionReplies();
        if (input.holdControlWrites) releaseControlWrites = session.holdWrites('camera-control');
        if (input.failControlWrite) session.failNextWrite('camera-control');
        if (input.releaseControlWrites) { releaseControlWrites?.(); releaseControlWrites = undefined; }
        if (input.holdPlanWrites) releasePlanWrites = session.holdWrites(session.repository.root);
        if (input.failPlanWrite) session.failNextWrite(session.repository.root);
        if (input.releasePlanWrites) { releasePlanWrites?.(); releasePlanWrites = undefined; }
        if (input.closeController) await controller.close();
        if (input.cameraName) controller.config.Camera.wide.Name = input.cameraName;
        if (input.mqtt) mqtt.send(input.mqtt.topic, input.mqtt.value);
        if (input.mqttControls) Object.assign(mqtt.controls, input.mqttControls);
        if (typeof input.pauseState === 'boolean') statePaused = input.pauseState;
        if (input.closeBroker) await closeBrokers();
        if (typeof input.pingDelayMs === 'number') pingDelayMs = Math.min(5000,Math.max(0,input.pingDelayMs));
        send({ updated: true }); return;
      }
      if (url.pathname !== '/__rpc') { send({ error: 'Unknown fixture route' }, 404); return; }
      const planSave = ['save-plan', 'save-commit'].includes(input.commandId);
      if (planSave) { planSaves++; planSavePending++; }
      try { send({ result: input.operation === 'state' ? rendererState() : await session.call(input.commandId, input.value) }); }
      catch (error) { send({ error: error instanceof Error ? error.message : 'Preview request failed' }); }
      finally { if (planSave) planSavePending--; }
      return;
    }
    if (url.pathname === '/__state') {
      // This page polls for state. A real host only sends it on a change, so a test can hold it back to see what stays on screen.
      if (statePaused) { response.writeHead(204); response.end(); return; }
      send(rendererState()); return;
    }
    if (url.pathname === '/__inspect') { send({ planSaves, planSavePending, opened: controllers.map(device => device.opened), openSockets: controllers.map(device => device.sockets.size), mqttConnections: mqtt.connections, actions: controller.actions, heldReplies: controller.heldActionReplies.length, config: controller.config, records: [...session.records], traces: session.traces, states: session.states.slice(-1), fleet:controllers.map(device=>({config:device.config,actions:device.actions})) }); return; }
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return; }
    if (url.pathname === runtimePath) {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
      response.end(spreadsheetRuntime);
      return;
    }
    const asset = url.pathname.slice(pagePath.length);
    if (!url.pathname.startsWith(pagePath) || !['/ui/index.html', '/ui/app.js', '/ui/app.css'].includes(asset)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    response.end(await readFile(path.resolve('dist', '.' + asset)));
  } catch { if (!response.headersSent) send({ error: 'Preview request failed' }, 500); else response.end(); }
});
const port = Number(process.env.CYANVIEW_PREVIEW_PORT || 43127);
server.listen(port, '127.0.0.1', () => console.log(`Cyanview module preview: http://127.0.0.1:${port} (simulated equipment only)`));
async function close() { releaseControlWrites?.(); releasePlanWrites?.(); await session.instance.dispose(); await Promise.all(controllers.map(device=>device.close())); server.close(); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
