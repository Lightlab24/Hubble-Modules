import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ModuleActionResultSchema, ModuleManifestSchema, type ModuleContext, type ModuleInstance } from "@hubble/module-sdk";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
import { createBackend, type BackendOptions, type Statuses } from "../src/backend.js";
import { matrix } from "../src/actions.js";
import { defaultDocument, DOCUMENT_ID, type MonitorDocument, type Mutation } from "../src/model.js";
import source from "../src/manifest.js";
import { FakeMonitor } from "./fake-monitor.js";

// Hubble runs on macOS, where the in-use check reads this Mac's connection table with netstat.
// GitHub's Linux runner has no netstat, so there presses use an empty table and the tests that
// read the real table run on macOS only.
const mac = process.platform === "darwin";
const connectionTable: BackendOptions = mac ? {} : { listConnections: async () => [] };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await delay(10);
  expect(check(), what).toBe(true);
}

async function monitor(policy: "newest-wins" | "many" = "newest-wins") {
  const fake = new FakeMonitor(policy);
  const port = await fake.listen();
  cleanup.push(() => fake.close());
  return { fake, port };
}

/** Another app, in its own process, holding a monitor's port the way LiveGrade does. */
async function otherApp(port: number, fake: FakeMonitor): Promise<ChildProcess> {
  const before = fake.events.filter((event) => event.type === "open").length;
  const child = spawn(process.execPath, ["-e", `require("net").connect(${port}, "127.0.0.1").on("error", () => {}); setInterval(() => {}, 1000)`], {
    stdio: "ignore",
  });
  cleanup.push(() => child.kill());
  await until(() => fake.events.filter((event) => event.type === "open").length > before, "the other app connects");
  return child;
}

/** A port whose listener never accepts and whose queue is full, like a monitor that doesn't answer. */
async function stalledPort(): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", `const s = require("net").createServer(); s.listen(0, "127.0.0.1", 1, () => { console.log(s.address().port); setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 20); });`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanup.push(() => child.kill("SIGKILL"));
  const port = await new Promise<number>((resolve) => child.stdout!.once("data", (data) => resolve(Number(String(data)))));
  await delay(100);
  for (let i = 0; i < 64; i++) {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    cleanup.push(() => socket.destroy());
    const connected = await Promise.race([new Promise<boolean>((resolve) => socket.once("connect", () => resolve(true))), delay(150).then(() => false)]);
    if (!connected) return port;
  }
  throw new Error("Couldn't fill the listener's queue");
}

async function closedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const row = (id: string, name: string, port: number, values: Record<string, string> = {}) => ({
  id,
  values: { name, enabled: "TRUE", host: "127.0.0.1", port: String(port), whenInUse: "wait", ...values },
});

/** Hubble's document store as the worker sees it: revisions, conflicts and a watch that wakes on the next write. */
function documentStore(monitors: MonitorDocument["monitors"]) {
  let document = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: { ...defaultDocument(), monitors } as MonitorDocument };
  let writes = 1;
  const watchers = new Set<() => void>();
  const store = (value: MonitorDocument) => {
    document = { ...document, revision: `rev-${++writes}`, value: structuredClone(value) };
    for (const wake of [...watchers]) wake();
  };
  const services = {
    async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: MonitorDocument }, signal?: AbortSignal) {
      if (input.method === "watch" && input.afterRevision === document.revision)
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
        if (input.expectedRevision !== document.revision) return { status: "conflict", document };
        store(input.value!);
      }
      return { status: "document", document };
    },
  };
  return { services, saved: () => document.value, writeFromElsewhere: store };
}

function backend(monitors: MonitorDocument["monitors"], options: BackendOptions & { connectionEnabled?: boolean } = {}) {
  const documents = documentStore(monitors);
  const states: { values: { statuses: Statuses; sequence: number } }[] = [];
  const feedback: unknown[] = [];
  const logs: string[] = [];
  const context = {
    connectionEnabled: options.connectionEnabled ?? true,
    instanceId: "flanders-test",
    scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "flanders-monitor" },
    settings: {},
    services: documents.services,
    log: (trace: { message: string }) => logs.push(trace.message),
    publishState: (state: never) => states.push(state),
    publishFeedback: (value: unknown) => feedback.push(value),
  } as unknown as ModuleContext;
  const instance = createBackend(context, { now: () => new Date("2026-11-17T10:42:03"), ...connectionTable, ...options });
  cleanup.push(() => instance.dispose());
  const execution = (signal = new AbortController().signal) => ({ executionId: "x", signal, gesture: "press" as const, wrap: false, log: (trace: { message: string }) => logs.push(trace.message) });
  const page = (commandId: string, value?: unknown) =>
    instance.call!(`page.flanders`, { sectionId: "frontend", commandId, ...(value === undefined ? {} : { value }) } as never, { signal: new AbortController().signal, log() {} }) as Promise<Record<string, unknown>>;
  const press = (name: string, key: string, signal?: AbortSignal) =>
    instance.execute("matrix", { actionId: "a", actionColumnId: "c", values: { enabled: true, "module.monitor": name, "module.key": key } }, execution(signal));
  const status = (id: string) => states.at(-1)?.values.statuses[id]?.text;
  return { instance, documents, states, feedback, logs, page, press, status, execution };
}

