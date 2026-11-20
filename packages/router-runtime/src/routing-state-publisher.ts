import type { ModuleContext } from "@hubble/module-sdk";

type PublishState = ModuleContext["publishState"];
type PublishedState = Parameters<PublishState>[0];

export interface RoutingStateOptions {
  /** A simulated router says so in its state, so Hubble can show Simulated instead of Ready. */
  readonly simulated?: boolean;
}

/** Adds the routing document revision to published state without restarting the worker. */
export function createRoutingStatePublisher(
  publishState: PublishState,
  options: RoutingStateOptions = {},
) {
  const simulated = options.simulated === true;
  let latest: PublishedState | undefined;
  let revision: string | null = null;
  const send = (state: PublishedState) =>
    publishState({
      ...state,
      ...(simulated && state.phase === "ready" && state.message === null
        ? { message: "Simulated router" }
        : {}),
      values: {
        ...state.values,
        routingGroupsRevision: revision,
        ...(simulated ? { simulated: true } : {}),
      },
    });
  return {
    publish(state: PublishedState) {
      latest = state;
      send(state);
    },
    setRevision(next: string | null) {
      if (next === revision) return;
      revision = next;
      if (latest) send(latest);
    },
  };
}
