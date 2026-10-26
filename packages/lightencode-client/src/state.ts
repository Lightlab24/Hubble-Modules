import {
  LIGHTENCODE_MAXIMUM_SLOT_NUMBER,
  LIGHTENCODE_MINIMUM_SLOT_NUMBER,
  LightEncodeHelloAckSchema,
  LightEncodeStateSnapshotSchema,
  type LightEncodeConfirmation,
  type LightEncodeHelloAck,
  type LightEncodePipelineState,
  type LightEncodeStateSnapshot,
} from './protocol.js'

export interface LightEncodeStateApplyResult {
  readonly accepted: boolean
  readonly state: LightEncodeStateSnapshot | null
}

export interface LightEncodeHelloApplyResult {
  readonly sessionChanged: boolean
  readonly sessionId: string
}

export class LightEncodeStateStore {
  private currentSessionId: string | null = null
  private currentSnapshot: LightEncodeStateSnapshot | null = null

  get sessionId(): string | null {
    return this.currentSessionId
  }

  get snapshot(): LightEncodeStateSnapshot | null {
    return this.currentSnapshot
  }

  applyHello(hello: LightEncodeHelloAck): LightEncodeHelloApplyResult {
    const parsed = LightEncodeHelloAckSchema.parse(hello)
    const sessionChanged =
      this.currentSessionId !== null && this.currentSessionId !== parsed.sessionId
    this.currentSessionId = parsed.sessionId
    this.currentSnapshot = null
    return Object.freeze({ sessionChanged, sessionId: parsed.sessionId })
  }

  applyState(snapshot: LightEncodeStateSnapshot): LightEncodeStateApplyResult {
    if (this.currentSessionId === null) {
      return Object.freeze({ accepted: false, state: this.currentSnapshot })
    }
    const parsed = LightEncodeStateSnapshotSchema.parse(snapshot)
    if (this.currentSnapshot && parsed.revision < this.currentSnapshot.revision) {
      return Object.freeze({ accepted: false, state: this.currentSnapshot })
    }
    this.currentSnapshot = parsed
    return Object.freeze({ accepted: true, state: parsed })
  }

  clear(): void {
    this.currentSessionId = null
    this.currentSnapshot = null
  }
}

export function lightEncodePipelineForSlot(
  snapshot: LightEncodeStateSnapshot,
  slotNumber: number,
): LightEncodePipelineState | undefined {
  if (
    !Number.isSafeInteger(slotNumber) ||
    slotNumber < LIGHTENCODE_MINIMUM_SLOT_NUMBER ||
    slotNumber > LIGHTENCODE_MAXIMUM_SLOT_NUMBER
  ) {
    return undefined
  }
  return snapshot.pipelines[slotNumber - 1]
}

export function matchesLightEncodeConfirmation(
  snapshot: LightEncodeStateSnapshot | null,
  minimumRevision: number,
  confirmation: LightEncodeConfirmation,
): boolean {
  if (!snapshot || snapshot.revision < minimumRevision) return false

  switch (confirmation.kind) {
    case 'pipelinesRecording': {
      const pipelines = new Map(
        snapshot.pipelines.map((pipeline) => [pipeline.pipelineId.toLowerCase(), pipeline]),
      )
      return confirmation.pipelineIds.every((pipelineId) => {
        const pipeline = pipelines.get(pipelineId.toLowerCase())
        if (!pipeline) return false
        return confirmation.recording
          ? pipeline.recordingState === 'recording'
          : pipeline.recordingState !== 'recording'
      })
    }
    case 'timerEnabled':
      return snapshot.app.timerEnabled === confirmation.enabled
    case 'timerMinutes':
      return snapshot.app.timerMinutes === confirmation.minutes
  }
}
