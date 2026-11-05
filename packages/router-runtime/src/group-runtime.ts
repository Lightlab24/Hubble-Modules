import {
  stepOrderedListIndex,
  type ButtonRotationStep,
} from "@hubble/module-contracts/interaction";
import type {
  ManagedRouterConnectionSnapshot,
  RouterConfirmedRouteTargetSnapshot,
  RouterDirectRouteInput,
  RouterDirectRouteSubmission,
} from "./connection-contract.js";

export interface RossRouteGroupModuleScope {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly connectionId: string;
  readonly automaticTake: boolean;
  readonly groupIds: readonly string[];
  /**
   * Lets configuration reconciliation retain a disabled router module. When
   * omitted, the runtime resolves the count from the live physical manager.
   */
  readonly levelCount?: number;
}

export interface RossRouteGroupActionScope {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly connectionId: string;
  readonly groupId: string | null;
}

export interface RossRouteGroupSelectSourceInput extends RossRouteGroupActionScope {
  readonly source: number;
  readonly levels?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface RossRouteGroupSelectDestinationInput extends RossRouteGroupActionScope {
  readonly destination: number;
  readonly signal?: AbortSignal;
}

export interface RossRouteGroupCycleDestinationInput extends RossRouteGroupActionScope {
  readonly destinations: readonly number[];
  readonly step: ButtonRotationStep;
  readonly wrap: boolean;
}

export interface RossRouteGroupTakeInput extends RossRouteGroupActionScope {
  readonly levels?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface RossRouteGroupToggleEnabledInput extends Omit<
  RossRouteGroupActionScope,
  "groupId"
> {
  readonly groupId: string;
}

export interface RossGroupRouteClaim {
  readonly source: number;
  readonly destination: number;
  readonly levels: readonly number[];
  readonly takeSequence: number | null;
  readonly origin: "take" | "automatic-take" | "passive-readback";
}

export interface RossGroupRuntimeSnapshot extends RossRouteGroupActionScope {
  readonly enabled: boolean;
  readonly automaticTake: boolean;
  /** True only for an intentional local stage while Automatic Take is disabled. */
  readonly manualStageActive: boolean;
  readonly stagedSource: number | null;
  readonly stagedLevels: readonly number[];
  readonly selectedDestination: number | null;
  /** The latest confirmed ownership claim, including a claim staged on another destination. */
  readonly routeClaim: RossGroupRouteClaim | null;
  /** A live, destination-gated claim that feedback may arbitrate. */
  readonly feedbackClaim: RossGroupRouteClaim | null;
  readonly pendingRouteClaims: ReadonlyMap<number, RossGroupRouteClaim>;
  readonly confirmedRoute: RouterConfirmedRouteTargetSnapshot | null;
  readonly moduleSequenceHighWaterMark: number;
}

export type RossRouteGroupRuntimeListener = (
  snapshots: readonly RossGroupRuntimeSnapshot[],
) => void;

export interface PersistedRossRouteGroupRuntimeState extends RossRouteGroupActionScope {
  /** Missing in schema-v1 documents written before runtime group toggles existed. */
  readonly enabled?: boolean;
  readonly selectedDestination: number | null;
  readonly levels: readonly number[];
  readonly committedTakeSequence: number | null;
}

export interface PersistedRossRouteModuleSequenceRuntimeState {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly moduleSequenceHighWaterMark: number;
}

export interface RossRouteGroupStateTransitionBase {
  readonly streamId: string;
  readonly sequence: number;
  readonly transitionId: string;
}

export type RossRouteGroupStateTransition =
  | (RossRouteGroupStateTransitionBase &
      Readonly<{
        operation: "move";
        workspaceId: string;
        moduleConnectionId: string;
        fromGroupId: string | null;
        toGroupId: string | null;
      }>)
  | (RossRouteGroupStateTransitionBase &
      Readonly<{
        operation: "discard-group";
        workspaceId: string;
        moduleConnectionId: string;
        groupId: string;
      }>)
  | (RossRouteGroupStateTransitionBase &
      Readonly<{
        operation: "discard-module";
        workspaceId: string;
        moduleConnectionId: string;
      }>)
  | (RossRouteGroupStateTransitionBase &
      Readonly<{
        operation: "discard-workspace";
        workspaceId: string;
      }>);

export interface RossGroupRuntimeStateStore {
  snapshot(): Promise<readonly PersistedRossRouteGroupRuntimeState[]>;
  moduleSnapshot(): Promise<
    readonly PersistedRossRouteModuleSequenceRuntimeState[]
  >;
  upsert(state: PersistedRossRouteGroupRuntimeState): Promise<void>;
  upsertModuleSequenceState(
    state: PersistedRossRouteModuleSequenceRuntimeState,
  ): Promise<void>;
  clearWorkspace(workspaceId: string): Promise<void>;
  reconcileScopes(
    scopes: readonly {
      readonly workspaceId: string;
      readonly moduleConnectionId: string;
      readonly groupIds: readonly string[];
    }[],
    workspaceIds?: readonly string[],
  ): Promise<void>;
  applyTransition(
    transition: RossRouteGroupStateTransition,
  ): Promise<"applied" | "already-applied">;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface RossRouteGroupConnectionManager {
  snapshots(): readonly ManagedRouterConnectionSnapshot[];
  submitDirectRouteTracked(
    input: RouterDirectRouteInput,
  ): RouterDirectRouteSubmission;
  watchConfirmedRouteTarget(
    target: {
      readonly connectionId: string;
      readonly destination: number;
      readonly levels: readonly number[];
    },
    listener: (snapshot: RouterConfirmedRouteTargetSnapshot) => void,
  ): () => void;
}

export interface RossRouteGroupRuntimeDiagnostic {
  readonly code:
    | "ross_route_group_state_read_failed"
    | "ross_route_group_state_write_failed"
    | "ross_route_group_state_transition_failed"
    | "ross_route_group_route_settlement_failed"
    | "ross_route_group_watch_failed";
  readonly message: string;
  readonly workspaceId?: string;
  readonly moduleConnectionId?: string;
  readonly groupId?: string | null;
  readonly takeSequence?: number;
  readonly submissionId?: string;
}

export interface RossRouteGroupRuntimeOptions {
  readonly connections: RossRouteGroupConnectionManager;
  readonly stateStore: RossGroupRuntimeStateStore;
  readonly onDiagnostic?: (diagnostic: RossRouteGroupRuntimeDiagnostic) => void;
}

export interface RouterDestinationDefault extends RossRouteGroupActionScope {
  readonly destinations: readonly number[];
  readonly editedDestination?: number;
}

export interface RossRouteGroupRuntimeContract {
  reconcile(
    scopes: readonly RossRouteGroupModuleScope[],
    workspaceId?: string,
  ): Promise<void>;
  selectSource(input: RossRouteGroupSelectSourceInput): Promise<void>;
  selectDestination(input: RossRouteGroupSelectDestinationInput): Promise<void>;
  cycleDestination(input: RossRouteGroupCycleDestinationInput): Promise<void>;
  take(input: RossRouteGroupTakeInput): Promise<void>;
  toggleGroupEnabled(input: RossRouteGroupToggleEnabledInput): Promise<void>;
  snapshots(): readonly RossGroupRuntimeSnapshot[];
  subscribe(listener: RossRouteGroupRuntimeListener): () => void;
  applyTransition(
    transition: RossRouteGroupStateTransition,
  ): Promise<"applied" | "already-applied">;
  clearWorkspace(workspaceId: string): Promise<void>;
  stop(): Promise<void>;
}

interface NormalizedModuleScope {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly connectionId: string;
  readonly automaticTake: boolean;
  readonly groupIds: readonly string[];
  readonly levelCount: number;
  readonly connectionFingerprint: string | null;
}

interface PendingRouteClaim {
  readonly claim: RossGroupRouteClaim;
  readonly destinationSelectionEpoch: number;
  settled: boolean;
  submissionId: string | null;
}

interface MutableGroupState {
  readonly module: MutableModuleState;
  groupId: string | null;
  enabled: boolean;
  toggleInProgress: boolean;
  toggleCompletion: Promise<void> | null;
  persistenceDirtyDuringToggle: boolean;
  persistenceDirtyDuringReservation: boolean;
  stagedSource: number | null;
  stagedLevels: readonly number[];
  intentionalManualStage: boolean;
  selectedDestination: number | null;
  matrixDestinationDefault: boolean;
  destinationSelectionEpoch: number;
  routeClaim: RossGroupRouteClaim | null;
  ownedClaim: RossGroupRouteClaim | null;
  readonly pendingRouteClaims: Map<number, PendingRouteClaim>;
  persistedLevels: readonly number[];
  committedTakeSequence: number | null;
  confirmedRoute: RouterConfirmedRouteTargetSnapshot | null;
  watchDestination: number | null;
  watchLevels: readonly number[];
  watchGeneration: number;
  preserveInitialPending: boolean;
  unsubscribeWatch: () => void;
  /** undefined means passive hydration is allowed; null waits for the first ready fingerprint. */
  passiveBlockedFingerprint: string | null | undefined;
}

interface WorkspaceClearReservation {
  readonly workspaceId: string;
}

interface MutableModuleState {
  scope: NormalizedModuleScope;
  moduleSequenceHighWaterMark: number;
  readonly groups: Map<string, MutableGroupState>;
}

const GENERIC_GROUP_KEY = "generic";

export class RossRouteGroupRuntime implements RossRouteGroupRuntimeContract {
  readonly #connections: RossRouteGroupConnectionManager;
  readonly #stateStore: RossGroupRuntimeStateStore;
  readonly #onDiagnostic:
    | ((diagnostic: RossRouteGroupRuntimeDiagnostic) => void)
    | undefined;
  readonly #modules = new Map<string, MutableModuleState>();
  readonly #listeners = new Set<RossRouteGroupRuntimeListener>();
  readonly #transitionsInProgress = new Set<RossRouteGroupStateTransition>();
  readonly #workspaceClearsInProgress = new Set<WorkspaceClearReservation>();
  #stopped = false;
  #stopPromise: Promise<void> | null = null;

