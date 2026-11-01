import type { createModuleFrontendClient } from "@hubble/module-sdk/frontend";
import {
  RouterSessionBootstrapSchema,
  RouterResourcePageSchema,
  SequencedRouterStateEventSchema,
  RouteCrosspointsResultSchema,
  InterrogateRouterTargetsResultSchema,
  type RouterSessionBootstrap,
  type SequencedRouterStateEvent,
  type RouterResourcePageQuery,
  type RouterResourcePage,
  type RouteCrosspointsRequest,
  type RouteCrosspointsResult,
  type InterrogateRouterTargetsRequest,
  type InterrogateRouterTargetsResult,
} from "../page-contract.js";
import type { ConnectionView } from "./connection-view.js";

export interface RouterPageApi {
  connectRouterState(
    connectionId: string,
    listener: (event: SequencedRouterStateEvent) => void,
  ): Promise<RouterSessionBootstrap>;
  disconnectRouterState(): void;
  queryRouterResources(
    query: RouterResourcePageQuery,
  ): Promise<RouterResourcePage>;
  routeCrosspoints(
    request: RouteCrosspointsRequest,
  ): Promise<RouteCrosspointsResult>;
  interrogateRouterTargets(
    request: InterrogateRouterTargetsRequest,
  ): Promise<InterrogateRouterTargetsResult>;
}
export type PageBridge = Pick<
  ReturnType<typeof createModuleFrontendClient>,
  "call"
>;
export function createRouterPageApi(
  bridge: PageBridge,
  update: (connection: ConnectionView, groupRevision?: string) => void,
): RouterPageApi {
  let epoch = 0,
    currentId: string | null = null;
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  const close = (id: string) => {
    void bridge.call("close", id).catch(() => {});
  };
  const result = async (command: string, input: unknown) => {
    const value = await bridge.call(command, json(input));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.routerResultPages !== 1
    )
      return value;
    if (
      typeof value.id !== "string" ||
      typeof value.count !== "number" ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 64
    )
      throw new Error("Invalid router command result");
    const parts: string[] = [];
    for (let index = 0; index < value.count; index++) {
      const part = await bridge.call("result-page", { id: value.id, index });
      if (typeof part !== "string" || part.length > 32768)
        throw new Error("Invalid router command result page");
      parts.push(part);
    }
    return JSON.parse(parts.join(""));
  };
  return {
    async connectRouterState(connectionId, listener) {
      const request = ++epoch;
      if (currentId) close(currentId);
      currentId = null;
      const result = (await bridge.call("open")) as unknown as {
        bootstrap: unknown;
        connection: ConnectionView;
      };
      const bootstrap = RouterSessionBootstrapSchema.parse(result.bootstrap);
      if (request !== epoch || bootstrap.connectionId !== connectionId) {
        close(bootstrap.listenerId);
        throw new Error("Router page changed");
      }
      currentId = bootstrap.listenerId;
      update(result.connection);
      // Start after the hook installs its bootstrap state. Every reply is tied to this epoch.
      setTimeout(() => {
        void (async () => {
          let afterSequence = bootstrap.lastEventSequence;
          while (request === epoch) {
            try {
              const response = (await bridge.call("poll", {
                sessionId: bootstrap.listenerId,
                afterSequence,
              })) as unknown as {
                events: unknown[];
                connection: ConnectionView;
                groupRevision: string;
              };
              if (request !== epoch) return;
              update(response.connection, response.groupRevision);
              for (const raw of response.events) {
                const event = SequencedRouterStateEventSchema.parse(raw);
                afterSequence = event.sequence;
                listener(event);
                if (request !== epoch) return;
              }
            } catch {
              if (request === epoch)
                listener({
                  sequence: afterSequence + 1,
                  emittedAt: new Date().toISOString(),
                  event: { type: "resync_required", reason: "sequence_gap" },
                });
              return;
            }
          }
        })();
      }, 0);
      return bootstrap;
    },
    disconnectRouterState() {
      epoch++;
      if (currentId) close(currentId);
      currentId = null;
    },
    async queryRouterResources(query) {
      return RouterResourcePageSchema.parse(
        await bridge.call("resources", json(query)),
      );
    },
    async routeCrosspoints(request) {
      return RouteCrosspointsResultSchema.parse(await result("route", request));
    },
    async interrogateRouterTargets(request) {
      return InterrogateRouterTargetsResultSchema.parse(
        await result("interrogate", request),
      );
    },
  };
}
