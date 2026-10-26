import { type QuartzMessage } from './codec.js'

export interface PendingRequest {
  readonly command: string
  readonly accept: (message: QuartzMessage) => boolean
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly retryTimer: ReturnType<typeof setInterval> | null
  readonly ignoreErrors: boolean
}

export class QuartzCommandError extends Error {}

export const LINK_PING_INTERVAL_MS = 1000

export const LINK_PONG_TIMEOUT_MS = 5000

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
