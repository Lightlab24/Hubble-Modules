import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JsonRossRouteGroupStateStore,
  type PersistedRossRouteGroupState,
  type PersistedRossRouteModuleSequenceState,
} from "../src/group-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("JsonRossRouteGroupStateStore", () => {
  it("persists group enablement with selected destination, routed levels, and sequence metadata privately", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });

    await store.upsert(
      groupState({ selectedDestination: 7, levels: [1, 2, 3, 4] }),
    );
    await store.upsertModuleSequenceState(moduleSequenceState());
    await store.close();

    const document = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(document)).not.toContain("stagedSource");
    expect(JSON.stringify(document)).not.toContain("routeClaim");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    expect(await reopened.snapshot()).toEqual([
      groupState({ selectedDestination: 7, levels: [1, 2, 3, 4] }),
    ]);
    expect(await reopened.moduleSnapshot()).toEqual([moduleSequenceState()]);
    await reopened.close();
  });

  it("defaults legacy schema-v1 group state to enabled and preserves an explicit disabled state", async () => {
    const filePath = await temporaryStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            ...groupState(),
            enabled: undefined,
          },
        ],
        modules: [],
        streams: [],
      })}\n`,
      { mode: 0o600 },
    );

    const store = new JsonRossRouteGroupStateStore({ filePath });
    expect(await store.snapshot()).toEqual([groupState({ enabled: true })]);
    await store.upsert(groupState({ enabled: false }));
    await store.close();

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    expect(await reopened.snapshot()).toEqual([groupState({ enabled: false })]);
    await reopened.close();
  });

  it("preserves a staged destination before any successful Take and a failed sequence high-water mark", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });

    await store.upsert(
      groupState({
        selectedDestination: 12,
        levels: [],
        committedTakeSequence: 8,
      }),
    );
    await store.upsertModuleSequenceState(
      moduleSequenceState({ moduleSequenceHighWaterMark: 9 }),
    );
    await store.close();

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    expect(await reopened.snapshot()).toEqual([
      groupState({
        selectedDestination: 12,
        levels: [],
        committedTakeSequence: 8,
      }),
    ]);
    expect(await reopened.moduleSnapshot()).toEqual([
      moduleSequenceState({ moduleSequenceHighWaterMark: 9 }),
    ]);
    await reopened.close();
  });

  it("moves generic state to the first group exactly once and applies stream transitions in order", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState({ groupId: null, selectedDestination: 9 }));

    const transition = {
      streamId: "10000000-0000-4000-8000-000000000001",
      sequence: 1,
      transitionId: "20000000-0000-4000-8000-000000000001",
      operation: "move" as const,
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_ID,
      fromGroupId: null,
      toGroupId: GROUP_ID,
    };
    expect(await store.applyTransition(transition)).toBe("applied");
    expect(await store.applyTransition(transition)).toBe("already-applied");
    expect(await store.snapshot()).toEqual([
      groupState({ groupId: GROUP_ID, selectedDestination: 9 }),
    ]);

    await expect(
      store.applyTransition({
        ...transition,
        sequence: 3,
        transitionId: "20000000-0000-4000-8000-000000000003",
        fromGroupId: GROUP_ID,
        toGroupId: null,
      }),
    ).rejects.toThrow("expected transition sequence 2");

    expect(
      await store.applyTransition({
        ...transition,
        sequence: 2,
        transitionId: "20000000-0000-4000-8000-000000000002",
        fromGroupId: GROUP_ID,
        toGroupId: null,
      }),
    ).toBe("applied");
    expect(await store.snapshot()).toEqual([
      groupState({ groupId: null, selectedDestination: 9 }),
    ]);
    await store.close();

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    expect(
      await reopened.applyTransition({
        ...transition,
        sequence: 2,
        transitionId: "20000000-0000-4000-8000-000000000002",
        fromGroupId: GROUP_ID,
        toGroupId: null,
      }),
    ).toBe("already-applied");
    await reopened.close();
  });

  it("defaults a moved generic scope back to enabled", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState({ enabled: false }));

    await store.applyTransition({
      streamId: STREAM_ID,
      sequence: 1,
      transitionId: "20000000-0000-4000-8000-000000000010",
      operation: "move",
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_ID,
      fromGroupId: GROUP_ID,
      toGroupId: null,
    });

    expect(await store.snapshot()).toEqual([
      groupState({ groupId: null, enabled: true }),
    ]);
    await store.close();
  });

  it("discards exact group, module, and workspace scopes without touching peers", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState({ groupId: GROUP_ID }));
    await store.upsert(groupState({ groupId: SECOND_GROUP_ID }));
    await store.upsert(
      groupState({ moduleConnectionId: SECOND_MODULE_ID, groupId: GROUP_ID }),
    );
    await store.upsert(
      groupState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: MODULE_ID,
        groupId: GROUP_ID,
      }),
    );
    await store.upsertModuleSequenceState(moduleSequenceState());
    await store.upsertModuleSequenceState(
      moduleSequenceState({ moduleConnectionId: SECOND_MODULE_ID }),
    );
    await store.upsertModuleSequenceState(
      moduleSequenceState({ workspaceId: SECOND_WORKSPACE_ID }),
    );

    await store.applyTransition({
      streamId: STREAM_ID,
      sequence: 1,
      transitionId: "20000000-0000-4000-8000-000000000011",
      operation: "discard-group",
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_ID,
      groupId: GROUP_ID,
    });
    expect(await store.snapshot()).toHaveLength(3);
    expect(await store.moduleSnapshot()).toHaveLength(3);

    await store.applyTransition({
      streamId: STREAM_ID,
      sequence: 2,
      transitionId: "20000000-0000-4000-8000-000000000012",
      operation: "discard-module",
      workspaceId: WORKSPACE_ID,
      moduleConnectionId: MODULE_ID,
    });
    expect(await store.snapshot()).toEqual([
      groupState({ moduleConnectionId: SECOND_MODULE_ID, groupId: GROUP_ID }),
      groupState({ workspaceId: SECOND_WORKSPACE_ID, groupId: GROUP_ID }),
    ]);
    expect(await store.moduleSnapshot()).toEqual([
      moduleSequenceState({ moduleConnectionId: SECOND_MODULE_ID }),
      moduleSequenceState({ workspaceId: SECOND_WORKSPACE_ID }),
    ]);

    await store.clearWorkspace(SECOND_WORKSPACE_ID);
    expect(await store.snapshot()).toEqual([
      groupState({ moduleConnectionId: SECOND_MODULE_ID, groupId: GROUP_ID }),
    ]);
    expect(await store.moduleSnapshot()).toEqual([
      moduleSequenceState({ moduleConnectionId: SECOND_MODULE_ID }),
    ]);
    await store.close();
  });

  it("reconciles only the workspaces represented by the supplied scopes", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState({ groupId: GROUP_ID }));
    await store.upsert(groupState({ groupId: SECOND_GROUP_ID }));
    await store.upsert(
      groupState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: SECOND_MODULE_ID,
        groupId: GROUP_ID,
      }),
    );
    await store.upsertModuleSequenceState(moduleSequenceState());
    await store.upsertModuleSequenceState(
      moduleSequenceState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: SECOND_MODULE_ID,
      }),
    );

    await store.reconcileScopes([
      {
        workspaceId: WORKSPACE_ID,
        moduleConnectionId: MODULE_ID,
        groupIds: [GROUP_ID],
      },
    ]);

    expect(await store.snapshot()).toEqual([
      groupState({ groupId: GROUP_ID }),
      groupState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: SECOND_MODULE_ID,
        groupId: GROUP_ID,
      }),
    ]);
    expect(await store.moduleSnapshot()).toEqual([
      moduleSequenceState(),
      moduleSequenceState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: SECOND_MODULE_ID,
      }),
    ]);
    await store.close();
  });

  it("reconciles an explicitly empty workspace without clearing inactive workspace state", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState());
    await store.upsert(
      groupState({
        workspaceId: SECOND_WORKSPACE_ID,
        moduleConnectionId: SECOND_MODULE_ID,
      }),
    );

    await store.reconcileScopes([], [SECOND_WORKSPACE_ID]);

    expect(await store.snapshot()).toEqual([groupState()]);
    await store.close();
  });

  it("recovers as empty from malformed state and reports a diagnostic", async () => {
    const filePath = await temporaryStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not valid json", { mode: 0o644 });
    const onDiagnostic = vi.fn();
    const store = new JsonRossRouteGroupStateStore({ filePath, onDiagnostic });

    expect(await store.snapshot()).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ross_route_group_state_invalid" }),
    );
    await store.upsert(groupState());
    await store.flush();
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await store.close();
  });

  it("serializes concurrent updates and flushes the final state before close", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.upsert(
          groupState({
            selectedDestination: index + 1,
            committedTakeSequence: index + 1,
          }),
        ),
      ),
    );
    await store.close();

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    expect(await reopened.snapshot()).toEqual([
      groupState({
        selectedDestination: 20,
        committedTakeSequence: 20,
      }),
    ]);
    await reopened.close();
  });

  it("repairs permissive permissions on an existing valid document", async () => {
    const filePath = await temporaryStatePath();
    const store = new JsonRossRouteGroupStateStore({ filePath });
    await store.upsert(groupState());
    await store.close();
    await chmod(filePath, 0o644);

    const reopened = new JsonRossRouteGroupStateStore({ filePath });
    await reopened.snapshot();
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await reopened.close();
  });
});

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const SECOND_WORKSPACE_ID = "30000000-0000-4000-8000-000000000002";
const MODULE_ID = "40000000-0000-4000-8000-000000000001";
const SECOND_MODULE_ID = "40000000-0000-4000-8000-000000000002";
const GROUP_ID = "50000000-0000-4000-8000-000000000001";
const SECOND_GROUP_ID = "50000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "60000000-0000-4000-8000-000000000001";
const STREAM_ID = "10000000-0000-4000-8000-000000000002";

function groupState(
  overrides: Partial<PersistedRossRouteGroupState> = {},
): PersistedRossRouteGroupState {
  return {
    workspaceId: WORKSPACE_ID,
    moduleConnectionId: MODULE_ID,
    connectionId: CONNECTION_ID,
    groupId: GROUP_ID,
    enabled: true,
    selectedDestination: 4,
    levels: [1, 2],
    committedTakeSequence: 8,
    ...overrides,
  };
}

function moduleSequenceState(
  overrides: Partial<PersistedRossRouteModuleSequenceState> = {},
): PersistedRossRouteModuleSequenceState {
  return {
    workspaceId: WORKSPACE_ID,
    moduleConnectionId: MODULE_ID,
    moduleSequenceHighWaterMark: 8,
    ...overrides,
  };
}

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hubble-ross-group-state-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "configuration", "ross-route-group-runtime.json");
}
