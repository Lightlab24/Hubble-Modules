import {
  MAX_ROUTER_BOOTSTRAP_CROSSPOINTS,
  MAX_ROUTER_PAGE_ENTRIES,
  MAX_ROUTER_TAKE_CROSSPOINTS,
  MAX_ROUTER_TAKE_MAPPINGS,
  RouteCrosspointsResultSchema,
  RouterMappingIdSchema,
  RouterOperationIdSchema,
  RouterResourcePageExchangeSchema,
  RouterResourcePageQuerySchema,
  RouterSessionBootstrapSchema,
  SequencedRouterStateEventSchema,
  type RouterDestinationEntry,
  type RouterDestinationRoute,
  type RouterResourcePage,
  type RouterResourcePageExchange,
  type RouterResourcePageQuery,
  type RouterRouteVersion,
  type RouterSessionBootstrap,
  type RouterSourceEntry,
  type RouterStateEvent,
} from "../page-contract.js";

const STANDARD_ROUTER_ADDRESS_MAX = 1_024;
const EXTENDED_ROUTER_ADDRESS_MAX = 65_536;
export const MAX_ROUTER_CACHED_ROWS = MAX_ROUTER_PAGE_ENTRIES * 4;
export const MAX_ROUTER_RETAINED_CROSSPOINTS = MAX_ROUTER_BOOTSTRAP_CROSSPOINTS;
export const MAX_ROUTER_CACHED_PAGES_PER_RESOURCE = 32;

export type RouterDraftStatus =
  | "staged"
  | "submitting"
  | "pending"
  | "confirmed"
  | "conflict"
  | "failed"
  | "unconfirmed"
  | "stale";

export type RouterTargetStatus =
  | Exclude<RouterDraftStatus, "staged">
  | "staged";

export interface RouterDraftTarget {
  readonly level: number;
  /** Null when the router reported nothing routed to this level. */
  readonly expectedSource: number | null;
  readonly status: RouterTargetStatus;
  readonly dispatchOutcome: string | null;
}

export interface RouterDraftMapping {
  readonly mappingId: string;
  readonly source: number;
  readonly destination: number;
  readonly levels: readonly number[];
  readonly expected: readonly {
    readonly level: number;
    readonly source: number | null;
  }[];
  readonly baselineGeneration: string;
  readonly operationId: string | null;
  readonly observedDesiredLevels: readonly number[];
  readonly observedContradictoryLevels: readonly number[];
  readonly targets: readonly RouterDraftTarget[];
  readonly dispatchDiagnostics: readonly string[];
  readonly dispatchOutcomes: readonly {
    readonly level: number;
    readonly outcome: string;
  }[];
  readonly status: RouterDraftStatus;
}

export interface RouterSelections {
  readonly source: number | null;
  readonly destination: number | null;
}

export type RouterDestinationSummary =
  | {
      readonly kind: "unknown";
      readonly knownLevels: 0;
      readonly totalLevels: number;
    }
  | {
      readonly kind: "partial";
      readonly knownLevels: number;
      readonly totalLevels: number;
      readonly sources: readonly number[];
    }
  | {
      readonly kind: "uniform";
      readonly knownLevels: number;
      readonly totalLevels: number;
      readonly source: number;
    }
  | {
      readonly kind: "mixed";
      readonly knownLevels: number;
      readonly totalLevels: number;
      readonly sources: readonly number[];
    };

export interface RouterPageCache {
  readonly key: string;
  readonly resource: "sources" | "destinations";
  readonly addresses: readonly number[];
  readonly nextAfterAddress: number | null;
  readonly totalCount: number;
  readonly version: RouterRouteVersion;
  readonly labelRevision: number;
}

type SharedRouterResyncReason = Extract<
  RouterStateEvent,
  { readonly type: "resync_required" }
>["reason"];

export type RouterResyncReason =
  | SharedRouterResyncReason
  | "revision_gap"
  | "generation_mismatch"
  | "invalid_page";

export type RouterEffect = "none" | "resync" | "reload_pages";

export interface RouterRouteCollection extends ReadonlyArray<RouterDestinationRoute> {
  readonly size: number;
  get(level: number): number | undefined;
}

export interface RouterDestinationRow extends Omit<
  RouterDestinationEntry,
  "routes"
> {
  readonly routes: RouterRouteCollection;
}

export interface RouterRouteIntent {
  readonly matrix: number;
  readonly destination: number;
  readonly level: number;
  readonly source: number;
  readonly canonicalSource: number | null;
  readonly destinationExisted: boolean;
}

export interface RouterLoadedPage {
  readonly query: RouterResourcePageQuery;
  readonly page: RouterResourcePage;
  readonly offset: number;
}

export interface RouterLoadedPages {
  readonly sources: readonly RouterLoadedPage[];
  readonly destinations: readonly RouterLoadedPage[];
}

export interface RouterPageReloads {
  readonly sources: boolean;
  readonly destinations: boolean;
}

export interface RouterState {
  readonly listenerId: RouterSessionBootstrap["listenerId"];
  readonly connectionId: RouterSessionBootstrap["connectionId"];
  readonly lastEventSequence: number;
  readonly version: RouterRouteVersion;
  readonly labelRevision: number;
  readonly transport: RouterSessionBootstrap["transport"];
  readonly sync: RouterSessionBootstrap["sync"];
  readonly labels: RouterSessionBootstrap["labels"];
  readonly requestTimeoutMs: number;
  readonly levels: number;
  readonly extended: boolean;
  readonly knownSourceCount: number;
  readonly knownDestinationCount: number;
  readonly knownCrosspointCount: number;
  readonly sources: ReadonlyMap<number, RouterSourceEntry>;
  readonly destinations: ReadonlyMap<number, RouterDestinationRow>;
  readonly reverseRoutes: ReadonlyMap<
    number,
    ReadonlyMap<number, ReadonlySet<number>>
  >;
  readonly destinationsBySource: ReadonlyMap<number, ReadonlySet<number>>;
  readonly routeIntents: ReadonlyMap<string, RouterRouteIntent>;
  readonly pageCaches: ReadonlyMap<string, RouterPageCache>;
  readonly pages: RouterLoadedPages;
  readonly pageReloads: RouterPageReloads;
  readonly selection: RouterSelections;
  readonly selections: RouterSelections;
  readonly focusedSource: number | null;
  readonly focusedDestination: number | null;
  readonly drafts: readonly RouterDraftMapping[];
  readonly resyncRequired: boolean;
  readonly resyncReason: RouterResyncReason | null;
}

export interface RouterReduction {
  readonly state: RouterState;
  readonly effect: RouterEffect;
}

export type RouterPageMerge = RouterReduction;

export interface StageRouterMappingInput {
  readonly source: number;
  readonly destination: number;
  readonly levels: readonly number[];
}

export interface RouterDraftCounts {
  readonly mappings: number;
  readonly crosspoints: number;
}

export function createRouterState(
  value: unknown,
  retainedDrafts: readonly RouterDraftMapping[] = [],
): RouterState {
  const bootstrap = RouterSessionBootstrapSchema.parse(value);
  const sources = new Map(
    bootstrap.sources.entries.map((entry) => [entry.address, entry]),
  );
  const destinations = new Map(
    bootstrap.destinations.entries.map((entry) => [
      entry.address,
      normalizeDestination(entry),
    ]),
  );
  const pageCaches = new Map<string, RouterPageCache>();
  pageCaches.set(
    pageKey({ resource: "sources", search: null }),
    cacheFromBootstrap("sources", bootstrap.sources),
  );
  pageCaches.set(
    pageKey({
      resource: "destinations",
      search: null,
      source: null,
      levels: [],
    }),
    cacheFromBootstrap("destinations", bootstrap.destinations),
  );

  const drafts = retainedDrafts.map((draft) =>
    restoreDraft(bootstrap, destinations, draft),
  );
  const selection = Object.freeze({ source: null, destination: null });
  const sourceQuery = RouterResourcePageQuerySchema.parse({
    resource: "sources",
    connectionId: bootstrap.connectionId,
    version: bootstrap.version,
    labelRevision: bootstrap.labelRevision,
    afterAddress: null,
    limit: MAX_ROUTER_PAGE_ENTRIES,
    search: null,
  });
  const destinationQuery = RouterResourcePageQuerySchema.parse({
    resource: "destinations",
    connectionId: bootstrap.connectionId,
    version: bootstrap.version,
    labelRevision: bootstrap.labelRevision,
    afterAddress: null,
    limit: MAX_ROUTER_PAGE_ENTRIES,
    search: null,
    source: null,
    levels: [],
  });
  return freezeState({
    listenerId: bootstrap.listenerId,
    connectionId: bootstrap.connectionId,
    lastEventSequence: bootstrap.lastEventSequence,
    version: bootstrap.version,
    labelRevision: bootstrap.labelRevision,
    transport: bootstrap.transport,
    sync: bootstrap.sync,
    labels: bootstrap.labels,
    requestTimeoutMs: bootstrap.requestTimeoutMs,
    levels: bootstrap.levels,
    extended: bootstrap.extended,
    knownSourceCount: bootstrap.knownSourceCount,
    knownDestinationCount: bootstrap.knownDestinationCount,
    knownCrosspointCount: bootstrap.knownCrosspointCount,
    sources,
    destinations,
    reverseRoutes: buildReverseRoutes(destinations),
    destinationsBySource: buildDestinationsBySource(destinations),
    routeIntents: new Map(),
    pageCaches,
    pages: Object.freeze({
      sources: Object.freeze([
        Object.freeze({
          query: sourceQuery,
          page: bootstrap.sources,
          offset: 0,
        }),
      ]),
      destinations: Object.freeze([
        Object.freeze({
          query: destinationQuery,
          page: bootstrap.destinations,
          offset: 0,
        }),
      ]),
    }),
    pageReloads: Object.freeze({ sources: false, destinations: false }),
    selection,
    selections: selection,
    focusedSource: null,
    focusedDestination: null,
    drafts,
    resyncRequired: false,
    resyncReason: null,
  });
}

