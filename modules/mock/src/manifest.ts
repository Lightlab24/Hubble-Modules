import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.0',
  },
  configVersion: 1,
  capabilities: [],
  settings: [],
  actions: [
    {
      id: 'mock',
      label: 'mock',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'local',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