  constructor(options: RossRouteGroupRuntimeOptions) {
    this.#connections = options.connections;
    this.#stateStore = options.stateStore;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async reconcile(
    scopes: readonly RossRouteGroupModuleScope[],
    workspaceId?: string,
  ): Promise<void> {
    this.#assertRunning();
    const normalizedScopes = this.#normalizeScopes(scopes);
    const [persistedGroups, persistedModules] = await Promise.all([
      this.#loadPersistedGroups(),
      this.#loadPersistedModules(),
    ]);
    if (this.#stopped) return;

    const persistedGroupsByKey = new Map(
      persistedGroups.map((state) => [groupStateKey(state), state] as const),
    );
    const persistedModulesByKey = new Map(
      persistedModules.map((state) => [moduleStateKey(state), state] as const),
    );
    const desiredModuleKeys = new Set(normalizedScopes.map(moduleStateKey));
    const reconciledWorkspaceIds = new Set(
      normalizedScopes.map((scope) => scope.workspaceId),
    );
    if (workspaceId !== undefined) reconciledWorkspaceIds.add(workspaceId);
    const reconcileAllWorkspaces = reconciledWorkspaceIds.size === 0;

    for (const [key, module] of this.#modules) {
      if (
        (!reconcileAllWorkspaces &&
          !reconciledWorkspaceIds.has(module.scope.workspaceId)) ||
        desiredModuleKeys.has(key)
      ) {
        continue;
      }
      this.#modules.delete(key);
      this.#disposeModule(module);
    }

    for (const scope of normalizedScopes) {
      const key = moduleStateKey(scope);
      let module = this.#modules.get(key);
      const persistedModuleHighWaterMark =
        persistedModulesByKey.get(key)?.moduleSequenceHighWaterMark ?? 0;
      if (module === undefined) {
        module = {
          scope,
          moduleSequenceHighWaterMark: persistedModuleHighWaterMark,
          groups: new Map(),
        };
        this.#modules.set(key, module);
      } else {
        const connectionChanged =
          module.scope.connectionId !== scope.connectionId ||
          module.scope.connectionFingerprint !== scope.connectionFingerprint;
        module.scope = scope;
        module.moduleSequenceHighWaterMark = Math.max(
          module.moduleSequenceHighWaterMark,
          persistedModuleHighWaterMark,
        );
        if (connectionChanged) {
          for (const state of module.groups.values()) {
            state.pendingRouteClaims.clear();
            state.routeClaim = null;
            state.ownedClaim = null;
            this.#removeWatch(state);
          }
        }
      }

      const desiredGroupIds =
        scope.groupIds.length === 0 ? [null] : [...scope.groupIds];
      const desiredGroupKeys = new Set(desiredGroupIds.map(groupKey));
      for (const [existingKey, state] of module.groups) {
        if (desiredGroupKeys.has(existingKey)) continue;
        module.groups.delete(existingKey);
        this.#disposeGroup(state);
      }

      for (const groupId of desiredGroupIds) {
        const keyForGroup = groupKey(groupId);
        let state = module.groups.get(keyForGroup);
        if (state === undefined) {
          const persisted = persistedGroupsByKey.get(
            groupStateKeyParts(
              scope.workspaceId,
              scope.moduleConnectionId,
              groupId,
            ),
          );
          state = this.#createGroupState(module, groupId, persisted);
          module.groups.set(keyForGroup, state);
        }
        module.moduleSequenceHighWaterMark = Math.max(
          module.moduleSequenceHighWaterMark,
          state.committedTakeSequence ?? 0,
        );
        this.#ensureBaseWatch(state);
      }
    }

    this.#emit();
    try {
      await this.#stateStore.reconcileScopes(
        normalizedScopes.map((scope) => ({
          workspaceId: scope.workspaceId,
          moduleConnectionId: scope.moduleConnectionId,
          groupIds: scope.groupIds,
        })),
        workspaceId === undefined ? undefined : [workspaceId],
      );
    } catch (error: unknown) {
      this.#diagnostic({
        code: "ross_route_group_state_write_failed",
        message: `reconcile scopes failed: ${errorMessage(error)}`,
      });
    }
  }

