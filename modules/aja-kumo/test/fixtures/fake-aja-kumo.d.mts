import type { Server, ServerResponse } from 'node:http'

export class FakeAjaKumo {
  readonly routes: Map<number, number>
  readonly locks: Set<number>
  readonly writes: { destination: number; source: number }[]
  readonly salvoRecalls: number[]
  readonly salvos: Map<number, { name: string; routes: Map<number, number> }>
  readonly requests: URL[]
  readonly replies: Map<
    string,
    { status?: number; body?: string; value?: unknown; headers?: Record<string, string | string[]> }
  >
  readonly server: Server
  readonly sessions: Map<string, Record<string, unknown>[]>
  readonly waiting: Map<string, ServerResponse>
  readonly heldReads: (() => void)[]
  readonly names: Map<string, string>
  password: string
  ignoreWrites: boolean
  rejectWrites: boolean
  invalidCounts: boolean
  malformedEvents: boolean
  holdReads: boolean
  port: number
  start(): Promise<void>
  stop(): Promise<void>
  route(destination: number, source: number): void
  emit(event: Record<string, unknown>): void
}
