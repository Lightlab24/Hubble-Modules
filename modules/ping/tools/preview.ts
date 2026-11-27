// Runs the built Ping page against the real backend and real pings, outside Hubble.
// The page sits in the same kind of sandboxed frame Hubble gives it, and the shared
// control files are read, unchanged, from an installed Hubble (PING_RENDERER_ASSETS).
// PREVIEW_COPIES=2 shows that many copies of the page side by side, as in several HubDash
// windows: each its own frame and channel, all on the one worker. Like Hubble, the preview
// hands every copy the worker's state when it changes (checked every PREVIEW_STATE_MS, 50).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModuleContext } from "@hubble/module-sdk";
import { createBackend } from "../src/backend.js";
import type { PingProcess } from "../src/engine.js";
import { defaultDocument, DOCUMENT_ID, type DeviceRow, type PingDocument } from "../src/model.js";

const assets = process.env.PING_RENDERER_ASSETS || "/Applications/Hubble.app/Contents/Library/HubbleAgent/renderer/main_window/assets";
const port = Number(process.env.PING_PREVIEW_PORT || 43191);
const device = (id: string, name: string, host: string, values: Record<string, string> = {}): DeviceRow => ({ id, values: { name, enabled: "TRUE", host, over: "", lost: "", ...values } });
// PING_PREVIEW_DEVICES is "Name=address,Name=address". 192.0.2.1 is reserved for examples and never answers.
const seeded = (process.env.PING_PREVIEW_DEVICES || "This Mac=127.0.0.1,Nobody=192.0.2.1").split(",").map((item, index) => {
  const [name, host] = item.split("=");
  return device(`seed-${index + 1}`, name!.trim(), (host ?? "").trim(), index === 0 ? { over: "20" } : {});
});

const seededDocument = () => ({ ...defaultDocument(), devices: process.env.PING_PREVIEW_EMPTY ? [] : structuredClone(seeded) }) as PingDocument;
let saved = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: seededDocument() };
let writes = 1;
let holdSaves: Promise<void> | undefined;
let releaseSaves: (() => void) | undefined;
let failNextSave = false;
const watchers = new Set<() => void>();
const logs: unknown[] = [];
const feedback: unknown[] = [];
const alerts: unknown[] = [];
let state: unknown = null;
const services = {
  async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: PingDocument }, signal?: AbortSignal) {
    if (input.method === "watch" && input.afterRevision === saved.revision)
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          watchers.delete(wake);
          resolve();
        };
        watchers.add(wake);
        signal?.addEventListener("abort", () => {
          watchers.delete(wake);
          reject(new Error("cancelled"));
        });
      });
    if (input.method === "write") {
      await holdSaves;
      if (failNextSave) {
        failNextSave = false;
        throw new Error("The workspace refused this save.");
      }
      if (input.expectedRevision !== saved.revision) return { status: "conflict", document: saved };
      saved = { ...saved, revision: `rev-${++writes}`, value: structuredClone(input.value!) };
      for (const wake of [...watchers]) wake();
    }
    return { status: "document", document: saved };
  },
};
const context = {
  connectionEnabled: true,
  instanceId: "ping-preview",
  scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "network-ping" },
  settings: {},
  services,
  log: (trace: unknown) => logs.push(trace),
  publishState: (value: unknown) => (state = value),
  publishFeedback: (value: unknown) => feedback.push(value),
  // Hubble would raise a notification here; the preview only records what was asked for.
  publishEvent: (channel: string, value: unknown) => alerts.push({ channel, value }),
} as unknown as ModuleContext;
/**
 * PING_PREVIEW_FAKE=1 answers with a stand-in for fping instead of real pings: about 0.8 ms with a
 * spike now and then, and the last few minutes filled in at the start, so the timeline's scale can
 * be looked at without waiting for a real network to misbehave. Addresses in 192.0.2.x never answer.
 */
function fakePinger(args: readonly string[]): PingProcess {
  const every = Number(args[args.indexOf("-p") + 1]) || 1000;
  const addresses = args.slice(args.indexOf("-b") + 2);
  const listeners: ((chunk: string) => void)[] = [];
  let count = 0;
  // A fixed sequence, so every run of the preview draws the same picture.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const line = (at: number) =>
    addresses
      .map((address) => {
        const spike = random() < 0.012 ? 4 + random() * 22 : 0;
        const rtt = 0.5 + random() * 0.6 + spike;
        return address.startsWith("192.0.2.")
          ? `[${(at / 1000).toFixed(5)}] ${address} : [${count}], timed out (NaN avg, 100% loss)\n`
          : `[${(at / 1000).toFixed(5)}] ${address} : [${count}], 64 bytes, ${rtt.toFixed(3)} ms (0.8 avg, 0% loss)\n`;
      })
      .join("");
  const backfillFrom = Date.now() - 5 * 60_000;
  const timer = setInterval(() => {
    const text = line(Date.now());
    count++;
    for (const listener of listeners) listener(text);
  }, every);
  setTimeout(() => {
    let text = "";
    for (let at = backfillFrom; at < Date.now(); at += every) text += line(at);
    for (const listener of listeners) listener(text);
  }, 50);
  return {
    stdout: { on: (_event: "data", listener: (chunk: Buffer | string) => void) => void listeners.push(listener) },
    on: () => undefined,
    kill: () => clearInterval(timer),
  };
}
const instance = createBackend(context, process.env.PING_PREVIEW_FAKE ? { start: fakePinger } : {});
await instance.start!();

