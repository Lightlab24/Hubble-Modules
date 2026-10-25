import type {
  RouterConfirmedRouteTarget,
  RouterConfirmedRouteTargetListener,
  RouterConfirmedRouteTargetSnapshot,
} from '@hubble/router-runtime/connection-contract'
import {
  confirmedRouteSnapshotsEqual,
  confirmedRouteWatchKey,
  pendingConfirmedRouteSnapshot,
  readyConfirmedRouteSnapshot,
  routeSource,
} from './single-level-confirmation.js'
import { VIDEO_LEVEL } from './single-level-limits.js'
import { type ConfirmedRouteWatch, type ManagedEntry } from './single-level-types.js'
import { normalizeConfirmedRouteTarget, validAddress } from './single-level-validation.js'

export interface SingleLevelWatchesContext {
  requireEntry(connectionId: string): ManagedEntry
}

export function watchConfirmedRouteTarget(
  runtime: SingleLevelWatchesContext,
  target: RouterConfirmedRouteTarget,
  listener: RouterConfirmedRouteTargetListener,
): () => void {
  const entry = runtime.requireEntry(target.connectionId)
  const normalizedTarget = normalizeConfirmedRouteTarget(entry, target)
  const key = confirmedRouteWatchKey(normalizedTarget)
  let watch = entry.confirmedRouteWatches.get(key)
  if (watch === undefined) {
    watch = {
      key,
      target: normalizedTarget,
      listeners: new Set(),
      snapshot: pendingConfirmedRouteSnapshot(normalizedTarget, null),
    }
    entry.confirmedRouteWatches.set(key, watch)
    publishConfirmedRouteWatchFromRoutes(runtime, entry, watch)
  }
  watch.listeners.add(listener)
  try {
    listener(watch.snapshot)
  } catch {
    watch.listeners.delete(listener)
  }
  return () => {
    const current = entry.confirmedRouteWatches.get(key)
    if (current !== watch) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) entry.confirmedRouteWatches.delete(key)
  }
}

export function publishConfirmedRouteWatchesFromRoutes(
  runtime: SingleLevelWatchesContext,
  entry: ManagedEntry,
): void {
  for (const watch of entry.confirmedRouteWatches.values()) {
    publishConfirmedRouteWatchFromRoutes(runtime, entry, watch)
  }
}

export function publishConfirmedRouteWatchFromRoutes(
  runtime: SingleLevelWatchesContext,
  entry: ManagedEntry,
  watch: ConfirmedRouteWatch,
): void {
  if (entry.phase !== 'connected' || entry.routing.snapshot().phase !== 'ready') {
    publishConfirmedRouteWatch(
      runtime,
      watch,
      pendingConfirmedRouteSnapshot(watch.target, 'Router readback is unavailable'),
    )
    return
  }
  if (!validAddress(watch.target.destination, entry.effectiveDestinationCount ?? 0)) {
    publishConfirmedRouteWatch(
      runtime,
      watch,
      pendingConfirmedRouteSnapshot(
        watch.target,
        'Videohub destination is outside the detected range',
      ),
    )
    return
  }
  const source = routeSource(entry, watch.target.destination)
  publishConfirmedRouteWatch(
    runtime,
    watch,
    readyConfirmedRouteSnapshot(
      watch.target,
      source === null ? new Map() : new Map([[VIDEO_LEVEL, source]]),
    ),
  )
}

export function invalidateConfirmedRouteWatches(
  runtime: SingleLevelWatchesContext,
  entry: ManagedEntry,
  error: string,
): void {
  for (const watch of entry.confirmedRouteWatches.values()) {
    publishConfirmedRouteWatch(
      runtime,
      watch,
      pendingConfirmedRouteSnapshot(watch.target, error),
    )
  }
}

export function publishConfirmedRouteWatch(
  runtime: SingleLevelWatchesContext,
  watch: ConfirmedRouteWatch,
  snapshot: RouterConfirmedRouteTargetSnapshot,
): void {
  if (confirmedRouteSnapshotsEqual(watch.snapshot, snapshot)) return
  watch.snapshot = snapshot
  for (const listener of [...watch.listeners]) {
    try {
      listener(snapshot)
    } catch {
      // Read-only feedback observers cannot affect routing state.
    }
  }
}
