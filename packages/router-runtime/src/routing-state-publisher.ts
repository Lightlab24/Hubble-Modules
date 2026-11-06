import type { ModuleContext } from "@hubble/module-sdk";

type PublishState = ModuleContext["publishState"];
type PublishedState = Parameters<PublishState>[0];

/** Adds the routing document revision to published state without restarting the worker. */
export function createRoutingStatePublisher(publishState: PublishState) {
  let latest: PublishedState | undefined;
  let revision: string | null = null;
  const send = (state: PublishedState) =>
    publishState({
      ...state,
      values: { ...state.values, routingGroupsRevision: revision },
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
