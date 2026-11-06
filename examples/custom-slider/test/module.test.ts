import test from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
import { createLatestValueQueue } from "../src/latest-value-queue.js";

test("the backend applies an in-range zoom and rejects the rest", async () => {
  const harness = createModuleHarness(module);
  await harness.instance.start();
  try {
    const setZoom = (value: unknown) =>
      harness.instance.call!(
        "page.zoom",
        { commandId: "set-zoom", value },
        harness.execution(),
      );
    assert.deepEqual(await setZoom({ zoom: 150.5 }), { zoom: 150.5 });
    assert.throws(() => setZoom({ zoom: 201 }), /Zoom must be/);
    assert.throws(() => setZoom({ zoom: "150" }), /Zoom must be/);
    assert.equal(harness.controls.length, 0);
  } finally {
    await harness.instance.dispose();
  }
});

function heldQueue() {
  const sends: {
    value: number;
    resolve: () => void;
    reject: (reason: Error) => void;
  }[] = [];
  const settled: { value: number; error: string | null; newest: boolean }[] =
    [];
  const queue = createLatestValueQueue<number>({
    send: (value) =>
      new Promise<void>((resolve, reject) => {
        sends.push({ value, resolve, reject });
      }),
    onSettled: (result) => {
      settled.push({
        value: result.value,
        error: result.error?.message ?? null,
        newest: result.newest,
      });
    },
  });
  return { queue, sends, settled };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the queue keeps one command in flight and collapses to the newest value", async () => {
  const { queue, sends, settled } = heldQueue();
  queue.push(101);
  queue.push(102);
  queue.push(103);
  assert.deepEqual(
    sends.map((send) => send.value),
    [101],
  );
  assert.equal(queue.pending, true);
  sends[0]!.resolve();
  await flush();
  assert.deepEqual(
    sends.map((send) => send.value),
    [101, 103],
  );
  assert.deepEqual(settled, [{ value: 101, error: null, newest: false }]);
  sends[1]!.resolve();
  await flush();
  assert.equal(queue.pending, false);
  assert.deepEqual(settled.at(-1), { value: 103, error: null, newest: true });
});

test("the queue keeps sending after a failure and flags whether it was the newest", async () => {
  const { queue, sends, settled } = heldQueue();
  queue.push(101);
  queue.push(102);
  sends[0]!.reject(new Error("older failed"));
  await flush();
  assert.deepEqual(settled[0], {
    value: 101,
    error: "older failed",
    newest: false,
  });
  sends[1]!.reject(new Error("newest failed"));
  await flush();
  assert.deepEqual(settled[1], {
    value: 102,
    error: "newest failed",
    newest: true,
  });
  assert.equal(queue.pending, false);
  queue.push(103);
  assert.equal(sends.at(-1)?.value, 103);
});
