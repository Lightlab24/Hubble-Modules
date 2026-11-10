import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { RouterPageApi as DesktopApi } from "./page-client.js";
import {
  InterrogateRouterTargetsRequestSchema,
  RouteCrosspointsRequestSchema,
  RouterResourcePageQuerySchema,
  type InterrogateRouterTarget,
  type RouteCrosspointsResult,
  type RouterDestinationPageQuery,
  type RouterSourcePageQuery,
} from "../page-contract.js";
import {
  applyTakeResult,
  beginTake,
  clearConfirmedDrafts,
  clearSelection as clearRouterSelection,
  clearStaged as clearRouterStaged,
  createRouterState,
  markRouterDisconnected,
  mergeRouterPage,
  rebaseMapping as rebaseRouterMapping,
  reduceRouterEvent,
  removeStagedMapping as removeRouterStagedMapping,
  replaceStagedSource as replaceRouterStagedSource,
  selectDestination as selectRouterDestination,
  selectSource as selectRouterSource,
  sourceAt,
  stageMapping as stageRouterMapping,
  changeStagedRoutes as changeRouterStagedRoutes,
  type RouterDraftMapping,
  type RouterSelections,
  type RouterState,
  type StageRouterMappingInput,
  type StagedRouteChange,
  type StagedRouteChangeOutcome,
} from "./router-state.js";

export type RouterConnectionStatus =
  | "inactive"
  | "connecting"
  | "failed"
  | "ready";

export interface RouterClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RouterStateHookOptions {
  readonly clock?: RouterClock;
  readonly presentationScheduler?: RouterPresentationScheduler;
  readonly randomUUID?: () => string;
  /** The router reports empty destinations, so a route may be staged onto one. */
  readonly allowUnassigned?: boolean;
}

export interface RouterPresentationScheduler {
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

interface PendingRouterPresentation {
  frameHandle: unknown;
  frameScheduled: boolean;
  fallbackHandle: unknown;
  fallbackScheduled: boolean;
  scheduler: RouterPresentationScheduler;
  clock: RouterClock;
  state: RouterState;
}

const ROUTER_PRESENTATION_FALLBACK_MS = 50;

const DEFAULT_ROUTER_CLOCK: RouterClock = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number): unknown =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
});

export interface RouterSourcePageInput {
  readonly afterAddress: RouterSourcePageQuery["afterAddress"];
  readonly limit: RouterSourcePageQuery["limit"];
  readonly search: RouterSourcePageQuery["search"];
}

export interface RouterDestinationPageInput {
  readonly afterAddress: RouterDestinationPageQuery["afterAddress"];
  readonly limit: RouterDestinationPageQuery["limit"];
  readonly search: RouterDestinationPageQuery["search"];
  readonly source: RouterDestinationPageQuery["source"];
  readonly levels: RouterDestinationPageQuery["levels"];
}

export interface RouterConnection {
  readonly state: RouterState | null;
  readonly status: RouterConnectionStatus;
  reconnect(): void;
  loadSourcePage(input: RouterSourcePageInput): Promise<void>;
  loadDestinationPage(input: RouterDestinationPageInput): Promise<void>;
  selectSource(source: number | null): void;
  selectDestination(destination: number | null): void;
  clearSelection(): void;
  stageMapping(input: StageRouterMappingInput): void;
  /** Add, replace or remove staged routes for one Routes sheet gesture. */
  changeStagedRoutes(
    changes: readonly StagedRouteChange[],
  ): StagedRouteChangeOutcome;
  replaceStagedSource(source: number): void;
  rebaseMapping(mappingId: string): void;
  removeStagedMapping(mappingId: string): void;
  clearStaged(): void;
  submitTake(): Promise<void>;
  /**
   * Send one route now, leaving anything staged for Take alone. Resolves to
   * null when the page changed or a target's current route isn't known yet.
   */
  sendRoute(
    input: StageRouterMappingInput,
  ): Promise<RouteCrosspointsResult | null>;
  refreshSelectedDestinations(): void;
}

