import type { Swp08Crosspoint, Swp08RouteMapSnapshot } from './models.js'

/** Apply authoritative deltas while preserving earlier published snapshots. */
export function updateRouteSnapshot(
  previous: Swp08RouteMapSnapshot,
  crosspoints: readonly Swp08Crosspoint[],
  revision: number,
): Swp08RouteMapSnapshot {
  const routes = new Map(previous.routes)
  const changed = new Map<number, Map<number, number>>()
  for (const { destination, level, source } of crosspoints) {
    let levels = changed.get(destination)
    if (!levels) {
      levels = new Map(routes.get(destination) ?? [])
      changed.set(destination, levels)
      routes.set(destination, levels)
    }
    levels.set(level, source)
  }
  return Object.freeze({ revision, routes })
}
