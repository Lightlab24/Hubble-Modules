import { DitBrowseStatusSchema, type DitBrowseStatus } from './protocol.js'

export interface DitBrowseCameraCatalogEntry {
  readonly cameraNumber: number
  readonly title: string
  readonly url: string
}

export interface DitBrowseState {
  readonly status: DitBrowseStatus | null
  readonly revision: number
  readonly catalog: readonly DitBrowseCameraCatalogEntry[]
}

export interface DitBrowseStatusApplyResult {
  readonly accepted: boolean
  readonly catalogChanged: boolean
  readonly state: DitBrowseState
}

export function createEmptyDitBrowseState(): DitBrowseState {
  return Object.freeze({ status: null, revision: -1, catalog: Object.freeze([]) })
}

function buildCatalog(status: DitBrowseStatus): readonly DitBrowseCameraCatalogEntry[] {
  const observed = new Set<number>()
  const catalog: DitBrowseCameraCatalogEntry[] = []
  for (const tab of status.tabs) {
    if (tab.cameraNumber === null || observed.has(tab.cameraNumber)) continue
    observed.add(tab.cameraNumber)
    catalog.push(
      Object.freeze({
        cameraNumber: tab.cameraNumber,
        title: tab.title,
        url: tab.url,
      }),
    )
  }
  return Object.freeze(catalog)
}

function catalogsEqual(
  left: readonly DitBrowseCameraCatalogEntry[],
  right: readonly DitBrowseCameraCatalogEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        entry.cameraNumber === candidate.cameraNumber &&
        entry.title === candidate.title &&
        entry.url === candidate.url
      )
    })
  )
}

export function applyDitBrowseStatus(
  current: DitBrowseState,
  status: DitBrowseStatus,
  revision?: number,
): DitBrowseStatusApplyResult {
  if (revision !== undefined) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new RangeError('DIT Browse status revision must be a non-negative integer')
    }
    if (revision <= current.revision) {
      return Object.freeze({ accepted: false, catalogChanged: false, state: current })
    }
  }

  const parsedStatus = DitBrowseStatusSchema.parse(status)
  const catalog = buildCatalog(parsedStatus)
  const catalogChanged = !catalogsEqual(current.catalog, catalog)
  const state = Object.freeze({
    status: parsedStatus,
    revision: revision ?? current.revision,
    catalog,
  })
  return Object.freeze({ accepted: true, catalogChanged, state })
}