interface LiveRouterSession {
  readonly epoch: number;
  readonly connectionId: string;
  readonly generation: string | null;
  readonly restart: number;
  readonly phase: "connecting" | "ready" | "terminal";
}

interface RequestedRouterSession {
  readonly active: boolean;
  readonly connectionId: string | null;
  readonly restart: number;
}

interface CurrentRouterSession {
  readonly live: LiveRouterSession;
  readonly state: RouterState;
}

interface PresentedRouterSession {
  readonly connectionId: string;
  readonly restart: number;
}

interface RouterStatusRecord {
  readonly connectionId: string;
  readonly restart: number;
  readonly status: Exclude<RouterConnectionStatus, "inactive">;
}

interface RouterPageRequestScope {
  epoch: number;
  sources: number;
  destinations: number;
}

interface RouterPageRequestToken {
  readonly epoch: number;
  readonly resource: "sources" | "destinations";
  readonly sequence: number;
}

export function useRouterState(
  api: DesktopApi,
  active: boolean,
  connectionId: string | null,
  options: RouterStateHookOptions = {},
): RouterConnection {
  const allowUnassigned = options.allowUnassigned === true;
  const [restart, setRestart] = useState(0);
  const [state, setState] = useState<RouterState | null>(null);
  const [presentedSession, setPresentedSession] =
    useState<PresentedRouterSession | null>(null);
  const [statusRecord, setStatusRecord] = useState<RouterStatusRecord | null>(
    null,
  );
  const stateRef = useRef<RouterState | null>(null);
  const epochRef = useRef(0);
  const requestedSessionRef = useRef<RequestedRouterSession>({
    active,
    connectionId,
    restart,
  });
  const liveSessionRef = useRef<LiveRouterSession | null>(null);
  const draftsByConnectionRef = useRef(
    new Map<string, readonly RouterDraftMapping[]>(),
  );
  const selectionByConnectionRef = useRef(new Map<string, RouterSelections>());
  const pageRequestScopeRef = useRef<RouterPageRequestScope>({
    epoch: 0,
    sources: 0,
    destinations: 0,
  });
  const presentationSchedulerRef = useRef<RouterPresentationScheduler | null>(
    options.presentationScheduler ?? defaultPresentationScheduler(),
  );
  const clockRef = useRef<RouterClock>(options.clock ?? DEFAULT_ROUTER_CLOCK);
  const pendingPresentationRef = useRef<PendingRouterPresentation | null>(null);
  const scheduleResyncRef = useRef<() => void>(() => undefined);
  const randomUuidRef = useRef(options.randomUUID ?? randomUuid);

  useLayoutEffect(() => {
    randomUuidRef.current = options.randomUUID ?? randomUuid;
  }, [options.randomUUID]);

  useLayoutEffect(() => {
    presentationSchedulerRef.current =
      options.presentationScheduler ?? defaultPresentationScheduler();
  }, [options.presentationScheduler]);

  useLayoutEffect(() => {
    clockRef.current = options.clock ?? DEFAULT_ROUTER_CLOCK;
  }, [options.clock]);

  const cancelPendingPresentation = useCallback((): void => {
    const pending = pendingPresentationRef.current;
    if (pending === null) return;
    pendingPresentationRef.current = null;
    if (pending.frameScheduled) pending.scheduler.cancel(pending.frameHandle);
    if (pending.fallbackScheduled)
      pending.clock.clearTimeout(pending.fallbackHandle);
  }, []);

  const presentPendingState = useCallback(
    (pending: PendingRouterPresentation): void => {
      if (pendingPresentationRef.current !== pending) return;
      pendingPresentationRef.current = null;
      if (pending.frameScheduled) pending.scheduler.cancel(pending.frameHandle);
      if (pending.fallbackScheduled)
        pending.clock.clearTimeout(pending.fallbackHandle);
      if (stateRef.current === pending.state) setState(pending.state);
    },
    [],
  );

  useLayoutEffect(() => {
    requestedSessionRef.current = { active, connectionId, restart };
    const live = liveSessionRef.current;
    if (
      !active ||
      connectionId === null ||
      live === null ||
      live.connectionId !== connectionId ||
      live.restart !== restart
    ) {
      cancelPendingPresentation();
      const current = stateRef.current;
      if (current !== null) {
        const disconnected = markRouterDisconnected(current);
        draftsByConnectionRef.current.set(
          current.connectionId,
          disconnected.drafts,
        );
        selectionByConnectionRef.current.set(
          current.connectionId,
          disconnected.selection,
        );
        setState(disconnected);
      }
      stateRef.current = null;
      setPresentedSession(null);
      setStatusRecord(null);
    }
  }, [active, cancelPendingPresentation, connectionId, restart]);

  const retainState = useCallback((next: RouterState): void => {
    stateRef.current = next;
    draftsByConnectionRef.current.set(next.connectionId, next.drafts);
    selectionByConnectionRef.current.set(next.connectionId, next.selection);
  }, []);

  const commitState = useCallback(
    (next: RouterState): void => {
      cancelPendingPresentation();
      retainState(next);
      setState(next);
    },
    [cancelPendingPresentation, retainState],
  );

  const commitStreamState = useCallback(
    (next: RouterState): void => {
      retainState(next);
      const scheduler = presentationSchedulerRef.current;
      if (scheduler === null) {
        setState(next);
        return;
      }
      // Keep the authoritative ref current for every ordered event, while
      // presenting only the newest truth once per display frame.
      const pending = pendingPresentationRef.current;
      if (pending !== null) {
        pending.state = next;
        return;
      }
      const clock = clockRef.current;
      const scheduled: PendingRouterPresentation = {
        frameHandle: undefined,
        frameScheduled: false,
        fallbackHandle: undefined,
        fallbackScheduled: false,
        scheduler,
        clock,
        state: next,
      };
      pendingPresentationRef.current = scheduled;
      try {
        scheduled.frameHandle = scheduler.request(() => {
          presentPendingState(scheduled);
        });
        scheduled.frameScheduled = true;
      } catch {
        presentPendingState(scheduled);
        return;
      }
      if (pendingPresentationRef.current !== scheduled) {
        scheduler.cancel(scheduled.frameHandle);
        return;
      }
      // A hidden or overloaded web view may permanently drop an animation frame.
      // Bound the wait so the latch always releases and presents the newest truth.
      try {
        scheduled.fallbackHandle = clock.setTimeout(() => {
          presentPendingState(scheduled);
        }, ROUTER_PRESENTATION_FALLBACK_MS);
        scheduled.fallbackScheduled = true;
      } catch {
        presentPendingState(scheduled);
        return;
      }
      if (pendingPresentationRef.current !== scheduled) {
        clock.clearTimeout(scheduled.fallbackHandle);
      }
    },
    [presentPendingState, retainState],
  );

  useEffect(
    () => () => {
      cancelPendingPresentation();
    },
    [cancelPendingPresentation],
  );

  const sessionMatches = useCallback(
    (
      epoch: number,
      expectedConnectionId: string,
      expectedGeneration?: string,
    ): boolean => {
      const live = liveSessionRef.current;
      const requested = requestedSessionRef.current;
      return (
        live !== null &&
        requested.active &&
        requested.connectionId === expectedConnectionId &&
        requested.restart === live.restart &&
        live.epoch === epoch &&
        live.connectionId === expectedConnectionId &&
        (expectedGeneration === undefined ||
          live.generation === expectedGeneration)
      );
    },
    [],
  );

  const currentSession = useCallback((): CurrentRouterSession | null => {
    const requested = requestedSessionRef.current;
    const live = liveSessionRef.current;
    const current = stateRef.current;
    if (
      !requested.active ||
      requested.connectionId === null ||
      live === null ||
      live.phase !== "ready" ||
      current === null ||
      live.connectionId !== requested.connectionId ||
      live.restart !== requested.restart ||
      current.connectionId !== requested.connectionId ||
      live.generation !== current.version.generation
    ) {
      return null;
    }
    return { live, state: current };
  }, []);

  useEffect(() => {
    const current = stateRef.current;
    if (current === null) return;
    const settled = clearConfirmedDrafts(current);
    if (settled === current) return;
    commitState(settled);
  }, [commitState, state]);

  const issueInterrogation = useCallback(
    (
      current: RouterState,
      targets: readonly InterrogateRouterTarget[],
      epoch: number,
    ): boolean => {
      const session = currentSession();
      if (
        session === null ||
        session.live.epoch !== epoch ||
        session.state !== current ||
        targets.length === 0 ||
        !sessionMatches(epoch, current.connectionId, current.version.generation)
      ) {
        return false;
      }
      const parsed = InterrogateRouterTargetsRequestSchema.safeParse({
        requestId: randomUuidRef.current(),
        connectionId: current.connectionId,
        generation: current.version.generation,
        targets,
      });
      if (!parsed.success) return false;
      const expectedConnectionId = current.connectionId;
      const expectedGeneration = current.version.generation;
      void api.interrogateRouterTargets(parsed.data).then(
        () => {
          // Route truth arrives through the sequenced stream. The command result is
          // deliberately side-effect free, but the session check prevents future
          // diagnostic handling from crossing a connection or generation boundary.
          sessionMatches(epoch, expectedConnectionId, expectedGeneration);
        },
        () => undefined,
      );
      return true;
    },
    [api, currentSession, sessionMatches],
  );

  const interrogateSelection = useCallback(
    (current: RouterState, epoch: number): void => {
      const session = currentSession();
      if (
        session === null ||
        session.live.epoch !== epoch ||
        session.state !== current
      )
        return;
      const destination = current.selection.destination;
      if (
        destination === null ||
        current.transport !== "connected" ||
        current.sync !== "ready"
      ) {
        return;
      }
      const levels = configuredLevels(current);
      issueInterrogation(current, [{ destination, levels }], epoch);
    },
    [currentSession, issueInterrogation],
  );

  const reconnect = useCallback((): void => {
    const live = liveSessionRef.current;
    if (live !== null) liveSessionRef.current = { ...live, phase: "terminal" };
    const current = stateRef.current;
    if (current !== null) {
      const disconnected = markRouterDisconnected(current);
      draftsByConnectionRef.current.set(
        current.connectionId,
        disconnected.drafts,
      );
      selectionByConnectionRef.current.set(
        current.connectionId,
        disconnected.selection,
      );
    }
    stateRef.current = null;
    pageRequestScopeRef.current = { epoch: -1, sources: 0, destinations: 0 };
    setRestart((current) => current + 1);
  }, []);

  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    pageRequestScopeRef.current = { epoch, sources: 0, destinations: 0 };
    scheduleResyncRef.current = () => undefined;

    if (!active || connectionId === null) {
      liveSessionRef.current = null;
      return;
    }

    let resyncScheduled = false;
    let listenerTerminated = false;
    liveSessionRef.current = {
      epoch,
      connectionId,
      generation: null,
      restart,
      phase: "connecting",
    };
    stateRef.current = null;

    const scheduleResync = (): void => {
      if (resyncScheduled || !sessionMatches(epoch, connectionId)) return;
      resyncScheduled = true;
      pageRequestScopeRef.current = { epoch: -1, sources: 0, destinations: 0 };
      const live = liveSessionRef.current;
      if (live?.epoch === epoch)
        liveSessionRef.current = { ...live, phase: "terminal" };
      queueMicrotask(() => {
        if (!sessionMatches(epoch, connectionId)) return;
        setRestart((current) => current + 1);
      });
    };
    scheduleResyncRef.current = scheduleResync;

    const listener: Parameters<DesktopApi["connectRouterState"]>[1] = (
      event,
    ) => {
      if (listenerTerminated || !sessionMatches(epoch, connectionId)) return;
      const current = stateRef.current;
      if (current === null) {
        listenerTerminated = true;
        scheduleResync();
        return;
      }
      const session = currentSession();
      if (session === null || session.state !== current) return;
      const reduction = reduceRouterEvent(current, event);
      const next = reduction.state;
      const generationChanged =
        next.version.generation !== current.version.generation;
      if (generationChanged) {
        liveSessionRef.current = {
          epoch,
          connectionId,
          generation: next.version.generation,
          restart,
          phase: "terminal",
        };
      }
      const routeTruthEvent =
        event.event.type === "delta" ||
        event.event.type === "observation" ||
        event.event.type === "intent";
      if (
        routeTruthEvent &&
        reduction.effect === "none" &&
        !generationChanged
      ) {
        commitStreamState(next);
      } else {
        commitState(next);
      }
      if (generationChanged) {
        listenerTerminated = true;
        scheduleResync();
        return;
      }
      if (reduction.effect === "resync") scheduleResync();
    };

    void (async () => {
      try {
        const bootstrap = await api.connectRouterState(connectionId, listener);
        const connecting = liveSessionRef.current;
        if (
          !sessionMatches(epoch, connectionId) ||
          connecting?.epoch !== epoch ||
          connecting.phase !== "connecting"
        ) {
          return;
        }
        const retainedDrafts =
          draftsByConnectionRef.current.get(connectionId) ?? [];
        const retainedSelection =
          selectionByConnectionRef.current.get(connectionId);
        let next = createRouterState(bootstrap, retainedDrafts);
        if (retainedSelection !== undefined) {
          next = selectRouterSource(next, retainedSelection.source);
          next = selectRouterDestination(next, retainedSelection.destination);
        }
        liveSessionRef.current = {
          epoch,
          connectionId,
          generation: next.version.generation,
          restart,
          phase: "ready",
        };
        commitState(next);
        setPresentedSession({ connectionId, restart });
        setStatusRecord({ connectionId, restart, status: "ready" });
      } catch {
        const connecting = liveSessionRef.current;
        if (
          sessionMatches(epoch, connectionId) &&
          connecting?.epoch === epoch &&
          connecting.phase === "connecting"
        ) {
          setStatusRecord({ connectionId, restart, status: "failed" });
        }
      }
    })();

    const draftsByConnection = draftsByConnectionRef.current;
    return () => {
      if (liveSessionRef.current?.epoch === epoch)
        liveSessionRef.current = null;
      if (pageRequestScopeRef.current.epoch === epoch) {
        pageRequestScopeRef.current = {
          epoch: -1,
          sources: 0,
          destinations: 0,
        };
      }
      if (scheduleResyncRef.current === scheduleResync) {
        scheduleResyncRef.current = () => undefined;
      }
      const current = stateRef.current;
      if (current?.connectionId === connectionId) {
        const disconnected = markRouterDisconnected(current);
        stateRef.current = disconnected;
        draftsByConnection.set(connectionId, disconnected.drafts);
      }
      api.disconnectRouterState();
    };
  }, [
    active,
    api,
    commitState,
    commitStreamState,
    connectionId,
    currentSession,
    restart,
    sessionMatches,
  ]);

  const loadPage = useCallback(
    async (
      queryValue: unknown,
      requestToken: RouterPageRequestToken,
    ): Promise<void> => {
      const session = currentSession();
      if (session === null) return;
      const { live, state: current } = session;
      const parsed = RouterResourcePageQuerySchema.safeParse(queryValue);
      if (!parsed.success) throw new Error("Invalid Router page query");
      const query = parsed.data;
      if (
        query.resource !== requestToken.resource ||
        live.epoch !== requestToken.epoch
      )
        return;
      const epoch = live.epoch;
      const expectedConnectionId = current.connectionId;
      const expectedGeneration = current.version.generation;
      try {
        const page = await api.queryRouterResources(query);
        if (!sessionMatches(epoch, expectedConnectionId, expectedGeneration))
          return;
        const latestRequest = pageRequestScopeRef.current;
        if (
          latestRequest.epoch !== requestToken.epoch ||
          latestRequest[requestToken.resource] !== requestToken.sequence
        ) {
          return;
        }
        const latestSession = currentSession();
        if (latestSession === null || latestSession.live.epoch !== epoch)
          return;
        const latest = latestSession.state;
        if (
          latest.version.revision !== query.version.revision ||
          latest.labelRevision !== query.labelRevision
        ) {
          return;
        }
        const merged = mergeRouterPage(latest, { query, page });
        commitState(merged.state);
        if (merged.effect === "resync") scheduleResyncRef.current();
      } catch (error) {
        // A page is advisory: keep the synchronized stream alive, but surface the
        // failure so the view can distinguish it from an empty result and retry.
        throw error;
      }
    },
    [api, commitState, currentSession, sessionMatches],
  );

  const loadSourcePage = useCallback(
    async (input: RouterSourcePageInput): Promise<void> => {
      const session = currentSession();
      if (session === null) return;
      const requestScope = pageRequestScopeRef.current;
      if (requestScope.epoch !== session.live.epoch) return;
      requestScope.sources += 1;
      const requestToken: RouterPageRequestToken = {
        epoch: requestScope.epoch,
        resource: "sources",
        sequence: requestScope.sources,
      };
      const current = session.state;
      await loadPage(
        {
          resource: "sources",
          connectionId: current.connectionId,
          version: current.version,
          labelRevision: current.labelRevision,
          ...input,
        },
        requestToken,
      );
    },
    [currentSession, loadPage],
  );

  const loadDestinationPage = useCallback(
    async (input: RouterDestinationPageInput): Promise<void> => {
      const session = currentSession();
      if (session === null) return;
      const requestScope = pageRequestScopeRef.current;
      if (requestScope.epoch !== session.live.epoch) return;
      requestScope.destinations += 1;
      const requestToken: RouterPageRequestToken = {
        epoch: requestScope.epoch,
        resource: "destinations",
        sequence: requestScope.destinations,
      };
      const current = session.state;
      await loadPage(
        {
          resource: "destinations",
          connectionId: current.connectionId,
          version: current.version,
          labelRevision: current.labelRevision,
          ...input,
        },
        requestToken,
      );
    },
    [currentSession, loadPage],
  );

  const selectSource = useCallback(
    (source: number | null): void => {
      const session = currentSession();
      if (session !== null)
        commitState(selectRouterSource(session.state, source));
    },
    [commitState, currentSession],
  );

  const selectDestination = useCallback(
    (destination: number | null): void => {
      const session = currentSession();
      if (session === null) return;
      commitState(selectRouterDestination(session.state, destination));
    },
    [commitState, currentSession],
  );

  const clearSelection = useCallback((): void => {
    const session = currentSession();
    if (session !== null) commitState(clearRouterSelection(session.state));
  }, [commitState, currentSession]);

  const stageMapping = useCallback(
    (input: StageRouterMappingInput): void => {
      const session = currentSession();
      if (session === null) return;
      commitState(
        stageRouterMapping(
          session.state,
          input,
          randomUuidRef.current,
          allowUnassigned,
        ),
      );
    },
    [allowUnassigned, commitState, currentSession],
  );

  const changeStagedRoutes = useCallback(
    (changes: readonly StagedRouteChange[]): StagedRouteChangeOutcome => {
      const session = currentSession();
      if (session === null) return "unavailable";
      const result = changeRouterStagedRoutes(
        session.state,
        changes,
        randomUuidRef.current,
        allowUnassigned,
      );
      if (result.outcome === "changed") commitState(result.state);
      return result.outcome;
    },
    [allowUnassigned, commitState, currentSession],
  );

  const clearStaged = useCallback((): void => {
    const session = currentSession();
    if (session === null) return;
    commitState(clearRouterStaged(session.state));
  }, [commitState, currentSession]);

  const replaceStagedSource = useCallback(
    (source: number): void => {
      const session = currentSession();
      if (session !== null)
        commitState(replaceRouterStagedSource(session.state, source));
    },
    [commitState, currentSession],
  );

  const rebaseMapping = useCallback(
    (mappingId: string): void => {
      const session = currentSession();
      if (session !== null)
        commitState(rebaseRouterMapping(session.state, mappingId));
    },
    [commitState, currentSession],
  );

  const removeStagedMapping = useCallback(
    (mappingId: string): void => {
      const session = currentSession();
      if (session === null) return;
      commitState(removeRouterStagedMapping(session.state, mappingId));
    },
    [commitState, currentSession],
  );

  const submitTake = useCallback(async (): Promise<void> => {
    const session = currentSession();
    if (session === null) return;
    const { live, state: current } = session;
    const operationId = randomUuidRef.current();
    const submitting = beginTake(current, operationId);
    if (submitting === current) return;
    const requestResult = RouteCrosspointsRequestSchema.safeParse({
      operationId,
      connectionId: submitting.connectionId,
      version: submitting.version,
      mappings: submitting.drafts
        .filter((draft) => draft.operationId === operationId)
        .map((draft) => ({
          mappingId: draft.mappingId,
          source: draft.source,
          destination: draft.destination,
          levels: draft.levels,
          expected: draft.expected,
        })),
    });
    if (!requestResult.success) return;
    commitState(submitting);

    const epoch = live.epoch;
    const expectedConnectionId = submitting.connectionId;
    const expectedGeneration = submitting.version.generation;
    try {
      const result = await api.routeCrosspoints(requestResult.data);
      if (!sessionMatches(epoch, expectedConnectionId, expectedGeneration))
        return;
      const latestSession = currentSession();
      if (latestSession === null || latestSession.live.epoch !== epoch) return;
      const latest = latestSession.state;
      commitState(clearConfirmedDrafts(applyTakeResult(latest, result)));
    } catch {
      if (!sessionMatches(epoch, expectedConnectionId, expectedGeneration))
        return;
      const latestSession = currentSession();
      if (latestSession === null || latestSession.live.epoch !== epoch) return;
      const latest = latestSession.state;
      const failed = applyTakeResult(latest, {
        status: "rejected",
        operationId,
        code: "connection_unavailable",
        message: "Router command is unavailable.",
      });
      commitState(failed);
    }
  }, [api, commitState, currentSession, sessionMatches]);

  const sendRoute = useCallback(
    async (
      input: StageRouterMappingInput,
    ): Promise<RouteCrosspointsResult | null> => {
      const session = currentSession();
      if (session === null) return null;
      const { state: current } = session;
      const request = RouteCrosspointsRequestSchema.safeParse({
        operationId: randomUuidRef.current(),
        connectionId: current.connectionId,
        version: current.version,
        mappings: [
          {
            mappingId: randomUuidRef.current(),
            source: input.source,
            destination: input.destination,
            levels: input.levels,
            expected: input.levels.map((level) => ({
              level,
              source: sourceAt(current, input.destination, level),
            })),
          },
        ],
      });
      return request.success ? api.routeCrosspoints(request.data) : null;
    },
    [api, currentSession],
  );

  const refreshSelectedDestinations = useCallback((): void => {
    const session = currentSession();
    if (session !== null)
      interrogateSelection(session.state, session.live.epoch);
  }, [currentSession, interrogateSelection]);

  const requestedState =
    active &&
    connectionId !== null &&
    state?.connectionId === connectionId &&
    presentedSession?.connectionId === connectionId &&
    presentedSession.restart === restart
      ? state
      : null;
  const requestedStatus: RouterConnectionStatus =
    !active || connectionId === null
      ? "inactive"
      : statusRecord?.connectionId === connectionId &&
          statusRecord.restart === restart
        ? statusRecord.status
        : "connecting";

  return {
    state: requestedState,
    status: requestedStatus,
    reconnect,
    loadSourcePage,
    loadDestinationPage,
    selectSource,
    selectDestination,
    clearSelection,
    stageMapping,
    changeStagedRoutes,
    replaceStagedSource,
    rebaseMapping,
    removeStagedMapping,
    clearStaged,
    submitTake,
    sendRoute,
    refreshSelectedDestinations,
  };
}

function configuredLevels(state: RouterState): readonly number[] {
  return Object.freeze(
    Array.from({ length: state.levels }, (_, index) => index + 1),
  );
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

function defaultPresentationScheduler(): RouterPresentationScheduler | null {
  if (
    typeof globalThis.requestAnimationFrame !== "function" ||
    typeof globalThis.cancelAnimationFrame !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    request: (callback: () => void): unknown =>
      globalThis.requestAnimationFrame(callback),
    cancel: (handle: unknown): void => {
      if (typeof handle === "number") globalThis.cancelAnimationFrame(handle);
    },
  });
}
