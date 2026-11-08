import { serveModuleHelper } from '@hubble/module-sdk/helper-runtime';
import { runPingBatch } from './ping-batch.js';
serveModuleHelper({ methods: { batch: (value, signal) => runPingBatch(value, signal) } });
