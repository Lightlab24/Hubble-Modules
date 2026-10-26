import { routerModule } from '@hubble/router-runtime/module'
import { actionSchemas } from './actions.js'
import { ConnectionDefinitionSchema } from './config.js'
import { EvertzQuartzConnectionManager } from './evertz-quartz-connection-manager.js'

export default routerModule('evertz-quartz', () => new EvertzQuartzConnectionManager(), {
  connection: ConnectionDefinitionSchema,
  actions: actionSchemas,
})