export function reduceRouterEvent(
  state: RouterState,
  value: unknown,
): RouterReduction {
  if (state.resyncRequired) return reduction(state);

  const rawSequence = readPositiveSequence(value);
  if (rawSequence !== null && rawSequence <= state.lastEventSequence)
    return reduction(state);

  const parsed = SequencedRouterStateEventSchema.safeParse(value);
  if (!parsed.success) return requireResync(state, "invalid_event");
  const message = parsed.data;
  if (message.sequence <= state.lastEventSequence) return reduction(state);
  if (message.sequence !== state.lastEventSequence + 1) {
    return requireResync(state, "sequence_gap");
  }
  if (message.event.type === "resync_required") {
    return requireResync(state, message.event.reason, message.sequence);
  }

  const event = message.event;
  switch (event.type) {
    case "reset":
      return applyReset(state, message.sequence, event);
    case "delta":
      return applyDelta(state, message.sequence, event);
    case "observation":
      return applyObservation(state, message.sequence, event);
    case "intent":
      return applyIntent(state, message.sequence, event);
    case "transport":
      return applyTransport(state, message.sequence, event);
    case "phase":
      return applyPhase(state, message.sequence, event);
    case "label-phase":
      return applyLabelPhase(state, message.sequence, event);
    case "catalog":
      return applyCatalog(state, message.sequence, event);
  }
}

export function mergeRouterPage(
  state: RouterState,
  exchangeValue: unknown,
): RouterPageMerge {
  const rawQuery =
    typeof exchangeValue === "object" &&
    exchangeValue !== null &&
    "query" in exchangeValue
      ? exchangeValue.query
      : undefined;
  const queryResult = RouterResourcePageQuerySchema.safeParse(rawQuery);
  if (!queryResult.success) return requireResync(state, "invalid_page");
  const query = queryResult.data;
  if (
    query.connectionId !== state.connectionId ||
    !versionsEqual(query.version, state.version) ||
    query.labelRevision !== state.labelRevision
  ) {
    return reduction(state);
  }
  if (!queryFitsMode(state, query)) return requireResync(state, "invalid_page");

  const exchange = RouterResourcePageExchangeSchema.safeParse(exchangeValue);
  if (!exchange.success) return requireResync(state, "invalid_page");
  const page = exchange.data.page;
  if (!pageFitsMode(state, page)) return requireResync(state, "invalid_page");
  if (
    page.resource === "destinations" &&
    !destinationPageMatchesLoadedTruth(state, page.entries)
  ) {
    return requireResync(state, "invalid_page");
  }

  const key = pageKey(query);
  const previousCache = state.pageCaches.get(key);
  const addresses =
    query.afterAddress === null || previousCache === undefined
      ? page.entries.map(({ address }) => address)
      : uniqueSorted([
          ...previousCache.addresses,
          ...page.entries.map(({ address }) => address),
        ]);
  const pageCaches = new Map(state.pageCaches);
  pageCaches.set(
    key,
    Object.freeze({
      key,
      resource: page.resource,
      addresses: Object.freeze(addresses),
      nextAfterAddress: page.nextAfterAddress,
      totalCount: page.totalCount,
      version: page.version,
      labelRevision: page.labelRevision,
    }),
  );
  const boundedPageCaches = boundPageCaches(pageCaches);

  if (page.resource === "sources") {
    const sources = new Map(state.sources);
    page.entries.forEach((entry) => sources.set(entry.address, entry));
    const bounded = boundRows(
      sources,
      pinnedSources(state),
      MAX_ROUTER_CACHED_ROWS,
    );
    const pages = appendLoadedPage(state.pages, exchange.data);
    return reduction(
      freezeState({
        ...state,
        sources: bounded,
        pageCaches: boundedPageCaches,
        pages,
        pageReloads: Object.freeze({ ...state.pageReloads, sources: false }),
      }),
    );
  }

  const canonicalDestinations = restoreIntentOverlays(
    state.destinations,
    state.routeIntents,
  );
  page.entries.forEach((entry) => {
    const existing = canonicalDestinations.get(entry.address);
    canonicalDestinations.set(
      entry.address,
      existing === undefined
        ? normalizeDestination(entry)
        : mergeDestination(existing, entry),
    );
  });
  const routeIntents = refreshIntentBaselines(
    state.routeIntents,
    canonicalDestinations,
  );
  const destinations = applyIntentOverlays(canonicalDestinations, routeIntents);
  const bounded = boundDestinationRows(
    destinations,
    pinnedDestinations({ ...state, routeIntents }),
    MAX_ROUTER_CACHED_ROWS,
    MAX_ROUTER_RETAINED_CROSSPOINTS,
  );
  const drafts = reconcileDraftsWithLoadedDestinations(
    state.drafts,
    page.entries
      .map(({ address }) => canonicalDestinations.get(address))
      .filter(isDefined),
    routeIntents,
  );
  return reduction(
    freezeState({
      ...state,
      destinations: bounded,
      reverseRoutes: buildReverseRoutes(bounded),
      destinationsBySource: buildDestinationsBySource(bounded),
      routeIntents,
      pageCaches: boundedPageCaches,
      pages: appendLoadedPage(state.pages, exchange.data),
      pageReloads: Object.freeze({ ...state.pageReloads, destinations: false }),
      drafts,
    }),
  );
}

export function sourceAt(
  state: RouterState,
  destination: number,
  level: number,
): number | null {
  return state.destinations.get(destination)?.routes.get(level) ?? null;
}

export function destinationSummary(
  state: RouterState,
  destination: number,
): RouterDestinationSummary {
  if (state.sync !== "ready") {
    return Object.freeze({
      kind: "unknown",
      knownLevels: 0,
      totalLevels: state.levels,
    });
  }
  const sources = Array.from({ length: state.levels }, (_, index) =>
    sourceAt(state, destination, index + 1),
  ).filter((source): source is number => source !== null);
  if (sources.length === 0) {
    return Object.freeze({
      kind: "unknown",
      knownLevels: 0,
      totalLevels: state.levels,
    });
  }
  const uniqueSources = uniqueSorted(sources);
  if (sources.length < state.levels) {
    return Object.freeze({
      kind: "partial",
      knownLevels: sources.length,
      totalLevels: state.levels,
      sources: Object.freeze(uniqueSources),
    });
  }
  if (uniqueSources.length === 1) {
    return Object.freeze({
      kind: "uniform",
      knownLevels: sources.length,
      totalLevels: state.levels,
      source: uniqueSources[0] as number,
    });
  }
  return Object.freeze({
    kind: "mixed",
    knownLevels: sources.length,
    totalLevels: state.levels,
    sources: Object.freeze(uniqueSources),
  });
}

export function selectSource(
  state: RouterState,
  source: number | null,
): RouterState {
  if (source !== null && !addressFitsMode(state, source)) return state;
  const selection = Object.freeze({ ...state.selection, source });
  return freezeState({
    ...state,
    selection,
    selections: selection,
    focusedSource: source ?? state.focusedSource,
  });
}

export function selectDestination(
  state: RouterState,
  destination: number | null,
): RouterState {
  if (destination !== null && !addressFitsMode(state, destination))
    return state;
  const selection = Object.freeze({ ...state.selection, destination });
  return freezeState({
    ...state,
    selection,
    selections: selection,
    focusedDestination: destination ?? state.focusedDestination,
  });
}

export function clearSelection(state: RouterState): RouterState {
  const selection = Object.freeze({ source: null, destination: null });
  return freezeState({
    ...state,
    selection,
    selections: selection,
  });
}

