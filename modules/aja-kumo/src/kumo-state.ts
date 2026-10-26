import type { VideohubSnapshot } from '@hubble/protocol-videohub'

export function emptySnapshot(confirmedOperationSequence = 0): VideohubSnapshot {
  return Object.freeze({
    phase: 'disconnected',
    revision: 0,
    catalogRevision: 0,
    confirmedOperationSequence,
    protocolVersion: null,
    deviceStatus: 'unknown',
    modelName: null,
    detectedSourceCount: null,
    detectedDestinationCount: null,
    sourceCount: null,
    destinationCount: null,
    sources: Object.freeze([]),
    destinations: Object.freeze([]),
    routes: Object.freeze([]),
    locks: Object.freeze([]),
    labelsDegraded: false,
    catalogStale: false,
    lastError: null,
  })
}
