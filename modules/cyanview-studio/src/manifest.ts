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
    'persistent-connection',
    'state-feedback',
    'service.selectFeed',
    'service.selectFeedByFeedId',
    'service.selectFeedByNumber',
  ],
  settings: [],
  actions: [
    {
      id: 'cyanview-studio.select-feed',
      label: 'select feed',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-studio.select-feed-id',
      label: 'select feed id',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-studio.select-feed-number',
      label: 'select feed number',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
