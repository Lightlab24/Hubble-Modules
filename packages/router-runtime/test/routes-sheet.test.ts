import { describe, expect, it, vi } from "vitest";
import { RouteSendQueue } from "../src/frontend/route-send-queue.js";
import {
  routePickFromEdit,
  routeSendOutcome,
  DISCONNECT_CHOICE,
  disconnectSourceAddress,
  isDisconnectEdit,
  routeChoicesWithDisconnect,
  routesSheetCell,
  routesSheetColumns,
  routesSheetRowsMatching,
  sourceChoices,
  type RoutePick,
  type RouteSendOutcome,
} from "../src/frontend/routes-sheet-model.js";

const operationId = "11111111-1111-4111-8111-111111111111" as never;
const mappingId = "22222222-2222-4222-8222-222222222222" as never;

describe("routes sheet columns", () => {
  it("adds an All column before the level columns on a multi-level router", () => {
    const columns = routesSheetColumns(17, true);
    expect(columns.map(({ label }) => label).slice(0, 3)).toEqual([
      "All",
      "L1",
      "L2",
    ]);
    expect(columns).toHaveLength(18);
    expect(columns[0]?.levels).toHaveLength(17);
    expect(columns[3]?.levels).toEqual([3]);
  });

  it("gives a single-level router one source column and no All column", () => {
    expect(routesSheetColumns(1, false)).toEqual([
      { id: "level:1", label: "Source", levels: [1] },
    ]);
    expect(routesSheetColumns(1, true).map(({ label }) => label)).toEqual([
      "L1",
    ]);
  });
});

describe("routes sheet cells", () => {
  const [all, one] = routesSheetColumns(2, true) as [
    ReturnType<typeof routesSheetColumns>[number],
    ReturnType<typeof routesSheetColumns>[number],
  ];
  const none = () => undefined;

  it("shows the shared source in All only when every level agrees", () => {
    expect(routesSheetCell(all, () => 4, none)).toEqual({
      kind: "source",
      source: 4,
      phase: null,
    });
    expect(routesSheetCell(all, (level) => level, none).kind).toBe("mixed");
  });

  it("is unknown until every level's route is known", () => {
    expect(
      routesSheetCell(all, (level) => (level === 1 ? 4 : undefined), none).kind,
    ).toBe("unknown");
    expect(routesSheetCell(one, () => undefined, none).kind).toBe("unknown");
  });

  it("shows a requested route over the observed one", () => {
    expect(
      routesSheetCell(
        one,
        () => 4,
        () => ({ source: 9, phase: "sending" }),
      ),
    ).toEqual({ kind: "source", source: 9, phase: "sending" });
  });
});

describe("routes sheet on a router that reports unassigned destinations", () => {
  const all = { id: "all", label: "All", levels: [1, 2] };
  const one = { id: "level:1", label: "L1", levels: [1] };
  const none = () => undefined;

  it("keeps an unassigned cell empty but routable", () => {
    expect(routesSheetCell(one, () => undefined, none, true)).toEqual({
      kind: "unknown",
      phase: null,
    });
    expect(routesSheetCell(all, () => undefined, none, true).kind).toBe(
      "unknown",
    );
  });

  it("shows a chosen source on an unassigned cell at once", () => {
    expect(
      routesSheetCell(
        one,
        () => undefined,
        () => ({ source: 9, phase: "sending" }),
        true,
      ),
    ).toEqual({ kind: "source", source: 9, phase: "sending" });
  });

  it("calls an All cell mixed when only some levels are unassigned", () => {
    expect(
      routesSheetCell(all, (level) => (level === 1 ? 4 : undefined), none, true)
        .kind,
    ).toBe("mixed");
  });
});

describe("disconnecting a destination with a typed dash", () => {
  const one = { id: "level:1", label: "L1", levels: [1] };
  const dash = {
    source: "choice",
    edits: [{ rowId: "13", columnId: "level:1", value: DISCONNECT_CHOICE }],
  };

  it("finds the Disconnect source by name", () => {
    const named = (label: string | null) => new Map([[97, label]]);
    for (const label of ["Disconnect", "DISCONNECT", "Disc", "DISCNCT", "Disconnect 1"])
      expect(disconnectSourceAddress(named(label))).toBe(97);
    for (const label of ["DISC PLYR", "Disco", "CAM 1", null])
      expect(disconnectSourceAddress(named(label))).toBeNull();
    expect(
      disconnectSourceAddress(
        new Map([
          [40, "Disconnect 2"],
          [12, "Disconnect 1"],
        ]),
      ),
    ).toBe(12);
  });

  it("offers only Disconnect for a lone dash", () => {
    const choices = routeChoicesWithDisconnect(
      [{ value: "3", label: "3 — HDR 1-1" }],
      97,
    );
    expect(choices("-").map(({ value }) => value)).toEqual([DISCONNECT_CHOICE]);
    expect(choices(" - ").map(({ value }) => value)).toEqual([DISCONNECT_CHOICE]);
    expect(choices("").map(({ value }) => value)).toEqual([
      DISCONNECT_CHOICE,
      "3",
    ]);
    expect(choices("").at(0)?.label).toBe("- Disconnect · 97");
  });

  it("routes the dash to the Disconnect source", () => {
    expect(routePickFromEdit(dash, [one], 97)).toEqual({
      destination: 13,
      source: 97,
      levels: [1],
    });
  });

  it("sends nothing when the router has no Disconnect source", () => {
    expect(routePickFromEdit(dash, [one], null)).toBeNull();
    expect(isDisconnectEdit(dash)).toBe(true);
    expect(
      isDisconnectEdit({ ...dash, source: "paste" }),
    ).toBe(false);
  });
});

