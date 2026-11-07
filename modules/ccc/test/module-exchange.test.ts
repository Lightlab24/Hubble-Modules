import { documentServices } from "./document-services.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleExchange,
  ModuleInstance,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import { createCccModule } from "../src/module.js";
import { CccController } from "../src/ccc-controller.js";
import { type CccConfig } from "../src/config.js";
import { recordingCheckpoint } from "../src/recording-checkpoint.js";
import { broker, closeBrokers } from "./loopback-broker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await closeBrokers();
});

it("keeps the record-rcp action on the one CCC queue for older CyanView packages, and preserves uncertainty", async () => {
  const network = await broker();
  const directory = await mkdtemp(path.join(tmpdir(), "ccc-exchange-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceId = randomUUID(),
    connectionId = randomUUID();
  const definition = {
    type: "cyanview-rcp",
    connectionId,
    name: "Simulator",
    host: "127.0.0.1",
    port: network.port,
    enabled: true,
    schemaVersion: 1,
    requestTimeoutMs: 200,
  };
  let config: CccConfig = {
    revision: 0,
    rows: [
      {
        rowId: randomUUID(),
        enabled: true,
        rcpIp: "127.0.0.1",
        cameraNumber: 101,
      },
    ],
  };
  const execution = () => ({
    executionId: randomUUID(),
    signal: new AbortController().signal,
    gesture: "press" as const,
    wrap: true,
    log: vi.fn(),
  });
  const rcpPeer = {
    kind: "connection" as const,
    connectionId,
    moduleId: "hubble-cyanview-rcp",
  };
  const modules: ModuleExchange = {
    discover: async () => [
      {
        peer: rcpPeer,
        name: "Simulator",
        available: true,
        actionsAllowed: false,
        data: [],
        actions: [],
      } satisfies ModulePeerDescription,
    ],
    bindings: async () => [],
    query: async () => definition,
    publish: async () => {},
    reportAction: async () => {},
    subscribe: async (subscription, listener) => {
      if (subscription.kind === "data")
        await listener({
          kind: "data",
          provider: rcpPeer,
          generation: randomUUID(),
          observedAt: new Date().toISOString(),
          id: "connection",
          version: 1,
          value: definition,
        });
      return async () => {};
    },
    execute: async () => {
      throw new Error("CCC must not execute another module");
    },
  };
  let controller!: CccController;
  const module = createCccModule((store) => {
    controller = new CccController(store, 60);
    return controller;
  });
  const context: ModuleContext = {
    modules,
    settings: {},
    log: vi.fn(),
    publishState: vi.fn(),
    publishFeedback: vi.fn(),
    publishEvent: vi.fn(),
    instanceId: "ccc",
    scope: { kind: "host", workspaceId, capabilityId: "ccc" },
    runtimeDirectory: directory,
    services: documentServices(workspaceId, config, (next) => {
      config = next;
    }),
  };
  const ccc: ModuleInstance = module.createInstance(context);
  cleanups.push(async () => ccc.dispose());
  await ccc.start();
  await expect
    .poll(() =>
      controller.state().rows.every((row) => row.connection === "online"),
    )
    .toBe(true);
  const record = () =>
    ccc.execute(
      "record-rcp",
      { connectionId, command: "record-camera", cameraNumber: 101 },
      execution(),
    );
  expect(await ccc.execute("single-switch", {}, execution())).toMatchObject({
    status: "success",
    evidence: { kind: "local" },
  });
  expect(config.singleSwitch).toBe(true);
  const start = ccc.execute("roll-enabled-cameras", {}, execution());
  const toggle = record();
  expect(await start).toMatchObject({
    status: "success",
    evidence: { kind: "state-confirmed" },
  });
  expect(await toggle).toMatchObject({
    status: "success",
    evidence: { kind: "state-confirmed" },
  });
  expect(network.commands).toHaveLength(2);
  network.controls.feedback = false;
  expect(await record()).toMatchObject({
    status: "failure",
    category: "timeout",
  });
  await ccc.dispose();
  expect(recordingCheckpoint(directory)).toMatchObject({
    recovery: "clean",
    checkpoint: { uncertain: [expect.any(String)] },
  });
});

it("marks interrupted workers unclean and isolates their local checkpoint from workspace files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ccc-checkpoint-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const first = recordingCheckpoint(directory);
  expect(first.recovery).toBe("initial");
  first.write({ uncertain: ["camera-a"] });
  expect(recordingCheckpoint(directory)).toMatchObject({
    recovery: "unclean",
    checkpoint: { uncertain: ["camera-a"] },
  });
  first.write({ uncertain: ["camera-a"] }, true);
  expect(recordingCheckpoint(directory).recovery).toBe("clean");
});
