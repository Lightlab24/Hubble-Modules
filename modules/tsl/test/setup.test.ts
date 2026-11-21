import { describe, expect, it } from "vitest";
import {
  defaultSwitcherDocument,
  deviceIdentity,
  deviceLine,
  deviceState,
  documentFromDevice,
  documentFromRow,
  linkStatus,
  listenerProblem,
  SwitcherDocumentSchema,
  unsentFields,
  wantedDevice,
  type ReceiverLink,
} from "../src/setup.js";
import type { SwitcherDeviceSettings, SwitcherReading } from "../src/switcher/index.js";

const receiver: ReceiverLink = { protocol: "5.0", transport: "udp", port: 9821, bindAddress: "0.0.0.0" };
const settings: SwitcherDeviceSettings = {
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
  fsfc: false,
  busName: false,
  umdId: false,
  oneSecond: false,
  header: false,
};
const row = { row: 4, slot: 3, type: "TSL UMD", driver: "TSL 5", name: "HUBBLE", ip: "10.20.100.235", port: 9821, enabled: true };
const reading = (mine: Partial<SwitcherDeviceSettings> | null = {}, formBusy = false): SwitcherReading => ({
  product: "Carbonite Ultra",
  software: "9.2.1.18190",
  devices: mine === null ? [] : [{ ...row, ip: mine.ip ?? row.ip, port: mine.port ?? row.port }],
  mine:
    mine === null
      ? null
      : { ...row, ip: mine.ip ?? row.ip, port: mine.port ?? row.port, settings: formBusy ? null : { ...settings, ...mine } },
  formBusy,
});
const link = (input: Partial<Parameters<typeof linkStatus>[0]>) =>
  linkStatus({ receiver, reading: reading(), readError: null, localAddresses: ["10.20.100.235"], listening: true, ...input });

