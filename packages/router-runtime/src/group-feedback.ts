import type { RouterActionDefinition } from "./actions.js";
import type { ManagedRouterConnectionSnapshot } from "./connection-contract.js";
import type {
  RossGroupRuntimeSnapshot,
  RossGroupRouteClaim,
} from "./group-runtime.js";

type GroupedRossFeedbackAction = Extract<
  RouterActionDefinition,
  {
    type:
      | "ross-swp08.select-source"
      | "ross-swp08.select-destination"
      | "ross-swp08.take"
      | "blackmagic-videohub.select-source"
      | "aja-kumo.select-source"
      | "blackmagic-videohub.select-destination"
      | "aja-kumo.select-destination"
      | "blackmagic-videohub.take"
      | "aja-kumo.take";
  }
>;

type ToggleRossGroupFeedbackAction = Extract<
  RouterActionDefinition,
  {
    type:
      | "ross-swp08.toggle-group-enabled"
      | "blackmagic-videohub.toggle-group-enabled"
      | "aja-kumo.toggle-group-enabled";
  }
>;

type RossGroupIdentityAction =
  | GroupedRossFeedbackAction
  | ToggleRossGroupFeedbackAction;

interface ConfirmedRossGroupClaim {
  readonly identity: string;
  readonly snapshot: RossGroupRuntimeSnapshot;
  readonly claim: RossGroupRouteClaim;
}

interface RossGroupFeedbackResolution {
  actionIsActive(action: GroupedRossFeedbackAction): boolean;
  actionIsStaged(action: RouterActionDefinition): boolean;
  groupIsEnabled(action: ToggleRossGroupFeedbackAction): boolean;
  selectedDestination(
    action: Extract<
      RouterActionDefinition,
      {
        type:
          | "ross-swp08.select-destination"
          | "blackmagic-videohub.select-destination"
          | "aja-kumo.select-destination";
      }
    >,
  ): number | null;
}

