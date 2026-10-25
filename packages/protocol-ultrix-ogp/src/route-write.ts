import { routeKey } from './client-values.js'
import { encodeMultiValueUpdate, encodeValueUpdate } from './messages.js'
import type { UltrixOgpRequests } from './requests.js'
import {
  assertSafeRouteControllerIdentityWrite,
  assertSafeRouteWrite,
  createRouteControllerIdentityWrite,
  createRouteWrite,
  type OgpCrosspoint,
} from './ultrix-parameters.js'
interface UltrixRoutePort {
  readonly controlReady: boolean
  readonly multiSetEnabled: boolean
  readonly panelId: number
  readonly routes: ReadonlyMap<string, OgpCrosspoint>
  readonly requests: UltrixOgpRequests
  requireConnected(): void
  write(bytes: Buffer): void
  assertGeneration(generation: number): void
  requestDestination(
    destination: number,
    suppressRouteApplication: boolean,
  ): Promise<readonly OgpCrosspoint[]>
  readDestination(
    destination: number,
    levels: readonly number[],
  ): Promise<readonly OgpCrosspoint[]>
  applyCrosspoints(crosspoints: readonly OgpCrosspoint[]): void
}

/** One identity-prefixed route write, with fresh observations or bounded readback for evidence. */
export async function performSetCrosspoint(
  port: UltrixRoutePort,
  input: {
    readonly source: number
    readonly destination: number
    readonly levels: readonly number[]
  },
  generation: number,
): Promise<void> {
  port.requireConnected()
  if (!port.controlReady) throw new Error('Ultrix OGP routing control is not ready')
  const outstandingLevels = input.levels.filter(
    (level) => port.routes.get(routeKey(input.destination, level))?.source !== input.source,
  )
  if (outstandingLevels.length === 0) return
  const writes = outstandingLevels.map((level) =>
    createRouteWrite({
      source: input.source,
      destination: input.destination,
      level,
    }),
  )
  const controllerIdentity = createRouteControllerIdentityWrite({
    panelId: port.panelId,
  })
  assertSafeRouteControllerIdentityWrite(controllerIdentity)
  for (const write of writes) assertSafeRouteWrite(write)

  const confirmation = port.requests.createRouteConfirmation(
    input.source,
    input.destination,
    outstandingLevels,
  )
  try {
    if (port.multiSetEnabled) {
      port.write(encodeMultiValueUpdate([controllerIdentity, ...writes]))
    } else {
      port.write(encodeValueUpdate(controllerIdentity))
      for (const write of writes) port.write(encodeValueUpdate(write))
    }
    const result = await Promise.race([
      confirmation.completion.then(() => 'complete' as const),
      confirmation.firstExpectedObservation.then(() => 'first-observation' as const),
    ])
    port.assertGeneration(generation)
    if (result === 'complete' || !port.requests.hasConfirmation(confirmation.pending)) return

    const selectedLevels = new Set(outstandingLevels)
    const earlyProbe = port.requestDestination(input.destination, true).then(
      (crosspoints) =>
        Object.freeze({
          kind: 'readback' as const,
          crosspoints: Object.freeze(
            crosspoints.filter((entry) => selectedLevels.has(entry.level)),
          ),
        }),
      () => Object.freeze({ kind: 'readback-error' as const }),
    )
    const earlyResult = await Promise.race([
      confirmation.completion.then(() => Object.freeze({ kind: 'complete' as const })),
      earlyProbe,
    ])
    port.assertGeneration(generation)
    if (earlyResult.kind === 'complete') return
    if (earlyResult.kind === 'readback') {
      const earlyMismatch = earlyResult.crosspoints.some(
        (entry) => entry.source !== input.source,
      )
      if (!earlyMismatch && earlyResult.crosspoints.length === outstandingLevels.length) {
        port.applyCrosspoints(earlyResult.crosspoints)
        port.requests.cancelRouteConfirmation(confirmation.pending)
        return
      }
    }

    await confirmation.completion
    return
  } catch (error) {
    if (!(error instanceof Error) || !/confirmation timed out/iu.test(error.message)) {
      port.requests.cancelRouteConfirmation(confirmation.pending)
      throw error
    }
  }

  port.assertGeneration(generation)
  const readback = await port.readDestination(input.destination, outstandingLevels)
  port.assertGeneration(generation)
  const mismatched = readback.filter((entry) => entry.source !== input.source)
  if (mismatched.length > 0 || readback.length !== outstandingLevels.length) {
    throw new Error(
      `Ultrix OGP route was not confirmed for destination ${String(input.destination)}`,
    )
  }
}
