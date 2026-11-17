import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ModuleActionResultSchema, ModuleManifestSchema } from "@hubble/module-sdk";
import { assertModuleConformance, createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
import { createInstance } from "../src/instance.js";
import { matrix } from "../src/actions.js";
import source from "../src/manifest.js";
import { FakeMonitor } from "./fake-monitor.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function monitor(policy: "newest-wins" | "many" = "newest-wins") {
  const fake = new FakeMonitor(policy);
  const port = await fake.listen();
  cleanup.push(() => fake.close());
  return { fake, port };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await delay(10);
  expect(check(), what).toBe(true);
}

/** Another app, in its own process, holding the monitor's port the way LiveGrade does. */
async function otherApp(port: number, fake: FakeMonitor): Promise<ChildProcess> {
  const before = fake.events.filter((event) => event.type === "open").length;
  const child = spawn(
    process.execPath,
    ["-e", `require("net").connect(${port}, "127.0.0.1").on("error", () => {}); setInterval(() => {}, 1000)`],
    { stdio: "ignore" },
  );
  cleanup.push(() => child.kill());
  await until(() => fake.events.filter((event) => event.type === "open").length > before, "the other app connects");
  return child;
}

/**
 * A port whose listener never accepts and whose queue is full, so a new
 * connection attempt hangs like one to a monitor that doesn't answer. The
 * listener is a separate process that blocks right after listening.
 */
