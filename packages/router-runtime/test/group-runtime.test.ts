import { describe, expect, it, vi } from "vitest";

import type {
  ManagedRouterConnectionSnapshot,
  RouterConfirmedRouteTargetSnapshot,
  RouterDirectRouteInput,
  RouterDirectRouteSubmission,
} from "../src/connection-contract.js";
import {
  RossRouteGroupRuntime,
  type PersistedRossRouteGroupRuntimeState,
  type PersistedRossRouteModuleSequenceRuntimeState,
  type RossGroupRuntimeStateStore,
  type RossRouteGroupConnectionManager,
  type RossRouteGroupModuleScope,
  type RossRouteGroupStateTransition,
} from "../src/group-runtime.js";

const WORKSPACE_1 = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_2 = "10000000-0000-4000-8000-000000000002";
const MODULE_1 = "20000000-0000-4000-8000-000000000001";
const MODULE_2 = "20000000-0000-4000-8000-000000000002";
const MODULE_3 = "20000000-0000-4000-8000-000000000003";
const CONNECTION_1 = "30000000-0000-4000-8000-000000000001";
const CONNECTION_2 = "30000000-0000-4000-8000-000000000002";
const GROUP_1 = "40000000-0000-4000-8000-000000000001";
const GROUP_2 = "40000000-0000-4000-8000-000000000002";
const GROUP_3 = "40000000-0000-4000-8000-000000000003";
const STREAM_ID = "50000000-0000-4000-8000-000000000001";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface ControlledSubmission {
  readonly input: RouterDirectRouteInput;
  readonly submissionId: string;
  readonly accepted: ReturnType<typeof deferred<void>>;
  readonly settled: ReturnType<typeof deferred<void>>;
}

interface ActiveWatch {
  readonly connectionId: string;
  readonly destination: number;
  readonly levels: readonly number[];
  readonly listener: (snapshot: RouterConfirmedRouteTargetSnapshot) => void;
  active: boolean;
}

class FakeConnections implements RossRouteGroupConnectionManager {
  readonly submissions: ControlledSubmission[] = [];
  readonly watches: ActiveWatch[] = [];
  readonly immediateReadySources = new Map<
    string,
    ReadonlyMap<number, number>
  >();
  readonly levelCounts = new Map<string, number>([
    [CONNECTION_1, 4],
    [CONNECTION_2, 3],
  ]);
  acceptImmediately = true;
  definitionRevision = 1;

  snapshots(): readonly ManagedRouterConnectionSnapshot[] {
    return [...this.levelCounts].map(
      ([connectionId, levels]) =>
        ({
          definition: {
            connectionId,
            type: "ross-swp08",
            levels,
            name: `Router definition ${String(this.definitionRevision)}`,
          },
        }) as unknown as ManagedRouterConnectionSnapshot,
    );
  }

  submitDirectRouteTracked(
    input: RouterDirectRouteInput,
  ): RouterDirectRouteSubmission {
    const accepted = deferred<void>();
    const settled = deferred<void>();
    const submissionId = `fake:${String(this.submissions.length + 1)}`;
    this.submissions.push({ input, submissionId, accepted, settled });
    if (this.acceptImmediately) accepted.resolve(undefined);
    return {
      submissionId,
      accepted: accepted.promise,
      settled: settled.promise,
    };
  }

  watchConfirmedRouteTarget(
    target: {
      readonly connectionId: string;
      readonly destination: number;
      readonly levels: readonly number[];
    },
    listener: (snapshot: RouterConfirmedRouteTargetSnapshot) => void,
  ): () => void {
    const watch: ActiveWatch = { ...target, listener, active: true };
    this.watches.push(watch);
    const immediateReady = this.immediateReadySources.get(
      `${target.connectionId}:${String(target.destination)}`,
    );
    listener(
      immediateReady === undefined
        ? Object.freeze({
            ...target,
            phase: "pending" as const,
            sourcesByLevel: new Map<number, number>(),
            lastError: null,
          })
        : Object.freeze({
            ...target,
            phase: "ready" as const,
            sourcesByLevel: new Map(
              target.levels.flatMap((level) => {
                const source = immediateReady.get(level);
                return source === undefined ? [] : [[level, source] as const];
              }),
            ),
            lastError: null,
          }),
    );
    return () => {
      watch.active = false;
    };
  }

  publishReady(
    connectionId: string,
    destination: number,
    sourcesByLevel: ReadonlyMap<number, number>,
  ): void {
    for (const watch of this.watches) {
      if (
        !watch.active ||
        watch.connectionId !== connectionId ||
        watch.destination !== destination
      ) {
        continue;
      }
      watch.listener(
        Object.freeze({
          connectionId,
          destination,
          levels: watch.levels,
          phase: "ready" as const,
          sourcesByLevel: new Map(
            watch.levels.flatMap((level) => {
              const source = sourcesByLevel.get(level);
              return source === undefined ? [] : [[level, source] as const];
            }),
          ),
          lastError: null,
        }),
      );
    }
  }

  publishPending(
    connectionId: string,
    destination: number,
    lastError: string,
  ): void {
    for (const watch of this.watches) {
      if (
        !watch.active ||
        watch.connectionId !== connectionId ||
        watch.destination !== destination
      ) {
        continue;
      }
      watch.listener(
        Object.freeze({
          connectionId,
          destination,
          levels: watch.levels,
          phase: "pending" as const,
          sourcesByLevel: new Map<number, number>(),
          lastError,
        }),
      );
    }
  }
}

class FakeStateStore implements RossGroupRuntimeStateStore {
  readonly groups = new Map<string, PersistedRossRouteGroupRuntimeState>();
  readonly modules = new Map<
    string,
    PersistedRossRouteModuleSequenceRuntimeState
  >();
  readonly appliedTransitions: RossRouteGroupStateTransition[] = [];
  readonly reconciliations: {
    readonly workspaceId: string;
    readonly moduleConnectionId: string;
    readonly groupIds: readonly string[];
  }[][] = [];
  flushCount = 0;
  closeCount = 0;
  failGroupWrites = false;
  failModuleWrites = false;
  nextTransitionResult: "applied" | "already-applied" = "applied";

  constructor(
    groups: readonly PersistedRossRouteGroupRuntimeState[] = [],
    modules: readonly PersistedRossRouteModuleSequenceRuntimeState[] = [],
  ) {
    for (const group of groups)
      this.groups.set(groupStateKey(group), cloneGroup(group));
    for (const module of modules)
      this.modules.set(moduleStateKey(module), { ...module });
  }

  snapshot(): Promise<readonly PersistedRossRouteGroupRuntimeState[]> {
    return Promise.resolve([...this.groups.values()].map(cloneGroup));
  }

  moduleSnapshot(): Promise<
    readonly PersistedRossRouteModuleSequenceRuntimeState[]
  > {
    return Promise.resolve(
      [...this.modules.values()].map((module) => ({ ...module })),
    );
  }

  upsert(state: PersistedRossRouteGroupRuntimeState): Promise<void> {
    if (this.failGroupWrites)
      return Promise.reject(new Error("group disk full"));
    this.groups.set(groupStateKey(state), cloneGroup(state));
    return Promise.resolve();
  }

  upsertModuleSequenceState(
    state: PersistedRossRouteModuleSequenceRuntimeState,
  ): Promise<void> {
    if (this.failModuleWrites)
      return Promise.reject(new Error("module disk full"));
    this.modules.set(moduleStateKey(state), { ...state });
    return Promise.resolve();
  }

  clearWorkspace(workspaceId: string): Promise<void> {
    for (const [key, group] of this.groups) {
      if (group.workspaceId === workspaceId) this.groups.delete(key);
    }
    for (const [key, module] of this.modules) {
      if (module.workspaceId === workspaceId) this.modules.delete(key);
    }
    return Promise.resolve();
  }

  reconcileScopes(
    scopes: readonly {
      readonly workspaceId: string;
      readonly moduleConnectionId: string;
      readonly groupIds: readonly string[];
    }[],
  ): Promise<void> {
    this.reconciliations.push(scopes.map((scope) => ({ ...scope })));
    return Promise.resolve();
  }

  applyTransition(
    transition: RossRouteGroupStateTransition,
  ): Promise<"applied" | "already-applied"> {
    const result = this.nextTransitionResult;
    this.nextTransitionResult = "applied";
    if (result === "already-applied") return Promise.resolve(result);
    this.appliedTransitions.push(transition);
    if (transition.operation === "move") {
      const fromKey = groupStateKey({
        ...transition,
        groupId: transition.fromGroupId,
      });
      const source = this.groups.get(fromKey);
      if (source !== undefined) {
        this.groups.delete(fromKey);
        const moved = cloneGroup({
          ...source,
          groupId: transition.toGroupId,
          enabled:
            transition.toGroupId === null ? true : (source.enabled ?? true),
        });
        this.groups.set(groupStateKey(moved), moved);
      }
    } else if (transition.operation === "discard-group") {
      this.groups.delete(groupStateKey(transition));
    } else if (transition.operation === "discard-module") {
      for (const [key, group] of this.groups) {
        if (
          group.workspaceId === transition.workspaceId &&
          group.moduleConnectionId === transition.moduleConnectionId
        ) {
          this.groups.delete(key);
        }
      }
      this.modules.delete(moduleStateKey(transition));
    } else {
      void this.clearWorkspace(transition.workspaceId);
    }
    return Promise.resolve(result);
  }

