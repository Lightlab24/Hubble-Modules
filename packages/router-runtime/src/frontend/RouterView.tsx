import {
  AlertTriangle,
  Cable,
  Check,
  CircleDashed,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unplug,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ConnectionView } from "./connection-view.js";
import {
  MAX_ROUTER_BOOTSTRAP_CROSSPOINTS,
  MAX_ROUTER_PAGE_ENTRIES,
  MAX_ROUTER_SEARCH_LENGTH,
  type RouterDestinationEntry,
  type RouterSourceEntry,
} from "../page-contract.js";
import {
  connectionPresentationLabel,
  connectionPresentationStatus,
} from "./connection-view.js";
import {
  canTake,
  draftCounts,
  sourceAt,
  type RouterDraftMapping,
  type RouterLoadedPage,
  type RouterState,
} from "./router-state.js";
import {
  MAXIMUM_ROUTER_VIEW_ZOOM,
  MINIMUM_ROUTER_VIEW_ZOOM,
  loadRouterViewZoom,
  resetRouterViewZoom,
  resolveRouterViewZoomShortcut,
  saveRouterViewZoom,
  stepRouterViewZoom,
  type RouterViewZoom,
  type RouterViewZoomDirection,
} from "./router-view-zoom.js";
import type { RouterConnection } from "./use-router-state.js";
import {
  VirtualRouterList,
  type VirtualRouterSelectionGesture,
} from "./VirtualRouterList.js";
import "./router.css";
import { routerZoomStorage } from "./zoom-storage.js";

const ROUTER_PAGE_SIZE = MAX_ROUTER_PAGE_ENTRIES;
const ROUTER_FILTER_REFRESH_DELAY_MS = 50;
const ROUTER_SEARCH_DELAY_MS = 50;
const ROUTER_SOURCE_ROW_HEIGHT = 44;
const ROUTER_DESTINATION_ROW_HEIGHT = 36;
const ROUTER_LIST_OVERSCAN = 6;

type OperatingRouterConnectionView =
  | Extract<
      ConnectionView,
      { readonly type: "ross-ultrix-ogp" | "evertz-quartz" }
    >
  | Extract<
      ConnectionView,
      { readonly type: "blackmagic-videohub" | "aja-kumo" }
    >;

export interface RouterViewProps {
  readonly connections: readonly ConnectionView[];
  readonly selectedConnectionId: string | null;
  readonly onConnectionChange: (connectionId: string) => void;
  readonly onRefreshRouterNames?: () => void;
  readonly refreshingRouterNames?: boolean;
  readonly router: RouterConnection;
}

interface RouterListModel<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
  readonly hasPage: boolean;
  readonly hasMore: boolean;
  readonly itemOffset: number;
  readonly nextAfterAddress: number | null;
}

type RouterPageLoadPhase = "idle" | "loading" | "failed";

interface RouterPageLoadState {
  readonly afterAddress: number | null;
  readonly identity: string;
  readonly phase: RouterPageLoadPhase;
}

interface RouterRouteDeltaEndpoint {
  readonly address: number;
  readonly name: string;
}

interface SourceRouteDelta {
  readonly additions: readonly RouterRouteDeltaEndpoint[];
  readonly removals: readonly RouterRouteDeltaEndpoint[];
}

export function RouterView({
  connections,
  selectedConnectionId,
  onConnectionChange,
  onRefreshRouterNames = () => undefined,
  refreshingRouterNames = false,
  router,
}: RouterViewProps): React.JSX.Element {
  const [routerViewZoom, setRouterViewZoom] = useState<RouterViewZoom>(() =>
    loadRouterViewZoom(routerZoomStorage),
  );
  const routerConnections = useMemo(
    () => connections.filter(isEnabledOperatingRouterConnection),
    [connections],
  );
  const selectedConnection = routerConnections.find(
    ({ connectionId }) => connectionId === selectedConnectionId,
  );
  const state =
    selectedConnection === undefined ||
    router.state?.connectionId !== selectedConnection.connectionId
      ? null
      : router.state;

  useEffect(() => {
    if (selectedConnectionId === null && routerConnections.length === 1) {
      const soleConnection = routerConnections[0];
      if (soleConnection !== undefined)
        onConnectionChange(soleConnection.connectionId);
    }
  }, [onConnectionChange, routerConnections, selectedConnectionId]);

  useEffect(() => {
    saveRouterViewZoom(routerZoomStorage, routerViewZoom);
  }, [routerViewZoom]);

  useEffect(() => {
    const handleRouterViewZoomShortcut = (event: KeyboardEvent): void => {
      const shortcut = resolveRouterViewZoomShortcut(event);
      if (shortcut === null) return;

      event.preventDefault();
      event.stopPropagation();
      setRouterViewZoom((current) =>
        shortcut === "reset"
          ? resetRouterViewZoom()
          : stepRouterViewZoom(current, shortcut),
      );
    };

    window.addEventListener("keydown", handleRouterViewZoomShortcut, true);
    return () => {
      window.removeEventListener("keydown", handleRouterViewZoomShortcut, true);
    };
  }, []);

  const changeRouterViewZoom = useCallback(
    (direction: RouterViewZoomDirection): void => {
      setRouterViewZoom((current) => stepRouterViewZoom(current, direction));
    },
    [],
  );

  const refreshEnabled =
    state !== null &&
    state.selection.destination !== null &&
    state.transport === "connected" &&
    state.sync === "ready" &&
    !state.resyncRequired;

  return (
    <section
      id="hubble-router-panel"
      className="router-view"
      aria-label="Router"
      aria-labelledby="hubble-router-tab"
      data-router-zoom={routerViewZoom}
      style={
        {
          "--router-view-zoom": String(routerViewZoom / 100),
        } as CSSProperties
      }
    >
      <header className="router-header">
        <div className="router-title-block">
          <span className="router-eyebrow">
            {selectedConnection?.type === "blackmagic-videohub" ||
            selectedConnection?.type === "aja-kumo"
              ? selectedConnection.type === "aja-kumo"
                ? "AJA KUMO operating view"
                : "Blackmagic Videohub operating view"
              : selectedConnection?.type === "ross-ultrix-ogp" ||
                  selectedConnection?.type === "evertz-quartz"
                ? selectedConnection.type === "evertz-quartz"
                  ? "Evertz Quartz operating view"
                  : "Ross Ultrix OGP operating view"
                : "Router operating view"}
          </span>
          <h2>Router</h2>
          {selectedConnection?.type === "ross-ultrix-ogp" ||
          selectedConnection?.type === "evertz-quartz" ? (
            <span
              className="router-scope-summary"
              aria-label={
                selectedConnection.type === "evertz-quartz"
                  ? "Configured Quartz range"
                  : "Configured OGP range"
              }
              title={`Watching sources 1–${String(selectedConnection.sourceLimit)}, destinations 1–${String(selectedConnection.destinationLimit)}, levels 1–${String(selectedConnection.levels)}`}
            >
              Sources 1–{selectedConnection.sourceLimit} · Destinations 1–
              {selectedConnection.destinationLimit} · Levels 1–
              {selectedConnection.levels}
            </span>
          ) : selectedConnection?.type === "blackmagic-videohub" ||
            selectedConnection?.type === "aja-kumo" ? (
            <VideohubScopeSummary
              connection={selectedConnection}
              state={state}
            />
          ) : null}
        </div>

        <label className="router-connection-control">
          <span>Router connection</span>
          <select
            aria-label="Router connection"
            value={selectedConnection?.connectionId ?? ""}
            disabled={routerConnections.length === 0}
            onChange={(event) => {
              if (event.currentTarget.value !== "")
                onConnectionChange(event.currentTarget.value);
            }}
          >
            <option value="" disabled>
              Choose connection
            </option>
            {routerConnections.map((connection) => (
              <option
                key={connection.connectionId}
                value={connection.connectionId}
              >
                {connection.name}
              </option>
            ))}
          </select>
        </label>

        <RouterPhaseStatus state={state} status={router.status} />

        <RouterZoomControl
          value={routerViewZoom}
          onChange={changeRouterViewZoom}
          onReset={() => {
            setRouterViewZoom(resetRouterViewZoom());
          }}
        />

        <button
          className="router-control-button router-header-action"
          type="button"
          aria-label="Refresh router names"
          title="Refresh router names"
          aria-busy={refreshingRouterNames}
          disabled={routerConnections.length === 0 || refreshingRouterNames}
          onClick={onRefreshRouterNames}
        >
          <RefreshCw
            aria-hidden="true"
            data-spinning={refreshingRouterNames}
            size={14}
            strokeWidth={1.8}
          />
          <span className="router-header-action-label">
            Refresh router names
          </span>
        </button>

        <button
          className="router-control-button router-header-action router-refresh-button"
          type="button"
          aria-label="Refresh selected destinations"
          title="Refresh selected destinations"
          disabled={!refreshEnabled}
          onClick={() => {
            router.refreshSelectedDestinations();
          }}
        >
          <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
          <span className="router-header-action-label">
            Refresh selected destinations
          </span>
        </button>
      </header>

      <RouterBody
        connectionCount={routerConnections.length}
        selectedConnection={selectedConnection}
        router={router}
        state={state}
      />
    </section>
  );
}

