import { connectionCandidates } from '@hubble/module-contracts/settings'
import {
  ConnectionDefinitionsSchema,
  LIVEGRADE_APPLICATIONS,
  LiveGradeApplicationSchema,
  LiveGradeSlotInputSchema,
  LiveGradeSlotPositionSchema,
  liveGradeActionApplication,
  liveGradeApplicationTarget,
  resolveLiveGradeSlotQuery,
  type LiveGradeApplication,
  type LiveGradeApplicationEdition,
  type LiveGradeConnectionDefinition,
  type LiveGradeSlotCatalogEntry,
} from './config.js'

import {
  LiveGradeHelperClientError,
  type LiveGradeHelperClientContract,
  type LiveGradeHelperResponse,
} from './livegrade-helper-client.js'

const DEFAULT_POLL_INTERVAL_MS = 10_000

export type LiveGradeConnectionPhase =
  | 'discovering'
  | 'ready'
  | 'not-running'
  | 'permission-required'
  | 'menu-unavailable'
  | 'error'

export interface ManagedLiveGradeConnectionSnapshot {
  readonly definition: LiveGradeConnectionDefinition
  readonly applications?: readonly ManagedLiveGradeApplicationSnapshot[]
  readonly phase: LiveGradeConnectionPhase
  readonly applicationVersion: string | null
  readonly slots: readonly LiveGradeSlotCatalogEntry[]
  readonly lastError: string | null
  readonly errorCode: string | null
}

export class LiveGradeConnectionError extends Error {
  override readonly name = 'LiveGradeConnectionError'

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type LiveGradeConnectionManagerListener = (
  snapshots: readonly ManagedLiveGradeConnectionSnapshot[],
) => void

export interface LiveGradeConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  snapshots(): readonly ManagedLiveGradeConnectionSnapshot[]
  subscribe(listener: LiveGradeConnectionManagerListener): () => void
  requestAccessibilityPermission(connectionId: string): Promise<void>
  selectSlot(
    connectionId: string,
    request: LiveGradeSlotSelectionRequest,
  ): Promise<LiveGradeSlotCatalogEntry>
  stop(): void
}

export interface LiveGradeSlotSelectionRequest {
  readonly application?: LiveGradeApplication
  readonly position: number | null
  readonly query: string
}

export type LiveGradeManagedClientFactory = (
  definition: Omit<LiveGradeConnectionDefinition, 'edition'> & {
    readonly edition: LiveGradeApplicationEdition
  },
) => LiveGradeHelperClientContract

export interface LiveGradeConnectionManagerOptions {
  readonly createClient: LiveGradeManagedClientFactory
  readonly pollIntervalMs?: number
}

export interface ManagedLiveGradeApplicationSnapshot {
  readonly application: LiveGradeApplication
  readonly phase: LiveGradeConnectionPhase
  readonly applicationVersion: string | null
  readonly slots: readonly LiveGradeSlotCatalogEntry[]
  readonly lastError: string | null
  readonly errorCode: string | null
}

interface ManagedApplication {
  readonly application: LiveGradeApplication
  readonly client: LiveGradeHelperClientContract
  phase: LiveGradeConnectionPhase
  applicationVersion: string | null
  slots: readonly LiveGradeSlotCatalogEntry[]
  lastError: string | null
  errorCode: string | null
}

interface ManagedEntry {
  definition: LiveGradeConnectionDefinition
  readonly applications: ReadonlyMap<LiveGradeApplication, ManagedApplication>
  timer: ReturnType<typeof setTimeout> | null
  queue: Promise<void>
  removed: boolean
}

export class LiveGradeConnectionManager implements LiveGradeConnectionManagerContract {
  readonly #entries = new Map<string, ManagedEntry>()
  readonly #listeners = new Set<LiveGradeConnectionManagerListener>()
  readonly #createClient: LiveGradeManagedClientFactory
  readonly #pollIntervalMs: number