  flush(): Promise<void> {
    this.flushCount += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

function moduleScope(
  overrides: Partial<RossRouteGroupModuleScope> = {},
): RossRouteGroupModuleScope {
  return {
    workspaceId: WORKSPACE_1,
    moduleConnectionId: MODULE_1,
    connectionId: CONNECTION_1,
    automaticTake: false,
    groupIds: [GROUP_1, GROUP_2],
    ...overrides,
  };
}

function actionScope(
  overrides: Partial<{
    workspaceId: string;
    moduleConnectionId: string;
    connectionId: string;
    groupId: string | null;
  }> = {},
) {
  return {
    workspaceId: WORKSPACE_1,
    moduleConnectionId: MODULE_1,
    connectionId: CONNECTION_1,
    groupId: GROUP_1,
    ...overrides,
  };
}

function readyRoutes(source: number, levels: readonly number[] = [1, 2, 3, 4]) {
  return new Map(levels.map((level) => [level, source] as const));
}

async function makeRuntime(
  scopes: readonly RossRouteGroupModuleScope[] = [moduleScope()],
  store = new FakeStateStore(),
  connections = new FakeConnections(),
  onDiagnostic?: ConstructorParameters<
    typeof RossRouteGroupRuntime
  >[0]["onDiagnostic"],
) {
  const runtime = new RossRouteGroupRuntime({
    connections,
    stateStore: store,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
  await runtime.reconcile(scopes);
  return { connections, runtime, store };
}

describe("RossRouteGroupRuntime", () => {
  it("waits for durable toggle persistence and suppresses stale route-callback writes", async () => {
    const store = new FakeStateStore();
    const { connections, runtime } = await makeRuntime([moduleScope()], store);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    const persisted = deferred<undefined>();
    const writeStarted = deferred<undefined>();
    const originalUpsert = store.upsert.bind(store);
    const upsert = vi
      .spyOn(store, "upsert")
      .mockImplementationOnce(async (state) => {
        writeStarted.resolve(undefined);
        await persisted.promise;
        await originalUpsert(state);
      });
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    listener.mockClear();
    let completed = false;

    const toggle = runtime
      .toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 })
      .then(() => {
        completed = true;
      });
    await writeStarted.promise;

    expect(completed).toBe(false);
    expect(runtime.snapshots()[0]?.enabled).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    await expect(
      runtime.selectDestination({ ...actionScope(), destination: 8 }),
    ).rejects.toThrow("Routing group toggle is in progress");
    await expect(
      runtime.toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 }),
    ).rejects.toThrow("Routing group toggle is already in progress");
    expect(runtime.snapshots()[0]?.selectedDestination).toBe(7);

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim).toMatchObject({
        source: 21,
        destination: 7,
        levels: [1],
        takeSequence: 1,
      });
    });
    expect(upsert).toHaveBeenCalledOnce();
    listener.mockClear();