describe("Flanders module", () => {
  it("declares one workspace module with a full Flanders page, its monitor document and a Monitor + Key column", () => {
    const parsed = ModuleManifestSchema.parse({ ...source, id: "flanders-monitor", name: "Flanders", version: "0.3.0", entry: "module.mjs", files: ["module.mjs", "ui/index.html", "ui/monitor.svg"] });
    expect(parsed.instanceScope).toBe("workspace");
    expect(parsed.documents?.map((document) => document.id)).toEqual([DOCUMENT_ID]);
    // Live in several HubDash windows at once, which only a Hubble with module windows accepts.
    expect(parsed.pages?.[0]).toMatchObject({ id: "flanders", label: "Flanders", layout: "full-page", sections: [{ type: "custom", id: "frontend", windows: true }] });
    // One grid, nothing to split: no parts, so the sidebar's Open in its own window stays one item.
    expect(parsed.pages?.[0]?.sections[0]).not.toHaveProperty("parts");
    expect(parsed.host).toMatchObject({
      requiredFeatures: expect.arrayContaining(["module-spreadsheet-controls-v1", "module-documents-v1", "module-workspace-instances-v1", "module-page-windows-v1"]),
    });
    expect(matrix.fields.map((field) => [field.id, field.type, field.fill])).toEqual([
      ["enabled", "boolean", "copy"],
      ["module.monitor", "text", "copy"],
      ["module.key", "choice", "copy"],
    ]);
    expect(matrix.fields.find((field) => field.id === "module.key")?.choices).toHaveLength(16);
  });

  it("presses a key on the monitor its row names, and on no other, then closes the connection", async () => {
    const one = await monitor();
    const two = await monitor();
    const flanders = backend([row("a", "Grade 1", one.port), row("b", "Grade 2", two.port)]);
    await flanders.instance.start();
    expect([...one.fake.events, ...two.fake.events]).toEqual([]);
    expect(flanders.states.at(-1)).toMatchObject({ phase: "ready", message: null });
    const result = await flanders.press("grade 2", "sdi-3");
    expect(ModuleActionResultSchema.parse(result)).toMatchObject({ status: "success", evidence: { kind: "submitted" } });
    expect(two.fake.events).toEqual([
      { type: "open", client: 1 },
      { type: "key", client: 1, code: 0x13 },
      { type: "client-closed", client: 1 },
    ]);
    expect(one.fake.events).toEqual([]);
    expect(flanders.status("b")).toBe("Sent SDI 3 · 10:42:03");
    await until(() => two.fake.openClients.length === 0, "nothing stays connected");
  });

  it.runIf(mac)("holds a key back while another app on this Mac is connected to that monitor, and says which", async () => {
    const { fake, port } = await monitor();
    const other = await otherApp(port, fake);
    const flanders = backend([row("a", "Grade 1", port)]);
    await flanders.instance.start();
    const result = await flanders.press("Grade 1", "menu");
    expect(result).toMatchObject({ status: "failure", category: "rejected" });
    expect(result.status === "failure" && result.message).toMatch(/^node is connected to Grade 1, so Menu wasn't sent/);
    expect(flanders.status("a")).toBe("Menu held back · node connected · 10:42:03");
    expect(fake.events).toEqual([{ type: "open", client: 1 }]);
    expect(fake.openClients).toEqual([1]);
    other.kill();
    await until(() => fake.openClients.length === 0, "the other app leaves");
    await delay(50);
    expect(await flanders.press("Grade 1", "menu")).toMatchObject({ status: "success" });
    expect(fake.keys).toEqual([0x20]);
  });

  it("sends anyway on a monitor set to, which a newest-wins monitor answers by dropping the other app", async () => {
    const { fake, port } = await monitor("newest-wins");
    await otherApp(port, fake);
    const flanders = backend([row("a", "Grade 1", port, { whenInUse: "send" })]);
    await flanders.instance.start();
    expect(await flanders.press("Grade 1", "f3")).toMatchObject({ status: "success" });
    expect(fake.keys).toEqual([0x33]);
    expect(fake.events).toContainEqual({ type: "dropped", client: 1 });
  });

  it("refuses unknown, switched-off and unaddressed monitors and blank keys without sending", async () => {
    const { fake, port } = await monitor();
    const flanders = backend([row("a", "Grade 1", port), row("b", "Spare", port, { enabled: "FALSE" }), row("c", "New", port, { host: "" })]);
    await flanders.instance.start();
    expect(await flanders.press("Client", "f1")).toMatchObject({ status: "failure", category: "invalid-config", message: `There's no monitor called "Client" on the Flanders page` });
    expect(await flanders.press("Spare", "f1")).toMatchObject({ status: "failure", category: "unavailable" });
    expect(await flanders.press("New", "f1")).toMatchObject({ status: "failure", category: "invalid-config" });
    expect(await flanders.press("Grade 1", "")).toMatchObject({ status: "failure", category: "invalid-config" });
    expect(await flanders.press("", "f1")).toMatchObject({ status: "failure", category: "invalid-config" });
    expect(await flanders.instance.execute("matrix", { key: "f1" }, flanders.execution())).toMatchObject({ category: "invalid-config" });
    expect(await flanders.instance.execute("unknown", {}, flanders.execution())).toMatchObject({ category: "invalid-config" });
    const off = backend([row("a", "Grade 1", port)], { connectionEnabled: false });
    await off.instance.start();
    expect(await off.press("Grade 1", "f1")).toMatchObject({ status: "failure", category: "unavailable" });
    expect(fake.events).toEqual([]);
  });

  it("runs the Press key action with a monitor and key", async () => {
    const { fake, port } = await monitor();
    const flanders = backend([row("a", "Grade 1", port)]);
    await flanders.instance.start();
    expect(await flanders.instance.execute("press-key", { monitor: "Grade 1", key: "mute" }, flanders.execution())).toMatchObject({ status: "success" });
    expect(fake.keys).toEqual([0x44]);
  });

  it("offers the page's monitor names for the Monitor cell", async () => {
    const flanders = backend([row("a", "Grade 1", 1), row("b", "Client", 2)]);
    await flanders.instance.start();
    expect(await flanders.instance.choices!("monitors")).toEqual([
      { id: "Grade 1", label: "Grade 1" },
      { id: "Client", label: "Client" },
    ]);
    expect(await flanders.instance.choices!("other")).toEqual([]);
  });

  it("saves page edits in order, refuses a duplicate name, and uses a new address at the next press", async () => {
    const one = await monitor();
    const two = await monitor();
    const flanders = backend([row("a", "Grade 1", one.port)]);
    await flanders.instance.start();
    const snapshot = await flanders.page("snapshot");
    expect(snapshot).toMatchObject({ revision: "rev-1", document: { monitors: [{ id: "a" }] } });
    const add: Mutation = { kind: "rows", rows: [row("a", "Grade 1", one.port), row("b", "Grade 1", two.port)], expected: [row("a", "Grade 1", one.port)] };
    await expect(flanders.page("save", { operation: add })).rejects.toThrow(/already called Grade 1/);
    const rename: Mutation = { kind: "edit", edits: [{ rowId: "a", columnId: "port", value: String(two.port), expected: String(one.port) }] };
    expect(await flanders.page("save", { operation: rename })).toMatchObject({ revision: "rev-2" });
    expect(flanders.documents.saved().monitors[0]!.values.port).toBe(String(two.port));
    expect(await flanders.press("Grade 1", "f2")).toMatchObject({ status: "success" });
    expect(two.fake.keys).toEqual([0x32]);
    expect(one.fake.keys).toEqual([]);
  });

  it("follows edits made in another HubDash window, and drops a status when its monitor's address changes", async () => {
    const one = await monitor();
    const two = await monitor();
    const flanders = backend([row("a", "Grade 1", one.port)]);
    await flanders.instance.start();
    await flanders.press("Grade 1", "f1");
    expect(flanders.status("a")).toBe("Sent F1 · 10:42:03");
    flanders.documents.writeFromElsewhere({ ...defaultDocument(), monitors: [row("a", "Grade 1", two.port)] });
    await until(() => flanders.states.at(-1)?.values.statuses.a === undefined, "the old status goes");
    expect(await flanders.press("Grade 1", "f1")).toMatchObject({ status: "success" });
    expect(two.fake.keys).toEqual([0x31]);
  });

  it.runIf(mac)("checks this Mac for other apps on every monitor without contacting any monitor", async () => {
    const one = await monitor();
    const two = await monitor();
    await otherApp(two.port, two.fake);
    const flanders = backend([row("a", "Grade 1", one.port), row("b", "Grade 2", two.port), row("c", "Off", one.port, { enabled: "FALSE" })]);
    await flanders.instance.start();
    const reply = await flanders.page("check");
    expect(reply.message).toBe("Another app is connected to 1 monitor");
    expect(flanders.status("a")).toBe("No other apps connected · 10:42:03");
    expect(flanders.status("b")).toBe("node connected · keys held back · 10:42:03");
    expect(flanders.status("c")).toBeUndefined();
    expect(one.fake.events).toEqual([]);
    expect(two.fake.events).toEqual([{ type: "open", client: 1 }]);
  });

  it("wakes the page's status wait as soon as a key's result is in", async () => {
    const { port } = await monitor();
    const flanders = backend([row("a", "Grade 1", port)]);
    await flanders.instance.start();
    const { sequence } = (await flanders.page("snapshot")) as { sequence: number };
    const waiting = flanders.page("changes", { after: sequence });
    await delay(30);
    await flanders.press("Grade 1", "up");
    const reply = (await waiting) as { statuses: Statuses; sequence: number };
    expect(reply.sequence).toBeGreaterThan(sequence);
    expect(reply.statuses.a?.text).toBe("Sent Up · 10:42:03");
  });

  it("presses keys for one monitor one at a time, never two connections at once", async () => {
    const { fake, port } = await monitor("many");
    const flanders = backend([row("a", "Grade 1", port), row("b", "Same monitor", port)]);
    await flanders.instance.start();
    const results = await Promise.all([flanders.press("Grade 1", "up"), flanders.press("Same monitor", "down"), flanders.press("Grade 1", "enter")]);
    expect(results.map((result) => result.status)).toEqual(["success", "success", "success"]);
    expect(fake.keys).toEqual([0x21, 0x22, 0x25]);
    expect(fake.events.map((event) => event.type)).toEqual(["open", "key", "client-closed", "open", "key", "client-closed", "open", "key", "client-closed"]);
  });

  it("reports a refused connection and a monitor that never answers, and says nothing was sent", async () => {
    const refused = await closedPort();
    const stalled = await stalledPort();
    const flanders = backend([row("a", "Gone", refused), row("b", "Silent", stalled, { whenInUse: "send" })], { connectTimeoutMs: 200 });
    await flanders.instance.start();
    const gone = await flanders.press("Gone", "f1");
    expect(gone).toMatchObject({ status: "failure", category: "unavailable" });
    expect(gone.status === "failure" && gone.message).toMatch(/refused the connection.*Nothing was sent/);
    expect(flanders.status("a")).toBe("F1 not sent · couldn't connect · 10:42:03");
    const silent = await flanders.press("Silent", "f1");
    expect(silent).toMatchObject({ status: "failure", category: "timeout" });
    expect(flanders.status("b")).toBe("F1 not sent · no answer · 10:42:03");
  });

  it("doesn't send when the check for other apps fails, and cancels a key waiting behind another", async () => {
    const { fake, port } = await monitor("many");
    const failing = backend([row("a", "Grade 1", port)], { listConnections: async () => Promise.reject(new Error("netstat missing")) });
    await failing.instance.start();
    expect(await failing.press("Grade 1", "f2")).toMatchObject({ status: "failure", category: "unavailable" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = backend([row("a", "Grade 1", port)], { listConnections: async () => (await held, []) });
    await slow.instance.start();
    const first = slow.press("Grade 1", "f4");
    const controller = new AbortController();
    const second = slow.press("Grade 1", "f5", controller.signal);
    controller.abort();
    release();
    expect(await first).toMatchObject({ status: "success" });
    expect(await second).toMatchObject({ status: "failure", category: "cancelled" });
    expect(fake.keys).toEqual([0x34]);
  });

  it("publishes no feedback colour, since the monitor reports nothing back, and disposes twice", async () => {
    const flanders = backend([]);
    await flanders.instance.start();
    const values = { "module.monitor": "Grade 1", "module.key": "f1" };
    await flanders.instance.subscribeFeedback?.([{ id: "key", fields: { values } }], { signal: new AbortController().signal });
    expect(flanders.feedback).toEqual([{ id: "key", fields: { values }, state: "unavailable", observedAt: null }]);
    await flanders.instance.dispose();
    await flanders.instance.dispose();
  });

  it("needs Hubble's documents and starts through the package entry", () => {
    const harness = createModuleHarness(module, {});
    expect(harness.instance).toBeDefined();
    expect(() => createBackend({ ...harness.context, services: undefined } as unknown as ModuleContext)).toThrow(/portable documents/);
  });
});

export type { ModuleInstance };
