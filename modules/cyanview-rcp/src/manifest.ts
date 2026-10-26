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
    'service.selectCamera',
    'service.recordCamera',
    'service.recordGroupAll',
  ],
  settings: [],
  actions: [
    {
      id: 'cyanview-rcp.select-camera',
      label: 'select camera',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-rcp.record-camera',
      label: 'record camera',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-rcp.record-group-all',
      label: 'record group all',
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