  selectSource(input: RossRouteGroupSelectSourceInput): Promise<void> {
    input.signal?.throwIfAborted();
    const state = this.#requireGroup(input);
    if (state.toggleInProgress) return toggleInProgressAction();
    if (this.#stateHasReservation(state)) return transitionInProgressAction();
    if (!state.enabled) return disabledGroupAction();
    const levels = canonicalLevels(input.levels, state.module.scope.levelCount);
    state.stagedSource = validateRouterAddress(input.source, "source");
    state.stagedLevels = levels;
    state.intentionalManualStage = !state.module.scope.automaticTake;
    this.#emit();
    if (!state.module.scope.automaticTake) return Promise.resolve();
    const destination = state.selectedDestination;
    if (destination === null) {
      return Promise.reject(
        new Error("Ross selected destination is not configured"),
      );
    }
    return this.#submitRoute(
      state,
      state.stagedSource,
      destination,
      levels,
      "automatic-take",
      input.signal,
    );
  }

  selectDestination(
    input: RossRouteGroupSelectDestinationInput,
  ): Promise<void> {
    input.signal?.throwIfAborted();
    const state = this.#requireGroup(input);
    if (state.toggleInProgress) return toggleInProgressAction();
    if (this.#stateHasReservation(state)) return transitionInProgressAction();
    if (!state.enabled) return disabledGroupAction();
    return this.#applyDestinationSelection(
      state,
      validateRouterAddress(input.destination, "destination"),
      input.signal,
    );
  }

  cycleDestination(input: RossRouteGroupCycleDestinationInput): Promise<void> {
    const state = this.#requireGroup(input);
    if (state.toggleInProgress) return toggleInProgressAction();
    if (this.#stateHasReservation(state)) return transitionInProgressAction();
    if (!state.enabled) return disabledGroupAction();
    const destinations = validateDestinationCycle(input.destinations);
    const selectedIndex =
      state.selectedDestination === null
        ? null
        : destinations.indexOf(state.selectedDestination);
    const nextDestination =
      destinations[
        stepOrderedListIndex(
          destinations.length,
          selectedIndex,
          input.step,
          input.wrap,
        )
      ];
    if (nextDestination === undefined) {
      throw new RangeError("Ross destination cycle must contain a destination");
    }
    if (nextDestination === state.selectedDestination) {
      if (state.matrixDestinationDefault) {
        state.matrixDestinationDefault = false;
        this.#persistGroup(state);
      }
      return Promise.resolve();
    }
    this.#applyDestinationCycle(state, nextDestination, false);
    return Promise.resolve();
  }

  reconcileDestinationDefaults(
    defaults: readonly RouterDestinationDefault[],
  ): void {
    const byGroup = new Map(
      defaults.map((item) => [groupStateKey(item), item]),
    );
    for (const module of this.#modules.values()) {
      for (const state of module.groups.values()) {
        if (
          !state.enabled ||
          state.toggleInProgress ||
          this.#stateHasReservation(state)
        )
          continue;
        const candidate = byGroup.get(
          groupStateKey({ ...module.scope, groupId: state.groupId }),
        );
        const current = state.selectedDestination;
        if (
          candidate?.editedDestination === undefined &&
          current !== null &&
          (!state.matrixDestinationDefault ||
            candidate?.destinations.includes(current))
        )
          continue;
        const destination =
          candidate?.editedDestination ?? candidate?.destinations[0] ?? null;
        if (destination === current) continue;
        if (destination === null) {
          this.#clearGroupRoutingState(state);
          this.#persistGroup(state);
          this.#emit();
        } else {
          this.#applyDestinationCycle(state, destination, true);
        }
      }
    }
  }

  #applyDestinationCycle(
    state: MutableGroupState,
    destination: number,
    matrixDestinationDefault: boolean,
  ): void {
    state.destinationSelectionEpoch += 1;
    state.selectedDestination = destination;
    state.matrixDestinationDefault = matrixDestinationDefault;
    state.stagedSource = null;
    state.intentionalManualStage = false;
    state.routeClaim = null;
    state.ownedClaim = null;
    state.committedTakeSequence = null;
    state.passiveBlockedFingerprint = undefined;
    this.#installWatch(state, this.#passiveLevels(state), false);
    this.#persistGroup(state);
    this.#emit();
  }

