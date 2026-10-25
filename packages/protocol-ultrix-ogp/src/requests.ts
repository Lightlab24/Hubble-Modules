import { referenceKey, routeKey } from './client-values.js'
import { encodeValueRequest, type OgpValuePayload, type OgpValueReference } from './messages.js'
import type { OgpCrosspoint } from './ultrix-parameters.js'
interface PendingValueBatch {
  readonly references: ReadonlyMap<string, OgpValueReference>
  readonly values: Map<string, OgpValuePayload>
  readonly suppressRouteApplication: boolean
  readonly resolve: (values: ReadonlyMap<string, OgpValuePayload>) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface RouteConfirmation {
  readonly expected: ReadonlyMap<string, number>
  readonly observed: Map<string, number | null>
  firstExpectedObservationSeen: boolean
  readonly resolveFirstExpectedObservation: () => void
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface RouteConfirmationHandle {
  readonly pending: RouteConfirmation
  readonly completion: Promise<void>
  readonly firstExpectedObservation: Promise<void>
}

interface OgpRequestTransport {
  generation(): number
  requireActiveConnection(): void
  assertGeneration(generation: number): void
  write(bytes: Buffer): void
}

/** Serializes uncorrelated value reads and owns confirmation/timer cancellation. */
export class UltrixOgpRequests {
  private readonly pendingValueBatches = new Set<PendingValueBatch>()
  private readonly routeConfirmations = new Set<RouteConfirmation>()
  private valueRequestTail: Promise<void> = Promise.resolve()
  public constructor(
    private readonly timeoutMs: number,
    private readonly port: OgpRequestTransport,
  ) {}
  public observePendingValue(payload: OgpValuePayload): boolean {
    const key = referenceKey(payload)
    let suppressRouteApplication = false
    for (const pending of [...this.pendingValueBatches]) {
      if (!pending.references.has(key) || pending.values.has(key)) continue
      suppressRouteApplication ||= pending.suppressRouteApplication
      pending.values.set(key, Object.freeze({ ...payload }))
      if (pending.values.size === pending.references.size) {
        clearTimeout(pending.timer)
        this.pendingValueBatches.delete(pending)
        pending.resolve(new Map(pending.values))
      }
    }
    return suppressRouteApplication
  }

  public requestValues(
    references: readonly OgpValueReference[],
    suppressRouteApplication = false,
  ): Promise<ReadonlyMap<string, OgpValuePayload>> {
    const generation = this.port.generation()
    const execute = (): Promise<ReadonlyMap<string, OgpValuePayload>> => {
      this.port.assertGeneration(generation)
      return this.performValueRequests(references, suppressRouteApplication)
    }
    const task = this.valueRequestTail.then(execute)
    this.valueRequestTail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  public performValueRequests(
    references: readonly OgpValueReference[],
    suppressRouteApplication: boolean,
  ): Promise<ReadonlyMap<string, OgpValuePayload>> {
    this.port.requireActiveConnection()
    const unique = new Map<string, OgpValueReference>()
    for (const reference of references) {
      const key = referenceKey(reference)
      if (unique.has(key)) throw new Error(`Duplicate OGP value request for ${reference.oid}`)
      unique.set(key, Object.freeze({ ...reference }))
    }
    return new Promise<ReadonlyMap<string, OgpValuePayload>>((resolve, reject) => {
      const pending: PendingValueBatch = {
        references: unique,
        values: new Map(),
        suppressRouteApplication,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingValueBatches.delete(pending)
          reject(new Error('Ultrix OGP value request timed out'))
        }, this.timeoutMs),
      }
      this.pendingValueBatches.add(pending)
      try {
        for (const reference of unique.values()) this.port.write(encodeValueRequest(reference))
      } catch (error) {
        clearTimeout(pending.timer)
        this.pendingValueBatches.delete(pending)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  public createRouteConfirmation(
    source: number,
    destination: number,
    levels: readonly number[],
  ): RouteConfirmationHandle {
    const expected = new Map(
      levels.map((level) => [routeKey(destination, level), source] as const),
    )
    let resolveCompletion: () => void = () => undefined
    let rejectCompletion: (error: Error) => void = () => undefined
    let resolveFirstExpectedObservation: () => void = () => undefined
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    const firstExpectedObservation = new Promise<void>((resolve) => {
      resolveFirstExpectedObservation = resolve
    })
    const pending: RouteConfirmation = {
      expected,
      observed: new Map(),
      firstExpectedObservationSeen: false,
      resolveFirstExpectedObservation,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timer: setTimeout(() => {
        this.routeConfirmations.delete(pending)
        rejectCompletion(new Error('Ultrix OGP route confirmation timed out'))
      }, this.timeoutMs),
    }
    this.routeConfirmations.add(pending)
    return Object.freeze({ pending, completion, firstExpectedObservation })
  }

  public cancelRouteConfirmation(pending: RouteConfirmation): void {
    if (!this.routeConfirmations.delete(pending)) return
    clearTimeout(pending.timer)
  }

  public observeRouteConfirmation(crosspoint: OgpCrosspoint): void {
    const key = routeKey(crosspoint.destination, crosspoint.level)
    for (const pending of [...this.routeConfirmations]) {
      const expectedSource = pending.expected.get(key)
      if (expectedSource === undefined) continue
      pending.observed.set(key, crosspoint.source)
      if (!pending.firstExpectedObservationSeen && crosspoint.source === expectedSource) {
        pending.firstExpectedObservationSeen = true
        pending.resolveFirstExpectedObservation()
      }
      if (
        pending.observed.size === pending.expected.size &&
        [...pending.expected].every(
          ([target, source]) => pending.observed.get(target) === source,
        )
      ) {
        clearTimeout(pending.timer)
        this.routeConfirmations.delete(pending)
        pending.resolve()
      }
    }
  }

  public hasConfirmation(pending: RouteConfirmation): boolean {
    return this.routeConfirmations.has(pending)
  }
  public rejectAll(error: Error): void {
    for (const pending of [...this.pendingValueBatches]) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingValueBatches.clear()
    for (const pending of [...this.routeConfirmations]) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.routeConfirmations.clear()
  }
}
