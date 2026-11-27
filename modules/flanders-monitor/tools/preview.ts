// Runs the built Flanders page against the real worker, outside Hubble, for checks in a browser.
//   pnpm build && FLANDERS_PREVIEW_PORT=43292 node_modules/.bin/tsx tools/preview.ts
// The page sits in the same kind of sandboxed frame Hubble gives it, and the shared control files
// are read, unchanged, from an installed Hubble (FLANDERS_RENDERER_ASSETS). The monitor list starts
// with two rows on 127.0.0.1; a fake monitor (tools/fake-monitor.ts) can listen there. Nothing
// here reaches a real monitor unless its address is typed in and a key is pressed from Hubble,
// which the preview can't do. Like Hubble, every open copy (each browser page, or each of
// PREVIEW_COPIES frames) is handed the worker's state when it changes.
// POST /__simulate takes { holdSaves, releaseSaves, failNextSave, reset }; GET /__inspect shows
// the saved list, its revision and how many times it was written.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModuleContext } from "@hubble/module-sdk";
import { createBackend } from "../src/backend.js";
import { defaultDocument, DOCUMENT_ID, type MonitorDocument, type MonitorRow } from "../src/model.js";

const assets = process.env.FLANDERS_RENDERER_ASSETS || "/Applications/Hubble.app/Contents/Library/HubbleAgent/renderer/main_window/assets";
const port = Number(process.env.FLANDERS_PREVIEW_PORT || 43192);
const monitor = (id: string, name: string, values: Record<string, string> = {}): MonitorRow => ({
  id,
  values: { name, enabled: "TRUE", host: "127.0.0.1", port: "18181", whenInUse: "wait", ...values },
});
const seeded = () => ({ ...defaultDocument(), monitors: [monitor("seed-1", "Grade 1"), monitor("seed-2", "Client", { port: "18182", whenInUse: "send" })] }) as MonitorDocument;

let saved = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: seeded() };
let writes = 1;
let holdSaves: Promise<void> | undefined;
let releaseSaves: (() => void) | undefined;
let failNextSave = false;
const watchers = new Set<() => void>();
let state: unknown = null;
const services = {
  async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: MonitorDocument }, signal?: AbortSignal) {
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
  instanceId: "flanders-preview",
  scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "flanders-monitor" },
  settings: {},
  services,
  log: () => undefined,
  publishState: (value: unknown) => (state = value),
  publishFeedback: () => undefined,
} as unknown as ModuleContext;
const instance = createBackend(context);
await instance.start!();

const manifest = JSON.parse(await readFile(path.resolve("dist/hubble-module.json"), "utf8"));
const declared = new Set<string>(manifest.pages[0].sections[0].commands.map((command: { id: string }) => command.id));
const pagePath = "/api/module-pages/" + "b".repeat(43);
const copies = Math.max(1, Math.min(4, Number(process.env.PREVIEW_COPIES || 1)));
const stateMs = Math.max(20, Number(process.env.PREVIEW_STATE_MS || 50));
const frames = Array.from({ length: copies }, (_, index) => `<iframe title="Flanders ${index + 1}" sandbox="allow-scripts" src="${pagePath}/ui/index.html"></iframe>`).join("");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Flanders preview</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#141414}body{display:flex;gap:4px}iframe{display:block;flex:1;min-width:0;height:100dvh;border:0}</style>${frames}<script>
const ports=new Map();
window.addEventListener('message', event => {
  const frame=[...document.querySelectorAll('iframe')].find(item=>item.contentWindow===event.source);if(!frame||event.data?.type!=='hubble.module.frontend.ready.v1')return;
  ports.get(frame)?.close();const channel=new MessageChannel();const port=channel.port1;ports.set(frame,port);
  port.onmessage=async event=>{const message=event.data;try{const response=await fetch('/__rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});const value=await response.json();port.postMessage(value.error?{type:'error',id:message.id,message:value.error}:{type:'result',id:message.id,value:value.result});}catch{port.postMessage({type:'error',id:message.id,message:'Preview bridge disconnected'});}};
  port.start();frame.contentWindow.postMessage({type:'hubble.module.frontend.connect.v1',id:event.data.id},'*',[channel.port2]);
});
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
        if (input.holdSaves && !holdSaves) holdSaves = new Promise((resolve) => (releaseSaves = resolve));
        if (input.releaseSaves) {
          releaseSaves?.();
          holdSaves = releaseSaves = undefined;
        }
        if (input.failNextSave) failNextSave = true;
        if (input.reset) {
          saved = { ...saved, revision: `rev-${++writes}`, value: seeded() };
          for (const wake of [...watchers]) wake();
        }
        return send({ updated: true });
      }
      if (url.pathname !== "/__rpc") return send({ error: "Unknown preview route" }, 404);
      if (input.operation === "state") return send({ result: state });
      if (!declared.has(input.commandId)) return send({ error: `Module page command is not declared: ${input.commandId}` });
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      try {
        return send({ result: await instance.call!("page.flanders", { sectionId: "frontend", commandId: input.commandId, value: input.value } as never, { signal: abort.signal, log() {} } as never) });
      } catch (error) {
        return send({ error: error instanceof Error ? error.message : "Preview request failed" });
      }
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end(html);
    }
    if (url.pathname === "/__inspect") return send({ document: saved.value, revision: saved.revision, writes, state });
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
server.listen(port, "127.0.0.1", () => console.log(`Flanders preview on http://127.0.0.1:${port}`));
const stop = () => {
  instance.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
