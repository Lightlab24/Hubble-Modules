import test from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module, { REPLY_MS } from "../src/index.js";
import {
  LOCKED_PRESET,
  applyControl,
  applyPress,
  filterSources,
  initialDevice,
} from "../src/device.js";
import { createLatestValueQueue } from "../src/latest-value-queue.js";

test("the device applies valid control values and rejects the rest", () => {
  let device = initialDevice();
  device = applyControl(device, { control: "record", value: true });
  device = applyControl(device, { control: "bus", value: "pvw" });
  device = applyControl(device, { control: "preset", value: 12 });
  device = applyControl(device, { control: "cue", value: "10:59:59:24" });
  device = applyControl(device, { control: "ptz", value: { x: -170, y: 90 } });
  device = applyControl(device, { control: "source", value: "evs1" });
  device = applyControl(device, { control: "color", value: "#FF0000" });
  assert.deepEqual(
    {
      record: device.record,
      bus: device.bus,
      preset: device.preset,
      cue: device.cue,
      ptz: device.ptz,
      source: device.source,
      color: device.color,
    },
    {
      record: true,
      bus: "pvw",
      preset: 12,
      cue: "10:59:59:24",
      ptz: { x: -170, y: 90 },
      source: "evs1",
      color: "#ff0000",
    },
  );
  for (const [request, message] of [
    [{ control: "record", value: "on" }, /on or off/],
    [{ control: "bus", value: "aux" }, /Program, Preview or Off/],
    [{ control: "preset", value: 1.5 }, /whole number/],
    [{ control: "preset", value: LOCKED_PRESET }, /locked/],
    [{ control: "cue", value: "00:00:10:27" }, /frames go up to 24/],
    [{ control: "ptz", value: { x: 200, y: 0 } }, /out of range/],
    [{ control: "source", value: "nope" }, /not on this router/],
    [{ control: "color", value: "red" }, /#RRGGBB/],
    [{ control: "zoom", value: 1 }, /Unknown control/],
  ] as const)
    assert.throws(() => applyControl(device, request), message);
});

test("a momentary take completes on release only", () => {
  let device = applyPress(initialDevice(), { button: "take", down: true });
  assert.equal(device.take, true);
  assert.equal(device.takes, 0);
  device = applyPress(device, { button: "take", down: false });
  assert.deepEqual([device.take, device.takes], [false, 1]);
  assert.throws(
    () => applyPress(device, { button: "cut", down: true }),
    /Unknown button/,
  );
});

test("sources filter by label and group", () => {
  assert.deepEqual(
    filterSources("play").map((source) => source.value),
    ["evs1", "evs2"],
  );
  assert.equal(filterSources("").length, 8);
});

test("the backend replies after a delay, publishes the device and honours cancellation", async () => {
  const harness = createModuleHarness(module, {
    settings: { tallyOutput: true },
  });
  await harness.instance.start();
  try {
    const call = (commandId: string, value: unknown, signal?: AbortSignal) =>
      harness.instance.call!(
        "page.controls",
        { commandId, value },
        signal ? { ...harness.execution(), signal } : harness.execution(),
      );
    const started = Date.now();
    assert.deepEqual(await call("set", { control: "record", value: true }), {
      ok: true,
    });
    assert.ok(Date.now() - started >= REPLY_MS - 20);
    const published = harness.states.at(-1)?.values;
    assert.equal(published?.record, true);
    assert.equal(published?.audioL, -9);
    // cam4 is never published, so its lamp shows unknown rather than off.
    assert.equal(published && "cam4" in published, false);
    await assert.rejects(
      call("set", { control: "preset", value: LOCKED_PRESET }),
      /locked/,
    );
    const controller = new AbortController();
    const pending = call(
      "set",
      { control: "bus", value: "pvw" },
      controller.signal,
    );
    controller.abort(new Error("Page closed"));
    await assert.rejects(pending, /Page closed/);
    assert.deepEqual(await call("sources", "cam 1"), {
      sources: [{ value: "cam1", label: "CAM 1", group: "Cameras" }],
    });
    assert.equal(harness.controls.length, 0);
  } finally {
    await harness.instance.dispose();
  }
});

test("the queue sends the newest value after a held reply and reports an older failure as stale", async () => {
  const sends: {
    value: number;
    resolve: () => void;
    reject: (error: Error) => void;
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
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  queue.push(12);
  queue.push(13);
  queue.push(14);
  sends[0]!.reject(new Error("held reply failed"));
  await flush();
  assert.deepEqual(settled[0], {
    value: 12,
    error: "held reply failed",
    newest: false,
  });
  assert.deepEqual(
    sends.map((send) => send.value),
    [12, 14],
  );
  sends[1]!.resolve();
  await flush();
  assert.equal(queue.pending, false);
});
