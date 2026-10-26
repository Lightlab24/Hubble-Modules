import { UltrixOgpClient } from '@hubble/protocol-ultrix-ogp'
import {
  MultiLevelRouterConnectionManager,
  type MultiLevelRouterManagedClient,
} from '@hubble/router-runtime/multi-level-manager'
import type { RossUltrixOgpConnectionDefinition } from './config.js'

export type RossUltrixOgpManagedClient = MultiLevelRouterManagedClient
export type RossUltrixOgpManagedClientFactory = (
  definition: RossUltrixOgpConnectionDefinition,
) => RossUltrixOgpManagedClient

export class RossUltrixOgpConnectionManager extends MultiLevelRouterConnectionManager {
  constructor(
    createClient: RossUltrixOgpManagedClientFactory = (definition) =>
      new UltrixOgpClient(definition),
  ) {
    super('ross-ultrix-ogp', (definition) => {
      if (definition.type !== 'ross-ultrix-ogp')
        throw new Error('Invalid Ultrix OGP definition')
      return createClient(definition)
    })
  }
}