export function stageMapping(
  state: RouterState,
  input: StageRouterMappingInput,
  idFactory: () => string = randomUuid,
  allowUnassigned = false,
): RouterState {
  const levels = uniqueSorted(input.levels);
  if (
    !routerTruthIsEditable(state) ||
    state.drafts.some((draft) => !draftCanBeEdited(draft)) ||
    !addressFitsMode(state, input.source) ||
    !addressFitsMode(state, input.destination) ||
    levels.length === 0 ||
    levels.length !== input.levels.length ||
    levels.some(
      (level, index) =>
        level !== input.levels[index] || !levelFitsMode(state, level),
    )
  ) {
    return state;
  }
  const batchSource = stagedBatchSource(state.drafts);
  if (batchSource !== null && batchSource !== input.source) return state;
  const mapping = newStagedDraft(
    state,
    { source: input.source, destination: input.destination, levels },
    idFactory,
    allowUnassigned,
  );
  if (mapping === null) return state;
  const drafts = [
    ...state.drafts.filter(
      ({ destination }) => destination !== input.destination,
    ),
    mapping,
  ];
  if (!draftsFitOneTake(drafts)) return state;
  return freezeState({ ...state, drafts: Object.freeze(drafts) });
}

export interface StagedRouteChange {
  readonly destination: number;
  readonly levels: readonly number[];
  /** Null takes these levels back out of what is staged. */
  readonly source: number | null;
}

export type StagedRouteChangeOutcome =
  | "changed"
  | "unchanged"
  /** A Take is running or route truth can't be trusted. */
  | "unavailable"
  | "invalid"
  | "capacity";

/**
 * The source every staged route shares. Null when nothing is staged, or when
 * the Routes sheet has staged routes from different sources.
 */
export function stagedBatchSource(
  drafts: readonly RouterDraftMapping[],
): number | null {
  const source = drafts[0]?.source ?? null;
  return drafts.every((draft) => draft.source === source) ? source : null;
}

/**
 * Applies one Routes sheet gesture to the staged routes, all of it or none of
 * it. Each cell is its own target, so routes may use different sources and one
 * destination may hold different sources on different levels. A level already
 * on the chosen source has nothing to take, so it isn't staged.
 */
export function changeStagedRoutes(
  state: RouterState,
  changes: readonly StagedRouteChange[],
  idFactory: () => string = randomUuid,
  allowUnassigned = false,
): {
  readonly state: RouterState;
  readonly outcome: StagedRouteChangeOutcome;
} {
  const refuse = (outcome: StagedRouteChangeOutcome) => ({ state, outcome });
  if (
    !routerTruthIsEditable(state) ||
    state.drafts.some((draft) => !draftCanBeEdited(draft))
  ) {
    return refuse("unavailable");
  }

  // Later cells in the gesture win, as they would if typed one at a time.
  const wanted = new Map<
    string,
    { destination: number; level: number; source: number | null }
  >();
  for (const { destination, levels, source } of changes) {
    if (
      !addressFitsMode(state, destination) ||
      (source !== null && !addressFitsMode(state, source))
    ) {
      return refuse("invalid");
    }
    for (const level of levels) {
      if (!levelFitsMode(state, level)) return refuse("invalid");
      wanted.set(routeIntentKey(destination, level), {
        destination,
        level,
        source,
      });
    }
  }

  const kept: RouterDraftMapping[] = [];
  let removedLevels = false;
  for (const draft of state.drafts) {
    const levels = draft.levels.filter(
      (level) => !wanted.has(routeIntentKey(draft.destination, level)),
    );
    if (levels.length === draft.levels.length) {
      kept.push(draft);
      continue;
    }
    removedLevels = true;
    if (levels.length > 0) kept.push(draftForLevels(draft, levels));
  }

  const additions = new Map<
    string,
    { destination: number; source: number; levels: number[] }
  >();
  for (const { destination, level, source } of wanted.values()) {
    if (source === null || sourceAt(state, destination, level) === source)
      continue;
    const key = routeIntentKey(destination, source);
    const addition = additions.get(key);
    if (addition === undefined)
      additions.set(key, { destination, source, levels: [level] });
    else addition.levels.push(level);
  }
  if (additions.size === 0 && !removedLevels) return refuse("unchanged");

  // One source on several levels of a destination is one route to Take.
  const drafts: RouterDraftMapping[] = [];
  for (const draft of kept) {
    const addition =
      draft.status === "staged"
        ? additions.get(routeIntentKey(draft.destination, draft.source))
        : undefined;
    if (addition === undefined) drafts.push(draft);
    else addition.levels.push(...draft.levels);
  }
  for (const addition of additions.values()) {
    const draft = newStagedDraft(
      state,
      { ...addition, levels: uniqueSorted(addition.levels) },
      idFactory,
      allowUnassigned,
    );
    if (draft === null) return refuse("invalid");
    drafts.push(draft);
  }
  if (!draftsFitOneTake(drafts)) return refuse("capacity");
  return {
    state: freezeState({ ...state, drafts: Object.freeze(drafts) }),
    outcome: "changed",
  };
}

function newStagedDraft(
  state: RouterState,
  route: {
    readonly source: number;
    readonly destination: number;
    readonly levels: readonly number[];
  },
  idFactory: () => string,
  allowUnassigned: boolean,
): RouterDraftMapping | null {
  const expected = route.levels.map((level) => ({
    level,
    source: sourceAt(state, route.destination, level),
  }));
  if (!allowUnassigned && expected.some(({ source }) => source === null))
    return null;
  const mappingId = RouterMappingIdSchema.safeParse(idFactory());
  if (!mappingId.success) return null;
  return freezeDraft({
    mappingId: mappingId.data,
    source: route.source,
    destination: route.destination,
    levels: route.levels,
    expected,
    baselineGeneration: state.version.generation,
    operationId: null,
    observedDesiredLevels: [],
    observedContradictoryLevels: [],
    targets: expected.map(({ level, source }) => ({
      level,
      expectedSource: source,
      status: "staged" as const,
      dispatchOutcome: null,
    })),
    dispatchDiagnostics: [],
    dispatchOutcomes: [],
    status: "staged",
  });
}

function draftForLevels(
  draft: RouterDraftMapping,
  levels: readonly number[],
): RouterDraftMapping {
  const keep = new Set(levels);
  return withTargetAggregate(
    freezeDraft({
      ...draft,
      levels,
      expected: draft.expected.filter(({ level }) => keep.has(level)),
      observedDesiredLevels: draft.observedDesiredLevels.filter((level) =>
        keep.has(level),
      ),
      observedContradictoryLevels: draft.observedContradictoryLevels.filter(
        (level) => keep.has(level),
      ),
    }),
    draft.targets.filter(({ level }) => keep.has(level)),
    draft.dispatchDiagnostics,
    draft.dispatchOutcomes.filter(({ level }) => keep.has(level)),
  );
}

function draftsFitOneTake(drafts: readonly RouterDraftMapping[]): boolean {
  return (
    drafts.length <= MAX_ROUTER_TAKE_MAPPINGS &&
    drafts.reduce((count, draft) => count + draft.levels.length, 0) <=
      MAX_ROUTER_TAKE_CROSSPOINTS
  );
}

export function clearStaged(state: RouterState): RouterState {
  return freezeState({ ...state, drafts: Object.freeze([]) });
}

export function clearConfirmedDrafts(state: RouterState): RouterState {
  const drafts = state.drafts.filter((draft) => draft.status !== "confirmed");
  return drafts.length === state.drafts.length
    ? state
    : freezeState({ ...state, drafts: Object.freeze(drafts) });
}

export function draftCounts(state: RouterState): RouterDraftCounts {
  return Object.freeze({
    mappings: state.drafts.length,
    crosspoints: state.drafts.reduce(
      (count, draft) => count + draft.levels.length,
      0,
    ),
  });
}

export function replaceStagedSource(
  state: RouterState,
  source: number,
): RouterState {
  if (
    state.drafts.length === 0 ||
    !routerTruthIsEditable(state) ||
    !addressFitsMode(state, source) ||
    state.drafts.every((draft) => draft.source === source) ||
    state.drafts.some((draft) => !draftCanBeEdited(draft))
  ) {
    return state;
  }

  const drafts: RouterDraftMapping[] = [];
  for (const draft of state.drafts) {
    const rebuilt = rebuildStagedDraft(state, draft, source);
    if (rebuilt === null) return state;
    drafts.push(rebuilt);
  }
  return stateWithDrafts(state, drafts);
}

export function removeStagedMapping(
  state: RouterState,
  mappingId: string,
): RouterState {
  const draft = state.drafts.find(
    (candidate) => candidate.mappingId === mappingId,
  );
  if (draft === undefined || !draftCanBeEdited(draft)) return state;
  return stateWithDrafts(
    state,
    state.drafts.filter((candidate) => candidate !== draft),
  );
}

export function rebaseMapping(
  state: RouterState,
  mappingId: string,
): RouterState {
  const index = state.drafts.findIndex(
    (draft) => draft.mappingId === mappingId,
  );
  const draft = state.drafts[index];
  if (
    draft === undefined ||
    draft.status !== "conflict" ||
    !draftCanBeEdited(draft) ||
    !routerTruthIsEditable(state)
  ) {
    return state;
  }
  const rebuilt = rebuildStagedDraft(state, draft, draft.source);
  if (rebuilt === null) return state;
  const drafts = [...state.drafts];
  drafts[index] = rebuilt;
  return stateWithDrafts(state, drafts);
}

