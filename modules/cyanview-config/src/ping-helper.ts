import { serveModuleHelper } from '@hubble/module-sdk/helper-runtime';
import { runPingBatch } from './ping-batch.js';
import { runOpenPage } from './open-page-run.js';
// The module's one helper process: the ping tool for discovery, and the browser for a controller's own web page.
serveModuleHelper({ methods: { batch: (value, signal) => runPingBatch(value, signal), 'open-page': (value, signal) => runOpenPage(value, signal) } });
