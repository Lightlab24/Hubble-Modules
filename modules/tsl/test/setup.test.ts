import { describe, expect, it } from "vitest";
import {
  defaultSwitcherDocument,
  deviceLine,
  deviceState,
  linkStatus,
  listenerProblem,
  SwitcherDocumentSchema,
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
      text: "The switcher sends TSL 5.0 over UDP to 10.20.100.235 : 9821, and this computer is listening for it",
      match: null,
    });
  });

  it("says what differs and offers the switcher's values to match", () => {
    const status = link({ receiver: { ...receiver, protocol: "3.1", transport: "tcp", port: 5727 } });
    expect(status.tone).toBe("warn");
    expect(status.title).toBe("Not matched");
    expect(status.text).toBe(
      "The switcher sends TSL 5.0 over UDP to port 9821. This computer listens for TSL 3.1 over TCP on port 5727",
    );
    expect(status.match).toEqual({ protocol: "5.0", transport: "udp", port: 9821 });
    // One differing value is enough, and matching copies all three.
    expect(link({ receiver: { ...receiver, port: 9822 } }).match).toEqual({ protocol: "5.0", transport: "udp", port: 9821 });
  });

  it("has nothing to match when the difference is on the switcher's side", () => {
    const elsewhere = link({ reading: reading({ ip: "10.20.100.236" }) });
    expect(elsewhere).toMatchObject({ tone: "warn", title: "Not matched", match: null });
    expect(elsewhere.text).toContain("10.20.100.236, which isn't one of this computer's addresses");
    const bound = link({ receiver: { ...receiver, bindAddress: "172.17.5.206" }, localAddresses: ["10.20.100.235", "172.17.5.206"] });
    expect(bound.text).toBe("The switcher sends to 10.20.100.235, but this computer listens only on 172.17.5.206");
    expect(link({ reading: reading({ enabled: false }) }).text).toBe("The device is switched off on the switcher");
    expect(link({ listening: false })).toMatchObject({ tone: "warn", title: "Not listening", match: null });
  });

  it("never claims a match it has not read", () => {
    expect(link({ reading: null })).toMatchObject({ tone: "idle", title: "Not checked", match: null });
    expect(link({ reading: reading(null) })).toMatchObject({ tone: "idle", title: "Not set up", match: null });
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

  it("starts as HUBBLE, enabled, low brightness, everything else off, sending to the automatic address", () => {
    expect(defaultSwitcherDocument()).toEqual({
      host: "",
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
    for (const good of [{ name: "RTR TALL" }, { name: "A" }, { name: "CAM-1" }, { offset: 50000 }, { screen: 65534 }, { sendTo: "10.20.100.235" }])
      expect(SwitcherDocumentSchema.safeParse(good).success, JSON.stringify(good)).toBe(true);
  });
});

describe("where this computer's device stands", () => {
  it("separates not read, not there, there, and changed here but not sent", () => {
    expect(deviceState({ reading: null, wanted: settings })).toEqual({ tone: "idle", text: "Not checked", onSwitcher: false, unsent: false });
    expect(deviceState({ reading: reading(null), wanted: settings })).toMatchObject({ text: "Not on the switcher yet", onSwitcher: false });
    expect(deviceState({ reading: reading(), wanted: settings })).toEqual({ tone: "ok", text: "On the switcher in slot 3", onSwitcher: true, unsent: false });
    expect(deviceState({ reading: reading(), wanted: { ...settings, center: true } })).toEqual({
      tone: "warn",
      text: "On the switcher in slot 3 · changes here are not sent yet",
      onSwitcher: true,
      unsent: true,
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
