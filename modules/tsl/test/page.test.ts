import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext, ModuleJsonValue } from "@hubble/module-sdk";
import { TslPage, switcherTarget, type LiveReply, type PageSnapshot, type SharedReply } from "../src/page.js";
import type { TslDiscoveredDisplay, TslReceiver } from "../src/receiver.js";
import { defaultSwitcherDocument, SWITCHER_DOCUMENT_ID, type SwitcherDocument } from "../src/setup.js";
import { TslRouting } from "../src/routing.js";
import type { SwitcherReading } from "../src/switcher/index.js";
import { FakeSwitcher, FAKE_DRIVER, FAKE_OID, realDevices as realDevicesForPage } from "./fixtures/fake-switcher.js";

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
  const routing = new TslRouting(context, () => null, () => page.changed());
  cleanups.push(() => routing.close());
  const page = new TslPage(context, () => receiver, async () => [{ id: "peer-1", label: "TALLY Switch" }], routing, {
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

  it("gives a page that kept its place from the last run everything at once", async () => {
    // The module restarted under an open page. Both runs have counted the same number of changes.
    const before = await world();
    const after = await world();
    before.displays.push(display(1));
    after.displays.push(display(1), display(2));
    const kept = await before.call<LiveReply>("live", { after: 0 });
    const fresh = await after.call<LiveReply>("live", { after: 0 });
    expect(kept.version).toBe(fresh.version);
    expect(kept.run).not.toBe(fresh.run);
    // Asked with the old run's place, the new run answers now, not after a wait for a change.
    const answer = await after.call<LiveReply>("live", { after: kept.version, run: kept.run });
    expect(answer).toMatchObject({ full: true, run: fresh.run });
    expect(answer.rows.map((row) => row.address)).toEqual([1, 2]);
    // With its own place it waits, as before.
    const gone = new AbortController();
    const waiting = after.call<LiveReply>("live", { after: answer.version, run: answer.run }, gone.signal);
    let settled = false;
    void waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    gone.abort();
    await expect(waiting).rejects.toThrow();
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

  it("saves the switcher setup with the workspace, only the fields a page changed, onto what is saved now", async () => {
    const { call, document, setDocument } = await world();
    const value = { ...defaultSwitcherDocument(), host: "10.20.20.41", fsfc: true };
    expect(await call("save-switcher", { change: { host: "10.20.20.41", fsfc: true } })).toEqual({ status: "saved", value, revision: "rev-1", kept: [] });
    expect(document().value).toEqual(value);
    // Another window saved since: this page's field goes on top of it, and neither undoes the other.
    setDocument({ name: "CAM1" });
    expect(await call("save-switcher", { change: { center: true } })).toEqual({
      status: "saved",
      value: { ...value, name: "CAM1", center: true },
      revision: "rev-3",
      kept: [],
    });
    // The same change again writes nothing.
    expect(await call("save-switcher", { change: { center: true } })).toMatchObject({ revision: "rev-3" });
    // A field the page changed by itself lands only where the setup still has what it started from.
    expect(await call("save-switcher", { change: { name: "ADAM", device: "ADAM" }, expected: { name: "HUBBLE", device: "" } })).toMatchObject({
      value: { name: "CAM1", device: "ADAM" },
      kept: ["name"],
    });
    // A value the switcher can't hold, or a field the setup doesn't have, is refused and nothing is saved.
    await expect(call("save-switcher", { change: { name: "TOO LONG NAME" } })).rejects.toThrow();
    await expect(call("save-switcher", { change: { colour: "red" } })).rejects.toThrow();
    expect(document()).toMatchObject({ revision: "rev-4", value: { ...value, name: "CAM1", center: true, device: "ADAM" } });
  });

  it("tells every open page where the saved setup and the last reading stand, and hands them over", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake });
    const first = await call<PageSnapshot>("snapshot");
    expect(first.live.setup).toEqual({ revision: "rev-1", reading: first.stamp, busy: false });
    // Another window reads the switcher: the next live answer says so at once, with a new stamp.
    const waiting = call<LiveReply>("live", { after: first.live.version, run: first.live.run });
    await call<Contact>("read-switcher");
    const told = await waiting;
    expect(told.setup.reading).not.toBe(first.stamp);
    const shared = await call<SharedReply>("saved");
    expect(shared).toMatchObject({ switcher: { revision: "rev-1" }, stamp: told.setup.reading, reading: { product: "Carbonite Ultra" } });
    expect(shared).not.toHaveProperty("routing");
    expect(await call<SharedReply>("saved", { routing: true })).toHaveProperty("routing.rows", []);
    // A change saved outside the module, such as an import, is noticed within a couple of seconds.
    setDocument({ center: true });
    let latest = await call<LiveReply>("live", { after: told.version, run: told.run });
    for (let wait = 0; latest.setup.revision !== "rev-2" && wait < 6; wait++)
      latest = await call<LiveReply>("live", { after: latest.version, run: latest.run });
    expect(latest.setup.revision).toBe("rev-2");
  }, 15_000);
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

  it("edits a picked device with the version, transport and port the page gives it", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake, settings: { protocol: "5.0", transport: "udp", port: 9821 } });
    setDocument({ device: "ADAM", name: "ADAM", sendTo: "127.0.0.1", protocol: "3.1", transport: "udp", port: 6000 });
    const sent = await call<Contact>("send-switcher", { adopt: true, receiver: { protocol: "5.0", transport: "tcp", port: 9821 } });
    expect(sent.reading?.mine).toMatchObject({ slot: 1, name: "ADAM", ip: "127.0.0.1", port: 6000, settings: { protocol: "3.1", transport: "udp" } });
    expect(fake.devices).toHaveLength(3);
  });

  it("changes a device that feeds something else and keeps it sending there, once told to", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake });
    setDocument({ device: "RTR TALL", name: "RTR TALL", sendTo: "10.20.50.50", protocol: "3.1", transport: "udp", port: 4490, center: true });
    await expect(call("send-switcher", {})).rejects.toThrow("RTR TALL on the switcher sends to 10.20.50.50. Confirm before changing it");
    expect(fake.devices[2]).toMatchObject({ center: 0 });
    const sent = await call<Contact>("send-switcher", { adopt: true });
    expect(sent.reading?.mine).toMatchObject({ slot: 2, name: "RTR TALL", ip: "10.20.50.50", port: 4490, settings: { center: true } });
    expect(fake.devices[2]).toMatchObject({ ip: "10.20.50.50", port: 4490, center: 1 });
    expect(fake.devices.slice(0, 2)).toEqual(realDevicesForPage().slice(0, 2));
    // Only where it already sends: any other address that isn't this computer's is refused after
    // reading the device and before changing anything.
    const before = fake.writes.length;
    setDocument({ sendTo: "10.20.50.51" });
    await expect(call("send-switcher", { adopt: true })).rejects.toThrow("10.20.50.51 isn't one of this computer's addresses");
    expect(fake.writes.slice(before).map((write) => write.oid)).toEqual([FAKE_OID.selectedRow, FAKE_OID.selectedRow]);
    expect(fake.devices[2]).toMatchObject({ ip: "10.20.50.50" });
  });

  it("renames a picked device in place and still finds it before the page records the name", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake });
    setDocument({ device: "ADAM", name: "CAM 1", sendTo: "127.0.0.1", protocol: "3.1", transport: "tcp", port: 5727 });
    const sent = await call<Contact>("send-switcher", { adopt: true });
    expect(sent.reading?.mine).toMatchObject({ slot: 1, name: "CAM 1" });
    expect(fake.devices.map((device) => device.name)).toEqual(["CP", "CAM 1", "RTR TALL"]);
    expect((await call<Contact>("read-switcher")).reading?.mine).toMatchObject({ slot: 1, name: "CAM 1", settings: { ip: "127.0.0.1" } });
    // Deleting it works the same way.
    expect((await call<Contact>("delete-switcher")).reading?.mine).toBeNull();
    expect(fake.devices.map((device) => device.name)).toEqual(["CP", "RTR TALL"]);
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

  it("lets go of the switcher's form when the module stops in the middle of a request", async () => {
    const fake = await fakeSwitcher();
    const { call, page } = await world({ fake });
    const stop = new AbortController();
    let closed: Promise<void> | undefined;
    // Hubble restarts the module once the new device's form is open and being filled in, and the
    // switcher is slow to answer what comes next.
    fake.onWrite = (write) => {
      if (write.oid !== FAKE_OID.slot) return;
      fake.onWrite = undefined;
      fake.hold();
      stop.abort();
      closed = page.close();
    };
    const sending = call("send-switcher", {}, stop.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(closed).toBeDefined());
    let stopped = false;
    void closed!.then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The module has not finished stopping: the edit is still open on the switcher.
    expect(stopped).toBe(false);
    expect(fake.formIsIdle).toBe(false);
    fake.release();
    await closed;
    // By the time it has stopped, the edit is cancelled and no row is chosen.
    expect(fake.formIsIdle).toBe(true);
    expect(fake.devices.map((device) => device.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    expect(await sending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fake.openConnections).toBe(0));
  });

  it("takes one request at a time: another window's waits its turn and sends what is saved then", async () => {
    const fake = await fakeSwitcher();
    const { call, setDocument } = await world({ fake });
    fake.hold();
    const first = call<Contact>("read-switcher");
    await vi.waitFor(() => expect(fake.openConnections).toBe(1));
    // Every open page hears that the switcher is busy.
    expect((await call<LiveReply>("live", { after: 0 })).setup.busy).toBe(true);
    let sent = false;
    const second = call<Contact>("send-switcher", {}).then((reply) => {
      sent = true;
      return reply;
    });
    // Saved while the second request waits: it is sent with the setup as saved when its turn comes.
    setDocument({ center: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toBe(false);
    expect(fake.openConnections).toBe(1);
    fake.release();
    expect((await first).reading?.devices).toHaveLength(3);
    expect((await second).reading?.mine).toMatchObject({ name: "HUBBLE", settings: { center: true } });
    expect(fake.devices).toHaveLength(4);
    expect(fake.formIsIdle).toBe(true);
  });

  it("lets a waiting request go when its page does, without holding up the next", async () => {
    const fake = await fakeSwitcher();
    const { call } = await world({ fake });
    fake.hold();
    const first = call<Contact>("read-switcher");
    await vi.waitFor(() => expect(fake.openConnections).toBe(1));
    const gone = new AbortController();
    const abandoned = call("delete-switcher", {}, gone.signal).catch((error: unknown) => error);
    gone.abort();
    expect(await abandoned).toBeInstanceOf(Error);
    const third = call<Contact>("read-switcher");
    fake.release();
    await first;
    expect((await third).reading?.devices).toHaveLength(3);
    // Deleting never ran.
    expect(fake.devices.map((device) => device.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
  });

  it("reads an address with or without a port", () => {
    expect(switcherTarget("10.20.20.41")).toEqual({ host: "10.20.20.41" });
    expect(switcherTarget(" 10.20.20.41:5253 ")).toEqual({ host: "10.20.20.41", port: 5253 });
    expect(switcherTarget("switcher.local:70000")).toEqual({ host: "switcher.local:70000" });
    expect(switcherTarget("fe80::1")).toEqual({ host: "fe80::1" });
  });
});
