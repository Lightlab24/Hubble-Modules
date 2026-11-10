import { describe, expect, it } from "vitest";
import {
  RouteCrosspointsRequestSchema,
  RouterSessionBootstrapSchema,
} from "../src/page-contract.js";
import {
  applyTakeResult,
  beginTake,
  canTake,
  changeStagedRoutes,
  createRouterState,
  draftCounts,
  stagedBatchSource,
  stageMapping,
  type RouterState,
  type StagedRouteChange,
} from "../src/frontend/router-state.js";
import {
  draftRouteOverlays,
  draftsNeedingAttention,
  routeCellKey,
  routesSheetColumns,
  stagedCellReplaces,
  stagedChangesFromEdit,
  type RouteEditBatch,
} from "../src/frontend/routes-sheet-model.js";

const LEVELS = 3;
const DESTINATIONS = 300;
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const version = { generation: uuid(4), revision: 8 };

function routerState(): RouterState {
  const entries = Array.from({ length: DESTINATIONS }, (_, index) => ({
    address: index + 1,
    label: `DST ${String(index + 1)}`,
    // Every destination starts on its own source, so a route is always visible.
    routes: Array.from({ length: LEVELS }, (_unused, level) => ({
      level: level + 1,
      source: index + 1,
    })),
  }));
  return createRouterState(
    RouterSessionBootstrapSchema.parse({
      listenerId: uuid(3),
      lastEventSequence: 4,
      connectionId: uuid(1),
      version,
      labelRevision: 3,
      transport: "connected",
      sync: "ready",
      labels: "ready",
      requestTimeoutMs: 1000,
      levels: LEVELS,
      extended: false,
      knownSourceCount: DESTINATIONS + 100,
      knownDestinationCount: DESTINATIONS,
      knownCrosspointCount: DESTINATIONS * LEVELS,
      sources: {
        resource: "sources",
        version,
        labelRevision: 3,
        entries: Array.from({ length: DESTINATIONS + 100 }, (_, index) => ({
          address: index + 1,
          label: `SRC ${String(index + 1)}`,
        })),
        nextAfterAddress: null,
        totalCount: DESTINATIONS + 100,
      },
      destinations: {
        resource: "destinations",
        version,
        labelRevision: 3,
        entries,
        nextAfterAddress: null,
        totalCount: DESTINATIONS,
      },
    }),
  );
}

let nextId = 100;
const ids = (): string => uuid(nextId++);

function apply(
  state: RouterState,
  changes: readonly StagedRouteChange[],
): RouterState {
  const result = changeStagedRoutes(state, changes, ids);
  expect(result.outcome).toBe("changed");
  return result.state;
}

const pick = (
  destination: number,
  source: number | null,
  levels: readonly number[] = [1, 2, 3],
): StagedRouteChange => ({ destination, source, levels });

/** Every staged crosspoint as "destination:level" to source. */
function staged(state: RouterState): Record<string, number> {
  return Object.fromEntries(
    [...draftRouteOverlays(state.drafts)].map(([key, { source }]) => [
      key,
      source,
    ]),
  );
}

