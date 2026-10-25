import type { VideohubClientEvent, VideohubNameCatalogSnapshot } from './client-types.js'
import {
  coversAddresses,
  isUsableRouterLabel,
  safeRouterLabel,
  sortedLabels,
} from './client-values.js'
import { immutableLabel, type VideohubRouterLabel } from './protocol.js'
interface CatalogDevice {
  requireDetectedSourceCount(): number
  requireDetectedDestinationCount(): number
  sourceCount(): number | null
  destinationCount(): number | null
  detectedSourceCount(): number | null
  detectedDestinationCount(): number | null
  emit(event: VideohubClientEvent): void
}

/** Label snapshots are hydrated and refreshed atomically, retaining later subscription deltas. */
export class VideohubNameCatalog {
  public readonly sources = new Map<number, VideohubRouterLabel>()
  public readonly destinations = new Map<number, VideohubRouterLabel>()
  public catalogRevision = 0
  public labelsDegraded = false
  public catalogStale = false
  public inputLabelsHydrated = false
  public outputLabelsHydrated = false
  public nameRefreshActive = false
  public refreshedSources: readonly VideohubRouterLabel[] | null = null
  public refreshedDestinations: readonly VideohubRouterLabel[] | null = null
  public readonly bufferedSourceLabelDeltas = new Map<number, VideohubRouterLabel>()
  public readonly bufferedDestinationLabelDeltas = new Map<number, VideohubRouterLabel>()

  public constructor(private readonly port: CatalogDevice) {}
  public handleInputLabels(labels: readonly VideohubRouterLabel[]): void {
    const count = this.port.requireDetectedSourceCount()
    if (!this.inputLabelsHydrated) {
      const next = this.catalogWithFallback('Input', count, labels)
      this.labelsDegraded ||= this.catalogIsDegraded(labels, count)
      this.sources.clear()
      for (const [address, label] of next) this.sources.set(address, label)
      this.inputLabelsHydrated = true
      this.bumpNames()
      return
    }
    const complete = coversAddresses(
      labels.map((label) => label.address),
      count,
    )
    if (this.nameRefreshActive && complete) {
      this.refreshedSources = Object.freeze(labels.map(immutableLabel))
      return
    }
    if (this.nameRefreshActive) {
      for (const label of labels)
        this.bufferedSourceLabelDeltas.set(label.address, immutableLabel(label))
      return
    }
    if (complete) {
      this.sources.clear()
      for (const [address, label] of this.catalogWithFallback('Input', count, labels)) {
        this.sources.set(address, label)
      }
      this.labelsDegraded ||= this.catalogIsDegraded(labels, count)
    } else {
      for (const label of labels) {
        if (label.address < 1 || label.address > count) continue
        const safe = safeRouterLabel('Input', label)
        this.sources.set(label.address, safe.label)
        this.labelsDegraded ||= safe.degraded
      }
    }
    this.bumpNames()
  }

  public handleOutputLabels(labels: readonly VideohubRouterLabel[]): void {
    const count = this.port.requireDetectedDestinationCount()
    if (!this.outputLabelsHydrated) {
      const next = this.catalogWithFallback('Output', count, labels)
      this.labelsDegraded ||= this.catalogIsDegraded(labels, count)
      this.destinations.clear()
      for (const [address, label] of next) this.destinations.set(address, label)
      this.outputLabelsHydrated = true
      this.bumpNames()
      return
    }
    const complete = coversAddresses(
      labels.map((label) => label.address),
      count,
    )
    if (this.nameRefreshActive && complete) {
      this.refreshedDestinations = Object.freeze(labels.map(immutableLabel))
      return
    }
    if (this.nameRefreshActive) {
      for (const label of labels) {
        this.bufferedDestinationLabelDeltas.set(label.address, immutableLabel(label))
      }
      return
    }
    if (complete) {
      this.destinations.clear()
      for (const [address, label] of this.catalogWithFallback('Output', count, labels)) {
        this.destinations.set(address, label)
      }
      this.labelsDegraded ||= this.catalogIsDegraded(labels, count)
    } else {
      for (const label of labels) {
        if (label.address < 1 || label.address > count) continue
        const safe = safeRouterLabel('Output', label)
        this.destinations.set(label.address, safe.label)
        this.labelsDegraded ||= safe.degraded
      }
    }
    this.bumpNames()
  }