export function canTake(state: RouterState): boolean {
  if (
    state.transport !== "connected" ||
    state.sync !== "ready" ||
    state.resyncRequired ||
    state.drafts.length === 0 ||
    state.drafts.length > MAX_ROUTER_TAKE_MAPPINGS
  ) {
    return false;
  }
  let targetCount = 0;
  const targets = new Set<string>();
  for (const draft of state.drafts) {
    if (
      draft.status !== "staged" ||
      draft.baselineGeneration !== state.version.generation
    ) {
      return false;
    }
    for (const expected of draft.expected) {
      targetCount += 1;
      const key = `${String(draft.destination)}:${String(expected.level)}`;
      if (
        targets.has(key) ||
        sourceAt(state, draft.destination, expected.level) !== expected.source
      ) {
        return false;
      }
      targets.add(key);
    }
  }
  return targetCount <= MAX_ROUTER_TAKE_CROSSPOINTS;
}

function routerTruthIsEditable(state: RouterState): boolean {
  return (
    state.transport === "connected" &&
    state.sync === "ready" &&
    !state.resyncRequired
  );
}

function draftCanBeEdited(draft: RouterDraftMapping): boolean {
  return !draft.targets.some(
    ({ status }) => status === "submitting" || status === "pending",
  );
}

function rebuildStagedDraft(
  state: RouterState,
  draft: RouterDraftMapping,
  source: number,
): RouterDraftMapping | null {
  const expected = draft.levels.map((level) => ({
    level,
    source: sourceAt(state, draft.destination, level),
  }));
  // A level may only be empty if it was already empty when this was staged.
  if (
    expected.some(
      ({ level, source: currentSource }) =>
        currentSource === null &&
        draft.expected.find((entry) => entry.level === level)?.source !== null,
    )
  )
    return null;
  const normalizedExpected = expected;
  return freezeDraft({
    ...draft,
    source,
    expected: normalizedExpected,
    baselineGeneration: state.version.generation,
    operationId: null,
    observedDesiredLevels: [],
    observedContradictoryLevels: [],
    targets: normalizedExpected.map(({ level, source: expectedSource }) => ({
      level,
      expectedSource,
      status: "staged",
      dispatchOutcome: null,
    })),
    dispatchDiagnostics: [],
    dispatchOutcomes: [],
    status: "staged",
  });
}

function stateWithDrafts(
  state: RouterState,
  drafts: readonly RouterDraftMapping[],
): RouterState {
  return Object.freeze({ ...state, drafts: Object.freeze([...drafts]) });
}

export function beginTake(
  state: RouterState,
  operationIdValue: string = randomUuid(),
): RouterState {
  if (!canTake(state)) return state;
  const operationId = RouterOperationIdSchema.safeParse(operationIdValue);
  if (!operationId.success) return state;
  const drafts = state.drafts.map((draft) =>
    freezeDraft({
      ...draft,
      operationId: operationId.data,
      observedDesiredLevels: [],
      observedContradictoryLevels: [],
      targets: draft.targets.map((target) => ({
        ...target,
        status: "submitting" as const,
        dispatchOutcome: null,
      })),
      dispatchDiagnostics: [],
      dispatchOutcomes: [],
      status: "submitting",
    }),
  );
  const selection = Object.freeze({ source: null, destination: null });
  return freezeState({
    ...state,
    drafts,
    selection,
    selections: selection,
  });
}

export function applyTakeResult(
  state: RouterState,
  value: unknown,
): RouterState {
  const parsed = RouteCrosspointsResultSchema.safeParse(value);
  if (!parsed.success) return state;
  const result = parsed.data;
  const matching = state.drafts.filter(
    (draft) => draft.operationId === result.operationId,
  );
  if (matching.length === 0) return state;

  const drafts = state.drafts.map((draft) => {
    if (draft.operationId !== result.operationId || draft.status === "stale")
      return draft;
    if (result.status === "rejected") {
      const targets = draft.targets.map((target) => {
        if (target.status === "conflict" || target.status === "stale") {
          return { ...target, dispatchOutcome: result.code };
        }
        return target.status === "confirmed" ||
          draft.observedDesiredLevels.includes(target.level)
          ? {
              ...target,
              status: "confirmed" as const,
              dispatchOutcome: result.code,
            }
          : {
              ...target,
              status: "failed" as const,
              dispatchOutcome: result.code,
            };
      });
      return withTargetAggregate(draft, targets, [result.code]);
    }
    const outcomes = result.outcomes.filter(
      (outcome) => outcome.mappingId === draft.mappingId,
    );
    if (
      outcomes.length !== draft.levels.length ||
      outcomes.some(
        (outcome, index) =>
          outcome.source !== draft.source ||
          outcome.destination !== draft.destination ||
          outcome.level !== draft.levels[index],
      )
    ) {
      return draft;
    }
    const targets = draft.targets.map((target) => {
      const outcome = outcomes.find(
        (candidate) => candidate.level === target.level,
      );
      if (outcome === undefined) return target;
      if (
        target.status === "confirmed" ||
        draft.observedDesiredLevels.includes(target.level)
      ) {
        return {
          ...target,
          status: "confirmed" as const,
          dispatchOutcome: outcome.outcome,
        };
      }
      if (
        target.status === "conflict" ||
        draft.observedContradictoryLevels.includes(target.level)
      ) {
        return {
          ...target,
          status: "conflict" as const,
          dispatchOutcome: outcome.outcome,
        };
      }
      const status: RouterTargetStatus =
        outcome.outcome === "already_confirmed"
          ? "confirmed"
          : outcome.outcome === "acknowledged"
            ? "pending"
            : outcome.outcome === "timeout"
              ? "unconfirmed"
              : outcome.outcome === "conflict"
                ? "conflict"
                : "failed";
      return { ...target, status, dispatchOutcome: outcome.outcome };
    });
    return withTargetAggregate(
      draft,
      targets,
      outcomes.map(({ outcome }) => outcome),
      outcomes.map(({ level, outcome }) => ({ level, outcome })),
    );
  });
  return freezeState({ ...state, drafts });
}

export function markRouterDisconnected(state: RouterState): RouterState {
  const drafts = state.drafts.map(staleInFlightDraft);
  return freezeState({
    ...state,
    transport: "disconnected",
    sync: "stale",
    drafts,
  });
}

function applyReset(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "reset" }>,
): RouterReduction {
  if (
    event.version.generation === state.version.generation ||
    !countsFitMode(
      state,
      event.knownSourceCount,
      event.knownDestinationCount,
      event.knownCrosspointCount,
    )
  ) {
    return requireResync(state, "invalid_event");
  }
  const destinations = new Map<number, RouterDestinationRow>();
  state.destinations.forEach((entry, address) => {
    destinations.set(
      address,
      Object.freeze({ ...entry, routes: routeCollection([]) }),
    );
  });
  const drafts = state.drafts.map((draft) =>
    freezeDraft({
      ...draft,
      operationId: null,
      targets: draft.targets.map((target) => ({
        ...target,
        status: "stale" as const,
      })),
      status: "stale",
    }),
  );
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      version: event.version,
      sync: event.phase,
      knownSourceCount: event.knownSourceCount,
      knownDestinationCount: event.knownDestinationCount,
      knownCrosspointCount: event.knownCrosspointCount,
      destinations,
      reverseRoutes: new Map(),
      destinationsBySource: new Map(),
      routeIntents: new Map(),
      pageCaches: new Map(),
      pages: emptyLoadedPages(),
      pageReloads: Object.freeze({ sources: true, destinations: true }),
      drafts,
    }),
    "reload_pages",
  );
}

