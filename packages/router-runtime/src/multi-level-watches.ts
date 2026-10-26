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
} from './multi-level-confirmation.js'
import { errorMessage } from './multi-level-snapshot.js'
import { type ConfirmedRouteWatch, type ManagedEntry } from './multi-level-types.js'
import {
  normalizeConfirmedRouteTarget,
  validateConfirmedRouteReadback,
} from './multi-level-validation.js'

export interface MultiLevelWatchesContext {
  requireEntry(connectionId: string): ManagedEntry
  isCurrentEntry(connectionId: string, entry: ManagedEntry): boolean
}

export function watchConfirmedRouteTarget(
  runtime: MultiLevelWatchesContext,
  target: RouterConfirmedRouteTarget,
  listener: RouterConfirmedRouteTargetListener,
): () => void {
  const entry = runtime.requireEntry(target.connectionId)
  const normalizedTarget = normalizeConfirmedRouteTarget(entry.definition, target)
  const key = confirmedRouteWatchKey(normalizedTarget)
  let watch = entry.confirmedRouteWatches.get(key)
  if (watch === undefined) {
    watch = {
      key,
      target: normalizedTarget,
      listeners: new Set(),
      snapshot: pendingConfirmedRouteSnapshot(normalizedTarget, null),
      running: false,
      runId: 0,
    }
    entry.confirmedRouteWatches.set(key, watch)
  }
  watch.listeners.add(listener)
  try {
    listener(watch.snapshot)
  } catch {
    watch.listeners.delete(listener)
  }
  runConfirmedRouteWatch(runtime, target.connectionId, entry, watch)
  return () => {
    const current = entry.confirmedRouteWatches.get(key)
    if (current !== watch) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    current.running = false
    current.runId += 1
    entry.confirmedRouteWatches.delete(key)
  }
}

export function runConfirmedRouteWatch(
  runtime: MultiLevelWatchesContext,
  connectionId: string,
  entry: ManagedEntry,
  watch: ConfirmedRouteWatch,
): void {
  if (
    !runtime.isCurrentEntry(connectionId, entry) ||
    entry.confirmedRouteWatches.get(watch.key) !== watch ||
    watch.listeners.size === 0 ||
    watch.running
  ) {
    return
  }
  if (entry.client.snapshot().phase !== 'connected') {
    publishConfirmedRouteWatch(
      runtime,
      watch,
      pendingConfirmedRouteSnapshot(
        watch.target,
        'Router confirmed route readback is unavailable',
      ),
    )
    return
  }

  watch.running = true
  const runId = watch.runId + 1
  watch.runId = runId
  const operation = entry.confirmedRouteWatchTail.then(async () => {
    if (
      !runtime.isCurrentEntry(connectionId, entry) ||
      entry.confirmedRouteWatches.get(watch.key) !== watch ||
      watch.runId !== runId ||
      entry.client.snapshot().phase !== 'connected'
    ) {
      return null
    }
    return validateConfirmedRouteReadback(
      entry.definition,
      watch.target,
      await entry.client.readDestination(watch.target.destination, watch.target.levels),
    )
  })
  entry.confirmedRouteWatchTail = operation.then(
    () => undefined,
    () => undefined,
  )
  void operation.then(
    (sourcesByLevel) => {
      if (
        !runtime.isCurrentEntry(connectionId, entry) ||
        entry.confirmedRouteWatches.get(watch.key) !== watch ||
        watch.runId !== runId
      ) {
        return
      }
      watch.running = false
      if (sourcesByLevel !== null) {
        // A multi-level read can straddle a control/update. Once every requested
        // level has been observed, prefer the client's current authoritative
        // route cache over values captured earlier in that read. Pending watches
        // deliberately ignore push callbacks until this initial read completes.
        const latest = new Map(sourcesByLevel)
        const observed = entry.routes.routes.get(watch.target.destination)
        for (const level of watch.target.levels) {
          const source = observed?.get(level)
          if (source !== undefined) latest.set(level, source)
        }
        publishConfirmedRouteWatch(
          runtime,
          watch,
          readyConfirmedRouteSnapshot(watch.target, latest),
        )
      }
    },
    (error: unknown) => {
      if (
        !runtime.isCurrentEntry(connectionId, entry) ||
        entry.confirmedRouteWatches.get(watch.key) !== watch ||
        watch.runId !== runId
      ) {
        return
      }
      watch.running = false
      publishConfirmedRouteWatch(
        runtime,
        watch,
        pendingConfirmedRouteSnapshot(watch.target, errorMessage(error)),
      )
    },
  )
}

export function runAllConfirmedRouteWatches(
  runtime: MultiLevelWatchesContext,
  connectionId: string,
  entry: ManagedEntry,
): void {
  for (const watch of entry.confirmedRouteWatches.values()) {
    runConfirmedRouteWatch(runtime, connectionId, entry, watch)
  }
}

export function publishConfirmedRouteWatchesFromRoutes(
  runtime: MultiLevelWatchesContext,
  entry: ManagedEntry,
): void {
  for (const watch of entry.confirmedRouteWatches.values()) {
    if (watch.snapshot.phase !== 'ready') continue
    const sourcesByLevel = new Map<number, number>()
    const destination = entry.routes.routes.get(watch.target.destination)
    for (const level of watch.target.levels) {
      const source = destination?.get(level)
      if (source !== undefined) sourcesByLevel.set(level, source)
    }
    publishConfirmedRouteWatch(
      runtime,
      watch,
      readyConfirmedRouteSnapshot(watch.target, sourcesByLevel),
    )
  }
}

export function invalidateConfirmedRouteWatches(
  runtime: MultiLevelWatchesContext,
  entry: ManagedEntry,
  error: string,
): void {
  for (const watch of entry.confirmedRouteWatches.values()) {
    watch.running = false
    watch.runId += 1
    publishConfirmedRouteWatch(
      runtime,
      watch,
      pendingConfirmedRouteSnapshot(watch.target, error),
    )
  }
}

export function publishConfirmedRouteWatch(
  runtime: MultiLevelWatchesContext,
  watch: ConfirmedRouteWatch,
  snapshot: RouterConfirmedRouteTargetSnapshot,
): void {
  if (confirmedRouteSnapshotsEqual(watch.snapshot, snapshot)) return
  watch.snapshot = snapshot
  for (const listener of [...watch.listeners]) {
    try {
      listener(snapshot)
    } catch {
      // A read-only route observer cannot interrupt OGP synchronization.
    }
  }
}
