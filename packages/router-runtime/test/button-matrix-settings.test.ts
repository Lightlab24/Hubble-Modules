import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  ButtonMatrixSettingsModel,
  MAX_ROUTING_GROUPS,
  followRoutingRevision,
  nextGroupName,
  type ButtonMatrixSettingsRow,
} from "../src/frontend/button-matrix-settings.js";
import type { GroupEdit, GroupPage } from "../src/group-page.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

type Group = GroupPage["groups"][number];

function setup(
  names: readonly string[] = ["Router"],
  automaticTake = true,
  groups: readonly Group[] = [],
) {
  const contexts = names.map((name) => ({ contextId: randomUUID(), name }));
  const page = (
    contextId: string | null,
    enabled: boolean,
    saved: readonly Group[] = groups,
  ): GroupPage => ({
    contexts,
    contextId: contextId ?? contexts[0]!.contextId,
    automaticTake: enabled,
    groups: [...saved],
  });
  const edits: {
    input: GroupEdit;
    held: ReturnType<typeof deferred<GroupPage>>;
  }[] = [];
  const call = vi.fn((command: string, value: unknown) => {
    if (command === "groups")
      return Promise.resolve(page(value as string | null, automaticTake));
    const held = deferred<GroupPage>();
    edits.push({ input: value as GroupEdit, held });
    return held.promise;
  });
  const seen: (readonly ButtonMatrixSettingsRow[])[] = [];
  const failed = vi.fn();
  const ids: string[] = [];
  const model = new ButtonMatrixSettingsModel(
    { call } as never,
    (rows) => seen.push(rows),
    failed,
    () => {
      const id = randomUUID();
      ids.push(id);
      return id;
    },
  );
  return { contexts, page, edits, call, seen, failed, model, ids };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("shows the saved Automatic Take and groups of every routing context", async () => {
  const studio = { id: randomUUID(), name: "Studio" };
  const { model, contexts } = setup(["Program", "Preview"], false, [studio]);
  await model.load();
  expect(model.rows).toEqual(
    contexts.map(({ contextId, name }) => ({
      contextId,
      name,
      automaticTake: false,
      groups: [studio],
    })),
  );
});

it("updates immediately and accepts a second toggle while the first save is held", async () => {
  const { model, contexts, edits, page, seen } = setup();
  const contextId = contexts[0]!.contextId;
  await model.load();
  expect(model.rows[0]?.automaticTake).toBe(true);

  model.setAutomaticTake(contextId, false);
  expect(model.rows[0]?.automaticTake).toBe(false);
  expect(seen.at(-1)?.[0]?.automaticTake).toBe(false);
  expect(edits).toHaveLength(1);

  model.setAutomaticTake(contextId, true);
  expect(model.rows[0]?.automaticTake).toBe(true);
  // Saves stay ordered: the second waits for the first acknowledgement.
  expect(edits).toHaveLength(1);

  edits[0]!.held.resolve(page(contextId, false));
  await settle();
  // The first receipt must not overwrite the newer pending choice.
  expect(model.rows[0]?.automaticTake).toBe(true);
  expect(edits).toHaveLength(2);
  expect(edits[1]?.input).toEqual({
    operation: "automatic-take",
    contextId,
    enabled: true,
  });
  edits[1]!.held.resolve(page(contextId, true));
  await settle();
  expect(model.rows[0]?.automaticTake).toBe(true);
});

it("rolls back only the failed row and reports why", async () => {
  const { model, contexts, edits, page, failed } = setup(
    ["Program", "Preview"],
    true,
  );
  const [program, preview] = contexts;
  await model.load();

  model.setAutomaticTake(program!.contextId, false);
  model.setAutomaticTake(preview!.contextId, false);
  expect(model.rows.map((row) => row.automaticTake)).toEqual([false, false]);

  edits[0]!.held.reject(new Error("Routing settings changed; retry this edit"));
  edits[1]!.held.resolve(page(preview!.contextId, false));
  await settle();

  expect(failed).toHaveBeenCalledWith(
    "Routing settings changed; retry this edit",
  );
  expect(model.rows.map((row) => row.automaticTake)).toEqual([true, false]);
});

it("shows a full new group at once and keeps a rename made before its save returns", async () => {
  const { model, contexts, edits, page, ids } = setup();
  const contextId = contexts[0]!.contextId;
  await model.load();

  model.addGroup(contextId);
  const id = ids[0]!;
  expect(model.rows[0]?.groups).toEqual([{ id, name: "Group 1" }]);
  expect(edits).toHaveLength(1);

  // Second edit while the first save is still held.
  const rename = model.renameGroup(contextId, id, "Studio");
  expect(model.rows[0]?.groups).toEqual([{ id, name: "Studio" }]);
  expect(edits).toHaveLength(1);

  edits[0]!.held.resolve(page(contextId, true, [{ id, name: "Group 1" }]));
  await settle();
  expect(model.rows[0]?.groups).toEqual([{ id, name: "Studio" }]);
  expect(edits[1]?.input).toEqual({
    operation: "rename",
    contextId,
    id,
    name: "Studio",
  });
  edits[1]!.held.resolve(page(contextId, true, [{ id, name: "Studio" }]));
  await rename;
  expect(model.rows[0]?.groups).toEqual([{ id, name: "Studio" }]);
});

it("removes a deleted group at once", async () => {
  const studio = { id: randomUUID(), name: "Studio" };
  const truck = { id: randomUUID(), name: "Truck" };
  const { model, contexts, edits, page } = setup(["Router"], true, [
    studio,
    truck,
  ]);
  const contextId = contexts[0]!.contextId;
  await model.load();

  model.deleteGroup(contextId, studio.id);
  expect(model.rows[0]?.groups).toEqual([truck]);
  edits[0]!.held.resolve(page(contextId, true, [truck]));
  await settle();
  expect(model.rows[0]?.groups).toEqual([truck]);
});

it("drops a failed new group and its rename, keeping other contexts' edits", async () => {
  const { model, contexts, edits, page, ids, failed } = setup([
    "Program",
    "Preview",
  ]);
  const [program, preview] = contexts;
  await model.load();

  model.addGroup(program!.contextId);
  const rename = model.renameGroup(program!.contextId, ids[0]!, "Studio");
  model.setAutomaticTake(preview!.contextId, false);
  expect(model.rows[0]?.groups).toEqual([{ id: ids[0], name: "Studio" }]);

  edits[0]!.held.reject(new Error("Group names must be unique"));
  edits[1]!.held.resolve(page(preview!.contextId, false));
  await expect(rename).rejects.toThrow("The routing group could not be added");
  await settle();

  expect(failed).toHaveBeenCalledWith("Group names must be unique");
  expect(model.rows[0]?.groups).toEqual([]);
  // The dependent rename was never sent.
  expect(edits.map(({ input }) => input.operation)).toEqual([
    "add",
    "automatic-take",
  ]);
  expect(model.rows[1]?.automaticTake).toBe(false);
});

it("names new groups after the ones that exist and stops at the limit", async () => {
  expect(nextGroupName([])).toBe("Group 1");
  expect(nextGroupName([{ name: "group 1" }, { name: "Group 3" }])).toBe(
    "Group 2",
  );
  const full = Array.from({ length: MAX_ROUTING_GROUPS }, (_, index) => ({
    id: randomUUID(),
    name: `Group ${String(index + 1)}`,
  }));
  const { model, contexts, edits } = setup(["Router"], true, full);
  await model.load();
  model.addGroup(contexts[0]!.contextId);
  expect(edits).toHaveLength(0);
  expect(model.rows[0]?.groups).toHaveLength(MAX_ROUTING_GROUPS);
});

it("does not let a read that started before an edit replace that edit", async () => {
  const { model, contexts, call, page, edits } = setup();
  const contextId = contexts[0]!.contextId;
  await model.load();

  const read = deferred<GroupPage>();
  call.mockImplementationOnce(() => read.promise);
  const reload = model.load();
  model.setAutomaticTake(contextId, false);
  read.resolve(page(contextId, true));
  await reload;
  expect(model.rows[0]?.automaticTake).toBe(false);

  edits[0]!.held.resolve(page(contextId, false));
  await settle();
  expect(model.rows[0]?.automaticTake).toBe(false);
});

it("reloads only when the published routing revision changes", () => {
  const reload = vi.fn();
  const follow = followRoutingRevision(reload);
  follow(null);
  follow({ phase: "connecting", values: {} });
  follow({ phase: "ready", values: { routingGroupsRevision: "a" } });
  expect(reload).not.toHaveBeenCalled();
  follow({ phase: "ready", values: { routingGroupsRevision: "a" } });
  expect(reload).not.toHaveBeenCalled();
  follow({ phase: "ready", values: { routingGroupsRevision: "b" } });
  expect(reload).toHaveBeenCalledTimes(1);
});
