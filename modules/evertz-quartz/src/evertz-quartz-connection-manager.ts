import { MultiLevelRouterConnectionManager } from '@hubble/router-runtime/multi-level-manager'
import { createSimulatedMultiLevelClient } from '@hubble/router-runtime/simulated-multi-level-client'
import { EvertzQuartzClient } from './quartz/client.js'

export class EvertzQuartzConnectionManager extends MultiLevelRouterConnectionManager {
  constructor() {
    super('evertz-quartz', (definition) => {
      if (definition.type !== 'evertz-quartz')
        throw new Error('Invalid Evertz Quartz definition')
      // A simulated Quartz runs in the worker and never opens a socket.
      return definition.simulated === true
        ? createSimulatedMultiLevelClient(definition)
        : new EvertzQuartzClient(definition)
    })
  }
}