export function resolveRossGroupFeedback(
  workspaceId: string,
  snapshots: readonly RossGroupRuntimeSnapshot[],
  routerByConnection: ReadonlyMap<string, ManagedRouterConnectionSnapshot>,
): RossGroupFeedbackResolution {
  const workspaceSnapshots = snapshots.filter(
    (snapshot) => snapshot.workspaceId === workspaceId,
  );
  const snapshotsByGroup = new Map(
    workspaceSnapshots.map(
      (snapshot) => [groupIdentity(snapshot), snapshot] as const,
    ),
  );
  const confirmedClaims = workspaceSnapshots
    .map(confirmedRossGroupClaim)
    .filter((claim): claim is ConfirmedRossGroupClaim => claim !== null);
  const claimsByGroup = new Map(
    confirmedClaims.map(
      (claim) => [groupIdentity(claim.snapshot), claim] as const,
    ),
  );
  const ownersByLevel = resolveRossGroupLevelOwners(confirmedClaims);

  return Object.freeze({
    actionIsStaged(action: RouterActionDefinition): boolean {
      if (
        action.type !== "ross-swp08.select-source" &&
        action.type !== "ross-swp08.select-destination" &&
        action.type !== "ross-swp08.take" &&
        action.type !== "blackmagic-videohub.select-source" &&
        action.type !== "aja-kumo.select-source" &&
        action.type !== "blackmagic-videohub.select-destination" &&
        action.type !== "aja-kumo.select-destination" &&
        action.type !== "blackmagic-videohub.take" &&
        action.type !== "aja-kumo.take"
      ) {
        return false;
      }
      if (!action.enabled || !action.drivesTally) return false;
      const snapshot = snapshotsByGroup.get(
        groupActionIdentity(workspaceId, action),
      );
      if (
        snapshot === undefined ||
        !snapshot.enabled ||
        snapshot.automaticTake ||
        !snapshot.manualStageActive ||
        snapshot.stagedSource === null ||
        snapshot.selectedDestination === null
      ) {
        return false;
      }
      const confirmed = snapshot.feedbackClaim;
      const stageDiffersFromConfirmed =
        confirmed === null ||
        confirmed.source !== snapshot.stagedSource ||
        confirmed.destination !== snapshot.selectedDestination ||
        snapshot.stagedLevels.some(
          (level) =>
            snapshot.confirmedRoute?.sourcesByLevel.get(level) !==
            snapshot.stagedSource,
        );
      if (!stageDiffersFromConfirmed) return false;
      switch (action.type) {
        case "ross-swp08.select-source":
          return (
            action.source === snapshot.stagedSource &&
            canonicalFeedbackLevels(
              action.levels,
              routerByConnection.get(action.connectionId),
            ).every((level) => snapshot.stagedLevels.includes(level))
          );
        case "aja-kumo.select-source":
        case "blackmagic-videohub.select-source":
          return action.source === snapshot.stagedSource;
        case "ross-swp08.select-destination":
        case "aja-kumo.select-destination":
        case "blackmagic-videohub.select-destination":
          return (
            action.destination === snapshot.selectedDestination ||
            action.destinations?.includes(snapshot.selectedDestination) === true
          );
        case "ross-swp08.take":
        case "aja-kumo.take":
        case "blackmagic-videohub.take":
          return true;
      }
    },
    selectedDestination(
      action: Extract<
        RouterActionDefinition,
        {
          type:
            | "ross-swp08.select-destination"
            | "blackmagic-videohub.select-destination"
            | "aja-kumo.select-destination";
        }
      >,
    ): number | null {
      return (
        snapshotsByGroup.get(groupActionIdentity(workspaceId, action))
          ?.selectedDestination ?? null
      );
    },
    groupIsEnabled(action: ToggleRossGroupFeedbackAction): boolean {
      return (
        snapshotsByGroup.get(groupActionIdentity(workspaceId, action))
          ?.enabled ?? true
      );
    },
    actionIsActive(action: GroupedRossFeedbackAction): boolean {
      const identity = groupActionIdentity(workspaceId, action);
      const confirmed = claimsByGroup.get(identity);
      if (confirmed === undefined) return false;

      const { snapshot, claim } = confirmed;
      let levels: readonly number[];
      switch (action.type) {
        case "ross-swp08.select-source":
        case "aja-kumo.select-source":
        case "blackmagic-videohub.select-source":
          if (action.source !== claim.source) return false;
          levels = canonicalFeedbackLevels(
            action.type === "ross-swp08.select-source" ? action.levels : [1],
            routerByConnection.get(action.connectionId),
          );
          break;
        case "ross-swp08.select-destination":
        case "aja-kumo.select-destination":
        case "blackmagic-videohub.select-destination":
          if (action.destination !== claim.destination) return false;
          levels = claim.levels;
          break;
        case "ross-swp08.take":
        case "aja-kumo.take":
        case "blackmagic-videohub.take":
          levels = canonicalFeedbackLevels(
            action.type === "ross-swp08.take" ? action.levels : [1],
            routerByConnection.get(action.connectionId),
          );
          break;
      }
      if (levels.length === 0) return false;
      if (
        !everyLevelMatches(
          snapshot.confirmedRoute?.sourcesByLevel,
          levels,
          claim.source,
        )
      ) {
        return false;
      }
      return levels.every(
        (level) =>
          ownersByLevel.get(
            rossGroupLevelKey(
              snapshot.workspaceId,
              snapshot.moduleConnectionId,
              snapshot.connectionId,
              claim.destination,
              level,
            ),
          ) === identity,
      );
    },
  });
}

function confirmedRossGroupClaim(
  snapshot: RossGroupRuntimeSnapshot,
): ConfirmedRossGroupClaim | null {
  const claim = snapshot.routeClaim;
  const confirmed = snapshot.confirmedRoute;
  if (
    !snapshot.enabled ||
    claim === null ||
    snapshot.selectedDestination === null ||
    claim.destination !== snapshot.selectedDestination ||
    confirmed?.phase !== "ready" ||
    confirmed.destination !== snapshot.selectedDestination ||
    !claim.levels.some(
      (level) => confirmed.sourcesByLevel.get(level) === claim.source,
    )
  ) {
    return null;
  }
  return Object.freeze({ identity: groupIdentity(snapshot), snapshot, claim });
}

