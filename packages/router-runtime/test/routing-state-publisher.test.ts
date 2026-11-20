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

it("marks a simulated router's state and gives a ready one a message", () => {
  const publish = vi.fn();
  const simulated = createRoutingStatePublisher(publish, { simulated: true });
  simulated.publish(state);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "ready",
      message: "Simulated router",
      values: {
        model: "Videohub",
        routingGroupsRevision: null,
        simulated: true,
      },
    }),
  );
  // A problem keeps its own message.
  simulated.publish({
    ...(state as object),
    phase: "unavailable",
    message: "Simulated Videohub is not connected",
  } as never);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "unavailable",
      message: "Simulated Videohub is not connected",
      values: expect.objectContaining({ simulated: true }),
    }),
  );

  const real = vi.fn();
  createRoutingStatePublisher(real).publish(state);
  expect(real).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: null,
      values: { model: "Videohub", routingGroupsRevision: null },
    }),
  );
});
