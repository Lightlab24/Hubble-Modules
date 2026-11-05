import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleHostServices,
  ModuleDocumentSnapshot,
  ModuleDocumentRequest,
  ModuleLogicalContext,
} from "@hubble/module-sdk";
import { RouterGroupController } from "../src/group-controller.js";
import {
  normalizeRouterGroups,
  RouterGroupDocumentSchema,
} from "../src/group-document.js";
import type { RossRouteGroupConnectionManager } from "../src/group-runtime.js";
import {
  routerMatrixAction,
  routerMatrixDestination,
  createRouterMatrixFeedback,
} from "../src/matrix.js";
import type { RouterActionDefinition } from "../src/actions.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const runtimeDirectory = await mkdtemp(
    path.join(tmpdir(), "router-group-controller-"),
  );
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const scope = {
    kind: "connection" as const,
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
  };
  const alias = (name: string): ModuleLogicalContext => ({
    name,
    reference: {
      kind: "hubble-context-reference",
      formatVersion: 1,
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      contextId: randomUUID(),
      unresolved: false,
    },
  });
  const contexts = [alias("Operator A"), alias("Operator B")];
  const document: ModuleDocumentSnapshot = {
    workspaceId: scope.workspaceId,
    owner: {
      kind: "connection",
      connectionId: scope.connectionId,
      moduleId: "hubble-ross-ultrix-ogp",
    },
    id: "routing-groups",
    version: 1,
    revision: null,
    value: { contexts: [] },
    canUndo: false,
    canRedo: false,
  };
  let conflict: (() => void) | undefined;
  const write = vi.fn((value: unknown) => {
    document.value = normalizeRouterGroups(
      RouterGroupDocumentSchema.parse(document.value),
      value,
    );
    document.revision = randomUUID();
  });
  const services = {
    request: vi.fn(
      async (
        service: string,
        _version: number,
        raw: unknown,
        signal?: AbortSignal,
      ) => {
        const input = raw as ModuleDocumentRequest;
        if (input.method === "watch")
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("Cancelled"));
            else
              signal?.addEventListener(
                "abort",
                () => reject(new Error("Cancelled")),
                { once: true },
              );
          });
        if (service === "contexts")
          return {
            revision: "a".repeat(64),
            contexts: structuredClone(contexts),
          };
        if (service !== "documents") throw new Error("Unexpected service");
        if (input.method === "write") {
          if (conflict) {
            const callback = conflict;
            conflict = undefined;
            callback();
          }
          if (input.expectedRevision !== document.revision)
            return { status: "conflict", document: structuredClone(document) };
          write(input.value);
        }
        return { status: "document", document: structuredClone(document) };
      },
    ),
  } as unknown as ModuleHostServices;
  const manager: RossRouteGroupConnectionManager = {
    snapshots: () =>
      [
        {
          definition: {
            connectionId: scope.connectionId,
            type: "ross-ultrix-ogp",
            levels: 4,
          },
        },
      ] as unknown as ReturnType<RossRouteGroupConnectionManager["snapshots"]>,
    submitDirectRouteTracked: vi.fn(() => ({
      submissionId: randomUUID(),
      accepted: Promise.resolve(),
      settled: Promise.resolve(),
    })),
    watchConfirmedRouteTarget: (_target, _listener) => () => {},
  };
  const context: ModuleContext = {
    runtimeDirectory,
    scope,
    instanceId: randomUUID(),
    settings: {},
    services,
    log: vi.fn(),
    publishFeedback: vi.fn(),
    publishState: vi.fn(),
  };
  const create = () => {
    const controller = new RouterGroupController(context, manager);
    cleanups.push(() => controller.stop());
    return controller;
  };
  const controller = create();
  await controller.refresh();
  const action = (index = 0, groupId: string | null = null) => ({
    ...scope,
    moduleConnectionId: contexts[index]!.reference.contextId,
    groupId,
  });
  const edit = (groups: { id: string; name: string }[], index = 0) =>
    controller.edit(
      contexts[index]!.reference.contextId,
      (item) => ({ ...item, groups }),
      new AbortController().signal,
    );
  return {
    controller,
    create,
    runtimeDirectory,
    scope,
    contexts,
    document,
    services,
    context,
    manager,
    action,
    edit,
    write,
    conflict: (fn: () => void) => {
      conflict = fn;
    },
  };
}