  constructor(options: LiveGradeConnectionManagerOptions) {
    this.#createClient = options.createClient
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 100) {
      throw new RangeError('LiveGrade polling interval must be at least 100 ms')
    }
  }

  reconcile(connectionValues: readonly unknown[]): void {
    const connections = ConnectionDefinitionsSchema.parse(
      structuredClone(connectionCandidates(connectionValues, 'livegrade')),
    )
    const enabled = new Map<string, LiveGradeConnectionDefinition>(
      connections
        .filter(
          (connection): connection is LiveGradeConnectionDefinition =>
            connection.type === 'livegrade' && connection.enabled,
        )
        .map((definition) => [definition.connectionId, definition]),
    )
    for (const [connectionId, entry] of [...this.#entries]) {
      const definition = enabled.get(connectionId)
      if (definition === undefined) {
        this.removeEntry(connectionId, entry)
        continue
      }
      if (
        liveGradeActionApplication('select-slot', entry.definition) !==
        liveGradeActionApplication('select-slot', definition)
      ) {
        this.removeEntry(connectionId, entry)
        this.addEntry(definition)
        enabled.delete(connectionId)
        continue
      }
      const timeoutChanged = entry.definition.requestTimeoutMs !== definition.requestTimeoutMs
      entry.definition = definition
      enabled.delete(connectionId)
      if (timeoutChanged) this.scheduleProbe(entry, 0)
    }
    for (const definition of enabled.values()) this.addEntry(definition)
    this.emit()
  }

  refresh(): void {
    for (const entry of this.#entries.values()) this.scheduleProbe(entry, 0)
  }

  snapshots(): readonly ManagedLiveGradeConnectionSnapshot[] {
    return Object.freeze(
      [...this.#entries.values()].map((entry) => {
        const applications = Object.freeze(
          [...entry.applications.values()].map((application) =>
            Object.freeze({
              application: application.application,
              phase: application.phase,
              applicationVersion: application.applicationVersion,
              slots: Object.freeze(application.slots.map((slot) => Object.freeze({ ...slot }))),
              lastError: application.lastError,
              errorCode: application.errorCode,
            }),
          ),
        )
        const preferred = applications.find(
          ({ application }) =>
            application === liveGradeActionApplication('select-slot', entry.definition),
        )
        if (preferred === undefined)
          throw new Error('Configured LiveGrade application is unavailable')
        const primary =
          preferred.phase === 'ready'
            ? preferred
            : (applications.find(({ phase }) => phase === 'ready') ??
              applications.find(({ phase }) => phase === 'permission-required') ??
              preferred)
        return Object.freeze({ ...primary, definition: entry.definition, applications })
      }),
    )
  }

  subscribe(listener: LiveGradeConnectionManagerListener): () => void {
    this.#listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      /* Observers cannot affect control. */
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }

  requestAccessibilityPermission(connectionId: string): Promise<void> {
    const entry = this.#entries.get(connectionId)
    if (entry === undefined || entry.removed) return Promise.reject(unavailableConnection())
    return this.serialize(entry, async () => {
      await this.probeApplications(entry)
    })
  }

  selectSlot(
    connectionId: string,
    requestValue: LiveGradeSlotSelectionRequest,
  ): Promise<LiveGradeSlotCatalogEntry> {
    const entry = this.#entries.get(connectionId)
    if (entry === undefined || entry.removed) return Promise.reject(unavailableConnection())
    const application =
      requestValue.application === undefined
        ? liveGradeActionApplication('select-slot', entry.definition)
        : LiveGradeApplicationSchema.parse(requestValue.application)
    const targetApplication = entry.applications.get(application)
    if (targetApplication === undefined) return Promise.reject(unavailableConnection())
    const request = Object.freeze({
      position:
        requestValue.position === null
          ? null
          : LiveGradeSlotPositionSchema.parse(requestValue.position),
      query: LiveGradeSlotInputSchema.parse(requestValue.query),
    })
    return this.serialize(entry, async () => {
      this.requireCurrentEntry(entry)
      let refreshed = false
      if (targetApplication.phase !== 'ready') {
        await this.probeApplication(entry, targetApplication, true)
        refreshed = true
      }
      let target: LiveGradeSlotCatalogEntry
      try {
        target = resolveSelection(targetApplication.slots, request)
      } catch (error) {
        if (!(error instanceof LiveGradeConnectionError) || refreshed) throw error
        await this.probeApplication(entry, targetApplication, true)
        target = resolveSelection(targetApplication.slots, request)
      }
      this.requireCurrentEntry(entry)
      let response: LiveGradeHelperResponse
      try {
        response = await targetApplication.client.selectSlot({
          position: target.position,
          timeoutMs: entry.definition.requestTimeoutMs,
        })
      } catch (error) {
        this.requireCurrentEntry(entry)
        this.applyClientError(targetApplication, error)
        this.emit()
        throw connectionError(error)
      }
      this.requireCurrentEntry(entry)
      this.applyResponse(targetApplication, response)
      this.emit()
      if (response.phase !== 'ready' || response.selected?.position !== target.position) {
        throw responseError(response)
      }
      return response.selected
    })
  }

  stop(): void {
    for (const [connectionId, entry] of this.#entries) this.removeEntry(connectionId, entry)
    this.#listeners.clear()
  }

  private requireCurrentEntry(entry: ManagedEntry): void {
    if (entry.removed || this.#entries.get(entry.definition.connectionId) !== entry) {
      throw unavailableConnection()
    }
  }

  private addEntry(definition: LiveGradeConnectionDefinition): void {
    const preferred = liveGradeActionApplication('select-slot', definition)
    const choices = [...LIVEGRADE_APPLICATIONS].sort(
      (left, right) => Number(right.value === preferred) - Number(left.value === preferred),
    )
    const entry: ManagedEntry = {
      definition,
      applications: new Map(
        choices.map(({ value: application }) => [
          application,
          {
            application,
            client: this.#createClient({
              ...definition,
              ...liveGradeApplicationTarget(application),
            }),
            phase: 'discovering',
            applicationVersion: null,
            slots: Object.freeze([]),
            lastError: null,
            errorCode: null,
          },
        ]),
      ),
      timer: null,
      queue: Promise.resolve(),
      removed: false,
    }
    this.#entries.set(definition.connectionId, entry)
    this.scheduleProbe(entry, 0)
  }

  private removeEntry(connectionId: string, entry: ManagedEntry): void {
    if (this.#entries.get(connectionId) !== entry) return
    this.#entries.delete(connectionId)
    entry.removed = true
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  private scheduleProbe(entry: ManagedEntry, delayMs: number): void {
    if (entry.removed || this.#entries.get(entry.definition.connectionId) !== entry) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.serialize(entry, () => this.probeApplications(entry))
        .catch(() => undefined)
        .finally(() => {
          this.scheduleProbe(entry, this.#pollIntervalMs)
        })
    }, delayMs)
    entry.timer.unref()
  }

  private serialize<TResult>(
    entry: ManagedEntry,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    // Every application on this connection shares a queue so menu automation
    // cannot overlap when consecutive actions select different LiveGrade apps.
    const result = entry.queue.catch(() => undefined).then(operation)
    entry.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async probeApplications(entry: ManagedEntry): Promise<void> {
    for (const application of entry.applications.values()) {
      await this.probeApplication(entry, application, false)
    }
  }

  private async probeApplication(
    entry: ManagedEntry,
    application: ManagedApplication,
    requireReady: boolean,
  ): Promise<void> {
    this.requireCurrentEntry(entry)
    let response: LiveGradeHelperResponse
    try {
      response = await application.client.probe(entry.definition.requestTimeoutMs)
    } catch (error) {
      this.requireCurrentEntry(entry)
      this.applyClientError(application, error)
      this.emit()
      if (requireReady) throw connectionError(error)
      return
    }
    this.requireCurrentEntry(entry)
    this.applyResponse(application, response)
    this.emit()
    if (requireReady && response.phase !== 'ready') throw responseError(response)
  }

  private applyResponse(
    application: ManagedApplication,
    response: LiveGradeHelperResponse,
  ): void {
    application.phase = response.phase
    application.applicationVersion =
      response.phase === 'ready' ? response.applicationVersion : null
    application.slots = response.phase === 'ready' ? response.slots : Object.freeze([])
    application.lastError = response.phase === 'ready' ? null : response.message
    application.errorCode = response.phase === 'ready' ? null : response.errorCode
  }

  private applyClientError(application: ManagedApplication, error: unknown): void {
    application.phase = 'error'
    application.applicationVersion = null
    application.slots = Object.freeze([])
    const mapped = connectionError(error)
    application.lastError = mapped.message
    application.errorCode = mapped.code
  }

  private emit(): void {
    if (this.#listeners.size === 0) return
    const snapshots = this.snapshots()
    for (const listener of this.#listeners) {
      try {
        listener(snapshots)
      } catch {
        /* Observers cannot affect control. */
      }
    }
  }
}

function unavailableConnection(): LiveGradeConnectionError {
  return new LiveGradeConnectionError(
    'livegrade_unconfigured',
    'LiveGrade connection is unavailable',
  )
}

function connectionError(error: unknown): LiveGradeConnectionError {
  if (error instanceof LiveGradeConnectionError) return error
  if (error instanceof LiveGradeHelperClientError) {
    if (error.code === 'helper_timeout') {
      return new LiveGradeConnectionError(
        'livegrade_timeout',
        'LiveGrade slot control timed out',
      )
    }
    return new LiveGradeConnectionError(
      'livegrade_protocol_error',
      'LiveGrade background helper failed',
    )
  }
  return new LiveGradeConnectionError(
    'livegrade_protocol_error',
    'LiveGrade slot control failed unexpectedly',
  )
}

function responseError(response: LiveGradeHelperResponse): LiveGradeConnectionError {
  const code = response.errorCode ?? 'livegrade_protocol_error'
  return new LiveGradeConnectionError(code, response.message ?? 'LiveGrade slot control failed')
}

function resolveSelection(
  slots: readonly LiveGradeSlotCatalogEntry[],
  request: LiveGradeSlotSelectionRequest,
): LiveGradeSlotCatalogEntry {
  if (request.query.trim().length > 0) {
    const resolution = resolveLiveGradeSlotQuery(slots, request.query)
    if (resolution.kind === 'ambiguous') {
      throw new LiveGradeConnectionError(
        'livegrade_slot_ambiguous',
        'LiveGrade slot query matches more than one current menu item',
      )
    }
    if (resolution.kind !== 'resolved') {
      throw new LiveGradeConnectionError(
        'livegrade_slot_not_found',
        'LiveGrade slot query does not exactly identify a current menu item',
      )
    }
    if (request.position !== null && request.position !== resolution.slot.position) {
      throw new LiveGradeConnectionError(
        'livegrade_slot_mismatch',
        'LiveGrade slot query and menu position identify different items',
      )
    }
    return resolution.slot
  }

  if (request.position === null) {
    throw new LiveGradeConnectionError(
      'livegrade_unconfigured',
      'LiveGrade slot selection is not configured',
    )
  }
  const target = slots.find((slot) => slot.position === request.position)
  if (target === undefined) {
    throw new LiveGradeConnectionError(
      'livegrade_slot_not_found',
      'LiveGrade menu position is unavailable',
    )
  }
  return target
}