function applyDelta(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "delta" }>,
): RouterReduction {
  if (event.generation !== state.version.generation) {
    return requireResync(state, "generation_mismatch");
  }
  if (event.previousRevision !== state.version.revision) {
    return requireResync(state, "revision_gap");
  }
  if (
    !countsFitMode(
      state,
      event.knownSourceCount,
      event.knownDestinationCount,
      event.knownCrosspointCount,
    ) ||
    event.crosspoints.some(
      ({ destination, level, previousSource, source }) =>
        !addressFitsMode(state, destination) ||
        !levelFitsMode(state, level) ||
        !addressFitsMode(state, source) ||
        (previousSource !== null && !addressFitsMode(state, previousSource)),
    )
  ) {
    return requireResync(state, "invalid_event");
  }

  const canonicalDestinations = restoreIntentOverlays(
    state.destinations,
    state.routeIntents,
  );
  const routeIntents = new Map(state.routeIntents);
  let drafts = state.drafts;
  let resolvedIntent = false;
  for (const crosspoint of event.crosspoints) {
    const key = routeIntentKey(crosspoint.destination, crosspoint.level);
    const intent = routeIntents.get(key);
    const entry = canonicalDestinations.get(crosspoint.destination);
    const current =
      intent === undefined
        ? entry?.routes.get(crosspoint.level)
        : intent.canonicalSource;
    if (
      (entry !== undefined || intent !== undefined) &&
      (current ?? null) !== crosspoint.previousSource
    ) {
      return requireResync(state, "invalid_event");
    }
    if (entry !== undefined) {
      canonicalDestinations.set(
        entry.address,
        replaceRoute(entry, crosspoint.level, crosspoint.source),
      );
    } else if (
      intent !== undefined ||
      pinnedDestinations(state).has(crosspoint.destination)
    ) {
      canonicalDestinations.set(
        crosspoint.destination,
        normalizeDestination({
          address: crosspoint.destination,
          label: null,
          routes: [{ level: crosspoint.level, source: crosspoint.source }],
        }),
      );
    }
    if (intent !== undefined) {
      if (intent.source === crosspoint.source) {
        routeIntents.delete(key);
        resolvedIntent = true;
      } else {
        routeIntents.set(
          key,
          Object.freeze({
            ...intent,
            canonicalSource: crosspoint.source,
            destinationExisted: true,
          }),
        );
      }
    }
    drafts = observeDraftTruth(
      drafts,
      crosspoint.destination,
      crosspoint.level,
      crosspoint.source,
    );
  }
  if (resolvedIntent) drafts = removeConfirmedDrafts(drafts);
  const destinations = applyIntentOverlays(canonicalDestinations, routeIntents);
  const boundedDestinations = boundDestinationRows(
    destinations,
    pinnedDestinations({ ...state, routeIntents }),
    MAX_ROUTER_CACHED_ROWS,
    MAX_ROUTER_RETAINED_CROSSPOINTS,
  );
  const version = Object.freeze({
    generation: event.generation,
    revision: event.revision,
  });
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      version,
      knownSourceCount: event.knownSourceCount,
      knownDestinationCount: event.knownDestinationCount,
      knownCrosspointCount: event.knownCrosspointCount,
      destinations: boundedDestinations,
      reverseRoutes: buildReverseRoutes(boundedDestinations),
      destinationsBySource: buildDestinationsBySource(boundedDestinations),
      routeIntents,
      pageCaches: new Map(),
      // Catalog pages carry names and list order; route truth is overlaid from the
      // live destination map. Keep those pages and their reload state stable so a
      // multi-level route burst does not turn every crosspoint into another pair
      // of full catalog queries.
      pages: state.pages,
      pageReloads: state.pageReloads,
      drafts,
    }),
  );
}

function applyObservation(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "observation" }>,
): RouterReduction {
  if (
    !versionsEqual(event.version, state.version) ||
    !addressFitsMode(state, event.crosspoint.destination) ||
    !addressFitsMode(state, event.crosspoint.source) ||
    !levelFitsMode(state, event.crosspoint.level)
  ) {
    return requireResync(state, "invalid_event");
  }
  const canonicalDestinations = restoreIntentOverlays(
    state.destinations,
    state.routeIntents,
  );
  const routeIntents = new Map(state.routeIntents);
  const key = routeIntentKey(
    event.crosspoint.destination,
    event.crosspoint.level,
  );
  const intent = routeIntents.get(key);
  const entry = canonicalDestinations.get(event.crosspoint.destination);
  const current = entry?.routes.get(event.crosspoint.level);
  if (
    intent === undefined &&
    current !== undefined &&
    current !== event.crosspoint.source
  ) {
    return requireResync(state, "invalid_event");
  }
  if (entry !== undefined) {
    canonicalDestinations.set(
      entry.address,
      replaceRoute(entry, event.crosspoint.level, event.crosspoint.source),
    );
  } else if (pinnedDestinations(state).has(event.crosspoint.destination)) {
    canonicalDestinations.set(
      event.crosspoint.destination,
      normalizeDestination({
        address: event.crosspoint.destination,
        label: null,
        routes: [
          {
            level: event.crosspoint.level,
            source: event.crosspoint.source,
          },
        ],
      }),
    );
  }
  const resolvedIntent =
    intent !== undefined && intent.source === event.crosspoint.source;
  if (resolvedIntent) {
    routeIntents.delete(key);
  } else if (intent !== undefined) {
    routeIntents.set(
      key,
      Object.freeze({
        ...intent,
        canonicalSource: event.crosspoint.source,
        destinationExisted: true,
      }),
    );
  }
  const destinations = applyIntentOverlays(canonicalDestinations, routeIntents);
  const boundedDestinations = boundDestinationRows(
    destinations,
    pinnedDestinations({ ...state, routeIntents }),
    MAX_ROUTER_CACHED_ROWS,
    MAX_ROUTER_RETAINED_CROSSPOINTS,
  );
  const observedDrafts = observeDraftTruth(
    state.drafts,
    event.crosspoint.destination,
    event.crosspoint.level,
    event.crosspoint.source,
  );
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      destinations: boundedDestinations,
      reverseRoutes: buildReverseRoutes(boundedDestinations),
      destinationsBySource: buildDestinationsBySource(boundedDestinations),
      routeIntents,
      drafts: resolvedIntent
        ? removeConfirmedDrafts(observedDrafts)
        : observedDrafts,
    }),
  );
}

function applyIntent(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "intent" }>,
): RouterReduction {
  if (
    !versionsEqual(event.version, state.version) ||
    event.crosspoints.some(
      ({ destination, level, source }) =>
        !addressFitsMode(state, destination) ||
        !addressFitsMode(state, source) ||
        !levelFitsMode(state, level),
    )
  ) {
    return requireResync(state, "invalid_event");
  }

  const canonicalDestinations = restoreIntentOverlays(
    state.destinations,
    state.routeIntents,
  );
  const routeIntents = new Map(state.routeIntents);
  let drafts = state.drafts;
  for (const crosspoint of event.crosspoints) {
    const key = routeIntentKey(crosspoint.destination, crosspoint.level);
    const existingIntent = routeIntents.get(key);
    if (event.active) {
      const canonicalDestination = canonicalDestinations.get(
        crosspoint.destination,
      );
      routeIntents.set(
        key,
        Object.freeze({
          matrix: crosspoint.matrix,
          destination: crosspoint.destination,
          level: crosspoint.level,
          source: crosspoint.source,
          canonicalSource:
            existingIntent?.canonicalSource ??
            canonicalDestination?.routes.get(crosspoint.level) ??
            null,
          destinationExisted:
            existingIntent?.destinationExisted ??
            canonicalDestination !== undefined,
        }),
      );
      continue;
    }

    if (existingIntent?.source !== crosspoint.source) continue;
    routeIntents.delete(key);
    drafts = markIntentUnconfirmed(
      drafts,
      crosspoint.destination,
      crosspoint.level,
      crosspoint.source,
    );
  }

  const destinations = applyIntentOverlays(canonicalDestinations, routeIntents);
  const boundedDestinations = boundDestinationRows(
    destinations,
    pinnedDestinations({ ...state, routeIntents }),
    MAX_ROUTER_CACHED_ROWS,
    MAX_ROUTER_RETAINED_CROSSPOINTS,
  );
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      destinations: boundedDestinations,
      reverseRoutes: buildReverseRoutes(boundedDestinations),
      destinationsBySource: buildDestinationsBySource(boundedDestinations),
      routeIntents,
      drafts,
    }),
  );
}

function applyTransport(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "transport" }>,
): RouterReduction {
  if (!versionsEqual(event.version, state.version))
    return requireResync(state, "invalid_event");
  const next = freezeState({
    ...state,
    lastEventSequence: sequence,
    transport: event.phase,
  });
  return reduction(
    event.phase === "connected"
      ? next
      : freezeState({ ...next, drafts: next.drafts.map(staleInFlightDraft) }),
  );
}

function applyPhase(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "phase" }>,
): RouterReduction {
  if (!versionsEqual(event.version, state.version))
    return requireResync(state, "invalid_event");
  const drafts =
    event.phase === "stale"
      ? state.drafts.map((draft) =>
          freezeDraft({
            ...draft,
            targets: draft.targets.map((target) => ({
              ...target,
              status: "stale" as const,
            })),
            status: "stale",
          }),
        )
      : state.drafts;
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      sync: event.phase,
      drafts,
    }),
  );
}

function applyLabelPhase(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "label-phase" }>,
): RouterReduction {
  if (
    !versionsEqual(event.version, state.version) ||
    event.labelRevision < state.labelRevision
  ) {
    return requireResync(state, "invalid_event");
  }
  const revisionChanged = event.labelRevision > state.labelRevision;
  const next = freezeState({
    ...state,
    lastEventSequence: sequence,
    labelRevision: event.labelRevision,
    labels: event.phase,
    pageCaches: revisionChanged ? new Map() : state.pageCaches,
    pages: revisionChanged ? emptyLoadedPages() : state.pages,
    pageReloads: revisionChanged
      ? Object.freeze({ sources: true, destinations: true })
      : state.pageReloads,
  });
  return reduction(next, revisionChanged ? "reload_pages" : "none");
}

