import { describe, expect, it } from 'vitest'

import type { DitBrowseStatus } from '../src/protocol.js'
import { applyDitBrowseStatus, createEmptyDitBrowseState } from '../src/state.js'

describe('DIT Browse status state', () => {
  it('atomically applies status and de-duplicates the camera catalog in tab order', () => {
    const initial = createEmptyDitBrowseState()
    const status = makeStatus([
      tab(1, 3, 'CAM 3'),
      tab(2, 3, 'CAM 3 duplicate'),
      tab(3, null, 'Unnumbered'),
      tab(4, 4, 'CAM 4'),
    ])

    const applied = applyDitBrowseStatus(initial, status, 8)

    expect(applied.accepted).toBe(true)
    expect(applied.catalogChanged).toBe(true)
    expect(applied.state.revision).toBe(8)
    expect(applied.state.catalog).toEqual([
      { cameraNumber: 3, title: 'CAM 3', url: 'http://camera-1/' },
      { cameraNumber: 4, title: 'CAM 4', url: 'http://camera-4/' },
    ])
  })

  it('rejects stale and duplicate revisions without replacing state', () => {
    const accepted = applyDitBrowseStatus(
      createEmptyDitBrowseState(),
      makeStatus([tab(1, 1)]),
      5,
    )

    for (const revision of [4, 5]) {
      const stale = applyDitBrowseStatus(accepted.state, makeStatus([tab(1, 2)]), revision)
      expect(stale).toEqual({
        accepted: false,
        catalogChanged: false,
        state: accepted.state,
      })
    }
  })

  it('accepts direct command status without moving the event revision backwards', () => {
    const event = applyDitBrowseStatus(createEmptyDitBrowseState(), makeStatus([tab(1, 1)]), 12)
    const direct = applyDitBrowseStatus(event.state, makeStatus([tab(1, 2)]))

    expect(direct.accepted).toBe(true)
    expect(direct.state.revision).toBe(12)
    expect(direct.state.status?.selectedCameraNumber).toBe(2)
  })
})

function tab(
  index: number,
  cameraNumber: number | null,
  title = `CAM ${cameraNumber === null ? '' : String(cameraNumber)}`,
) {
  const indexText = String(index)
  return {
    index,
    tileId: `tile-${indexText}`,
    cameraId: cameraNumber === null ? null : `camera-${String(cameraNumber)}`,
    cameraNumber,
    title,
    url: `http://camera-${indexText}/`,
  }
}

function makeStatus(tabs: DitBrowseStatus['tabs']): DitBrowseStatus {
  const selected = tabs.find((candidate) => candidate.cameraNumber !== null) ?? null
  return {
    expansionEnabled: true,
    focusMode: selected !== null,
    selectedCameraNumber: selected?.cameraNumber ?? null,
    selectedTileId: selected?.tileId ?? null,
    selectedIndex: selected?.index ?? null,
    tabs,
  }
}