describe("whether the switcher and this computer agree", () => {
  it("is matched when version, transport, port and address all agree and the listener is up", () => {
    expect(link({})).toEqual({
      tone: "ok",
      title: "Matched",
      text: "HUBBLE sends TSL 5.0 over UDP to 10.20.100.235 : 9821, and this computer is listening for it",
      match: null,
    });
  });

  it("says what differs and offers the switcher's values to match", () => {
    const status = link({ receiver: { ...receiver, protocol: "3.1", transport: "tcp", port: 5727 } });
    expect(status.tone).toBe("warn");
    expect(status.title).toBe("Not matched");
    expect(status.text).toBe(
      "HUBBLE sends TSL 5.0 over UDP to port 9821. This computer listens for TSL 3.1 over TCP on port 5727",
    );
    expect(status.match).toEqual({ protocol: "5.0", transport: "udp", port: 9821, bindAddress: "0.0.0.0" });
    // One differing value is enough, and matching copies all three.
    expect(link({ receiver: { ...receiver, port: 9822 } }).match).toEqual({ protocol: "5.0", transport: "udp", port: 9821, bindAddress: "0.0.0.0" });
  });

  it("listens on the address the device sends to when this computer listens only somewhere else", () => {
    const bound = link({ receiver: { ...receiver, bindAddress: "172.17.5.206" }, localAddresses: ["10.20.100.235", "172.17.5.206"] });
    expect(bound.text).toBe("HUBBLE sends to 10.20.100.235, but this computer listens only on 172.17.5.206");
    expect(bound.match).toEqual({ protocol: "5.0", transport: "udp", port: 9821, bindAddress: "10.20.100.235" });
    // A saved address this computer no longer has is put right the same way.
    expect(link({ receiver: { ...receiver, bindAddress: "10.20.100.236" } }).match).toMatchObject({ bindAddress: "10.20.100.235" });
  });

  it("offers no match for a device that doesn't send to this computer, whatever else differs", () => {
    const elsewhere = link({ reading: reading({ ip: "10.20.100.236", protocol: "3.1", transport: "tcp", port: 5727 }) });
    expect(elsewhere).toEqual({
      tone: "warn",
      title: "Not matched",
      text: "HUBBLE sends to 10.20.100.236 : 5727, which isn't this computer. Point it here and send, then match",
      match: null,
    });
    // Naming this computer's address on the switcher's network, when it is known.
    expect(link({ reading: reading({ ip: "10.20.100.236", port: 5727 }), hereAddress: "10.20.100.235" }).text).toBe(
      "HUBBLE sends to 10.20.100.236 : 5727, which isn't this computer (10.20.100.235). Point it here and send, then match",
    );
    expect(link({ reading: reading({ enabled: false }) })).toMatchObject({ text: "HUBBLE is switched off on the switcher", match: null });
  });

  it("says when the address is all that differs, and both ways to put it right", () => {
    // TSL 5.0, UDP and 9821 agree; the switcher sends to an address this computer doesn't have.
    expect(link({ reading: reading({ ip: "10.20.100.236" }), hereAddress: "10.20.100.235" })).toEqual({
      tone: "warn",
      title: "Not matched",
      text: "Only the address differs: HUBBLE sends to 10.20.100.236, and this computer is 10.20.100.235. Point HUBBLE at 10.20.100.235, or give this computer 10.20.100.236",
      match: null,
    });
    // An address that isn't one of this computer's is no help in the words.
    for (const hereAddress of [null, undefined, "192.168.9.9"])
      expect(link({ reading: reading({ ip: "10.20.100.236" }), hereAddress }).text).toBe(
        "Only the address differs: HUBBLE sends to 10.20.100.236, and this computer is not on that address. Point HUBBLE at this computer, or give this computer 10.20.100.236",
      );
    expect(link({ listening: false })).toMatchObject({ tone: "warn", title: "Not listening", match: null });
  });

  it("never claims a match it has not read", () => {
    expect(link({ reading: null })).toMatchObject({ tone: "idle", title: "Not checked", match: null });
    expect(link({ reading: reading(null) })).toMatchObject({ tone: "idle", title: "Not set up", match: null });
    expect(link({ reading: reading(null), deviceName: "ADAM" }).text).toBe(
      "The switcher has no device named ADAM. Pick one from its list, or send to add it",
    );
    expect(link({ reading: reading({}, true) })).toMatchObject({ tone: "idle", title: "Not checked", match: null });
    expect(link({ reading: reading(), readError: "The switcher did not answer" })).toEqual({
      tone: "bad",
      title: "Switcher offline",
      text: "The switcher did not answer",
      match: null,
    });
  });
});

