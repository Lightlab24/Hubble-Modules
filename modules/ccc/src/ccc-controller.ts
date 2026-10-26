import {
  RcpSession,
  type CyanViewCameraParameterStep,
  type CyanViewCameraTarget,
} from '@hubble/protocol-cyanview-rcp'
import { randomUUID } from 'node:crypto'
import {
  CyanViewRcpConnectionDefinitionSchema,
  EMPTY_CCC,
  cccCommandControlsRecording,
  cccCommandNeedsCamera,
  cccTargetKey,
  type CccBatchResult,
  type CccCommand,
  type CccCommandRequest,
  type CccConfig,
  type CccMutationRequest,
  type CccResult,
  type CccRow,
  type CccState,
  type CyanViewRcpConnectionDefinition,
} from './config.js'

const PARAMETER_STEPS = new Map<CccCommand, CyanViewCameraParameterStep>([
  ['nd-up-enabled-cameras', { parameter: 'nd_filter', direction: 'next' }],
  ['nd-down-enabled-cameras', { parameter: 'nd_filter', direction: 'prev' }],
  ['iso-up-enabled-cameras', { parameter: 'master_gain', direction: 'next' }],
  ['iso-down-enabled-cameras', { parameter: 'master_gain', direction: 'prev' }],
])

export interface CccStore {
  read(workspaceId: string): Promise<CccConfig>
  mutate(request: CccMutationRequest): Promise<CccConfig>
}
interface ConnectionEntry {
  readonly session: RcpSession
  leases: number
}
interface CapturedTarget {
  readonly row: CccRow
  readonly epoch: number
  readonly entry?: ConnectionEntry
  readonly target?: CyanViewCameraTarget
  readonly error?: string
}

export type CccControllerContract = Pick<
  CccController,
  'activate' | 'state' | 'mutate' | 'command' | 'subscribe' | 'stop'
>

/** One selection authority for the spreadsheet, matrix, Companion and Stream Deck. */
export class CccController {
  private workspaceId = ''
  private config: CccConfig = EMPTY_CCC
  private readonly entries = new Map<string, ConnectionEntry>()
  private readonly results = new Map<string, CccResult>()
  private readonly listeners = new Set<() => void>()
  private acceptance: Promise<unknown> = Promise.resolve()
  private publishing: Promise<unknown> = Promise.resolve()
  private stopped = false
  private nextEpoch = 0
  private readonly epochs = new Map<string, number>()

  constructor(
    private readonly store: CccStore,
    private readonly feedbackTimeoutMs = 1500,
    private readonly createSession = (
      definition: CyanViewRcpConnectionDefinition,
      changed: () => void,
    ): RcpSession =>
      new RcpSession(CyanViewRcpConnectionDefinitionSchema.parse(definition), changed, true),
  ) {}

  activate(workspaceId: string): Promise<void> {
    return this.serialize(async () => {
      const config = await this.store.read(workspaceId)
      if (workspaceId !== this.workspaceId) {
        this.results.clear()
        this.epochs.clear()
      }
      this.workspaceId = workspaceId
      this.adopt(config)
    })
  }

  state(): CccState {
    return {
      workspaceId: this.workspaceId,
      config: this.config,
      rows: this.config.rows.map((row) => {
        const base = {
          rowId: row.rowId,
          name: '',
          recording: 'unknown' as const,
          lastResult: this.results.get(row.rowId) ?? null,
        }
        if (cccTargetKey(row) === null)
          return {
            ...base,
            connection: 'incomplete' as const,
            message: 'Enter an RCP IP and camera number',
          }
        const session = this.entries.get(row.rcpIp)?.session
        const snapshot = session?.snapshot()
        if (!session || snapshot?.phase !== 'ready')
          return {
            ...base,
            connection:
              snapshot?.phase === 'checking' ? ('connecting' as const) : ('offline' as const),
            message: snapshot?.lastError ?? 'Connecting to RCP',
          }
        const cameras = session
          .cameraObservations()
          .filter((camera) => camera.number === row.cameraNumber)
        const camera = cameras[0]
        if (cameras.length !== 1 || !camera)
          return {
            ...base,
            connection: 'error' as const,
            message: cameras.length
              ? 'Camera number is ambiguous on this RCP'
              : 'Camera number was not found on this RCP',
          }
        return {
          ...base,
          name: camera.name,
          connection: camera.online === true ? ('online' as const) : ('offline' as const),
          recording:
            camera.online !== true || camera.recording === null
              ? ('unknown' as const)
              : camera.recording
                ? ('recording' as const)
                : ('stopped' as const),
          message: camera.recordingLocked
            ? 'Recording locked'
            : camera.online === true
              ? 'Online'
              : 'Camera offline',
        }
      }),
    }
  }