function resolveRossGroupLevelOwners(
  claims: readonly ConfirmedRossGroupClaim[],
): ReadonlyMap<string, string | null> {
  const candidatesByLevel = new Map<string, ConfirmedRossGroupClaim[]>();
  for (const candidate of claims) {
    for (const level of candidate.claim.levels) {
      if (
        candidate.snapshot.confirmedRoute?.sourcesByLevel.get(level) !==
        candidate.claim.source
      ) {
        continue;
      }
      const key = rossGroupLevelKey(
        candidate.snapshot.workspaceId,
        candidate.snapshot.moduleConnectionId,
        candidate.snapshot.connectionId,
        candidate.claim.destination,
        level,
      );
      const candidates = candidatesByLevel.get(key);
      if (candidates === undefined) candidatesByLevel.set(key, [candidate]);
      else candidates.push(candidate);
    }
  }

  const owners = new Map<string, string | null>();
  for (const [key, candidates] of candidatesByLevel) {
    const sequenced = candidates.filter(
      ({ claim }) => claim.takeSequence !== null,
    );
    if (sequenced.length === 0) {
      const passiveOwners = new Set(candidates.map(({ identity }) => identity));
      const [passiveOwner] = passiveOwners;
      owners.set(key, passiveOwners.size === 1 ? (passiveOwner ?? null) : null);
      continue;
    }
    const highestSequence = Math.max(
      ...sequenced.map(({ claim }) => claim.takeSequence as number),
    );
    const highestOwners = new Set(
      sequenced
        .filter(({ claim }) => claim.takeSequence === highestSequence)
        .map(({ identity }) => identity),
    );
    const [highestOwner] = highestOwners;
    owners.set(key, highestOwners.size === 1 ? (highestOwner ?? null) : null);
  }
  return owners;
}

function canonicalFeedbackLevels(
  requested: readonly number[],
  router: ManagedRouterConnectionSnapshot | undefined,
): readonly number[] {
  if (requested.length > 0) {
    return Object.freeze(
      [...new Set(requested)].sort((left, right) => left - right),
    );
  }
  const levelCount =
    router?.definition.type === "blackmagic-videohub" ||
    router?.definition.type === "aja-kumo"
      ? 1
      : (router?.definition.levels ?? 0);
  return Object.freeze(
    Array.from({ length: levelCount }, (_, index) => index + 1),
  );
}

function everyLevelMatches(
  routes: ReadonlyMap<number, number> | undefined,
  levels: readonly number[],
  source: number,
): boolean {
  return (
    routes !== undefined &&
    levels.length > 0 &&
    levels.every((level) => routes.get(level) === source)
  );
}

function groupIdentity(snapshot: RossGroupRuntimeSnapshot): string {
  return rossGroupIdentity(
    snapshot.workspaceId,
    snapshot.moduleConnectionId,
    snapshot.connectionId,
    snapshot.groupId,
  );
}

function groupActionIdentity(
  workspaceId: string,
  action: RossGroupIdentityAction,
): string {
  return rossGroupIdentity(
    workspaceId,
    action.moduleConnectionId,
    action.connectionId,
    action.groupId,
  );
}

function rossGroupIdentity(
  workspaceId: string,
  moduleConnectionId: string,
  connectionId: string,
  groupId: string | null,
): string {
  return `${workspaceId}\u0000${moduleConnectionId}\u0000${connectionId}\u0000${groupId ?? ""}`;
}

function rossGroupLevelKey(
  workspaceId: string,
  moduleConnectionId: string,
  connectionId: string,
  destination: number,
  level: number,
): string {
  return `${workspaceId}\u0000${moduleConnectionId}\u0000${connectionId}\u0000${String(destination)}\u0000${String(level)}`;
}
