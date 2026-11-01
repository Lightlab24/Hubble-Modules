import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModuleJsonValue } from "@hubble/module-sdk";
import type { RouterConnectionManagerContract } from "./connection-contract.js";
import type { RossSwp08RouteStateEvent } from "./routing-models.js";
import { connectionView } from "./frontend/connection-view.js";
import {
  RouterSessionBootstrapSchema,
  RouterResourcePageQuerySchema,
  RouterResourcePageExchangeSchema,
  RouterStateEventSchema,
  RouteCrosspointsRequestSchema,
  RouteCrosspointsExchangeSchema,
  InterrogateRouterTargetsRequestSchema,
  InterrogateRouterTargetsExchangeSchema,
  type RouterStateEvent,
  type SequencedRouterStateEvent,
} from "./page-contract.js";

const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value));
const MAX_PAGE_BYTES = 196608;
const MAX_PAGE_EVENTS = 128;
const SESSION_LIFETIME = 60000;
const Poll = z.strictObject({
  sessionId: z.uuid(),
  afterSequence: z.int().nonnegative(),
});
type Session = {
  sequence: number;
  expires: number;
  events: SequencedRouterStateEvent[];
  bytes: number;
  wake?: () => void;
  waiting: boolean;
};

/** All routing projections, sequencing and device decisions ship in the module package. */
export class RouterPageRuntime {
  private sequence = 0;
  private groupRevision = "initial";
  notifyGroups(value: unknown) {
    const revision = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    if (revision === this.groupRevision) return;
    this.groupRevision = revision;
    for (const session of this.sessions.values()) session.wake?.();
  }
  private sessions = new Map<string, Session>();
  private results = new Map<string, { text: string | null; expires: number }>();
  private stops: (() => void)[] = [];
  constructor(
    private readonly manager: RouterConnectionManagerContract,
    private readonly connectionId: string,
  ) {}