  #applyDestinationSelection(
    state: MutableGroupState,
    destination: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const stagedSource = state.stagedSource;
    const stagedLevels = state.stagedLevels;
    if (state.selectedDestination !== destination)
      state.destinationSelectionEpoch += 1;
    state.selectedDestination = destination;
    state.matrixDestinationDefault = false;
    state.passiveBlockedFingerprint = undefined;
    this.#installWatch(state, this.#passiveLevels(state), true);
    this.#persistGroup(state);
    this.#emit();
    if (!state.module.scope.automaticTake) return Promise.resolve();
    if (stagedSource === null) {
      return Promise.reject(
        new Error("Ross selected source is not configured"),
      );
    }
    const levels =
      stagedLevels.length === 0
        ? canonicalLevels(undefined, state.module.scope.levelCount)
        : stagedLevels;
    return this.#submitRoute(
      state,
      stagedSource,
      state.selectedDestination,
      levels,
      "automatic-take",
      signal,
    );
  }

  take(input: RossRouteGroupTakeInput): Promise<void> {
    input.signal?.throwIfAborted();
    const state = this.#requireGroup(input);
    if (state.toggleInProgress) return toggleInProgressAction();
    if (this.#stateHasReservation(state)) return transitionInProgressAction();
    if (!state.enabled) return disabledGroupAction();
    const levels = canonicalLevels(input.levels, state.module.scope.levelCount);
    state.stagedLevels = levels;
    this.#emit();
    if (state.stagedSource === null) {
      return Promise.reject(
        new Error("Ross selected source is not configured"),
      );
    }
    if (state.selectedDestination === null) {
      return Promise.reject(
        new Error("Ross selected destination is not configured"),
      );
    }
    state.intentionalManualStage = !state.module.scope.automaticTake;
    return this.#submitRoute(
      state,
      state.stagedSource,
      state.selectedDestination,
      levels,
      "take",
      input.signal,
    );
  }

  async toggleGroupEnabled(
    input: RossRouteGroupToggleEnabledInput,
  ): Promise<void> {
    const state = this.#requireGroup(input);
    if (state.groupId === null) {
      throw new RangeError("Routing group toggle requires an explicit group");
    }
    if (this.#stateHasReservation(state)) {
      throw new Error("Routing group transition is in progress");
    }
    if (state.toggleCompletion !== null) {
      throw new Error("Routing group toggle is already in progress");
    }
    state.toggleInProgress = true;
    let resolveToggleCompletion!: () => void;
    state.toggleCompletion = new Promise<void>((resolve) => {
      resolveToggleCompletion = resolve;
    });
    const enabled = !state.enabled;
    try {
      await this.#persistGroupToggle(state, enabled);
      if (
        !this.#stateIsActive(state) ||
        state.groupId !== input.groupId ||
        state.module.scope.connectionId !== input.connectionId
      ) {
        throw new RangeError("Ross route group scope is no longer configured");
      }
      state.enabled = enabled;
      this.#clearGroupRoutingState(state);
      if (state.enabled) this.#ensureBaseWatch(state);
      state.persistenceDirtyDuringToggle = false;
    } catch (error: unknown) {
      state.persistenceDirtyDuringToggle = true;
      await this.#resyncGroupAfterFailedToggle(state);
      throw error;
    } finally {
      state.toggleInProgress = false;
      state.toggleCompletion = null;
      resolveToggleCompletion();
    }
    this.#emit();
  }

  snapshots(): readonly RossGroupRuntimeSnapshot[] {
    this.#assertRunning();
    return Object.freeze(
      [...this.#modules.values()]
        .sort((left, right) =>
          moduleStateKey(left.scope).localeCompare(moduleStateKey(right.scope)),
        )
        .flatMap((module) =>
          [...module.groups.values()]
            .sort((left, right) =>
              groupKey(left.groupId).localeCompare(groupKey(right.groupId)),
            )
            .map((state) => snapshotFor(state)),
        ),
    );
  }

  subscribe(listener: RossRouteGroupRuntimeListener): () => void {
    this.#assertRunning();
    this.#listeners.add(listener);
    try {
      listener(this.snapshots());
    } catch {
      this.#listeners.delete(listener);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async applyTransition(
    transition: RossRouteGroupStateTransition,
  ): Promise<"applied" | "already-applied"> {
    this.#assertRunning();
    this.#transitionsInProgress.add(transition);
    try {
      await this.#waitForAffectedToggles(transition);
      let result: "applied" | "already-applied";
      try {
        result = await this.#stateStore.applyTransition(transition);
      } catch (error: unknown) {
        this.#diagnostic({
          code: "ross_route_group_state_transition_failed",
          message: `Ross route-group state transition failed: ${errorMessage(error)}`,
          workspaceId: transition.workspaceId,
          ...("moduleConnectionId" in transition
            ? { moduleConnectionId: transition.moduleConnectionId }
            : {}),
        });
        throw error;
      }
      if (result === "already-applied" || this.#stopped) return result;
      this.#applyTransitionToMemory(transition);
      this.#emit();
      return result;
    } finally {
      this.#transitionsInProgress.delete(transition);
      this.#flushUnreservedReservationDirtyStates();
    }
  }

  async clearWorkspace(workspaceId: string): Promise<void> {
    this.#assertRunning();
    const reservation = Object.freeze({ workspaceId });
    this.#workspaceClearsInProgress.add(reservation);
    try {
      await this.#waitForWorkspaceToggles(workspaceId);
      try {
        await this.#stateStore.clearWorkspace(workspaceId);
      } catch (error: unknown) {
        this.#diagnostic({
          code: "ross_route_group_state_write_failed",
          message: `Clearing Ross route-group workspace state failed: ${errorMessage(error)}`,
          workspaceId,
        });
        throw error;
      }
      for (const [key, module] of this.#modules) {
        if (module.scope.workspaceId !== workspaceId) continue;
        this.#modules.delete(key);
        this.#disposeModule(module);
      }
      this.#emit();
    } finally {
      this.#workspaceClearsInProgress.delete(reservation);
      this.#flushUnreservedReservationDirtyStates();
    }
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const module of this.#modules.values()) this.#disposeModule(module);
    this.#modules.clear();
    this.#listeners.clear();
    let failure: unknown;
    try {
      await this.#stateStore.flush();
    } catch (error: unknown) {
      failure = error;
      this.#diagnostic({
        code: "ross_route_group_state_write_failed",
        message: `Flushing Ross route-group state failed: ${errorMessage(error)}`,
      });
    }
    try {
      await this.#stateStore.close();
    } catch (error: unknown) {
      failure ??= error;
      this.#diagnostic({
        code: "ross_route_group_state_write_failed",
        message: `Closing Ross route-group state failed: ${errorMessage(error)}`,
      });
    }
    if (failure !== undefined) throw failure;
  }

  #submitRoute(
    state: MutableGroupState,
    source: number,
    destination: number,
    levels: readonly number[],
    origin: "take" | "automatic-take",
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.toggleInProgress) return toggleInProgressAction();
    if (this.#stateHasReservation(state)) return transitionInProgressAction();
    if (!state.enabled) return disabledGroupAction();
    const module = state.module;
    const takeSequence = module.moduleSequenceHighWaterMark + 1;
    module.moduleSequenceHighWaterMark = takeSequence;
    const claim = freezeClaim({
      source,
      destination,
      levels,
      takeSequence,
      origin,
    });
    const pending: PendingRouteClaim = {
      claim,
      destinationSelectionEpoch: state.destinationSelectionEpoch,
      settled: false,
      submissionId: null,
    };
    state.pendingRouteClaims.set(takeSequence, pending);
    this.#persistModuleSequence(module);
    this.#ensureWatchCovers(state, levels);
    this.#emit();

    let submission: RouterDirectRouteSubmission;
    try {
      submission = this.#connections.submitDirectRouteTracked({
        connectionId: module.scope.connectionId,
        source,
        destination,
        levels,
        ...(signal ? { signal } : {}),
      });
      pending.submissionId = submission.submissionId;
    } catch (error: unknown) {
      state.pendingRouteClaims.delete(takeSequence);
      this.#emit();
      throw error;
    }

    void submission.settled.then(
      () => {
        this.#settleRoute(state, takeSequence);
      },
      (error: unknown) => {
        this.#rejectRoute(state, takeSequence, submission.submissionId, error);
      },
    );
    return submission.accepted;
  }

  #settleRoute(state: MutableGroupState, takeSequence: number): void {
    if (!this.#stateIsActive(state) || !state.enabled) return;
    if (state.toggleInProgress) state.persistenceDirtyDuringToggle = true;
    if (this.#stateHasReservation(state))
      state.persistenceDirtyDuringReservation = true;
    const pending = state.pendingRouteClaims.get(takeSequence);
    if (pending === undefined) return;
    if (!pendingClaimMatchesSelection(pending, state)) {
      state.pendingRouteClaims.delete(takeSequence);
      this.#emit();
      return;
    }
    pending.settled = true;
    this.#promoteSettledClaim(state);
    this.#emit();
  }

  #rejectRoute(
    state: MutableGroupState,
    takeSequence: number,
    submissionId: string,
    error: unknown,
  ): void {
    if (!this.#stateIsActive(state) || !state.enabled) return;
    if (state.toggleInProgress) state.persistenceDirtyDuringToggle = true;
    if (this.#stateHasReservation(state))
      state.persistenceDirtyDuringReservation = true;
    const pending = state.pendingRouteClaims.get(takeSequence);
    if (pending === undefined) return;
    state.pendingRouteClaims.delete(takeSequence);
    if (pendingClaimMatchesSelection(pending, state)) {
      state.passiveBlockedFingerprint = confirmedFingerprint(
        state.confirmedRoute,
      );
      const promotedEarlierClaim = this.#promoteSettledClaim(state);
      const ownedClaim = state.ownedClaim;
      if (
        !promotedEarlierClaim &&
        ownedClaim !== null &&
        claimMatchesConfirmed(ownedClaim, state.confirmedRoute)
      ) {
        state.routeClaim = ownedClaim;
      } else if (!promotedEarlierClaim) {
        state.routeClaim = null;
      }
    }
    this.#diagnostic({
      code: "ross_route_group_route_settlement_failed",
      message: `Ross route-group submission settled unsuccessfully: ${errorMessage(error)}`,
      workspaceId: state.module.scope.workspaceId,
      moduleConnectionId: state.module.scope.moduleConnectionId,
      groupId: state.groupId,
      takeSequence,
      submissionId,
    });
    this.#emit();
  }

  #promoteSettledClaim(state: MutableGroupState): boolean {
    if (!state.enabled) return false;
    const confirmed = state.confirmedRoute;
    if (confirmed?.phase !== "ready") return false;
    let promotedSequence = -1;
    let promoted: PendingRouteClaim | null = null;
    for (const [sequence, pending] of state.pendingRouteClaims) {
      if (
        !pending.settled ||
        !pendingClaimMatchesSelection(pending, state) ||
        !claimMatchesConfirmed(pending.claim, confirmed)
      ) {
        continue;
      }
      if (sequence <= promotedSequence) continue;
      promotedSequence = sequence;
      promoted = pending;
    }
    if (promoted === null) return false;
    state.ownedClaim = promoted.claim;
    state.routeClaim = promoted.claim;
    state.stagedSource = promoted.claim.source;
    state.stagedLevels = promoted.claim.levels;
    state.intentionalManualStage =
      !state.module.scope.automaticTake && promoted.claim.origin === "take";
    state.persistedLevels = promoted.claim.levels;
    state.committedTakeSequence = promoted.claim.takeSequence;
    state.passiveBlockedFingerprint = undefined;
    for (const [sequence, pending] of state.pendingRouteClaims) {
      if (
        sequence <= promotedSequence &&
        pendingClaimMatchesSelection(pending, state)
      ) {
        state.pendingRouteClaims.delete(sequence);
      }
    }
    this.#persistGroup(state);
    return true;
  }

  #handleConfirmedRoute(
    state: MutableGroupState,
    generation: number,
    snapshot: RouterConfirmedRouteTargetSnapshot,
  ): void {
    if (
      !this.#stateIsActive(state) ||
      !state.enabled ||
      state.watchGeneration !== generation ||
      state.selectedDestination !== snapshot.destination
    ) {
      return;
    }
    if (state.toggleInProgress) state.persistenceDirtyDuringToggle = true;
    if (this.#stateHasReservation(state))
      state.persistenceDirtyDuringReservation = true;
    state.confirmedRoute = cloneConfirmedRoute(snapshot);
    if (snapshot.phase === "pending") {
      if (!state.preserveInitialPending) {
        if (!this.#preservesIntentionalManualStage(state)) {
          state.stagedSource = null;
        }
        state.routeClaim = null;
      }
      this.#emit();
      return;
    }

    if (this.#promoteSettledClaim(state)) {
      this.#emit();
      return;
    }
    const ownedClaim = state.ownedClaim;
    if (
      ownedClaim !== null &&
      claimMatchesConfirmed(ownedClaim, state.confirmedRoute)
    ) {
      state.routeClaim = ownedClaim;
      if (!this.#preservesIntentionalManualStage(state)) {
        state.stagedSource = ownedClaim.source;
        state.stagedLevels = ownedClaim.levels;
      }
      this.#emit();
      return;
    }
    if (hasPendingClaimForSelection(state.pendingRouteClaims, state)) {
      state.routeClaim = null;
      this.#emit();
      return;
    }
    if (
      ownedClaim !== null &&
      ownedClaim.origin !== "passive-readback" &&
      claimHasConfirmedLevel(ownedClaim, state.confirmedRoute)
    ) {
      // Ownership is destination/level scoped. A later group may legitimately
      // replace only part of this claim, so retain the successful claim for the
      // levels that still match instead of collapsing the whole group to a
      // passive mixed-state blank.
      state.routeClaim = ownedClaim;
      if (!this.#preservesIntentionalManualStage(state)) {
        state.stagedSource = ownedClaim.source;
        state.stagedLevels = ownedClaim.levels;
      }
      this.#emit();
      return;
    }

    const fingerprint = confirmedFingerprint(state.confirmedRoute);
    if (state.passiveBlockedFingerprint !== undefined) {
      if (state.passiveBlockedFingerprint === null) {
        state.passiveBlockedFingerprint = fingerprint;
      } else if (state.passiveBlockedFingerprint !== fingerprint) {
        state.passiveBlockedFingerprint = undefined;
      }
    }
    if (state.passiveBlockedFingerprint !== undefined) {
      state.routeClaim = null;
      this.#emit();
      return;
    }

    const levels = this.#passiveLevels(state);
    const source = uniformConfirmedSource(state.confirmedRoute, levels);
    if (source === null || state.selectedDestination === null) {
      if (!this.#preservesIntentionalManualStage(state)) {
        state.stagedSource = null;
      }
      state.routeClaim = null;
      state.ownedClaim = null;
      this.#emit();
      return;
    }
    const passiveClaim = freezeClaim({
      source,
      destination: state.selectedDestination,
      levels,
      takeSequence: state.committedTakeSequence,
      origin: "passive-readback",
    });
    if (!this.#preservesIntentionalManualStage(state)) {
      state.stagedSource = source;
      state.stagedLevels = levels;
    }
    state.routeClaim = passiveClaim;
    state.ownedClaim = passiveClaim;
    this.#emit();
  }

  #ensureBaseWatch(state: MutableGroupState): void {
    if (!state.enabled) {
      this.#removeWatch(state);
      return;
    }
    if (state.selectedDestination === null) {
      this.#removeWatch(state);
      return;
    }
    if (
      state.watchDestination === state.selectedDestination &&
      state.watchLevels.length > 0
    ) {
      return;
    }
    this.#installWatch(state, this.#passiveLevels(state), false);
  }

  #ensureWatchCovers(
    state: MutableGroupState,
    levels: readonly number[],
  ): void {
    if (!state.enabled || state.selectedDestination === null) return;
    if (
      state.watchDestination === state.selectedDestination &&
      levels.every((level) => state.watchLevels.includes(level))
    ) {
      return;
    }
    const nextLevels =
      state.watchDestination === state.selectedDestination
        ? canonicalLevelUnion(state.watchLevels, levels)
        : canonicalLevelUnion(this.#passiveLevels(state), levels);
    this.#installWatch(state, nextLevels, true);
  }

  #installWatch(
    state: MutableGroupState,
    levels: readonly number[],
    preserveInitialPending: boolean,
  ): void {
    const destination = state.selectedDestination;
    this.#removeWatch(state);
    if (!state.enabled || destination === null) return;
    state.watchDestination = destination;
    state.watchLevels = levels;
    state.confirmedRoute = null;
    state.watchGeneration += 1;
    const generation = state.watchGeneration;
    state.preserveInitialPending = preserveInitialPending;
    try {
      const unsubscribe = this.#connections.watchConfirmedRouteTarget(
        {
          connectionId: state.module.scope.connectionId,
          destination,
          levels,
        },
        (snapshot) => {
          this.#handleConfirmedRoute(state, generation, snapshot);
        },
      );
      if (this.#stateIsActive(state) && state.watchGeneration === generation) {
        state.unsubscribeWatch = unsubscribe;
      } else {
        unsubscribe();
      }
    } catch (error: unknown) {
      state.watchDestination = null;
      state.watchLevels = Object.freeze([]);
      state.confirmedRoute = null;
      this.#diagnostic({
        code: "ross_route_group_watch_failed",
        message: `Ross route-group confirmed readback failed: ${errorMessage(error)}`,
        workspaceId: state.module.scope.workspaceId,
        moduleConnectionId: state.module.scope.moduleConnectionId,
        groupId: state.groupId,
      });
    } finally {
      state.preserveInitialPending = false;
    }
  }

  #removeWatch(state: MutableGroupState): void {
    state.watchGeneration += 1;
    state.unsubscribeWatch();
    state.unsubscribeWatch = () => undefined;
    state.watchDestination = null;
    state.watchLevels = Object.freeze([]);
    state.confirmedRoute = null;
    state.preserveInitialPending = false;
  }

  #passiveLevels(state: MutableGroupState): readonly number[] {
    return state.persistedLevels.length > 0
      ? state.persistedLevels
      : canonicalLevels(undefined, state.module.scope.levelCount);
  }

  #preservesIntentionalManualStage(state: MutableGroupState): boolean {
    return !state.module.scope.automaticTake && state.intentionalManualStage;
  }

  #persistGroup(state: MutableGroupState): void {
    if (state.toggleInProgress) {
      state.persistenceDirtyDuringToggle = true;
      return;
    }
    if (this.#stateHasReservation(state)) {
      state.persistenceDirtyDuringReservation = true;
      return;
    }
    this.#observePersistence("persist group state", state, () =>
      this.#stateStore.upsert({
        workspaceId: state.module.scope.workspaceId,
        moduleConnectionId: state.module.scope.moduleConnectionId,
        connectionId: state.module.scope.connectionId,
        groupId: state.groupId,
        enabled: state.enabled,
        selectedDestination: state.matrixDestinationDefault
          ? null
          : state.selectedDestination,
        levels: state.persistedLevels,
        committedTakeSequence: state.committedTakeSequence,
      }),
    );
  }

  async #resyncGroupAfterFailedToggle(state: MutableGroupState): Promise<void> {
    while (state.persistenceDirtyDuringToggle && this.#stateIsActive(state)) {
      state.persistenceDirtyDuringToggle = false;
      try {
        await this.#stateStore.upsert({
          workspaceId: state.module.scope.workspaceId,
          moduleConnectionId: state.module.scope.moduleConnectionId,
          connectionId: state.module.scope.connectionId,
          groupId: state.groupId,
          enabled: state.enabled,
          selectedDestination: state.matrixDestinationDefault
            ? null
            : state.selectedDestination,
          levels: state.persistedLevels,
          committedTakeSequence: state.committedTakeSequence,
        });
      } catch (error: unknown) {
        this.#diagnostic({
          code: "ross_route_group_state_write_failed",
          message: `resync group state after failed toggle failed: ${errorMessage(error)}`,
          workspaceId: state.module.scope.workspaceId,
          moduleConnectionId: state.module.scope.moduleConnectionId,
          groupId: state.groupId,
        });
        state.toggleInProgress = false;
        return;
      }
    }
    state.toggleInProgress = false;
  }

  async #waitForAffectedToggles(
    transition: RossRouteGroupStateTransition,
  ): Promise<void> {
    const completions: Promise<void>[] = [];
    for (const module of this.#modules.values()) {
      for (const state of module.groups.values()) {
        if (
          !transitionAffectsState(transition, state) ||
          state.toggleCompletion === null
        )
          continue;
        completions.push(state.toggleCompletion);
      }
    }
    await Promise.all(completions);
  }

  async #waitForWorkspaceToggles(workspaceId: string): Promise<void> {
    const completions: Promise<void>[] = [];
    for (const module of this.#modules.values()) {
      if (module.scope.workspaceId !== workspaceId) continue;
      for (const state of module.groups.values()) {
        if (state.toggleCompletion !== null)
          completions.push(state.toggleCompletion);
      }
    }
    await Promise.all(completions);
  }

  #flushUnreservedReservationDirtyStates(): void {
    for (const module of this.#modules.values()) {
      for (const state of module.groups.values()) {
        if (
          !state.persistenceDirtyDuringReservation ||
          this.#stateHasReservation(state)
        )
          continue;
        state.persistenceDirtyDuringReservation = false;
        this.#persistGroup(state);
      }
    }
  }

  async #persistGroupToggle(
    state: MutableGroupState,
    enabled: boolean,
  ): Promise<void> {
    try {
      await this.#stateStore.upsert({
        workspaceId: state.module.scope.workspaceId,
        moduleConnectionId: state.module.scope.moduleConnectionId,
        connectionId: state.module.scope.connectionId,
        groupId: state.groupId,
        enabled,
        selectedDestination: null,
        levels: Object.freeze([]),
        committedTakeSequence: null,
      });
    } catch (error: unknown) {
      this.#diagnostic({
        code: "ross_route_group_state_write_failed",
        message: `persist group toggle state failed: ${errorMessage(error)}`,
        workspaceId: state.module.scope.workspaceId,
        moduleConnectionId: state.module.scope.moduleConnectionId,
        groupId: state.groupId,
      });
      throw error;
    }
  }

  #persistModuleSequence(module: MutableModuleState): void {
    this.#observePersistence("persist module sequence", undefined, () =>
      this.#stateStore.upsertModuleSequenceState({
        workspaceId: module.scope.workspaceId,
        moduleConnectionId: module.scope.moduleConnectionId,
        moduleSequenceHighWaterMark: module.moduleSequenceHighWaterMark,
      }),
    );
  }

  #observePersistence(
    operation: string,
    state: MutableGroupState | undefined,
    persist: () => Promise<unknown>,
  ): void {
    try {
      void persist().catch((error: unknown) => {
        this.#diagnostic({
          code: "ross_route_group_state_write_failed",
          message: `${operation} failed: ${errorMessage(error)}`,
          ...(state === undefined
            ? {}
            : {
                workspaceId: state.module.scope.workspaceId,
                moduleConnectionId: state.module.scope.moduleConnectionId,
                groupId: state.groupId,
              }),
        });
      });
    } catch (error: unknown) {
      this.#diagnostic({
        code: "ross_route_group_state_write_failed",
        message: `${operation} failed: ${errorMessage(error)}`,
        ...(state === undefined
          ? {}
          : {
              workspaceId: state.module.scope.workspaceId,
              moduleConnectionId: state.module.scope.moduleConnectionId,
              groupId: state.groupId,
            }),
      });
    }
  }

  async #loadPersistedGroups(): Promise<
    readonly PersistedRossRouteGroupRuntimeState[]
  > {
    try {
      return await this.#stateStore.snapshot();
    } catch (error: unknown) {
      this.#diagnostic({
        code: "ross_route_group_state_read_failed",
        message: `Reading Ross route-group state failed: ${errorMessage(error)}`,
      });
      return Object.freeze([]);
    }
  }

  async #loadPersistedModules(): Promise<
    readonly PersistedRossRouteModuleSequenceRuntimeState[]
  > {
    try {
      return await this.#stateStore.moduleSnapshot();
    } catch (error: unknown) {
      this.#diagnostic({
        code: "ross_route_group_state_read_failed",
        message: `Reading Ross route-group module sequence state failed: ${errorMessage(error)}`,
      });
      return Object.freeze([]);
    }
  }

  #createGroupState(
    module: MutableModuleState,
    groupId: string | null,
    persisted: PersistedRossRouteGroupRuntimeState | undefined,
  ): MutableGroupState {
    const enabled = groupId === null ? true : (persisted?.enabled ?? true);
    const persistedLevels = Object.freeze(
      enabled ? [...(persisted?.levels ?? [])] : [],
    );
    return {
      module,
      groupId,
      enabled,
      toggleInProgress: false,
      toggleCompletion: null,
      persistenceDirtyDuringToggle: false,
      persistenceDirtyDuringReservation: false,
      stagedSource: null,
      stagedLevels: persistedLevels,
      intentionalManualStage: false,
      selectedDestination: enabled
        ? (persisted?.selectedDestination ?? null)
        : null,
      matrixDestinationDefault: false,
      destinationSelectionEpoch: 0,
      routeClaim: null,
      ownedClaim: null,
      pendingRouteClaims: new Map(),
      persistedLevels,
      committedTakeSequence: enabled
        ? (persisted?.committedTakeSequence ?? null)
        : null,
      confirmedRoute: null,
      watchDestination: null,
      watchLevels: Object.freeze([]),
      watchGeneration: 0,
      preserveInitialPending: false,
      unsubscribeWatch: () => undefined,
      passiveBlockedFingerprint: undefined,
    };
  }

  #clearGroupRoutingState(state: MutableGroupState): void {
    state.destinationSelectionEpoch += 1;
    state.stagedSource = null;
    state.stagedLevels = Object.freeze([]);
    state.intentionalManualStage = false;
    state.selectedDestination = null;
    state.matrixDestinationDefault = false;
    state.routeClaim = null;
    state.ownedClaim = null;
    state.pendingRouteClaims.clear();
    state.persistedLevels = Object.freeze([]);
    state.committedTakeSequence = null;
    state.passiveBlockedFingerprint = undefined;
    this.#removeWatch(state);
  }

  #applyTransitionToMemory(transition: RossRouteGroupStateTransition): void {
    switch (transition.operation) {
      case "move": {
        const module = this.#modules.get(moduleStateKey(transition));
        if (module === undefined) return;
        const source = module.groups.get(groupKey(transition.fromGroupId));
        if (source === undefined) return;
        const targetKey = groupKey(transition.toGroupId);
        const target = module.groups.get(targetKey);
        if (target !== undefined && target !== source)
          this.#disposeGroup(target);
        module.groups.delete(groupKey(transition.fromGroupId));
        source.groupId = transition.toGroupId;
        if (source.groupId === null) source.enabled = true;
        module.groups.set(targetKey, source);
        module.scope = Object.freeze({
          ...module.scope,
          groupIds: Object.freeze(
            [...module.groups.values()].flatMap((state) =>
              state.groupId === null ? [] : [state.groupId],
            ),
          ),
        });
        return;
      }
      case "discard-group": {
        const module = this.#modules.get(moduleStateKey(transition));
        const state = module?.groups.get(groupKey(transition.groupId));
        if (module === undefined || state === undefined) return;
        module.groups.delete(groupKey(transition.groupId));
        this.#disposeGroup(state);
        return;
      }
      case "discard-module": {
        const key = moduleStateKey(transition);
        const module = this.#modules.get(key);
        if (module === undefined) return;
        this.#modules.delete(key);
        this.#disposeModule(module);
        return;
      }
      case "discard-workspace":
        for (const [key, module] of this.#modules) {
          if (module.scope.workspaceId !== transition.workspaceId) continue;
          this.#modules.delete(key);
          this.#disposeModule(module);
        }
    }
  }

  #normalizeScopes(
    scopes: readonly RossRouteGroupModuleScope[],
  ): readonly NormalizedModuleScope[] {
    const physicalById = new Map<string, ManagedRouterConnectionSnapshot>(
      this.#connections
        .snapshots()
        .map((snapshot) => [snapshot.definition.connectionId, snapshot]),
    );
    const seen = new Set<string>();
    return Object.freeze(
      scopes.map((scope) => {
        const key = moduleStateKey(scope);
        if (seen.has(key))
          throw new RangeError(
            `Duplicate Ross route-group module scope ${key}`,
          );
        seen.add(key);
        const groupIds = Object.freeze([...scope.groupIds]);
        if (new Set(groupIds).size !== groupIds.length) {
          throw new RangeError(
            `Duplicate Ross route-group id in module scope ${key}`,
          );
        }
        const levelCount =
          scope.levelCount ??
          physicalLevelCount(physicalById.get(scope.connectionId));
        if (
          !Number.isSafeInteger(levelCount) ||
          levelCount < 1 ||
          levelCount > 256
        ) {
          throw new RangeError(
            "Ross router level count must be an integer from 1 to 256",
          );
        }
        return Object.freeze({
          workspaceId: scope.workspaceId,
          moduleConnectionId: scope.moduleConnectionId,
          connectionId: scope.connectionId,
          automaticTake: scope.automaticTake,
          groupIds,
          levelCount,
          connectionFingerprint: routerConnectionFingerprint(
            physicalById.get(scope.connectionId),
          ),
        });
      }),
    );
  }

  #requireGroup(scope: RossRouteGroupActionScope): MutableGroupState {
    this.#assertRunning();
    const module = this.#modules.get(moduleStateKey(scope));
    if (
      module === undefined ||
      module.scope.connectionId !== scope.connectionId
    ) {
      throw new RangeError("Ross route group scope is not configured");
    }
    const state = module.groups.get(groupKey(scope.groupId));
    if (state === undefined)
      throw new RangeError("Ross route group scope is not configured");
    return state;
  }

  #stateIsActive(state: MutableGroupState): boolean {
    if (this.#stopped) return false;
    const module = this.#modules.get(moduleStateKey(state.module.scope));
    return (
      module === state.module &&
      module.groups.get(groupKey(state.groupId)) === state
    );
  }

  #stateHasReservation(state: MutableGroupState): boolean {
    return (
      [...this.#transitionsInProgress].some((transition) =>
        transitionAffectsState(transition, state),
      ) ||
      [...this.#workspaceClearsInProgress].some(
        (reservation) =>
          reservation.workspaceId === state.module.scope.workspaceId,
      )
    );
  }

  #disposeGroup(state: MutableGroupState): void {
    state.pendingRouteClaims.clear();
    this.#removeWatch(state);
  }

  #disposeModule(module: MutableModuleState): void {
    for (const state of module.groups.values()) this.#disposeGroup(state);
    module.groups.clear();
  }

  #emit(): void {
    if (this.#stopped || this.#listeners.size === 0) return;
    const snapshots = this.snapshots();
    for (const listener of this.#listeners) {
      try {
        listener(snapshots);
      } catch {
        // Runtime observers must never affect routing or persistence.
      }
    }
  }

  #diagnostic(diagnostic: RossRouteGroupRuntimeDiagnostic): void {
    try {
      this.#onDiagnostic?.(Object.freeze(diagnostic));
    } catch {
      // Diagnostics must never alter action completion or runtime ownership.
    }
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error("Ross route group runtime is stopped");
  }
}

