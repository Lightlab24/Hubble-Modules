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
      kept: [],
    });
  });

  it("leaves a camera deleted elsewhere deleted, and names the change that could not land", () => {
    const mine = routingChange(cameras, [camera(1), camera(2, { name: "Gone" }), camera(3)]);
    expect(applyRoutingChange([camera(1), camera(3)], mine)).toEqual({ rows: [camera(1), camera(3)], missing: ["camera-2"], kept: [] });
  });

  it("lands an Undo only where a field still holds what the window last read", () => {
    // The window last read source 21 on camera 1 and 22 on camera 2, and its Undo puts back 30 on
    // both, with a new name for camera 1 that is no Undo. Another window has since changed camera
    // 1's source to 50.
    const undo = {
      ...routingChange(
        [camera(1), camera(2)],
        [camera(1, { name: "Wide", source: 30 }), camera(2, { source: 30 })],
      ),
      expected: [
        { id: "camera-1", fields: { source: 21 } },
        { id: "camera-2", fields: { source: 22 } },
      ],
    };
    expect(applyRoutingChange([camera(1, { source: 50 }), camera(2)], undo)).toEqual({
      rows: [camera(1, { name: "Wide", source: 50 }), camera(2, { source: 30 })],
      missing: [],
      kept: [{ id: "camera-1", field: "source" }],
    });
    // Another window already put back the same value: nothing is left out, and nothing is said.
    expect(applyRoutingChange([camera(1, { source: 30 }), camera(2)], undo).kept).toEqual([]);
    // Without `expected`, as every other change is sent, the newest change wins.
    const { expected: _, ...plain } = undo;
    expect(applyRoutingChange([camera(1, { source: 50 }), camera(2)], plain).rows[0]).toEqual(camera(1, { name: "Wide", source: 30 }));
  });

  it("takes a camera away for an Undo only as the window last read it", () => {
    // An Undo of adding camera 3: it goes only while it holds what this window read.
    const { id: _, ...asRead } = camera(3);
    const undo = { ...routingChange(cameras, [camera(1), camera(2)]), expected: [{ id: "camera-3", fields: asRead }] };
    expect(applyRoutingChange(cameras, undo)).toEqual({ rows: [camera(1), camera(2)], missing: [], kept: [] });
    // Another window renamed it since: it stays, and is named.
    expect(applyRoutingChange([camera(1), camera(2), camera(3, { name: "Crane" })], undo)).toEqual({
      rows: [camera(1), camera(2), camera(3, { name: "Crane" })],
      missing: [],
      kept: [{ id: "camera-3" }],
    });
    // Another window deleted it already: nothing is left to take away, and nothing is said.
    expect(applyRoutingChange([camera(1), camera(2)], undo)).toEqual({ rows: [camera(1), camera(2)], missing: [], kept: [] });
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
