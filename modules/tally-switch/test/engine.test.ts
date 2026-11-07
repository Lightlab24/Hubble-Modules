import { describe, expect, it, vi } from "vitest";
import {
  program,
  TallySwitchEngine,
  type Mapping,
  type Tally,
} from "../src/engine.js";
const rows: Mapping[] = [1, 2].map((address) => ({
  id: `camera-${address}`,
  values: {
    name: `Camera ${address}`,
    enabled: true,
    receiver: "tsl",
    screen: 0,
    address,
    indicator: "default",
    router: "router",
    source: address,
    destination: 1,
    level: 1,
  },
}));
const tally = (first: boolean, second: boolean): Tally => ({
  phase: "listening",
  protocol: "3.1",
  displays: [first, second].map((on, i) => [
    0,
    i + 1,
    on ? 2 : 0,
    0,
    0,
    0,
    true,
    i + 1,
  ]),
});
function fixture(route = vi.fn(async () => "Submitted")) {
  const engine = new TallySwitchEngine(
    structuredClone(rows),
    true,
    route,
    () => {},
  );
  engine.routers.set("router", { ready: true, approved: true });
  const update = (data: Tally, dispatch = true) => {
    engine.tallies.set("tsl", data);
    engine.evaluate(dispatch);
  };
  return { engine, route, update };
}
describe("independent TALLY Switch decisions", () => {
  it("holds startup tally, routes a fresh winner once, and never replays repeated packets", async () => {
    const { route, update } = fixture();
    update(tally(true, false));
    update(tally(true, false));
    expect(route).not.toHaveBeenCalled();
    update(tally(false, true));
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    expect(route).toHaveBeenCalledWith({
      router: "router",
      source: 2,
      destination: 1,
      level: 1,
    });
    update(tally(false, true));
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("holds unknown, stale, conflicting, and all-off inputs", () => {
    const { engine, route, update } = fixture();
    update(tally(true, false));
    const stale = tally(false, true);
    stale.displays[0]![6] = false;
    update(stale);
    expect(engine.statuses[0]?.values.status).toContain("every mapped camera");
    update(tally(true, true));
    expect(engine.statuses[0]?.values.status).toContain("multiple cameras");
    update(tally(false, false));
    expect(engine.statuses[0]?.values.status).toContain("no camera");
    expect(route).not.toHaveBeenCalled();
  });
  it("requires a ready router and an explicit action approval", () => {
    const { engine, route, update } = fixture();
    update(tally(true, false));
    engine.routers.set("router", { ready: true, approved: false });
    update(tally(false, true));
    expect(route).not.toHaveBeenCalled();
    expect(engine.statuses[1]?.values.status).toBe(
      "Holding · router unavailable",
    );
    engine.routers.set("router", { ready: false, approved: true });
    update(tally(false, true));
    expect(route).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain failure until a new program transition", async () => {
    const route = vi.fn(async () => {
      throw new Error("timeout");
    });
    const { engine, update } = fixture(route);
    update(tally(true, false));
    update(tally(false, true));
    await vi.waitFor(() =>
      expect(engine.statuses[1]?.values.status).toContain("timeout"),
    );
    for (let i = 0; i < 10; i++) update(tally(false, true));
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("baselines new receiver generations instead of replaying the latest winner", () => {
    const { engine, route, update } = fixture();
    update(tally(true, false));
    engine.baseline("tsl");
    update(tally(false, true), false);
    update(tally(false, true));
    expect(route).not.toHaveBeenCalled();
  });
  it("explicit follow catches up, and unfollow prevents subsequent routes", async () => {
    const { engine, route, update } = fixture();
    update(tally(true, false));
    engine.setFollowing(true);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    engine.setFollowing(false);
    update(tally(false, true));
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("serializes changing winners behind an unsettled route", async () => {
    let finish!: (value: string) => void;
    const route = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue("Submitted");
    const { update } = fixture(route);
    update(tally(true, false));
    update(tally(false, true));
    update(tally(true, false));
    expect(route).toHaveBeenCalledTimes(1);
    finish("Submitted");
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(2));
  });
  it("stopping with a route in flight prevents any queued winner replay", async () => {
    let finish!: (value: string) => void;
    const route = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const { engine, update } = fixture(route);
    update(tally(true, false));
    update(tally(false, true));
    update(tally(true, false));
    engine.close();
    finish("Submitted");
    await Promise.resolve();
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("uses newest broadcast values and rejects indicator/version mismatches", () => {
    const data = tally(true, false);
    data.displays.push([65535, 65535, 0, 0, 0, 0, true, 10]);
    expect(program(data, rows[0]!.values)).toBe(false);
    expect(program(data, { ...rows[0]!.values, indicator: "text" })).toBeNull();
    expect(
      program(
        { ...data, protocol: "5.0", displays: [[5, 10, 0, 0, 1, 0, true, 1]] },
        { ...rows[0]!.values, screen: 5, address: 10 },
      ),
    ).toBe(true);
  });
});

import manifest from "../src/manifest.js";
it("keeps TALLY Switch in its page and peer follow workflow, not the button authoring catalog", () => {
  expect(manifest.actionUi).toBe(false);
  expect(manifest.host.requiredFeatures).toContain(
    "module-action-authoring-v1",
  );
  expect(manifest.actions.map((action) => action.id)).toContain("follow");
  expect(manifest.pages?.length).toBeGreaterThan(0);
});
it("connects to every TSL receiver and router, with only route allowed", () => {
  expect(manifest.host.requiredFeatures).toContain("module-exchange-peers-v1");
  expect(manifest.exchange.peers).toEqual([
    { data: "tally", version: 1, actions: [] },
    { data: "router", version: 1, actions: ["route"] },
  ]);
});

import module from "../src/module.js";
import { createModuleHarness } from "@hubble/module-sdk/testing";
it("retains peer follow, unfollow and the page toggle without sending a router command", async () => {
  const execute = vi.fn(async () => ({
    status: "success" as const,
    evidence: { kind: "local" as const, summary: "fixture" },
  }));
  const publish = vi.fn(async () => {});
  const harness = createModuleHarness(
    module,
    { enabled: false, mappings: [] },
    {
      modules: {
        discover: async () => [],
        bindings: async () => [],
        query: async () => null,
        subscribe: async () => async () => {},
        publish,
        execute,
        reportAction: async () => {},
      },
    },
  );
  try {
    await harness.instance.start();
    for (const [mode, following] of [
      ["follow", true],
      ["unfollow", false],
      ["toggle", true],
    ] as const) {
      expect(
        await harness.instance.execute("follow", { mode }, harness.execution()),
      ).toMatchObject({ status: "success" });
      expect(publish).toHaveBeenLastCalledWith("following", 1, { following });
    }
    expect(
      await harness.instance.call?.(
        "page.tally-switch",
        { commandId: "toggle" },
        harness.execution(),
      ),
    ).toEqual({ message: "Unfollowing" });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await harness.instance.execute(
        "follow",
        { mode: "follow" },
        harness.execution(aborted.signal),
      ),
    ).toMatchObject({ status: "failure", category: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.feedback.at(-1)).toMatchObject({
      id: "following",
      state: "inactive",
    });
  } finally {
    await harness.instance.dispose();
  }
});
