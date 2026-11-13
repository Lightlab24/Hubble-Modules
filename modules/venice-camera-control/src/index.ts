import type { HubbleModule } from "@hubble/module-sdk";
import { createBackend } from './backend.js';
export default { createInstance: context => createBackend(context,undefined,{watchMs:3000}) } satisfies HubbleModule;
