import { describe, expect, it } from "vitest";
import { applyRoutingChange, applySetupChange, noRoutingChange, routingChange } from "../src/changes.js";
import { defaultSwitcherDocument } from "../src/setup.js";
import type { RoutingRow } from "../src/routing.js";

const camera = (n: number, change: Partial<RoutingRow> = {}): RoutingRow => ({
  id: `camera-${n}`,
  name: `Camera ${n}`,
  enabled: true,
  screen: 0,
  address: n,
  indicator: "default",
  router: "router-1",
  destination: 2,
  source: 20 + n,
  level: 1,
  ...change,
});
const cameras = [camera(1), camera(2), camera(3)];

describe("what one window changed in the cameras", () => {
  it("is only the deletions, additions and fields that differ", () => {
    const edited = [camera(1, { name: "Wide" }), camera(3), camera(9), camera(4, { source: 40 })];
    expect(routingChange(cameras, edited)).toEqual({
      removed: ["camera-2"],
      added: [
        { row: camera(9), after: "camera-3" },
        { row: camera(4, { source: 40 }), after: "camera-9" },
      ],
      changed: [{ id: "camera-1", fields: { name: "Wide" } }],
    });
    expect(noRoutingChange(routingChange(cameras, structuredClone(cameras)))).toBe(true);
  });

  it("lands on what another window saved meanwhile without undoing it", () => {
    // This window renamed camera 1; another window had changed camera 2 and added camera 4 first.
    const mine = routingChange(cameras, [camera(1, { name: "Wide" }), camera(2), camera(3)]);
    const theirs = [camera(1), camera(2, { source: 99 }), camera(3), camera(4)];
    expect(applyRoutingChange(theirs, mine)).toEqual({
      rows: [camera(1, { name: "Wide" }), camera(2, { source: 99 }), camera(3), camera(4)],
      missing: [],
    });
  });

  it("leaves a camera deleted elsewhere deleted, and names the change that could not land", () => {
    const mine = routingChange(cameras, [camera(1), camera(2, { name: "Gone" }), camera(3)]);
    expect(applyRoutingChange([camera(1), camera(3)], mine)).toEqual({ rows: [camera(1), camera(3)], missing: ["camera-2"] });
  });

  it("puts a camera added after one deleted elsewhere at the end, and adds it only once", () => {
    const mine = routingChange(cameras, [camera(1), camera(2), camera(5), camera(3)]);
    const once = applyRoutingChange([camera(1), camera(3)], mine);
    expect(once.rows.map((row) => row.id)).toEqual(["camera-1", "camera-3", "camera-5"]);
    // Sent again, as after a restart cut the answer short: nothing changes.
    expect(applyRoutingChange(once.rows, mine).rows).toEqual(once.rows);
    expect(applyRoutingChange([], routingChange([], [camera(7), camera(8)])).rows.map((row) => row.id)).toEqual(["camera-7", "camera-8"]);
  });
});

describe("what one window changed in the switcher setup", () => {
  const setup = { ...defaultSwitcherDocument(), host: "10.20.20.41", name: "HUBBLE", protocol: "5.0" as const };

  it("puts the operator's own fields on top, newest wins, and takes a field away with null", () => {
    const theirs = { ...setup, center: true, name: "CAM 2" };
    expect(applySetupChange(theirs, { name: "CAM 1", fsfc: true, protocol: null })).toEqual({
      value: { ...defaultSwitcherDocument(), host: "10.20.20.41", name: "CAM 1", center: true, fsfc: true },
      kept: [],
    });
  });

  it("lands a field the page changed by itself only where the setup still holds what it started from", () => {
    // After Read switcher the page takes the device's port and name; another window had changed the port.
    const theirs = { ...setup, port: 7000 };
    expect(applySetupChange(theirs, { port: 6000, device: "ADAM" }, { port: 5727, device: "" })).toEqual({
      value: { ...setup, port: 7000, device: "ADAM" },
      kept: ["port"],
    });
    // A field that was not there to start from counts as missing on both sides.
    expect(applySetupChange(setup, { transport: "tcp" }, { transport: null }).value).toMatchObject({ transport: "tcp" });
  });
});