  public replaceBothCatalogs(
    sourceLabels: readonly VideohubRouterLabel[],
    destinationLabels: readonly VideohubRouterLabel[],
  ): void {
    const sourceCount = this.port.requireDetectedSourceCount()
    const destinationCount = this.port.requireDetectedDestinationCount()
    this.sources.clear()
    this.destinations.clear()
    for (const [address, label] of this.catalogWithFallback(
      'Input',
      sourceCount,
      sourceLabels,
    )) {
      this.sources.set(address, label)
    }
    for (const [address, label] of this.catalogWithFallback(
      'Output',
      destinationCount,
      destinationLabels,
    )) {
      this.destinations.set(address, label)
    }
    this.labelsDegraded =
      this.catalogIsDegraded(sourceLabels, sourceCount) ||
      this.catalogIsDegraded(destinationLabels, destinationCount)
    for (const [address, label] of this.bufferedSourceLabelDeltas) {
      if (address < 1 || address > sourceCount) continue
      const safe = safeRouterLabel('Input', label)
      this.sources.set(address, safe.label)
      this.labelsDegraded ||= safe.degraded
    }
    for (const [address, label] of this.bufferedDestinationLabelDeltas) {
      if (address < 1 || address > destinationCount) continue
      const safe = safeRouterLabel('Output', label)
      this.destinations.set(address, safe.label)
      this.labelsDegraded ||= safe.degraded
    }
    this.bumpNames()
  }

  public replayBufferedNameDeltas(): void {
    const detectedSourceCount = this.port.detectedSourceCount()
    const detectedDestinationCount = this.port.detectedDestinationCount()
    let changed = false
    for (const [address, label] of this.bufferedSourceLabelDeltas) {
      if (detectedSourceCount !== null && address >= 1 && address <= detectedSourceCount) {
        const safe = safeRouterLabel('Input', label)
        this.sources.set(address, safe.label)
        this.labelsDegraded ||= safe.degraded
        changed = true
      }
    }
    for (const [address, label] of this.bufferedDestinationLabelDeltas) {
      if (
        detectedDestinationCount !== null &&
        address >= 1 &&
        address <= detectedDestinationCount
      ) {
        const safe = safeRouterLabel('Output', label)
        this.destinations.set(address, safe.label)
        this.labelsDegraded ||= safe.degraded
        changed = true
      }
    }
    if (changed) this.bumpNames()
  }

  public catalogIsDegraded(labels: readonly VideohubRouterLabel[], count: number): boolean {
    const usable = new Set(
      labels
        .filter(
          (label) =>
            label.address >= 1 && label.address <= count && isUsableRouterLabel(label.name),
        )
        .map((label) => label.address),
    )
    return usable.size < count
  }

  public catalogWithFallback(
    prefix: 'Input' | 'Output',
    count: number,
    labels: readonly VideohubRouterLabel[],
  ): Map<number, VideohubRouterLabel> {
    const byAddress = new Map(labels.map((label) => [label.address, label] as const))
    const catalog = new Map<number, VideohubRouterLabel>()
    for (let address = 1; address <= count; address += 1) {
      const received = byAddress.get(address)
      const safe =
        received === undefined
          ? null
          : safeRouterLabel(prefix, Object.freeze({ address, name: received.name }))
      catalog.set(
        address,
        safe?.label ?? immutableLabel({ address, name: `${prefix} ${String(address)}` }),
      )
    }
    return catalog
  }

  public bumpNames(): void {
    this.catalogRevision += 1
    this.port.emit({ type: 'names', names: this.nameSnapshot() })
  }

  public nameSnapshot(): VideohubNameCatalogSnapshot {
    return Object.freeze({
      revision: this.catalogRevision,
      sources: sortedLabels(this.sources, this.port.sourceCount()),
      destinations: sortedLabels(this.destinations, this.port.destinationCount()),
      degraded: this.labelsDegraded,
      stale: this.catalogStale,
    })
  }
}
