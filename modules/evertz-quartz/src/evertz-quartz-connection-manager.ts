import { MultiLevelRouterConnectionManager } from '@hubble/router-runtime/multi-level-manager'
import { EvertzQuartzClient } from './quartz/client.js'

export class EvertzQuartzConnectionManager extends MultiLevelRouterConnectionManager {
  constructor() {
    super('evertz-quartz', (definition) => {
      if (definition.type !== 'evertz-quartz')
        throw new Error('Invalid Evertz Quartz definition')
      return new EvertzQuartzClient(definition)
    })
  }
}