function RouterZoomControl({
  onChange,
  onReset,
  value,
}: {
  readonly onChange: (direction: RouterViewZoomDirection) => void;
  readonly onReset: () => void;
  readonly value: RouterViewZoom;
}): React.JSX.Element {
  return (
    <div className="router-zoom-control" role="group" aria-label="Router zoom">
      <button
        type="button"
        aria-label="Zoom out of Router"
        title="Zoom out (⌘− / Ctrl−)"
        disabled={value <= MINIMUM_ROUTER_VIEW_ZOOM}
        onClick={() => {
          onChange("decrease");
        }}
      >
        <Minus aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
      <button
        className="router-zoom-reset"
        type="button"
        aria-label="Reset Router zoom to 100%"
        title="Reset zoom to 100% (⌘0 / Ctrl0)"
        onClick={onReset}
      >
        <output aria-label="Router zoom value" aria-live="polite">
          {value}%
        </output>
      </button>
      <button
        type="button"
        aria-label="Zoom in to Router"
        title="Zoom in (⌘+ / Ctrl+)"
        disabled={value >= MAXIMUM_ROUTER_VIEW_ZOOM}
        onClick={() => {
          onChange("increase");
        }}
      >
        <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function RouterBody({
  connectionCount,
  selectedConnection,
  router,
  state,
}: {
  readonly connectionCount: number;
  readonly selectedConnection: OperatingRouterConnectionView | undefined;
  readonly router: RouterConnection;
  readonly state: RouterState | null;
}): React.JSX.Element {
  if (connectionCount === 0) {
    return (
      <RouterEmptyState icon="unplugged" title="No Router connection available">
        Add or enable a router module in Module Connections for this workspace
        to view and patch routes.
      </RouterEmptyState>
    );
  }

  if (selectedConnection === undefined) {
    return (
      <RouterEmptyState icon="cable" title="Choose a Router connection">
        Select an enabled router connection to open its bounded route stream.
      </RouterEmptyState>
    );
  }

  if (router.status === "failed") {
    return (
      <RouterEmptyState icon="warning" title="Router stream unavailable">
        The route stream could not be opened. Confirm the connection, then
        retry.
        <button
          className="router-control-button"
          type="button"
          onClick={() => {
            router.reconnect();
          }}
        >
          Retry Router connection
        </button>
      </RouterEmptyState>
    );
  }

  if (state === null || router.status === "connecting") {
    return (
      <RouterEmptyState icon="loading" title="Opening Router stream">
        Loading bounded source, destination, and route indexes.
      </RouterEmptyState>
    );
  }

  return (
    <RouterWorkspace
      key={state.connectionId}
      destinationLocks={
        selectedConnection.type === "evertz-quartz"
          ? selectedConnection.destinationLocks
          : undefined
      }
      router={router}
      showsLevels={
        selectedConnection.type !== "blackmagic-videohub" &&
        selectedConnection.type !== "aja-kumo"
      }
      state={state}
    />
  );
}

function VideohubScopeSummary({
  connection,
  state,
}: {
  readonly connection: Extract<
    ConnectionView,
    { readonly type: "blackmagic-videohub" | "aja-kumo" }
  >;
  readonly state: RouterState | null;
}): React.JSX.Element {
  const sourceCount = videohubScopeCount(
    connection.effectiveSourceCount,
    connection.detectedSourceCount,
    connection.sourceLimit ?? null,
    state?.knownSourceCount ?? 0,
  );
  const destinationCount = videohubScopeCount(
    connection.effectiveDestinationCount,
    connection.detectedDestinationCount,
    connection.destinationLimit ?? null,
    state?.knownDestinationCount ?? 0,
  );
  const sourceScope = routerScopeLabel("Sources", sourceCount);
  const destinationScope = routerScopeLabel("Destinations", destinationCount);
  const modelName = connection.modelName ?? "Blackmagic Videohub";

  return (
    <span
      className="router-scope-summary"
      aria-label="Active Videohub range"
      title={`${modelName} · Watching ${sourceScope.toLowerCase()}, ${destinationScope.toLowerCase()}`}
    >
      {sourceScope} · {destinationScope}
    </span>
  );
}

function videohubScopeCount(
  effectiveCount: number | null,
  detectedCount: number | null,
  configuredLimit: number | null,
  synchronizedCount: number,
): number | null {
  if (effectiveCount !== null) return effectiveCount;
  if (detectedCount !== null) {
    return configuredLimit === null
      ? detectedCount
      : Math.min(detectedCount, configuredLimit);
  }
  if (configuredLimit !== null) return configuredLimit;
  return synchronizedCount > 0 ? synchronizedCount : null;
}

function routerScopeLabel(
  label: "Destinations" | "Sources",
  count: number | null,
): string {
  return count === null ? `${label} detecting` : `${label} 1–${String(count)}`;
}

function RouterEmptyState({
  children,
  icon,
  title,
}: {
  readonly children: React.ReactNode;
  readonly icon: "cable" | "loading" | "unplugged" | "warning";
  readonly title: string;
}): React.JSX.Element {
  return (
    <div
      className="router-empty-state"
      role={icon === "warning" ? "alert" : "status"}
      data-state={icon}
    >
      <span className="router-empty-icon" aria-hidden="true">
        {icon === "unplugged" ? (
          <Unplug size={24} />
        ) : icon === "warning" ? (
          <AlertTriangle size={24} />
        ) : icon === "loading" ? (
          <CircleDashed size={24} />
        ) : (
          <Cable size={24} />
        )}
      </span>
      <h3>{title}</h3>
      <div className="router-empty-body">{children}</div>
    </div>
  );
}

function RouterWorkspace({
  destinationLocks,
  router,
  showsLevels,
  state,
}: {
  readonly destinationLocks?:
    | readonly { destination: number; owner: number }[]
    | undefined;
  readonly router: RouterConnection;
  readonly showsLevels: boolean;
  readonly state: RouterState;
}): React.JSX.Element {
  const [sourceSearchInput, setSourceSearchInput] = useState("");
  const [destinationSearchInput, setDestinationSearchInput] = useState("");
  const [fedOnly, setFedOnly] = useState(false);
  const [focusedSource, setFocusedSource] = useState<number | null>(null);
  const [focusedDestination, setFocusedDestination] = useState<number | null>(
    null,
  );
  const configuredLevels = useMemo(
    () => Array.from({ length: state.levels }, (_, index) => index + 1),
    [state.levels],
  );
  const [viewLevelSelection, setViewLevelSelection] = useState<number | null>(
    configuredLevels[0] ?? null,
  );
  const viewLevel =
    viewLevelSelection !== null && configuredLevels.includes(viewLevelSelection)
      ? viewLevelSelection
      : null;
  const visibleLevels = useMemo(
    () => (viewLevel === null ? configuredLevels : [viewLevel]),
    [configuredLevels, viewLevel],
  );
  const [stagingLevels, setStagingLevels] =
    useState<readonly number[]>(configuredLevels);
  const previousConfiguredLevelsRef = useRef(configuredLevels);
  const [levelSelectorOpen, setLevelSelectorOpen] = useState(false);
  const [pendingRouteReplacement, setPendingRouteReplacement] = useState<
    number | null
  >(null);
  const [replaceSourceCandidate, setReplaceSourceCandidate] = useState<
    number | null
  >(null);
  const [clearStagedOpen, setClearStagedOpen] = useState(false);
  const destinationSelectionAnchorRef = useRef<number | null>(null);
  const sourceSearch = normalizedSearch(
    useDebouncedValue(sourceSearchInput, ROUTER_SEARCH_DELAY_MS),
  );
  const destinationSearch = normalizedSearch(
    useDebouncedValue(destinationSearchInput, ROUTER_SEARCH_DELAY_MS),
  );
  const selectedSource = state.selection.source;
  const truthReady = routeTruthIsReady(state);

  useEffect(() => {
    const previousConfiguredLevels = previousConfiguredLevelsRef.current;
    if (numberArraysEqual(previousConfiguredLevels, configuredLevels)) return;
    previousConfiguredLevelsRef.current = configuredLevels;
    setStagingLevels((current) => {
      const next = numberArraysEqual(current, previousConfiguredLevels)
        ? configuredLevels
        : current.filter((level) => configuredLevels.includes(level));
      return numberArraysEqual(current, next) ? current : next;
    });
  }, [configuredLevels]);

  const [previousTruthReady, setPreviousTruthReady] = useState(truthReady);
  if (previousTruthReady !== truthReady) {
    setPreviousTruthReady(truthReady);
    if (!truthReady) {
      setFedOnly(false);
      setLevelSelectorOpen(false);
      setPendingRouteReplacement(null);
      setReplaceSourceCandidate(null);
      setClearStagedOpen(false);
    }
  }
  useEffect(() => {
    if (!truthReady) destinationSelectionAnchorRef.current = null;
  }, [truthReady]);
  const fedOnlyActive = fedOnly && selectedSource !== null && truthReady;
  const destinationSourceFilter = fedOnlyActive ? selectedSource : null;
  const destinationQueryLevels = useMemo(
    () =>
      destinationSourceFilter === null || viewLevel === null
        ? []
        : ([viewLevel] satisfies readonly number[]),
    [destinationSourceFilter, viewLevel],
  );

  const sourceModel = useMemo(
    () => sourceListModel(state, sourceSearch),
    [sourceSearch, state],
  );
  const destinationModel = useMemo(
    () =>
      destinationListModel(
        state,
        destinationSearch,
        destinationSourceFilter,
        destinationQueryLevels,
      ),
    [destinationQueryLevels, destinationSearch, destinationSourceFilter, state],
  );
  const sourceLabels = useMemo(() => sourceLabelMap(state), [state]);
  const sourceRouteDeltas = useMemo(
    () => sourceRouteDeltaMap(state, visibleLevels),
    [state, visibleLevels],
  );
  const sourceRouteDestinations = useMemo(
    () => sourceRouteDestinationMap(state, visibleLevels),
    [state, visibleLevels],
  );
  const selectedDestinationSources = useMemo(() => {
    const destination = state.selection.destination;
    if (destination === null || !truthReady) return new Set<number>();
    const entry = destinationForAddress(state, destination);
    return new Set(
      entry?.routes
        .filter(({ level }) => visibleLevels.includes(level))
        .map(({ source }) => source) ?? [],
    );
  }, [state, truthReady, visibleLevels]);
  const sourceRequestIdentity = pageRequestIdentity(state, "sources", {
    levels: [],
    search: sourceSearch,
    source: null,
  });
  const sourceListIdentity = pageListIdentity(state, "sources", {
    levels: [],
    search: sourceSearch,
    source: null,
  });
  const destinationRequestIdentity = pageRequestIdentity(
    state,
    "destinations",
    {
      levels: destinationQueryLevels,
      search: destinationSearch,
      source: destinationSourceFilter,
    },
  );
  const destinationListIdentity = pageListIdentity(state, "destinations", {
    levels: destinationQueryLevels,
    search: destinationSearch,
    source: destinationSourceFilter,
  });
  const destinationPageSize = destinationPageLimit(state.levels);
  const batchSource = state.drafts[0]?.source ?? null;
  const counts = draftCounts(state);
  const hasActiveTake = state.drafts.some((draft) =>
    draft.targets.some(
      ({ status }) => status === "submitting" || status === "pending",
    ),
  );
  const canStageWithSource = useCallback(
    (source: number): boolean =>
      stagingLevels.length > 0 &&
      truthReady &&
      !hasActiveTake &&
      (batchSource === null || batchSource === source),
    [batchSource, hasActiveTake, stagingLevels.length, truthReady],
  );
  const canStartStage =
    stagingLevels.length > 0 && truthReady && !hasActiveTake;
  const stageDisabled =
    selectedSource === null || !canStageWithSource(selectedSource);

  const toggleStagingLevel = useCallback(
    (level: number, checked: boolean): void => {
      setStagingLevels((current) =>
        checked
          ? [...new Set([...current, level])].sort(
              (left, right) => left - right,
            )
          : current.filter((candidate) => candidate !== level),
      );
    },
    [],
  );

  const stagePair = useCallback(
    (source: number, destination: number): void => {
      if (!canStageWithSource(source)) return;
      const existing = state.drafts.find(
        (draft) => draft.destination === destination,
      );
      if (
        existing?.status === "staged" &&
        existing.source === source &&
        numberArraysEqual(existing.levels, stagingLevels)
      ) {
        return;
      }
      if (existing !== undefined) {
        setPendingRouteReplacement(destination);
        return;
      }
      router.stageMapping({ source, destination, levels: stagingLevels });
    },
    [canStageWithSource, router, stagingLevels, state.drafts],
  );

  const replaceStagedPair = useCallback(
    (source: number, destination: number): void => {
      if (!canStartStage) return;
      const onlyDraft = state.drafts.length === 1 ? state.drafts[0] : undefined;
      if (
        onlyDraft?.status === "staged" &&
        onlyDraft.source === source &&
        onlyDraft.destination === destination &&
        numberArraysEqual(onlyDraft.levels, stagingLevels)
      ) {
        return;
      }
      router.clearStaged();
      router.stageMapping({ source, destination, levels: stagingLevels });
      setPendingRouteReplacement(null);
    },
    [canStartStage, router, stagingLevels, state.drafts],
  );

  const activateSource = useCallback(
    (source: number): void => {
      const destination = state.selection.destination;
      router.selectSource(source);
      destinationSelectionAnchorRef.current = destination;
      if (destination !== null) {
        replaceStagedPair(source, destination);
      } else if (
        batchSource !== null &&
        batchSource !== source &&
        !hasActiveTake
      ) {
        router.clearStaged();
      }
    },
    [
      batchSource,
      hasActiveTake,
      replaceStagedPair,
      router,
      state.selection.destination,
    ],
  );

  const activateDestination = useCallback(
    (destination: number, gesture: VirtualRouterSelectionGesture): void => {
      router.selectDestination(destination);
      if (selectedSource === null) {
        destinationSelectionAnchorRef.current = destination;
        return;
      }

      if (gesture.range) {
        const anchor = destinationSelectionAnchorRef.current;
        const anchorIndex = destinationModel.items.findIndex(
          ({ address }) => address === anchor,
        );
        const destinationIndex = destinationModel.items.findIndex(
          ({ address }) => address === destination,
        );
        if (anchorIndex < 0 || destinationIndex < 0) {
          destinationSelectionAnchorRef.current = destination;
          replaceStagedPair(selectedSource, destination);
          return;
        }
        const firstIndex = Math.min(anchorIndex, destinationIndex);
        const lastIndex = Math.max(anchorIndex, destinationIndex);
        for (const item of destinationModel.items.slice(
          firstIndex,
          lastIndex + 1,
        )) {
          if (
            !state.drafts.some((draft) => draft.destination === item.address)
          ) {
            stagePair(selectedSource, item.address);
          }
        }
        return;
      }

      destinationSelectionAnchorRef.current = destination;
      if (gesture.toggle) {
        const existing = state.drafts.find(
          (draft) => draft.destination === destination,
        );
        if (existing !== undefined) {
          if (truthReady && !hasActiveTake)
            router.removeStagedMapping(existing.mappingId);
        } else {
          stagePair(selectedSource, destination);
        }
        return;
      }

      replaceStagedPair(selectedSource, destination);
    },
    [
      destinationModel.items,
      hasActiveTake,
      replaceStagedPair,
      router,
      selectedSource,
      stagePair,
      state.drafts,
      truthReady,
    ],
  );

  const confirmRouteReplacement = useCallback((): void => {
    if (
      pendingRouteReplacement === null ||
      selectedSource === null ||
      stageDisabled
    )
      return;
    router.stageMapping({
      source: selectedSource,
      destination: pendingRouteReplacement,
      levels: stagingLevels,
    });
    setPendingRouteReplacement(null);
  }, [
    pendingRouteReplacement,
    router,
    selectedSource,
    stageDisabled,
    stagingLevels,
  ]);

  const requestSource = useCallback(
    (afterAddress: number | null): Promise<void> =>
      router.loadSourcePage({
        afterAddress,
        limit: ROUTER_PAGE_SIZE,
        search: sourceSearch,
      }),
    [router, sourceSearch],
  );
  const requestDestination = useCallback(
    (afterAddress: number | null): Promise<void> =>
      router.loadDestinationPage({
        afterAddress,
        limit: destinationPageSize,
        search: destinationSearch,
        source: destinationSourceFilter,
        levels: destinationQueryLevels,
      }),
    [
      destinationPageSize,
      destinationQueryLevels,
      destinationSearch,
      destinationSourceFilter,
      router,
    ],
  );
  const sourceLoader = useRouterPageLoader(
    sourceRequestIdentity,
    requestSource,
  );
  const destinationLoader = useRouterPageLoader(
    destinationRequestIdentity,
    requestDestination,
  );

  useFilteredDestinationReload(
    destinationSourceFilter !== null,
    state.version.generation,
    state.version.revision,
    destinationLoader.loadPage,
  );
  useCoalescedFirstPageReload(
    state.pageReloads.sources,
    sourceRequestIdentity,
    sourceLoader.loadPage,
  );
  useCoalescedFirstPageReload(
    state.pageReloads.destinations,
    destinationRequestIdentity,
    destinationLoader.loadPage,
  );

  const sourceFocusAddress =
    focusedSource ??
    state.focusedSource ??
    selectedSource ??
    sourceModel.items[0]?.address ??
    null;
  const destinationFocusAddress =
    focusedDestination ??
    state.focusedDestination ??
    state.selection.destination ??
    destinationModel.items[0]?.address ??
    null;
  const sourceBusy = sourceLoader.phase === "loading";
  const destinationBusy = destinationLoader.phase === "loading";
  const sourceVirtualTotal = state.pageReloads.sources
    ? sourceModel.itemOffset + sourceModel.items.length
    : sourceModel.totalCount;
  const destinationVirtualTotal = state.pageReloads.destinations
    ? destinationModel.itemOffset + destinationModel.items.length
    : destinationModel.totalCount;

  return (
    <div
      className="router-workspace"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        const target = event.target;
        if (
          target instanceof Element &&
          (target.closest('[role="alertdialog"]') !== null ||
            target.closest(".router-level-selector-panel") !== null ||
            target.closest('input[type="search"]') !== null)
        ) {
          return;
        }
        event.preventDefault();
        router.clearSelection();
        destinationSelectionAnchorRef.current = null;
        setPendingRouteReplacement(null);
        setReplaceSourceCandidate(null);
        setClearStagedOpen(false);
        setLevelSelectorOpen(false);
      }}
    >
      <section
        className="router-pane router-resource-pane router-source-pane"
        aria-labelledby="router-sources-title"
      >
        <RouterPaneHeading
          id="router-sources-title"
          label="Sources"
          loadedCount={sourceModel.items.length}
          side="source"
          totalCount={sourceModel.totalCount}
        />
        <div className="router-pane-toolbar">
          <RouterSearchField
            label="Search sources"
            placeholder="Search label or address"
            value={sourceSearchInput}
            onChange={setSourceSearchInput}
          />
        </div>
        <div className="router-list-frame">
          <VirtualRouterList
            activeAddress={sourceFocusAddress}
            ariaLabel="Sources"
            busy={sourceBusy}
            className="router-virtual-list"
            hasMore={!state.pageReloads.sources && sourceModel.hasMore}
            itemOffset={sourceModel.itemOffset}
            items={sourceModel.items}
            loadPage={sourceLoader.loadPage}
            nextAfterAddress={sourceModel.nextAfterAddress}
            onActiveAddressChange={setFocusedSource}
            onActivateAddress={activateSource}
            onToggleAddress={activateSource}
            overscan={ROUTER_LIST_OVERSCAN}
            pageIdentity={sourceListIdentity}
            renderRow={(source) => (
              <SourceRow
                currentForSelectedDestination={selectedDestinationSources.has(
                  source.address,
                )}
                destinations={sourceRouteDestinations.get(source.address) ?? []}
                routeDelta={sourceRouteDeltas.get(source.address)}
                selected={state.selection.source === source.address}
                source={source}
                stagedSource={state.drafts.some(
                  (draft) => draft.source === source.address,
                )}
              />
            )}
            rowHeight={ROUTER_SOURCE_ROW_HEIGHT}
            selectedAddress={state.selection.source}
            totalCount={sourceVirtualTotal}
          />
          <RouterListStatus
            busy={sourceBusy}
            hasPage={sourceModel.hasPage}
            itemCount={sourceModel.items.length}
            label="sources"
            phase={sourceLoader.phase}
            search={sourceSearch}
            totalCount={sourceModel.totalCount}
            onRetry={() =>
              sourceLoader.loadPage(sourceLoader.failedAfterAddress)
            }
          />
        </div>
      </section>

      <section
        className="router-pane router-resource-pane router-destination-pane"
        aria-labelledby="router-destinations-title"
      >
        <RouterPaneHeading
          id="router-destinations-title"
          label="Destinations"
          loadedCount={destinationModel.items.length}
          side="destination"
          totalCount={destinationModel.totalCount}
        />
        <div className="router-pane-toolbar">
          <RouterSearchField
            label="Search destinations"
            placeholder="Search label or address"
            value={destinationSearchInput}
            onChange={setDestinationSearchInput}
          />
          {showsLevels ? (
            <label className="router-view-level-filter">
              <span>View routes</span>
              <select
                aria-label="View routing level"
                value={viewLevel === null ? "all" : String(viewLevel)}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setViewLevelSelection(
                    nextValue === "all" ? null : Number(nextValue),
                  );
                }}
              >
                <option value="all">All levels</option>
                {configuredLevels.map((level) => (
                  <option key={level} value={level}>
                    Level {level}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="router-fed-filter">
            <input
              type="checkbox"
              aria-label="Fed by selected source"
              checked={fedOnlyActive}
              disabled={selectedSource === null || !truthReady}
              onChange={(event) => {
                setFedOnly(event.currentTarget.checked);
              }}
            />
            <span className="router-toggle-track" aria-hidden="true">
              <span />
            </span>
            <span>Fed only</span>
            <span className="router-visually-hidden">
              Fed by selected source
            </span>
          </label>
        </div>
        <div className="router-list-frame">
          <VirtualRouterList
            activeAddress={destinationFocusAddress}
            ariaLabel="Destinations"
            busy={destinationBusy}
            className="router-virtual-list"
            hasMore={
              !state.pageReloads.destinations && destinationModel.hasMore
            }
            itemOffset={destinationModel.itemOffset}
            items={destinationModel.items}
            isAddressChecked={(address) =>
              state.drafts.some((draft) => draft.destination === address)
            }
            loadPage={destinationLoader.loadPage}
            nextAfterAddress={destinationModel.nextAfterAddress}
            onActiveAddressChange={setFocusedDestination}
            onActivateAddress={activateDestination}
            overscan={ROUTER_LIST_OVERSCAN}
            pageIdentity={destinationListIdentity}
            renderRow={(destination) => (
              <DestinationRow
                destination={destination}
                lockOwner={
                  destinationLocks === undefined
                    ? undefined
                    : (destinationLocks.find(
                        (lock) => lock.destination === destination.address,
                      )?.owner ?? null)
                }
                draft={state.drafts.find(
                  (candidate) => candidate.destination === destination.address,
                )}
                selected={state.selection.destination === destination.address}
                selectedSource={selectedSource}
                showsLevels={showsLevels}
                sourceLabels={sourceLabels}
                stageDisabled={stageDisabled}
                state={state}
                visibleLevels={visibleLevels}
              />
            )}
            rowHeight={ROUTER_DESTINATION_ROW_HEIGHT}
            selectedAddress={state.selection.destination}
            totalCount={destinationVirtualTotal}
            onToggleAddress={activateDestination}
          />
          <RouterListStatus
            busy={destinationBusy}
            hasPage={destinationModel.hasPage}
            itemCount={destinationModel.items.length}
            label="destinations"
            phase={destinationLoader.phase}
            search={destinationSearch}
            totalCount={destinationModel.totalCount}
            onRetry={() =>
              destinationLoader.loadPage(destinationLoader.failedAfterAddress)
            }
          />
        </div>
      </section>

      <RouteComposer
        mutationsAvailable={truthReady}
        pendingRouteReplacement={truthReady ? pendingRouteReplacement : null}
        selectedLevels={stagingLevels}
        showsLevels={showsLevels}
        sourceLabels={sourceLabels}
        state={state}
        onCancelRouteReplacement={() => {
          setPendingRouteReplacement(null);
        }}
        onConfirmRouteReplacement={confirmRouteReplacement}
        onRequestRouteReplacement={(destination) => {
          if (truthReady) setPendingRouteReplacement(destination);
        }}
        onRebaseMapping={(mappingId) => {
          if (truthReady) router.rebaseMapping(mappingId);
        }}
        onRemoveMapping={(mappingId) => {
          router.removeStagedMapping(mappingId);
        }}
      />

      <RouterActionBar
        batchSource={batchSource}
        clearStagedOpen={truthReady && clearStagedOpen}
        configuredLevels={configuredLevels}
        counts={counts}
        levelSelectorOpen={truthReady && levelSelectorOpen}
        replaceSourceCandidate={truthReady ? replaceSourceCandidate : null}
        router={router}
        selectedLevels={stagingLevels}
        showsLevels={showsLevels}
        sourceLabels={sourceLabels}
        state={state}
        truthReady={truthReady}
        onClearStagedOpenChange={(open) => {
          setClearStagedOpen(truthReady && open);
        }}
        onLevelSelectorOpenChange={(open) => {
          setLevelSelectorOpen(truthReady && open);
        }}
        onReplaceSourceCandidateChange={(source) => {
          setReplaceSourceCandidate(truthReady ? source : null);
        }}
        onSelectedLevelsChange={(levels) => {
          if (truthReady) setStagingLevels(levels);
        }}
        onToggleLevel={(level, checked) => {
          if (truthReady) toggleStagingLevel(level, checked);
        }}
      />
    </div>
  );
}

function RouterPaneHeading({
  id,
  label,
  loadedCount,
  side,
  totalCount,
}: {
  readonly id: string;
  readonly label: string;
  readonly loadedCount: number;
  readonly side: "destination" | "source";
  readonly totalCount: number;
}): React.JSX.Element {
  return (
    <div className="router-pane-heading" data-side={side}>
      <h3 id={id}>{label}</h3>
      <span
        className="router-pane-count"
        title={`${String(loadedCount)} loaded`}
      >
        {totalCount.toLocaleString("en-US")}
      </span>
    </div>
  );
}

function RouterListStatus({
  busy,
  hasPage,
  itemCount,
  label,
  onRetry,
  phase,
  search,
  totalCount,
}: {
  readonly busy: boolean;
  readonly hasPage: boolean;
  readonly itemCount: number;
  readonly label: "sources" | "destinations";
  readonly onRetry: () => Promise<void>;
  readonly phase: RouterPageLoadPhase;
  readonly search: string | null;
  readonly totalCount: number;
}): React.JSX.Element | null {
  if (phase === "failed") {
    return (
      <div
        className="router-list-message"
        role="alert"
        data-state="failed"
        data-has-items={itemCount > 0 ? "true" : "false"}
      >
        <strong>Could not load {label}</strong>
        <span>The Router stream remains connected. Retry this page.</span>
        <button
          className="router-control-button"
          type="button"
          onClick={() => {
            void onRetry().catch(() => undefined);
          }}
        >
          Retry {label}
        </button>
      </div>
    );
  }
  if (busy && itemCount === 0) {
    return (
      <div className="router-list-message" role="status" data-state="loading">
        Loading {label}…
      </div>
    );
  }
  if (hasPage && totalCount === 0) {
    return (
      <div className="router-list-message" role="status" data-state="empty">
        {search === null
          ? `No ${label} reported.`
          : `No ${label} match this search.`}
      </div>
    );
  }
  return null;
}

function RouterSearchField({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <label className="router-search-field">
      <span className="router-visually-hidden">{label}</span>
      <Search aria-hidden="true" size={13} strokeWidth={1.8} />
      <input
        type="search"
        aria-label={label}
        maxLength={MAX_ROUTER_SEARCH_LENGTH}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(sanitizeSearchInput(event.currentTarget.value));
        }}
      />
    </label>
  );
}

function SourceRow({
  currentForSelectedDestination,
  destinations,
  routeDelta,
  selected,
  source,
  stagedSource,
}: {
  readonly currentForSelectedDestination: boolean;
  readonly destinations: readonly RouterRouteDeltaEndpoint[];
  readonly routeDelta: SourceRouteDelta | undefined;
  readonly selected: boolean;
  readonly source: RouterSourceEntry;
  readonly stagedSource: boolean;
}): React.JSX.Element {
  return (
    <div
      className="router-resource-row router-source-row"
      data-current={currentForSelectedDestination ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-staged={stagedSource ? "true" : "false"}
    >
      {stagedSource ? (
        <span
          className="router-row-action-mark"
          aria-hidden="true"
          data-state="staged"
        >
          <Check size={12} strokeWidth={2.4} />
        </span>
      ) : null}
      <span className="router-resource-copy">
        <span
          className="router-endpoint-kind"
          data-side="source"
          aria-hidden="true"
        >
          S
        </span>
        <strong>{source.label ?? `Source ${String(source.address)}`}</strong>
        <span className="router-address">
          <span aria-hidden="true">SRC</span> <span>{source.address}</span>
        </span>
      </span>
      <SourceDestinationTags
        destinations={destinations}
        routeDelta={routeDelta}
        sourceName={source.label ?? `Source ${String(source.address)}`}
      />
      <span className="router-source-meta">
        {selected ? (
          <span className="router-row-state">Selected source</span>
        ) : null}
        {currentForSelectedDestination ? (
          <span className="router-current-marker">
            Feeds selected destination
          </span>
        ) : null}
        {stagedSource ? (
          <span className="router-staged-marker">Draft source</span>
        ) : null}
      </span>
    </div>
  );
}

function SourceDestinationTags({
  destinations,
  routeDelta,
  sourceName,
}: {
  readonly destinations: readonly RouterRouteDeltaEndpoint[];
  readonly routeDelta: SourceRouteDelta | undefined;
  readonly sourceName: string;
}): React.JSX.Element {
  const additions = new Map(
    routeDelta?.additions.map((destination) => [
      destination.address,
      destination,
    ]),
  );
  const removals = new Map(
    routeDelta?.removals.map((destination) => [
      destination.address,
      destination,
    ]),
  );
  const current = destinations.filter(
    (destination) =>
      !additions.has(destination.address) && !removals.has(destination.address),
  );

  return (
    <span
      className="router-source-destinations"
      aria-label={`Destinations fed by ${sourceName}`}
    >
      {current.map((destination) => (
        <span
          key={`current-${String(destination.address)}`}
          className="router-destination-tag"
          title={`Feeds ${destination.name}`}
        >
          <span aria-hidden="true">D</span>
          {destination.name}
        </span>
      ))}
      {[...removals.values()].map((destination) => (
        <span
          key={`remove-${String(destination.address)}`}
          className="router-route-delta-pill"
          data-kind="remove"
          title={`Remove ${destination.name}`}
        >
          <Minus aria-hidden="true" size={9} strokeWidth={2.6} />
          {destination.name}
        </span>
      ))}
      {[...additions.values()].map((destination) => (
        <span
          key={`add-${String(destination.address)}`}
          className="router-route-delta-pill"
          data-kind="add"
          title={`Route ${destination.name}`}
        >
          <Plus aria-hidden="true" size={9} strokeWidth={2.6} />
          {destination.name}
        </span>
      ))}
    </span>
  );
}

function DestinationRow({
  destination,
  lockOwner,
  draft,
  selected,
  selectedSource,
  showsLevels,
  sourceLabels,
  stageDisabled,
  state,
  visibleLevels,
}: {
  readonly destination: RouterDestinationEntry;
  readonly lockOwner?: number | null | undefined;
  readonly draft: RouterDraftMapping | undefined;
  readonly selected: boolean;
  readonly selectedSource: number | null;
  readonly showsLevels: boolean;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly stageDisabled: boolean;
  readonly state: RouterState;
  readonly visibleLevels: readonly number[];
}): React.JSX.Element {
  const destinationName =
    destination.label ?? `Destination ${String(destination.address)}`;
  const selectedSourceName =
    selectedSource === null
      ? "a selected source"
      : sourceDisplayName(sourceLabels, selectedSource);
  return (
    <div
      className="router-resource-row router-destination-row"
      data-selected={selected ? "true" : "false"}
      data-staged={draft === undefined ? "false" : "true"}
      data-testid={`stage-destination-${String(destination.address)}`}
    >
      <span className="router-visually-hidden">
        {draft === undefined ? "Not staged" : draftStatusLabel(draft.status)}.{" "}
        {stageDisabled
          ? `Routing ${destinationName} with ${selectedSourceName} is unavailable.`
          : `Activate to stage ${destinationName} with ${selectedSourceName}.`}
      </span>
      <span className="router-destination-meta">
        <DestinationSummary
          destination={destination}
          showsLevels={showsLevels}
          sourceLabels={sourceLabels}
          state={state}
          visibleLevels={visibleLevels}
        />
        {draft === undefined ? null : (
          <DestinationRouteDelta
            draft={draft}
            sourceLabels={sourceLabels}
            visibleLevels={visibleLevels}
          />
        )}
        {selected ? (
          <span className="router-row-state">Selected destination</span>
        ) : null}
        {draft === undefined ? null : (
          <span className="router-staged-marker">
            {draftStatusLabel(draft.status)}
          </span>
        )}
      </span>
      <span className="router-resource-copy">
        <span
          className="router-endpoint-kind"
          data-side="destination"
          aria-hidden="true"
        >
          D
        </span>
        <strong>{destinationName}</strong>
        {lockOwner === undefined ? null : (
          <span className="router-row-state">
            {lockOwner === null
              ? "Lock unknown"
              : lockOwner === 0
                ? "Unlocked"
                : lockOwner === 255
                  ? "Locked"
                  : `Owned · panel ${String(lockOwner - 1)}`}
          </span>
        )}
        <span className="router-address">
          <span aria-hidden="true">DST</span> <span>{destination.address}</span>
        </span>
      </span>
      {draft === undefined ? null : (
        <span
          className="router-row-action-mark"
          aria-hidden="true"
          data-state="staged"
        >
          <Check size={12} strokeWidth={2.4} />
        </span>
      )}
    </div>
  );
}

function DestinationRouteDelta({
  draft,
  sourceLabels,
  visibleLevels,
}: {
  readonly draft: RouterDraftMapping;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly visibleLevels: readonly number[];
}): React.JSX.Element {
  const removedSources = [
    ...new Set(
      draft.expected
        .filter(({ level }) => visibleLevels.includes(level))
        .map(({ source }) => source),
    ),
  ].filter((source) => source !== draft.source);
  return (
    <span
      className="router-destination-delta"
      aria-label={`${removedSources
        .map((source) => `${sourceDisplayName(sourceLabels, source)} removed`)
        .join(
          ", ",
        )}${removedSources.length > 0 ? "; " : ""}${sourceDisplayName(sourceLabels, draft.source)} added`}
    >
      {removedSources.map((source) => (
        <span
          key={source}
          className="router-route-delta-pill"
          data-kind="remove"
          title={`Remove ${sourceDisplayName(sourceLabels, source)}`}
        >
          {sourceDisplayName(sourceLabels, source)}
          <Minus aria-hidden="true" size={9} strokeWidth={2.6} />
        </span>
      ))}
      <span className="router-delta-arrow" aria-hidden="true">
        →
      </span>
      <span
        className="router-route-delta-pill"
        data-kind="add"
        title={`Route ${sourceDisplayName(sourceLabels, draft.source)}`}
      >
        {sourceDisplayName(sourceLabels, draft.source)}
        <Plus aria-hidden="true" size={9} strokeWidth={2.6} />
      </span>
    </span>
  );
}

function DestinationSummary({
  destination,
  showsLevels,
  sourceLabels,
  state,
  visibleLevels,
}: {
  readonly destination: RouterDestinationEntry;
  readonly showsLevels: boolean;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly state: RouterState;
  readonly visibleLevels: readonly number[];
}): React.JSX.Element {
  const truthReady = routeTruthIsReady(state);
  const summary = destinationSummaryForEntry(destination, visibleLevels);
  const routeTruthLabel = destinationRouteTruthLabel(
    destination,
    visibleLevels,
    sourceLabels,
    truthReady,
    showsLevels,
  );
  const staleQualifier = truthReady ? null : (
    <span aria-hidden="true" data-kind="status">
      Last observed
    </span>
  );
  switch (summary.kind) {
    case "uniform":
      return (
        <span
          className={`router-summary${truthReady ? "" : " router-summary-sources"}`}
          data-state={truthReady ? "uniform" : "stale"}
          title={routeTruthLabel}
        >
          <span className="router-visually-hidden">{routeTruthLabel}</span>
          <span
            aria-hidden="true"
            data-kind={truthReady ? undefined : "source"}
            data-state={truthReady ? "uniform" : undefined}
          >
            {sourceDisplayName(sourceLabels, summary.source)}
          </span>
          {staleQualifier}
        </span>
      );
    case "mixed":
      return (
        <span
          className="router-summary router-summary-sources"
          data-state={truthReady ? "mixed" : "stale"}
          title={routeTruthLabel}
        >
          <span className="router-visually-hidden">{routeTruthLabel}</span>
          {summary.sources.map((source) => (
            <span aria-hidden="true" data-kind="source" key={source}>
              {sourceDisplayName(sourceLabels, source)}
            </span>
          ))}
          {staleQualifier}
        </span>
      );
    case "partial":
      return (
        <span
          className="router-summary router-summary-sources"
          data-state={truthReady ? "partial" : "stale"}
          title={routeTruthLabel}
        >
          <span className="router-visually-hidden">{routeTruthLabel}</span>
          {summary.sources.map((source) => (
            <span aria-hidden="true" data-kind="source" key={source}>
              {sourceDisplayName(sourceLabels, source)}
            </span>
          ))}
          <span aria-hidden="true" data-kind="status">
            {showsLevels
              ? `Partial · ${String(summary.knownLevels)}/${String(summary.totalLevels)} levels`
              : "Partial route truth"}
          </span>
          {staleQualifier}
        </span>
      );
    case "unknown":
      return (
        <span
          className="router-summary"
          data-state={truthReady ? "unknown" : "stale"}
          title={routeTruthLabel}
        >
          {truthReady ? (
            "Unknown"
          ) : (
            <>
              <span className="router-visually-hidden">{routeTruthLabel}</span>
              <span aria-hidden="true">Unknown · Last observed</span>
            </>
          )}
        </span>
      );
  }
}

function RouteComposer({
  mutationsAvailable,
  onCancelRouteReplacement,
  onConfirmRouteReplacement,
  onRebaseMapping,
  onRemoveMapping,
  onRequestRouteReplacement,
  pendingRouteReplacement,
  selectedLevels,
  showsLevels,
  sourceLabels,
  state,
}: {
  readonly mutationsAvailable: boolean;
  readonly onCancelRouteReplacement: () => void;
  readonly onConfirmRouteReplacement: () => void;
  readonly onRebaseMapping: (mappingId: string) => void;
  readonly onRemoveMapping: (mappingId: string) => void;
  readonly onRequestRouteReplacement: (destination: number) => void;
  readonly pendingRouteReplacement: number | null;
  readonly selectedLevels: readonly number[];
  readonly showsLevels: boolean;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly state: RouterState;
}): React.JSX.Element {
  const selectedDestinationAddress = state.selection.destination;
  const selectedSourceAddress = state.selection.source;
  const selectedDraft =
    selectedSourceAddress === null || selectedDestinationAddress === null
      ? undefined
      : state.drafts.find(
          (draft) =>
            draft.source === selectedSourceAddress &&
            draft.destination === selectedDestinationAddress,
        );
  let patchGuidance = "Choose a source or destination to begin a route.";
  if (selectedSourceAddress !== null && selectedDestinationAddress === null) {
    patchGuidance = `${sourceDisplayName(sourceLabels, selectedSourceAddress)} selected. Choose one or more destinations.`;
  } else if (
    selectedSourceAddress === null &&
    selectedDestinationAddress !== null
  ) {
    patchGuidance = `${destinationDisplayName(state, selectedDestinationAddress)} selected. Choose a source.`;
  } else if (
    selectedSourceAddress !== null &&
    selectedDestinationAddress !== null
  ) {
    if (selectedDraft !== undefined) {
      const status =
        selectedDraft.status === "staged"
          ? "staged for review"
          : draftStatusLabel(selectedDraft.status).toLowerCase();
      patchGuidance = `${sourceDisplayName(sourceLabels, selectedDraft.source)} → ${destinationDisplayName(state, selectedDraft.destination)} ${status}.`;
    } else if (state.transport !== "connected") {
      patchGuidance =
        "Routes are current, but controls are reconnecting. Try again in a moment.";
    } else if (!routeTruthIsReady(state)) {
      patchGuidance =
        "Route truth is unavailable. Reconnect before staging this route.";
    } else if (selectedLevels.length === 0) {
      patchGuidance =
        "Choose at least one routing level before staging this route.";
    } else if (
      state.drafts[0] !== undefined &&
      state.drafts[0].source !== selectedSourceAddress
    ) {
      patchGuidance = `Staged routes use ${sourceDisplayName(sourceLabels, state.drafts[0].source)}. Replace the staged source or clear staged routes first.`;
    } else if (
      selectedLevels.some(
        (level) => sourceAt(state, selectedDestinationAddress, level) === null,
      )
    ) {
      patchGuidance = `Current truth for ${destinationDisplayName(state, selectedDestinationAddress)} is incomplete. Refresh it before staging.`;
    } else {
      patchGuidance = `${sourceDisplayName(sourceLabels, selectedSourceAddress)} and ${destinationDisplayName(state, selectedDestinationAddress)} selected. Choose another endpoint or retry.`;
    }
  }
  const expanded = state.drafts.length > 0;

  return (
    <section
      className="router-route-tray"
      aria-labelledby="router-route-composer-title"
      data-expanded={expanded ? "true" : "false"}
      data-revision={state.version.revision}
      tabIndex={0}
    >
      <div className="router-route-tray-bar">
        <h3 id="router-route-composer-title">Route activity</h3>
        <div className="router-route-activity-content">
          <div
            className={
              expanded ? "router-visually-hidden" : "router-patch-guidance"
            }
            role="status"
            aria-label="Router patch selection"
            aria-live="polite"
          >
            {patchGuidance}
          </div>
          {expanded ? (
            <StagedRouteList
              mutationsAvailable={mutationsAvailable}
              onCancelRouteReplacement={onCancelRouteReplacement}
              onConfirmRouteReplacement={onConfirmRouteReplacement}
              onRebaseMapping={onRebaseMapping}
              onRemoveMapping={onRemoveMapping}
              onRequestRouteReplacement={onRequestRouteReplacement}
              pendingRouteReplacement={pendingRouteReplacement}
              selectedLevels={selectedLevels}
              showsLevels={showsLevels}
              sourceLabels={sourceLabels}
              state={state}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StagedRouteList({
  mutationsAvailable,
  onCancelRouteReplacement,
  onConfirmRouteReplacement,
  onRebaseMapping,
  onRemoveMapping,
  onRequestRouteReplacement,
  pendingRouteReplacement,
  selectedLevels,
  showsLevels,
  sourceLabels,
  state,
}: {
  readonly mutationsAvailable: boolean;
  readonly onCancelRouteReplacement: () => void;
  readonly onConfirmRouteReplacement: () => void;
  readonly onRebaseMapping: (mappingId: string) => void;
  readonly onRemoveMapping: (mappingId: string) => void;
  readonly onRequestRouteReplacement: (destination: number) => void;
  readonly pendingRouteReplacement: number | null;
  readonly selectedLevels: readonly number[];
  readonly showsLevels: boolean;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly state: RouterState;
}): React.JSX.Element | null {
  const sectionRef = useRef<HTMLElement | null>(null);
  const cardRefs = useRef(new Map<number, HTMLLIElement>());
  const focusAfterUpdateRef = useRef<number | null>(null);
  const inlineConfirmationRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(
    () => () => {
      if (focusAfterUpdateRef.current === null) return;
      focusAfterUpdateRef.current = null;
      document.querySelector<HTMLElement>(".router-action-bar")?.focus();
    },
    [],
  );

  useLayoutEffect(() => {
    if (pendingRouteReplacement !== null) {
      inlineConfirmationRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    }
  }, [pendingRouteReplacement]);

  useLayoutEffect(() => {
    const destination = focusAfterUpdateRef.current;
    if (destination === null) return;
    focusAfterUpdateRef.current = null;
    const card = cardRefs.current.get(destination);
    if (card !== undefined) card.focus();
    else if (sectionRef.current !== null) sectionRef.current.focus();
    else document.querySelector<HTMLElement>(".router-action-bar")?.focus();
  }, [pendingRouteReplacement, state.drafts]);

  if (state.drafts.length === 0) return null;
  return (
    <section
      className="router-staged-section"
      aria-labelledby="router-staged-title"
      ref={sectionRef}
      tabIndex={-1}
    >
      <h4 id="router-staged-title" className="router-visually-hidden">
        Staged routes
      </h4>
      <ul className="router-staged-list" aria-label="Staged routes">
        {state.drafts.map((draft) => {
          const sourceName = sourceDisplayName(sourceLabels, draft.source);
          const destinationName = destinationDisplayName(
            state,
            draft.destination,
          );
          const baseline = routeSourceSummary(
            draft.expected.map(({ source }) => source),
            sourceLabels,
          );
          const current = routeSourceSummary(
            draft.levels.map((level) =>
              sourceAt(state, draft.destination, level),
            ),
            sourceLabels,
          );
          const activityLabel = draftActivityLabel(draft);
          const targetDetails = draft.targets.map((target) => {
            const currentSource = sourceAt(
              state,
              draft.destination,
              target.level,
            );
            const currentLabel =
              currentSource === null
                ? "Unknown"
                : `${sourceDisplayName(sourceLabels, currentSource)} · ${String(currentSource)}`;
            const expectedLabel = `${sourceDisplayName(sourceLabels, target.expectedSource)} · ${String(target.expectedSource)}`;
            const targetStatus = `${draftStatusLabel(target.status)}, expected ${expectedLabel}, current ${currentLabel}, dispatch ${dispatchOutcomeLabel(target.dispatchOutcome)}`;
            return showsLevels
              ? `Level ${String(target.level)}, ${targetStatus}`
              : targetStatus;
          });
          const ticketDescription = [
            `${sourceName}, source ${String(draft.source)} to ${destinationName}, destination ${String(draft.destination)}`,
            ...(showsLevels ? [formatLevelRanges(draft.levels)] : []),
            activityLabel,
            ...targetDetails,
            ...(draft.dispatchDiagnostics.length === 0
              ? []
              : [
                  `Dispatch diagnostics: ${draft.dispatchDiagnostics
                    .map(dispatchOutcomeLabel)
                    .join(", ")}`,
                ]),
          ].join("; ");
          const replacementOpen = pendingRouteReplacement === draft.destination;
          const canRestage =
            showsLevels &&
            state.selection.source === draft.source &&
            selectedLevels.length > 0 &&
            draft.status !== "submitting" &&
            draft.status !== "pending";
          return (
            <li
              key={draft.mappingId}
              className="router-staged-card"
              data-state={draft.status}
              aria-label={ticketDescription}
              ref={(element) => {
                if (element === null)
                  cardRefs.current.delete(draft.destination);
                else cardRefs.current.set(draft.destination, element);
              }}
              tabIndex={-1}
              title={ticketDescription}
            >
              <div className="router-staged-signal" aria-hidden="true">
                <span className="router-staged-endpoint" data-side="source">
                  <strong>{sourceName}</strong>
                  <span className="router-address">SRC {draft.source}</span>
                </span>
                <span className="router-staged-arrow">→</span>
                <span
                  className="router-staged-endpoint"
                  data-side="destination"
                >
                  <strong>{destinationName}</strong>

                  <span className="router-address">
                    DST {draft.destination}
                  </span>
                </span>
              </div>
              {showsLevels ? (
                <span className="router-level-range">
                  {formatLevelRanges(draft.levels)}
                </span>
              ) : null}
              <span className="router-draft-status">{activityLabel}</span>
              {draft.status === "conflict" ? (
                <p className="router-conflict-summary">
                  <span>
                    Expected <strong>{baseline}</strong>
                  </span>
                  <span>
                    Now <strong>{current}</strong>
                  </span>
                </p>
              ) : null}
              <div className="router-staged-card-actions">
                {canRestage ? (
                  <button
                    className="router-link-button"
                    type="button"
                    disabled={!mutationsAvailable}
                    onClick={() => {
                      onRequestRouteReplacement(draft.destination);
                    }}
                    aria-label={`Restage ${destinationName} with selected levels`}
                  >
                    Update levels
                  </button>
                ) : null}
                {draft.status === "conflict" ? (
                  <button
                    className="router-link-button"
                    type="button"
                    disabled={!mutationsAvailable}
                    onClick={() => {
                      focusAfterUpdateRef.current = draft.destination;
                      onRebaseMapping(draft.mappingId);
                    }}
                  >
                    Use current as baseline
                  </button>
                ) : null}
                {draft.status !== "submitting" && draft.status !== "pending" ? (
                  <button
                    className="router-icon-button"
                    type="button"
                    aria-label={`Remove staged ${destinationName} route`}
                    onClick={() => {
                      focusAfterUpdateRef.current = draft.destination;
                      onRemoveMapping(draft.mappingId);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={12} />
                  </button>
                ) : null}
              </div>
              {replacementOpen ? (
                <div
                  className="router-inline-confirmation"
                  role="alertdialog"
                  aria-label={`Replace staged ${destinationName} route`}
                  aria-describedby={`router-replace-route-${draft.mappingId}`}
                  ref={inlineConfirmationRef}
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    focusAfterUpdateRef.current = draft.destination;
                    onCancelRouteReplacement();
                  }}
                >
                  <span id={`router-replace-route-${draft.mappingId}`}>
                    {showsLevels
                      ? `Replace ${formatLevelRanges(draft.levels)} with ${formatLevelRanges(selectedLevels)}?`
                      : "Replace this staged route?"}
                  </span>
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        focusAfterUpdateRef.current = draft.destination;
                        onCancelRouteReplacement();
                      }}
                    >
                      Keep route
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        focusAfterUpdateRef.current = draft.destination;
                        onConfirmRouteReplacement();
                      }}
                    >
                      Replace route
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RouterActionBar({
  batchSource,
  clearStagedOpen,
  configuredLevels,
  counts,
  levelSelectorOpen,
  onClearStagedOpenChange,
  onLevelSelectorOpenChange,
  onReplaceSourceCandidateChange,
  onSelectedLevelsChange,
  onToggleLevel,
  replaceSourceCandidate,
  router,
  selectedLevels,
  showsLevels,
  sourceLabels,
  state,
  truthReady,
}: {
  readonly batchSource: number | null;
  readonly clearStagedOpen: boolean;
  readonly configuredLevels: readonly number[];
  readonly counts: ReturnType<typeof draftCounts>;
  readonly levelSelectorOpen: boolean;
  readonly onClearStagedOpenChange: (open: boolean) => void;
  readonly onLevelSelectorOpenChange: (open: boolean) => void;
  readonly onReplaceSourceCandidateChange: (source: number | null) => void;
  readonly onSelectedLevelsChange: (levels: readonly number[]) => void;
  readonly onToggleLevel: (level: number, checked: boolean) => void;
  readonly replaceSourceCandidate: number | null;
  readonly router: RouterConnection;
  readonly selectedLevels: readonly number[];
  readonly showsLevels: boolean;
  readonly sourceLabels: ReadonlyMap<number, string | null>;
  readonly state: RouterState;
  readonly truthReady: boolean;
}): React.JSX.Element {
  const actionBarRef = useRef<HTMLElement | null>(null);
  const clearStagedButtonRef = useRef<HTMLButtonElement | null>(null);
  const replaceSourceButtonRef = useRef<HTMLButtonElement | null>(null);
  const clearDialogRef = useRef<HTMLDivElement | null>(null);
  const replaceDialogRef = useRef<HTMLDivElement | null>(null);
  const levelSelectorButtonRef = useRef<HTMLButtonElement | null>(null);
  const allLevelsCheckboxRef = useRef<HTMLInputElement | null>(null);
  const previousClearOpenRef = useRef(false);
  const previousReplaceOpenRef = useRef(false);
  const focusAfterMutationRef = useRef(false);
  const replaceSourceOpen = replaceSourceCandidate !== null;

  useLayoutEffect(() => {
    if (allLevelsCheckboxRef.current !== null) {
      allLevelsCheckboxRef.current.indeterminate =
        selectedLevels.length > 0 &&
        selectedLevels.length < configuredLevels.length;
    }
  }, [configuredLevels.length, selectedLevels]);

  useLayoutEffect(() => {
    const previouslyOpen = previousClearOpenRef.current;
    previousClearOpenRef.current = clearStagedOpen;
    if (clearStagedOpen && !previouslyOpen) {
      clearDialogRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    } else if (!clearStagedOpen && previouslyOpen) {
      const trigger = clearStagedButtonRef.current;
      if (trigger !== null && !trigger.disabled) trigger.focus();
      else actionBarRef.current?.focus();
    }
  }, [clearStagedOpen]);

  useLayoutEffect(() => {
    const previouslyOpen = previousReplaceOpenRef.current;
    previousReplaceOpenRef.current = replaceSourceOpen;
    if (replaceSourceOpen && !previouslyOpen) {
      replaceDialogRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    } else if (!replaceSourceOpen && previouslyOpen) {
      const trigger = replaceSourceButtonRef.current;
      if (trigger !== null && !trigger.disabled) trigger.focus();
      else actionBarRef.current?.focus();
    }
  }, [replaceSourceOpen]);

  useLayoutEffect(() => {
    if (!focusAfterMutationRef.current) return;
    focusAfterMutationRef.current = false;
    actionBarRef.current?.focus();
  }, [state.drafts, state.selection]);

  const allLevelsSelected = numberArraysEqual(configuredLevels, selectedLevels);
  const levelScopeLabel = allLevelsSelected
    ? "All levels"
    : formatLevelRanges(selectedLevels);
  const selectedSource = state.selection.source;
  const sourceReplacementAvailable =
    batchSource !== null &&
    selectedSource !== null &&
    batchSource !== selectedSource;
  const clearNeedsConfirmation = state.drafts.some(
    ({ status }) => status !== "staged" && status !== "confirmed",
  );
  const takeReady = canTake(state);
  const hasCriticalDraft = state.drafts.some(
    ({ status }) => status === "failed" || status === "conflict",
  );
  const unavailableReason = takeReady ? null : takeUnavailableReason(state);
  const countLabel = stagedCountLabel(counts.mappings);
  const takeLabel = `Take ${String(counts.mappings)} ${counts.mappings === 1 ? "route" : "routes"}`;
  const selectedSourceName =
    selectedSource === null
      ? null
      : sourceDisplayName(sourceLabels, selectedSource);
  const replacementSourceName =
    replaceSourceCandidate === null
      ? null
      : sourceDisplayName(sourceLabels, replaceSourceCandidate);

  return (
    <footer
      className="router-action-bar"
      aria-label="Router staging controls"
      ref={actionBarRef}
      tabIndex={-1}
    >
      <div className="router-action-primary">
        <button
          className="router-control-button"
          type="button"
          disabled={
            state.selection.source === null &&
            state.selection.destination === null
          }
          onClick={() => {
            focusAfterMutationRef.current = true;
            router.clearSelection();
          }}
        >
          Clear selection
        </button>
        <button
          className="router-control-button"
          type="button"
          ref={clearStagedButtonRef}
          disabled={!truthReady || state.drafts.length === 0}
          onClick={() => {
            onReplaceSourceCandidateChange(null);
            if (clearNeedsConfirmation) onClearStagedOpenChange(true);
            else {
              focusAfterMutationRef.current = true;
              router.clearStaged();
            }
          }}
        >
          Clear staged
        </button>
        {showsLevels ? (
          <div className="router-level-selector">
            <button
              className="router-control-button"
              type="button"
              ref={levelSelectorButtonRef}
              disabled={!truthReady}
              aria-expanded={levelSelectorOpen}
              aria-controls="router-level-selector-panel"
              onClick={() => {
                onLevelSelectorOpenChange(!levelSelectorOpen);
              }}
            >
              Route: {levelScopeLabel}
            </button>
            {levelSelectorOpen ? (
              <fieldset
                id="router-level-selector-panel"
                className="router-level-selector-panel"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onLevelSelectorOpenChange(false);
                  queueMicrotask(() => {
                    levelSelectorButtonRef.current?.focus();
                  });
                }}
              >
                <legend>Routing levels</legend>
                <label className="router-level-all">
                  <input
                    type="checkbox"
                    ref={allLevelsCheckboxRef}
                    checked={allLevelsSelected}
                    onChange={(event) => {
                      onSelectedLevelsChange(
                        event.currentTarget.checked ? configuredLevels : [],
                      );
                    }}
                  />
                  All levels
                </label>
                <div className="router-level-options">
                  {configuredLevels.map((level) => (
                    <label key={level}>
                      <input
                        type="checkbox"
                        checked={selectedLevels.includes(level)}
                        onChange={(event) => {
                          onToggleLevel(level, event.currentTarget.checked);
                        }}
                      />
                      Level {level}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="router-batch-summary">
        {sourceReplacementAvailable && selectedSourceName !== null ? (
          <button
            className="router-link-button"
            type="button"
            disabled={
              !truthReady ||
              state.drafts.some((draft) =>
                draft.targets.some(
                  ({ status }) =>
                    status === "submitting" || status === "pending",
                ),
              )
            }
            onClick={() => {
              onClearStagedOpenChange(false);
              onReplaceSourceCandidateChange(selectedSource);
            }}
            ref={replaceSourceButtonRef}
          >
            Replace staged source with {selectedSourceName}
          </button>
        ) : null}
      </div>

      <div className="router-take-summary">
        <span className="router-count-summary">{countLabel}</span>
        {unavailableReason === null ? null : (
          <span className="router-take-reason">
            {unavailableReason} · Take unavailable
          </span>
        )}
      </div>
      <button
        className="router-take-button"
        type="button"
        disabled={!takeReady}
        onClick={() => {
          focusAfterMutationRef.current = true;
          void router.submitTake();
        }}
      >
        {takeLabel}
      </button>

      <div className="router-visually-hidden" role="status" aria-live="polite">
        {hasCriticalDraft
          ? ""
          : `Router staging update: ${draftStatusAnnouncement(state.drafts)}`}
      </div>
      {hasCriticalDraft ? (
        <div
          className="router-visually-hidden"
          role="alert"
          aria-live="assertive"
        >
          {draftStatusAnnouncement(state.drafts)}
        </div>
      ) : null}

      {replaceSourceOpen || clearStagedOpen ? (
        <div className="router-confirmation-scrim" aria-hidden="true" />
      ) : null}

      {replaceSourceOpen && replacementSourceName !== null ? (
        <div
          className="router-action-confirmation"
          role="alertdialog"
          aria-labelledby="router-replace-source-title"
          aria-describedby="router-replace-source-description"
          aria-modal="true"
          ref={replaceDialogRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            handleConfirmationDialogKeyDown(event, () => {
              onReplaceSourceCandidateChange(null);
            });
          }}
        >
          <strong id="router-replace-source-title">
            Replace staged source
          </strong>
          <span id="router-replace-source-description">
            {counts.mappings} {counts.mappings === 1 ? "route" : "routes"} will
            use {replacementSourceName}.
          </span>
          <div>
            <button
              type="button"
              onClick={() => {
                onReplaceSourceCandidateChange(null);
              }}
            >
              Keep source
            </button>
            <button
              type="button"
              onClick={() => {
                onReplaceSourceCandidateChange(null);
                router.replaceStagedSource(replaceSourceCandidate);
              }}
            >
              Replace source
            </button>
          </div>
        </div>
      ) : null}

      {clearStagedOpen ? (
        <div
          className="router-action-confirmation"
          role="alertdialog"
          aria-labelledby="router-clear-staged-title"
          aria-describedby="router-clear-staged-description"
          aria-modal="true"
          ref={clearDialogRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            handleConfirmationDialogKeyDown(event, () => {
              onClearStagedOpenChange(false);
            });
          }}
        >
          <strong id="router-clear-staged-title">Clear staged routes</strong>
          <span id="router-clear-staged-description">
            Clear {pendingDraftLabel(state.drafts)}? Dispatch results will
            remain in the status log.
          </span>
          <div>
            <button
              type="button"
              onClick={() => {
                onClearStagedOpenChange(false);
              }}
            >
              Keep staged
            </button>
            <button
              type="button"
              onClick={() => {
                onClearStagedOpenChange(false);
                router.clearStaged();
              }}
            >
              Clear staged
            </button>
          </div>
        </div>
      ) : null}
    </footer>
  );
}

function RouterPhaseStatus({
  state,
  status,
}: {
  readonly state: RouterState | null;
  readonly status: RouterConnection["status"];
}): React.JSX.Element {
  const presentation = routerPhasePresentation(state, status);
  return (
    <output
      className="router-phase-status"
      aria-label="Router status"
      data-state={presentation.state}
    >
      <span className="router-status-mark" aria-hidden="true" />
      <span>{presentation.label}</span>
    </output>
  );
}

function routerPhasePresentation(
  state: RouterState | null,
  status: RouterConnection["status"],
): { readonly label: string; readonly state: string } {
  if (status === "inactive") return { label: "Inactive", state: "inactive" };
  if (status === "connecting")
    return { label: "Opening route stream", state: "loading" };
  if (status === "failed")
    return { label: "Route stream unavailable", state: "failed" };
  if (state === null)
    return { label: "Waiting for route truth", state: "loading" };
  if (connectionPresentationStatus(state.transport) === "reconnecting") {
    if (state.sync === "ready" && !state.resyncRequired) {
      return {
        label: "Routes current · controls reconnecting",
        state: "warning",
      };
    }
    return {
      label: "Reconnecting to Router · route truth stale",
      state: "reconnecting",
    };
  }
  if (state.resyncRequired || state.sync === "synchronizing") {
    return { label: "Synchronizing route truth", state: "loading" };
  }
  if (state.sync === "degraded") {
    return {
      label: `Degraded · rev ${String(state.version.revision)}`,
      state: "failed",
    };
  }
  if (state.sync === "stale") {
    return {
      label: `Stale · rev ${String(state.version.revision)}`,
      state: "stale",
    };
  }
  const labelHealth = state.labels === "ready" ? "" : " · cached labels";
  return {
    label: `Ready · rev ${String(state.version.revision)}${labelHealth}`,
    state: state.labels === "ready" ? "ready" : "warning",
  };
}

function sourceListModel(
  state: RouterState,
  search: string | null,
): RouterListModel<RouterSourceEntry> {
  const pages = contiguousPageWindow(
    state.pages.sources.filter(
      ({ query, page }) =>
        query.resource === "sources" &&
        page.resource === "sources" &&
        query.search === search,
    ),
  );
  const rows = new Map<number, RouterSourceEntry>();
  for (const { page } of pages) {
    if (page.resource !== "sources") continue;
    for (const entry of page.entries)
      rows.set(entry.address, state.sources.get(entry.address) ?? entry);
  }
  return {
    items: [...rows.values()],
    totalCount: pages[0]?.page.totalCount ?? state.knownSourceCount,
    hasPage: pages.length > 0,
    hasMore:
      pages.length === 0
        ? state.knownSourceCount > 0
        : pages.at(-1)?.page.nextAfterAddress !== null,
    itemOffset: pages[0]?.offset ?? 0,
    nextAfterAddress: pages.at(-1)?.page.nextAfterAddress ?? null,
  };
}

function destinationListModel(
  state: RouterState,
  search: string | null,
  source: number | null,
  levels: readonly number[],
): RouterListModel<RouterDestinationEntry> {
  const filteredLevels = levels.length === 0 ? null : new Set(levels);
  const pages = contiguousPageWindow(
    state.pages.destinations.filter(
      ({ query, page }) =>
        query.resource === "destinations" &&
        page.resource === "destinations" &&
        query.search === search &&
        query.source === source &&
        numberArraysEqual(query.levels, levels),
    ),
  );
  const rows = new Map<number, RouterDestinationEntry>();
  for (const { page } of pages) {
    if (page.resource !== "destinations") continue;
    for (const entry of page.entries) {
      if (
        source !== null &&
        !destinationStillMatchesSourceFilter(
          state,
          entry,
          source,
          filteredLevels,
        )
      ) {
        continue;
      }
      rows.set(entry.address, state.destinations.get(entry.address) ?? entry);
    }
  }
  return {
    items: [...rows.values()],
    totalCount: pages[0]?.page.totalCount ?? state.knownDestinationCount,
    hasPage: pages.length > 0,
    hasMore:
      pages.length === 0
        ? state.knownDestinationCount > 0
        : pages.at(-1)?.page.nextAfterAddress !== null,
    itemOffset: pages[0]?.offset ?? 0,
    nextAfterAddress: pages.at(-1)?.page.nextAfterAddress ?? null,
  };
}

function destinationStillMatchesSourceFilter(
  state: RouterState,
  loaded: RouterDestinationEntry,
  source: number,
  levels: ReadonlySet<number> | null,
): boolean {
  const live = state.destinations.get(loaded.address);
  if (live === undefined) return true;
  const levelMatches = (level: number): boolean =>
    levels === null || levels.has(level);
  if (
    live.routes.some(
      (route) => levelMatches(route.level) && route.source === source,
    )
  ) {
    return true;
  }

  const previouslyMatchingLevels = loaded.routes
    .filter((route) => levelMatches(route.level) && route.source === source)
    .map(({ level }) => level);
  return previouslyMatchingLevels.some(
    (level) => live.routes.get(level) === undefined,
  );
}

function contiguousPageWindow(
  pages: readonly RouterLoadedPage[],
): readonly RouterLoadedPage[] {
  if (pages.length < 2) return pages;
  const ordered = [...pages].sort((left, right) => left.offset - right.offset);
  const contiguous: RouterLoadedPage[] = [ordered.at(-1) as RouterLoadedPage];
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const page = ordered[index];
    const next = contiguous[0];
    if (
      page === undefined ||
      next === undefined ||
      page.offset + page.page.entries.length !== next.offset
    ) {
      break;
    }
    contiguous.unshift(page);
  }
  return contiguous;
}

function destinationForAddress(
  state: RouterState,
  address: number,
): RouterDestinationEntry | undefined {
  const live = state.destinations.get(address);
  if (live !== undefined) return live;
  for (
    let index = state.pages.destinations.length - 1;
    index >= 0;
    index -= 1
  ) {
    const page = state.pages.destinations[index]?.page;
    if (page?.resource !== "destinations") continue;
    const entry = page.entries.find(
      (candidate) => candidate.address === address,
    );
    if (entry !== undefined) return entry;
  }
  return undefined;
}

function sourceLabelMap(
  state: RouterState,
): ReadonlyMap<number, string | null> {
  const labels = new Map<number, string | null>();
  for (const { page } of state.pages.sources) {
    if (page.resource !== "sources") continue;
    for (const entry of page.entries) labels.set(entry.address, entry.label);
  }
  for (const [address, source] of state.sources)
    labels.set(address, source.label);
  return labels;
}

function sourceRouteDeltaMap(
  state: RouterState,
  visibleLevels: readonly number[],
): ReadonlyMap<number, SourceRouteDelta> {
  const additions = new Map<number, Map<number, RouterRouteDeltaEndpoint>>();
  const removals = new Map<number, Map<number, RouterRouteDeltaEndpoint>>();

  const addDelta = (
    collection: Map<number, Map<number, RouterRouteDeltaEndpoint>>,
    source: number,
    destination: number,
  ): void => {
    const destinations =
      collection.get(source) ?? new Map<number, RouterRouteDeltaEndpoint>();
    destinations.set(destination, {
      address: destination,
      name: destinationDisplayName(state, destination),
    });
    collection.set(source, destinations);
  };

  for (const draft of state.drafts) {
    if (draft.levels.some((level) => visibleLevels.includes(level))) {
      addDelta(additions, draft.source, draft.destination);
    }
    for (const { level, source } of draft.expected) {
      if (!visibleLevels.includes(level)) continue;
      if (source !== draft.source)
        addDelta(removals, source, draft.destination);
    }
  }

  const deltas = new Map<number, SourceRouteDelta>();
  for (const source of new Set([...additions.keys(), ...removals.keys()])) {
    const byAddress = (
      values: Map<number, RouterRouteDeltaEndpoint> | undefined,
    ): readonly RouterRouteDeltaEndpoint[] =>
      [...(values?.values() ?? [])].sort(
        (left, right) => left.address - right.address,
      );
    deltas.set(source, {
      additions: byAddress(additions.get(source)),
      removals: byAddress(removals.get(source)),
    });
  }
  return deltas;
}

function sourceRouteDestinationMap(
  state: RouterState,
  visibleLevels: readonly number[],
): ReadonlyMap<number, readonly RouterRouteDeltaEndpoint[]> {
  const destinationsBySource = new Map<
    number,
    readonly RouterRouteDeltaEndpoint[]
  >();
  for (const [source, routesByLevel] of state.reverseRoutes) {
    const destinations = new Set<number>();
    for (const level of visibleLevels) {
      for (const destination of routesByLevel.get(level) ?? [])
        destinations.add(destination);
    }
    destinationsBySource.set(
      source,
      [...destinations]
        .sort((left, right) => left - right)
        .map((address) => ({
          address,
          name: destinationDisplayName(state, address),
        })),
    );
  }
  return destinationsBySource;
}

function destinationSummaryForEntry(
  destination: RouterDestinationEntry,
  visibleLevels: readonly number[],
):
  | { readonly kind: "unknown" }
  | { readonly kind: "uniform"; readonly source: number }
  | {
      readonly kind: "partial";
      readonly knownLevels: number;
      readonly totalLevels: number;
      readonly sources: readonly number[];
    }
  | { readonly kind: "mixed"; readonly sources: readonly number[] } {
  const routes = destination.routes.filter(({ level }) =>
    visibleLevels.includes(level),
  );
  if (routes.length === 0) return { kind: "unknown" };
  const knownLevels = new Set(routes.map(({ level }) => level)).size;
  const sources = [...new Set(routes.map(({ source }) => source))].sort(
    (left, right) => left - right,
  );
  if (knownLevels < visibleLevels.length) {
    return {
      kind: "partial",
      knownLevels,
      totalLevels: visibleLevels.length,
      sources,
    };
  }
  if (sources.length === 1)
    return { kind: "uniform", source: sources[0] as number };
  return { kind: "mixed", sources };
}

function destinationRouteTruthLabel(
  destination: RouterDestinationEntry,
  visibleLevels: readonly number[],
  sourceLabels: ReadonlyMap<number, string | null>,
  truthReady = true,
  showsLevels = true,
): string {
  const routesByLevel = new Map(
    destination.routes.map((route) => [route.level, route.source]),
  );
  if (!showsLevels) {
    const source =
      visibleLevels[0] === undefined
        ? undefined
        : routesByLevel.get(visibleLevels[0]);
    const prefix = truthReady
      ? "Current route"
      : "Route truth is stale. Last observed route";
    return source === undefined
      ? `${prefix}: unknown`
      : `${prefix}: ${sourceDisplayName(sourceLabels, source)}, source address ${String(source)}`;
  }
  const prefix = truthReady
    ? "Current routes"
    : "Route truth is stale. Last observed routes";
  return `${prefix}: ${visibleLevels
    .map((level): string => {
      const source = routesByLevel.get(level);
      return source === undefined
        ? `Level ${String(level)}, unknown`
        : `Level ${String(level)}, ${sourceDisplayName(
            sourceLabels,
            source,
          )}, source address ${String(source)}`;
    })
    .join("; ")}`;
}

function destinationDisplayName(state: RouterState, address: number): string {
  return (
    destinationForAddress(state, address)?.label ??
    `Destination ${String(address)}`
  );
}

function routeSourceSummary(
  sources: readonly (number | null)[],
  sourceLabels: ReadonlyMap<number, string | null>,
): string {
  const known = [
    ...new Set(sources.filter((source): source is number => source !== null)),
  ].sort((left, right) => left - right);
  if (known.length === 0) return "Unknown route truth";
  if (known.length === 1 && !sources.includes(null)) {
    const source = known[0] as number;
    return `${sourceDisplayName(sourceLabels, source)} · ${String(source)}`;
  }
  const names = known
    .map(
      (source) =>
        `${sourceDisplayName(sourceLabels, source)} · ${String(source)}`,
    )
    .join(" + ");
  return sources.includes(null) ? `Partial · ${names}` : names;
}

function formatLevelRanges(levelsValue: readonly number[]): string {
  const levels = [...new Set(levelsValue)].sort((left, right) => left - right);
  if (levels.length === 0) return "No levels";
  const ranges: string[] = [];
  let start = levels[0] as number;
  let end = start;
  for (const level of levels.slice(1)) {
    if (level === end + 1) {
      end = level;
      continue;
    }
    ranges.push(
      start === end ? `L${String(start)}` : `L${String(start)}–${String(end)}`,
    );
    start = level;
    end = level;
  }
  ranges.push(
    start === end ? `L${String(start)}` : `L${String(start)}–${String(end)}`,
  );
  return ranges.join(", ");
}

function draftStatusLabel(status: RouterDraftMapping["status"]): string {
  switch (status) {
    case "staged":
      return "Staged";
    case "submitting":
      return "Submitting";
    case "pending":
      return "Pending confirmation";
    case "confirmed":
      return "Confirmed";
    case "conflict":
      return "Conflict";
    case "failed":
      return "Failed";
    case "unconfirmed":
      return "Unconfirmed";
    case "stale":
      return "Stale";
  }
}

function draftActivityLabel(draft: RouterDraftMapping): string {
  const counts = new Map<
    RouterDraftMapping["targets"][number]["status"],
    number
  >();
  for (const target of draft.targets) {
    counts.set(target.status, (counts.get(target.status) ?? 0) + 1);
  }
  if (counts.size <= 1) return draftStatusLabel(draft.status);
  return [...counts.entries()]
    .map(
      ([status, count]) =>
        `${String(count)} ${compactTargetStatusLabel(status)}`,
    )
    .join(" · ");
}

function compactTargetStatusLabel(
  status: RouterDraftMapping["targets"][number]["status"],
): string {
  return status === "pending" ? "pending" : status;
}

function dispatchOutcomeLabel(outcome: string | null): string {
  if (outcome === null) return "Not dispatched";
  return outcome
    .split("_")
    .map((word) => `${word.slice(0, 1).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function stagedCountLabel(mappings: number): string {
  return `${String(mappings)} ${mappings === 1 ? "route" : "routes"} staged`;
}

function takeUnavailableReason(state: RouterState): string {
  if (state.transport !== "connected")
    return connectionPresentationLabel(state.transport);
  if (state.sync !== "ready" || state.resyncRequired)
    return "Route truth is stale";
  if (state.drafts.length === 0) return "No routes staged";
  if (
    state.drafts.some((draft) =>
      draft.levels.some(
        (level) => sourceAt(state, draft.destination, level) === null,
      ),
    )
  ) {
    return "Unknown route truth";
  }
  if (state.drafts.some(({ status }) => status === "conflict"))
    return "Conflict";
  if (state.drafts.some(({ status }) => status === "submitting"))
    return "Take in progress";
  if (state.drafts.some(({ status }) => status === "pending"))
    return "Confirmation pending";
  if (state.drafts.some(({ status }) => status === "failed"))
    return "Failed route requires review";
  if (state.drafts.some(({ status }) => status === "unconfirmed")) {
    return "Unconfirmed route requires review";
  }
  if (
    state.drafts.some(
      ({ baselineGeneration }) =>
        baselineGeneration !== state.version.generation,
    )
  ) {
    return "Stale route baseline";
  }
  return "Review staged routes";
}

function draftStatusAnnouncement(
  drafts: readonly RouterDraftMapping[],
): string {
  if (drafts.length === 0) return "No routes staged";
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    const label = draftStatusLabel(draft.status);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => `${String(count)} ${label.toLocaleLowerCase()}`)
    .join(", ");
}

function pendingDraftLabel(drafts: readonly RouterDraftMapping[]): string {
  const pending = drafts.filter(
    ({ status }) => status === "pending" || status === "submitting",
  );
  const count = pending.length > 0 ? pending.length : drafts.length;
  const qualifier = pending.length > 0 ? "pending " : "";
  return `${String(count)} ${qualifier}${count === 1 ? "route" : "routes"}`;
}

function numberArraysEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function handleConfirmationDialogKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onDismiss: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  ];
  if (focusable.length === 0) return;
  const first = focusable[0] as HTMLButtonElement;
  const last = focusable.at(-1) as HTMLButtonElement;
  const active = event.currentTarget.ownerDocument.activeElement;
  if (
    event.shiftKey &&
    (active === first || !event.currentTarget.contains(active))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !event.currentTarget.contains(active))
  ) {
    event.preventDefault();
    first.focus();
  }
}

function normalizedSearch(value: string): string | null {
  const normalized = sanitizeSearchInput(value).trim();
  return normalized.length === 0 ? null : normalized;
}

function sanitizeSearchInput(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, "")
    .slice(0, MAX_ROUTER_SEARCH_LENGTH);
}

function destinationPageLimit(levels: number): number {
  const safeLevels = Math.max(1, Math.floor(levels));
  return Math.max(
    1,
    Math.min(
      MAX_ROUTER_PAGE_ENTRIES,
      Math.floor(MAX_ROUTER_BOOTSTRAP_CROSSPOINTS / safeLevels),
    ),
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

function sourceDisplayName(
  sourceLabels: ReadonlyMap<number, string | null>,
  address: number,
): string {
  return sourceLabels.get(address) ?? `Source ${String(address)}`;
}

function routeTruthIsReady(state: RouterState): boolean {
  return state.sync === "ready" && !state.resyncRequired;
}

function pageRequestIdentity(
  state: RouterState,
  resource: "sources" | "destinations",
  query: {
    readonly levels: readonly number[];
    readonly search: string | null;
    readonly source: number | null;
  },
): string {
  return [
    state.connectionId,
    state.version.generation,
    String(state.version.revision),
    String(state.labelRevision),
    resource,
    query.search ?? "",
    String(query.source ?? ""),
    query.levels.join(","),
  ].join(":");
}

function pageListIdentity(
  state: RouterState,
  resource: "sources" | "destinations",
  query: {
    readonly levels: readonly number[];
    readonly search: string | null;
    readonly source: number | null;
  },
): string {
  return [
    state.connectionId,
    state.version.generation,
    resource,
    query.search ?? "",
    String(query.source ?? ""),
    query.levels.join(","),
  ].join(":");
}

function useFilteredDestinationReload(
  enabled: boolean,
  generation: string,
  revision: number,
  loadPage: (afterAddress: number | null) => Promise<void>,
): void {
  const latestRef = useRef({ enabled, generation, loadPage, revision });
  const versionRef = useRef({ generation, revision });
  const activeRef = useRef(false);
  const trailingRef = useRef(false);
  const disposedRef = useRef(false);

  useLayoutEffect(() => {
    latestRef.current = { enabled, generation, loadPage, revision };
  }, [enabled, generation, loadPage, revision]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      trailingRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previous = versionRef.current;
    versionRef.current = { generation, revision };
    if (
      !enabled ||
      previous.generation !== generation ||
      previous.revision === revision
    ) {
      if (!enabled || previous.generation !== generation)
        trailingRef.current = false;
      return;
    }

    trailingRef.current = true;
    const timeout = window.setTimeout(() => {
      if (activeRef.current || disposedRef.current) return;
      activeRef.current = true;
      void (async () => {
        try {
          while (
            trailingRef.current &&
            latestRef.current.enabled &&
            !disposedRef.current
          ) {
            trailingRef.current = false;
            await latestRef.current.loadPage(null).catch(() => undefined);
          }
        } finally {
          activeRef.current = false;
        }
      })();
    }, ROUTER_FILTER_REFRESH_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [enabled, generation, loadPage, revision]);
}

function useRouterPageLoader(
  identity: string,
  requestPage: (afterAddress: number | null) => Promise<void>,
): {
  readonly failedAfterAddress: number | null;
  readonly loadPage: (afterAddress: number | null) => Promise<void>;
  readonly phase: RouterPageLoadPhase;
} {
  const latestRequestRef = useRef({ identity, requestPage });
  useLayoutEffect(() => {
    latestRequestRef.current = { identity, requestPage };
  }, [identity, requestPage]);
  const inFlightRef = useRef(new Map<string, Promise<void>>());
  const [loadState, setLoadState] = useState<RouterPageLoadState>({
    afterAddress: null,
    identity,
    phase: "idle",
  });

  const loadPage = useCallback((afterAddress: number | null): Promise<void> => {
    const current = latestRequestRef.current;
    const requestKey = `${current.identity}:${String(afterAddress ?? "")}`;
    const existing = inFlightRef.current.get(requestKey);
    if (existing !== undefined) return existing;

    setLoadState({
      afterAddress,
      identity: current.identity,
      phase: "loading",
    });
    const request = current.requestPage(afterAddress).then(
      () => {
        if (latestRequestRef.current.identity === current.identity) {
          setLoadState({
            afterAddress: null,
            identity: current.identity,
            phase: "idle",
          });
        }
      },
      (error: unknown) => {
        if (latestRequestRef.current.identity === current.identity) {
          setLoadState({
            afterAddress,
            identity: current.identity,
            phase: "failed",
          });
        }
        throw error;
      },
    );
    inFlightRef.current.set(requestKey, request);
    void request.then(
      () => {
        if (inFlightRef.current.get(requestKey) === request)
          inFlightRef.current.delete(requestKey);
      },
      () => {
        if (inFlightRef.current.get(requestKey) === request)
          inFlightRef.current.delete(requestKey);
      },
    );
    return request;
  }, []);

  return {
    failedAfterAddress:
      loadState.identity === identity && loadState.phase === "failed"
        ? loadState.afterAddress
        : null,
    loadPage,
    phase: loadState.identity === identity ? loadState.phase : "idle",
  };
}

function useCoalescedFirstPageReload(
  enabled: boolean,
  identity: string,
  loadPage: (afterAddress: number | null) => Promise<void>,
): void {
  const latestRef = useRef({ enabled, identity, loadPage });
  useLayoutEffect(() => {
    latestRef.current = { enabled, identity, loadPage };
  }, [enabled, identity, loadPage]);
  const activeRef = useRef(false);
  const processedIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      processedIdentityRef.current = null;
      return;
    }
    if (processedIdentityRef.current === identity || activeRef.current) return;

    const drain = async (): Promise<void> => {
      if (activeRef.current) return;
      activeRef.current = true;
      try {
        while (latestRef.current.enabled) {
          const current = latestRef.current;
          if (processedIdentityRef.current === current.identity) break;
          processedIdentityRef.current = current.identity;
          try {
            await current.loadPage(null);
          } catch {
            // The loader exposes failure state and an explicit retry. Keep the
            // live Router session running and do not spin on the same stamp.
          }
        }
      } finally {
        activeRef.current = false;
      }
    };
    void drain();
  }, [enabled, identity]);
}

function isEnabledOperatingRouterConnection(
  connection: ConnectionView,
): connection is OperatingRouterConnectionView {
  return (
    connection.enabled &&
    (connection.type === "ross-ultrix-ogp" ||
      connection.type === "evertz-quartz" ||
      connection.type === "blackmagic-videohub" ||
      connection.type === "aja-kumo")
  );
}
