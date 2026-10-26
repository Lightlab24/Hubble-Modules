import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.0',
    requiredFeatures: ['host-services-v1'],
  },
  configVersion: 1,
  capabilities: [
    'state-feedback',
    'host.ccc-store',
    'service.activate',
    'service.mutate',
    'service.command',
  ],
  settings: [],
  actions: [
    {
      id: 'ccc.command',
      label: 'ccc.command',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'response',
      timeoutMs: 120000,
      fields: [],
      completionAlternatives: ['state-confirmed', 'local'],
      legacy: true,
    },
  ],
  feedback: [],
})