  mutate(request: CccMutationRequest): Promise<CccState> {
    return this.serialize(async () => {
      this.requireWorkspace(request.workspaceId)
      this.adopt(await this.store.mutate(request))
      return this.state()
    })
  }

  async command(request: CccCommandRequest, signal?: AbortSignal): Promise<CccBatchResult> {
    const accepted = await this.serialize(async () => {
      this.requireWorkspace(request.workspaceId)
      const batchId = randomUUID()
      if (cccCommandNeedsCamera(request.command) || request.command === 'enable-all-cameras') {
        const enableAll = !this.config.rows
          .filter((row) => cccTargetKey(row) !== null)
          .every((row) => row.enabled)
        const mutation =
          request.command === 'enable-all-cameras'
            ? {
                kind: 'replace' as const,
                expectedRevision: this.config.revision,
                rows: this.config.rows.map((row) =>
                  cccTargetKey(row) === null ? row : { ...row, enabled: enableAll },
                ),
              }
            : {
                kind: 'enabled' as const,
                rowId: request.rowId ?? '',
                enabled: 'toggle' as const,
              }
        this.adopt(await this.store.mutate({ workspaceId: request.workspaceId, mutation }))
        return {
          completion: Promise.resolve({ batchId, command: request.command, results: [] }),
        }
      }
      const targets = this.enabledTargets(request.command)
      if (!targets.length) throw new Error('No complete, valid CCC cameras are enabled')
      const run = () => this.publishBatch(request, batchId, targets, signal)
      const completion = this.publishing.then(run, run)
      this.publishing = completion.catch(() => undefined)
      return { completion }
    })
    return accepted.completion
  }

  /** Capture the shared selection and concrete MQTT addresses at acceptance time. */
  private enabledTargets(command: CccCommand): readonly CapturedTarget[] {
    return this.config.rows
      .filter((row) => row.enabled && cccTargetKey(row) !== null)
      .map((row) => {
        const epoch = this.epochs.get(row.rowId) ?? 0
        try {
          const entry = this.entries.get(row.rcpIp)
          if (!entry || row.cameraNumber === null) throw new Error('RCP is unavailable')
          const target = entry.session.resolveCamera(
            row.cameraNumber,
            cccCommandControlsRecording(command) ? 'recording' : 'adjustment',
          )
          entry.leases += 1
          return { row, epoch, entry, target }
        } catch (error) {
          return {
            row,
            epoch,
            error: error instanceof Error ? error.message : 'Camera is unavailable',
          }
        }
      })
  }