async function stalledPort(): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const s = require("net").createServer(); s.listen(0, "127.0.0.1", 1, () => { console.log(s.address().port); setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 20); });`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanup.push(() => child.kill("SIGKILL"));
  const port = await new Promise<number>((resolve) => child.stdout!.once("data", (data) => resolve(Number(String(data)))));
  await delay(100);
  // Fill the queue: keep connecting until an attempt no longer completes.
  for (let i = 0; i < 64; i++) {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    cleanup.push(() => socket.destroy());
    const connected = await Promise.race([
      new Promise<boolean>((resolve) => socket.once("connect", () => resolve(true))),
      delay(150).then(() => false),
    ]);
    if (!connected) return port;
  }
  throw new Error("Couldn't fill the listener's queue");
}

const settings = (port: number, extra: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  whenInUse: "wait",
  ...extra,
});
const row = (key: string) => ({ actionId: "row", actionColumnId: "column", values: { enabled: true, "module.key": key } });

describe("Flanders module", () => {
  it("declares a valid manifest with a Key column and every FSI key", () => {
    const parsed = ModuleManifestSchema.parse({
      ...source,
      id: "flanders-monitor",
      name: "Flanders",
      version: "0.1.0",
      entry: "module.mjs",
      files: ["module.mjs"],
    });
    expect(parsed.matrix?.primaryField).toBe("module.key");
    expect(parsed.actions.map((action) => action.id)).toEqual(["matrix", "press-key"]);
    expect(parsed.settings.map((setting) => setting.id)).toEqual(["host", "port", "whenInUse"]);
    expect(matrix.fields.find((field) => field.id === "module.key")?.choices).toHaveLength(16);
  });

  it("passes the SDK conformance checks and doesn't contact the monitor on start", async () => {
    const { fake, port } = await monitor();
    await assertModuleConformance({
      module,
      settings: settings(port),
      actionId: "press-key",
      fields: { key: "f1" },
      controlCount: () => fake.events.length,
    });
    expect(fake.keys).toEqual([0x31]);
  });

  it("sends one packet per key and closes its connection straight away", async () => {
    const { fake, port } = await monitor();
    const harness = createModuleHarness(module, settings(port));
    await harness.instance.start();
    expect(fake.events).toEqual([]);
    const result = await harness.instance.execute("matrix", row("sdi-2"), harness.execution());
    expect(ModuleActionResultSchema.parse(result)).toMatchObject({ status: "success", evidence: { kind: "submitted" } });
    expect(fake.events).toEqual([
      { type: "open", client: 1 },
      { type: "key", client: 1, code: 0x12 },
      { type: "client-closed", client: 1 },
    ]);
    await until(() => fake.openClients.length === 0, "nothing stays connected");
    expect(harness.states.at(-1)).toMatchObject({ phase: "ready" });
  });

  it("leaves another app's connection alone and says which app it is", async () => {
    const { fake, port } = await monitor();
    const other = await otherApp(port, fake);
    const harness = createModuleHarness(module, settings(port));
    await harness.instance.start();
    const result = await harness.instance.execute("press-key", { key: "menu" }, harness.execution());
    expect(result).toMatchObject({ status: "failure", category: "rejected" });
    expect(result.status === "failure" && result.message).toMatch(/^node is connected to this monitor, so Menu wasn't sent/);
    // The monitor never saw a second connection, so the other app kept its own.
    expect(fake.events).toEqual([{ type: "open", client: 1 }]);
    expect(fake.openClients).toEqual([1]);
    other.kill();
    await until(() => fake.openClients.length === 0, "the other app leaves");
    await delay(50);
    const after = await harness.instance.execute("press-key", { key: "menu" }, harness.execution());
    expect(after).toMatchObject({ status: "success" });
    expect(fake.keys).toEqual([0x20]);
  });

  it("sends anyway when told to, which a newest-wins monitor answers by dropping the other app", async () => {
    const { fake, port } = await monitor("newest-wins");
    await otherApp(port, fake);
    const harness = createModuleHarness(module, settings(port, { whenInUse: "send" }));
    await harness.instance.start();
    const result = await harness.instance.execute("press-key", { key: "f3" }, harness.execution());
    expect(result).toMatchObject({ status: "success" });
    expect(fake.keys).toEqual([0x33]);
    expect(fake.events).toContainEqual({ type: "dropped", client: 1 });
  });

  it("presses keys for one monitor one at a time, never two connections at once", async () => {
    const { fake, port } = await monitor("many");
    const first = createModuleHarness(module, settings(port));
    const second = createModuleHarness(module, settings(port));
    const results = await Promise.all([
      first.instance.execute("press-key", { key: "up" }, first.execution()),
      second.instance.execute("press-key", { key: "down" }, second.execution()),
      first.instance.execute("press-key", { key: "enter" }, first.execution()),
    ]);
    expect(results.map((result) => result.status)).toEqual(["success", "success", "success"]);
    expect(fake.keys).toEqual([0x21, 0x22, 0x25]);
    // Each connection is finished before the next one opens.
    expect(fake.events.map((event) => event.type)).toEqual([
      "open", "key", "client-closed",
      "open", "key", "client-closed",
      "open", "key", "client-closed",
    ]);
  });

  it("reports a missing monitor without hanging", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const harness = createModuleHarness(module, settings(port));
    const started = Date.now();
    const result = await harness.instance.execute("press-key", { key: "f1" }, harness.execution());
    expect(result).toMatchObject({ status: "failure", category: "unavailable" });
    expect(result.status === "failure" && result.message).toMatch(/refused the connection.*Nothing was sent/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("times out on a monitor that never answers, and says nothing was sent", async () => {
    const port = await stalledPort();
    const harness = createModuleHarness(module, settings(port, { whenInUse: "send" }));
    const instance = createInstance(harness.context, { connectTimeoutMs: 200 });
    const started = Date.now();
    const result = await instance.execute("press-key", { key: "f1" }, harness.execution());
    expect(result).toMatchObject({ status: "failure", category: "timeout" });
    expect(result.status === "failure" && result.message).toMatch(/didn't answer.*Nothing was sent/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("refuses a switched-off connection, a missing address, a blank row and unknown keys without sending", async () => {
    const { fake, port } = await monitor();
    const off = createModuleHarness(module, settings(port), { connectionEnabled: false });
    expect(await off.instance.execute("press-key", { key: "f1" }, off.execution())).toMatchObject({
      status: "failure",
      category: "unavailable",
    });
    const blank = createModuleHarness(module, { host: " ", port, whenInUse: "wait" });
    await blank.instance.start();
    expect(blank.states.at(-1)).toMatchObject({ phase: "error" });
    expect(await blank.instance.execute("press-key", { key: "f1" }, blank.execution())).toMatchObject({
      status: "failure",
      category: "invalid-config",
    });
    const harness = createModuleHarness(module, settings(port));
    for (const [id, fields] of [
      ["matrix", row("")],
      ["matrix", row("power")],
      ["matrix", { key: "f1" }],
      ["press-key", { key: "f9" }],
      ["unknown", { key: "f1" }],
    ] as const)
      expect(await harness.instance.execute(id, fields, harness.execution()), `${id} ${JSON.stringify(fields)}`).toMatchObject({
        status: "failure",
        category: "invalid-config",
      });
    expect(fake.events).toEqual([]);
  });

  it("doesn't send when the check for other apps fails", async () => {
    const { fake, port } = await monitor();
    const harness = createModuleHarness(module, settings(port));
    const instance = createInstance(harness.context, {
      listConnections: async () => {
        throw new Error("netstat missing");
      },
    });
    const result = await instance.execute("press-key", { key: "f2" }, harness.execution());
    expect(result).toMatchObject({ status: "failure", category: "unavailable" });
    expect(result.status === "failure" && result.message).toMatch(/Couldn't check whether another app is using the monitor/);
    expect(fake.events).toEqual([]);
  });

  it("cancels a key waiting behind another without sending it", async () => {
    const { fake, port } = await monitor("many");
    const harness = createModuleHarness(module, settings(port));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const instance = createInstance(harness.context, {
      listConnections: async () => {
        await held;
        return [];
      },
    });
    const first = instance.execute("press-key", { key: "f4" }, harness.execution());
    const controller = new AbortController();
    const second = instance.execute("press-key", { key: "f5" }, harness.execution(controller.signal));
    controller.abort();
    release();
    expect(await first).toMatchObject({ status: "success" });
    expect(await second).toMatchObject({ status: "failure", category: "cancelled" });
    expect(fake.keys).toEqual([0x34]);
  });

  it("publishes no feedback colour, since the monitor reports nothing back", async () => {
    const harness = createModuleHarness(module, settings(1));
    await harness.instance.subscribeFeedback?.([{ id: "key", fields: row("f1") }], {
      signal: new AbortController().signal,
    });
    expect(harness.feedback).toEqual([
      { id: "key", fields: row("f1"), state: "unavailable", observedAt: null },
    ]);
  });
});
