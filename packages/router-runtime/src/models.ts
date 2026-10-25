export interface Swp08Crosspoint {
  readonly matrix: number
  readonly source: number
  readonly destination: number
  readonly level: number
}
export interface Swp08RouterLabel {
  readonly address: number
  readonly label: string
}
export interface Swp08NameCatalogSnapshot {
  readonly revision: number
  readonly sources: readonly Swp08RouterLabel[]
  readonly destinations: readonly Swp08RouterLabel[]
}
export interface Swp08RouteMapSnapshot {
  readonly revision: number
  readonly routes: ReadonlyMap<number, ReadonlyMap<number, number>>
}
export type Swp08ConnectionPhase = 'disconnected' | 'connecting' | 'connected'
