import { routerModule } from '@hubble/router-runtime/module'
import { actionSchemas } from './actions.js'
import { BlackmagicVideohubConnectionManager } from './blackmagic-videohub-connection-manager.js'
import { ConnectionDefinitionSchema } from './config.js'

export default routerModule(
  'blackmagic-videohub',
  () => new BlackmagicVideohubConnectionManager(),
  {
    connection: ConnectionDefinitionSchema,
    actions: actionSchemas,
  },
)
