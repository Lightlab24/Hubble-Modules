import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext, ModuleJsonValue } from "@hubble/module-sdk";
import { TslPage, switcherTarget, type LiveReply, type PageSnapshot } from "../src/page.js";
import type { TslDiscoveredDisplay, TslReceiver } from "../src/receiver.js";
import { defaultSwitcherDocument, SWITCHER_DOCUMENT_ID, type SwitcherDocument } from "../src/setup.js";
import type { SwitcherReading } from "../src/switcher/index.js";
import { FakeSwitcher, FAKE_DRIVER, FAKE_OID } from "./fixtures/fake-switcher.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const display = (address: number, change: Partial<TslDiscoveredDisplay> = {}): TslDiscoveredDisplay => ({
  protocol: "5.0",
  screen: 0,
  address,
  label: `CAM ${address}`,
  flags: [false, false, false, false],
  left: 0,
  text: 0,
  right: 0,
  brightness: 1,
  sourceAddress: "10.20.20.41",
  sourcePort: 40000,
  lastSeen: 1_000 + address,
  sequence: address,
  fresh: true,
  ...change,
});

async function world(options: { settings?: Record<string, unknown>; runtimeDirectory?: string; fake?: FakeSwitcher } = {}) {
  const runtimeDirectory = options.runtimeDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "tsl-page-")));
  if (!options.runtimeDirectory) cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  let saved = { id: SWITCHER_DOCUMENT_ID, version: 1, revision: null as string | null, value: defaultSwitcherDocument() as SwitcherDocument };
  let writes = 0;
  const displays: TslDiscoveredDisplay[] = [];
  const logs: { level: string; stage: string; message: string }[] = [];
  const context = {
    scope: { kind: "connection", workspaceId: "w", connectionId: "c" },
    instanceId: "i",
    runtimeDirectory,
    settings: { name: "TSL Tally Main", protocol: "5.0", transport: "udp", bindAddress: "0.0.0.0", port: 9821, sourceAddress: "", staleAfterMs: 0, routingPeer: "", ...options.settings },
    services: {
      async request(_service: string, _version: number, input: { method: string; expectedRevision?: string | null; value?: SwitcherDocument }) {
        if (input.method === "write") {
          if (input.expectedRevision !== saved.revision) return { status: "conflict", document: saved };
          saved = { ...saved, revision: `rev-${++writes}`, value: structuredClone(input.value!) };
        }
        return { status: "document", document: saved };
      },
    },
    log: (trace: { level: string; stage: string; message: string }) => logs.push(trace),
    publishState: vi.fn(),
    publishFeedback: vi.fn(),
  } as unknown as ModuleContext;
  const receiver = {
    snapshot: () => ({ phase: "listening", error: null, invalidPackets: 0, displays: [...displays] }),
  } as unknown as TslReceiver;
  const page = new TslPage(context, () => receiver, async () => [{ id: "peer-1", label: "TALLY Switch" }], {
    localAddresses: () => [{ id: "127.0.0.1", label: "127.0.0.1 · this computer" }],
    routeAddress: async (host) => (host === "127.0.0.1" ? "127.0.0.1" : null),
  });
  cleanups.push(() => page.close());
  const call = <T>(commandId: string, value: unknown = null, signal = new AbortController().signal) =>
    page.call({ sectionId: "app", commandId, value } as ModuleJsonValue, signal) as Promise<T>;
  const setDocument = (change: Partial<SwitcherDocument>) => {
    saved = { ...saved, revision: `rev-${++writes}`, value: { ...saved.value, ...change } };
  };
  if (options.fake) setDocument({ host: `127.0.0.1:${options.fake.port}` });
  return { page, call, displays, logs, runtimeDirectory, setDocument, document: () => saved };
}
const fakeSwitcher = async (options: ConstructorParameters<typeof FakeSwitcher>[0] = {}) => {
  const fake = await FakeSwitcher.start({ chatter: false, ...options });
  cleanups.push(() => fake.stop());
  return fake;
};
type Contact = { reading: SwitcherReading | null; readAt: number | null; readError: string | null };

