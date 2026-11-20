import type { AjaKumoConnectionDefinition } from './config.js'

import {
  SingleLevelRouterConnectionManager,
  type SingleLevelRouterManagedClient,
} from '@hubble/router-runtime/single-level-manager'
import { createSimulatedSingleLevelClient } from '@hubble/router-runtime/simulated-single-level-client'
import { AjaKumoClient } from './aja-kumo-client.js'

export type AjaKumoManagedClientFactory = (
  definition: AjaKumoConnectionDefinition,
) => SingleLevelRouterManagedClient

/** KUMO shares the same routing, confirmation, and group contracts as other Hubble routers. */
export class AjaKumoConnectionManager extends SingleLevelRouterConnectionManager {
  constructor(
    createClient: AjaKumoManagedClientFactory = (definition) => new AjaKumoClient(definition),
  ) {
    super('aja-kumo', (definition) => {
      if (definition.type !== 'aja-kumo') throw new Error('Invalid AJA KUMO definition')
      // A simulated KUMO runs in the worker; it never reaches a test factory or the network.
      return definition.simulated === true
        ? createSimulatedSingleLevelClient(definition)
        : createClient(definition)
    })
  }
}