describe("routes sheet destination search", () => {
  const rows = [
    { address: 1, label: "Program" },
    { address: 12, label: "Camera 1" },
    { address: 30, label: null },
  ];
  const matching = (search: string | null): readonly number[] =>
    routesSheetRowsMatching(rows, search).map(({ address }) => address);

  it("keeps the same rows when there is no search", () => {
    expect(routesSheetRowsMatching(rows, null)).toBe(rows);
  });

  it("finds a destination by any part of its name, ignoring case", () => {
    expect(matching("PROG")).toEqual([1]);
    expect(matching("camera")).toEqual([12]);
  });

  it("finds a destination by any part of its number", () => {
    expect(matching("30")).toEqual([30]);
    expect(matching("1")).toEqual([1, 12]);
  });

  it("returns nothing when no destination matches", () => {
    expect(matching("audio")).toEqual([]);
  });
});

describe("routes sheet edits", () => {
  const columns = routesSheetColumns(3, true);

  it("turns a pick in a level cell into a route for that level only", () => {
    expect(
      routePickFromEdit(
        {
          source: "choice",
          edits: [{ rowId: "7", columnId: "level:2", value: "12" }],
        },
        columns,
      ),
    ).toEqual({ destination: 7, source: 12, levels: [2] });
  });

  it("turns a pick in the All cell into a route for every level", () => {
    expect(
      routePickFromEdit(
        {
          source: "choice",
          edits: [{ rowId: "7", columnId: "all", value: "12" }],
        },
        columns,
      ),
    ).toEqual({ destination: 7, source: 12, levels: [1, 2, 3] });
  });

  it.each(["paste", "fill", "clear", "cut", "toggle"])(
    "never routes from %s",
    (source) => {
      expect(
        routePickFromEdit(
          {
            source,
            edits: [{ rowId: "7", columnId: "level:1", value: "12" }],
          },
          columns,
        ),
      ).toBeNull();
    },
  );

  it("labels choices the way the Button Matrix does", () => {
    expect(
      sourceChoices([
        { address: 3, label: "CAM C" },
        { address: 4, label: null },
      ]),
    ).toEqual([
      { value: "3", label: "3 — CAM C" },
      { value: "4", label: "4 — Unlabeled" },
    ]);
  });
});

describe("route results", () => {
  const pick: RoutePick = { destination: 5, source: 2, levels: [1, 2] };

  it("reports a partial failure against only the failed level", () => {
    const outcome = routeSendOutcome(pick, {
      status: "partial",
      operationId,
      outcomes: [
        {
          mappingId,
          source: 2,
          destination: 5,
          level: 1,
          outcome: "acknowledged",
        },
        { mappingId, source: 2, destination: 5, level: 2, outcome: "nak" },
      ],
    } as never);
    expect(outcome.succeededLevels).toEqual([1]);
    expect(outcome.failedLevels).toEqual([2]);
    expect(outcome.message).toContain("refused");
  });

  it("fails every level when the router rejects the request", () => {
    const outcome = routeSendOutcome(pick, {
      status: "rejected",
      operationId,
      code: "disconnected",
      message: "Router is disconnected",
    } as never);
    expect(outcome.failedLevels).toEqual([1, 2]);
    expect(outcome.message).toContain("Router is disconnected");
  });
});