function snapshotFor(state: MutableGroupState): RossGroupRuntimeSnapshot {
  const routeClaim = state.routeClaim;
  const feedbackClaim =
    state.enabled &&
    routeClaim !== null &&
    routeClaim.destination === state.selectedDestination &&
    claimHasConfirmedLevel(routeClaim, state.confirmedRoute)
      ? routeClaim
      : null;
  return Object.freeze({
    workspaceId: state.module.scope.workspaceId,
    moduleConnectionId: state.module.scope.moduleConnectionId,
    connectionId: state.module.scope.connectionId,
    groupId: state.groupId,
    enabled: state.enabled,
    automaticTake: state.module.scope.automaticTake,
    manualStageActive:
      !state.module.scope.automaticTake && state.intentionalManualStage,
    stagedSource: state.stagedSource,
    stagedLevels: Object.freeze([...state.stagedLevels]),
    selectedDestination: state.selectedDestination,
    routeClaim,
    feedbackClaim,
    pendingRouteClaims: new Map(
      [...state.pendingRouteClaims].map(([sequence, pending]) => [
        sequence,
        pending.claim,
      ]),
    ),
    confirmedRoute:
      state.confirmedRoute === null
        ? null
        : cloneConfirmedRoute(state.confirmedRoute),
    moduleSequenceHighWaterMark: state.module.moduleSequenceHighWaterMark,
  });
}