describe("the page's first read", () => {
  it("hands over this computer's settings, the saved switcher setup, the tab and the tally so far", async () => {
    const { call, displays } = await world({ settings: { protocol: "3.1", transport: "tcp", port: 5727 } });
    displays.push(display(2, { right: 1, text: 3, left: 2 }), display(1));
    const snapshot = await call<PageSnapshot>("snapshot");
    expect(snapshot).toMatchObject({
      name: "TSL Tally Main",
      tab: "tally",
      receiver: { protocol: "3.1", transport: "tcp", port: 5727, bindAddress: "0.0.0.0", sourceAddress: "", staleAfterMs: 0, routingPeer: "" },
      addresses: [{ id: "127.0.0.1" }],
      peers: [{ id: "peer-1", label: "TALLY Switch" }],
      switcher: { value: defaultSwitcherDocument(), revision: null },
      routeAddress: null,
      reading: null,
      readAt: null,
      readError: null,
    });
    expect(snapshot.live.full).toBe(true);
    expect(snapshot.live.rows).toEqual([
      { key: "0:2", screen: 0, address: 2, label: "CAM 2", lamps: [2, 3, 1], sender: "10.20.20.41", fresh: true },
      { key: "0:1", screen: 0, address: 1, label: "CAM 1", lamps: [0, 0, 0], sender: "10.20.20.41", fresh: true },
    ]);
    expect(snapshot.live.listener).toEqual({ phase: "listening", error: null, invalidPackets: 0, lastPacketAt: 1002, lastSender: "10.20.20.41" });
  });

  it("refuses a command the page did not declare, or one for another section", async () => {
    const { page, call } = await world();
    await expect(call("format-disk")).rejects.toThrow("Unknown page command");
    await expect(page.call({ sectionId: "other", commandId: "snapshot" }, new AbortController().signal)).rejects.toThrow();
  });
});

describe("live tally", () => {
  it("waits for a change, then sends only what changed, including what went away", async () => {
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const { page, call, displays } = await world();
    displays.push(display(1), display(2));
    const first = await call<LiveReply>("live", { after: 0 });
    expect(first.rows.map((row) => row.address)).toEqual([1, 2]);

    let settled: LiveReply | undefined;
    const waiting = call<LiveReply>("live", { after: first.version }).then((reply) => (settled = reply));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBeUndefined();

    // A burst of packets is one wake-up, not hundreds.
    displays[1] = display(2, { text: 1, right: 1 });
    displays.shift();
    for (let i = 0; i < 50; i++) page.changed();
    await vi.advanceTimersByTimeAsync(60);
    await waiting;
    expect(settled).toMatchObject({ full: false, removed: ["0:1"] });
    expect(settled?.rows).toEqual([expect.objectContaining({ key: "0:2", lamps: [0, 1, 1] })]);
    expect(settled?.version).toBeGreaterThan(first.version);

    // Nothing new: the wait ends by itself with an empty answer, so a lost page never holds it forever.
    const idle = call<LiveReply>("live", { after: settled!.version });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await idle).toMatchObject({ full: false, rows: [], removed: [], version: settled!.version });
  });

  it("stops waiting when the page goes away, and resends everything to a page that is behind", async () => {
    const { call, displays } = await world();
    displays.push(display(1));
    const first = await call<LiveReply>("live", { after: 0 });
    const gone = new AbortController();
    const waiting = call<LiveReply>("live", { after: first.version }, gone.signal);
    gone.abort();
    await expect(waiting).rejects.toThrow();
    expect(await call<LiveReply>("live", { after: first.version + 99 })).toMatchObject({ full: true, rows: [expect.objectContaining({ address: 1 })] });
  });

  it("shows a 3.1 address as four lamps and an address that went stale as stale", async () => {
    const { call, displays } = await world({ settings: { protocol: "3.1" } });
    displays.push(display(5, { protocol: "3.1", flags: [true, false, false, true], fresh: false, label: "  PGM  " }));
    expect((await call<LiveReply>("live", { after: 0 })).rows).toEqual([
      { key: "0:5", screen: 0, address: 5, label: "PGM", lamps: [1, 0, 0, 1], sender: "10.20.20.41", fresh: false },
    ]);
  });
});

