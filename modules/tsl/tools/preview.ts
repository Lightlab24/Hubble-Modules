// Runs the built TSL Tally page against the real backend, outside Hubble, with a pretend Ross
// switcher on this computer. The page sits in the same kind of sandboxed frame Hubble gives it,
// and the shared control files are read, unchanged, from an installed Hubble
// (TSL_RENDERER_ASSETS). Nothing here reaches a real switcher unless TSL_PREVIEW_SWITCHER names
// one: then the page talks to that switcher, this computer's real addresses are used, and the
// pretend switcher sends no tally.
import dgram from "node:dgram";
import net from "node:net";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModuleContext, ModuleInstance } from "@hubble/module-sdk";
import { createTslModule } from "../src/module.js";
import { PAGE_ID, PAGE_SECTION_ID, PAGE_SETTINGS, localAddresses } from "../src/page.js";
import { defaultSwitcherDocument, SWITCHER_DOCUMENT_ID } from "../src/setup.js";
import { FAKE_DRIVER, FakeSwitcher } from "../test/fixtures/fake-switcher.js";
import { packet31, packet50, stream50 } from "../test/fixtures/tsl-packets.js";

const assets = process.env.TSL_RENDERER_ASSETS || "/Applications/Hubble.app/Contents/Library/HubbleAgent/renderer/main_window/assets";
const port = Number(process.env.TSL_PREVIEW_PORT || 43197);
const captured = JSON.parse(await readFile(path.resolve("tools/preview-displays.json"), "utf8")) as { address: number; label: string; left: number; text: number; right: number }[];

// ----- The pretend switcher: the three devices the real one had, and tally for whoever it points at here. -----
const fake = await FakeSwitcher.start({ chatter: true });
let program = 2;
let preview = 3;
const control = (address: number, original: { left: number; text: number; right: number }) =>
  address <= 24
    ? (address === program ? 1 : 0) | ((address === program ? (address === preview ? 3 : 1) : address === preview ? 2 : 0) << 2) | ((address === preview ? 2 : 0) << 4)
    : original.right | (original.text << 2) | (original.left << 4);
const tcpLinks = new Map<string, net.Socket>();
const sendTally = (onlyChanged: boolean) => {
  for (const device of fake.devices) {
    if (device.type !== 11 || !device.enabled || device.ip !== "127.0.0.1") continue;
    const five = device.driverKey === FAKE_DRIVER.tsl5;
    const rows = captured.filter((row) => (five ? true : row.address <= 126) && (!onlyChanged || row.address <= 24));
    const packets = rows.map((row) =>
      five
        ? packet50(device.screen, [{ address: row.address, control: control(row.address, row), label: row.label }])
        : packet31(row.address, (row.address === preview ? 1 : 0) | (row.address === program ? 2 : 0), row.label.slice(0, 16)),
    );
    if (device.transport === 1) {
      const socket = dgram.createSocket("udp4");
      let left = packets.length;
      for (const packet of packets) socket.send(packet, device.port, device.ip, () => --left || socket.close());
      if (!packets.length) socket.close();
    } else {
      const key = `${device.ip}:${device.port}`;
      let socket = tcpLinks.get(key);
      if (!socket || socket.destroyed) {
        socket = net.connect(device.port, device.ip);
        socket.on("error", () => socket?.destroy());
        tcpLinks.set(key, socket);
      }
      for (const packet of packets) socket.write(five ? stream50(packet) : packet);
    }
  }
};
const realSwitcher = process.env.TSL_PREVIEW_SWITCHER || "";
let ticks = 0;
setInterval(() => {
  if (realSwitcher) return;
  // A cut every few seconds, and everything again now and then, as the real switcher does.
  // Every fourth cut leaves program and preview on the same input, which a Ross switcher
  // sends as green, amber and red together.
  if (++ticks % 3 === 0) [program, preview] = [preview, ticks % 12 === 0 ? preview : (preview % 8) + 1];
  sendTally(ticks % 20 !== 0);
}, 1000).unref();

// ----- A pretend Hubble: settings, the saved document, and a restart when a setting is saved. -----
const settings: Record<string, unknown> = {
  name: "TSL Tally Main",
  routingPeer: "",
  protocol: process.env.TSL_PREVIEW_PROTOCOL || "3.1",
  transport: process.env.TSL_PREVIEW_TRANSPORT || "tcp",
  bindAddress: "0.0.0.0",
  port: Number(process.env.TSL_PREVIEW_LISTEN_PORT || 45727),
  sourceAddress: "",
  staleAfterMs: 0,
};
let saved = { id: SWITCHER_DOCUMENT_ID, version: 1, revision: null as string | null, value: { ...defaultSwitcherDocument(), host: realSwitcher || (process.env.TSL_PREVIEW_EMPTY ? "" : `127.0.0.1:${fake.port}`) } };
let writes = 0;
let holdSaves: Promise<void> | undefined;
let releaseSaves: (() => void) | undefined;
let failNextSave = false;
let failNextSettings = false;
let generation = 0;
const logs: unknown[] = [];
let state: unknown = null;
const services = {
  async request(_service: string, _version: number, input: { method: string; expectedRevision?: string | null; value?: typeof saved.value }) {
    if (input.method === "write") {
      await holdSaves;
      if (failNextSave) {
        failNextSave = false;
        throw new Error("The workspace refused this save.");
      }
      if (input.expectedRevision !== saved.revision) return { status: "conflict", document: saved };
      saved = { ...saved, revision: `rev-${++writes}`, value: structuredClone(input.value!) };
    }
    return { status: "document", document: saved };
  },
};
const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "tsl-preview-"));
const module = createTslModule(
  realSwitcher
    ? {}
    : {
        // The pretend switcher is on this computer, so loopback counts as one of its addresses here.
        localAddresses: () => [...localAddresses(), { id: "127.0.0.1", label: "127.0.0.1 · this computer" }],
        routeAddress: async (host) => (host === "127.0.0.1" ? "127.0.0.1" : null),
      },
);
let instance: ModuleInstance;
const startInstance = async () => {
  generation++;
  const context = {
    connectionEnabled: true,
    instanceId: "tsl-preview",
    runtimeDirectory,
    scope: { kind: "connection", workspaceId: "11111111-1111-4111-8111-111111111111", connectionId: "22222222-2222-4222-8222-222222222222" },
    settings: structuredClone(settings),
    services,
    modules: { discover: async () => [], bindings: async () => [], publish: async () => undefined, subscribe: async () => async () => undefined, query: async () => null, execute: async () => ({ status: "failure", category: "unavailable", message: "No peers in the preview" }) },
    log: (trace: unknown) => logs.push(trace),
    publishState: (value: unknown) => (state = value),
    publishFeedback: () => undefined,
    publishEvent: () => undefined,
  } as unknown as ModuleContext;
  instance = module.createInstance(context);
  await instance.start();
};
await startInstance();

