import { connectionCandidates } from '@hubble/module-contracts/settings'
import { ConnectionDefinitionsSchema, type CyanViewRcpConnectionDefinition } from './config.js'
import {
  CyanViewRcpConnectionError,
  type CyanViewRcpConnectionManagerContract,
  type CyanViewRcpConnectionManagerListener,
  type ManagedCyanViewRcpConnectionSnapshot,
} from './models.js'
import { RcpSession } from './session.js'

export class CyanViewRcpConnectionManager implements CyanViewRcpConnectionManagerContract {
  #entries = new Map<string, RcpSession>()
  #listeners = new Set<CyanViewRcpConnectionManagerListener>()
  #stopped = false

  reconcile(values: readonly unknown[]): void {
    if (this.#stopped) throw new Error('CyanView RCP manager is stopped')
    const enabled = new Map<string, CyanViewRcpConnectionDefinition>(
      ConnectionDefinitionsSchema.parse(
        structuredClone(connectionCandidates(values, 'cyanview-rcp')),
      )
        .filter(
          (definition): definition is CyanViewRcpConnectionDefinition =>
            definition.type === 'cyanview-rcp' && definition.enabled,
        )
        .map((definition) => [definition.connectionId, definition]),
    )
    for (const [id, session] of this.#entries) {
      const next = enabled.get(id)
      if (
        next === undefined ||
        next.host !== session.definition.host ||
        next.port !== session.definition.port ||
        next.requestTimeoutMs !== session.definition.requestTimeoutMs
      ) {
        this.#entries.delete(id)
        session.stop()
      } else {
        session.definition = next
        enabled.delete(id)
      }
    }
    for (const definition of enabled.values())
      this.#entries.set(
        definition.connectionId,
        new RcpSession(definition, () => {
          this.emit()
        }),
      )
    this.emit()
  }
  refresh(): void {
    for (const session of this.#entries.values()) session.refresh()
  }
  selectCamera(
    connectionId: string,
    cameraNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.#entries.get(connectionId)
    return (
      session?.selectCamera(cameraNumber, signal) ??
      Promise.reject(
        new CyanViewRcpConnectionError(
          'cyanview_unconfigured',
          'CyanView RCP connection is unavailable',
        ),
      )
    )
  }
  recordCamera(
    connectionId: string,
    cameraNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return (
      this.#entries.get(connectionId)?.recordCamera(cameraNumber, signal) ??
      Promise.reject(
        new CyanViewRcpConnectionError(
          'cyanview_unconfigured',
          'CyanView RCP connection is unavailable',
        ),
      )
    )
  }
  recordGroupAll(connectionId: string, signal?: AbortSignal): Promise<void> {
    return (
      this.#entries.get(connectionId)?.recordGroupAll(signal) ??
      Promise.reject(
        new CyanViewRcpConnectionError(
          'cyanview_unconfigured',
          'CyanView RCP connection is unavailable',
        ),
      )
    )
  }
  snapshots(): readonly ManagedCyanViewRcpConnectionSnapshot[] {
    return Object.freeze([...this.#entries.values()].map((session) => session.snapshot()))
  }
  subscribe(listener: CyanViewRcpConnectionManagerListener): () => void {
    if (!this.#stopped) this.#listeners.add(listener)
    try {
      listener(this.snapshots())
    } catch {
      /* Observers cannot affect the transport. */
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }
  stop(): void {
    this.#stopped = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    for (const session of entries) session.stop()
    this.emit()
    this.#listeners.clear()
  }
  private emit(): void {
    const snapshots = this.snapshots()
    for (const listener of this.#listeners) {
      try {
        listener(snapshots)
      } catch {
        /* Observers cannot affect the transport. */
      }
    }
  }
}
export {
  CyanViewRcpConnectionError,
  type CyanViewCameraObservation,
  type CyanViewCameraParameterStep,
  type CyanViewCameraTarget,
  type CyanViewRcpConnectionErrorCode,
  type CyanViewRcpConnectionManagerContract,
  type CyanViewRcpConnectionManagerListener,
  type ManagedCyanViewRcpConnectionSnapshot,
} from './models.js'
export { RcpSession } from './session.js'
