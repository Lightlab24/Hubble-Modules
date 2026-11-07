import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createModuleDocumentClient,
  type ModuleContext,
  type ModuleExchange,
  type ModuleInstance,
  type ModuleJsonValue,
} from "@hubble/module-sdk";
import { CccController } from "../src/ccc-controller.js";
import { createCccModule } from "../src/module.js";
import { documentServices } from "./document-services.js";

// Backoff waits are recorded and skipped, or held open to catch a loop that can't be stopped.
const timers = vi.hoisted(() => ({ delays: [] as number[], hold: false }));
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: (
    ms: number,
    _value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise<void>((resolve, reject) => {
      timers.delays.push(ms);
      if (timers.hold)
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      else setImmediate(resolve);
    }),
}));

const REFUSED = "Host service is not granted or available for this scope";
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  timers.delays.length = 0;
  timers.hold = false;
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

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

type Refuse = (method: string) => boolean | Promise<boolean>;
async function harness(refuse: Refuse = () => false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ccc-watch-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  const requests: string[] = [];
  const shouldRefuse = { current: refuse };
  const broken = { current: false };
  const services = documentServices(
    workspaceId,
    {
      revision: 0,
      // No address, so no RCP session and no network in these tests.
      rows: [
        { rowId: randomUUID(), enabled: false, rcpIp: "", cameraNumber: null },
      ],
    },
    () => {},
    undefined,
    async (method) => {
      requests.push(method);
      if (await shouldRefuse.current(method)) throw new Error(REFUSED);
    },
  );
  const served = {
    ...services,
    request: async (...args: Parameters<typeof services.request>) => {
      const result: any = await services.request(...args);
      return broken.current && result?.status === "document"
        ? {
            ...result,
            document: { ...result.document, value: { cameras: "unreadable" } },
          }
        : result;
    },
  } as typeof services;
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
    services: served,
  };
  let controller!: CccController;
  const instance: ModuleInstance = createCccModule((store) => {
    controller = new CccController(store);
    return controller;
  }).createInstance(context);
  let disposed = false;
  const dispose = async () => {
    if (!disposed) await instance.dispose();
    disposed = true;
  };
  cleanups.push(dispose);
  await instance.start();
  // The edits come from outside CCC, so they use the real store, not what CCC is served.
  const client = createModuleDocumentClient(services);
  const states = () =>
    vi.mocked(context.publishState).mock.calls.map(([state]) => state);
  return {
    context,
    instance,
    controller: () => controller,
    requests,
    shouldRefuse,
    broken,
    states,
    lastState: () => states().at(-1),
    dispose,
    /** A second camera from outside CCC, the way a workbook edit arrives. */
    async addCamera() {
      const document = await client.read("cameras");
      const value = document.value as { cameras: ModuleJsonValue[] };
      await client.write(document, {
        ...value,
        cameras: [
          ...value.cameras,
          {
            id: randomUUID(),
            values: { enabled: true, rcpIp: "", cameraNumber: null },
          },
        ],
      } as ModuleJsonValue);
    },
    cameraCount: () => controller.state().config.rows.length,
    logged: () => vi.mocked(context.log).mock.calls.map(([trace]) => trace),
  };
}
/** The long poll is back up when it's the newest request and nothing else follows. */
async function settled(requests: string[]) {
  await expect
    .poll(async () => {
      await nextTurn();
      return requests.at(-1);
    })
    .toBe("watch");
  await nextTurn();
}

it("survives one refused watch with no error, and still adopts later edits", async () => {
  let refused = false;
  const h = await harness((method) => {
    if (method !== "watch" || refused) return false;
    refused = true;
    return true;
  });
  await expect.poll(() => timers.delays).toEqual([250]);
  await settled(h.requests);

  await h.addCamera();
  await expect.poll(h.cameraCount).toBe(2);
  await expect
    .poll(() => {
      const values = h.lastState()?.values as {
        cameraSelection: { rows: unknown[] };
      };
      return values.cameraSelection.rows.length;
    })
    .toBe(2);
  expect(h.states().every((state) => state.phase === "ready")).toBe(true);
  expect(h.logged()).toContainEqual({
    level: "info",
    stage: "document-watch",
    message: REFUSED,
  });
});

