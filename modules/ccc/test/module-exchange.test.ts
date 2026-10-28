import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleExchange,
  ModuleInstance,
  ModuleJsonValue,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import { createCccModule } from "../src/module.js";
import rcpModule from "../../cyanview-rcp/src/module.js";
import { CccController } from "../src/ccc-controller.js";
import { RcpSession } from "../src/rcp-session.js";
import {
  CccConfigSchema,
  CccMutationRequestSchema,
  type CccConfig,
} from "../src/config.js";
import { recordingCheckpoint } from "../src/recording-checkpoint.js";
import { broker, closeBrokers } from "./loopback-broker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await closeBrokers();
});

it("routes approved CyanView and CCC controls through one recording queue and preserves uncertainty", async () => {
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
  let allowed = false;
  let ccc: ModuleInstance;
  const execution = () => ({
    executionId: randomUUID(),
    signal: new AbortController().signal,
    gesture: "press" as const,
    wrap: true,
    log: vi.fn(),
  });
  const cccPeer = {
    kind: "host" as const,
    capabilityId: "ccc",
    moduleId: "hubble-ccc",
  };
  const rcpPeer = {
    kind: "connection" as const,
    connectionId,
    moduleId: "hubble-cyanview-rcp",
  };
  const describe = (
    peer: ModulePeerDescription["peer"],
  ): ModulePeerDescription => ({
    peer,
    name: "Simulator",
    available: true,
    actionsAllowed: allowed,
    data: [],
    actions: [],
  });
  const modules: ModuleExchange = {
    discover: async () => [describe(cccPeer), describe(rcpPeer)],
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
    execute: async (_target, id, fields) =>
      ccc.execute(id, fields, execution()),
  };
  const base = {
    modules,
    settings: {},
    log: vi.fn(),
    publishState: vi.fn(),
    publishFeedback: vi.fn(),
    publishEvent: vi.fn(),
  };
  const context: ModuleContext = {
    ...base,
    instanceId: "ccc",
    scope: { kind: "host", workspaceId, capabilityId: "ccc" },
    runtimeDirectory: directory,
    requestHost: async (_method, value) => {
      const input = value as { method: string; request?: ModuleJsonValue };
      if (input.method === "mutate") {
        const mutation = CccMutationRequestSchema.parse(input.request).mutation;
        if (mutation.kind !== "replace")
          throw new Error(
            "Selection decisions must already be resolved by CCC",
          );
        expect(mutation.expectedRevision).toBe(config.revision);
        config = CccConfigSchema.parse({
          revision: config.revision + 1,
          rows: mutation.rows,
          singleSwitch: mutation.singleSwitch,
        });
      }
      return JSON.parse(JSON.stringify(config)) as ModuleJsonValue;
    },
  };
  const module = createCccModule(
    (store) =>
      new CccController(
        store,
        60,
        (definition, changed) =>
          new RcpSession({ ...definition, port: network.port }, changed),
      ),
  );
  ccc = module.createInstance(context);
  cleanups.push(async () => ccc.dispose());
  const rcp = rcpModule.createInstance({
    ...base,
    instanceId: "rcp",
    scope: { kind: "connection", workspaceId, connectionId },
    settings: definition,
  });
  cleanups.push(async () => rcp.dispose());
  await rcp.start();
  await ccc.start();
  await expect
    .poll(() =>
      base.publishState.mock.calls.some(([state]) => state.phase === "ready"),
    )
    .toBe(true);
  const denied = await rcp.execute(
    "cyanview-rcp.record-camera",
    { cameraNumber: 101 },
    execution(),
  );
  expect(denied).toMatchObject({
    status: "failure",
    message: expect.stringContaining("Approve"),
  });
  expect(network.commands).toHaveLength(0);
  expect(await ccc.execute("single-switch", {}, execution())).toMatchObject({
    status: "success",
    evidence: { kind: "local" },
  });
  expect(config.singleSwitch).toBe(true);
  allowed = true;
  const start = ccc.execute("roll-enabled-cameras", {}, execution());
  const toggle = rcp.execute(
    "cyanview-rcp.record-camera",
    { cameraNumber: 101 },
    execution(),
  );
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
  expect(
    await rcp.execute(
      "cyanview-rcp.record-camera",
      { cameraNumber: 101 },
      execution(),
    ),
  ).toMatchObject({ status: "failure", category: "timeout" });
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
