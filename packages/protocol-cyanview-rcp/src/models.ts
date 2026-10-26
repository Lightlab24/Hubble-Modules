import { type CyanViewRcpConnectionDefinition } from './config.js'

export interface CyanViewCameraObservation {
  readonly address: string
  readonly number: number | null
  readonly name: string
  readonly online: boolean | null
  readonly recording: boolean | null
  readonly recordingLocked: boolean
  readonly recordingSequence: number
  readonly variableNd: boolean
}

export interface CyanViewCameraParameterStep {
  readonly parameter: 'nd_filter' | 'master_gain'
  readonly direction: 'next' | 'prev'
}

export interface CyanViewCameraTarget {
  readonly address: string
  readonly generation: number
  readonly observation: CyanViewCameraObservation
}

export type CyanViewRcpConnectionErrorCode =
  | 'cyanview_unconfigured'
  | 'cyanview_unavailable'
  | 'cyanview_timeout'
  | 'cyanview_camera_not_found'
  | 'cyanview_invalid_request'
  | 'cyanview_protocol_error'

export class CyanViewRcpConnectionError extends Error {
  override readonly name = 'CyanViewRcpConnectionError'
  constructor(
    readonly code: CyanViewRcpConnectionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ManagedCyanViewRcpConnectionSnapshot {
  readonly definition: CyanViewRcpConnectionDefinition
  readonly phase: 'checking' | 'ready' | 'unavailable'
  readonly panelId: string | null
  readonly activeCameraNumber: number | null
  readonly lastEventAt: string | null
  readonly lastError: string | null
}

export type CyanViewRcpConnectionManagerListener = (
  snapshots: readonly ManagedCyanViewRcpConnectionSnapshot[],
) => void

export interface CyanViewRcpConnectionManagerContract {
  reconcile(connections: readonly unknown[]): void
  refresh(): void
  selectCamera(connectionId: string, cameraNumber: number, signal?: AbortSignal): Promise<void>
  recordCamera(connectionId: string, cameraNumber: number, signal?: AbortSignal): Promise<void>
  recordGroupAll(connectionId: string, signal?: AbortSignal): Promise<void>
  snapshots(): readonly ManagedCyanViewRcpConnectionSnapshot[]
  subscribe(listener: CyanViewRcpConnectionManagerListener): () => void
  stop(): void
}

export function unavailable(
  message = 'CyanView RCP is unavailable',
): CyanViewRcpConnectionError {
  return new CyanViewRcpConnectionError('cyanview_unavailable', message)
}

export interface Panel {
  activeCamera: string | null
  online: boolean | null
}

export interface PendingCommand {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}