it("shows a lasting failure, keeps showing it, and clears it on recovery", async () => {
  const h = await harness();
  await settled(h.requests);
  await h.addCamera();
  h.shouldRefuse.current = () => true;

  await expect.poll(() => h.lastState()?.phase).toBe("error");
  expect(h.lastState()).toMatchObject({
    phase: "error",
    message: REFUSED,
    values: { cameraSelection: { rows: expect.any(Array) } },
  });
  expect(h.logged()).toContainEqual({
    level: "error",
    stage: "document-watch",
    message: REFUSED,
  });

  // A status change from elsewhere must not paint over a watch that is still failing.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.shouldRefuse.current = async () => {
    await held;
    return true;
  };
  const selecting = h.instance.execute("single-switch", {}, {
    executionId: randomUUID(),
    signal: new AbortController().signal,
    gesture: "press",
    wrap: true,
    log: vi.fn(),
  });
  await expect
    .poll(() => (h.lastState()?.values as { singleSwitch: string }).singleSwitch)
    .toBe("On");
  expect(h.lastState()).toMatchObject({ phase: "error", message: REFUSED });
  release();
  await selecting;
  await nextTurn();
  expect(h.lastState()).toMatchObject({ phase: "error", message: REFUSED });

  h.shouldRefuse.current = () => false;
  await expect.poll(() => h.lastState()?.phase).toBe("ready");
  expect(h.lastState()?.message).not.toBe(REFUSED);
  await settled(h.requests);
  await h.addCamera();
  await expect.poll(h.cameraCount).toBe(3);
});

it("doesn't count a readable document as recovered until it has been adopted", async () => {
  const h = await harness();
  await settled(h.requests);
  await h.addCamera();
  await expect.poll(h.cameraCount).toBe(2);
  await settled(h.requests);

  // The watch's own read succeeds, then adopting the document fails, every time round.
  let reads = 0;
  h.shouldRefuse.current = (method) =>
    method === "read" && (reads += 1) % 2 === 0;
  await h.addCamera();
  await expect.poll(() => h.lastState()?.phase).toBe("error");

  h.shouldRefuse.current = () => false;
  await expect.poll(() => h.lastState()?.phase).toBe("ready");
});

it("backs off to no longer than 5 seconds and never gives up", async () => {
  const h = await harness();
  await settled(h.requests);
  await h.addCamera();
  h.shouldRefuse.current = () => true;
  const count = 30;
  await expect
    .poll(() => timers.delays.length, { timeout: 5000 })
    .toBeGreaterThanOrEqual(count);
  expect(timers.delays.slice(0, 8)).toEqual([
    250, 500, 1000, 2000, 4000, 5000, 5000, 5000,
  ]);
  expect(Math.max(...timers.delays)).toBe(5000);
  h.shouldRefuse.current = () => false;
  await expect.poll(() => h.lastState()?.phase).toBe("ready");
});

it("stops promptly during a wait and sends nothing afterwards", async () => {
  const h = await harness();
  await settled(h.requests);
  timers.hold = true;
  await h.addCamera();
  h.shouldRefuse.current = () => true;
  await expect.poll(() => timers.delays.length).toBeGreaterThan(0);

  await h.dispose();
  const after = h.requests.length;
  await nextTurn();
  await nextTurn();
  expect(h.requests).toHaveLength(after);
});

it("still reports a document too broken to summarize, then recovers", async () => {
  const h = await harness();
  await settled(h.requests);
  h.broken.current = true;
  await h.addCamera();
  await expect.poll(() => h.lastState()?.phase).toBe("error");
  expect(h.lastState()).toMatchObject({ phase: "error", values: {} });

  h.broken.current = false;
  await expect.poll(() => h.lastState()?.phase).toBe("ready");
  await expect.poll(h.cameraCount).toBe(2);
});