describe("the device Hubble wants on the switcher", () => {
  it("takes version, transport and port from this computer and the rest from the page", () => {
    const document = SwitcherDocumentSchema.parse({ host: "10.20.20.41", name: "HUBBLE", fsfc: true, offset: 10000, brightness: 3 });
    expect(wantedDevice(document, { ...receiver, protocol: "3.1", transport: "tcp", port: 5727 }, "10.20.100.235")).toEqual({
      ...settings,
      protocol: "3.1",
      transport: "tcp",
      port: 5727,
      fsfc: true,
      offset: 10000,
      brightness: 3,
    });
  });

  it("takes version, transport and port from the page once it has its own", () => {
    const document = SwitcherDocumentSchema.parse({ name: "ADAM", device: "ADAM", protocol: "3.1", transport: "tcp", port: 5727 });
    expect(wantedDevice(document, receiver, "10.20.100.235")).toMatchObject({ name: "ADAM", protocol: "3.1", transport: "tcp", port: 5727 });
  });

  it("starts as HUBBLE, enabled, low brightness, everything else off, sending to the automatic address", () => {
    expect(defaultSwitcherDocument()).toEqual({
      host: "",
      device: "",
      name: "HUBBLE",
      sendTo: "",
      enabled: true,
      screen: 0,
      offset: 0,
      brightness: 1,
      center: false,
      fsfc: false,
      busName: false,
      umdId: false,
      oneSecond: false,
      header: false,
    });
  });

  it("refuses values the switcher cannot hold", () => {
    for (const bad of [{ name: "" }, { name: "NINECHARS" }, { name: " LEAD" }, { name: "TRAIL " }, { name: "café" }, { offset: 5000 }, { screen: 65535 }, { brightness: 4 }, { sendTo: "not-an-address" }, { extra: 1 }])
      expect(SwitcherDocumentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const bad of [{ device: "NINECHARS" }, { device: " ADAM" }, { protocol: "4.0" }, { transport: "sdi" }, { port: 0 }, { port: 65536 }])
      expect(SwitcherDocumentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const good of [{ name: "RTR TALL" }, { name: "A" }, { name: "CAM-1" }, { offset: 50000 }, { screen: 65534 }, { sendTo: "10.20.100.235" }])
      expect(SwitcherDocumentSchema.safeParse(good).success, JSON.stringify(good)).toBe(true);
    for (const good of [{ device: "" }, { device: "RTR TALL" }, { protocol: "3.1", transport: "tcp", port: 5727 }])
      expect(SwitcherDocumentSchema.safeParse(good).success, JSON.stringify(good)).toBe(true);
  });

  it("reads a setup saved before 1.3.1 as the device named HUBBLE that sends what this computer listens for", () => {
    const old = SwitcherDocumentSchema.parse({ host: "10.20.20.41", name: "HUBBLE", sendTo: "", enabled: true, screen: 0, offset: 0, brightness: 1, center: false, fsfc: false, busName: false, umdId: false, oneSecond: false, header: false });
    expect(old).not.toHaveProperty("protocol");
    expect(deviceIdentity(old)).toBe("HUBBLE");
    expect(wantedDevice(old, receiver, "10.20.100.235")).toMatchObject({ protocol: "5.0", transport: "udp", port: 9821 });
  });
});

describe("picking a device on the switcher", () => {
  const document = SwitcherDocumentSchema.parse({ host: "10.20.20.41", name: "HUBBLE", fsfc: true, brightness: 3, screen: 4 });
  it("takes what the list says at once: name, where it sends, version, port and on or off", () => {
    const adam = { row: 2, slot: 1, type: "TSL UMD", driver: "TSL 3.1", name: "ADAM", ip: "10.20.100.236", port: 5727, enabled: true };
    expect(documentFromRow(document, adam)).toEqual({ ...document, device: "ADAM", name: "ADAM", sendTo: "10.20.100.236", protocol: "3.1", port: 5727, enabled: true });
    // A device with no address yet leaves Send to on automatic.
    expect(documentFromRow(document, { ...adam, driver: "TSL 5", ip: "", port: 0 })).toMatchObject({ sendTo: "", protocol: "5.0" });
    expect(documentFromRow(document, { ...adam, ip: "", port: 0 })).not.toHaveProperty("port");
  });

  it("then takes the rest from its form, keeping TSL 5.0 options a TSL 3.1 device doesn't have", () => {
    const adam = { ...settings, name: "ADAM", ip: "10.20.100.236", port: 5727, protocol: "3.1" as const, transport: "tcp" as const, center: true, brightness: 0 as const, screen: 0 };
    expect(documentFromDevice(document, adam)).toEqual({
      ...document,
      device: "ADAM",
      name: "ADAM",
      sendTo: "10.20.100.236",
      protocol: "3.1",
      transport: "tcp",
      port: 5727,
      enabled: true,
      center: true,
      fsfc: false,
    });
    expect(documentFromDevice(document, { ...adam, protocol: "5.0", brightness: 0, screen: 9, offset: 20000, header: true })).toMatchObject({
      brightness: 0,
      screen: 9,
      offset: 20000,
      header: true,
    });
  });

  it("is found by the name it has on the switcher while a new name waits to be sent", () => {
    expect(deviceIdentity({ device: "ADAM", name: "CAM" })).toBe("ADAM");
    expect(deviceIdentity({ device: "", name: "HUBBLE" })).toBe("HUBBLE");
    expect(unsentFields({ ...settings, name: "CAM" }, settings)).toEqual(["name"]);
    expect(unsentFields(settings, settings)).toEqual([]);
    expect(unsentFields(null, settings)).toEqual([]);
  });
});