it.each([
  "ross-ultrix-ogp",
  "blackmagic-videohub",
  "aja-kumo",
  "evertz-quartz",
] as const)(
  "%s selects and highlights the first accepted destination without routing",
  async (type) => {
    const f = await fixture();
    const scope = f.action();
    await f.controller.edit(
      scope.moduleConnectionId,
      (value) => ({ ...value, automaticTake: true }),
      new AbortController().signal,
    );
    const fields = (actionValue: string) => ({
      contextId: scope.moduleConnectionId,
      actionId: "destination-row",
      actionColumnId: randomUUID(),
      values: {
        actionType: "select-destination",
        actionValue,
        drivesTally: true,
        feedbackColor: "#123456",
      },
    });
    const column = fields("8");
    const observe = (value: string) => {
      const row = routerMatrixDestination(type, {
        ...column,
        values: { ...column.values, actionValue: value },
      });
      return f.controller.observeMatrixDestinations(row ? [row] : []);
    };
    const color = (value: string) => {
      const mapped = routerMatrixAction(
        type,
        {
          ...column,
          values: { ...column.values, actionValue: value },
        },
        {},
      );
      return createRouterMatrixFeedback(
        f.scope.workspaceId,
        f.controller,
        [],
      )({
        ...mapped.fields,
        type: mapped.id,
        connectionId: f.scope.connectionId,
        enabled: true,
      } as RouterActionDefinition).appearance?.cells?.actionValue?.color;
    };
    await observe("8");
    expect(color("8")).toBe("#123456");
    await observe("5, 8");
    expect(color("5, 8")).toBe("#FF0000");
    expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
    await f.controller.dispatch("cycleDestination", {
      ...scope,
      destinations: [5, 8],
      step: 1,
      wrap: true,
    });
    await observe("5, 8");
    expect(color("5, 8")).toBe("#0000FF");
    await observe("8, 5");
    await observe("6");
    expect(color("6")).toBe("#123456");
    expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
    await f.controller.dispatch("selectSource", {
      ...scope,
      source: 3,
      levels: [1],
    });
    expect(f.manager.submitDirectRouteTracked).toHaveBeenCalledExactlyOnceWith({
      connectionId: f.scope.connectionId,
      source: 3,
      destination: 6,
      levels: [1],
    });
    await observe("");
    await expect(
      f.controller.dispatch("selectSource", {
        ...scope,
        source: 4,
        levels: [1],
      }),
    ).rejects.toThrow(/destination is not configured/);
    expect(f.manager.submitDirectRouteTracked).toHaveBeenCalledTimes(1);
  },
);

it("moves a selected destination through first/last group edits and restores it after restart without a device command", async () => {
  const f = await fixture(),
    groupId = randomUUID();
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 9,
  });
  await f.controller.dispatch("selectSource", {
    ...f.action(),
    source: 3,
    levels: [1, 2],
  });
  await f.edit([{ id: groupId, name: "Studio" }]);
  expect(
    f.controller.runtime
      .snapshots()
      .find(
        (item) => item.moduleConnectionId === f.action().moduleConnectionId,
      ),
  ).toMatchObject({ groupId, selectedDestination: 9, stagedSource: 3 });
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 12,
  }); // Former blank actions still work.
  await f.controller.stop();
  const restarted = f.create();
  await restarted.refresh();
  expect(
    restarted.runtime
      .snapshots()
      .find(
        (item) => item.moduleConnectionId === f.action().moduleConnectionId,
      ),
  ).toMatchObject({ groupId, selectedDestination: 12, stagedSource: null });
  await restarted.edit(
    f.contexts[0]!.reference.contextId,
    (item) => ({ ...item, groups: [] }),
    new AbortController().signal,
  );
  await restarted.dispatch("selectDestination", {
    ...f.action(0, groupId),
    destination: 14,
  });
  expect(
    restarted.runtime
      .snapshots()
      .find(
        (item) => item.moduleConnectionId === f.action().moduleConnectionId,
      ),
  ).toMatchObject({ groupId: null, selectedDestination: 14 });
  expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
});

it("retries a document conflict without dropping another alias, and rejects a foreign action scope", async () => {
  const f = await fixture(),
    otherGroup = randomUUID();
  f.conflict(() => {
    f.write({
      contexts: [
        {
          reference: f.contexts[1]!.reference,
          groups: [{ id: otherGroup, name: "Truck" }],
        },
      ],
    });
  });
  await f.edit([{ id: randomUUID(), name: "Studio" }]);
  expect(
    RouterGroupDocumentSchema.parse(f.document.value).contexts,
  ).toHaveLength(2);
  expect(f.controller.snapshot().contexts[1]!.settings.groups).toEqual([
    { id: otherGroup, name: "Truck" },
  ]);
  await expect(
    f.controller.dispatch("selectDestination", {
      ...f.action(),
      workspaceId: randomUUID(),
      destination: 1,
    }),
  ).rejects.toThrow("scope changed");
  await expect(
    f.controller.dispatch("selectDestination", {
      ...f.action(),
      moduleConnectionId: randomUUID(),
      destination: 1,
    }),
  ).rejects.toThrow("unavailable");
  expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
});

it("replays an interrupted group-state transition once after restart and retains unrelated selections", async () => {
  const f = await fixture(),
    groupId = randomUUID();
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 8,
  });
  await f.controller.dispatch("selectDestination", {
    ...f.action(1),
    destination: 17,
  });
  vi.spyOn(f.controller.runtime, "applyTransition").mockRejectedValueOnce(
    new Error("Temporary storage failure"),
  );
  await expect(f.edit([{ id: groupId, name: "Studio" }])).rejects.toThrow(
    "storage failure",
  );
  expect(
    JSON.parse(
      await readFile(
        path.join(f.runtimeDirectory, "group-configuration-journal.json"),
        "utf8",
      ),
    ).pending,
  ).not.toBeNull();
  await f.controller.stop();
  const restarted = f.create();
  await restarted.refresh();
  await restarted.refresh();
  expect(restarted.runtime.snapshots()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        moduleConnectionId: f.action().moduleConnectionId,
        groupId,
        selectedDestination: 8,
      }),
      expect.objectContaining({
        moduleConnectionId: f.action(1).moduleConnectionId,
        groupId: null,
        selectedDestination: 17,
      }),
    ]),
  );
  const journal = JSON.parse(
    await readFile(
      path.join(f.runtimeDirectory, "group-configuration-journal.json"),
      "utf8",
    ),
  );
  expect(journal).toMatchObject({ sequence: 1, pending: null });
});