function canonicalLevels(
  requested: readonly number[] | undefined,
  levelCount: number,
): readonly number[] {
  const levels =
    requested === undefined || requested.length === 0
      ? Array.from({ length: levelCount }, (_, index) => index + 1)
      : [...requested];
  const seen = new Set<number>();
  for (const level of levels) {
    if (!Number.isSafeInteger(level) || level < 1 || level > levelCount) {
      throw new RangeError(
        `Ross route level must be an integer from 1 to ${String(levelCount)}`,
      );
    }
    if (seen.has(level))
      throw new RangeError("Ross route levels must be unique");
    seen.add(level);
  }
  return Object.freeze(levels.sort((left, right) => left - right));
}

function canonicalLevelUnion(
  left: readonly number[],
  right: readonly number[],
): readonly number[] {
  return Object.freeze([...new Set([...left, ...right])].sort((a, b) => a - b));
}

function validateRouterAddress(
  value: number,
  kind: "source" | "destination",
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new RangeError(
      `Ross route ${kind} must be an integer from 1 to 65536`,
    );
  }
  return value;
}

function validateDestinationCycle(
  destinations: readonly number[],
): readonly number[] {
  if (destinations.length < 2 || destinations.length > 5) {
    throw new RangeError(
      "Ross destination cycle must contain between 2 and 5 destinations",
    );
  }
  const validated = destinations.map((destination) =>
    validateRouterAddress(destination, "destination"),
  );
  if (new Set(validated).size !== validated.length) {
    throw new RangeError("Ross destination cycle destinations must be unique");
  }
  return Object.freeze(validated);
}