  start() {
    let transport = this.snapshot().phase;
    this.stops = [
      this.manager.subscribeRouteState(this.connectionId, (event) =>
        this.emit(this.project(event)),
      ),
      this.manager.subscribe(() => {
        const next = this.snapshot().phase;
        if (transport === next) return;
        transport = next;
        this.emit(
          RouterStateEventSchema.parse({
            type: "transport",
            phase: next,
            version: this.manager.routeState(this.connectionId).version,
          }),
        );
      }),
    ];
  }
  stop() {
    this.stops.splice(0).forEach((stop) => stop());
    for (const session of this.sessions.values()) session.wake?.();
    this.sessions.clear();
    this.results.clear();
  }
  private snapshot() {
    const snapshot = this.manager
      .snapshots()
      .find((item) => item.definition.connectionId === this.connectionId);
    if (!snapshot) throw new Error("Router connection is unavailable");
    return snapshot;
  }
  private project(event: RossSwp08RouteStateEvent): RouterStateEvent {
    try {
      if (event.type === "reset") {
        const route = this.manager.routeState(this.connectionId);
        return RouterStateEventSchema.parse({
          ...event,
          knownSourceCount: route.knownSourceCount,
          knownDestinationCount: route.knownDestinationCount,
          knownCrosspointCount: route.knownCrosspointCount,
        });
      }
      if (event.type === "delta")
        return RouterStateEventSchema.parse({
          ...event,
          crosspoints: event.crosspoints.map(
            ({ matrix: _, ...point }) => point,
          ),
        });
      if (event.type === "observation") {
        const { matrix: _, ...crosspoint } = event.crosspoint;
        return RouterStateEventSchema.parse({ ...event, crosspoint });
      }
      return RouterStateEventSchema.parse(event);
    } catch {
      return { type: "resync_required", reason: "invalid_event" };
    }
  }
  private prune() {
    for (const [id, session] of this.sessions)
      if (session.expires <= Date.now()) {
        session.wake?.();
        this.sessions.delete(id);
      }
    for (const [id, result] of this.results)
      if (result.expires <= Date.now()) this.results.delete(id);
  }
  private async commandResult(
    run: () => Promise<unknown>,
  ): Promise<ModuleJsonValue> {
    this.prune();
    if (this.results.size >= 8)
      throw new Error(
        "Router command result capacity reached; wait for pending commands",
      );
    const id = randomUUID();
    this.results.set(id, { text: null, expires: Date.now() + 120000 });
    try {
      const value = json(await run()),
        text = JSON.stringify(value);
      if (text.length <= 65536) {
        this.results.delete(id);
        return value;
      }
      this.results.set(id, { text, expires: Date.now() + SESSION_LIFETIME });
      return {
        routerResultPages: 1,
        id,
        count: Math.ceil(text.length / 32768),
      };
    } catch (error) {
      this.results.delete(id);
      throw error;
    }
  }
  private emit(event: RouterStateEvent) {
    this.prune();
    const next = {
      sequence: ++this.sequence,
      emittedAt: new Date().toISOString(),
      event,
    };
    const bytes = JSON.stringify(next).length;
    for (const session of this.sessions.values()) {
      if (
        session.bytes + bytes > MAX_PAGE_BYTES ||
        session.events.length >= MAX_PAGE_EVENTS
      ) {
        const overflow: SequencedRouterStateEvent = {
          ...next,
          event: { type: "resync_required", reason: "event_buffer_overflow" },
        };
        session.events = [overflow];
        session.bytes = JSON.stringify(overflow).length;
      } else {
        session.events.push(next);
        session.bytes += bytes;
      }
      session.wake?.();
    }
  }
  private page(raw: unknown) {
    const query = RouterResourcePageQuerySchema.parse(raw);
    if (query.connectionId !== this.connectionId)
      throw new Error("Router page scope changed");
    const definition = this.snapshot().definition;
    const levelCount = "levels" in definition ? definition.levels : 1;
    const limit = Math.min(
      query.limit,
      128,
      Math.max(1, Math.floor(2048 / levelCount)),
    );
    const request = { ...query, limit };
    const value =
      query.resource === "sources"
        ? this.manager.queryRouteSources(this.connectionId, request)
        : this.manager.queryRouteDestinations(this.connectionId, {
            ...request,
            source: query.source,
            levels: query.levels,
          });
    const page = { ...value, resource: query.resource };
    return RouterResourcePageExchangeSchema.parse({ query, page }).page;
  }
  async call(
    command: string,
    value: ModuleJsonValue,
    signal: AbortSignal,
  ): Promise<ModuleJsonValue> {
    signal.throwIfAborted();
    switch (command) {
      case "open": {
        this.prune();
        if (this.sessions.size >= 8)
          throw new Error("Close an unused router page before opening another");
        const snapshot = this.snapshot(),
          route = this.manager.routeState(this.connectionId);
        const query = {
          connectionId: this.connectionId,
          version: route.version,
          labelRevision: route.labelRevision,
          afterAddress: null,
          search: null,
          limit: 64,
        };
        const listenerId = randomUUID();
        const bootstrap = RouterSessionBootstrapSchema.parse({
          listenerId,
          lastEventSequence: this.sequence,
          connectionId: this.connectionId,
          version: route.version,
          labelRevision: route.labelRevision,
          transport: snapshot.phase,
          sync: route.phase,
          labels: route.labelPhase,
          requestTimeoutMs: snapshot.definition.requestTimeoutMs,
          levels:
            "levels" in snapshot.definition ? snapshot.definition.levels : 1,
          extended: "levels" in snapshot.definition,
          wideAddresses: true,
          knownSourceCount: route.knownSourceCount,
          knownDestinationCount: route.knownDestinationCount,
          knownCrosspointCount: route.knownCrosspointCount,
          sources: this.page({ ...query, resource: "sources" }),
          destinations: this.page({
            ...query,
            resource: "destinations",
            source: null,
            levels: [],
          }),
        });
        this.sessions.set(listenerId, {
          sequence: this.sequence,
          expires: Date.now() + SESSION_LIFETIME,
          events: [],
          bytes: 0,
          waiting: false,
        });
        return json({ connection: connectionView(snapshot), bootstrap });
      }
      case "close": {
        const id = z.uuid().parse(value),
          session = this.sessions.get(id);
        session?.wake?.();
        this.sessions.delete(id);
        return null;
      }
      case "poll": {
        this.prune();
        const input = Poll.parse(value),
          session = this.sessions.get(input.sessionId);
        if (!session || session.waiting)
          throw new Error("Router page session is unavailable");
        if (
          input.afterSequence < session.sequence ||
          input.afterSequence > this.sequence
        )
          throw new Error("Invalid router page acknowledgement");
        session.sequence = input.afterSequence;
        session.events = session.events.filter(
          (event) => event.sequence > input.afterSequence,
        );
        session.bytes = JSON.stringify(session.events).length;
        session.expires = Date.now() + SESSION_LIFETIME;
        session.waiting = true;
        try {
          if (!session.events.length)
            await new Promise<void>((resolve, reject) => {
              const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", aborted);
                delete session.wake;
                resolve();
              };
              const aborted = () => {
                finish();
                reject(signal.reason ?? new Error("Cancelled"));
              };
              const timer = setTimeout(finish, 20000);
              session.wake = finish;
              signal.addEventListener("abort", aborted, { once: true });
              if (signal.aborted) aborted();
            });
          signal.throwIfAborted();
          if (this.sessions.get(input.sessionId) !== session)
            throw new Error("Router page session ended");
          return json({
            events: session.events,
            connection: connectionView(this.snapshot()),
            groupRevision: this.groupRevision,
          });
        } finally {
          session.waiting = false;
        }
      }
      case "resources":
        return json(this.page(value));
      case "result-page": {
        this.prune();
        const input = z
          .strictObject({ id: z.uuid(), index: z.int().min(0).max(63) })
          .parse(value);
        const result = this.results.get(input.id);
        if (!result?.text || input.index * 32768 >= result.text.length)
          throw new Error(
            "Router command result expired; refresh observed routes without repeating the command",
          );
        return result.text.slice(
          input.index * 32768,
          (input.index + 1) * 32768,
        );
      }
      case "route": {
        const request = RouteCrosspointsRequestSchema.parse(value);
        if (request.connectionId !== this.connectionId)
          throw new Error("Router command scope changed");
        return this.commandResult(async () => {
          const outcome = await this.manager.routeCrosspoints(request);
          const result =
            outcome.status === "rejected"
              ? { ...outcome, message: routeRejectionMessage(outcome.code) }
              : outcome;
          return RouteCrosspointsExchangeSchema.parse({ request, result })
            .result;
        });
      }
      case "interrogate": {
        const request = InterrogateRouterTargetsRequestSchema.parse(value);
        if (request.connectionId !== this.connectionId)
          throw new Error("Router command scope changed");
        return this.commandResult(async () => {
          const outcome = await this.manager.interrogateRouteTargets(request);
          const result =
            outcome.status === "rejected"
              ? { ...outcome, message: routeRejectionMessage(outcome.code) }
              : outcome;
          return InterrogateRouterTargetsExchangeSchema.parse({
            request,
            result,
          }).result;
        });
      }
      case "refresh":
        await this.manager.refreshNames(this.connectionId);
        return null;
      default:
        throw new Error("Unknown router page command");
    }
  }
}

const ROUTE_REJECTION_MESSAGES = {
  connection_unavailable: "Router connection is unavailable",
  disabled: "Router connection is disabled",
  disconnected: "Router is disconnected",
  not_synchronized: "Router state is not synchronized",
  stale_generation: "Router state changed; refresh and try again",
  target_conflict: "Router routes changed; review and try again",
  target_busy: "Router target confirmation is still pending",
  invalid_source: "Router source is outside the configured range",
  invalid_destination: "Router destination is outside the configured range",
  invalid_level: "Router level is outside the configured range",
  duplicate_target: "Router request contains a duplicate target",
  capacity_exceeded: "Router request is too large",
  operation_id_conflict: "Router operation identifier was already used",
  operation_capacity_exceeded: "Too many Router operations are in progress",
} as const;

function routeRejectionMessage(code: string): string {
  return (
    ROUTE_REJECTION_MESSAGES[code as keyof typeof ROUTE_REJECTION_MESSAGES] ??
    "Router request was rejected"
  );
}