function applyCatalog(
  state: RouterState,
  sequence: number,
  event: Extract<RouterStateEvent, { readonly type: "catalog" }>,
): RouterReduction {
  if (
    !versionsEqual(event.version, state.version) ||
    event.labelRevision < state.labelRevision ||
    event.knownSourceCount > addressMaximum(state) ||
    event.knownDestinationCount > addressMaximum(state)
  ) {
    return requireResync(state, "invalid_event");
  }
  const invalidated = [
    ...(event.sourcesChanged ? (["sources"] as const) : []),
    ...(event.destinationsChanged ? (["destinations"] as const) : []),
  ];
  const pageCaches = new Map(state.pageCaches);
  for (const [key, cache] of pageCaches) {
    if (invalidated.includes(cache.resource)) pageCaches.delete(key);
  }
  const pages = Object.freeze({
    sources: event.sourcesChanged ? Object.freeze([]) : state.pages.sources,
    destinations: event.destinationsChanged
      ? Object.freeze([])
      : state.pages.destinations,
  });
  return reduction(
    freezeState({
      ...state,
      lastEventSequence: sequence,
      labelRevision: event.labelRevision,
      knownSourceCount: event.knownSourceCount,
      knownDestinationCount: event.knownDestinationCount,
      pageCaches,
      pages,
      pageReloads: Object.freeze({
        sources: event.sourcesChanged || state.pageReloads.sources,
        destinations:
          event.destinationsChanged || state.pageReloads.destinations,
      }),
    }),
    "reload_pages",
  );
}

function observeDraftTruth(
  drafts: readonly RouterDraftMapping[],
  destination: number,
  level: number,
  source: number,
): readonly RouterDraftMapping[] {
  return drafts.map((draft) => {
    if (draft.destination !== destination || !draft.levels.includes(level))
      return draft;
    const desired = source === draft.source;
    const desiredLevels = new Set(draft.observedDesiredLevels);
    const contradictoryLevels = new Set(draft.observedContradictoryLevels);
    const target = draft.targets.find((candidate) => candidate.level === level);
    if (target === undefined) return draft;
    if (target.status === "staged") {
      const expected = draft.expected.map((candidate) =>
        candidate.level === level ? { ...candidate, source } : candidate,
      );
      const targets = draft.targets.map((candidate) =>
        candidate.level === level
          ? { ...candidate, expectedSource: source, status: "staged" as const }
          : candidate,
      );
      return withTargetAggregate(
        freezeDraft({
          ...draft,
          expected,
        }),
        targets,
        draft.dispatchDiagnostics,
      );
    }
    if (target.status !== "stale") {
      if (desired) {
        desiredLevels.add(level);
        contradictoryLevels.delete(level);
      } else {
        contradictoryLevels.add(level);
        desiredLevels.delete(level);
      }
    }
    const targets = draft.targets.map((candidate) => {
      if (candidate.level !== level) return candidate;
      if (candidate.status === "stale") return candidate;
      if (candidate.status === "submitting") {
        return {
          ...candidate,
          status: desired ? ("submitting" as const) : ("conflict" as const),
        };
      }
      if (desired) {
        return { ...candidate, status: "confirmed" as const };
      }
      return { ...candidate, status: "conflict" as const };
    });
    return withTargetAggregate(
      freezeDraft({
        ...draft,
        observedDesiredLevels: uniqueSorted([...desiredLevels]),
        observedContradictoryLevels: uniqueSorted([...contradictoryLevels]),
      }),
      targets,
      draft.dispatchDiagnostics,
    );
  });
}

function withTargetAggregate(
  draft: RouterDraftMapping,
  targetValues: readonly RouterDraftTarget[],
  diagnostics: readonly string[],
  dispatchOutcomes: readonly {
    readonly level: number;
    readonly outcome: string;
  }[] = draft.dispatchOutcomes,
): RouterDraftMapping {
  const targets = Object.freeze(
    targetValues.map((target) => Object.freeze({ ...target })),
  );
  const statuses = targets.map(({ status }) => status);
  const status: RouterDraftStatus = statuses.includes("conflict")
    ? "conflict"
    : statuses.includes("failed")
      ? "failed"
      : statuses.includes("stale")
        ? "stale"
        : statuses.includes("unconfirmed")
          ? "unconfirmed"
          : statuses.includes("pending")
            ? "pending"
            : statuses.includes("submitting")
              ? "submitting"
              : statuses.every((candidate) => candidate === "confirmed")
                ? "confirmed"
                : "staged";
  return freezeDraft({
    ...draft,
    targets,
    dispatchDiagnostics: Object.freeze([...diagnostics]),
    dispatchOutcomes: Object.freeze(
      dispatchOutcomes.map((outcome) => Object.freeze({ ...outcome })),
    ),
    status,
  });
}

function restoreDraft(
  bootstrap: RouterSessionBootstrap,
  destinations: ReadonlyMap<number, RouterDestinationRow>,
  draft: RouterDraftMapping,
): RouterDraftMapping {
  if (draft.baselineGeneration !== bootstrap.version.generation) {
    return staleDraft(draft);
  }
  const restored = reconcileDraftWithLoadedDestination(
    draft,
    destinations.get(draft.destination),
    "restore",
  );
  return freezeDraft({ ...restored, operationId: null });
}

function reconcileDraftsWithLoadedDestinations(
  drafts: readonly RouterDraftMapping[],
  destinations: readonly RouterDestinationRow[],
  routeIntents: ReadonlyMap<string, RouterRouteIntent> = new Map(),
): readonly RouterDraftMapping[] {
  const byAddress = new Map(
    destinations.map((destination) => [destination.address, destination]),
  );
  return drafts.map((draft) => {
    const destination = byAddress.get(draft.destination);
    return destination === undefined
      ? draft
      : reconcileDraftWithLoadedDestination(
          draft,
          destination,
          "merge",
          routeIntents,
        );
  });
}

function reconcileDraftWithLoadedDestination(
  draft: RouterDraftMapping,
  destination: RouterDestinationRow | undefined,
  mode: "merge" | "restore",
  routeIntents: ReadonlyMap<string, RouterRouteIntent> = new Map(),
): RouterDraftMapping {
  const desiredLevels = new Set(draft.observedDesiredLevels);
  const contradictoryLevels = new Set(draft.observedContradictoryLevels);
  const targets = draft.targets.map((target): RouterDraftTarget => {
    if (routeIntents.has(routeIntentKey(draft.destination, target.level)))
      return target;
    const current = destination?.routes.get(target.level);
    if (
      mode === "restore" &&
      (target.status === "submitting" || target.status === "pending")
    ) {
      return { ...target, status: "stale" };
    }
    if (current === undefined) {
      return mode === "restore" && target.status === "confirmed"
        ? { ...target, status: "stale" }
        : target;
    }
    const desired = current === draft.source;
    if (
      mode === "merge" &&
      target.status !== "staged" &&
      target.status !== "stale"
    ) {
      if (desired) {
        desiredLevels.add(target.level);
        contradictoryLevels.delete(target.level);
      } else {
        contradictoryLevels.add(target.level);
        desiredLevels.delete(target.level);
      }
    }
    switch (target.status) {
      case "staged":
        return current === target.expectedSource
          ? target
          : { ...target, expectedSource: current };
      case "submitting":
        return desired ? target : { ...target, status: "conflict" };
      case "pending":
      case "unconfirmed":
        return desired
          ? { ...target, status: "confirmed" }
          : { ...target, status: "conflict" };
      case "failed":
        return desired
          ? { ...target, status: "confirmed" }
          : mode === "merge"
            ? { ...target, status: "conflict" }
            : target;
      case "confirmed":
        return desired ? target : { ...target, status: "conflict" };
      case "conflict":
        return desired ? { ...target, status: "confirmed" } : target;
      case "stale":
        return target;
    }
  });
  const expected = draft.expected.map((entry) => {
    const target = targets.find((candidate) => candidate.level === entry.level);
    return target?.status === "staged"
      ? { ...entry, source: target.expectedSource }
      : entry;
  });
  return withTargetAggregate(
    freezeDraft({
      ...draft,
      expected,
      observedDesiredLevels: uniqueSorted([...desiredLevels]),
      observedContradictoryLevels: uniqueSorted([...contradictoryLevels]),
    }),
    targets,
    draft.dispatchDiagnostics,
  );
}

function staleDraft(draft: RouterDraftMapping): RouterDraftMapping {
  return freezeDraft({
    ...draft,
    operationId: null,
    targets: draft.targets.map((target) => ({
      ...target,
      status: "stale" as const,
    })),
    status: "stale",
  });
}

function staleInFlightDraft(draft: RouterDraftMapping): RouterDraftMapping {
  const shouldStale = draft.targets.some(
    ({ status }) =>
      status === "submitting" ||
      status === "pending" ||
      status === "unconfirmed",
  );
  if (!shouldStale) return draft;
  const targets = draft.targets.map((target) => {
    if (
      target.status !== "submitting" &&
      target.status !== "pending" &&
      target.status !== "unconfirmed"
    ) {
      return target;
    }
    return { ...target, status: "stale" as const };
  });
  return withTargetAggregate(
    freezeDraft({ ...draft, operationId: null }),
    targets,
    draft.dispatchDiagnostics,
  );
}

function markIntentUnconfirmed(
  drafts: readonly RouterDraftMapping[],
  destination: number,
  level: number,
  source: number,
): readonly RouterDraftMapping[] {
  return drafts.map((draft) => {
    if (draft.destination !== destination || draft.source !== source)
      return draft;
    const target = draft.targets.find((candidate) => candidate.level === level);
    if (target?.status !== "pending") return draft;
    return withTargetAggregate(
      draft,
      draft.targets.map((candidate) =>
        candidate.level === level
          ? { ...candidate, status: "unconfirmed" as const }
          : candidate,
      ),
      draft.dispatchDiagnostics,
    );
  });
}

