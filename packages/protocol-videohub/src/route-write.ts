import type { VideohubRouteResult } from './client-types.js'
import { errorMessage } from './client-values.js'
import {
  VideohubError,
  encodeVideoOutputRouting,
  type VideohubCrosspoint,
  type VideohubOutputLock,
  type VideohubProtocolMessage,
  type VideohubStatusHeader,
} from './protocol.js'
import type { VideohubRequests } from './requests.js'

interface VideohubRoutePort {
  requireConnected(): void
  validateSource(source: number): void
  validateDestination(destination: number): void
  readonly locks: ReadonlyMap<number, VideohubOutputLock>
  readonly routes: ReadonlyMap<number, VideohubCrosspoint>
  readonly requests: VideohubRequests
  requestCompleteBlock(
    header: VideohubStatusHeader,
    acknowledgement: boolean,
  ): Promise<VideohubProtocolMessage>
}

/** Execute exactly once; uncertain acknowledgements permit readback, never replay. */
export async function performSetCrosspoints(
  port: VideohubRoutePort,
  crosspoints: readonly VideohubCrosspoint[],
): Promise<readonly VideohubRouteResult[]> {
  try {
    port.requireConnected()
    for (const crosspoint of crosspoints) {
      port.validateSource(crosspoint.source)
      port.validateDestination(crosspoint.destination)
    }
  } catch (error) {
    const failure =
      error instanceof VideohubError
        ? error
        : new VideohubError(
            'unsupported-dimensions',
            `Videohub dimensions no longer support this route: ${errorMessage(error)}`,
            { cause: error },
          )
    return Object.freeze(
      crosspoints.map((crosspoint) =>
        Object.freeze({
          crosspoint,
          status: 'failed' as const,
          error: failure,
        }),
      ),
    )
  }

  const results = new Map<number, VideohubRouteResult>()
  const outstanding: VideohubCrosspoint[] = []
  for (const crosspoint of crosspoints) {
    if (port.locks.get(crosspoint.destination)?.state === 'locked') {
      results.set(
        crosspoint.destination,
        Object.freeze({
          crosspoint,
          status: 'failed',
          error: new VideohubError(
            'locked',
            `Videohub destination ${String(crosspoint.destination)} is locked by another client`,
          ),
        }),
      )
    } else if (port.routes.get(crosspoint.destination)?.source === crosspoint.source) {
      results.set(crosspoint.destination, Object.freeze({ crosspoint, status: 'unchanged' }))
    } else {
      outstanding.push(crosspoint)
    }
  }
  if (outstanding.length === 0) return orderedResults(crosspoints, results)

  const confirmation = port.requests.createRouteConfirmation(outstanding)
  let acknowledgementTimedOut = false
  try {
    await port.requests.sendWithAcknowledgement(encodeVideoOutputRouting(outstanding), false)
  } catch (error) {
    if (error instanceof VideohubError && error.code === 'timeout') {
      acknowledgementTimedOut = true
    } else {
      port.requests.cancelRouteConfirmation(confirmation.pending)
      const failure =
        error instanceof VideohubError
          ? error
          : new VideohubError('protocol-error', errorMessage(error), {
              cause: error,
            })
      for (const crosspoint of outstanding) {
        results.set(
          crosspoint.destination,
          Object.freeze({ crosspoint, status: 'failed', error: failure }),
        )
      }
      return orderedResults(crosspoints, results)
    }
  }

  if (!acknowledgementTimedOut) {
    try {
      await confirmation.promise
      for (const crosspoint of outstanding) {
        results.set(crosspoint.destination, Object.freeze({ crosspoint, status: 'confirmed' }))
      }
      return orderedResults(crosspoints, results)
    } catch (error) {
      if (!(error instanceof VideohubError) || error.code !== 'timeout') {
        const failure =
          error instanceof VideohubError
            ? error
            : new VideohubError('protocol-error', errorMessage(error), {
                cause: error,
              })
        for (const crosspoint of outstanding) {
          results.set(
            crosspoint.destination,
            Object.freeze({ crosspoint, status: 'failed', error: failure }),
          )
        }
        return orderedResults(crosspoints, results)
      }
    }
  }

  port.requests.cancelRouteConfirmation(confirmation.pending)
  try {
    await port.requestCompleteBlock('VIDEO OUTPUT ROUTING', !acknowledgementTimedOut)
  } catch (error) {
    const failure =
      error instanceof VideohubError
        ? error
        : new VideohubError('timeout', errorMessage(error), { cause: error })
    for (const crosspoint of outstanding) {
      results.set(
        crosspoint.destination,
        Object.freeze({ crosspoint, status: 'failed', error: failure }),
      )
    }
    if (acknowledgementTimedOut) port.requests.fenceDesynchronizedAcknowledgements()
    return orderedResults(crosspoints, results)
  }
  for (const crosspoint of outstanding) {
    const confirmed = port.routes.get(crosspoint.destination)?.source === crosspoint.source
    results.set(
      crosspoint.destination,
      confirmed
        ? Object.freeze({ crosspoint, status: 'confirmed' })
        : Object.freeze({
            crosspoint,
            status: 'failed',
            error: new VideohubError(
              acknowledgementTimedOut ? 'timeout' : 'conflicting-readback',
              acknowledgementTimedOut
                ? `Videohub route acknowledgement timed out for destination ${String(
                    crosspoint.destination,
                  )}`
                : `Videohub conflicting readback: route was not confirmed for destination ${String(
                    crosspoint.destination,
                  )}`,
            ),
          }),
    )
  }
  if (acknowledgementTimedOut) port.requests.fenceDesynchronizedAcknowledgements()
  return orderedResults(crosspoints, results)
}

function orderedResults(
  crosspoints: readonly VideohubCrosspoint[],
  results: ReadonlyMap<number, VideohubRouteResult>,
): readonly VideohubRouteResult[] {
  return Object.freeze(
    crosspoints.map((crosspoint) => {
      const result = results.get(crosspoint.destination)
      if (result === undefined) throw new Error('Videohub route result is missing')
      return result
    }),
  )
}
