import { type UltrixOgpSnapshot } from '@hubble/protocol-ultrix-ogp'
import {
  boundedCrosspoints,
  boundedRouteSnapshot,
  snapshotError,
} from './multi-level-snapshot.js'
import { type ManagedEntry } from './multi-level-types.js'
import { validAddress } from './multi-level-validation.js'

export interface MultiLevelCatalogContext {}

export function hydrateConnectedSnapshot(
  runtime: MultiLevelCatalogContext,
  entry: ManagedEntry,
): void {
  const snapshot = entry.client.snapshot()
  if (snapshot.phase !== 'connected') throw new Error('Router snapshot is not connected')
  if (snapshot.subscriptions.length === 0) {
    throw new Error('Router updates are unavailable')
  }
  if (!snapshot.controlReady)
    throw new Error(
      entry.definition.type === 'ross-ultrix-ogp'
        ? 'Ultrix routing control is not ready'
        : 'Quartz routing control is not ready',
    )
  assertLevelCatalog(runtime, entry, snapshot)
  applyCatalogSnapshot(runtime, entry, snapshot)
  const routes = boundedCrosspoints(entry.definition, snapshot)
  entry.routing.replaceRoutes({
    clientRevision: snapshot.revision,
    crosspoints: routes,
  })
  entry.routes = boundedRouteSnapshot(entry.definition, snapshot)
  entry.routing.markLabelsReady()
  entry.routing.markReady()
  entry.phase = 'connected'
  entry.lastError = snapshotError(snapshot)
}

export function applyCatalogSnapshot(
  runtime: MultiLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: UltrixOgpSnapshot,
): void {
  const sources = Object.freeze(
    snapshot.sources
      .filter(({ address }) => validAddress(address, entry.definition.sourceLimit))
      .map(({ address, label }) => Object.freeze({ address, label })),
  )
  const destinations = Object.freeze(
    snapshot.destinations
      .filter(({ address }) => validAddress(address, entry.definition.destinationLimit))
      .map(({ address, label }) => Object.freeze({ address, label })),
  )
  entry.sourceCatalog = sources
  entry.destinationCatalog = destinations
  entry.routing.replaceCatalogs({
    revision: snapshot.catalogRevision,
    sources,
    destinations,
  })
}

export function assertLevelCatalog(
  runtime: MultiLevelCatalogContext,
  entry: ManagedEntry,
  snapshot: UltrixOgpSnapshot,
): void {
  const configured = new Set(
    snapshot.levels
      .map(({ level }) => level)
      .filter((level) => validAddress(level, entry.definition.levels)),
  )
  for (let level = 1; level <= entry.definition.levels; level += 1) {
    if (!configured.has(level)) {
      throw new Error(`Router level ${String(level)} is unavailable`)
    }
  }
}

export function synchronizeAfterCommand(
  runtime: MultiLevelCatalogContext,
  entry: ManagedEntry,
): void {
  const snapshot = entry.client.snapshot()
  if (snapshot.phase !== 'connected') return
  entry.lastError = snapshotError(snapshot)
  const currentRevision = entry.routing.snapshot().version.revision
  if (snapshot.revision === currentRevision) {
    entry.routes = boundedRouteSnapshot(entry.definition, snapshot)
    return
  }
  hydrateConnectedSnapshot(runtime, entry)
}
