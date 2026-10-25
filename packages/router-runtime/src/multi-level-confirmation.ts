import type {
  RouterConfirmedRouteTarget,
  RouterConfirmedRouteTargetSnapshot,
} from '@hubble/router-runtime/connection-contract'
import { type ManagedEntry } from './multi-level-types.js'

export function confirmedRouteWatchKey(target: RouterConfirmedRouteTarget): string {
  return `${target.connectionId}:${String(target.destination)}:${target.levels.join(',')}`
}

export function pendingConfirmedRouteSnapshot(
  target: RouterConfirmedRouteTarget,
  lastError: string | null,
): RouterConfirmedRouteTargetSnapshot {
  return Object.freeze({
    ...target,
    phase: 'pending',
    sourcesByLevel: new Map<number, number>(),
    lastError,
  })
}

export function readyConfirmedRouteSnapshot(
  target: RouterConfirmedRouteTarget,
  sourcesByLevel: ReadonlyMap<number, number>,
): RouterConfirmedRouteTargetSnapshot {
  return Object.freeze({
    ...target,
    phase: 'ready',
    sourcesByLevel: new Map(sourcesByLevel),
    lastError: null,
  })
}

export function confirmedRouteSnapshotsEqual(
  left: RouterConfirmedRouteTargetSnapshot,
  right: RouterConfirmedRouteTargetSnapshot,
): boolean {
  if (
    left.phase !== right.phase ||
    left.lastError !== right.lastError ||
    left.sourcesByLevel.size !== right.sourcesByLevel.size
  ) {
    return false
  }
  for (const [level, source] of left.sourcesByLevel) {
    if (right.sourcesByLevel.get(level) !== source) return false
  }
  return true
}

export function routeSource(
  entry: ManagedEntry,
  destination: number,
  level: number,
): number | null {
  return entry.routes.routes.get(destination)?.get(level) ?? null
}
