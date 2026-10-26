import { routerModule } from '@hubble/router-runtime/module'
import { actionSchemas } from './actions.js'
import { AjaKumoConnectionManager } from './aja-kumo-connection-manager.js'
import { ConnectionDefinitionSchema } from './config.js'

export default routerModule('aja-kumo', () => new AjaKumoConnectionManager(), {
  connection: ConnectionDefinitionSchema,
  actions: actionSchemas,
})
