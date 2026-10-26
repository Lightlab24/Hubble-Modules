import { describe, expect, it } from 'vitest'

import type { LightEncodeHelloAck, LightEncodeStateSnapshot } from '../src/protocol.js'
import {
  LightEncodeStateStore,
  lightEncodePipelineForSlot,
  matchesLightEncodeConfirmation,
} from '../src/state.js'

const FIRST_ID = 'd396fe70-517f-416c-882b-c831795ad942'
const SECOND_ID = 'd7621840-e45b-4ce4-aab4-15f0918bf28f'

describe('LightEncodeStateStore', () => {
  it('requires a hello, replaces all state on session change, and clears explicitly', () => {
    const store = new LightEncodeStateStore()
    expect(store.applyState(state(1))).toMatchObject({ accepted: false })

    store.applyHello(hello('49fd5ac4-8c89-4f15-a596-bec3667d5be8'))
    expect(
      store.applyState(state(8, [{ id: FIRST_ID, recordingState: 'recording' }])),
    ).toMatchObject({ accepted: true })

    const replacement = store.applyHello(hello('a55fe1af-8ab8-469e-aa45-904983c78ea6'))
    expect(replacement.sessionChanged).toBe(true)
    expect(store.sessionId).toBe('a55fe1af-8ab8-469e-aa45-904983c78ea6')
    expect(store.snapshot).toBeNull()

    store.clear()
    expect(store.sessionId).toBeNull()
    expect(store.snapshot).toBeNull()
  })

  it('ignores only older revisions and accepts a current-revision replacement', () => {
    const store = connectedStore()
    const accepted = store.applyState(state(8, [{ id: FIRST_ID, recordingState: 'recording' }]))

    const stale = store.applyState(state(7, [{ id: FIRST_ID, recordingState: 'idle' }]))
    expect(stale).toEqual({ accepted: false, state: accepted.state })
    expect(store.snapshot?.pipelines[0]?.recordingState).toBe('recording')

    expect(
      store.applyState(state(8, [{ id: FIRST_ID, recordingState: 'finishing' }])).accepted,
    ).toBe(true)
    expect(store.snapshot?.pipelines[0]?.recordingState).toBe('finishing')
  })

  it('resolves top-to-bottom slots against the newest snapshot', () => {
    const first = state(1, [{ id: FIRST_ID }, { id: SECOND_ID }])
    expect(lightEncodePipelineForSlot(first, 1)?.pipelineId).toBe(FIRST_ID)
    expect(lightEncodePipelineForSlot(first, 2)?.pipelineId).toBe(SECOND_ID)
    expect(lightEncodePipelineForSlot(first, 0)).toBeUndefined()
    expect(lightEncodePipelineForSlot(first, 1.5)).toBeUndefined()
    expect(lightEncodePipelineForSlot(first, 1_000)).toBeUndefined()

    const shifted = state(2, [{ id: SECOND_ID }])
    expect(lightEncodePipelineForSlot(shifted, 1)?.pipelineId).toBe(SECOND_ID)
  })

  it('matches all confirmation variants at or above the response revision', () => {
    const snapshot = state(
      9,
      [
        { id: FIRST_ID, recordingState: 'recording' },
        { id: SECOND_ID, recordingState: 'finishing' },
      ],
      { timerEnabled: true, timerMinutes: 45 },
    )

    expect(
      matchesLightEncodeConfirmation(snapshot, 9, {
        kind: 'pipelinesRecording',
        pipelineIds: [FIRST_ID.toUpperCase()],
        recording: true,
      }),
    ).toBe(true)
    expect(
      matchesLightEncodeConfirmation(snapshot, 9, {
        kind: 'pipelinesRecording',
        pipelineIds: [SECOND_ID],
        recording: false,
      }),
    ).toBe(true)
    expect(
      matchesLightEncodeConfirmation(snapshot, 9, {
        kind: 'pipelinesRecording',
        pipelineIds: [FIRST_ID, SECOND_ID],
        recording: true,
      }),
    ).toBe(false)
    expect(
      matchesLightEncodeConfirmation(snapshot, 9, { kind: 'timerEnabled', enabled: true }),
    ).toBe(true)
    expect(
      matchesLightEncodeConfirmation(snapshot, 9, { kind: 'timerMinutes', minutes: 45 }),
    ).toBe(true)
    expect(
      matchesLightEncodeConfirmation(snapshot, 10, { kind: 'timerMinutes', minutes: 45 }),
    ).toBe(false)
  })
})

function connectedStore(): LightEncodeStateStore {
  const store = new LightEncodeStateStore()
  store.applyHello(hello('49fd5ac4-8c89-4f15-a596-bec3667d5be8'))
  return store
}

function hello(sessionId: string): LightEncodeHelloAck {
  return {
    type: 'helloAck',
    protocol: 'lightencode-companion',
    protocolVersion: 1,
    appVersion: '1.0.0',
    sessionId,
    capabilities: ['record.toggleAll', 'record.togglePipeline', 'timer.toggle', 'timer.set'],
  }
}

function state(
  revision: number,
  pipelines: ReadonlyArray<{
    readonly id: string
    readonly recordingState?: 'idle' | 'recording' | 'finishing' | 'error'
  }> = [],
  app: { readonly timerEnabled?: boolean; readonly timerMinutes?: number } = {},
): LightEncodeStateSnapshot {
  return {
    type: 'state',
    revision,
    app: {
      anyRecording: pipelines.some((pipeline) => pipeline.recordingState === 'recording'),
      timerEnabled: app.timerEnabled ?? false,
      timerMinutes: app.timerMinutes ?? 0,
    },
    pipelines: pipelines.map((pipeline, index) => ({
      pipelineId: pipeline.id,
      cameraId: `CAM${String(index + 1)}`,
      recordingEnabled: true,
      canStartRecording: true,
      recordingState: pipeline.recordingState ?? 'idle',
      errorMessage: null,
    })),
  }
}
