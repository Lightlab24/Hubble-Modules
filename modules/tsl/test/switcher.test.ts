import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteDevice,
  readSwitcher,
  sendDevice,
  SWITCHER_OID,
  SWITCHER_WRITABLE_OIDS,
  SwitcherError,
  type SwitcherDeviceSettings,
  type SwitcherTarget,
} from "../src/switcher/index.js";
import {
  cstring,
  int32,
  OgpBinaryClient,
  OgpError,
  readInt,
  readString,
  readStrings,
  type OgpSocket,
} from "../src/switcher/ogp-binary.js";
import {
  FAKE_DRIVER,
  FAKE_OID,
  FakeSwitcher,
  fakeTslDevice,
  realDevices,
  type FakeSwitcherOptions,
  type FakeWrite,
} from "./fixtures/fake-switcher.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function start(options: FakeSwitcherOptions = {}): Promise<FakeSwitcher> {
  const fake = await FakeSwitcher.start(options);
  cleanup.push(() => fake.stop());
  return fake;
}
const at = (fake: FakeSwitcher, extra: Partial<SwitcherTarget> = {}): SwitcherTarget => ({
  host: "127.0.0.1",
  port: fake.port,
  timeoutMs: 1000,
  ...extra,
});
const w = (oid: number, value: number | string): FakeWrite => ({ oid, value });
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const HUBBLE: SwitcherDeviceSettings = {
  name: "HUBBLE",
  ip: "10.20.100.235",
  port: 9821,
  protocol: "5.0",
  transport: "udp",
  enabled: true,
  screen: 0,
  offset: 0,
  brightness: 1,
  center: false,
  fsfc: true,
  busName: false,
  umdId: false,
  oneSecond: false,
  header: false,
};
/** HUBBLE as the fake keeps it once saved. */
const hubbleDevice = () => ({
  ...fakeTslDevice(3, "HUBBLE", "10.20.100.235", 9821, true, 1, FAKE_DRIVER.tsl5),
  fsfc: 1,
});
const withHubble = () => [...realDevices(), hubbleDevice()];

/** The writes seen on a real Carbonite Ultra when a TSL 5 device was added, then its options. */
const ADD_HUBBLE: FakeWrite[] = [
  w(FAKE_OID.addDevice, 0),
  w(FAKE_OID.slot, 3),
  w(FAKE_OID.type, 11),
  w(FAKE_OID.driver, FAKE_DRIVER.tsl5),
  w(FAKE_OID.ip, "10.20.100.235"),
  w(FAKE_OID.name, "HUBBLE"),
  w(FAKE_OID.port, 9821),
  w(FAKE_OID.transport, 1),
  w(FAKE_OID.center, 0),
  w(FAKE_OID.fsfcLabel, 1),
  w(FAKE_OID.showBusName, 0),
  w(FAKE_OID.showUmdId, 0),
  w(FAKE_OID.oneSecondUpdate, 0),
  w(FAKE_OID.tslHeader, 0),
  w(FAKE_OID.tslBrightness, 1),
  w(FAKE_OID.tslScreen, 0),
  w(FAKE_OID.tslAddressOffset, 0),
  w(FAKE_OID.changes, 1),
  w(FAKE_OID.selectedRow, 0),
];