const manifest = JSON.parse(await readFile(path.resolve("dist/hubble-module.json"), "utf8"));
const section = manifest.pages[0].sections[0] as { commands: { id: string }[]; settings?: string[] };
const declared = new Set<string>(section.commands.map((command) => command.id));
const pagePath = "/api/module-pages/" + "a".repeat(43);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>TSL Tally preview</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#060606}iframe{display:block;width:100%;height:100dvh;border:0}</style><iframe title="TSL Tally" sandbox="allow-scripts" src="${pagePath}/ui/index.html"></iframe><script>
let port; window.addEventListener('message', event => {
  const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow||event.data?.type!=='hubble.module.frontend.ready.v1')return;
  port?.close();const channel=new MessageChannel();port=channel.port1;
  port.onmessage=async event=>{const message=event.data;try{const response=await fetch('/__rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});const value=await response.json();
    // A saved setting restarts the module, and Hubble then reloads the page. So does this.
    if(value.reload){window.__reloads=(window.__reloads||0)+1;frame.src=frame.src;return;}
    port.postMessage(value.error?{type:'error',id:message.id,message:value.error}:{type:'result',id:message.id,value:value.result});}catch{port.postMessage({type:'error',id:message.id,message:'Preview bridge disconnected'});}};
  port.start();frame.contentWindow.postMessage({type:'hubble.module.frontend.connect.v1',id:event.data.id},'*',[channel.port2]);
});
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
        // Hold, release or fail saves, and make the pretend switcher misbehave.
        if (input.holdSaves && !holdSaves) holdSaves = new Promise((resolve) => (releaseSaves = resolve));
        if (input.releaseSaves) {
          releaseSaves?.();
          holdSaves = releaseSaves = undefined;
        }
        if (input.failNextSave) failNextSave = true;
        if (input.failNextSettings) failNextSettings = true;
        if (input.switcher) Object.assign(fake.options, input.switcher);
        if (input.holdSwitcher) fake.hold();
        if (input.releaseSwitcher) fake.release();
        if (input.settings) {
          Object.assign(settings, input.settings);
          await instance.dispose();
          await startInstance();
        }
        return send({ updated: true });
      }
      if (url.pathname !== "/__rpc") return send({ error: "Unknown preview route" }, 404);
      if (input.operation === "state") return send({ result: state });
      if (input.operation === "settings") {
        // Hubble accepts only the settings the section declares, refuses the rest whole, then restarts the module.
        if (Object.keys(input.values).some((id) => !(section.settings ?? []).includes(id))) return send({ error: "This page did not declare that setting" });
        if (failNextSettings) {
          failNextSettings = false;
          return send({ error: "The workspace refused this save." });
        }
        Object.assign(settings, input.values);
        await instance.dispose();
        await startInstance();
        return send({ result: null, reload: true });
      }
      // Hubble passes a page only the commands its manifest declares, and so does the preview.
      if (!declared.has(input.commandId)) return send({ error: `Module page command is not declared: ${input.commandId}` });
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const serving = instance;
      try {
        return send({ result: await serving.call!(`page.${PAGE_ID}`, { sectionId: PAGE_SECTION_ID, commandId: input.commandId, value: input.value ?? null } as never, { signal: abort.signal, log: () => undefined } as never) });
      } catch (error) {
        if (abort.signal.aborted) return void response.end();
        return send({ error: error instanceof Error ? error.message : "Preview request failed" });
      }
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end(html);
    }
    if (url.pathname === "/__inspect")
      return send({ settings, generation, document: saved.value, revision: saved.revision, switcher: { port: fake.port, devices: fake.devices, writes: fake.writes, form: fake.form, connections: fake.openConnections }, logs: logs.slice(-40), state, declaredSettings: [...PAGE_SETTINGS] });
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
server.listen(port, "127.0.0.1", () => console.log(`TSL Tally preview on http://127.0.0.1:${port} (${realSwitcher ? `REAL switcher ${realSwitcher}` : `pretend switcher on 127.0.0.1:${fake.port}`})`));
const stop = async () => {
  await instance.dispose();
  await fake.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