function held() {
  let resolve!: (value: RouteSendOutcome) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RouteSendOutcome>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const truth = new Map<string, number>();
  const sends: { pick: RoutePick; hold: ReturnType<typeof held> }[] = [];
  const failed = vi.fn<(message: string) => void>();
  let now = 1000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const queue = new RouteSendQueue({
    send: (pick) => {
      const hold = held();
      sends.push({ pick, hold });
      return hold.promise;
    },
    read: (destination, level) =>
      truth.get(`${String(destination)}:${String(level)}`) ?? null,
    confirmTimeoutMs: () => 2000,
    onChange: () => undefined,
    onFailure: failed,
    clock: {
      now: () => now,
      setTimeout: (callback, delay) => {
        timers.set(++nextTimer, { at: now + delay, run: callback });
        return nextTimer;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  const acknowledged = (pick: RoutePick): RouteSendOutcome => ({
    succeededLevels: pick.levels,
    failedLevels: [],
    message: null,
  });
  return { queue, truth, sends, failed, advance, acknowledged };
}

describe("route send queue", () => {
  const first: RoutePick = { destination: 1, source: 9, levels: [1] };
  const second: RoutePick = { destination: 2, source: 8, levels: [1] };

  it("shows a pick at once and accepts a second pick while the first is held", async () => {
    const { queue, sends, truth, acknowledged } = setup();
    queue.enqueue(first);
    expect(queue.overlay(1, 1)).toEqual({ source: 9, phase: "sending" });

    queue.enqueue(second);
    expect(queue.overlay(2, 1)).toEqual({ source: 8, phase: "queued" });
    expect(sends).toHaveLength(1);

    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    expect(queue.overlay(1, 1)).toEqual({ source: 9, phase: "confirming" });
    expect(sends.map(({ pick }) => pick)).toEqual([first, second]);

    truth.set("1:1", 9);
    queue.observe();
    expect(queue.overlay(1, 1)).toBeUndefined();
    expect(queue.overlay(2, 1)).toEqual({ source: 8, phase: "sending" });
  });

  it("clears a cell as soon as the router already shows the route", async () => {
    const { queue, sends, truth, acknowledged } = setup();
    queue.enqueue(first);
    truth.set("1:1", 9);
    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    expect(queue.overlay(1, 1)).toBeUndefined();
  });

  it("rolls back only the failed pick and still sends the next one", async () => {
    const { queue, sends, failed } = setup();
    queue.enqueue(first);
    queue.enqueue(second);
    sends[0]!.hold.resolve({
      succeededLevels: [],
      failedLevels: [1],
      message: "Destination 1 wasn't routed",
    });
    await flush();
    expect(queue.overlay(1, 1)).toBeUndefined();
    expect(failed).toHaveBeenCalledWith("Destination 1 wasn't routed");
    expect(queue.overlay(2, 1)).toEqual({ source: 8, phase: "sending" });
    expect(sends[1]?.pick).toEqual(second);
  });

  it("rolls back when the command itself fails", async () => {
    const { queue, sends, failed } = setup();
    queue.enqueue(first);
    sends[0]!.hold.reject(new Error("bridge closed"));
    await flush();
    expect(queue.overlay(1, 1)).toBeUndefined();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("lets the newest pick for a target replace one that hasn't been sent", async () => {
    const { queue, sends, truth, acknowledged } = setup();
    queue.enqueue(first);
    queue.enqueue({ destination: 2, source: 3, levels: [1] });
    queue.enqueue(second);
    expect(queue.overlay(2, 1)).toEqual({ source: 8, phase: "queued" });
    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    truth.set("1:1", 9);
    queue.observe();
    expect(sends.map(({ pick }) => pick.source)).toEqual([9, 8]);
  });

  it("waits for a target's route to be observed before changing it again", async () => {
    const { queue, sends, truth, acknowledged } = setup();
    queue.enqueue(first);
    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    const again = { destination: 1, source: 4, levels: [1] };
    queue.enqueue(again);
    await flush();
    expect(sends).toHaveLength(1);
    expect(queue.overlay(1, 1)).toEqual({ source: 4, phase: "queued" });
    truth.set("1:1", 9);
    queue.observe();
    expect(sends[1]?.pick).toEqual(again);
  });

  it("reverts and says so when an acknowledged route is never observed", async () => {
    const { queue, sends, failed, advance, acknowledged } = setup();
    queue.enqueue(first);
    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    advance(2001);
    expect(queue.overlay(1, 1)).toBeUndefined();
    expect(failed.mock.calls[0]?.[0]).toContain("hasn't confirmed");
  });

  it("drops unsent routes instead of firing them after a reconnect", async () => {
    const { queue, sends, failed, acknowledged } = setup();
    queue.enqueue(first);
    queue.enqueue(second);
    queue.cancel("Dropped");
    expect(failed).toHaveBeenCalledWith("Dropped");
    expect(queue.overlay(1, 1)).toBeUndefined();
    expect(queue.overlay(2, 1)).toBeUndefined();
    sends[0]!.hold.resolve(acknowledged(first));
    await flush();
    expect(sends).toHaveLength(1);
  });
});