  private async publishBatch(
    request: CccCommandRequest,
    batchId: string,
    targets: readonly CapturedTarget[],
    signal?: AbortSignal,
  ): Promise<CccBatchResult> {
    const results: CccResult[] = []
    let cursor = 0
    const feedback: Promise<void>[] = []
    const worker = async () => {
      for (;;) {
        const index = cursor++
        const captured = targets[index]
        if (!captured) return
        const { row, entry, target, epoch } = captured
        const result = (phase: CccResult['phase'], message: string): CccResult => ({
          rowId: row.rowId,
          rcpIp: row.rcpIp,
          cameraNumber: row.cameraNumber,
          phase,
          message,
        })
        const finish = (final: CccResult) => {
          results[index] = final
          this.updateResult(request.workspaceId, row, epoch, final)
          if (entry) entry.leases -= 1
          this.pruneConnections()
        }
        try {
          if (this.stopped || signal?.aborted) throw new Error('CCC command was cancelled')
          if (!entry || !target) throw new Error(captured.error ?? 'Camera is unavailable')
          const step = PARAMETER_STEPS.get(request.command)
          if (step) {
            await entry.session.stepCameraParameter(target, step, signal)
            // A broker acknowledgement is delivery, not camera-state confirmation.
            finish(result('sent', 'Sent to RCP'))
            continue
          }
          const observation = entry.session
            .cameraObservations()
            .find((camera) => camera.address === target.address)
          const before = observation?.recordingSequence ?? 0
          const toggle = request.command === 'roll-toggle-enabled-cameras'
          // Status predicts confirmation only; the camera performs the toggle.
          const expectedRecording = toggle
            ? observation?.recording == null
              ? null
              : !observation.recording
            : request.command === 'roll-enabled-cameras'
          await entry.session.sendCameraCommand(
            target,
            toggle ? 'RecToggle' : request.command === 'roll-enabled-cameras' ? 'Rec' : 'Stop',
            signal,
          )
          this.updateResult(request.workspaceId, row, epoch, result('sent', 'Sent to RCP'))
          // Only publishing occupies a concurrency slot. A slow camera's feedback
          // must not delay sending to the rest of the group.
          feedback.push(
            this.waitForFeedback(
              entry.session,
              target.address,
              before,
              expectedRecording,
              signal,
            ).then((confirmed) => {
              finish(
                result(
                  confirmed ? 'confirmed' : 'unconfirmed',
                  confirmed
                    ? 'Confirmed by camera'
                    : 'Sent; matching camera feedback was not received',
                ),
              )
            }),
          )
        } catch (error) {
          finish(
            result(
              'error',
              error instanceof Error ? error.message.slice(0, 512) : 'Command failed',
            ),
          )
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
    await Promise.all(feedback)
    return { batchId, command: request.command, results }
  }

  private waitForFeedback(
    session: RcpSession,
    address: string,
    after: number,
    recording: boolean | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (recording === null) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (matched: boolean) => {
        clearTimeout(timer)
        this.listeners.delete(check)
        signal?.removeEventListener('abort', abort)
        resolve(matched)
      }
      const check = () => {
        const camera = session.cameraObservations().find((item) => item.address === address)
        if (
          camera &&
          camera.online === true &&
          camera.recordingSequence > after &&
          camera.recording === recording
        )
          finish(true)
      }
      const abort = () => {
        finish(false)
      }
      this.listeners.add(check)
      const timer = setTimeout(() => {
        finish(false)
      }, this.feedbackTimeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) finish(false)
      else check()
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) entry.session.stop()
    this.entries.clear()
    this.results.clear()
    this.emit()
  }

  private adopt(config: CccConfig): void {
    const previous = new Map(this.config.rows.map((row) => [row.rowId, cccTargetKey(row)]))
    for (const row of config.rows) {
      if (previous.get(row.rowId) !== cccTargetKey(row) || !this.epochs.has(row.rowId)) {
        this.results.delete(row.rowId)
        this.epochs.set(row.rowId, ++this.nextEpoch)
      }
    }
    for (const id of this.epochs.keys())
      if (!config.rows.some((row) => row.rowId === id)) this.epochs.delete(id)
    for (const id of this.results.keys())
      if (!config.rows.some((row) => row.rowId === id)) this.results.delete(id)
    this.config = config
    for (const row of config.rows) {
      if (!row.rcpIp || this.entries.has(row.rcpIp)) continue
      const definition = CyanViewRcpConnectionDefinitionSchema.parse({
        type: 'cyanview-rcp',
        connectionId: randomUUID(),
        name: `CCC ${row.rcpIp}`,
        host: row.rcpIp,
        port: 1883,
        requestTimeoutMs: 3000,
        enabled: true,
        schemaVersion: 1,
      })
      this.entries.set(row.rcpIp, {
        session: this.createSession(definition, () => {
          this.emit()
        }),
        leases: 0,
      })
    }
    this.pruneConnections()
    this.emit()
  }

  private pruneConnections(): void {
    const used = new Set(this.config.rows.map((row) => row.rcpIp))
    for (const [ip, entry] of this.entries)
      if (!used.has(ip) && entry.leases === 0) {
        this.entries.delete(ip)
        entry.session.stop()
      }
  }
  private updateResult(
    workspaceId: string,
    row: CccRow,
    epoch: number,
    result: CccResult,
  ): void {
    if (
      workspaceId !== this.workspaceId ||
      this.epochs.get(row.rowId) !== epoch ||
      !this.config.rows.some(
        (current) => current.rowId === row.rowId && cccTargetKey(current) === cccTargetKey(row),
      )
    )
      return
    this.results.set(row.rowId, result)
    this.emit()
  }
  private requireWorkspace(workspaceId: string): void {
    if (this.stopped || workspaceId !== this.workspaceId)
      throw new Error('CCC workspace is unavailable')
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.acceptance.then(operation, operation)
    this.acceptance = result.catch(() => undefined)
    return result
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* An observer cannot interrupt control. */
      }
    }
  }
}
