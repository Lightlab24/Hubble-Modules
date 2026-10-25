import { type VideohubSnapshot } from '@hubble/protocol-videohub'
import {
  boundedCrosspoints,
  boundedRouteSnapshot,
  emptyRouteSnapshot,
} from './single-level-snapshot.js'
import { type ManagedEntry } from './single-level-types.js'
import { validAddress, validateDimensions } from './single-level-validation.js'

export interface SingleLevelCatalogContext {
  publishConfirmedRouteWatchesFromRoutes(entry: ManagedEntry): void
  invalidateConfirmedRouteWatches(entry: ManagedEntry, error: string): void
}

export function hydrateConnectedSnapshot(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
): void {
  const snapshot = entry.client.snapshot()
  if (snapshot.phase !== 'connected') throw new Error('Router snapshot is not connected')
  validateDimensions(snapshot)
  const hadSelectedDestination = entry.selectedDestination !== null
  const deviceIdentityChanged =
    entry.detectedSourceCount !== null &&
    (entry.deviceModel !== snapshot.modelName ||
      entry.detectedSourceCount !== snapshot.detectedSourceCount ||
      entry.detectedDestinationCount !== snapshot.detectedDestinationCount)
  if (deviceIdentityChanged) entry.completedRouteOperations.clear()
  applyDeviceMetadata(runtime, entry, snapshot)
  if (
    entry.selectedSource !== null &&
    !validAddress(entry.selectedSource, snapshot.sourceCount)
  ) {
    entry.selectedSource = null
  }
  if (
    entry.selectedDestination !== null &&
    !validAddress(entry.selectedDestination, snapshot.destinationCount)
  ) {
    entry.selectedDestination = null
  }
  applyCatalogSnapshot(runtime, entry, snapshot)
  entry.routing.replaceRoutes({
    clientRevision: snapshot.revision,
    crosspoints: boundedCrosspoints(entry, snapshot),
  })
  entry.routes = boundedRouteSnapshot(entry, snapshot)
  applyLabelPhase(runtime, entry, snapshot)
  entry.routing.markReady()
  entry.phase = 'connected'
  entry.catalogStale = false
  entry.lastError = snapshot.lastError
  if (
    !hadSelectedDestination &&
    entry.selectedDestination === null &&
    snapshot.destinationCount > 0
  ) {
    entry.selectedDestination = 1
  }
  runtime.publishConfirmedRouteWatchesFromRoutes(entry)
}

export function applyDeviceMetadata(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): void {
  entry.deviceStatus = snapshot.deviceStatus
  entry.deviceModel = snapshot.modelName
  entry.detectedSourceCount = snapshot.detectedSourceCount
  entry.detectedDestinationCount = snapshot.detectedDestinationCount
  entry.effectiveSourceCount = snapshot.sourceCount
  entry.effectiveDestinationCount = snapshot.destinationCount
  entry.lockedDestinationCount = snapshot.locks.filter(({ state }) => state === 'locked').length
}

export function applySynchronizingDeviceSnapshot(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): void {
  const sameCatalogIdentity =
    snapshot.deviceStatus === 'present' &&
    snapshot.catalogStale &&
    entry.deviceModel === snapshot.modelName &&
    entry.detectedSourceCount === snapshot.detectedSourceCount &&
    entry.detectedDestinationCount === snapshot.detectedDestinationCount &&
    snapshot.sources.length > 0 &&
    snapshot.destinations.length > 0
  applyDeviceMetadata(runtime, entry, snapshot)
  if (sameCatalogIdentity) {
    entry.catalogStale = true
    return
  }

  entry.selectedSource = null
  entry.selectedDestination = null
  entry.routes = emptyRouteSnapshot()
  entry.sourceCatalog = Object.freeze([])
  entry.destinationCatalog = Object.freeze([])
  entry.catalogStale = false
  entry.completedRouteOperations.clear()
  entry.routing.replaceCatalogs({
    revision: snapshot.catalogRevision,
    sources: [],
    destinations: [],
  })
  entry.routing.reset({ clientRevision: snapshot.revision, phase: 'stale' })
  runtime.invalidateConfirmedRouteWatches(entry, 'Videohub attached device changed')
}

export function applyCatalogSnapshot(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): void {
  validateDimensions(snapshot)
  const sourceNames = new Map(
    snapshot.sources.map(({ address, name }) => [address, name] as const),
  )
  const destinationNames = new Map(
    snapshot.destinations.map(({ address, name }) => [address, name] as const),
  )
  const sources = Object.freeze(
    Array.from({ length: snapshot.sourceCount }, (_, index) => {
      const address = index + 1
      return Object.freeze({ address, label: sourceNames.get(address) ?? '' })
    }),
  )
  const destinations = Object.freeze(
    Array.from({ length: snapshot.destinationCount }, (_, index) => {
      const address = index + 1
      return Object.freeze({ address, label: destinationNames.get(address) ?? '' })
    }),
  )
  entry.sourceCatalog = sources
  entry.destinationCatalog = destinations
  entry.routing.replaceCatalogs({ revision: snapshot.catalogRevision, sources, destinations })
}

export function applyLabelPhase(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: VideohubSnapshot,
): void {
  if (snapshot.labelsDegraded) entry.routing.markLabelsDegraded()
  else entry.routing.markLabelsReady()
}

export function markDisconnected(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
  error: string | null,
): void {
  entry.phase = 'disconnected'
  entry.lastError = error
  entry.catalogStale = entry.sourceCatalog.length > 0 || entry.destinationCatalog.length > 0
  entry.routes = emptyRouteSnapshot()
  entry.completedRouteOperations.clear()
  entry.routing.markStale()
  runtime.invalidateConfirmedRouteWatches(entry, error ?? 'Router readback is disconnected')
}

export function synchronizeAfterCommand(
  runtime: SingleLevelCatalogContext,
  entry: ManagedEntry,
): void {
  const snapshot = entry.client.snapshot()
  if (snapshot.phase !== 'connected') return
  entry.lastError = snapshot.lastError
  if (snapshot.revision !== entry.routing.snapshot().version.revision) {
    hydrateConnectedSnapshot(runtime, entry)
  } else {
    entry.routes = boundedRouteSnapshot(entry, snapshot)
    runtime.publishConfirmedRouteWatchesFromRoutes(entry)
  }
}