function pendingClaimMatchesSelection(
  pending: PendingRouteClaim,
  state: MutableGroupState,
): boolean {
  return (
    pending.claim.destination === state.selectedDestination &&
    pending.destinationSelectionEpoch === state.destinationSelectionEpoch
  );
}

function hasPendingClaimForSelection(
  pendingRouteClaims: ReadonlyMap<number, PendingRouteClaim>,
  state: MutableGroupState,
): boolean {
  for (const pending of pendingRouteClaims.values()) {
    if (pendingClaimMatchesSelection(pending, state)) return true;
  }
  return false;
}

function uniformConfirmedSource(
  confirmed: RouterConfirmedRouteTargetSnapshot,
  levels: readonly number[],
): number | null {
  if (confirmed.phase !== "ready" || levels.length === 0) return null;
  let source: number | null = null;
  for (const level of levels) {
    const observed = confirmed.sourcesByLevel.get(level);
    if (observed === undefined) return null;
    if (source === null) source = observed;
    else if (source !== observed) return null;
  }
  return source;
}

function claimMatchesConfirmed(
  claim: RossGroupRouteClaim,
  confirmed: RouterConfirmedRouteTargetSnapshot | null,
): boolean {
  return (
    confirmed?.phase === "ready" &&
    claim.destination === confirmed.destination &&
    claim.levels.length > 0 &&
    claim.levels.every(
      (level) => confirmed.sourcesByLevel.get(level) === claim.source,
    )
  );
}