it("rejects ordinary deleted groups and removes a deleted alias without discarding another alias", async () => {
  const f = await fixture(),
    first = randomUUID(),
    second = randomUUID();
  await f.edit([
    { id: first, name: "A" },
    { id: second, name: "B" },
  ]);
  await f.controller.dispatch("selectDestination", {
    ...f.action(0, second),
    destination: 8,
  });
  await f.controller.dispatch("selectDestination", {
    ...f.action(1),
    destination: 17,
  });
  await f.edit([{ id: second, name: "B" }]);
  await expect(
    f.controller.dispatch("selectDestination", {
      ...f.action(0, first),
      destination: 2,
    }),
  ).rejects.toThrow("available routing group");
  f.contexts.shift();
  await f.controller.refresh();
  expect(f.controller.runtime.snapshots()).toHaveLength(1);
  expect(f.controller.runtime.snapshots()[0]).toMatchObject({
    selectedDestination: 17,
  });
});

it("submits successive routes without waiting for another host settings read", async () => {
  const f = await fixture();
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 9,
  });
  await f.controller.edit(
    f.action().moduleConnectionId,
    (settings) => ({
      ...settings,
      automaticTake: true,
    }),
    new AbortController().signal,
  );
  const request = vi.mocked(f.services.request);
  const original = request.getMockImplementation()!;
  let release = () => {};
  const heldRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  request.mockClear();
  request.mockImplementation(async (...args) => {
    if ((args[2] as { method: string }).method === "read") await heldRead;
    return original(...args);
  });
  const first = f.controller.dispatch("selectSource", {
    ...f.action(),
    source: 2,
    levels: [1],
  });
  const second = f.controller.dispatch("selectSource", {
    ...f.action(),
    source: 3,
    levels: [1],
  });
  try {
    await nextTurn();
    expect(f.manager.submitDirectRouteTracked).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

it("applies an already queued configuration update before the next route", async () => {
  const f = await fixture();
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 9,
  });
  await f.controller.edit(
    f.action().moduleConnectionId,
    (settings) => ({
      ...settings,
      automaticTake: true,
    }),
    new AbortController().signal,
  );
  f.document.value = {
    contexts: [
      { reference: f.contexts[0]!.reference, automaticTake: false, groups: [] },
    ],
  };
  const request = vi.mocked(f.services.request);
  const original = request.getMockImplementation()!;
  let release = () => {};
  const heldRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  request.mockImplementation(async (...args) => {
    if ((args[2] as { method: string }).method === "read") await heldRead;
    return original(...args);
  });
  const refresh = f.controller.refresh();
  const route = f.controller.dispatch("selectSource", {
    ...f.action(),
    source: 2,
    levels: [1],
  });
  try {
    await nextTurn();
    expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([refresh, route]);
  }
  expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
  expect(
    f.controller.runtime
      .snapshots()
      .find(
        (item) => item.moduleConnectionId === f.action().moduleConnectionId,
      ),
  ).toMatchObject({
    automaticTake: false,
    stagedSource: 2,
  });
});

it("rereads authoritative settings before routing while a configuration watch is failing", async () => {
  const f = await fixture();
  await f.controller.dispatch("selectDestination", {
    ...f.action(),
    destination: 9,
  });
  await f.controller.edit(
    f.action().moduleConnectionId,
    (settings) => ({
      ...settings,
      automaticTake: true,
    }),
    new AbortController().signal,
  );
  const request = vi.mocked(f.services.request);
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => {
    if (
      args[0] === "contexts" &&
      (args[2] as { method: string }).method === "watch"
    )
      throw new Error("Watch unavailable");
    return original(...args);
  });
  await f.controller.start();
  await nextTurn();
  expect(f.context.log).toHaveBeenCalledWith(
    expect.objectContaining({ stage: "router-groups-watch" }),
  );
  f.document.value = {
    contexts: [
      { reference: f.contexts[0]!.reference, automaticTake: false, groups: [] },
    ],
  };
  await f.controller.dispatch("selectSource", {
    ...f.action(),
    source: 2,
    levels: [1],
  });
  expect(f.manager.submitDirectRouteTracked).not.toHaveBeenCalled();
  expect(
    f.controller.runtime
      .snapshots()
      .find(
        (item) => item.moduleConnectionId === f.action().moduleConnectionId,
      ),
  ).toMatchObject({
    automaticTake: false,
    stagedSource: 2,
  });
});
