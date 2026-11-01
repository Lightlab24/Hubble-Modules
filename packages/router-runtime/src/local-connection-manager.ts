import type {
  RouterConnectionManagerContract,
  ManagedRouterConnectionSnapshot,
  RouterConnectionManagerListener,
} from "./connection-contract.js";
import type { RouterConnectionDefinition } from "./types.js";
import { RossSwp08RoutingState } from "./routing-state.js";

/** A disabled physical connection supplies definitions for local state without constructing a protocol client. */
export function localRouterManager(): RouterConnectionManagerContract {
  let definition: RouterConnectionDefinition | undefined;
  const routing = new RossSwp08RoutingState(),
    listeners = new Set<RouterConnectionManagerListener>();
  const snapshots = (): ManagedRouterConnectionSnapshot[] =>
    definition
      ? [
          {
            definition,
            phase: "disconnected",
            routeTransport: "disconnected",
            selectedSource: null,
            selectedDestination: null,
            routes: { revision: 0, routes: new Map() },
            sourceCatalog: [],
            destinationCatalog: [],
            lastError: null,
          },
        ]
      : [];
  const disabled = async (): Promise<never> => {
    throw new Error("Router connection is disabled");
  };
  const unavailable = (): never => {
    throw new Error("Router connection is disabled");
  };
  return {
    reconcile(connections) {
      definition = connections[0]
        ? { ...(connections[0] as RouterConnectionDefinition), enabled: false }
        : undefined;
      for (const listener of listeners) listener(snapshots());
    },
    snapshots,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshots());
      return () => {
        listeners.delete(listener);
      };
    },
    subscribePrimaryRouteFeedback(listener) {
      listeners.add(listener);
      listener(snapshots());
      return () => {
        listeners.delete(listener);
      };
    },
    routeState: () => routing.snapshot(),
    subscribeRouteState: (_id, listener) => routing.subscribe(listener),
    queryRouteSources: (_id, query) => routing.sourcePage(query),
    queryRouteDestinations: (_id, query) => routing.destinationPage(query),
    refresh: unavailable,
    refreshNames: disabled,
    selectDestination: unavailable,
    selectSource: disabled,
    take: disabled,
    directRoute: disabled,
    submitDirectRouteTracked: unavailable,
    watchConfirmedRouteTarget(target, listener) {
      listener({
        ...target,
        phase: "pending",
        sourcesByLevel: new Map(),
        lastError: "Router connection is disabled",
      });
      return () => {};
    },
    routeCrosspoints: async (request) => ({
      status: "rejected",
      operationId: request.operationId,
      code: "disabled",
    }),
    interrogateRouteTargets: async (request) => ({
      status: "rejected",
      requestId: request.requestId,
      code: "disabled",
    }),
    stop() {
      listeners.clear();
      definition = undefined;
    },
  };
}