    persisted.resolve(undefined);
    await toggle;
    expect(completed).toBe(true);
    expect(runtime.snapshots()[0]).toMatchObject({
      enabled: false,
      stagedSource: null,
      stagedLevels: [],
      selectedDestination: null,
      routeClaim: null,
      feedbackClaim: null,
      pendingRouteClaims: new Map(),
      confirmedRoute: null,
    });
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ groupId: GROUP_1, enabled: false }),
      expect.objectContaining({ groupId: GROUP_2, enabled: true }),
    ]);
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledOnce();
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      enabled: false,
      selectedDestination: null,
      levels: [],
      committedTakeSequence: null,
    });
    unsubscribe();
  });

  it("keeps runtime routing state intact and propagates a failed toggle write", async () => {
    const diagnostics = vi.fn();
    const { connections, runtime, store } = await makeRuntime(
      [moduleScope()],
      new FakeStateStore(),
      new FakeConnections(),
      diagnostics,
    );
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    const before = runtime.snapshots()[0];
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    listener.mockClear();
    store.failGroupWrites = true;

    await expect(
      runtime.toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 }),
    ).rejects.toThrow("group disk full");

    expect(runtime.snapshots()[0]).toEqual(before);
    expect(connections.watches.some((watch) => watch.active)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith({
      code: "ross_route_group_state_write_failed",
      message: "persist group toggle state failed: group disk full",
      workspaceId: WORKSPACE_1,
      moduleConnectionId: MODULE_1,
      groupId: GROUP_1,
    });
    unsubscribe();
    store.failGroupWrites = false;
    await expect(
      runtime.selectDestination({ ...actionScope(), destination: 8 }),
    ).resolves.toBeUndefined();
  });

  it("durably resyncs callback state when a pending toggle write fails", async () => {
    const store = new FakeStateStore();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime([moduleScope()], store, connections);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    const releaseFailure = deferred<undefined>();
    vi.spyOn(store, "upsert").mockImplementationOnce(async () => {
      await releaseFailure.promise;
      throw new Error("group disk full");
    });

    const toggle = runtime.toggleGroupEnabled({
      ...actionScope(),
      groupId: GROUP_1,
    });
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim).toMatchObject({
        source: 21,
        destination: 7,
        levels: [1],
        takeSequence: 1,
      });
    });

    releaseFailure.resolve(undefined);
    await expect(toggle).rejects.toThrow("group disk full");

    const snapshot = runtime.snapshots()[0];
    expect(snapshot).toMatchObject({
      enabled: true,
      stagedSource: 21,
      stagedLevels: [1],
      selectedDestination: 7,
    });
    expect(snapshot?.routeClaim?.takeSequence).toBe(1);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      enabled: true,
      selectedDestination: 7,
      levels: [1],
      committedTakeSequence: 1,
    });
  });

  it("persists a settlement that lands in the failed-toggle resync handoff", async () => {
    const store = new FakeStateStore();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime([moduleScope()], store, connections);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    const toggleWriteStarted = deferred<undefined>();
    const releaseToggleFailure = deferred<undefined>();
    const resyncWriteStarted = deferred<PersistedRossRouteGroupRuntimeState>();
    const releaseResyncWrite = deferred<undefined>();
    const originalUpsert = store.upsert.bind(store);
    const upsert = vi
      .spyOn(store, "upsert")
      .mockImplementationOnce(async () => {
        toggleWriteStarted.resolve(undefined);
        await releaseToggleFailure.promise;
        throw new Error("group disk full");
      })
      .mockImplementationOnce((state) => {
        resyncWriteStarted.resolve(cloneGroup(state));
        return releaseResyncWrite.promise;
      })
      .mockImplementation(originalUpsert);

    const toggleFailure = runtime
      .toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 })
      .catch((error: unknown) => error);
    await toggleWriteStarted.promise;
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    releaseToggleFailure.resolve(undefined);

    const resyncState = await resyncWriteStarted.promise;
    await originalUpsert(resyncState);
    releaseResyncWrite.resolve(undefined);
    connections.submissions[0]?.settled.resolve(undefined);

    const error = await toggleFailure;
    expect(error).toEqual(
      expect.objectContaining({ message: "group disk full" }),
    );
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim).toMatchObject({
        source: 21,
        destination: 7,
        levels: [1],
        takeSequence: 1,
      });
      expect(
        store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
      ).toMatchObject({
        enabled: true,
        selectedDestination: 7,
        levels: [1],
        committedTakeSequence: 1,
      });
    });
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it("finishes failed-toggle resync before discarding the group record", async () => {
    const store = new FakeStateStore();
    const { runtime } = await makeRuntime([moduleScope()], store);
    const toggleWriteStarted = deferred<undefined>();
    const releaseToggleFailure = deferred<undefined>();
    const upsert = vi
      .spyOn(store, "upsert")
      .mockImplementationOnce(async () => {
        toggleWriteStarted.resolve(undefined);
        await releaseToggleFailure.promise;
        throw new Error("group disk full");
      });
    const applyTransition = vi.spyOn(store, "applyTransition");
    const toggleFailure = runtime
      .toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 })
      .catch((error: unknown) => error);
    await toggleWriteStarted.promise;

    const discard = runtime.applyTransition(
      transition({
        operation: "discard-group",
        workspaceId: WORKSPACE_1,
        moduleConnectionId: MODULE_1,
        groupId: GROUP_1,
      }),
    );
    await Promise.resolve();
    expect(applyTransition).not.toHaveBeenCalled();

    releaseToggleFailure.resolve(undefined);
    expect(await toggleFailure).toEqual(
      expect.objectContaining({ message: "group disk full" }),
    );
    await expect(discard).resolves.toBe("applied");

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.invocationCallOrder[1]).toBeLessThan(
      applyTransition.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(store.groups.has(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)).toBe(
      false,
    );
    expect(
      runtime.snapshots().some((snapshot) => snapshot.groupId === GROUP_1),
    ).toBe(false);
  });

  it("rejects a group toggle while an affecting transition is in flight", async () => {
    const store = new FakeStateStore();
    const { runtime } = await makeRuntime([moduleScope()], store);
    const transitionStarted = deferred<undefined>();
    const releaseTransition = deferred<undefined>();
    const originalApplyTransition = store.applyTransition.bind(store);
    vi.spyOn(store, "applyTransition").mockImplementationOnce(async (value) => {
      transitionStarted.resolve(undefined);
      await releaseTransition.promise;
      return originalApplyTransition(value);
    });
    const upsert = vi.spyOn(store, "upsert");
    const discard = runtime.applyTransition(
      transition({
        operation: "discard-group",
        workspaceId: WORKSPACE_1,
        moduleConnectionId: MODULE_1,
        groupId: GROUP_1,
      }),
    );
    await transitionStarted.promise;

    await expect(
      runtime.toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 }),
    ).rejects.toThrow("Routing group transition is in progress");
    expect(upsert).not.toHaveBeenCalled();

    releaseTransition.resolve(undefined);
    await expect(discard).resolves.toBe("applied");
  });

  it("defers settlement persistence during a move and flushes it only under the target key", async () => {
    const store = new FakeStateStore();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime([moduleScope()], store, connections);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    const transitionStarted = deferred<undefined>();
    const releaseTransition = deferred<undefined>();
    const originalApplyTransition = store.applyTransition.bind(store);
    vi.spyOn(store, "applyTransition").mockImplementationOnce(async (value) => {
      const result = await originalApplyTransition(value);
      transitionStarted.resolve(undefined);
      await releaseTransition.promise;
      return result;
    });
    const upsert = vi.spyOn(store, "upsert");

    const move = runtime.applyTransition(
      transition({
        operation: "move",
        workspaceId: WORKSPACE_1,
        moduleConnectionId: MODULE_1,
        fromGroupId: GROUP_1,
        toGroupId: GROUP_2,
      }),
    );
    await transitionStarted.promise;
    expect(store.groups.has(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)).toBe(
      false,
    );
    await expect(
      runtime.selectSource({ ...actionScope(), source: 22, levels: [1] }),
    ).rejects.toThrow("Routing group transition is in progress");

    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim?.takeSequence).toBe(1);
    });
    expect(upsert).not.toHaveBeenCalled();

    releaseTransition.resolve(undefined);
    await expect(move).resolves.toBe("applied");
    await vi.waitFor(() => {
      expect(
        store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_2}`),
      ).toMatchObject({
        groupId: GROUP_2,
        enabled: true,
        selectedDestination: 7,
        levels: [1],
        committedTakeSequence: 1,
      });
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]?.[0].groupId).toBe(GROUP_2);
    expect(store.groups.has(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)).toBe(
      false,
    );
  });

  it("carries deferred settlement persistence through overlapping chained moves", async () => {
    const store = new FakeStateStore();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime(
      [moduleScope({ groupIds: [GROUP_1, GROUP_2, GROUP_3] })],
      store,
      connections,
    );
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    const firstMoveStarted = deferred<undefined>();
    const releaseFirstMove = deferred<undefined>();
    const secondMoveStarted = deferred<undefined>();
    const releaseSecondMove = deferred<undefined>();
    const originalApplyTransition = store.applyTransition.bind(store);
    vi.spyOn(store, "applyTransition")
      .mockImplementationOnce(async (value) => {
        const result = await originalApplyTransition(value);
        firstMoveStarted.resolve(undefined);
        await releaseFirstMove.promise;
        return result;
      })
      .mockImplementationOnce(async (value) => {
        const result = await originalApplyTransition(value);
        secondMoveStarted.resolve(undefined);
        await releaseSecondMove.promise;
        return result;
      });
    const upsert = vi.spyOn(store, "upsert");

    const firstMove = runtime.applyTransition(
      transition(
        {
          operation: "move",
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_1,
          fromGroupId: GROUP_1,
          toGroupId: GROUP_2,
        },
        41,
      ),
    );
    await firstMoveStarted.promise;
    const secondMove = runtime.applyTransition(
      transition(
        {
          operation: "move",
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_1,
          fromGroupId: GROUP_2,
          toGroupId: GROUP_3,
        },
        42,
      ),
    );
    await secondMoveStarted.promise;

    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim?.takeSequence).toBe(1);
    });
    expect(upsert).not.toHaveBeenCalled();

    releaseFirstMove.resolve(undefined);
    await expect(firstMove).resolves.toBe("applied");
    expect(upsert).not.toHaveBeenCalled();

    releaseSecondMove.resolve(undefined);
    await expect(secondMove).resolves.toBe("applied");
    await vi.waitFor(() => {
      expect(
        store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_3}`),
      ).toMatchObject({
        groupId: GROUP_3,
        enabled: true,
        selectedDestination: 7,
        levels: [1],
        committedTakeSequence: 1,
      });
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]?.[0].groupId).toBe(GROUP_3);
    expect(store.groups.has(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)).toBe(
      false,
    );
    expect(store.groups.has(`${WORKSPACE_1}:${MODULE_1}:${GROUP_2}`)).toBe(
      false,
    );
    expect(runtime.snapshots()).toHaveLength(1);
    expect(runtime.snapshots()[0]?.groupId).toBe(GROUP_3);
    expect(runtime.snapshots()[0]?.routeClaim?.takeSequence).toBe(1);
  });

  it("finishes failed-toggle resync before durably clearing its workspace", async () => {
    const store = new FakeStateStore();
    const { runtime } = await makeRuntime([moduleScope()], store);
    const toggleWriteStarted = deferred<undefined>();
    const releaseToggleFailure = deferred<undefined>();
    const upsert = vi
      .spyOn(store, "upsert")
      .mockImplementationOnce(async () => {
        toggleWriteStarted.resolve(undefined);
        await releaseToggleFailure.promise;
        throw new Error("group disk full");
      });
    const clearWorkspace = vi.spyOn(store, "clearWorkspace");
    const toggleFailure = runtime
      .toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 })
      .catch((error: unknown) => error);
    await toggleWriteStarted.promise;

    const clear = runtime.clearWorkspace(WORKSPACE_1);
    await Promise.resolve();
    expect(clearWorkspace).not.toHaveBeenCalled();

    releaseToggleFailure.resolve(undefined);
    expect(await toggleFailure).toEqual(
      expect.objectContaining({ message: "group disk full" }),
    );
    await expect(clear).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.invocationCallOrder[1]).toBeLessThan(
      clearWorkspace.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      [...store.groups.values()].some(
        (state) => state.workspaceId === WORKSPACE_1,
      ),
    ).toBe(false);
    expect(
      runtime
        .snapshots()
        .some((snapshot) => snapshot.workspaceId === WORKSPACE_1),
    ).toBe(false);
  });

  it("drops settlement persistence that arrives while a workspace clear is in flight", async () => {
    const store = new FakeStateStore();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime([moduleScope()], store, connections);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    const clearStarted = deferred<undefined>();
    const releaseClear = deferred<undefined>();
    const originalClearWorkspace = store.clearWorkspace.bind(store);
    vi.spyOn(store, "clearWorkspace").mockImplementationOnce(
      async (workspaceId) => {
        await originalClearWorkspace(workspaceId);
        clearStarted.resolve(undefined);
        await releaseClear.promise;
      },
    );
    const upsert = vi.spyOn(store, "upsert");

    const clear = runtime.clearWorkspace(WORKSPACE_1);
    await clearStarted.promise;
    expect(
      [...store.groups.values()].some(
        (state) => state.workspaceId === WORKSPACE_1,
      ),
    ).toBe(false);
    await expect(
      runtime.toggleGroupEnabled({ ...actionScope(), groupId: GROUP_1 }),
    ).rejects.toThrow("Routing group transition is in progress");

    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim?.takeSequence).toBe(1);
    });
    expect(upsert).not.toHaveBeenCalled();

    releaseClear.resolve(undefined);
    await expect(clear).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(
      [...store.groups.values()].some(
        (state) => state.workspaceId === WORKSPACE_1,
      ),
    ).toBe(false);
    expect(
      runtime
        .snapshots()
        .some((snapshot) => snapshot.workspaceId === WORKSPACE_1),
    ).toBe(false);
  });

  it("toggles an explicit group off, clears routing state, and blocks every grouped route action", async () => {
    const { connections, runtime, store } = await makeRuntime();
    const scope = actionScope();

    await runtime.selectSource({ ...scope, source: 21, levels: [1, 2] });
    await runtime.selectDestination({ ...scope, destination: 7 });
    await runtime.take({ ...scope, levels: [1, 2] });
    expect(connections.submissions).toHaveLength(1);
    expect(runtime.snapshots()[0]).toMatchObject({
      enabled: true,
      stagedSource: 21,
      selectedDestination: 7,
      moduleSequenceHighWaterMark: 1,
    });
    expect(connections.watches.some((watch) => watch.active)).toBe(true);

    await runtime.toggleGroupEnabled({ ...scope, groupId: GROUP_1 });

    expect(runtime.snapshots()[0]).toMatchObject({
      enabled: false,
      stagedSource: null,
      stagedLevels: [],
      selectedDestination: null,
      routeClaim: null,
      feedbackClaim: null,
      pendingRouteClaims: new Map(),
      confirmedRoute: null,
      moduleSequenceHighWaterMark: 1,
    });
    expect(connections.watches.every((watch) => !watch.active)).toBe(true);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      enabled: false,
      selectedDestination: null,
      levels: [],
      committedTakeSequence: null,
    });

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21));
    connections.submissions[0]?.settled.resolve(undefined);
    await Promise.resolve();
    expect(runtime.snapshots()[0]).toMatchObject({
      enabled: false,
      stagedSource: null,
      selectedDestination: null,
      routeClaim: null,
      confirmedRoute: null,
    });

    await expect(
      runtime.selectSource({ ...scope, source: 22, levels: [1] }),
    ).rejects.toThrow("Routing group is disabled");
    await expect(
      runtime.selectDestination({ ...scope, destination: 8 }),
    ).rejects.toThrow("Routing group is disabled");
    await expect(
      runtime.cycleDestination({
        ...scope,
        destinations: [7, 8],
        step: 1,
        wrap: true,
      }),
    ).rejects.toThrow("Routing group is disabled");
    await expect(runtime.take({ ...scope, levels: [1] })).rejects.toThrow(
      "Routing group is disabled",
    );
    expect(connections.submissions).toHaveLength(1);

    await runtime.toggleGroupEnabled({ ...scope, groupId: GROUP_1 });
    expect(runtime.snapshots()[0]).toMatchObject({
      enabled: true,
      stagedSource: null,
      stagedLevels: [],
      selectedDestination: null,
      routeClaim: null,
      feedbackClaim: null,
      confirmedRoute: null,
      moduleSequenceHighWaterMark: 1,
    });
    expect(connections.watches.every((watch) => !watch.active)).toBe(true);
    expect(connections.submissions).toHaveLength(1);
  });

  it("restores persisted disabled state across restart and defaults legacy records to enabled", async () => {
    const store = new FakeStateStore();
    const first = await makeRuntime([moduleScope()], store);
    await first.runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1],
    });
    await first.runtime.selectDestination({ ...actionScope(), destination: 7 });
    await first.runtime.take({ ...actionScope(), levels: [1] });
    await first.runtime.toggleGroupEnabled({
      ...actionScope(),
      groupId: GROUP_1,
    });
    expect(
      store.modules.get(`${WORKSPACE_1}:${MODULE_1}`)
        ?.moduleSequenceHighWaterMark,
    ).toBe(1);
    await first.runtime.stop();

    const second = await makeRuntime(
      [moduleScope()],
      store,
      new FakeConnections(),
    );
    expect(second.runtime.snapshots()[0]).toMatchObject({
      enabled: false,
      stagedSource: null,
      stagedLevels: [],
      selectedDestination: null,
      routeClaim: null,
      confirmedRoute: null,
      moduleSequenceHighWaterMark: 1,
    });
    expect(second.connections.watches).toHaveLength(0);

    const legacyStore = new FakeStateStore([persistedGroup()]);
    const legacy = await makeRuntime(
      [moduleScope()],
      legacyStore,
      new FakeConnections(),
    );
    expect(legacy.runtime.snapshots()[0]).toMatchObject({
      enabled: true,
      selectedDestination: 7,
    });
    expect(legacy.connections.watches.some((watch) => watch.active)).toBe(true);
  });

  it("steps forward by list index through sparse destinations and wraps", async () => {
    const { connections, runtime, store } = await makeRuntime();
    const scope = actionScope();
    const cycle = () =>
      runtime.cycleDestination({
        ...scope,
        destinations: [1, 5, 10],
        step: 1,
        wrap: true,
      });
    const selectedDestination = () =>
      runtime.snapshots()[0]?.selectedDestination;

    await cycle();
    expect(selectedDestination()).toBe(1);
    await cycle();
    expect(selectedDestination()).toBe(5);
    await cycle();
    expect(selectedDestination()).toBe(10);
    await cycle();
    expect(selectedDestination()).toBe(1);

    await runtime.selectDestination({ ...scope, destination: 20 });
    await cycle();
    expect(selectedDestination()).toBe(1);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)
        ?.selectedDestination,
    ).toBe(1);
    expect(connections.submissions).toHaveLength(0);
  });

  it("steps backward by list index through sparse destinations and wraps", async () => {
    const { connections, runtime, store } = await makeRuntime();
    const scope = actionScope();
    const cycle = () =>
      runtime.cycleDestination({
        ...scope,
        destinations: [1, 5, 10],
        step: -1,
        wrap: true,
      });
    const selectedDestination = () =>
      runtime.snapshots()[0]?.selectedDestination;

    await cycle();
    expect(selectedDestination()).toBe(10);
    await cycle();
    expect(selectedDestination()).toBe(5);
    await cycle();
    expect(selectedDestination()).toBe(1);
    await cycle();
    expect(selectedDestination()).toBe(10);

    await runtime.selectDestination({ ...scope, destination: 20 });
    await cycle();
    expect(selectedDestination()).toBe(10);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)
        ?.selectedDestination,
    ).toBe(10);
    expect(connections.submissions).toHaveLength(0);
  });

  it.each([
    { label: "right", step: 1 as const, selections: [1, 5, 10] as const },
    { label: "left", step: -1 as const, selections: [10, 5, 1] as const },
  ])(
    "clamps a non-wrapping $label cycle without disturbing state at the endpoint",
    async ({ step, selections }) => {
      const { connections, runtime, store } = await makeRuntime();
      const scope = actionScope();
      const cycle = () =>
        runtime.cycleDestination({
          ...scope,
          destinations: [1, 5, 10],
          step,
          wrap: false,
        });

      for (const destination of selections) {
        await cycle();
        expect(runtime.snapshots()[0]?.selectedDestination).toBe(destination);
      }
      await runtime.selectSource({ ...scope, source: 21, levels: [1, 2] });
      const before = runtime.snapshots()[0];
      const watchCount = connections.watches.length;
      const listener = vi.fn();
      const unsubscribe = runtime.subscribe(listener);
      listener.mockClear();

      await cycle();

      expect(runtime.snapshots()[0]).toEqual(before);
      expect(connections.watches).toHaveLength(watchCount);
      expect(connections.submissions).toHaveLength(0);
      expect(listener).not.toHaveBeenCalled();
      expect(
        store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)
          ?.selectedDestination,
      ).toBe(selections.at(-1));
      unsubscribe();
    },
  );

  it.each([
    { label: "right", step: 1 as const, expected: 1 },
    { label: "left", step: -1 as const, expected: 10 },
  ])(
    "enters a non-wrapping $label cycle from an outside destination at the directional edge",
    async ({ step, expected }) => {
      const { runtime } = await makeRuntime();
      const scope = actionScope();

      await runtime.selectDestination({ ...scope, destination: 20 });
      await runtime.cycleDestination({
        ...scope,
        destinations: [1, 5, 10],
        step,
        wrap: false,
      });

      expect(runtime.snapshots()[0]?.selectedDestination).toBe(expected);
    },
  );

  it("cycles first, next, wrap, and outside destinations in shared group state", async () => {
    const { connections, runtime, store } = await makeRuntime();
    const groupOne = actionScope({ groupId: GROUP_1 });
    const groupTwo = actionScope({ groupId: GROUP_2 });

    await runtime.cycleDestination({
      ...groupOne,
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    expect(
      runtime.snapshots().find(({ groupId }) => groupId === GROUP_1)
        ?.selectedDestination,
    ).toBe(7);
    await runtime.cycleDestination({
      ...groupOne,
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    expect(
      runtime.snapshots().find(({ groupId }) => groupId === GROUP_1)
        ?.selectedDestination,
    ).toBe(8);
    await runtime.cycleDestination({
      ...groupOne,
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    await runtime.cycleDestination({
      ...groupOne,
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    expect(
      runtime.snapshots().find(({ groupId }) => groupId === GROUP_1)
        ?.selectedDestination,
    ).toBe(7);

    await runtime.selectDestination({ ...groupOne, destination: 20 });
    await runtime.cycleDestination({
      ...groupOne,
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    await runtime.cycleDestination({
      ...groupTwo,
      destinations: [30, 31],
      step: 1,
      wrap: true,
    });
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: GROUP_1, selectedDestination: 7 }),
        expect.objectContaining({ groupId: GROUP_2, selectedDestination: 30 }),
      ]),
    );
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`)
        ?.selectedDestination,
    ).toBe(7);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_2}`)
        ?.selectedDestination,
    ).toBe(30);
    expect(connections.submissions).toHaveLength(0);
  });

  it("advances rapid non-awaited cycles atomically", async () => {
    const { runtime } = await makeRuntime();
    const first = runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });
    const second = runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8, 9],
      step: 1,
      wrap: true,
    });

    expect(runtime.snapshots()[0]?.selectedDestination).toBe(8);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    { label: "one destination", destinations: [7] },
    { label: "six destinations", destinations: [1, 2, 3, 4, 5, 6] },
    { label: "duplicate destinations", destinations: [7, 8, 7] },
    { label: "invalid destination", destinations: [7, 0] },
  ])("rejects $label before changing group state", async ({ destinations }) => {
    const { runtime } = await makeRuntime();

    expect(() =>
      runtime.cycleDestination({
        ...actionScope(),
        destinations,
        step: 1,
        wrap: true,
      }),
    ).toThrow();
    expect(runtime.snapshots()[0]?.selectedDestination).toBeNull();
  });

  it("hydrates the cycled destination from immediate readback without routing", async () => {
    const connections = new FakeConnections();
    connections.immediateReadySources.set(
      `${CONNECTION_1}:7`,
      readyRoutes(21, [1, 2]),
    );
    connections.immediateReadySources.set(
      `${CONNECTION_1}:8`,
      readyRoutes(31, [1, 2]),
    );
    const store = new FakeStateStore([persistedGroup()]);
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: true })],
      store,
      connections,
    );

    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: 21,
      routeClaim: expect.objectContaining({ destination: 7, takeSequence: 5 }),
    });
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });

    expect(connections.submissions).toHaveLength(0);
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: 31,
      stagedLevels: [1, 2],
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 8,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      selectedDestination: 8,
      committedTakeSequence: null,
    });
  });

  it("blanks the prior source while cycle readback is pending, then hydrates without routing", async () => {
    const connections = new FakeConnections();
    connections.immediateReadySources.set(
      `${CONNECTION_1}:7`,
      readyRoutes(21, [1, 2]),
    );
    const store = new FakeStateStore([persistedGroup()]);
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: true })],
      store,
      connections,
    );

    await expect(
      runtime.cycleDestination({
        ...actionScope(),
        destinations: [7, 8],
        step: 1,
        wrap: true,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: null,
      routeClaim: null,
      feedbackClaim: null,
    });
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      selectedDestination: 8,
      committedTakeSequence: null,
    });
    expect(connections.submissions).toHaveLength(0);

    connections.publishReady(CONNECTION_1, 8, readyRoutes(31, [1, 2]));

    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: 31,
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 8,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(connections.submissions).toHaveLength(0);
  });

  it.each(["settles", "rejects"] as const)(
    "retires an old-destination Take when it $outcome without disturbing cycled readback",
    async (outcome) => {
      const diagnostics = vi.fn();
      const connections = new FakeConnections();
      connections.immediateReadySources.set(
        `${CONNECTION_1}:8`,
        readyRoutes(31),
      );
      const { runtime } = await makeRuntime(
        [moduleScope({ automaticTake: false })],
        new FakeStateStore(),
        connections,
        diagnostics,
      );

      await runtime.selectSource({
        ...actionScope(),
        source: 21,
        levels: [1, 2],
      });
      await runtime.selectDestination({ ...actionScope(), destination: 7 });
      await runtime.take({ ...actionScope(), levels: [1, 2] });
      const oldDestinationSubmission = connections.submissions[0];
      expect(oldDestinationSubmission?.input).toMatchObject({
        source: 21,
        destination: 7,
      });

      await runtime.reconcile([moduleScope({ automaticTake: true })]);
      await runtime.cycleDestination({
        ...actionScope(),
        destinations: [7, 8],
        step: 1,
        wrap: true,
      });

      expect(runtime.snapshots()[0]).toMatchObject({
        selectedDestination: 8,
        stagedSource: 31,
        routeClaim: expect.objectContaining({
          source: 31,
          destination: 8,
          origin: "passive-readback",
          takeSequence: null,
        }),
      });
      expect(runtime.snapshots()[0]?.pendingRouteClaims.has(1)).toBe(true);
      expect(connections.submissions).toHaveLength(1);

      if (outcome === "settles")
        oldDestinationSubmission?.settled.resolve(undefined);
      else
        oldDestinationSubmission?.settled.reject(
          new Error("SW-P-08 router returned NAK"),
        );

      await vi.waitFor(() => {
        expect(runtime.snapshots()[0]?.pendingRouteClaims.size).toBe(0);
      });
      expect(runtime.snapshots()[0]).toMatchObject({
        selectedDestination: 8,
        stagedSource: 31,
        routeClaim: expect.objectContaining({
          source: 31,
          destination: 8,
          origin: "passive-readback",
          takeSequence: null,
        }),
      });
      expect(connections.submissions).toHaveLength(1);
      if (outcome === "rejects") {
        expect(diagnostics).toHaveBeenCalledWith(
          expect.objectContaining({
            code: "ross_route_group_route_settlement_failed",
            takeSequence: 1,
          }),
        );
      }
    },
  );

  it("does not let an old-destination rejection block later cycled readback", async () => {
    const diagnostics = vi.fn();
    const connections = new FakeConnections();
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: false })],
      new FakeStateStore(),
      connections,
      diagnostics,
    );

    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1, 2] });
    await runtime.reconcile([moduleScope({ automaticTake: true })]);
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: null,
      routeClaim: null,
    });

    connections.submissions[0]?.settled.reject(
      new Error("SW-P-08 router returned NAK"),
    );
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.pendingRouteClaims.size).toBe(0);
    });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "ross_route_group_route_settlement_failed",
        takeSequence: 1,
      }),
    );

    connections.publishReady(CONNECTION_1, 8, readyRoutes(31));
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: 31,
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 8,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(connections.submissions).toHaveLength(1);
  });

  it("does not promote an old Take that settles after a 7 to 8 to 7 cycle", async () => {
    const connections = new FakeConnections();
    const store = new FakeStateStore();
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: false })],
      store,
      connections,
    );

    await runtime.selectSource({
      ...actionScope(),
      source: 31,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1, 2] });
    const oldDestinationSubmission = connections.submissions[0];
    connections.immediateReadySources.set(`${CONNECTION_1}:8`, readyRoutes(41));
    connections.immediateReadySources.set(`${CONNECTION_1}:7`, readyRoutes(31));

    await runtime.reconcile([moduleScope({ automaticTake: true })]);
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });

    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: 31,
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 7,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(runtime.snapshots()[0]?.pendingRouteClaims.has(1)).toBe(true);

    oldDestinationSubmission?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.pendingRouteClaims.size).toBe(0);
    });

    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: 31,
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 7,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      selectedDestination: 7,
      committedTakeSequence: null,
    });
    expect(connections.submissions).toHaveLength(1);
  });

  it("does not block passive readback when an old Take rejects after a 7 to 8 to 7 cycle", async () => {
    const diagnostics = vi.fn();
    const connections = new FakeConnections();
    const store = new FakeStateStore();
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: false })],
      store,
      connections,
      diagnostics,
    );

    await runtime.selectSource({
      ...actionScope(),
      source: 31,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1, 2] });
    const oldDestinationSubmission = connections.submissions[0];
    connections.immediateReadySources.set(`${CONNECTION_1}:8`, readyRoutes(41));

    await runtime.reconcile([moduleScope({ automaticTake: true })]);
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });
    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: null,
      routeClaim: null,
    });

    oldDestinationSubmission?.settled.reject(
      new Error("SW-P-08 router returned NAK"),
    );
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.pendingRouteClaims.size).toBe(0);
    });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "ross_route_group_route_settlement_failed",
        takeSequence: 1,
      }),
    );

    connections.publishReady(CONNECTION_1, 7, readyRoutes(31));
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: 31,
      routeClaim: expect.objectContaining({
        source: 31,
        destination: 7,
        origin: "passive-readback",
        takeSequence: null,
      }),
    });
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      selectedDestination: 7,
      committedTakeSequence: null,
    });
    expect(connections.submissions).toHaveLength(1);
  });

  it("Automatic Take routes a later selected source only to the cycled destination", async () => {
    const connections = new FakeConnections();
    connections.immediateReadySources.set(
      `${CONNECTION_1}:7`,
      readyRoutes(21, [1, 2]),
    );
    connections.immediateReadySources.set(
      `${CONNECTION_1}:8`,
      readyRoutes(31, [1, 2]),
    );
    const { runtime } = await makeRuntime(
      [moduleScope({ automaticTake: true })],
      new FakeStateStore([persistedGroup()]),
      connections,
    );

    await runtime.cycleDestination({
      ...actionScope(),
      destinations: [7, 8],
      step: 1,
      wrap: true,
    });
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: 31,
    });
    expect(connections.submissions).toHaveLength(0);

    await runtime.selectSource({ ...actionScope(), source: 41, levels: [2] });

    expect(connections.submissions).toHaveLength(1);
    expect(connections.submissions[0]?.input).toEqual({
      connectionId: CONNECTION_1,
      source: 41,
      destination: 8,
      levels: [2],
    });
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      stagedSource: 41,
    });
  });

  it("keeps a cycle selection after missing readback without reporting a source failure", async () => {
    const { connections, runtime } = await makeRuntime(
      [moduleScope({ automaticTake: true })],
      new FakeStateStore(),
      new FakeConnections(),
    );

    await expect(
      runtime.cycleDestination({
        ...actionScope(),
        destinations: [7, 8],
        step: 1,
        wrap: true,
      }),
    ).resolves.toBeUndefined();
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 7,
      stagedSource: null,
      routeClaim: null,
    });
    expect(connections.submissions).toHaveLength(0);
  });

  it("isolates manual staging across groups, modules, and workspaces with zero route calls", async () => {
    const { connections, runtime } = await makeRuntime([
      moduleScope(),
      moduleScope({ moduleConnectionId: MODULE_2, groupIds: [] }),
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_3,
        connectionId: CONNECTION_2,
        groupIds: [GROUP_1],
      }),
    ]);

    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [3, 1],
    });
    await runtime.selectDestination({
      ...actionScope({ groupId: GROUP_2 }),
      destination: 8,
    });
    await runtime.selectSource({
      ...actionScope({ moduleConnectionId: MODULE_2, groupId: null }),
      source: 31,
      levels: [],
    });

    expect(connections.submissions).toHaveLength(0);
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_1,
          groupId: GROUP_1,
          manualStageActive: true,
          stagedSource: 21,
          stagedLevels: [1, 3],
        }),
        expect.objectContaining({
          moduleConnectionId: MODULE_1,
          groupId: GROUP_2,
          selectedDestination: 8,
        }),
        expect.objectContaining({
          moduleConnectionId: MODULE_2,
          groupId: null,
          manualStageActive: true,
          stagedSource: 31,
          stagedLevels: [1, 2, 3, 4],
        }),
        expect.objectContaining({
          workspaceId: WORKSPACE_2,
          moduleConnectionId: MODULE_3,
          manualStageActive: false,
          stagedSource: null,
        }),
      ]),
    );
    expect(() =>
      runtime.selectSource({ ...actionScope({ groupId: null }), source: 90 }),
    ).toThrow("Ross route group scope is not configured");
  });

  it("updates confirmed tally without overwriting an intentional manual-Take source", async () => {
    const { connections, runtime } = await makeRuntime();

    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    connections.publishReady(CONNECTION_1, 7, readyRoutes(11));
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });

    connections.publishReady(CONNECTION_1, 7, readyRoutes(31));
    expect(runtime.snapshots()[0]).toMatchObject({
      manualStageActive: true,
      stagedSource: 21,
      stagedLevels: [1, 2],
      confirmedRoute: {
        phase: "ready",
        sourcesByLevel: new Map([
          [1, 31],
          [2, 31],
          [3, 31],
          [4, 31],
        ]),
      },
      routeClaim: expect.objectContaining({
        source: 31,
        origin: "passive-readback",
      }),
      feedbackClaim: expect.objectContaining({
        source: 31,
        origin: "passive-readback",
      }),
    });

    connections.publishPending(CONNECTION_1, 7, "disconnected");
    expect(runtime.snapshots()[0]).toMatchObject({
      stagedSource: 21,
      stagedLevels: [1, 2],
      routeClaim: null,
      feedbackClaim: null,
    });

    connections.publishReady(CONNECTION_1, 7, readyRoutes(31));
    await runtime.take({ ...actionScope(), levels: [1, 2] });
    expect(connections.submissions[0]?.input).toEqual({
      connectionId: CONNECTION_1,
      source: 21,
      destination: 7,
      levels: [1, 2],
    });
  });

  it("applies module-local Automatic Take from both SRC and DST after preserving selections", async () => {
    const { connections, runtime } = await makeRuntime([
      moduleScope({ automaticTake: true }),
      moduleScope({
        moduleConnectionId: MODULE_2,
        groupIds: [],
        automaticTake: false,
      }),
    ]);

    await expect(
      runtime.selectSource({ ...actionScope(), source: 21, levels: [1, 3] }),
    ).rejects.toThrow("Ross selected destination is not configured");
    expect(runtime.snapshots()[0]).toMatchObject({
      stagedSource: 21,
      stagedLevels: [1, 3],
    });

    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    expect(connections.submissions[0]?.input).toEqual({
      connectionId: CONNECTION_1,
      source: 21,
      destination: 7,
      levels: [1, 3],
    });

    await expect(
      runtime.selectDestination({
        ...actionScope({ groupId: GROUP_2 }),
        destination: 8,
      }),
    ).rejects.toThrow("Ross selected source is not configured");
    expect(runtime.snapshots()[1]).toMatchObject({ selectedDestination: 8 });
    await runtime.selectSource({
      ...actionScope({ groupId: GROUP_2 }),
      source: 31,
      levels: [2],
    });
    expect(connections.submissions[1]?.input).toMatchObject({
      source: 31,
      destination: 8,
      levels: [2],
    });

    await runtime.selectDestination({
      ...actionScope({ moduleConnectionId: MODULE_2, groupId: null }),
      destination: 9,
    });
    await runtime.selectSource({
      ...actionScope({ moduleConnectionId: MODULE_2, groupId: null }),
      source: 41,
      levels: [4],
    });
    expect(connections.submissions).toHaveLength(2);
  });

  it("expands empty levels and records sequence-keyed pending ownership before acceptance", async () => {
    const connections = new FakeConnections();
    connections.acceptImmediately = false;
    const { runtime, store } = await makeRuntime(
      [moduleScope()],
      new FakeStateStore(),
      connections,
    );
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });

    const take = runtime.take({ ...actionScope(), levels: [] });
    expect(connections.submissions[0]?.input.levels).toEqual([1, 2, 3, 4]);
    expect(runtime.snapshots()[0]?.pendingRouteClaims).toEqual(
      new Map([
        [
          1,
          expect.objectContaining({
            source: 21,
            destination: 7,
            levels: [1, 2, 3, 4],
            takeSequence: 1,
          }),
        ],
      ]),
    );
    expect(store.modules.get(`${WORKSPACE_1}:${MODULE_1}`)).toMatchObject({
      moduleSequenceHighWaterMark: 1,
    });

    connections.submissions[0]?.accepted.resolve(undefined);
    await expect(take).resolves.toBeUndefined();
    expect(runtime.snapshots()[0]?.routeClaim).toBeNull();
  });

  it("promotes only settled, matching readback and suspends an old destination claim", async () => {
    const { connections, runtime, store } = await makeRuntime();
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1, 2] });

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1, 2]));
    expect(runtime.snapshots()[0]?.routeClaim).toBeNull();
    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.feedbackClaim).toMatchObject({
        source: 21,
        destination: 7,
        levels: [1, 2],
        takeSequence: 1,
        origin: "take",
      });
    });
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_1}:${GROUP_1}`),
    ).toMatchObject({
      levels: [1, 2],
      committedTakeSequence: 1,
    });

    await runtime.selectSource({ ...actionScope(), source: 22, levels: [2] });
    expect(runtime.snapshots()[0]).toMatchObject({
      stagedSource: 22,
      stagedLevels: [2],
      routeClaim: expect.objectContaining({ source: 21, destination: 7 }),
      feedbackClaim: expect.objectContaining({ source: 21, destination: 7 }),
    });

    await runtime.selectDestination({ ...actionScope(), destination: 8 });
    expect(runtime.snapshots()[0]).toMatchObject({
      selectedDestination: 8,
      routeClaim: expect.objectContaining({ destination: 7 }),
      feedbackClaim: null,
    });
  });

  it("retains a successful claim on levels that a later route did not replace", async () => {
    const { connections, runtime } = await makeRuntime();
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1, 2] });

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1, 2]));
    connections.submissions[0]?.settled.resolve(undefined);
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.feedbackClaim).toMatchObject({
        source: 21,
        levels: [1, 2],
        takeSequence: 1,
      });
    });

    connections.publishReady(
      CONNECTION_1,
      7,
      new Map([
        [1, 22],
        [2, 21],
      ]),
    );

    expect(runtime.snapshots()[0]).toMatchObject({
      stagedSource: 21,
      routeClaim: expect.objectContaining({
        source: 21,
        levels: [1, 2],
        takeSequence: 1,
      }),
      feedbackClaim: expect.objectContaining({
        source: 21,
        levels: [1, 2],
        takeSequence: 1,
      }),
    });
  });

  it("preserves sequence 1 when sequence 2 fails, including a same-source late failure", async () => {
    const diagnostics = vi.fn();
    const { connections, runtime } = await makeRuntime(
      undefined,
      undefined,
      undefined,
      diagnostics,
    );
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });
    connections.submissions[0]?.settled.resolve(undefined);
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1]));
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim?.takeSequence).toBe(1);
    });

    await runtime.selectSource({ ...actionScope(), source: 22, levels: [1] });
    await runtime.take({ ...actionScope(), levels: [1] });
    connections.submissions[1]?.settled.reject(new Error("SW-P-08 NAK"));
    await vi.waitFor(() => {
      expect(runtime.snapshots()[0]?.routeClaim).toMatchObject({
        source: 21,
        takeSequence: 1,
      });
    });

    const second = await makeRuntime([
      moduleScope({ moduleConnectionId: MODULE_2, groupIds: [] }),
    ]);
    const scope = actionScope({ moduleConnectionId: MODULE_2, groupId: null });
    await second.runtime.selectSource({ ...scope, source: 33, levels: [1] });
    await second.runtime.selectDestination({ ...scope, destination: 9 });
    await second.runtime.take({ ...scope, levels: [1] });
    second.connections.publishReady(CONNECTION_1, 9, readyRoutes(33, [1]));
    expect(second.runtime.snapshots()[0]?.routeClaim).toBeNull();
    second.connections.submissions[0]?.settled.reject(
      new Error("same-source NAK"),
    );
    await vi.waitFor(() => {
      expect(second.runtime.snapshots()[0]?.routeClaim).toBeNull();
    });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "ross_route_group_route_settlement_failed",
        takeSequence: 2,
      }),
    );
  });

  it("passively hydrates multiple watched destinations without routing and blanks mixed truth", async () => {
    const store = new FakeStateStore(
      [
        persistedGroup({
          groupId: GROUP_1,
          selectedDestination: 7,
          levels: [1, 2],
        }),
        persistedGroup({
          groupId: GROUP_2,
          selectedDestination: 8,
          levels: [],
          committedTakeSequence: null,
        }),
      ],
      [persistedModule({ moduleSequenceHighWaterMark: 5 })],
    );
    const { connections, runtime } = await makeRuntime(undefined, store);

    expect(connections.submissions).toHaveLength(0);
    expect(
      connections.watches
        .filter((watch) => watch.active)
        .map((watch) => ({
          destination: watch.destination,
          levels: watch.levels,
        })),
    ).toEqual([
      { destination: 7, levels: [1, 2] },
      { destination: 8, levels: [1, 2, 3, 4] },
    ]);

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1, 2]));
    connections.publishReady(CONNECTION_1, 8, readyRoutes(31));
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: GROUP_1,
          stagedSource: 21,
          routeClaim: expect.objectContaining({
            takeSequence: 5,
            origin: "passive-readback",
          }),
        }),
        expect.objectContaining({
          groupId: GROUP_2,
          stagedSource: 31,
          routeClaim: expect.objectContaining({ takeSequence: null }),
        }),
      ]),
    );
    expect(connections.submissions).toHaveLength(0);

    connections.publishReady(
      CONNECTION_1,
      8,
      new Map([
        [1, 31],
        [2, 32],
        [3, 31],
      ]),
    );
    expect(
      runtime.snapshots().find((snapshot) => snapshot.groupId === GROUP_2),
    ).toMatchObject({
      stagedSource: null,
      routeClaim: null,
      feedbackClaim: null,
    });
    connections.publishPending(CONNECTION_1, 7, "disconnected");
    expect(
      runtime.snapshots().find((snapshot) => snapshot.groupId === GROUP_1),
    ).toMatchObject({
      stagedSource: null,
      routeClaim: null,
      feedbackClaim: null,
    });
    connections.publishPending(CONNECTION_1, 8, "disconnected");
    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1, 2]));
    connections.publishReady(CONNECTION_1, 8, readyRoutes(31));
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: GROUP_1, stagedSource: 21 }),
        expect.objectContaining({ groupId: GROUP_2, stagedSource: 31 }),
      ]),
    );
    expect(connections.submissions).toHaveLength(0);
  });

  it("exposes ambiguous passive overlap as two null-sequence claims for feedback arbitration", async () => {
    const store = new FakeStateStore([
      persistedGroup({
        groupId: GROUP_1,
        selectedDestination: 7,
        levels: [1, 2],
        committedTakeSequence: null,
      }),
      persistedGroup({
        groupId: GROUP_2,
        selectedDestination: 7,
        levels: [1, 2],
        committedTakeSequence: null,
      }),
    ]);
    const { connections, runtime } = await makeRuntime(undefined, store);

    connections.publishReady(CONNECTION_1, 7, readyRoutes(21, [1, 2]));
    expect(
      runtime.snapshots().map((snapshot) => ({
        groupId: snapshot.groupId,
        claim: snapshot.feedbackClaim,
      })),
    ).toEqual([
      {
        groupId: GROUP_1,
        claim: expect.objectContaining({ source: 21, takeSequence: null }),
      },
      {
        groupId: GROUP_2,
        claim: expect.objectContaining({ source: 21, takeSequence: null }),
      },
    ]);
    expect(connections.submissions).toHaveLength(0);
  });

  it("allocates Take sequences across groups but independently per workspace module", async () => {
    const { runtime } = await makeRuntime([
      moduleScope(),
      moduleScope({ moduleConnectionId: MODULE_2, groupIds: [] }),
    ]);
    for (const scope of [
      actionScope({ groupId: GROUP_1 }),
      actionScope({ groupId: GROUP_2 }),
      actionScope({ moduleConnectionId: MODULE_2, groupId: null }),
    ]) {
      await runtime.selectSource({ ...scope, source: 21, levels: [1] });
      await runtime.selectDestination({ ...scope, destination: 7 });
      await runtime.take({ ...scope, levels: [1] });
    }

    const snapshots = runtime.snapshots();
    expect(
      snapshots
        .find((snapshot) => snapshot.groupId === GROUP_1)
        ?.pendingRouteClaims.has(1),
    ).toBe(true);
    expect(
      snapshots
        .find((snapshot) => snapshot.groupId === GROUP_2)
        ?.pendingRouteClaims.has(2),
    ).toBe(true);
    expect(
      snapshots
        .find((snapshot) => snapshot.moduleConnectionId === MODULE_2)
        ?.pendingRouteClaims.has(1),
    ).toBe(true);
  });

  it("uses persisted module high-water marks and defensively honors committed group sequences", async () => {
    const store = new FakeStateStore(
      [persistedGroup({ committedTakeSequence: 11, levels: [1] })],
      [persistedModule({ moduleSequenceHighWaterMark: 9 })],
    );
    const { connections, runtime } = await makeRuntime(undefined, store);
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.take({ ...actionScope(), levels: [1] });

    expect(runtime.snapshots()[0]?.pendingRouteClaims.has(12)).toBe(true);
    expect(
      store.modules.get(`${WORKSPACE_1}:${MODULE_1}`)
        ?.moduleSequenceHighWaterMark,
    ).toBe(12);
    expect(connections.submissions).toHaveLength(1);
  });

  it("moves generic state to the first group idempotently and applies discard transitions", async () => {
    const { runtime, store } = await makeRuntime([
      moduleScope({ moduleConnectionId: MODULE_2, groupIds: [] }),
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_3,
        groupIds: [GROUP_2],
      }),
    ]);
    const generic = actionScope({
      moduleConnectionId: MODULE_2,
      groupId: null,
    });
    await runtime.selectDestination({ ...generic, destination: 7 });
    const move = transition({
      operation: "move",
      workspaceId: WORKSPACE_1,
      moduleConnectionId: MODULE_2,
      fromGroupId: null,
      toGroupId: GROUP_1,
    });
    await expect(runtime.applyTransition(move)).resolves.toBe("applied");
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleConnectionId: MODULE_2,
          groupId: GROUP_1,
          selectedDestination: 7,
        }),
      ]),
    );

    await runtime.applyTransition(
      transition(
        {
          operation: "move",
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_2,
          fromGroupId: GROUP_1,
          toGroupId: null,
        },
        2,
      ),
    );
    expect(runtime.snapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleConnectionId: MODULE_2,
          groupId: null,
          selectedDestination: 7,
        }),
      ]),
    );
    await runtime.applyTransition(
      transition(
        {
          operation: "move",
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_2,
          fromGroupId: null,
          toGroupId: GROUP_1,
        },
        3,
      ),
    );

    store.nextTransitionResult = "already-applied";
    await expect(runtime.applyTransition(move)).resolves.toBe(
      "already-applied",
    );
    expect(
      runtime
        .snapshots()
        .filter(
          (snapshot) =>
            snapshot.moduleConnectionId === MODULE_2 &&
            snapshot.groupId === GROUP_1,
        ),
    ).toHaveLength(1);

    await runtime.applyTransition(
      transition(
        {
          operation: "discard-group",
          workspaceId: WORKSPACE_1,
          moduleConnectionId: MODULE_2,
          groupId: GROUP_1,
        },
        4,
      ),
    );
    expect(
      runtime
        .snapshots()
        .some((snapshot) => snapshot.moduleConnectionId === MODULE_2),
    ).toBe(false);
    await runtime.applyTransition(
      transition(
        {
          operation: "discard-workspace",
          workspaceId: WORKSPACE_2,
        },
        5,
      ),
    );
    expect(runtime.snapshots()).toHaveLength(0);
  });

  it("restores enabled state when a disabled explicit group becomes the generic scope", async () => {
    const { runtime, store } = await makeRuntime([
      moduleScope({ moduleConnectionId: MODULE_2, groupIds: [GROUP_1] }),
    ]);
    await runtime.toggleGroupEnabled({
      ...actionScope({ moduleConnectionId: MODULE_2 }),
      groupId: GROUP_1,
    });

    await runtime.applyTransition(
      transition({
        operation: "move",
        workspaceId: WORKSPACE_1,
        moduleConnectionId: MODULE_2,
        fromGroupId: GROUP_1,
        toGroupId: null,
      }),
    );

    expect(runtime.snapshots()).toEqual([
      expect.objectContaining({
        moduleConnectionId: MODULE_2,
        groupId: null,
        enabled: true,
        stagedSource: null,
        selectedDestination: null,
      }),
    ]);
    expect(
      store.groups.get(`${WORKSPACE_1}:${MODULE_2}:generic`),
    ).toMatchObject({
      groupId: null,
      enabled: true,
    });
  });

  it("retains in-memory staging across reconciliation and prunes removed watches without routing", async () => {
    const { connections, runtime } = await makeRuntime();
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 3],
    });
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    const watchedBefore = connections.watches.filter(
      (watch) => watch.active,
    ).length;

    await runtime.reconcile([moduleScope({ automaticTake: true })]);
    expect(runtime.snapshots()[0]).toMatchObject({
      automaticTake: true,
      stagedSource: 21,
      stagedLevels: [1, 3],
      selectedDestination: 7,
    });
    expect(connections.watches.filter((watch) => watch.active)).toHaveLength(
      watchedBefore,
    );
    expect(connections.submissions).toHaveLength(0);

    await runtime.reconcile([]);
    expect(runtime.snapshots()).toHaveLength(0);
    expect(connections.watches.some((watch) => watch.active)).toBe(false);
  });

  it("reattaches confirmed readback when a physical router definition is replaced in place", async () => {
    const { connections, runtime } = await makeRuntime();
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 2],
    });
    expect(connections.watches.filter((watch) => watch.active)).toHaveLength(1);

    connections.definitionRevision += 1;
    await runtime.reconcile([moduleScope()]);

    expect(connections.watches).toHaveLength(2);
    expect(connections.watches.filter((watch) => watch.active)).toHaveLength(1);
    connections.publishReady(CONNECTION_1, 7, readyRoutes(31));
    expect(runtime.snapshots()[0]).toMatchObject({
      stagedSource: 21,
      feedbackClaim: expect.objectContaining({
        source: 31,
        origin: "passive-readback",
      }),
    });
  });

  it("preserves inactive workspace groups while reconciling the current workspace", async () => {
    const { runtime } = await makeRuntime([
      moduleScope(),
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_2,
        groupIds: [GROUP_1],
      }),
    ]);
    await runtime.selectSource({
      ...actionScope(),
      source: 21,
      levels: [1, 3],
    });
    await runtime.selectSource({
      ...actionScope(),
      workspaceId: WORKSPACE_2,
      moduleConnectionId: MODULE_2,
      groupId: GROUP_1,
      source: 31,
    });

    await runtime.reconcile([
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_2,
        groupIds: [GROUP_1],
        automaticTake: true,
      }),
    ]);

    expect(
      runtime
        .snapshots()
        .find((snapshot) => snapshot.workspaceId === WORKSPACE_1)?.stagedSource,
    ).toBe(21);
    expect(
      runtime
        .snapshots()
        .find((snapshot) => snapshot.workspaceId === WORKSPACE_2)
        ?.automaticTake,
    ).toBe(true);
  });

  it("can reconcile an empty current workspace without discarding inactive workspaces", async () => {
    const { runtime } = await makeRuntime([
      moduleScope(),
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_2,
        groupIds: [GROUP_1],
      }),
    ]);

    await runtime.reconcile([], WORKSPACE_2);

    expect(
      runtime
        .snapshots()
        .every((snapshot) => snapshot.workspaceId === WORKSPACE_1),
    ).toBe(true);
  });

  it("reports persistence failures without changing Ross action completion", async () => {
    const store = new FakeStateStore();
    const diagnostics = vi.fn();
    const { connections, runtime } = await makeRuntime(
      undefined,
      store,
      undefined,
      diagnostics,
    );
    store.failGroupWrites = true;
    await expect(
      runtime.selectDestination({ ...actionScope(), destination: 7 }),
    ).resolves.toBeUndefined();
    await Promise.resolve();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ross_route_group_state_write_failed" }),
    );

    store.failModuleWrites = true;
    await runtime.selectSource({ ...actionScope(), source: 21, levels: [1] });
    await expect(
      runtime.take({ ...actionScope(), levels: [1] }),
    ).resolves.toBeUndefined();
    expect(connections.submissions).toHaveLength(1);
    await Promise.resolve();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("module disk full"),
      }),
    );
  });

  it("notifies subscribers, clears one workspace, and flushes/unsubscribes on stop", async () => {
    const { connections, runtime, store } = await makeRuntime([
      moduleScope(),
      moduleScope({
        workspaceId: WORKSPACE_2,
        moduleConnectionId: MODULE_3,
        connectionId: CONNECTION_2,
        groupIds: [GROUP_1],
      }),
    ]);
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    await runtime.selectDestination({ ...actionScope(), destination: 7 });
    expect(listener).toHaveBeenCalled();

    await runtime.clearWorkspace(WORKSPACE_1);
    expect(
      runtime
        .snapshots()
        .every((snapshot) => snapshot.workspaceId === WORKSPACE_2),
    ).toBe(true);
    unsubscribe();
    await runtime.stop();

    expect(store.flushCount).toBe(1);
    expect(store.closeCount).toBe(1);
    expect(connections.watches.some((watch) => watch.active)).toBe(false);
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(store.flushCount).toBe(1);
  });
});

function persistedGroup(
  overrides: Partial<PersistedRossRouteGroupRuntimeState> = {},
): PersistedRossRouteGroupRuntimeState {
  return {
    workspaceId: WORKSPACE_1,
    moduleConnectionId: MODULE_1,
    connectionId: CONNECTION_1,
    groupId: GROUP_1,
    selectedDestination: 7,
    levels: [1, 2],
    committedTakeSequence: 5,
    ...overrides,
  };
}

function persistedModule(
  overrides: Partial<PersistedRossRouteModuleSequenceRuntimeState> = {},
): PersistedRossRouteModuleSequenceRuntimeState {
  return {
    workspaceId: WORKSPACE_1,
    moduleConnectionId: MODULE_1,
    moduleSequenceHighWaterMark: 5,
    ...overrides,
  };
}

function transition(
  value:
    | Omit<
        Extract<RossRouteGroupStateTransition, { operation: "move" }>,
        keyof RossRouteGroupStateTransitionBaseForTest
      >
    | Omit<
        Extract<RossRouteGroupStateTransition, { operation: "discard-group" }>,
        keyof RossRouteGroupStateTransitionBaseForTest
      >
    | Omit<
        Extract<RossRouteGroupStateTransition, { operation: "discard-module" }>,
        keyof RossRouteGroupStateTransitionBaseForTest
      >
    | Omit<
        Extract<
          RossRouteGroupStateTransition,
          { operation: "discard-workspace" }
        >,
        keyof RossRouteGroupStateTransitionBaseForTest
      >,
  sequence = 1,
): RossRouteGroupStateTransition {
  return {
    streamId: STREAM_ID,
    sequence,
    transitionId: `60000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    ...value,
  } as RossRouteGroupStateTransition;
}

interface RossRouteGroupStateTransitionBaseForTest {
  readonly streamId: string;
  readonly sequence: number;
  readonly transitionId: string;
}

function cloneGroup(
  state: PersistedRossRouteGroupRuntimeState,
): PersistedRossRouteGroupRuntimeState {
  return { ...state, levels: [...state.levels] };
}

function groupStateKey(state: {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly groupId: string | null;
}): string {
  return `${state.workspaceId}:${state.moduleConnectionId}:${state.groupId ?? "generic"}`;
}

function moduleStateKey(state: {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
}): string {
  return `${state.workspaceId}:${state.moduleConnectionId}`;
}