function removeConfirmedDrafts(
  drafts: readonly RouterDraftMapping[],
): readonly RouterDraftMapping[] {
  return drafts.filter((draft) => draft.status !== "confirmed");
}

function replaceRoute(
  entry: RouterDestinationRow,
  level: number,
  source: number,
): RouterDestinationRow {
  return Object.freeze({
    ...entry,
    routes: routeCollection(
      [
        ...entry.routes.filter((route) => route.level !== level),
        { level, source },
      ].sort((left, right) => left.level - right.level),
    ),
  });
}

function removeRoute(
  entry: RouterDestinationRow,
  level: number,
): RouterDestinationRow {
  return Object.freeze({
    ...entry,
    routes: routeCollection(
      entry.routes.filter((route) => route.level !== level),
    ),
  });
}

function normalizeDestination(
  entry: RouterDestinationEntry,
): RouterDestinationRow {
  return Object.freeze({ ...entry, routes: routeCollection(entry.routes) });
}

function restoreIntentOverlays(
  displayed: ReadonlyMap<number, RouterDestinationRow>,
  intents: ReadonlyMap<string, RouterRouteIntent>,
): Map<number, RouterDestinationRow> {
  const destinations = new Map(displayed);
  for (const intent of intents.values()) {
    const entry = destinations.get(intent.destination);
    if (intent.canonicalSource !== null) {
      destinations.set(
        intent.destination,
        entry === undefined
          ? normalizeDestination({
              address: intent.destination,
              label: null,
              routes: [{ level: intent.level, source: intent.canonicalSource }],
            })
          : replaceRoute(entry, intent.level, intent.canonicalSource),
      );
      continue;
    }
    if (entry === undefined) continue;
    const restored = removeRoute(entry, intent.level);
    if (
      !intent.destinationExisted &&
      restored.routes.length === 0 &&
      restored.label === null
    ) {
      destinations.delete(intent.destination);
    } else {
      destinations.set(intent.destination, restored);
    }
  }
  return destinations;
}

function applyIntentOverlays(
  canonical: ReadonlyMap<number, RouterDestinationRow>,
  intents: ReadonlyMap<string, RouterRouteIntent>,
): Map<number, RouterDestinationRow> {
  const destinations = new Map(canonical);
  for (const intent of intents.values()) {
    const entry = destinations.get(intent.destination);
    destinations.set(
      intent.destination,
      entry === undefined
        ? normalizeDestination({
            address: intent.destination,
            label: null,
            routes: [{ level: intent.level, source: intent.source }],
          })
        : replaceRoute(entry, intent.level, intent.source),
    );
  }
  return destinations;
}

function refreshIntentBaselines(
  intents: ReadonlyMap<string, RouterRouteIntent>,
  canonical: ReadonlyMap<number, RouterDestinationRow>,
): ReadonlyMap<string, RouterRouteIntent> {
  return new Map(
    [...intents].map(([key, intent]) => {
      const destination = canonical.get(intent.destination);
      return [
        key,
        Object.freeze({
          ...intent,
          canonicalSource: destination?.routes.get(intent.level) ?? null,
          destinationExisted: destination !== undefined,
        }),
      ];
    }),
  );
}

function routeCollection(
  routesValue: readonly RouterDestinationRoute[],
): RouterRouteCollection {
  const routes = routesValue.map((route) => Object.freeze({ ...route }));
  Object.defineProperties(routes, {
    get: {
      enumerable: false,
      value(level: number): number | undefined {
        return routes.find((route) => route.level === level)?.source;
      },
    },
    size: {
      enumerable: false,
      get(): number {
        return routes.length;
      },
    },
  });
  return Object.freeze(routes) as RouterRouteCollection;
}

function buildDestinationsBySource(
  destinations: ReadonlyMap<number, RouterDestinationRow>,
): ReadonlyMap<number, ReadonlySet<number>> {
  const mutable = new Map<number, Set<number>>();
  destinations.forEach((entry) => {
    entry.routes.forEach(({ source }) => {
      const addresses = mutable.get(source) ?? new Set<number>();
      addresses.add(entry.address);
      mutable.set(source, addresses);
    });
  });
  return new Map(
    [...mutable].map(([source, addresses]) => [
      source,
      new Set(addresses) as ReadonlySet<number>,
    ]),
  );
}

function buildReverseRoutes(
  destinations: ReadonlyMap<number, RouterDestinationRow>,
): ReadonlyMap<number, ReadonlyMap<number, ReadonlySet<number>>> {
  const mutable = new Map<number, Map<number, Set<number>>>();
  destinations.forEach((entry) => {
    entry.routes.forEach(({ level, source }) => {
      const levels = mutable.get(source) ?? new Map<number, Set<number>>();
      const addresses = levels.get(level) ?? new Set<number>();
      addresses.add(entry.address);
      levels.set(level, addresses);
      mutable.set(source, levels);
    });
  });
  return new Map(
    [...mutable].map(([source, levels]) => [
      source,
      new Map(
        [...levels].map(([level, addresses]) => [
          level,
          new Set(addresses) as ReadonlySet<number>,
        ]),
      ),
    ]),
  );
}

function queryFitsMode(
  state: RouterState,
  query: RouterResourcePageQuery,
): boolean {
  if (
    query.afterAddress !== null &&
    !addressFitsMode(state, query.afterAddress)
  )
    return false;
  if (query.resource === "sources") return true;
  return (
    (query.source === null || addressFitsMode(state, query.source)) &&
    query.levels.every((level) => levelFitsMode(state, level))
  );
}

function pageFitsMode(state: RouterState, page: RouterResourcePage): boolean {
  if (page.totalCount > addressMaximum(state)) return false;
  if (page.resource === "sources") {
    return page.entries.every(({ address }) => addressFitsMode(state, address));
  }
  return page.entries.every(
    ({ address, routes }) =>
      addressFitsMode(state, address) &&
      routes.every(
        ({ level, source }) =>
          levelFitsMode(state, level) && addressFitsMode(state, source),
      ),
  );
}

function destinationPageMatchesLoadedTruth(
  state: RouterState,
  entries: readonly RouterDestinationEntry[],
): boolean {
  return entries.every((entry) => {
    const existing = state.destinations.get(entry.address);
    if (existing === undefined) return true;
    return entry.routes.every(({ level, source }) => {
      const intent = state.routeIntents.get(
        routeIntentKey(entry.address, level),
      );
      const loadedSource =
        intent === undefined
          ? existing.routes.get(level)
          : intent.canonicalSource;
      return (
        loadedSource === undefined ||
        loadedSource === null ||
        loadedSource === source
      );
    });
  });
}

function mergeDestination(
  existing: RouterDestinationRow,
  incoming: RouterDestinationEntry,
): RouterDestinationRow {
  const routes = new Map(existing.routes.map((route) => [route.level, route]));
  incoming.routes.forEach((route) => routes.set(route.level, route));
  return Object.freeze({
    address: incoming.address,
    label: incoming.label,
    routes: routeCollection(
      [...routes.values()].sort((left, right) => left.level - right.level),
    ),
  });
}

function appendLoadedPage(
  pages: RouterLoadedPages,
  exchange: RouterResourcePageExchange,
): RouterLoadedPages {
  const resourcePages =
    exchange.query.resource === "sources" ? pages.sources : pages.destinations;
  const record = Object.freeze({
    query: exchange.query,
    page: exchange.page,
    offset: loadedPageOffset(resourcePages, exchange.query),
  });
  const key = loadedPageKey(exchange.query);
  const retainedPages = (
    loaded: readonly RouterLoadedPage[],
  ): readonly RouterLoadedPage[] =>
    loaded.filter(({ query }) =>
      exchange.query.afterAddress === null
        ? pageKey(query) !== pageKey(exchange.query)
        : loadedPageKey(query) !== key,
    );
  if (exchange.query.resource === "sources") {
    const sources = [...retainedPages(pages.sources), record].slice(
      -MAX_ROUTER_CACHED_PAGES_PER_RESOURCE,
    );
    return Object.freeze({
      sources: Object.freeze(sources),
      destinations: pages.destinations,
    });
  }
  const destinations = boundDestinationPages(
    [...retainedPages(pages.destinations), record],
    MAX_ROUTER_CACHED_PAGES_PER_RESOURCE,
    MAX_ROUTER_RETAINED_CROSSPOINTS,
  );
  return Object.freeze({
    sources: pages.sources,
    destinations: Object.freeze(destinations),
  });
}

