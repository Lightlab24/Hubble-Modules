import { expect, it, vi } from "vitest";
import { createRoutingStatePublisher } from "../src/routing-state-publisher.js";

const state = {
  phase: "ready",
  message: null,
  observedAt: "2026-11-06T12:00:00.000Z",
  values: { model: "Videohub" },
} as never;

it("adds the routing revision to state and republishes when it changes", () => {
  const publish = vi.fn();
  const publisher = createRoutingStatePublisher(publish);

  // Nothing is published until the worker has a state of its own.
  publisher.setRevision("a");
  expect(publish).not.toHaveBeenCalled();

  publisher.publish(state);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "ready",
      values: { model: "Videohub", routingGroupsRevision: "a" },
    }),
  );

  publisher.setRevision("a");
  expect(publish).toHaveBeenCalledTimes(1);

  publisher.setRevision("b");
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      values: { model: "Videohub", routingGroupsRevision: "b" },
    }),
  );
});
