import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.0',
    requiredFeatures: ['host-services-v1'],
  },
  configVersion: 1,
  capabilities: ['persistent-listener', 'state-feedback', 'host.tsl'],
  settings: [],
  actions: [
    {
      id: 'tsl.tally-feedback',
      label: 'tsl.tally feedback',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'local',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'tsl.set-indication',
      label: 'tsl.set indication',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'local',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'tsl.tally-switch',
      label: 'tsl.tally switch',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'local',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'tsl.follow',
      label: 'tsl.follow',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'local',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