describe("staging several routes from the sheet", () => {
  it("keeps the earlier picks when another destination is picked", () => {
    let state = apply(routerState(), [pick(1, 50)]);
    state = apply(state, [pick(2, 50)]);
    state = apply(state, [pick(3, 50)]);
    expect(draftCounts(state).mappings).toBe(3);
  });

  it("holds a different source on each destination and can still Take", () => {
    let state = apply(routerState(), [pick(1, 50)]);
    state = apply(state, [pick(2, 51)]);
    expect(staged(state)).toMatchObject({ "1:1": 50, "2:1": 51 });
    expect(stagedBatchSource(state.drafts)).toBeNull();
    expect(canTake(state)).toBe(true);
  });

  it("holds different sources on different levels of one destination", () => {
    let state = apply(routerState(), [pick(1, 50, [1])]);
    state = apply(state, [pick(1, 51, [2])]);
    expect(staged(state)).toEqual({ "1:1": 50, "1:2": 51 });
    expect(canTake(state)).toBe(true);
  });

  it("counts one source on several levels of a destination as one route", () => {
    let state = apply(routerState(), [pick(1, 50, [1])]);
    state = apply(state, [pick(1, 50, [3])]);
    expect(draftCounts(state)).toEqual({ mappings: 1, crosspoints: 2 });
    expect(state.drafts[0]?.levels).toEqual([1, 3]);
  });

  it("replaces only the level that was picked again", () => {
    let state = apply(routerState(), [pick(1, 50)]);
    state = apply(state, [pick(1, 51, [2])]);
    expect(staged(state)).toEqual({ "1:1": 50, "1:2": 51, "1:3": 50 });
  });

  it("lets a pick in All replace picks on single levels", () => {
    let state = apply(routerState(), [pick(1, 50, [1]), pick(1, 51, [2])]);
    state = apply(state, [pick(1, 52)]);
    expect(staged(state)).toEqual({ "1:1": 52, "1:2": 52, "1:3": 52 });
    expect(draftCounts(state).mappings).toBe(1);
  });

  it("applies a whole paste as one change, with later cells winning", () => {
    const state = apply(routerState(), [
      pick(1, 50),
      pick(1, 51, [2]),
      pick(2, 52),
    ]);
    expect(staged(state)).toEqual({
      "1:1": 50,
      "1:2": 51,
      "1:3": 50,
      "2:1": 52,
      "2:2": 52,
      "2:3": 52,
    });
  });

  it("takes a level back out when it is set to what the router already has", () => {
    let state = apply(routerState(), [pick(1, 50), pick(2, 51)]);
    state = apply(state, [pick(1, 1, [2])]);
    expect(staged(state)).toEqual({
      "1:1": 50,
      "1:3": 50,
      "2:1": 51,
      "2:2": 51,
      "2:3": 51,
    });
  });

  it("does nothing when the router already has every chosen route", () => {
    const state = routerState();
    expect(changeStagedRoutes(state, [pick(1, 1)], ids)).toEqual({
      state,
      outcome: "unchanged",
    });
  });

  it("removes only the cells that were cleared", () => {
    let state = apply(routerState(), [pick(1, 50), pick(2, 51)]);
    state = apply(state, [pick(1, null, [1])]);
    expect(staged(state)).toEqual({
      "1:2": 50,
      "1:3": 50,
      "2:1": 51,
      "2:2": 51,
      "2:3": 51,
    });
    state = apply(state, [pick(2, null)]);
    expect(Object.keys(staged(state))).toEqual(["1:2", "1:3"]);
  });

  it("says nothing changed when Delete lands on cells with nothing staged", () => {
    const state = apply(routerState(), [pick(1, 50)]);
    expect(changeStagedRoutes(state, [pick(9, null)], ids).outcome).toBe(
      "unchanged",
    );
  });

  it("applies none of a gesture when one target is out of range", () => {
    const state = apply(routerState(), [pick(1, 50)]);
    const result = changeStagedRoutes(
      state,
      [pick(2, 51), pick(3, 52, [LEVELS + 1])],
      ids,
    );
    expect(result).toEqual({ state, outcome: "invalid" });
  });

  it("refuses more routes than one Take can send and keeps what was staged", () => {
    const state = apply(routerState(), [pick(1, 50)]);
    // Source 350 isn't on any destination yet, so all 256 are real changes.
    const tooMany = Array.from({ length: 256 }, (_, index) =>
      pick(index + 2, 350),
    );
    const result = changeStagedRoutes(state, tooMany, ids);
    expect(result).toEqual({ state, outcome: "capacity" });
    expect(draftCounts(result.state).mappings).toBe(1);
  });

  it("refuses to change anything while a Take is running", () => {
    const state = beginTake(apply(routerState(), [pick(1, 50)]), uuid(7));
    expect(changeStagedRoutes(state, [pick(2, 51)], ids)).toEqual({
      state,
      outcome: "unavailable",
    });
  });

  it("sends a mixed batch as one valid Take and settles each level", () => {
    let state = apply(routerState(), [pick(1, 50, [1]), pick(1, 51, [2])]);
    state = apply(state, [pick(2, 52)]);
    state = beginTake(state, uuid(7));
    const request = RouteCrosspointsRequestSchema.parse({
      operationId: uuid(7),
      connectionId: state.connectionId,
      version: state.version,
      mappings: state.drafts.map((draft) => ({
        mappingId: draft.mappingId,
        source: draft.source,
        destination: draft.destination,
        levels: draft.levels,
        expected: draft.expected,
      })),
    });
    expect(request.mappings).toHaveLength(3);

    state = applyTakeResult(state, {
      status: "acknowledged",
      operationId: uuid(7),
      outcomes: request.mappings.flatMap((mapping) =>
        mapping.levels.map((level) => ({
          mappingId: mapping.mappingId,
          source: mapping.source,
          destination: mapping.destination,
          level,
          outcome: "acknowledged",
        })),
      ),
    });
    expect(state.drafts.map(({ status }) => status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("keeps staging around a route that needs attention, without replacing it", () => {
    const first = apply(routerState(), [pick(1, 50)]);
    const taken = beginTake(first, uuid(7));
    const failed = applyTakeResult(taken, {
      status: "rejected",
      operationId: uuid(7),
      code: "disconnected",
      message: "Router went away.",
    });
    expect(draftsNeedingAttention(failed.drafts)).toHaveLength(1);
    const state = apply(failed, [pick(2, 51)]);
    expect(state.drafts.map(({ status }) => status)).toEqual([
      "failed",
      "staged",
    ]);
    expect(draftsNeedingAttention(state.drafts)).toHaveLength(1);
  });
});

describe("the Patch view after the sheet has staged routes", () => {
  it("keeps its one-source rule on a one-source batch", () => {
    const state = apply(routerState(), [pick(1, 50)]);
    expect(stagedBatchSource(state.drafts)).toBe(50);
    expect(
      stageMapping(state, { source: 51, destination: 2, levels: [1] }, ids),
    ).toBe(state);
  });

  it("can add to a batch that already has mixed sources", () => {
    const state = apply(routerState(), [pick(1, 50), pick(2, 51)]);
    const next = stageMapping(
      state,
      { source: 60, destination: 3, levels: [1] },
      ids,
    );
    expect(draftCounts(next).mappings).toBe(3);
  });
});

describe("reading a sheet gesture", () => {
  const columns = routesSheetColumns(LEVELS, true);
  const isSource = (source: number): boolean => source >= 1 && source <= 100;
  const edit = (rowId: string, columnId: string, value: string) => ({
    rowId,
    columnId,
    value,
  });
  const read = (batch: RouteEditBatch) =>
    stagedChangesFromEdit(batch, columns, isSource);

  it("turns a pick into a change for that cell's levels", () => {
    expect(
      read({ source: "choice", edits: [edit("4", "level:2", "9")] }),
    ).toEqual([{ destination: 4, levels: [2], source: 9 }]);
  });

  it("turns every pasted or filled cell into a change", () => {
    for (const source of ["paste", "fill"]) {
      expect(
        read({
          source,
          edits: [edit("4", "all", "9"), edit("5", "level:1", " 10 ")],
        }),
      ).toEqual([
        { destination: 4, levels: [1, 2, 3], source: 9 },
        { destination: 5, levels: [1], source: 10 },
      ]);
    }
  });

  it("leaves a cell alone when a paste has a blank for it", () => {
    expect(
      read({
        source: "paste",
        edits: [edit("4", "level:1", ""), edit("5", "level:1", "9")],
      }),
    ).toEqual([{ destination: 5, levels: [1], source: 9 }]);
  });

  it("turns Delete into taking the route back out", () => {
    expect(read({ source: "clear", edits: [edit("4", "all", "")] })).toEqual([
      { destination: 4, levels: [1, 2, 3], source: null },
    ]);
  });

  it("refuses the whole paste when one value isn't a source here", () => {
    for (const value of ["101", "Cam A", "1e1", "2.5", "-3"]) {
      expect(
        read({
          source: "paste",
          edits: [edit("4", "level:1", "9"), edit("5", "level:1", value)],
        }),
      ).toBeNull();
    }
  });

  it("refuses gestures that aren't routes", () => {
    expect(
      read({ source: "toggle", edits: [edit("4", "level:1", "9")] }),
    ).toBeNull();
    expect(
      read({ source: "paste", edits: [edit("4", "nope", "9")] }),
    ).toBeNull();
  });
});

describe("hover text on a staged cell", () => {
  const [all, levelOne] = routesSheetColumns(2, true);
  const labels = new Map<number, string | null>([
    [8, "Cam C"],
    [9, null],
  ]);
  const staged = (source: number) => () => ({
    source,
    phase: "staged" as const,
  });

  it("names what the cell will replace", () => {
    expect(stagedCellReplaces(levelOne!, () => 8, staged(5), labels)).toBe(
      "Replaces 8 Cam C",
    );
    expect(stagedCellReplaces(levelOne!, () => 9, staged(5), labels)).toBe(
      "Replaces 9",
    );
  });

  it("says when levels disagree or nothing is routed", () => {
    expect(
      stagedCellReplaces(all!, (level) => level + 7, staged(5), labels),
    ).toBe("Replaces mixed sources");
    expect(stagedCellReplaces(levelOne!, () => null, staged(5), labels)).toBe(
      "Replaces nothing routed",
    );
  });

  it("has nothing to say on a cell that isn't staged", () => {
    expect(
      stagedCellReplaces(
        levelOne!,
        () => 8,
        () => undefined,
        labels,
      ),
    ).toBeUndefined();
    expect(
      stagedCellReplaces(
        levelOne!,
        () => 8,
        () => ({ source: 5, phase: "sending" }),
        labels,
      ),
    ).toBeUndefined();
  });
});

describe("cell keys used across staging", () => {
  it("match the draft overlay keys", () => {
    const state = apply(routerState(), [pick(7, 50, [2])]);
    expect(draftRouteOverlays(state.drafts).get(routeCellKey(7, 2))).toEqual({
      source: 50,
      phase: "staged",
    });
  });
});
