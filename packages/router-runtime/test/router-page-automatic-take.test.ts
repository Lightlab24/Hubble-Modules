import { expect, it, vi } from "vitest";
import { PreferenceSaveQueue } from "../src/frontend/preference-save-queue.js";
import { routerViewPreferences } from "../src/module.js";

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup(initial = false) {
  const saves: { value: boolean; held: ReturnType<typeof deferred> }[] = [];
  const shown: boolean[] = [];
  const failed = vi.fn();
  const queue = new PreferenceSaveQueue(
    initial,
    (value: boolean) => {
      const held = deferred();
      saves.push({ value, held });
      return held.promise;
    },
    (value) => shown.push(value),
    failed,
  );
  return { queue, saves, shown, failed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("shows the choice at once and saves a second choice after the first", async () => {
  const { queue, saves, shown } = setup();
  void queue.set(true);
  expect(queue.value).toBe(true);
  expect(shown).toEqual([true]);
  await settle();
  expect(saves.map(({ value }) => value)).toEqual([true]);

  // Second choice while the first save is held.
  void queue.set(false);
  expect(queue.value).toBe(false);
  await settle();
  expect(saves).toHaveLength(1);

  saves[0]!.held.resolve();
  await settle();
  expect(queue.value).toBe(false);
  expect(saves.map(({ value }) => value)).toEqual([true, false]);
  saves[1]!.held.resolve();
  await settle();
  expect(queue.value).toBe(false);
});

it("rolls back to the saved value when the newest save fails", async () => {
  const { queue, saves, failed } = setup(false);
  const done = queue.set(true);
  await settle();
  saves[0]!.held.reject(new Error("Router page preferences changed; try again"));
  await done;
  expect(queue.value).toBe(false);
  expect(failed).toHaveBeenCalledWith(
    "Router page preferences changed; try again",
  );
});

it("keeps a newer choice when an older save fails", async () => {
  const { queue, saves, failed } = setup(false);
  void queue.set(true);
  await settle();
  const done = queue.set(false);
  void queue.set(true);
  saves[0]!.held.reject(new Error("offline"));
  await settle();
  // The newest choice is still pending, so it stays on screen.
  expect(queue.value).toBe(true);
  expect(failed).toHaveBeenCalledTimes(1);
  saves[1]!.held.resolve();
  await done;
  await settle();
  saves[2]!.held.resolve();
  await settle();
  expect(queue.value).toBe(true);
});

it("reads the Router page preferences with safe defaults", () => {
  expect(routerViewPreferences({ zoom: 100 })).toEqual({
    zoom: 100,
    automaticTake: false,
    view: "patch",
  });
  expect(
    routerViewPreferences({ zoom: 125, automaticTake: true, view: "routes" }),
  ).toEqual({
    zoom: 125,
    automaticTake: true,
    view: "routes",
  });
  expect(
    routerViewPreferences({ zoom: "big", automaticTake: 1, view: "other" }),
  ).toEqual({
    zoom: 100,
    automaticTake: false,
    view: "patch",
  });
  expect(routerViewPreferences(null)).toEqual({
    zoom: 100,
    automaticTake: false,
    view: "patch",
  });
});
