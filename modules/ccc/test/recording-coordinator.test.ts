import { afterEach, describe, expect, it } from "vitest";
import { parseRecordMode } from "../src/recording-capabilities.js";
import {
  RecordingCoordinator,
  type RecordingSession,
  type RecordingTarget,
} from "../src/recording-coordinator.js";
import type { CyanViewCameraObservation } from "../src/rcp-session.js";
const coordinators: RecordingCoordinator[] = [];
afterEach(async () => {
  await Promise.all(
    coordinators.splice(0).map((coordinator) => coordinator.dispose()),
  );
});
function coordinator(
  options: Partial<ConstructorParameters<typeof RecordingCoordinator>[0]> = {},
) {
  const value = new RecordingCoordinator({
    feedbackTimeoutMs: 100,
    ...options,
  });
  coordinators.push(value);
  return value;
}
function camera(
  owner: RecordingCoordinator,
  key = "camera-1",
  initial: Partial<CyanViewCameraObservation> = {},
) {
  let observation: CyanViewCameraObservation = {
    address: `gateway/${key}`,
    number: 1,
    name: key,
    online: true,
    recording: false,
    recordingLocked: false,
    recordingSequence: 0,
    recordMode: "rec-stop",
    variableNd: false,
    baseGain: null,
    model: "",
    persistentLock: false,
    volatileLock: false,
    ...initial,
  };
  let generation = 0;
  const commands: string[] = [];
  let onSend: (() => Promise<void>) | undefined;
  const session: RecordingSession = {
    observeTarget(target) {
      if (target.generation !== generation)
        throw new Error("Disconnected; captured operation cannot be replayed");
      return observation;
    },
    async sendCameraCommand(target, value, signal, submitted) {
      session.observeTarget(target);
      if (signal?.aborted) throw new Error("Cancelled before sending");
      submitted?.();
      commands.push(value);
      await onSend?.();
    },
  };
  return {
    commands,
    capture: (): RecordingTarget => ({
      key,
      session,
      target: { address: observation.address, generation, observation },
    }),
    status(value: boolean | null, retained = false) {
      observation = {
        ...observation,
        recording: value,
        recordingSequence: retained ? 0 : observation.recordingSequence + 1,
      };
      owner.notify();
    },
    change(value: Partial<CyanViewCameraObservation>) {
      observation = { ...observation, ...value };
      owner.notify();
    },
    reconnect() {
      generation += 1;
      observation = { ...observation, recordingSequence: 0 };
      owner.notify();
    },
    setSend(operation: () => Promise<void>) {
      onSend = operation;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
describe("CyanView recording capabilities", () => {
  it("decodes the documented zero-based byte and anonymized offline capture encoding", () => {
    expect(
      parseRecordMode(
        "00 00 00 00 00 40 00 00 00 00 00 02 00 C0 00 00 00 00 00 00 00",
      ),
    ).toBe("rec-stop");
    expect(
      parseRecordMode("00 00 00 00 00 40 00 00 00 00 00 02 80 40 00"),
    ).toBe("toggle");
    for (const input of [
      "",
      "80",
      "00 ".repeat(13).trim(),
      "[0,128]",
      "00 ".repeat(13) + "GG",
      "00 ".repeat(13) + "080",
    ])
      expect(parseRecordMode(input)).toBeNull();
  });
});
describe("one module-owned recording coordinator", () => {
  it.each([
    ["rec-stop", false, "start", "Rec", true],
    ["rec-stop", true, "stop", "Stop", false],
    ["rec-stop", true, "toggle", "Stop", false],
    ["rec-stop", false, "toggle", "Rec", true],
    ["toggle", false, "start", "RecToggle", true],
    ["toggle", true, "stop", "RecToggle", false],
    ["toggle", false, "toggle", "RecToggle", true],
  ] as const)(
    "chooses %s commands from the latest state (%s → %s)",
    async (mode, recording, intent, command, expected) => {
      const owner = coordinator();
      const target = camera(owner, "camera", { recordMode: mode, recording });
      target.setSend(() => {
        target.status(expected);
        return Promise.resolve();
      });
      expect(await owner.record(target.capture(), intent)).toMatchObject({
        outcome: "success",
        evidence: "confirmed",
      });
      expect(target.commands).toEqual([command]);
    },
  );
  it.each([
    [true, "start"],
    [false, "stop"],
  ] as const)(
    "does not send for an already satisfied state (%s, %s)",
    async (recording, intent) => {
      const owner = coordinator();
      const target = camera(owner, "camera", {
        recording,
        recordMode: "toggle",
      });
      expect(await owner.record(target.capture(), intent)).toMatchObject({
        outcome: "success",
        evidence: "noop",
      });
      expect(target.commands).toEqual([]);
    },
  );
  it.each([
    { recording: null },
    { recordMode: null },
    { online: false },
    { recordingLocked: true },
  ])(
    "refuses unavailable, unknown or locked cameras without affecting healthy targets: %j",
    async (initial) => {
      const owner = coordinator();
      const target = camera(owner, "bad", initial);
      const good = camera(owner, "good");
      good.setSend(() => {
        good.status(true);
        return Promise.resolve();
      });
      const results = await Promise.all([
        owner.record(target.capture(), "start"),
        owner.record(good.capture(), "start"),
      ]);
      expect(results.map((result) => result.outcome)).toEqual([
        "failure",
        "success",
      ]);
      expect(target.commands).toEqual([]);
      expect(good.commands).toEqual(["Rec"]);
    },
  );
  it("holds one camera queue through confirmation and re-reads state for another entry point", async () => {
    const owner = coordinator();
    const target = camera(owner);
    const first = owner.record(target.capture(), "start");
    const second = owner.record(target.capture(), "toggle");
    await flush();
    expect(target.commands).toEqual(["Rec"]);
    target.status(true);
    expect((await first).evidence).toBe("confirmed");
    await flush();
    expect(target.commands).toEqual(["Rec", "Stop"]);
    target.status(false);
    expect((await second).evidence).toBe("confirmed");
  });
  it("re-checks a lock acquired while another operation was pending", async () => {
    const owner = coordinator();
    const target = camera(owner);
    const first = owner.record(target.capture(), "start");
    const second = owner.record(target.capture(), "toggle");
    await flush();
    target.change({ recordingLocked: true });
    target.status(true);
    await first;
    expect((await second).evidence).toBe("skipped");
    expect(target.commands).toEqual(["Rec"]);
  });
  it("bounds concurrent publications while allowing other cameras to send during confirmation waits", async () => {
    const owner = coordinator({ feedbackTimeoutMs: 1000 });
    const cameras = Array.from({ length: 6 }, (_, index) =>
      camera(owner, `camera-${String(index)}`),
    );
    const releases: (() => void)[] = [];
    for (const target of cameras)
      target.setSend(() => new Promise((resolve) => releases.push(resolve)));
    const results = cameras.map((target) =>
      owner.record(target.capture(), "start"),
    );
    await flush();
    expect(cameras.flatMap((target) => target.commands)).toHaveLength(4);
    requiredTestValue(releases[0])();
    await flush();
    expect(cameras.flatMap((target) => target.commands)).toHaveLength(5);
    requiredTestValue(releases[1])();
    await flush();
    expect(cameras.flatMap((target) => target.commands)).toHaveLength(6);
    for (const release of releases) release();
    for (const target of cameras) target.status(true);
    expect(
      (await Promise.all(results)).every(
        (result) => result.evidence === "confirmed",
      ),
    ).toBe(true);
  });
  it("does not treat broker delivery or retained state as camera confirmation, and blocks until later live feedback", async () => {
    const owner = coordinator({ feedbackTimeoutMs: 15 });
    const target = camera(owner);
    target.setSend(() => {
      target.status(true, true);
      return Promise.resolve();
    });
    expect((await owner.record(target.capture(), "start")).evidence).toBe(
      "unconfirmed",
    );
    expect((await owner.record(target.capture(), "toggle")).evidence).toBe(
      "error",
    );
    expect(target.commands).toEqual(["Rec"]);
    target.status(true);
    target.setSend(() => {
      target.status(false);
      return Promise.resolve();
    });
    expect((await owner.record(target.capture(), "stop")).evidence).toBe(
      "confirmed",
    );
    expect(target.commands).toEqual(["Rec", "Stop"]);
  });
  it("requires feedback newer than the timeout, even if conflicting live feedback arrived while waiting", async () => {
    const owner = coordinator({ feedbackTimeoutMs: 15 });
    const target = camera(owner);
    target.setSend(() => {
      target.status(false);
      return Promise.resolve();
    });
    expect((await owner.record(target.capture(), "start")).evidence).toBe(
      "unconfirmed",
    );
    expect((await owner.record(target.capture(), "start")).evidence).toBe(
      "error",
    );
    expect(target.commands).toEqual(["Rec"]);
  });
  it("distinguishes cancellation before dispatch from cancellation after a possible write", async () => {
    const owner = coordinator();
    const target = camera(owner);
    const before = new AbortController();
    before.abort();
    expect(
      (await owner.record(target.capture(), "start", before.signal)).evidence,
    ).toBe("error");
    expect(owner.isUncertain("camera-1")).toBe(false);
    const after = new AbortController();
    const pending = owner.record(target.capture(), "start", after.signal);
    await flush();
    after.abort();
    expect((await pending).evidence).toBe("unconfirmed");
    expect(owner.isUncertain("camera-1")).toBe(true);
    expect(target.commands).toEqual(["Rec"]);
  });
  it("keeps uncertainty across an opaque checkpoint and requires live status after unclean recovery", async () => {
    const recovered = coordinator({
      recovery: "clean",
      checkpoint: { uncertain: ["camera-1"] },
    });
    const target = camera(recovered, "camera-1", { recording: true });
    expect((await recovered.record(target.capture(), "start")).evidence).toBe(
      "error",
    );
    target.status(true);
    expect((await recovered.record(target.capture(), "start")).evidence).toBe(
      "noop",
    );
    const crashed = coordinator({ recovery: "unclean" });
    const fresh = camera(crashed);
    expect((await crashed.record(fresh.capture(), "stop")).evidence).toBe(
      "error",
    );
    fresh.status(false);
    expect((await crashed.record(fresh.capture(), "stop")).evidence).toBe(
      "noop",
    );
  });
  it("rejects captured identities after reconnect without replay and accepts a new live target", async () => {
    const owner = coordinator();
    const target = camera(owner);
    const captured = target.capture();
    target.reconnect();
    expect((await owner.record(captured, "start")).evidence).toBe("error");
    target.setSend(() => {
      target.status(true);
      return Promise.resolve();
    });
    expect((await owner.record(target.capture(), "start")).evidence).toBe(
      "confirmed",
    );
    expect(target.commands).toEqual(["Rec"]);
  });
});

function requiredTestValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing test fixture value");
  return value;
}
