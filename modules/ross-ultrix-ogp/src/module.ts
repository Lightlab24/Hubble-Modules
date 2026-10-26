import { routerModule } from '@hubble/router-runtime/module'
import { actionSchemas } from './actions.js'
import { ConnectionDefinitionSchema } from './config.js'
import { RossUltrixOgpConnectionManager } from './ross-ultrix-ogp-connection-manager.js'

export default routerModule('ross-ultrix-ogp', () => new RossUltrixOgpConnectionManager(), {
  connection: ConnectionDefinitionSchema,
  actions: actionSchemas,
})