const manifest = JSON.parse(await readFile(path.resolve("dist/hubble-module.json"), "utf8"));
const declared = new Set<string>(manifest.pages[0].sections[0].commands.map((command: { id: string }) => command.id));
const pagePath = "/api/module-pages/" + "a".repeat(43);
const copies = Math.max(1, Math.min(4, Number(process.env.PREVIEW_COPIES || 1)));
const stateMs = Math.max(20, Number(process.env.PREVIEW_STATE_MS || 50));
const frames = Array.from({ length: copies }, (_, index) => `<iframe title="Ping ${index + 1}" sandbox="allow-scripts" src="${pagePath}/ui/index.html"></iframe>`).join("");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Ping preview</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#141414}body{display:flex;gap:4px}iframe{display:block;flex:1;min-width:0;height:100dvh;border:0}</style>${frames}<script>
const ports=new Map();
window.addEventListener('message', event => {
  const frame=[...document.querySelectorAll('iframe')].find(item=>item.contentWindow===event.source);if(!frame||event.data?.type!=='hubble.module.frontend.ready.v1')return;
  ports.get(frame)?.close();const channel=new MessageChannel();const port=channel.port1;ports.set(frame,port);
  port.onmessage=async event=>{const message=event.data;try{const response=await fetch('/__rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});const value=await response.json();port.postMessage(value.error?{type:'error',id:message.id,message:value.error}:{type:'result',id:message.id,value:value.result});}catch{port.postMessage({type:'error',id:message.id,message:'Preview bridge disconnected'});}};
  port.start();frame.contentWindow.postMessage({type:'hubble.module.frontend.connect.v1',id:event.data.id},'*',[channel.port2]);
});
// Like Hubble: every open copy is handed the worker's state whenever it changes.
let shown='';setInterval(async()=>{try{const text=await (await fetch('/__state')).text();if(text===shown)return;shown=text;const value=JSON.parse(text);for(const port of ports.values())port.postMessage({type:'state',value});}catch{}},${stateMs});
</script></html>`;
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://127.0.0.1");
  const send = (value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const file = (body: Buffer, name: string) => {
    response.writeHead(200, { "Content-Type": types[path.extname(name)] ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    response.end(body);
  };
  try {
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (url.pathname === "/__simulate") {
        // Hold, release or fail saves, to see what the page does while one is waiting.
        if (input.holdSaves && !holdSaves) holdSaves = new Promise((resolve) => (releaseSaves = resolve));
        if (input.releaseSaves) {
          releaseSaves?.();
          holdSaves = releaseSaves = undefined;
        }
        if (input.failNextSave) failNextSave = true;
        // Puts the seeded list back, as a new save, so a check can start again without restarting the preview.
        if (input.reset) {
          saved = { ...saved, revision: `rev-${++writes}`, value: seededDocument() };
          for (const wake of [...watchers]) wake();
        }
        return send({ updated: true });
      }
      if (url.pathname !== "/__rpc") return send({ error: "Unknown preview route" }, 404);
      if (input.operation === "state") return send({ result: state });
      // Hubble passes a page only the commands its manifest declares, and so does the preview.
      if (!declared.has(input.commandId)) return send({ error: `Module page command is not declared: ${input.commandId}` });
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      try {
        return send({ result: await instance.call!("page.ping", { sectionId: "frontend", commandId: input.commandId, value: input.value } as never, { signal: abort.signal } as never) });
      } catch (error) {
        return send({ error: error instanceof Error ? error.message : "Preview request failed" });
      }
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end(html);
    }
    if (url.pathname === "/__inspect") return send({ document: saved.value, revision: saved.revision, writes, logs, alerts, feedback: feedback.slice(-20), state });
    if (url.pathname === "/__state") return send(state);
    if (url.pathname.startsWith("/api/module-controls/")) {
      const name = path.basename(url.pathname);
      const served = /^(spreadsheet|controls|slider|workbook-tools)-v1\.js$|^theme-v1\.css$/u.test(name) ? `module-${name}` : name;
      return file(await readFile(path.join(assets, served)), name);
    }
    if (url.pathname.startsWith(`${pagePath}/ui/`)) {
      const name = path.basename(url.pathname);
      return file(await readFile(path.resolve("dist/ui", name)), name);
    }
    response.writeHead(404).end();
  } catch {
    if (!response.headersSent) send({ error: "Preview request failed" }, 500);
    else response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Ping preview on http://127.0.0.1:${port}`));
const stop = () => {
  instance.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