describe("what stays on this computer", () => {
  it("comes back to the same tab and the last reading after the module restarts", async () => {
    const fake = await fakeSwitcher();
    const first = await world({ fake });
    await first.call("view", { tab: "setup" });
    const read = await first.call<Contact>("read-switcher");
    expect(read.reading?.devices.map((row) => row.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    await first.page.close();

    // Saving a setting restarts the module: a new page object over the same runtime folder.
    const second = await world({ runtimeDirectory: first.runtimeDirectory, fake });
    const snapshot = await second.call<PageSnapshot>("snapshot");
    expect(snapshot.tab).toBe("setup");
    expect(snapshot.reading?.devices.map((row) => row.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    expect(snapshot.readAt).toBe(read.readAt);
    expect(snapshot.routeAddress).toBe("127.0.0.1");

    // A reading belongs to the address it came from.
    second.setDocument({ host: "10.99.99.99" });
    expect(await second.call<PageSnapshot>("snapshot")).toMatchObject({ reading: null, readAt: null, readError: null });
  });

  it("saves the switcher setup with the workspace, and reports a save that lost a race", async () => {
    const { call, document } = await world();
    const value = { ...defaultSwitcherDocument(), host: "10.20.20.41", fsfc: true };
    expect(await call("save-switcher", { value, revision: null })).toEqual({ status: "saved", value, revision: "rev-1" });
    expect(document().value).toEqual(value);
    expect(await call("save-switcher", { value: { ...value, center: true }, revision: null })).toEqual({ status: "conflict", value, revision: "rev-1" });
    await expect(call("save-switcher", { value: { ...value, name: "TOO LONG NAME" }, revision: "rev-1" })).rejects.toThrow();
    expect(document().value).toEqual(value);
  });
});

describe("the switcher", () => {
  it("is read only when asked, and a failed read says so without keeping the old reading", async () => {
    const fake = await fakeSwitcher();
    const { call, logs } = await world({ fake });
    expect(fake.requests).toHaveLength(0);
    await call("snapshot");
    expect(fake.requests).toHaveLength(0);
    const read = await call<Contact>("read-switcher");
    expect(read).toMatchObject({ readError: null, reading: { product: "Carbonite Ultra", mine: null, formBusy: false } });
    expect(fake.formIsIdle).toBe(true);

    await fake.stop();
    await expect(call("read-switcher")).rejects.toThrow();
    expect(await call<PageSnapshot>("snapshot")).toMatchObject({ reading: null, readError: expect.any(String) });
    expect(logs.filter((log) => log.stage === "read-switcher").map((log) => log.level)).toEqual(["info", "error"]);
  });

  it("gets a device for this computer that sends what this computer listens for", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake, settings: { protocol: "5.0", transport: "udp", port: 9821 } });
    setDocument({ fsfc: true, brightness: 3, offset: 10000, screen: 7 });
    const sent = await call<Contact>("send-switcher", {});
    expect(sent.reading?.mine).toMatchObject({
      slot: 3,
      name: "HUBBLE",
      ip: "127.0.0.1",
      port: 9821,
      settings: { protocol: "5.0", transport: "udp", port: 9821, ip: "127.0.0.1", fsfc: true, brightness: 3, offset: 10000, screen: 7, enabled: true },
    });
    expect(fake.devices).toHaveLength(4);
    expect(fake.devices[3]).toMatchObject({ slot: 3, name: "HUBBLE", ip: "127.0.0.1", port: 9821, transport: 1, driverKey: FAKE_DRIVER.tsl5, fsfc: 1, brightness: 3, offsetKey: 1, screen: 7 });
    // The switcher's other devices are exactly as they were.
    expect(fake.devices.slice(0, 3).map((device) => [device.name, device.ip, device.port, device.enabled])).toEqual([
      ["CP", "192.168.1.204", 7788, false],
      ["ADAM", "10.20.100.236", 5727, true],
      ["RTR TALL", "10.20.50.50", 4490, true],
    ]);
    expect(fake.formIsIdle).toBe(true);
    expect(fake.openConnections).toBe(0);

    // Deleting removes that device and nothing else.
    const deleted = await call<Contact>("delete-switcher");
    expect(deleted.reading?.mine).toBeNull();
    expect(fake.devices.map((device) => device.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    expect(fake.formIsIdle).toBe(true);
  });

  it("sends what the page shows for this computer, even before Hubble has saved it", async () => {
    const fake = await fakeSwitcher();
    // The module still runs on TSL 5.0 over TCP; the page has just been changed to 3.1 over UDP.
    const { call } = await world({ fake, settings: { protocol: "5.0", transport: "tcp", port: 9821 } });
    const sent = await call<Contact>("send-switcher", { receiver: { protocol: "3.1", transport: "udp", port: 9900 } });
    expect(sent.reading?.mine?.settings).toMatchObject({ protocol: "3.1", transport: "udp", port: 9900 });
    expect(fake.devices[3]).toMatchObject({ name: "HUBBLE", port: 9900, transport: 1, driverKey: FAKE_DRIVER.tsl31 });
    // Anything else in its place is refused before the switcher is contacted.
    const before = fake.requests.length;
    await expect(call("send-switcher", { receiver: { protocol: "4.0", transport: "udp", port: 9900 } })).rejects.toThrow();
    await expect(call("send-switcher", { receiver: { protocol: "3.1", transport: "udp", port: 0 } })).rejects.toThrow();
    expect(fake.requests).toHaveLength(before);
  });

  it("never repoints a device that sends somewhere else without being told to", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake, settings: { protocol: "3.1", transport: "tcp", port: 5727 } });
    setDocument({ name: "ADAM" });
    await expect(call("send-switcher", {})).rejects.toThrow("ADAM on the switcher sends to 10.20.100.236. Confirm before changing it");
    expect(fake.devices[1]).toMatchObject({ name: "ADAM", ip: "10.20.100.236", port: 5727 });
    expect(fake.writes.filter((write) => write.oid === FAKE_OID.changes || write.oid === FAKE_OID.ip)).toEqual([]);

    const sent = await call<Contact>("send-switcher", { adopt: true });
    expect(sent.reading?.mine).toMatchObject({ slot: 1, name: "ADAM", ip: "127.0.0.1", port: 5727 });
    expect(fake.devices).toHaveLength(3);
  });

  it("will not send to an address that isn't this computer's, or to nowhere", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake });
    setDocument({ sendTo: "10.20.100.236" });
    await expect(call("send-switcher", {})).rejects.toThrow("10.20.100.236 isn't one of this computer's addresses");
    setDocument({ sendTo: "", host: "" });
    await expect(call("send-switcher", {})).rejects.toThrow("Choose which of this computer's addresses the switcher should send to");
    await expect(call("read-switcher")).rejects.toThrow("Enter the switcher's address first");
    expect(fake.writes).toEqual([]);
  });

  it("takes one request at a time", async () => {
    const fake = await fakeSwitcher();
    const { call } = await world({ fake });
    fake.hold();
    const first = call<Contact>("read-switcher");
    await vi.waitFor(() => expect(fake.openConnections).toBe(1));
    await expect(call("send-switcher", {})).rejects.toThrow("Still working on the last switcher request");
    fake.release();
    expect((await first).reading?.devices).toHaveLength(3);
    expect(fake.devices).toHaveLength(3);
  });

  it("reads an address with or without a port", () => {
    expect(switcherTarget("10.20.20.41")).toEqual({ host: "10.20.20.41" });
    expect(switcherTarget(" 10.20.20.41:5253 ")).toEqual({ host: "10.20.20.41", port: 5253 });
    expect(switcherTarget("switcher.local:70000")).toEqual({ host: "switcher.local:70000" });
    expect(switcherTarget("fe80::1")).toEqual({ host: "fe80::1" });
  });
});
