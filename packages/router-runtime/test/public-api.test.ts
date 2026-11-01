import { expect, it, vi } from "vitest";
import { routePublic } from "../src/public-api.js";
import type { RouterConnectionManagerContract } from "../src/connection-contract.js";

it("validates permission-independent router readiness, range and cancellation before dispatch and waits for settlement", async () => {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const submit = vi.fn(() => ({
    submissionId: "route",
    accepted: Promise.resolve(),
    settled,
  }));
  let ready = false;
  const manager = {
    snapshots: () => [
      {
        definition: {
          connectionId: "router",
          levels: 2,
          sourceLimit: 10,
          destinationLimit: 4,
        },
        routeTransport: "connected",
      },
    ],
    routeState: () => ({ phase: ready ? "ready" : "pending" }),
    submitDirectRouteTracked: submit,
  } as unknown as RouterConnectionManagerContract;
  const controller = new AbortController();
  const execution = {
    executionId: "test",
    signal: controller.signal,
    gesture: "press" as const,
    wrap: false,
    log: vi.fn(),
  };
  const fields = { source: 2, destination: 1, level: 1 };
  expect(await routePublic(manager, "router", fields, execution)).toMatchObject(
    { status: "failure", category: "unavailable" },
  );
  ready = true;
  expect(
    await routePublic(manager, "router", { ...fields, source: 11 }, execution),
  ).toMatchObject({ status: "failure", category: "invalid-config" });
  expect(submit).not.toHaveBeenCalled();
  let completed = false;
  const result = routePublic(manager, "router", fields, execution).then(
    (value) => {
      completed = true;
      return value;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(submit).toHaveBeenCalledTimes(1);
  finish();
  expect(await result).toMatchObject({
    status: "success",
    evidence: { kind: "submitted" },
  });
  controller.abort();
  expect(await routePublic(manager, "router", fields, execution)).toMatchObject(
    { status: "failure", category: "cancelled" },
  );
  expect(submit).toHaveBeenCalledTimes(1);
});