function claimHasConfirmedLevel(
  claim: RossGroupRouteClaim,
  confirmed: RouterConfirmedRouteTargetSnapshot | null,
): boolean {
  return (
    confirmed?.phase === "ready" &&
    claim.destination === confirmed.destination &&
    claim.levels.some(
      (level) => confirmed.sourcesByLevel.get(level) === claim.source,
    )
  );
}

function freezeClaim(claim: RossGroupRouteClaim): RossGroupRouteClaim {
  return Object.freeze({ ...claim, levels: Object.freeze([...claim.levels]) });
}

function cloneConfirmedRoute(
  snapshot: RouterConfirmedRouteTargetSnapshot,
): RouterConfirmedRouteTargetSnapshot {
  return Object.freeze({
    connectionId: snapshot.connectionId,
    destination: snapshot.destination,
    levels: Object.freeze([...snapshot.levels]),
    phase: snapshot.phase,
    sourcesByLevel: new Map(snapshot.sourcesByLevel),
    lastError: snapshot.lastError,
  });
}

function confirmedFingerprint(
  snapshot: RouterConfirmedRouteTargetSnapshot | null,
): string | null {
  if (snapshot?.phase !== "ready") return null;
  return snapshot.levels
    .map(
      (level) =>
        `${String(level)}:${String(snapshot.sourcesByLevel.get(level) ?? "unknown")}`,
    )
    .join("|");
}

function physicalLevelCount(
  snapshot: ManagedRouterConnectionSnapshot | undefined,
): number {
  if (snapshot === undefined) {
    throw new RangeError(
      "Router level count is unavailable for the module scope",
    );
  }
  return snapshot.definition.type === "blackmagic-videohub" ||
    snapshot.definition.type === "aja-kumo"
    ? 1
    : snapshot.definition.levels;
}

function routerConnectionFingerprint(
  snapshot: ManagedRouterConnectionSnapshot | undefined,
): string | null {
  return snapshot === undefined ? null : JSON.stringify(snapshot.definition);
}

function groupKey(groupId: string | null): string {
  return groupId ?? GENERIC_GROUP_KEY;
}

function groupStateKey(state: RossRouteGroupActionScope): string {
  return groupStateKeyParts(
    state.workspaceId,
    state.moduleConnectionId,
    state.groupId,
  );
}

function groupStateKeyParts(
  workspaceId: string,
  moduleConnectionId: string,
  groupId: string | null,
): string {
  return `${workspaceId}:${moduleConnectionId}:${groupKey(groupId)}`;
}

function moduleStateKey(state: {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
}): string {
  return `${state.workspaceId}:${state.moduleConnectionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transitionAffectsGroup(
  transition: RossRouteGroupStateTransition,
  scope: RossRouteGroupActionScope,
): boolean {
  if (transition.workspaceId !== scope.workspaceId) return false;
  if (transition.operation === "discard-workspace") return true;
  if (transition.moduleConnectionId !== scope.moduleConnectionId) return false;
  switch (transition.operation) {
    case "move":
      return (
        transition.fromGroupId === scope.groupId ||
        transition.toGroupId === scope.groupId
      );
    case "discard-group":
      return transition.groupId === scope.groupId;
    case "discard-module":
      return true;
  }
}

function transitionAffectsState(
  transition: RossRouteGroupStateTransition,
  state: MutableGroupState,
): boolean {
  return transitionAffectsGroup(transition, {
    workspaceId: state.module.scope.workspaceId,
    moduleConnectionId: state.module.scope.moduleConnectionId,
    connectionId: state.module.scope.connectionId,
    groupId: state.groupId,
  });
}

function disabledGroupAction(): Promise<never> {
  return Promise.reject(new Error("Routing group is disabled"));
}

function toggleInProgressAction(): Promise<never> {
  return Promise.reject(new Error("Routing group toggle is in progress"));
}

function transitionInProgressAction(): Promise<never> {
  return Promise.reject(new Error("Routing group transition is in progress"));
}
