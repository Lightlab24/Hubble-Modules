import type { HubbleModule } from '@hubble/module-sdk';
import { createBackend } from './backend.js';
export default { createInstance: context => createBackend(context) } satisfies HubbleModule;
