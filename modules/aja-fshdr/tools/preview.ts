// Runs the real page and the real worker code in a browser, against FS-HDR simulators on this computer.
//   node --import tsx tools/preview.ts
// FSHDR_SIMULATOR_DIR=<folder holding server.mjs> starts simulators too, one per entry in FSHDR_SIMULATORS (default "four,four,single").
// Nothing here reaches a real unit unless you type its address into Setup.
import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBackend } from '../src/backend.js';
import { defaultDocument, newUnit } from '../src/model.js';

const root = path.resolve(import.meta.dirname, '..');
const assets = process.env.HUBBLE_RENDERER_ASSETS ?? '/Applications/Hubble.app/Contents/Library/HubbleAgent/renderer/main_window/assets';
const port = Number(process.env.PORT ?? 43971), simulatorBase = Number(process.env.FSHDR_SIMULATOR_PORT ?? 43981);
const token = 'v'.repeat(43), prefix = '/api/module-pages/' + token + '/ui/';
const simulators: ChildProcess[] = [], simulatorHosts: string[] = [];
if (process.env.FSHDR_SIMULATOR_DIR) for (const [index, mode] of (process.env.FSHDR_SIMULATORS ?? 'four,four,single').split(',').entries()) {
  const child = spawn(process.execPath, [path.join(process.env.FSHDR_SIMULATOR_DIR, 'server.mjs'), '--port', String(simulatorBase + index), '--name', 'FS-HDR ' + (index + 1), '--mode', mode], { stdio: 'ignore' });
  simulators.push(child); simulatorHosts.push('127.0.0.1:' + (simulatorBase + index));
}
// Stands in for Hubble's document store: each document has a revision, and a write against an old one is refused.
const stored = new Map<string, { revision: number; value: unknown }>();
const seeded = defaultDocument();
if (process.env.PREVIEW_EMPTY !== '1') seeded.units = simulatorHosts.map((host, index) => newUnit('unit-' + (index + 1), 'FS-HDR ' + (index + 1), host));
stored.set('fshdr-plan', { revision: 1, value: seeded }); stored.set('setup', { revision: 1, value: {} });
let hold = false, held: { resolve(rejected: boolean): void } | undefined, published: unknown, feedback: unknown[] = [];
const record = (id: string) => ({ id, version: 1, revision: String(stored.get(id)!.revision), value: stored.get(id)!.value });
const services = { async request(_service: string, _version: number, input: any, signal?: AbortSignal) {
  if (!stored.has(input.id)) throw Error('Unknown document ' + input.id);
  if (input.method === 'watch') return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  if (input.method === 'write') {
    if (input.expectedRevision !== String(stored.get(input.id)!.revision)) return { status: 'conflict', document: record(input.id) };
    stored.set(input.id, { revision: stored.get(input.id)!.revision + 1, value: input.value });
  }
  return { status: 'document', document: record(input.id) };
} };
const logs: unknown[] = [];
const backend = createBackend({ services, connectionEnabled: process.env.PREVIEW_DISABLED !== '1', settings: {}, log(entry: unknown) { logs.push(entry); if (logs.length > 500) logs.shift(); }, publishState(value: unknown) { published = value; }, publishFeedback(value: unknown) { feedback.push(value); if (feedback.length > 200) feedback.shift(); } } as any);
await backend.start?.();
const lifetime = new AbortController();
const wrapper = '<!doctype html><html><head><title>FS-HDR preview</title><style>html,body{margin:0;height:100%;background:#111;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts" title="FS-HDR" src="' + prefix + 'index.html"></iframe><script>const frame=document.querySelector("iframe");addEventListener("message",event=>{if(event.source!==frame.contentWindow||event.data?.type!=="hubble.module.frontend.ready.v1")return;const channel=new MessageChannel();channel.port1.onmessage=async(event)=>{const r=event.data;try{const response=await fetch("/fixture/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(r)});const value=await response.json();channel.port1.postMessage(value.error?{type:"error",id:r.id,message:value.error}:{type:"result",id:r.id,value:value.result});}catch(error){channel.port1.postMessage({type:"error",id:r.id,message:String(error)});}};channel.port1.start();' +
  // Hubble hands a module page its state on a slow cycle. PREVIEW_STATE_MS sets how slow; the page's own waiting call is what makes changes prompt.
  'setInterval(async()=>{const r=await fetch("/fixture/live");channel.port1.postMessage({type:"state",value:await r.json()});},' + Number(process.env.PREVIEW_STATE_MS ?? 3000) + ');frame.contentWindow.postMessage({type:"hubble.module.frontend.connect.v1",id:event.data.id},"*",[channel.port2]);});</script></body></html>';
async function body(request: http.IncomingMessage) { let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 1048576) throw Error('Payload too large'); } return text ? JSON.parse(text) : {}; }
function json(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (url.pathname === '/fixture/live') { json(response, 200, published ?? {}); return; }
    if (url.pathname === '/fixture/state') { json(response, 200, { document: stored.get('fshdr-plan')!.value, revision: String(stored.get('fshdr-plan')!.revision), published, held: !!held, simulatorHosts, logs, feedback }); return; }
    // The next save waits here until it is released, so a check can see what the page does before the workspace answers.
    if (url.pathname === '/fixture/hold') { hold = true; json(response, 200, { ok: true }); return; }
    if (url.pathname === '/fixture/release') { const input = await body(request); if (held) { held.resolve(input.reject === true); held = undefined; } hold = false; json(response, 200, { ok: true }); return; }
    if (url.pathname === '/fixture/call') {
      const input = await body(request);
      try {
        if (input.operation === 'state') { json(response, 200, { result: published ?? {} }); return; }
        if (input.commandId === 'save' && hold) { hold = false; const rejected = await new Promise<boolean>(resolve => { held = { resolve }; }); if (rejected) throw Error('Fixture save rejected.'); }
        json(response, 200, { result: await backend.call!('page.fshdr', { sectionId: 'frontend', commandId: input.commandId, value: input.value }, { signal: lifetime.signal } as any) });
      } catch (error) { json(response, 200, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (url.pathname === '/' || url.pathname === '/preview') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(wrapper); return; }
    let file: string | undefined;
    if (url.pathname.startsWith(prefix)) file = path.join(root, 'dist/ui', path.basename(url.pathname));
    if (url.pathname === '/api/module-controls/spreadsheet-v1.js') file = path.join(assets, 'module-spreadsheet-v1.js');
    if (url.pathname === '/api/module-controls/workbook-tools-v1.js') file = path.join(assets, 'module-workbook-tools-v1.js');
    if (url.pathname === '/api/module-controls/slider-v1.js') file = path.join(assets, 'module-slider-v1.js');
    if (!file) { response.writeHead(404); response.end('Not found'); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch (error) { json(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});
server.listen(port, '127.0.0.1', () => console.log('FS-HDR preview http://127.0.0.1:' + port + (simulatorHosts.length ? ' with simulators at ' + simulatorHosts.join(', ') : ' with no simulators')));
const stop = () => { lifetime.abort(); for (const child of simulators) child.kill(); server.close(); void backend.dispose?.(); setTimeout(() => process.exit(0), 300); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
