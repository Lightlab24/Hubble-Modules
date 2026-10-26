import { VideohubClient } from '@hubble/protocol-videohub'
import type { BlackmagicVideohubConnectionDefinition } from './config.js'

import {
  SingleLevelRouterConnectionManager,
  type SingleLevelRouterManagedClient,
} from '@hubble/router-runtime/single-level-manager'

export type BlackmagicVideohubManagedClient = SingleLevelRouterManagedClient
export type BlackmagicVideohubManagedClientFactory = (
  definition: BlackmagicVideohubConnectionDefinition,
) => BlackmagicVideohubManagedClient

export class BlackmagicVideohubConnectionManager extends SingleLevelRouterConnectionManager {
  constructor(createClient: BlackmagicVideohubManagedClientFactory = defaultClientFactory) {
    super('blackmagic-videohub', (definition) => {
      if (definition.type !== 'blackmagic-videohub')
        throw new Error('Invalid Videohub definition')
      return createClient(definition)
    })
  }
}

function defaultClientFactory(
  definition: BlackmagicVideohubConnectionDefinition,
): BlackmagicVideohubManagedClient {
  return new VideohubClient({
    host: definition.host,
    port: definition.port,
    requestTimeoutMs: definition.requestTimeoutMs,
    ...(definition.sourceLimit === undefined ? {} : { sourceLimit: definition.sourceLimit }),
    ...(definition.destinationLimit === undefined
      ? {}
      : { destinationLimit: definition.destinationLimit }),
  })
}
