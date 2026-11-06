import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  AutomaticTakeSettingsModel,
  followRoutingRevision,
  type AutomaticTakeRow,
} from "../src/frontend/automatic-take-settings.js";
import type { GroupPage } from "../src/group-page.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup(names: readonly string[] = ["Router"], automaticTake = true) {
  const contexts = names.map((name) => ({ contextId: randomUUID(), name }));
  const page = (contextId: string | null, enabled: boolean): GroupPage => ({
    contexts,
    contextId: contextId ?? contexts[0]!.contextId,
    automaticTake: enabled,
    groups: [],
  });
  const edits: {
    input: unknown;
    held: ReturnType<typeof deferred<GroupPage>>;
  }[] = [];
  const call = vi.fn((command: string, value: unknown) => {
    if (command === "groups")
      return Promise.resolve(page(value as string | null, automaticTake));
    const held = deferred<GroupPage>();
    edits.push({ input: value, held });
    return held.promise;
  });
  const seen: (readonly AutomaticTakeRow[])[] = [];
  const failed = vi.fn();
  const model = new AutomaticTakeSettingsModel(
    { call } as never,
    (rows) => seen.push(rows),
    failed,
  );
  return { contexts, page, edits, call, seen, failed, model };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("shows the saved value of every routing context", async () => {
  const { model, contexts } = setup(["Program", "Preview"], false);
  await model.load();
  expect(model.rows).toEqual(
    contexts.map(({ contextId, name }) => ({
      contextId,
      name,
      automaticTake: false,
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