describe("reading a Carbonite's devices", () => {
  it("lists every device, finds none of its own and writes nothing", async () => {
    const fake = await start();
    const reading = await readSwitcher({ ...at(fake), deviceName: "HUBBLE" });
    expect(reading).toEqual({
      product: "Carbonite Ultra",
      software: "9.2.1.18190",
      formBusy: false,
      mine: null,
      devices: [
        { row: 1, slot: 0, type: "TSL UMD", driver: "TSL 3.1", name: "CP", ip: "192.168.1.204", port: 7788, enabled: false },
        { row: 2, slot: 1, type: "TSL UMD", driver: "TSL 3.1", name: "ADAM", ip: "10.20.100.236", port: 5727, enabled: true },
        { row: 3, slot: 2, type: "TSL UMD", driver: "TSL 3.1", name: "RTR TALL", ip: "10.20.50.50", port: 4490, enabled: true },
      ],
    });
    expect(fake.writes).toEqual([]);
    await pause();
    expect(fake.openConnections).toBe(0);
  });

  it("reads its own device by choosing its row, then chooses none again", async () => {
    const fake = await start({ devices: withHubble() });
    const reading = await readSwitcher({ ...at(fake), deviceName: "HUBBLE" });
    expect(reading.mine).toEqual({
      row: 4,
      slot: 3,
      type: "TSL UMD",
      driver: "TSL 5",
      name: "HUBBLE",
      ip: "10.20.100.235",
      port: 9821,
      enabled: true,
      // Transport comes back with a length byte of 1 and four bytes, as on the real switcher.
      settings: HUBBLE,
    });
    expect(fake.writes).toEqual([w(FAKE_OID.selectedRow, 4), w(FAKE_OID.selectedRow, 0)]);
    expect(fake.formIsIdle).toBe(true);
  });

  it("never chooses a row while someone has the form open", async () => {
    const fake = await start({ devices: withHubble(), busyForm: true });
    const reading = await readSwitcher({ ...at(fake), deviceName: "HUBBLE" });
    expect(reading.formBusy).toBe(true);
    expect(reading.devices).toHaveLength(4);
    expect(reading.mine).toMatchObject({ name: "HUBBLE", slot: 3, settings: null });
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(
      "Someone is editing devices on the switcher",
    );
    await expect(deleteDevice({ ...at(fake), deviceName: "HUBBLE" })).rejects.toThrow(
      "Someone is editing devices on the switcher",
    );
    expect(fake.writes).toEqual([]);
    expect(fake.devices).toEqual(withHubble());
  });

  it("fails on two devices with the same name and changes nothing", async () => {
    const twin = fakeTslDevice(4, "HUBBLE", "10.0.0.9", 5727, true, 0);
    const fake = await start({ devices: [...withHubble(), twin] });
    const message = "Two devices on the switcher are named HUBBLE";
    await expect(readSwitcher({ ...at(fake), deviceName: "HUBBLE" })).rejects.toThrow(message);
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(message);
    await expect(deleteDevice({ ...at(fake), deviceName: "HUBBLE" })).rejects.toThrow(message);
    expect(fake.writes).toEqual([]);
  });

  it("leaves alone a device with its name that isn't TSL UMD", async () => {
    const rossTalk = { ...fakeTslDevice(3, "HUBBLE", "10.0.0.9", 7788, true, 0), type: 10, driverKey: FAKE_DRIVER.rossTalk };
    const fake = await start({ devices: [...realDevices(), rossTalk] });
    const reading = await readSwitcher({ ...at(fake), deviceName: "HUBBLE" });
    expect(reading.mine).toMatchObject({ type: "RossTalk", settings: null });
    const message = "HUBBLE on the switcher is a RossTalk device, not TSL UMD";
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(message);
    await expect(deleteDevice({ ...at(fake), deviceName: "HUBBLE" })).rejects.toThrow(message);
    expect(fake.writes).toEqual([]);
  });

  it("says so when the address isn't a Carbonite", async () => {
    const fake = await start({ noDeviceList: true });
    await expect(readSwitcher({ ...at(fake), deviceName: "HUBBLE" })).rejects.toThrow(
      "doesn't have the device list",
    );
  });

  it("says so when the switcher refuses the connection", async () => {
    const fake = await start({ refuseHandshake: true });
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(
      "The switcher refused the connection",
    );
    expect(fake.writes).toEqual([]);
    await pause();
    expect(fake.openConnections).toBe(0);
  });

  it("checks names and addresses before connecting", async () => {
    const fake = await start();
    const bad = (settings: Partial<SwitcherDeviceSettings>) =>
      sendDevice({ ...at(fake), settings: { ...HUBBLE, ...settings } });
    await expect(bad({ name: "NINECHARS" })).rejects.toThrow(SwitcherError);
    await expect(bad({ name: " PAD" })).rejects.toThrow(SwitcherError);
    await expect(bad({ ip: "0.0.0.0" })).rejects.toThrow("Send to needs");
    await expect(bad({ ip: "10.20.300.1" })).rejects.toThrow("Send to needs");
    await expect(bad({ port: 0 })).rejects.toThrow("Port is a number");
    await expect(bad({ offset: 15000 })).rejects.toThrow("Address offset");
    await expect(bad({ screen: 65535 })).rejects.toThrow("Screen is a number");
    await expect(readSwitcher({ ...at(fake), deviceName: "" })).rejects.toThrow(SwitcherError);
    await expect(readSwitcher({ ...at(fake), host: "", deviceName: "HUBBLE" })).rejects.toThrow(
      "Enter the switcher's host name or IP address",
    );
    expect(fake.requests).toEqual([]);
  });
});