function boundDestinationPages(
  pages: readonly RouterLoadedPage[],
  maximumPages: number,
  maximumCrosspoints: number,
): readonly RouterLoadedPage[] {
  const newestFirst: RouterLoadedPage[] = [];
  let retainedCrosspoints = 0;
  for (
    let index = pages.length - 1;
    index >= 0 && newestFirst.length < maximumPages;
    index -= 1
  ) {
    const page = pages[index];
    if (page === undefined) continue;
    const pageCrosspoints = page.page.entries.reduce(
      (count, entry) => count + ("routes" in entry ? entry.routes.length : 0),
      0,
    );
    if (
      newestFirst.length > 0 &&
      retainedCrosspoints + pageCrosspoints > maximumCrosspoints
    ) {
      break;
    }
    newestFirst.push(page);
    retainedCrosspoints += pageCrosspoints;
  }
  return newestFirst.reverse();
}

function loadedPageOffset(
  pages: readonly RouterLoadedPage[],
  query: RouterResourcePageQuery,
): number {
  if (query.afterAddress === null) return 0;
  const baseKey = pageKey(query);
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const previous = pages[index];
    if (
      previous !== undefined &&
      pageKey(previous.query) === baseKey &&
      previous.page.nextAfterAddress === query.afterAddress
    ) {
      return previous.offset + previous.page.entries.length;
    }
  }
  return 0;
}

function loadedPageKey(query: RouterResourcePageQuery): string {
  return `${pageKey(query)}:${String(query.afterAddress ?? "")}:${String(query.limit)}`;
}

function emptyLoadedPages(): RouterLoadedPages {
  return Object.freeze({
    sources: Object.freeze([]),
    destinations: Object.freeze([]),
  });
}

function pageKey(
  query:
    | RouterResourcePageQuery
    | Readonly<{
        resource: "sources";
        search: string | null;
      }>
    | Readonly<{
        resource: "destinations";
        search: string | null;
        source: number | null;
        levels: readonly number[];
      }>,
): string {
  return query.resource === "sources"
    ? `sources:${query.search ?? ""}`
    : `destinations:${query.search ?? ""}:${String(query.source ?? "")}:${query.levels.join(",")}`;
}

function cacheFromBootstrap(
  resource: "sources" | "destinations",
  page:
    | RouterSessionBootstrap["sources"]
    | RouterSessionBootstrap["destinations"],
): RouterPageCache {
  const key =
    resource === "sources"
      ? pageKey({ resource, search: null })
      : pageKey({ resource, search: null, source: null, levels: [] });
  return Object.freeze({
    key,
    resource,
    addresses: Object.freeze(page.entries.map(({ address }) => address)),
    nextAfterAddress: page.nextAfterAddress,
    totalCount: page.totalCount,
    version: page.version,
    labelRevision: page.labelRevision,
  });
}

function pinnedSources(state: RouterState): ReadonlySet<number> {
  return new Set([
    ...(state.selections.source === null ? [] : [state.selections.source]),
    ...(state.focusedSource === null ? [] : [state.focusedSource]),
    ...state.drafts.map(({ source }) => source),
    ...[...state.routeIntents.values()].flatMap(
      ({ source, canonicalSource }) => [
        source,
        ...(canonicalSource === null ? [] : [canonicalSource]),
      ],
    ),
  ]);
}

function pinnedDestinations(state: RouterState): ReadonlySet<number> {
  return new Set([
    ...(state.selections.destination === null
      ? []
      : [state.selections.destination]),
    ...(state.focusedDestination === null ? [] : [state.focusedDestination]),
    ...state.drafts.map(({ destination }) => destination),
    ...[...state.routeIntents.values()].map(({ destination }) => destination),
  ]);
}

function boundRows<T>(
  rows: ReadonlyMap<number, T>,
  pinned: ReadonlySet<number>,
  maximum: number,
): ReadonlyMap<number, T> {
  if (rows.size <= maximum) return new Map(rows);
  const bounded = new Map(rows);
  for (const address of bounded.keys()) {
    if (bounded.size <= maximum) break;
    if (!pinned.has(address)) bounded.delete(address);
  }
  return bounded;
}

function boundDestinationRows(
  rows: ReadonlyMap<number, RouterDestinationRow>,
  pinned: ReadonlySet<number>,
  maximumRows: number,
  maximumCrosspoints: number,
): ReadonlyMap<number, RouterDestinationRow> {
  const bounded = new Map(rows);
  let retainedCrosspoints = destinationRouteCount(bounded);
  if (bounded.size <= maximumRows && retainedCrosspoints <= maximumCrosspoints)
    return bounded;

  for (const [address, destination] of bounded) {
    if (
      bounded.size <= maximumRows &&
      retainedCrosspoints <= maximumCrosspoints
    )
      break;
    if (pinned.has(address)) continue;
    bounded.delete(address);
    retainedCrosspoints -= destination.routes.length;
  }
  return bounded;
}

function destinationRouteCount(
  destinations: ReadonlyMap<number, RouterDestinationRow>,
): number {
  let count = 0;
  destinations.forEach((destination) => {
    count += destination.routes.length;
  });
  return count;
}

function boundPageCaches(
  caches: ReadonlyMap<string, RouterPageCache>,
): ReadonlyMap<string, RouterPageCache> {
  const bounded = new Map(caches);
  const maximum = MAX_ROUTER_CACHED_PAGES_PER_RESOURCE * 2;
  while (bounded.size > maximum) {
    const oldestKey = bounded.keys().next().value;
    if (oldestKey === undefined) break;
    bounded.delete(oldestKey);
  }
  return bounded;
}

function countsFitMode(
  state: RouterState,
  sourceCount: number,
  destinationCount: number,
  crosspointCount: number,
): boolean {
  return (
    sourceCount <= addressMaximum(state) &&
    destinationCount <= addressMaximum(state) &&
    crosspointCount <= destinationCount * state.levels
  );
}

function addressFitsMode(
  state: Pick<RouterState, "extended">,
  address: number,
): boolean {
  return (
    Number.isInteger(address) &&
    address >= 1 &&
    address <= addressMaximum(state)
  );
}

function addressMaximum(state: Pick<RouterState, "extended">): number {
  return state.extended
    ? EXTENDED_ROUTER_ADDRESS_MAX
    : STANDARD_ROUTER_ADDRESS_MAX;
}

function levelFitsMode(
  state: Pick<RouterState, "levels">,
  level: number,
): boolean {
  return Number.isInteger(level) && level >= 1 && level <= state.levels;
}

function requireResync(
  state: RouterState,
  reason: RouterResyncReason,
  sequence = state.lastEventSequence,
): RouterReduction {
  const drafts = state.drafts.map(staleDraft);
  const next = freezeState({
    ...state,
    lastEventSequence: sequence,
    resyncRequired: true,
    resyncReason: reason,
    sync: "stale",
    drafts,
  });
  return reduction(next, "resync");
}

function reduction(
  state: RouterState,
  effect: RouterEffect = "none",
): RouterReduction {
  return Object.freeze({ state, effect });
}

function freezeState(state: RouterState): RouterState {
  const selection = Object.freeze({ ...state.selection });
  return Object.freeze({
    ...state,
    sources: new Map(state.sources),
    destinations: new Map(state.destinations),
    reverseRoutes: new Map(
      [...state.reverseRoutes].map(([source, levels]) => [
        source,
        new Map(
          [...levels].map(([level, destinations]) => [
            level,
            new Set(destinations),
          ]),
        ),
      ]),
    ),
    destinationsBySource: new Map(state.destinationsBySource),
    routeIntents: new Map(
      [...state.routeIntents].map(([key, intent]) => [
        key,
        Object.freeze({ ...intent }),
      ]),
    ),
    pageCaches: new Map(state.pageCaches),
    pages: Object.freeze({
      sources: Object.freeze([...state.pages.sources]),
      destinations: Object.freeze([...state.pages.destinations]),
    }),
    pageReloads: Object.freeze({ ...state.pageReloads }),
    selection,
    selections: selection,
    drafts: Object.freeze(state.drafts.map(freezeDraft)),
  });
}

function freezeDraft(draft: RouterDraftMapping): RouterDraftMapping {
  return Object.freeze({
    ...draft,
    levels: Object.freeze([...draft.levels]),
    expected: Object.freeze(
      draft.expected.map((entry) => Object.freeze({ ...entry })),
    ),
    observedDesiredLevels: Object.freeze([...draft.observedDesiredLevels]),
    observedContradictoryLevels: Object.freeze([
      ...draft.observedContradictoryLevels,
    ]),
    targets: Object.freeze(
      draft.targets.map((target) => Object.freeze({ ...target })),
    ),
    dispatchDiagnostics: Object.freeze([...draft.dispatchDiagnostics]),
    dispatchOutcomes: Object.freeze(
      draft.dispatchOutcomes.map((outcome) => Object.freeze({ ...outcome })),
    ),
  });
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function versionsEqual(
  left: RouterRouteVersion,
  right: RouterRouteVersion,
): boolean {
  return (
    left.generation === right.generation && left.revision === right.revision
  );
}

function routeIntentKey(destination: number, level: number): string {
  return `${String(destination)}:${String(level)}`;
}

function readPositiveSequence(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("sequence" in value))
    return null;
  const sequence = value.sequence;
  return Number.isSafeInteger(sequence) && Number(sequence) > 0
    ? Number(sequence)
    : null;
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}
