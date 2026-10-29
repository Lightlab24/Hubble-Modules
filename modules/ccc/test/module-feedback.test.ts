import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleExchange,
  ModuleJsonValue,
} from "@hubble/module-sdk";
import manifest from "../src/manifest.js";
import { createCccModule } from "../src/module.js";
import { CccController } from "../src/ccc-controller.js";
import { RcpSession } from "../src/rcp-session.js";
import {
  applyCccMutation,
  CccMutationRequestSchema,
  type CccConfig,
} from "../src/config.js";
import { broker, closeBrokers } from "./loopback-broker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await closeBrokers();
  vi.useRealTimers();
});

async function harness() {
  const network = await broker();
  const directory = await mkdtemp(path.join(tmpdir(), "ccc-feedback-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  let config: CccConfig = {
    revision: 0,
    rows: [101, 102].map((cameraNumber) => ({
      rowId: randomUUID(),
      enabled: cameraNumber === 101,
      rcpIp: "127.0.0.1",
      cameraNumber,
    })),
  };
  const modules: ModuleExchange = {
    discover: async () => [],
    bindings: async () => [],
    query: async () => null,
    publish: async () => {},
    reportAction: async () => {},
    subscribe: async () => async () => {},
    execute: async () => {
      throw new Error("Unexpected peer action");
    },
  };
  const context: ModuleContext = {
    instanceId: "ccc",
    scope: { kind: "host", workspaceId, capabilityId: "ccc" },
    runtimeDirectory: directory,
    settings: {},
    modules,
    log: vi.fn(),
    publishState: vi.fn(),
    publishFeedback: vi.fn(),
    publishEvent: vi.fn(),
    requestHost: async (_method, value) => {
      const request = value as { method: string; request?: ModuleJsonValue };
      if (request.method === "mutate")
        config = applyCccMutation(
          config,
          CccMutationRequestSchema.parse(request.request).mutation,
        );
      return JSON.parse(JSON.stringify(config)) as ModuleJsonValue;
    },
  };
  let controller!: CccController;
  const instance = createCccModule((store) => {
    controller = new CccController(
      store,
      60,
      (definition, changed) =>
        new RcpSession({ ...definition, port: network.port }, changed),
    );
    return controller;
  }).createInstance(context);
  cleanups.push(async () => instance.dispose());
  await instance.start();
  await expect
    .poll(() =>
      controller.state().rows.every((row) => row.connection === "online"),
    )
    .toBe(true);
  const execution = () => ({
    executionId: randomUUID(),
    signal: new AbortController().signal,
    gesture: "press" as const,
    wrap: true,
    log: vi.fn(),
  });
  const observations = () =>
    vi.mocked(context.publishFeedback).mock.calls.map(([value]) => value);
  const cameraState = (cameraId: string) =>
    observations()
      .filter(
        (value) =>
          value.id === "toggle-camera-enabled" &&
          value.fields?.cameraId === cameraId,
      )
      .at(-1);
  return {
    instance,
    controller,
    network,
    workspaceId,
    context,
    execution,
    observations,
    cameraState,
  };
}

it("keeps public camera actions compatible and offers matching camera selection feedback", () => {
  const labels = Object.fromEntries(
    manifest.actions.map(({ id, label }) => [id, label]),
  );
  expect(labels).toMatchObject({
    "toggle-camera-enabled": "Enable / Disable Camera",
    "enable-all-cameras": "Enable / Disable All Cameras",
    "roll-enabled-cameras": "Start Recording",
    "stop-enabled-cameras": "Stop Recording",
    "roll-toggle-enabled-cameras": "Toggle Recording",
  });
  const action = manifest.actions.find(
    ({ id }) => id === "toggle-camera-enabled",
  );
  const feedback = manifest.feedback.find(
    ({ id }) => id === "toggle-camera-enabled",
  );
  expect(feedback?.fields).toEqual(action?.fields);
  expect(feedback?.fields).toEqual([
    expect.objectContaining({
      id: "cameraId",
      required: true,
      choiceProvider: "cameras",
    }),
  ]);
  expect(
    manifest.actions.some(
      (action) =>
        action.id === "ccc.command" && "legacy" in action && action.legacy,
    ),
  ).toBe(true);
});

it("suppresses unchanged snapshots and status across separate controller notifications", async () => {
  const h = await harness();
  await nextTurn();
  const events = vi.mocked(h.context.publishEvent!);
  const status = vi.mocked(h.context.publishState);
  const feedback = vi.mocked(h.context.publishFeedback);
  const lastObservedAt = status.mock.lastCall?.[0].observedAt;
  expect(lastObservedAt).toBeTypeOf("string");
  const initial = [
    events.mock.calls.length,
    status.mock.calls.length,
    feedback.mock.calls.length,
  ];
  for (let index = 0; index < 20; index += 1) {
    h.controller.configureConsumers([], true);
    await nextTurn();
  }
  expect([
    events.mock.calls.length,
    status.mock.calls.length,
    feedback.mock.calls.length,
  ]).toEqual(initial);
  expect(status.mock.lastCall?.[0].observedAt).toBe(lastObservedAt);
});

it("publishes changed selection and recording rows without refreshing unchanged status timestamps", async () => {
  const h = await harness();
  await nextTurn();
  const events = vi.mocked(h.context.publishEvent!);
  const status = vi.mocked(h.context.publishState);
  events.mockClear();
  status.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T20:00:00.000Z"));
  const second = h.controller.state().config.rows[1]!;
  await h.controller.mutate({
    workspaceId: h.workspaceId,
    mutation: { kind: "enabled", rowId: second.rowId, enabled: true },
  });
  await nextTurn();
  expect(events).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
  expect(status.mock.lastCall?.[0]).toMatchObject({
    observedAt: "2026-10-28T20:00:00.000Z",
    values: { enabledCameraCount: 2, unavailableCameraCount: 0 },
  });

  vi.setSystemTime(new Date("2026-10-28T20:00:01.000Z"));
  h.network.send("unit/a/camhead/status/volatile/recording", "1");
  await expect
    .poll(() => h.controller.state().rows[0]?.recording)
    .toBe("recording");
  await nextTurn();
  expect(events).toHaveBeenCalledTimes(2);
  expect(events.mock.lastCall?.[0]).toBe("host.ccc");
  const chunk = events.mock.lastCall?.[1] as { text: string };
  expect(JSON.parse(chunk.text)).toMatchObject({
    rows: [
      expect.objectContaining({ recording: "recording" }),
      expect.anything(),
    ],
  });
  expect(status).toHaveBeenCalledTimes(1);
  expect(status.mock.lastCall?.[0].observedAt).toBe("2026-10-28T20:00:00.000Z");

  vi.setSystemTime(new Date("2026-10-28T20:00:02.000Z"));
  h.network.send("unit/a/camhead/status/volatile/control", "offline");
  await expect
    .poll(() => h.controller.state().rows[0]?.connection)
    .toBe("offline");
  await nextTurn();
  expect(events).toHaveBeenCalledTimes(3);
  expect(status).toHaveBeenCalledTimes(2);
  expect(status.mock.lastCall?.[0]).toMatchObject({
    observedAt: "2026-10-28T20:00:02.000Z",
    values: { enabledCameraCount: 2, unavailableCameraCount: 1 },
  });
  expect(h.network.commands).toHaveLength(0);
});

it("keeps selection and public feedback usable when enabled cameras and their RCP are offline", async () => {
  const h = await harness();
  const [first, second] = h.controller.state().config.rows;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  h.network.send("unit/a/camhead/status/volatile/control", "offline");
  await expect
    .poll(() => h.controller.state().rows[0]?.connection)
    .toBe("offline");
  await expect
    .poll(() => vi.mocked(h.context.publishState).mock.lastCall?.[0])
    .toMatchObject({
      phase: "ready",
      message: "Camera offline",
      values: { enabledCameraCount: 1, unavailableCameraCount: 1 },
    });
  expect(h.cameraState(first!.rowId)?.state).toBe("active");
  expect(h.cameraState(second!.rowId)?.state).toBe("inactive");
  await expect
    .poll(
      () =>
        h
          .observations()
          .filter(({ id }) => id === "roll-enabled-cameras")
          .at(-1)?.state,
    )
    .toBe("unavailable");

  h.network.send("unit/RCP/rcp_helper/status/volatile/control", "offline");
  await expect
    .poll(() =>
      h.controller
        .state()
        .rows.every(({ connection }) => connection === "offline"),
    )
    .toBe(true);
  expect(
    await h.instance.execute(
      "toggle-camera-enabled",
      { cameraId: first!.rowId },
      h.execution(),
    ),
  ).toMatchObject({
    status: "success",
    evidence: { kind: "local" },
  });
  await expect.poll(() => h.cameraState(first!.rowId)?.state).toBe("inactive");
  expect(
    await h.instance.execute("enable-all-cameras", {}, h.execution()),
  ).toMatchObject({ status: "success" });
  await expect
    .poll(() => [
      h.cameraState(first!.rowId)?.state,
      h.cameraState(second!.rowId)?.state,
    ])
    .toEqual(["active", "active"]);
  await expect
    .poll(() => vi.mocked(h.context.publishState).mock.lastCall?.[0])
    .toMatchObject({
      phase: "ready",
      values: { enabledCameraCount: 2, unavailableCameraCount: 2 },
    });
  expect(h.network.commands).toHaveLength(0);
});

it("publishes external selection changes and invalidates removed cameras by stable row identity", async () => {
  const h = await harness();
  const [first, second] = h.controller.state().config.rows;
  await expect.poll(() => h.cameraState(first!.rowId)?.state).toBe("active");
  await h.controller.mutate({
    workspaceId: h.workspaceId,
    mutation: { kind: "enabled", rowId: first!.rowId, enabled: false },
  });
  await expect.poll(() => h.cameraState(first!.rowId)?.state).toBe("inactive");
  const config = h.controller.state().config;
  await h.controller.mutate({
    workspaceId: h.workspaceId,
    mutation: {
      kind: "replace",
      expectedRevision: config.revision,
      rows: [{ ...second!, cameraNumber: 101, enabled: true }],
    },
  });
  await expect
    .poll(() => h.cameraState(first!.rowId))
    .toMatchObject({ state: "unavailable", observedAt: null });
  await expect.poll(() => h.cameraState(second!.rowId)?.state).toBe("active");
  expect(await h.instance.choices?.("cameras")).toEqual([
    { id: second!.rowId, label: "101 — 127.0.0.1" },
  ]);
  const removedCount = h
    .observations()
    .filter(
      ({ id, fields, state }) =>
        id === "toggle-camera-enabled" &&
        fields?.cameraId === first!.rowId &&
        state === "unavailable",
    ).length;
  await h.controller.mutate({
    workspaceId: h.workspaceId,
    mutation: { kind: "enabled", rowId: second!.rowId, enabled: false },
  });
  await expect.poll(() => h.cameraState(second!.rowId)?.state).toBe("inactive");
  expect(
    h
      .observations()
      .filter(
        ({ id, fields, state }) =>
          id === "toggle-camera-enabled" &&
          fields?.cameraId === first!.rowId &&
          state === "unavailable",
      ),
  ).toHaveLength(removedCount);
  expect(h.network.commands).toHaveLength(0);
});