describe("where this computer's device stands", () => {
  it("separates not read, not there, there, and changed here but not sent", () => {
    expect(deviceState({ reading: null, wanted: settings })).toEqual({ tone: "idle", text: "Not checked", onSwitcher: false, unsent: false, fields: [] });
    expect(deviceState({ reading: reading(null), wanted: settings })).toMatchObject({ text: "Not on the switcher yet", onSwitcher: false });
    expect(deviceState({ reading: reading(), wanted: settings })).toEqual({ tone: "ok", text: "On the switcher in slot 3", onSwitcher: true, unsent: false, fields: [] });
    expect(deviceState({ reading: reading(), wanted: { ...settings, center: true } })).toEqual({
      tone: "warn",
      text: "Slot 3 · 1 change not sent",
      onSwitcher: true,
      unsent: true,
      fields: ["center"],
    });
    expect(deviceState({ reading: reading(), wanted: { ...settings, ip: "10.20.100.240", port: 9000, name: "CAM" } })).toMatchObject({
      text: "Slot 3 · 3 changes not sent",
      fields: ["name", "ip", "port"],
    });
    // A TSL 3.1 device has no Screen, Address offset, Brightness or TSL header to differ in.
    const old = { ...settings, protocol: "3.1" as const, transport: "tcp" as const, port: 5727 };
    expect(deviceState({ reading: reading(old), wanted: { ...old, brightness: 3, screen: 9, offset: 10000, header: true } })).toMatchObject({ unsent: false });
    expect(deviceState({ reading: reading(old), wanted: { ...old, brightness: 3, fsfc: true } })).toMatchObject({ unsent: true });
    // Without the device's settings (a busy form) nothing is called unsent.
    expect(deviceState({ reading: reading({}, true), wanted: { ...settings, center: true } })).toMatchObject({ unsent: false, onSwitcher: true });
  });

  it("writes a list line the way the switcher's own words read", () => {
    expect(deviceLine(row, true)).toEqual({ slot: "3", name: "HUBBLE", format: "TSL 5.0", sendsTo: "10.20.100.235 : 9821", enabled: "On", mine: true });
    expect(deviceLine({ ...row, driver: "TSL 3.1", enabled: false }, false)).toMatchObject({ format: "TSL 3.1", enabled: "Off", mine: false });
    expect(deviceLine({ ...row, type: "RossTalk", driver: "", ip: "" }, false)).toMatchObject({ format: "RossTalk", sendsTo: "" });
  });
});

describe("a listener that could not start", () => {
  const local = ["192.168.1.100"];
  it("says so in the operator's words", () => {
    // The saved address belongs to a network this computer is no longer on.
    expect(
      listenerProblem({ error: "listen EADDRNOTAVAIL: address not available 10.20.100.236:5727", bindAddress: "10.20.100.236", port: 5727, localAddresses: local }),
    ).toBe("10.20.100.236 isn't one of this computer's addresses");
    expect(listenerProblem({ error: "listen EADDRINUSE: address already in use 0.0.0.0:5727", bindAddress: "0.0.0.0", port: 5727, localAddresses: local })).toBe(
      "port 5727 is in use by something else",
    );
    expect(listenerProblem({ error: "listen EACCES: permission denied 0.0.0.0:80", bindAddress: "0.0.0.0", port: 80, localAddresses: local })).toBe(
      "this computer doesn't allow port 80",
    );
  });
  it("passes on what it does not recognise, and never an empty reason", () => {
    expect(listenerProblem({ error: "socket hung up", bindAddress: "192.168.1.100", port: 5727, localAddresses: local })).toBe("socket hung up");
    expect(listenerProblem({ error: null, bindAddress: "0.0.0.0", port: 5727, localAddresses: local })).toBe("the port could not be opened");
  });
});
