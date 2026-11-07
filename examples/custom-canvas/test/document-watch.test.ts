import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  createModuleHostServices,
  ModuleDocumentRequestSchema,
  ModuleDocumentSnapshotSchema,
  type ModuleJsonValue,
  type ModuleState,
} from "@hubble/module-sdk";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
import manifest from "../src/manifest.js";

const REFUSED = "Host service is not granted or available for this scope";

// The retry waits run on a mocked clock, so these tests take no real time.
// Syncing is what lets the mock reach `delay`, a named import of a built-in.
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  syncBuiltinESMExports();
});
afterEach(() => {
  mock.timers.reset();
  syncBuiltinESMExports();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await settle();
};

async function harness() {
  const scope = {
    kind: "host" as const,
    workspaceId: randomUUID(),
    capabilityId: "example-custom-canvas",
  };
  let document = ModuleDocumentSnapshotSchema.parse({
    workspaceId: scope.workspaceId,
    owner: {
      kind: "host",
      capabilityId: scope.capabilityId,
      moduleId: "example-custom-canvas",
    },
    id: "design",
    version: 1,
    revision: null,
    value: manifest.documents![0]!.defaultValue,
    canUndo: false,
    canRedo: false,
  });
  const requests: { method: string; at: number }[] = [];
  const longPolls = new Set<() => void>();
  let refuse = (_method: string) => false;
  const services = createModuleHostServices(
    async (_method, raw, signal): Promise<ModuleJsonValue> => {
      const { service, input: request } = raw as {
        service: string;
        input: unknown;
      };
      if (service === "helpers")
        return {
          status: "helper",
          helperId: "renderer",
          state: "ready",
          message: null,
          pid: 123,
        };
      const input = ModuleDocumentRequestSchema.parse(request);
      requests.push({ method: input.method, at: Date.now() });
      if (refuse(input.method)) throw new Error(REFUSED);
      if (input.method === "watch" && input.afterRevision === document.revision)
        await new Promise<void>((resolve, reject) => {
          longPolls.add(resolve);
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Cancelled")),
            { once: true },
          );
        });
      return { status: "document", document };
    },
  );
  const h = createModuleHarness(module, {}, { services, scope });
  await h.instance.start();
  await settle();
  const lastState = () => h.states.at(-1) as ModuleState;
  return {
    ...h,
    requests,
    lastState,
    refuse(rule: (method: string) => boolean) {
      refuse = rule;
    },
    /** Refuses the next request to `method`, as some hosts do after a version switch. */
    refuseNext(method: string) {
      refuse = (requested) => {
        if (requested !== method) return false;
        refuse = () => false;
        return true;
      };
    },
    /** An edit from outside the module. It wakes the long poll. */
    edit(rowCount: number) {
      const value = {
        ...(document.value as Record<string, unknown>),
        labels: Array.from({ length: rowCount }, (_, id) => ({ id })),
      };
      document = ModuleDocumentSnapshotSchema.parse({
        ...document,
        revision: randomUUID(),
        value,
      });
      for (const wake of longPolls) wake();
      longPolls.clear();
    },
    rowCount: () => lastState().values.rowCount,
  };
}

test("one refused watch is only logged, and later edits still arrive", async () => {
  const h = await harness();
  // The save that opens the refusal window is also what wakes the long poll.
  h.refuseNext("watch");
  h.edit(1);
  await settle();
  assert.equal(h.rowCount(), 1);
  assert.deepEqual(h.traces.at(-1), {
    level: "info",
    stage: "document-watch",
    message: `Error: ${REFUSED}`,
  });

  const sent = h.requests.length;
  await advance(249);
  assert.equal(h.requests.length, sent);
  await advance(1);
  assert.deepEqual(
    h.requests.slice(sent).map(({ method }) => method),
    ["read", "watch"],
  );

  h.edit(2);
  await settle();
  assert.equal(h.rowCount(), 2);
  assert.ok(
    h.states.every((state) => (state as ModuleState).phase === "ready"),
  );

  // Cancelling the long poll at disposal isn't a failure.
  const logged = h.traces.length;
  await h.instance.dispose();
  assert.equal(h.traces.length, logged);
});

test("a lasting failure stays shown with the last values, then clears on recovery", async () => {
  const h = await harness();
  h.refuse(() => true);
  h.edit(1);
  await settle();
  assert.equal(h.lastState().phase, "ready");

  await advance(250);
  assert.equal(h.lastState().phase, "error");
  assert.equal(h.lastState().message, `Error: ${REFUSED}`);
  assert.equal(h.rowCount(), 1);
  assert.deepEqual(h.traces.at(-1), {
    level: "error",
    stage: "document-watch",
    message: `Error: ${REFUSED}`,
  });

  // Another status change must not paint over a watch that is still failing.
  await h.instance.subscribeFeedback!([], h.execution());
  assert.equal(h.lastState().phase, "error");

  h.refuse(() => false);
  await advance(500);
  assert.equal(h.lastState().phase, "ready");
  assert.equal(h.lastState().message, null);

  h.edit(2);
  await settle();
  assert.equal(h.rowCount(), 2);
  assert.equal(h.lastState().phase, "ready");
  await h.instance.dispose();
});

test("a failure after the watch has stayed open starts a new count", async () => {
  const h = await harness();
  h.refuse(() => true);
  h.edit(1);
  await settle();
  await advance(250);
  assert.equal(h.lastState().phase, "error");
  h.refuse(() => false);
  await advance(500);

  await advance(5001);
  h.refuseNext("watch");
  h.edit(2);
  await settle();
  assert.equal(h.lastState().phase, "ready");
  const sent = h.requests.length;
  await advance(250);
  assert.ok(h.requests.length > sent);
  assert.equal(h.lastState().phase, "ready");
  await h.instance.dispose();
});

test("retries back off to 5 seconds when only the long poll fails, and dispose stops them", async () => {
  const h = await harness();
  // Each read succeeds, as it does when the host is at its subscription limit,
  // so a delivered document can't be what proves the watch works again.
  h.refuse((method) => method === "watch");
  h.edit(1);
  await settle();
  const reads = () =>
    h.requests.filter(({ method }) => method === "read").map(({ at }) => at);
  const before = reads().length - 1;
  for (let elapsed = 0; elapsed < 17_750; elapsed += 250) await advance(250);
  const waits = reads()
    .slice(before)
    .map((at, index, all) => at - (all[index - 1] ?? at))
    .slice(1);
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 5000, 5000]);
  assert.equal(h.lastState().phase, "error");

  // Dispose resolves in the middle of a wait, and nothing is sent afterwards.
  await advance(250);
  let stopped = false;
  void Promise.resolve(h.instance.dispose()).then(() => {
    stopped = true;
  });
  await settle();
  assert.ok(stopped);
  const sent = h.requests.length;
  await advance(60_000);
  assert.equal(h.requests.length, sent);
});