describe("sending this computer's device", () => {
  it("adds it in the free slot, in the order seen on a real switcher, and touches nothing else", async () => {
    const fake = await start();
    const reading = await sendDevice({ ...at(fake), settings: HUBBLE });
    expect(fake.writes).toEqual(ADD_HUBBLE);
    expect(fake.devices).toEqual(withHubble());
    expect(fake.formIsIdle).toBe(true);
    expect(reading.devices).toHaveLength(4);
    expect(reading.mine).toMatchObject({ row: 4, slot: 3, driver: "TSL 5", enabled: true, settings: HUBBLE });
    await pause();
    expect(fake.openConnections).toBe(0);
  });

  it("uses the first free slot when one in the middle is empty", async () => {
    const fake = await start({ devices: [realDevices()[0]!, realDevices()[2]!] });
    await sendDevice({ ...at(fake), settings: HUBBLE });
    expect(fake.writes[1]).toEqual(w(FAKE_OID.slot, 1));
    expect(fake.devices.map((device) => [device.slot, device.name])).toEqual([
      [0, "CP"],
      [2, "RTR TALL"],
      [1, "HUBBLE"],
    ]);
  });

  it("writes nothing but the row choice when the switcher already matches", async () => {
    const fake = await start({ devices: withHubble() });
    const reading = await sendDevice({ ...at(fake), settings: HUBBLE });
    expect(fake.writes).toEqual([w(FAKE_OID.selectedRow, 4), w(FAKE_OID.selectedRow, 0)]);
    expect(reading.mine?.settings).toEqual(HUBBLE);
    expect(fake.devices).toEqual(withHubble());
  });

  it("changes only the fields that differ on its own device", async () => {
    const fake = await start({ devices: withHubble() });
    const wanted: SwitcherDeviceSettings = {
      ...HUBBLE,
      port: 9900,
      transport: "tcp",
      oneSecond: true,
      brightness: 3,
      screen: 7,
      offset: 20000,
    };
    const reading = await sendDevice({ ...at(fake), settings: wanted });
    expect(fake.writes).toEqual([
      w(FAKE_OID.selectedRow, 4),
      w(FAKE_OID.port, 9900),
      w(FAKE_OID.transport, 0),
      w(FAKE_OID.oneSecondUpdate, 1),
      w(FAKE_OID.tslBrightness, 3),
      w(FAKE_OID.tslScreen, 7),
      w(FAKE_OID.tslAddressOffset, 2),
      w(FAKE_OID.changes, 1),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(reading.mine?.settings).toEqual(wanted);
    expect(fake.devices.slice(0, 3)).toEqual(realDevices());
    expect(fake.devices[3]).toMatchObject({ port: 9900, transport: 0, oneSecond: 1, brightness: 3, screen: 7, offsetKey: 2 });
    expect(fake.formIsIdle).toBe(true);
  });

  it("changes TSL version with the driver number the switcher gives, and leaves TSL 5 options out of TSL 3.1", async () => {
    const fake = await start({ devices: withHubble() });
    const wanted: SwitcherDeviceSettings = { ...HUBBLE, protocol: "3.1", transport: "tcp", port: 5727 };
    const reading = await sendDevice({ ...at(fake), settings: wanted });
    expect(fake.writes).toEqual([
      w(FAKE_OID.selectedRow, 4),
      w(FAKE_OID.driver, FAKE_DRIVER.tsl31),
      w(FAKE_OID.ip, "10.20.100.235"),
      w(FAKE_OID.name, "HUBBLE"),
      w(FAKE_OID.port, 5727),
      w(FAKE_OID.transport, 0),
      w(FAKE_OID.center, 0),
      w(FAKE_OID.fsfcLabel, 1),
      w(FAKE_OID.showBusName, 0),
      w(FAKE_OID.showUmdId, 0),
      w(FAKE_OID.oneSecondUpdate, 0),
      w(FAKE_OID.changes, 1),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(reading.mine).toMatchObject({ driver: "TSL 3.1", port: 5727 });
    expect(reading.mine?.settings).toMatchObject({ protocol: "3.1", transport: "tcp" });
    expect(fake.devices[3]?.driverKey).toBe(FAKE_DRIVER.tsl31);
  });

  it("adds a TSL 3.1 device without the TSL 5 options", async () => {
    const fake = await start();
    await sendDevice({ ...at(fake), settings: { ...HUBBLE, protocol: "3.1", transport: "tcp", port: 5727 } });
    const written = fake.writes.map((write) => write.oid);
    expect(written).toContain(FAKE_OID.oneSecondUpdate);
    for (const oid of [FAKE_OID.tslHeader, FAKE_OID.tslBrightness, FAKE_OID.tslScreen, FAKE_OID.tslAddressOffset])
      expect(written).not.toContain(oid);
    expect(fake.writes[3]).toEqual(w(FAKE_OID.driver, FAKE_DRIVER.tsl31));
    expect(fake.devices[3]).toMatchObject({ driverKey: FAKE_DRIVER.tsl31, port: 5727, transport: 0 });
  });

  it("waits out a list the switcher is still filling in after a save or a delete", async () => {
    // Seen on the real switcher: the list's columns disagree for a moment after a change.
    const fake = await start({ listSettlesAfterMs: 700 });
    const added = await sendDevice({ ...at(fake), settings: HUBBLE });
    expect(added.mine).toMatchObject({ slot: 3, name: "HUBBLE" });
    expect(fake.devices).toEqual(withHubble());
    const gone = await deleteDevice({ ...at(fake), deviceName: "HUBBLE" });
    expect(gone.mine).toBeNull();
    expect(gone.devices.map((row) => row.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    expect(fake.formIsIdle).toBe(true);
  });

  it("turns its device off and on without touching its settings", async () => {
    const fake = await start();
    const off = await sendDevice({ ...at(fake), settings: { ...HUBBLE, enabled: false } });
    expect(fake.writes.slice(-3)).toEqual([
      w(FAKE_OID.changes, 1),
      w(FAKE_OID.enableDisable, 3),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(off.mine).toMatchObject({ enabled: false, settings: { ...HUBBLE, enabled: false } });
    expect(fake.devices[3]?.enabled).toBe(false);
    fake.writes.length = 0;
    const on = await sendDevice({ ...at(fake), settings: HUBBLE });
    expect(fake.writes).toEqual([
      w(FAKE_OID.selectedRow, 4),
      w(FAKE_OID.enableDisable, 2),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(on.mine?.enabled).toBe(true);
    expect(fake.devices).toEqual(withHubble());
  });

  it("cancels the form when a field doesn't read back", async () => {
    const fake = await start({ forgetWritesTo: FAKE_OID.port });
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(
      "The switcher didn't accept Port, so nothing was saved",
    );
    expect(fake.writes.slice(-3)).toEqual([
      w(FAKE_OID.port, 9821),
      w(FAKE_OID.changes, 0),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(fake.writes.map((write) => write.oid)).not.toContain(FAKE_OID.transport);
    expect(fake.devices).toEqual(realDevices());
    expect(fake.formIsIdle).toBe(true);
  });

  it("reports a save the switcher didn't keep, and cancels", async () => {
    const fake = await start({ dropSave: true });
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(
      "The switcher didn't keep the change",
    );
    expect(fake.writes.slice(-3)).toEqual([
      w(FAKE_OID.changes, 1),
      w(FAKE_OID.changes, 0),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(fake.devices).toEqual(realDevices());
    expect(fake.formIsIdle).toBe(true);
  });

  it("stops and says which device when another one changed during the save", async () => {
    const fake = await start({ spoilAnotherOnSave: true });
    await expect(sendDevice({ ...at(fake), settings: HUBBLE })).rejects.toThrow(
      "Another device on the switcher changed (slot 1, ADAM)",
    );
    expect(fake.formIsIdle).toBe(true);
  });
});

describe("editing a device the switcher already has", () => {
  const adamAsRead = async (fake: FakeSwitcher) => {
    const read = await readSwitcher({ ...at(fake), deviceName: "ADAM" });
    fake.writes.length = 0;
    return read.mine!.settings!;
  };

  it("changes only what differs on the device it was pointed at, in its own slot", async () => {
    const fake = await start();
    const adam = await adamAsRead(fake);
    expect(adam).toMatchObject({ name: "ADAM", ip: "10.20.100.236", port: 5727, protocol: "3.1", transport: "tcp", enabled: true });
    const reading = await sendDevice({ ...at(fake), deviceName: "ADAM", settings: { ...adam, ip: "10.20.100.235", center: true } });
    expect(fake.writes).toEqual([
      w(FAKE_OID.selectedRow, 2),
      w(FAKE_OID.ip, "10.20.100.235"),
      w(FAKE_OID.center, 1),
      w(FAKE_OID.changes, 1),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(reading.mine).toMatchObject({ slot: 1, name: "ADAM", ip: "10.20.100.235", settings: { center: true } });
    const [cp, , router] = realDevices();
    expect(fake.devices).toEqual([cp, { ...realDevices()[1], ip: "10.20.100.235", center: 1 }, router]);
    expect(fake.formIsIdle).toBe(true);
  });

  it("renames it in place rather than adding another", async () => {
    const fake = await start();
    const adam = await adamAsRead(fake);
    const reading = await sendDevice({ ...at(fake), deviceName: "ADAM", settings: { ...adam, name: "CAM 1" } });
    expect(fake.writes).toEqual([w(FAKE_OID.selectedRow, 2), w(FAKE_OID.name, "CAM 1"), w(FAKE_OID.changes, 1), w(FAKE_OID.selectedRow, 0)]);
    expect(fake.devices.map((device) => [device.slot, device.name])).toEqual([[0, "CP"], [1, "CAM 1"], [2, "RTR TALL"]]);
    expect(reading.mine).toMatchObject({ slot: 1, name: "CAM 1" });
    // Until the page records the new name it still asks for ADAM, and finds the device by the name it gave it.
    expect((await readSwitcher({ ...at(fake), deviceName: "ADAM", otherName: "CAM 1" })).mine).toMatchObject({ slot: 1, name: "CAM 1" });
    expect((await readSwitcher({ ...at(fake), deviceName: "ADAM" })).mine).toBeNull();
  });

  it("won't give it a name another device has, and writes nothing", async () => {
    const fake = await start();
    const adam = await adamAsRead(fake);
    await expect(sendDevice({ ...at(fake), deviceName: "ADAM", settings: { ...adam, name: "RTR TALL" } })).rejects.toThrow(
      "Another device on the switcher is already named RTR TALL. Choose another device name",
    );
    expect(fake.writes).toEqual([]);
    expect(fake.devices).toEqual(realDevices());
  });

  it("deletes the device by the name it has, or the one it is being given", async () => {
    const fake = await start();
    const reading = await deleteDevice({ ...at(fake), deviceName: "GONE", otherName: "RTR TALL" });
    expect(reading.devices.map((device) => device.name)).toEqual(["CP", "ADAM"]);
  });
});

describe("deleting this computer's device", () => {
  it("deletes only its own device, after the form shows that device", async () => {
    const [cp, adam, router] = realDevices();
    const fake = await start({ devices: [cp!, { ...hubbleDevice(), slot: 5 }, adam!, router!] });
    const reading = await deleteDevice({ ...at(fake), deviceName: "HUBBLE" });
    expect(fake.writes).toEqual([
      w(FAKE_OID.selectedRow, 2),
      w(FAKE_OID.deleteDevice, 1),
      w(FAKE_OID.selectedRow, 0),
    ]);
    expect(fake.devices).toEqual(realDevices());
    expect(reading.mine).toBeNull();
    expect(reading.devices.map((device) => device.name)).toEqual(["CP", "ADAM", "RTR TALL"]);
    expect(fake.formIsIdle).toBe(true);
  });

  it("does nothing when the switcher has no such device", async () => {
    const fake = await start();
    const reading = await deleteDevice({ ...at(fake), deviceName: "HUBBLE" });
    expect(reading.mine).toBeNull();
    expect(reading.devices).toHaveLength(3);
    expect(fake.writes).toEqual([]);
  });
});

describe("when the switcher is slow or the work is stopped", () => {
  it("gives up on a reply that never comes and closes the connection", async () => {
    const fake = await start();
    fake.hold();
    await expect(readSwitcher({ ...at(fake, { timeoutMs: 120 }), deviceName: "HUBBLE" })).rejects.toThrow(
      "The switcher didn't answer in time",
    );
    await pause();
    expect(fake.openConnections).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it("asks the switcher to drop a half-made device when a reply never comes", async () => {
    const fake = await start();
    fake.onWrite = (write) => {
      if (write.oid === FAKE_OID.type) fake.hold();
    };
    await expect(sendDevice({ ...at(fake, { timeoutMs: 150 }), settings: HUBBLE })).rejects.toThrow(
      "The switcher didn't answer in time",
    );
    // The cancel and the "choose no row" were sent before the connection closed.
    expect(fake.writes.slice(-2)).toEqual([w(FAKE_OID.changes, 0), w(FAKE_OID.selectedRow, 0)]);
    fake.release();
    await pause();
    expect(fake.devices).toEqual(realDevices());
    expect(fake.formIsIdle).toBe(true);
    expect(fake.openConnections).toBe(0);
  });

  it("stops at once when aborted, and still cancels and chooses no row", async () => {
    const fake = await start();
    const stop = new AbortController();
    fake.onWrite = (write) => {
      if (write.oid === FAKE_OID.slot) stop.abort();
    };
    const failure = await sendDevice({ ...at(fake, { signal: stop.signal }), settings: HUBBLE }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(fake.writes).toEqual([
      w(FAKE_OID.addDevice, 0),
      w(FAKE_OID.slot, 3),
      w(FAKE_OID.changes, 0),
      w(FAKE_OID.selectedRow, 0),
    ]);
    await pause();
    expect(fake.devices).toEqual(realDevices());
    expect(fake.formIsIdle).toBe(true);
    expect(fake.openConnections).toBe(0);
  });

  it("does not connect when already aborted", async () => {
    const fake = await start();
    const failure = await readSwitcher({
      ...at(fake, { signal: AbortSignal.abort() }),
      deviceName: "HUBBLE",
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(fake.requests).toEqual([]);
  });

  it("says the switcher can't be reached when nothing listens there", async () => {
    const fake = await FakeSwitcher.start();
    const port = fake.port;
    await fake.stop();
    await expect(
      readSwitcher({ host: "127.0.0.1", port, timeoutMs: 500, deviceName: "HUBBLE" }),
    ).rejects.toThrow("The switcher refused the connection. Check its address");
  });
});

describe("the binary OGP client", () => {
  it("refuses, before sending, any parameter outside the Devices form", async () => {
    const fake = await start();
    const client = new OgpBinaryClient({ host: "127.0.0.1", port: fake.port, writable: SWITCHER_WRITABLE_OIDS });
    cleanup.push(() => client.close());
    await client.connect();
    await client.handshake();
    // 0x1A6A is the switcher's own IP address.
    await expect(client.set(0x1a6a, cstring("10.0.0.1"))).rejects.toThrow("doesn't write switcher setting 0x1A6A");
    await expect(client.set(FAKE_OID.listSlot, int32(1))).rejects.toThrow(OgpError);
    expect(fake.requests).toEqual([{ type: 0x4a, oid: FAKE_OID.connection }]);
    expect(fake.writes).toEqual([]);
    expect(SWITCHER_WRITABLE_OIDS.size).toBe(21);
    for (const oid of [0x1a6a, 0x1a6d, 0x0105, 0xfe02, FAKE_OID.listName, FAKE_OID.connection])
      expect(SWITCHER_WRITABLE_OIDS.has(oid)).toBe(false);
    expect([...SWITCHER_WRITABLE_OIDS].sort()).toEqual(
      Object.entries(SWITCHER_OID)
        .filter(([name]) => !/^list|^productName$|^software$|^engineType$/u.test(name))
        .map(([, oid]) => oid)
        .sort(),
    );
  });

  it("turns the switcher's return codes into plain errors and stays usable", async () => {
    const fake = await start();
    const client = new OgpBinaryClient({
      host: "127.0.0.1",
      port: fake.port,
      writable: new Set([FAKE_OID.listSlot, FAKE_OID.port, FAKE_OID.selectedRow]),
    });
    cleanup.push(() => client.close());
    await client.connect();
    await client.handshake();
    await expect(client.get(0x4242)).rejects.toMatchObject({ code: 0x11, oid: 0x4242 });
    await expect(client.set(FAKE_OID.listSlot, int32(1))).rejects.toMatchObject({
      code: 0x13,
      message: "The switcher says that setting can't be changed",
    });
    await expect(client.set(FAKE_OID.port, int32(9821))).rejects.toMatchObject({ code: 0x14 });
    await expect(client.set(FAKE_OID.selectedRow, int32(99))).rejects.toMatchObject({
      code: 0x12,
      message: "The switcher refused that value",
    });
    expect(readInt(await client.get(FAKE_OID.selectedRow))).toBe(0);
  });

  it("reads a parameter's choices, with the switcher's own numbers", async () => {
    const fake = await start();
    const client = new OgpBinaryClient({ host: "127.0.0.1", port: fake.port, writable: SWITCHER_WRITABLE_OIDS });
    cleanup.push(() => client.close());
    await client.connect();
    await client.handshake();
    const type = await client.descriptor(FAKE_OID.type);
    expect(type.name).toBe("Device Type");
    expect(type.typeId).toBe(4);
    expect(type.choices).toHaveLength(8);
    expect(type.choices).toContainEqual({ key: 11, label: "TSL UMD" });
    expect((await client.descriptor(FAKE_OID.driver)).choices).toEqual([{ key: 0, label: "--none--" }]);
    await client.set(FAKE_OID.selectedRow, int32(1));
    expect((await client.descriptor(FAKE_OID.driver)).choices).toEqual([
      { key: FAKE_DRIVER.tsl31, label: "TSL 3.1" },
      { key: FAKE_DRIVER.tsl5, label: "TSL 5" },
    ]);
    // Transport's reply carries a length byte of 1 and a four-byte number.
    await client.set(FAKE_OID.selectedRow, int32(3));
    expect(readInt(await client.get(FAKE_OID.transport))).toBe(1);
  });

  it("finds its reply among split packets, junk and frames nobody asked for", async () => {
    class Wire extends EventEmitter {
      readonly sent: Buffer[] = [];
      destroyed = false;
      write(data: Buffer): boolean {
        this.sent.push(Buffer.from(data));
        return true;
      }
      destroy(): this {
        this.destroyed = true;
        return this;
      }
      setNoDelay(): this {
        return this;
      }
    }
    const wire = new Wire();
    const client = new OgpBinaryClient({
      host: "switcher.test",
      timeoutMs: 500,
      connect: () => {
        queueMicrotask(() => wire.emit("connect"));
        return wire as unknown as OgpSocket;
      },
    });
    await client.connect();
    const frame = (type: number, content: number[]) =>
      Buffer.from([0xba, 0xd2, 0xac, 0xe5, 0x10, 0x00, type, content.length >> 8, content.length & 0xff, ...content]);
    const feed = (bytes: Buffer, size: number) => {
      for (let offset = 0; offset < bytes.length; offset += size)
        wire.emit("data", bytes.subarray(offset, offset + size));
    };

    const shaking = client.handshake();
    await Promise.resolve();
    expect(wire.sent[0]).toEqual(
      Buffer.from([0xba, 0xd2, 0xac, 0xe5, 0x00, 0x10, 0x4a, 0x00, 0x08, 0x00, 0xff, 0x03, 0x04, 0, 0, 0, 0]),
    );
    // The real switcher's reply, one byte at a time.
    feed(frame(0xca, [0x00, 0xff, 0x03, 0x06, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), 1);
    await shaking;

    const reading = client.get(0x5188);
    await Promise.resolve();
    await Promise.resolve();
    expect(wire.sent[1]).toEqual(Buffer.from([0xba, 0xd2, 0xac, 0xe5, 0x00, 0x10, 0x49, 0x00, 0x03, 0x00, 0x51, 0x88]));
    feed(
      Buffer.concat([
        Buffer.from([0x07, 0xba, 0xd2, 0xac]), // junk that looks like the start of a frame
        frame(0x10, [0x7f, 0x41, 0x01]), // a value report
        frame(0xca, [0x00, 0x7f, 0x41, 0x02, 0x31, 0x00]), // the clock, pushed as a write reply
        frame(0xc9, [0x00, 0x51, 0x89, 0x04, 0xff, 0xff, 0xff, 0xff]), // a read reply for another parameter
        frame(0xc9, [0x00, 0x51, 0x88, 0x04, 0x00, 0x00, 0x00, 0x04]),
      ]),
      3,
    );
    expect(readInt(await reading)).toBe(4);
    client.close();
    expect(wire.destroyed).toBe(true);
    await expect(client.get(0x5188)).rejects.toThrow("The connection to the switcher is closed");
  });

  it("reads the switcher's numbers, texts and lists", () => {
    // The Slot column as the real switcher sent it: SP, 0, 1, 2.
    expect(readStrings(Buffer.from("03535000023000023100023200", "hex"))).toEqual(["SP", "0", "1", "2"]);
    // The Name column: an empty first entry, then CP, ADAM, RTR TALL.
    expect(
      readStrings(Buffer.from("01000343500005" + "4144414d00" + "09" + "5254522054414c4c00", "hex")),
    ).toEqual(["", "CP", "ADAM", "RTR TALL"]);
    expect(readStrings(Buffer.alloc(0))).toEqual([]);
    expect(() => readStrings(Buffer.from("0553500002", "hex"))).toThrow(OgpError);
    expect(readInt(Buffer.from("ffffffff", "hex"))).toBe(-1);
    expect(readInt(Buffer.from("edd39288", "hex"))).toBe(-304901496);
    expect(readInt(Buffer.from("fffe", "hex"))).toBe(-2);
    expect(() => readInt(Buffer.from("000000", "hex"))).toThrow(OgpError);
    expect(readString(Buffer.from("302e302e302e3000", "hex"))).toBe("0.0.0.0");
    expect(readString(Buffer.from("00", "hex"))).toBe("");
    expect(int32(-1)).toEqual(Buffer.from("ffffffff", "hex"));
    expect(cstring("HUBBLE")).toEqual(Buffer.from("485542424c4500", "hex"));
    expect(() => int32(2 ** 31)).toThrow(RangeError);
  });
});
