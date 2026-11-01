import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { GroupEditQueue } from "../src/frontend/group-edit-queue.js";
import type { GroupPage } from "../src/group-page.js";
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const page = (): GroupPage => {
  const contextId = randomUUID();
  return {
    contexts: [{ contextId, name: "Operator" }],
    contextId,
    automaticTake: false,
    groups: [],
  };
};

it("creates full stable groups immediately and keeps a second edit through the first unresolved receipt", async () => {
  const initial = page(),
    first = deferred<GroupPage>(),
    second = deferred<GroupPage>(),
    changed = vi.fn();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const queue = new GroupEditQueue(initial, save, changed, vi.fn()),
    id = randomUUID(),
    contextId = initial.contextId!;
  const add = queue.edit({ operation: "add", contextId, id, name: "Studio" });
  const rename = queue.edit({
    operation: "rename",
    contextId,
    id,
    name: "Truck",
  });
  expect(queue.snapshot.groups).toEqual([{ id, name: "Truck" }]);
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve({ ...initial, groups: [{ id, name: "Studio" }] });
  await add;
  expect(queue.snapshot.groups).toEqual([{ id, name: "Truck" }]);
  second.resolve({ ...initial, groups: [{ id, name: "Truck" }] });
  await rename;
  expect(queue.snapshot.groups).toEqual([{ id, name: "Truck" }]);
  expect(queue.busy).toBe(false);
});

it("rolls back a failed addition and its dependent rename, preserves unrelated work, and ignores a stale read", async () => {
  const initial = page(),
    first = deferred<GroupPage>(),
    changed = vi.fn(),
    failed = vi.fn();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...initial, automaticTake: true });
  const queue = new GroupEditQueue(initial, save, changed, failed),
    epoch = queue.readEpoch,
    id = randomUUID(),
    contextId = initial.contextId!;
  const add = queue
    .edit({ operation: "add", contextId, id, name: "Studio" })
    .catch((error) => error);
  const rename = queue
    .edit({ operation: "rename", contextId, id, name: "Truck" })
    .catch((error) => error);
  const toggle = queue.edit({
    operation: "automatic-take",
    contextId,
    enabled: true,
  });
  expect(queue.snapshot).toMatchObject({
    automaticTake: true,
    groups: [{ id, name: "Truck" }],
  });
  first.reject(new Error("Save failed"));
  expect(await add).toBeInstanceOf(Error);
  expect(await rename).toBeInstanceOf(Error);
  await toggle;
  queue.refresh(initial, epoch);
  expect(queue.snapshot).toMatchObject({ automaticTake: true, groups: [] });
  expect(save).toHaveBeenCalledTimes(2);
  expect(failed).toHaveBeenCalledWith("Save failed");
});

it("removes a row immediately and restores it on rejection while keeping another group edit", async () => {
  const initial = page(),
    first = deferred<GroupPage>(),
    a = randomUUID(),
    b = randomUUID();
  initial.groups = [
    { id: a, name: "A" },
    { id: b, name: "B" },
  ];
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({
      ...initial,
      groups: [
        { id: a, name: "A" },
        { id: b, name: "Truck" },
      ],
    });
  const queue = new GroupEditQueue(initial, save, vi.fn(), vi.fn()),
    contextId = initial.contextId!;
  const remove = queue
    .edit({ operation: "delete", contextId, id: a })
    .catch((error) => error);
  const rename = queue.edit({
    operation: "rename",
    contextId,
    id: b,
    name: "Truck",
  });
  expect(queue.snapshot.groups).toEqual([{ id: b, name: "Truck" }]);
  first.reject(new Error("Storage failed"));
  await remove;
  await rename;
  expect(queue.snapshot.groups).toEqual([
    { id: a, name: "A" },
    { id: b, name: "Truck" },
  ]);
});
