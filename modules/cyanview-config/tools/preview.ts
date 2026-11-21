// Module-owned SDK fixture. Every device connection is redirected to a loopback simulator.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
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
// The addresses the page asked to open in a browser. The preview opens nothing.
let openedPages: string[] = [], openPageError = '';
// How long a live read's answer is held back after it is worked out, as when the page hears back late.
let liveReadDelayMs = 0;
// Controllers switched off: their settings sockets fail and their MQTT broker stops answering.
let fleet: FakeRemiFleet | null = null;
const switchedOff = new Set<string>(), mqttSockets = new Map<string, Set<Socket>>();
let sampleSetting = true, sessionOptions: Parameters<typeof fixture>[1], statePaused = false;
// The page's own made-up rows, which it shows and saves but never sends. The worker runs Simulated underneath, so these
// rows stay in the simulated plan, and the preview answers read-plan the way a worker once did for them.
let pageFixtures = true;
/** The page's made-up rows reach no controller, so what the worker says of them, all unreachable, is left out as a worker once left it. */
const fixtureControl = (value: any) => pageFixtures && value && typeof value === 'object' ? { ...value, controllers: {}, cameras: {} } : value;
const rendererState = () => {
  const state = session.states.at(-1) as Parameters<typeof session.context.publishState>[0];
  return pageFixtures && state?.values ? { ...state, values: { ...state.values, cameraControl: fixtureControl(state.values.cameraControl) } } : state;
};
async function reset(sample: boolean, remi = false, gateway = false, direct = false, extra = false, live = false, wan = false, reachAll = false, simulated = false, tour = false) {
  statePaused = false;
  pingDelayMs = 0;
  releaseControlWrites?.(); releaseControlWrites = undefined;
  releasePlanWrites?.(); releasePlanWrites = undefined;
  planSaves = 0; planSavePending = 0;
  switchedOff.clear(); mqttSockets.clear();
  openedPages = []; openPageError = ''; liveReadDelayMs = 0;
  if (session) await session.instance.dispose();
  await Promise.all(controllers.map(device => device.close()));
  await closeBrokers();
  mqtt = await broker();
  controller = new FakeController();
  controllers = [controller];
  // The first controller is a RIO WAN, on DHCP like the one captured on Nov 17, 2026.
  if (wan) controller.addWan();
  if (gateway) {
    controller.config.Product = { Serial:'CY-GWY-1-10',Name:'GATEWAY',MaxCam:'unlimited' };
    controller.config.Camera.wide = { Number:'1',Name:'Wide',Model:'Sony - Venice-IP',IP:'10.20.20.1',Port:'80',Enabled:'1' };
  }
  if (remi) {
    controller.config.Camera.wide = { Number:'1',Name:'Wide',Model:'Sony - Venice-IP',IP:'10.20.20.1',Port:'80',Enabled:'1' };
    for (const suffix of extra ? [20,30,40,50] : [20,30]) {
      const rcp = new FakeController();
      rcp.config.Product = { Serial:'CY-RCP-1-'+suffix,Name:'RCP',MaxCam:'unlimited' };
      rcp.config.IP.protected.IP = '10.192.1.'+suffix;
      rcp.config.IP.old.IP = '10.20.101.'+(199+suffix/10);
      controllers.push(rcp);
    }
    // A camera set up directly on an RCP, with no RIO in front of it.
    if (direct) controllers[1]!.config.Camera.direct = { Number:'7',Name:'Jib',Model:'Sony - Venice-IP',IP:'10.20.20.7',Port:'80',Enabled:'1' };
  }
  fleet = remi ? new FakeRemiFleet(controllers) : null;
  await Promise.all(controllers.map(device => device.start()));
  const socket = (url: string, options: Parameters<typeof controller.socket>[1]) => {
    const address = new URL(url).hostname;
    const target = fleet ? fleet.deviceAt(address) : controller;
    if (!target) throw new Error('Unknown simulated address');
    return target.socket(url,options);
  };
  // Simulated runs the worker against the controllers simulated inside it, and the page is live to it.
  sampleSetting = sample || simulated; pageFixtures = sample && !simulated;
  sessionOptions = {
    client: address => new CyanviewClient(address, { socket, timeout: 2000 }),
    // Held settings sockets, as in Hubble. Off unless a spec asks, since several count sockets.
    liveConfig: live ? { retryMs: [200, 1000], settleMs: 50 } : false,
    // Short enough for specs. Hubble itself holds a camera off for a second and waits up to six for it to come back online.
    cameraEnabled: { holdMs: 300, onlineWaitMs: 400 },
    openPage: async address => { if (openPageError) throw new Error(openPageError); openedPages.push(address); },
    control: { cameraSettleMs: 400, session: (definition, changed) => new RcpSession(definition, changed, true, () => {
      // Nothing listens on port 9, so a switched-off controller's broker refuses the connection.
      const socket = createConnection({ host: '127.0.0.1', port: switchedOff.has(definition.connectionId) ? 9 : mqtt.port }), open = mqttSockets.get(definition.connectionId) ?? new Set<Socket>();
      mqttSockets.set(definition.connectionId, open.add(socket));
      socket.once('close', () => open.delete(socket));
      return socket;
    }) },
    // Only the RIO answers a connection unless a spec asks for every simulated controller, as saved devices do.
    reachable: async address => ['10.192.1.10', '10.20.101.200'].includes(address) || reachAll && Boolean(fleet?.deviceAt(address)),
    discovery: { durationMs: 100,
      ping: async (range, receive, progress, signal) => {
        receive(['10.192.1.10','10.20.101.200'].filter(range.contains));
        if(pingDelayMs)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,pingDelayMs);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
        signal.throwIfAborted();progress(range.count);
      },
      announcements: async (receive, signal) => { receive({role:'rio',serialHint:'CY-RIO-1-10',addresses:['10.192.1.10','10.20.101.200']});await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});}); } },
  };
  session = fixture({ sampleData: sampleSetting }, sessionOptions);
  await session.instance.start();
  // The setup tour starts by itself on a page with no controllers. Only a spec about the tour asks
  // for that; for the rest it has already been seen, as it would be on any Mac after the first time.
  if (!tour) await session.call('setup-guide', { offered: true, confirmed: [] });
  if (remi) {
    const snapshots = controllers.map(device=>device.snapshot(device.config.IP.protected.IP));
    const names = ['Stage RIO','Master RCP','Downstream RCP','Truck RCP','Cart RCP'];
    await session.call('save-plan',{revision:null,plan:{
      formatVersion:1,devices:snapshots.map((snapshot,index)=>({...snapshot.device,name:names[index]})),
      cameras:snapshots.flatMap(snapshot=>snapshot.cameras),lans:[],uiState:null,
    }});
  }
}
await reset(true);
const manifest = JSON.parse(await readFile(path.resolve('dist/hubble-module.json'), 'utf8'));
const declaredCommands = new Set<string>(manifest.pages[0].sections[0].commands.map((command: { id: string }) => command.id));
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
/** The saved plan with the page told to show its own rows until it has saved some, and to send nothing. */
async function fixturePlan() {
  const saved = await session.repository.read(session.signal);
  return { revision: saved.revision, sample: true, plan: saved.fresh ? null : saved.plan };
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://127.0.0.1');
  const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (url.pathname === '/__reset') { await reset(input.sample !== false && input.simulated !== true, input.remi === true, input.gateway === true, input.direct === true, input.extra === true, input.live === true, input.wan === true, input.reachAll === true, input.simulated === true, input.tour === true); send({ reset: true }); return; }
      if (url.pathname === '/__load') {
        // A copy of a workspace's Cyanview documents, to see the page at a real setup's size and layout.
        // The worker restarts on them as a real one, not Simulated; every connection still reaches only
        // the loopback simulator above, so a copied address goes nowhere else.
        const documents = Array.isArray(input.documents) ? input.documents : [];
        const workspaceId = randomUUID(), records = new Map(documents.map((item: any) => [item.id, { workspaceId, owner: { kind: 'host' as const, capabilityId: 'lightlab-cyanview-config', moduleId: 'lightlab-cyanview-config' }, id: item.id, version: item.version ?? 1, revision: item.revision ?? null, value: item.value, canUndo: false, canRedo: false }]));
        await session.instance.dispose();
        sampleSetting = false; pageFixtures = false;
        session = fixture({ sampleData: false }, sessionOptions, records as any);
        await session.instance.start();
        await session.call('setup-guide', { offered: true, confirmed: [] });
        send({ loaded: records.size }); return;
      }
      if (url.pathname === '/__restart') {
        // The equipment and saved documents stay, as they do when Hubble restarts a module's worker.
        // The tour's progress lives in the worker's runtime folder, which the preview keeps in memory.
        const { records } = session, tour = await session.call('setup-guide', null);
        await session.instance.dispose();
        session = fixture({ sampleData: sampleSetting }, sessionOptions, records);
        await session.instance.start();
        await session.call('setup-guide', tour);
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
        // Switches one simulated controller off or back on, as when a RIO loses power.
        if (input.power && fleet) {
          const target = controllers[Number(input.power.device) || 0]!, id = String(target.config.Product.Serial);
          if (input.power.on) switchedOff.delete(id); else switchedOff.add(id);
          fleet.power(target, !!input.power.on);
          if (!input.power.on) for (const socket of mqttSockets.get(id) ?? []) socket.destroy();
        }
        if (input.cameraName) controller.config.Camera.wide.Name = input.cameraName;
        if (input.addCamera) { const target = controllers[Number(input.addCamera.device) || 0]!; target.config.Camera[String(input.addCamera.key)] = input.addCamera.row; target.broadcast(); }
        // A change made outside Hubble, such as in Cyanview's own page. The controller pushes it to every open socket.
        if (input.editCamera) { const target = controllers[Number(input.editCamera.device) || 0]!; Object.assign(target.config.Camera[String(input.editCamera.key)], input.editCamera.fields); target.broadcast(); }
        // Address rows set on one controller outside Hubble, as on its own page. They are listed first, since a controller
        // lists its rows in no fixed order, and a row given as null is deleted.
        if (input.editIp) {
          const target = controllers[Number(input.editIp.device) || 0]!, rows = Object.entries(input.editIp.rows ?? {}) as [string, any][];
          const kept = Object.entries(target.config.IP).filter(([key]) => !rows.some(([other]) => other === key));
          target.config.IP = Object.fromEntries([...rows.filter(([, row]) => row !== null), ...kept]);
          target.broadcast();
        }
        if (input.rekeyCamera) { const { wide, ...others } = controller.config.Camera; controller.config.Camera = { ...others, [input.rekeyCamera]: wide }; controller.broadcast(); }
        if (input.mqtt) mqtt.send(input.mqtt.topic, input.mqtt.value);
        if (input.mqttControls) Object.assign(mqtt.controls, input.mqttControls);
        if (typeof input.pauseState === 'boolean') statePaused = input.pauseState;
        if (input.closeBroker) await closeBrokers();
        if (typeof input.openPageError === 'string') openPageError = input.openPageError;
        if (typeof input.liveReadDelayMs === 'number') liveReadDelayMs = Math.min(3000, Math.max(0, input.liveReadDelayMs));
        if (typeof input.optionDelayMs === 'number') controller.optionDelayMs = Math.min(3000, Math.max(0, input.optionDelayMs));
        if (typeof input.pingDelayMs === 'number') pingDelayMs = Math.min(5000,Math.max(0,input.pingDelayMs));
        // Keys in the Button Matrix that use Cyanview, and a press of one, as Hubble passes them to the worker.
        if (Array.isArray(input.keys)) session.instance.subscribeFeedback!(input.keys, session.execution());
        if (input.press && typeof input.press === 'object') await session.instance.execute('camera-control', { values: { enabled: true, ...input.press } }, session.execution()).catch(() => undefined);
        send({ updated: true }); return;
      }
      if (url.pathname !== '/__rpc') { send({ error: 'Unknown fixture route' }, 404); return; }
      // Hubble passes a page only the commands its manifest declares, and so does the preview.
      if (input.operation !== 'state' && !declaredCommands.has(input.commandId)) { send({ error: 'Module page command is not declared: ' + input.commandId }); return; }
      const planSave = ['save-plan', 'save-commit'].includes(input.commandId);
      if (planSave) { planSaves++; planSavePending++; }
      try {
        const result = input.operation === 'state' ? rendererState() : pageFixtures && input.commandId === 'read-plan' ? await fixturePlan()
          : ['camera-control-state', 'camera-control-mutate'].includes(input.commandId) ? fixtureControl(await session.call(input.commandId, input.value)) : await session.call(input.commandId, input.value);
        if (liveReadDelayMs && input.commandId === 'refresh' && input.value?.live === true) await new Promise(resolve => setTimeout(resolve, liveReadDelayMs));
        send({ result });
      }
      catch (error) { send({ error: error instanceof Error ? error.message : 'Preview request failed' }); }
      finally { if (planSave) planSavePending--; }
      return;
    }
    if (url.pathname === '/__state') {
      // This page polls for state. A real host only sends it on a change, so a test can hold it back to see what stays on screen.
      if (statePaused) { response.writeHead(204); response.end(); return; }
      send(rendererState()); return;
    }
    if (url.pathname === '/__inspect') { send({ planSaves, planSavePending, openedPages, opened: controllers.map(device => device.opened), openSockets: controllers.map(device => device.sockets.size), mqttConnections: mqtt.connections, actions: controller.actions, heldReplies: controller.heldActionReplies.length, config: controller.config, records: [...session.records], traces: session.traces, states: session.states.slice(-1), fleet:controllers.map(device=>({config:device.config,actions:device.actions})) }); return; }
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
  } catch (error) { console.error('Preview request failed:', url.pathname, error); if (!response.headersSent) send({ error: 'Preview request failed' }, 500); else response.end(); }
});
const port = Number(process.env.CYANVIEW_PREVIEW_PORT || 43127);
server.listen(port, '127.0.0.1', () => console.log(`Cyanview module preview: http://127.0.0.1:${port} (simulated equipment only)`));
async function close() { releaseControlWrites?.(); releasePlanWrites?.(); await session.instance.dispose(); await Promise.all(controllers.map(device=>device.close())); server.close(); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
